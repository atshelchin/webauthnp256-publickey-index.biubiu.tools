import { getPublicKey } from "../contract.ts";
import { cacheGet, cacheSet } from "../cache.ts";
import { findDuplicate } from "../queue.ts";

const CACHE_HEADERS = { "Cache-Control": "public, max-age=3600" };

export async function handleQuery(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const rpId = url.searchParams.get("rpId");
  const credentialId = url.searchParams.get("credentialId");

  if (!rpId || !credentialId) {
    return Response.json({ error: "rpId and credentialId are required" }, { status: 400 });
  }

  const cacheKey = `query:${rpId}:${credentialId}`;
  const cached = cacheGet<object>(cacheKey);
  if (cached) {
    return Response.json(cached, { headers: CACHE_HEADERS });
  }

  // Try on-chain first
  const result = await getPublicKey(rpId, credentialId);
  if (result) {
    cacheSet(cacheKey, result);
    return Response.json(result, { headers: CACHE_HEADERS });
  }

  // Fallback: check queue for pending/in-progress records
  const queued = findDuplicate(rpId, credentialId);
  if (queued) {
    return Response.json({
      rpId: queued.rpId,
      credentialId: queued.credentialId,
      publicKey: queued.publicKey,
      name: queued.name,
      initialCredentialId: queued.initialCredentialId,
      metadata: queued.metadata,
      createdAt: queued.createdAt,
      _queue: { id: queued.id, status: queued.status },
    });
  }

  return Response.json({ error: "not found" }, { status: 404 });
}
