/**
 * Cloudflare Worker entry point.
 * Shares rpc.ts, contract.ts, validation.ts, wallet-ref.ts, cache.ts,
 * challenge.ts, stats.ts routes with Deno version.
 * Only queue (D1 vs SQLite) and config (env bindings vs Deno.env) differ.
 */
import { initRpc } from "../shared/rpc.ts";
import { CONTRACT_ADDRESS } from "../shared/contract.ts";
import { handleChallenge } from "../shared/routes/challenge.ts";
import { handleListRpIds, handleListPublicKeys, handleTotalCredentials } from "../shared/routes/stats.ts";
import { handleQuery } from "./routes/query.ts";
import { handleCreate, handleCreateStatus } from "./routes/create.ts";
import { initQueue } from "./queue.ts";
import type { Env } from "./types.ts";

export { QueueProcessor } from "./queue-processor.ts";

const HOME_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>WebAuthn P256 Public Key Index</title></head>
<body><h1>WebAuthn P256 Public Key Index</h1><p>API running on Cloudflare Workers.</p>
<p>See <a href="/api/health">/api/health</a> for status.</p></body></html>`;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function withCors(response: Response): Response {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

let rpcInitialized = false;
let queueInitialized = false;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Initialize RPC list (lazy, once per isolate lifetime)
    if (!rpcInitialized) {
      await initRpc();
      rpcInitialized = true;
    }

    // Initialize D1 queue tables (lazy)
    if (!queueInitialized) {
      await initQueue(env.DB);
      queueInitialized = true;
    }

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);
    const path = url.pathname;

    let response: Response;

    try {
      if (path === "/" && request.method === "GET") {
        response = new Response(HOME_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      } else if (path === "/api/health" && request.method === "GET") {
        response = Response.json({
          service: "webauthn-p256-publickey-index",
          version: "1.0.0",
          runtime: "cloudflare-workers",
          chainId: 100,
          contract: CONTRACT_ADDRESS,
          status: "ok",
        });
      } else if (path === "/api/challenge" && request.method === "GET") {
        response = handleChallenge();
      } else if (path === "/api/query" && request.method === "GET") {
        response = await handleQuery(request, env.DB);
      } else if (path === "/api/create" && request.method === "POST") {
        response = await handleCreate(request, env.DB);
      } else if (path.startsWith("/api/create/") && request.method === "GET") {
        response = await handleCreateStatus(request, env.DB);
      } else if (path === "/api/stats/total" && request.method === "GET") {
        response = await handleTotalCredentials();
      } else if (path === "/api/stats/sites" && request.method === "GET") {
        response = await handleListRpIds(request);
      } else if (path === "/api/stats/keys" && request.method === "GET") {
        response = await handleListPublicKeys(request);
      } else {
        response = Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (error) {
      console.error("Unhandled error:", error);
      response = Response.json({ error: "internal server error" }, { status: 500 });
    }

    // Ensure queue processor DO is running
    ctx.waitUntil((async () => {
      try {
        const doId = env.QUEUE_PROCESSOR.idFromName("main");
        const doStub = env.QUEUE_PROCESSOR.get(doId);
        await doStub.fetch(new Request("https://do/start"));
      } catch { /* ignore */ }
    })());

    return withCors(response);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Backup: ensure DO alarm is running via cron trigger
    ctx.waitUntil((async () => {
      try {
        const doId = env.QUEUE_PROCESSOR.idFromName("main");
        const doStub = env.QUEUE_PROCESSOR.get(doId);
        await doStub.fetch(new Request("https://do/start"));
      } catch { /* ignore */ }
    })());
  },
};
