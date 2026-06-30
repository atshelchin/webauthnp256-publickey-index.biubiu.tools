import { getPublicKey, getPublicKeyByWalletRef } from "../../shared/contract-read.ts";
import { cacheGet, cacheGetStale, cacheSet } from "../../shared/cache.ts";
import { findDuplicate } from "../queue.ts";
import { validateStringLength } from "../../shared/validation.ts";
import { isDependencyError, serveStaleOrDependency, STALE_MAX_MS_RECORD } from "../../shared/routes/errors.ts";

const CACHE_HEADERS = { "Cache-Control": "public, max-age=3600" };

export async function handleQuery(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const rpId = url.searchParams.get("rpId");
  const credentialId = url.searchParams.get("credentialId");
  const walletRef = url.searchParams.get("walletRef");

  const lengthError = validateStringLength({ rpId: rpId ?? undefined, credentialId: credentialId ?? undefined, walletRef: walletRef ?? undefined });
  if (lengthError) {
    return Response.json({ error: lengthError }, { status: 400 });
  }

  // Query by walletRef
  if (walletRef) {
    if (!walletRef.startsWith("0x") || walletRef.length !== 66) {
      return Response.json({ error: "walletRef must be a 0x-prefixed 32-byte hex string" }, { status: 400 });
    }

    const cacheKey = `query:walletRef:${walletRef}`;
    const cached = cacheGet<object>(cacheKey);
    if (cached) {
      return Response.json(cached, { headers: CACHE_HEADERS });
    }

    let result;
    try {
      result = await getPublicKeyByWalletRef(walletRef as `0x${string}`);
    } catch (err) {
      // Chain unreachable: serve last-known-good if we have it, else a stable
      // retryable 503 — never a 404 that wrongly implies the record is gone.
      if (isDependencyError(err)) {
        return serveStaleOrDependency(cacheGetStale<object>(cacheKey), STALE_MAX_MS_RECORD, err);
      }
      throw err;
    }
    if (result) {
      cacheSet(cacheKey, result);
      return Response.json(result, { headers: CACHE_HEADERS });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }

  // Query by rpId + credentialId (backward compatible)
  if (!rpId || !credentialId) {
    return Response.json({ error: "rpId and credentialId are required (or walletRef)" }, { status: 400 });
  }

  const cacheKey = `query:${rpId}:${credentialId}`;
  const cached = cacheGet<object>(cacheKey);
  if (cached) {
    return Response.json(cached, { headers: CACHE_HEADERS });
  }

  // Try on-chain first
  let result;
  try {
    result = await getPublicKey(rpId, credentialId);
  } catch (err) {
    if (isDependencyError(err)) {
      return serveStaleOrDependency(cacheGetStale<object>(cacheKey), STALE_MAX_MS_RECORD, err);
    }
    throw err;
  }
  if (result) {
    cacheSet(cacheKey, result);
    return Response.json(result, { headers: CACHE_HEADERS });
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
