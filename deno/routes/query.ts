import { getPublicKey, getPublicKeyByWalletRef } from "../../shared/contract-read.ts";
import { cacheGet, cacheGetStale, cacheSet, cacheKey as cacheKey_, NOT_FOUND, NEGATIVE_TTL_MS } from "../../shared/cache.ts";
import { allowChainRead, clientIp } from "../../shared/read-limit.ts";
import { findDuplicate, findDuplicateByWalletRef } from "../queue.ts";
import { validateStringLength } from "../../shared/validation.ts";
import { isDependencyError, serveStaleOrDependency, STALE_MAX_MS_RECORD } from "../../shared/routes/errors.ts";

const CACHE_HEADERS = { "Cache-Control": "public, max-age=3600" };

export async function handleQuery(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const rpId = url.searchParams.get("rpId");
  const credentialId = url.searchParams.get("credentialId");
  let walletRef = url.searchParams.get("walletRef");

  const lengthError = validateStringLength({ rpId: rpId ?? undefined, credentialId: credentialId ?? undefined, walletRef: walletRef ?? undefined });
  if (lengthError) {
    return Response.json({ error: lengthError }, { status: 400 });
  }

  // Query by walletRef
  if (walletRef) {
    if (!walletRef.startsWith("0x") || walletRef.length !== 66) {
      return Response.json({ error: "walletRef must be a 0x-prefixed 32-byte hex string" }, { status: 400 });
    }
    // Stored walletRef is always lowercase (derived Safe address). Normalize the
    // query param so a mixed-case request hits the cache AND the queue fallback.
    walletRef = walletRef.toLowerCase();

    const cacheKey = cacheKey_("query", "walletRef", walletRef);
    const cached = cacheGet<object>(cacheKey);
    if (cached === NOT_FOUND) {
      // Even on a negative hit, a create may have been enqueued since — check
      // the local queue (cheap) before returning 404.
      const q = findDuplicateByWalletRef(walletRef);
      if (q) return Response.json({ rpId: q.rpId, publicKey: q.publicKey, name: q.name, metadata: q.metadata, createdAt: q.createdAt, _queue: { id: q.id, status: q.status } });
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (cached) {
      return Response.json(cached, { headers: CACHE_HEADERS });
    }

    // Chain reads are the expensive path — bound per-IP amplification. Cached
    // responses (incl. negative) never reach this point. Fails open internally.
    if (!await allowChainRead(clientIp(req))) {
      return Response.json({ error: "too many uncached reads, slow down", retryable: true }, { status: 429, headers: { "Retry-After": "10" } });
    }

    let result;
    try {
      result = await getPublicKeyByWalletRef(walletRef as `0x${string}`);
    } catch (err) {
      // Chain unreachable: serve last-known-good if we have it, else a stable
      // retryable 503 — never a 404 that wrongly implies the record is gone.
      if (isDependencyError(err)) {
        const stale = cacheGetStale<object>(cacheKey);
        // A cached NEGATIVE is not a servable record body — treat as no-stale
        // (→ 503 + Retry-After, never a fabricated 200 nor an outage 404).
        return serveStaleOrDependency(stale && stale.value !== NOT_FOUND ? stale : undefined, STALE_MAX_MS_RECORD, err);
      }
      throw err;
    }
    if (result) {
      cacheSet(cacheKey, result);
      return Response.json(result, { headers: CACHE_HEADERS });
    }
    // Not on-chain: fall back to the queue (a create landed moments ago is
    // still pending). Redacted, matching the rpId+credentialId path.
    const q = findDuplicateByWalletRef(walletRef);
    if (q) {
      return Response.json({ rpId: q.rpId, publicKey: q.publicKey, name: q.name, metadata: q.metadata, createdAt: q.createdAt, _queue: { id: q.id, status: q.status } });
    }
    // Negative-cache (short TTL): repeat lookups for a nonexistent walletRef
    // must not cost one chain RPC each.
    cacheSet(cacheKey, NOT_FOUND, NEGATIVE_TTL_MS);
    return Response.json({ error: "not found" }, { status: 404 });
  }

  // Query by rpId + credentialId (backward compatible)
  if (!rpId || !credentialId) {
    return Response.json({ error: "rpId and credentialId are required (or walletRef)" }, { status: 400 });
  }

  const cacheKey = cacheKey_("query", rpId, credentialId);
  const cached = cacheGet<object>(cacheKey);
  // Negative hit: skip the CHAIN read (the expensive part) but ALWAYS still
  // consult the local queue below — a create enqueued moments ago must stay
  // visible; only the on-chain lookup is short-circuited.
  if (cached && cached !== NOT_FOUND) {
    return Response.json(cached, { headers: CACHE_HEADERS });
  }

  let result = null;
  if (cached !== NOT_FOUND) {
    if (!await allowChainRead(clientIp(req))) {
      return Response.json({ error: "too many uncached reads, slow down", retryable: true }, { status: 429, headers: { "Retry-After": "10" } });
    }
    // Try on-chain first
    try {
      result = await getPublicKey(rpId, credentialId);
    } catch (err) {
      if (isDependencyError(err)) {
        const stale = cacheGetStale<object>(cacheKey);
        // A cached NEGATIVE is not a servable record body — treat as no-stale
        // (→ 503 + Retry-After, never a fabricated 200 nor an outage 404).
        return serveStaleOrDependency(stale && stale.value !== NOT_FOUND ? stale : undefined, STALE_MAX_MS_RECORD, err);
      }
      throw err;
    }
    if (result) {
      cacheSet(cacheKey, result);
      return Response.json(result, { headers: CACHE_HEADERS });
    }
    cacheSet(cacheKey, NOT_FOUND, NEGATIVE_TTL_MS);
  }

  // Fallback: check queue for pending/in-progress records
  const queued = findDuplicate(rpId, credentialId);
  if (queued) {
    // Redact credentialId/walletRef/initialCredentialId to prevent front-running
    // Always return publicKey (client needs it)
    return Response.json({
      rpId: queued.rpId,
      publicKey: queued.publicKey,
      name: queued.name,
      metadata: queued.metadata,
      createdAt: queued.createdAt,
      _queue: { id: queued.id, status: queued.status },
    });
  }

  return Response.json({ error: "not found" }, { status: 404 });
}
