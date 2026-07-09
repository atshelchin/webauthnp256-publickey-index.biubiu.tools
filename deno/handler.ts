/**
 * The REAL request handler, extracted from the entrypoint so tests exercise
 * the deployed routing/CORS/error/health behavior instead of a hand-copied
 * replica (the old server.test.ts replica had silently diverged — 9 green
 * tests certified code that never shipped).
 */
import { getReadCircuitState } from "../shared/rpc.ts";
import { CONTRACT_ADDRESS } from "../shared/contract-read.ts";
import { handleQuery } from "./routes/query.ts";
import { handleChallenge } from "../shared/routes/challenge.ts";
import { handleCreate, handleCreateStatus } from "./routes/create.ts";
import { handleListRpIds, handleListPublicKeys, handleTotalCredentials } from "../shared/routes/stats.ts";
import { getQueueStats } from "./queue.ts";
import { getConfig } from "./config.ts";
import { buildHealthBody } from "../shared/routes/health.ts";
import { withCors } from "../shared/cors.ts";
import { log, newRequestId } from "../shared/log.ts";

export function createHandler(homeHtml: string): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), req);
    }

    const url = new URL(req.url);
    const path = url.pathname;
    const requestId = newRequestId();
    const start = performance.now();
    log.info("http request", { request_id: requestId, method: req.method, path, query: url.search || undefined });

    let response: Response;

    try {
      if (path === "/" && req.method === "GET") {
        response = new Response(homeHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      } else if (path === "/api/health" && req.method === "GET") {
        let telegramConfigured = false;
        try { const c = getConfig(); telegramConfigured = !!(c.telegramBotToken && c.telegramChatId); } catch { /* config not init (tests) */ }
        const base = {
          service: "webauthn-p256-publickey-index",
          version: "1.0.0",
          chainId: 100,
          contract: CONTRACT_ADDRESS,
          rpcCircuit: getReadCircuitState(),
          telegramConfigured,
        };
        let stats = null;
        try { stats = getQueueStats(); } catch { /* DB hiccup → degraded */ }
        response = Response.json(buildHealthBody(base, stats));
      } else if (path === "/api/challenge" && req.method === "GET") {
        response = handleChallenge();
      } else if (path === "/api/query" && req.method === "GET") {
        response = await handleQuery(req);
      } else if (path === "/api/create" && req.method === "POST") {
        response = await handleCreate(req, requestId);
      } else if (path.startsWith("/api/create/") && req.method === "GET") {
        response = handleCreateStatus(req);
      } else if (path === "/api/stats/total" && req.method === "GET") {
        response = await handleTotalCredentials(req);
      } else if (path === "/api/stats/sites" && req.method === "GET") {
        response = await handleListRpIds(req);
      } else if (path === "/api/stats/keys" && req.method === "GET") {
        response = await handleListPublicKeys(req);
      } else {
        response = Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (error) {
      log.error("http unhandled error", { request_id: requestId, method: req.method, path, error: String(error) });
      response = Response.json({ error: "internal server error", request_id: requestId }, { status: 500 });
    }

    const ms = Math.round(performance.now() - start);
    log.info("http response", { request_id: requestId, method: req.method, path, status: response.status, latency_ms: ms });
    response.headers.set("X-Request-Id", requestId);
    return withCors(response, req);
  };
}
