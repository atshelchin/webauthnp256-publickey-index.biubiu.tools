import { getPublicKey } from "../contract.ts";
import { cacheGet, cacheSet } from "../cache.ts";

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

  const result = await getPublicKey(rpId, credentialId);
  if (!result) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  cacheSet(cacheKey, result);
  return Response.json(result, { headers: CACHE_HEADERS });
}
