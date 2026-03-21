import { listRpIds, listPublicKeysByRpId } from "../db.ts";
import { cacheGet, cacheSet } from "../cache.ts";

const CACHE_HEADERS = { "Cache-Control": "public, max-age=3600" };

function parsePagination(url: URL) {
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10)));
  const order = url.searchParams.get("order") === "asc" ? "asc" as const : "desc" as const;
  return { page, pageSize, order };
}

export function handleListRpIds(req: Request): Response {
  const url = new URL(req.url);
  const { page, pageSize, order } = parsePagination(url);

  const cacheKey = `stats:rpIds:${page}:${pageSize}:${order}`;
  const cached = cacheGet<object>(cacheKey);
  if (cached) {
    return Response.json(cached, { headers: CACHE_HEADERS });
  }

  const result = listRpIds(page, pageSize, order);
  if (result.items.length > 0) {
    cacheSet(cacheKey, result);
  }
  return Response.json(result, { headers: result.items.length > 0 ? CACHE_HEADERS : undefined });
}

export function handleListPublicKeys(req: Request): Response {
  const url = new URL(req.url);
  const rpId = url.searchParams.get("rpId");

  if (!rpId) {
    return Response.json({ error: "rpId is required" }, { status: 400 });
  }

  const { page, pageSize, order } = parsePagination(url);

  const cacheKey = `stats:keys:${rpId}:${page}:${pageSize}:${order}`;
  const cached = cacheGet<object>(cacheKey);
  if (cached) {
    return Response.json(cached, { headers: CACHE_HEADERS });
  }

  const result = listPublicKeysByRpId(rpId, page, pageSize, order);
  if (result.items.length > 0) {
    cacheSet(cacheKey, result);
  }
  return Response.json(result, { headers: result.items.length > 0 ? CACHE_HEADERS : undefined });
}
