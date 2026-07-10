/**
 * Integration tests against the REAL handler (deno/handler.ts — the exact
 * routing the entrypoint serves). Replaces a hand-copied router replica that
 * had silently diverged from production (missing routes, stale health shape).
 */
import { assertEquals, assert } from "@std/assert/";
import { cacheClear } from "../../shared/cache.ts";
import { initQueue } from "../queue.ts";
import { createHandler } from "../handler.ts";

const handler = createHandler("<!DOCTYPE html><html><body>test-home</body></html>");

async function setup() {
  cacheClear();
  await initQueue(":memory:");
}

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

// --- Routing basics (the real if/else chain) ---

Deno.test("GET / serves the homepage HTML", async () => {
  await setup();
  const res = await handler(req("/"));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert((await res.text()).includes("test-home"));
});

Deno.test("GET /api/health returns the REAL health shape (status + queue + rpcCircuit)", async () => {
  await setup();
  const res = await handler(req("/api/health"));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.service, "webauthn-p256-publickey-index");
  assertEquals(body.chainId, 100);
  assert(body.status === "ok" || body.status === "degraded");
  assert(typeof body.queue === "object", "health must expose queue depth/dlq/oldest");
  assert(body.rpcCircuit === "open" || body.rpcCircuit === "closed");
});

Deno.test("GET /api/challenge returns a challenge via the real route", async () => {
  await setup();
  const res = await handler(req("/api/challenge"));
  assertEquals(res.status, 200);
  const body = await res.json();
  assert(typeof body.challenge === "string" && body.challenge.length > 0);
});

Deno.test("unknown path → 404 JSON with CORS headers", async () => {
  await setup();
  const res = await handler(req("/nope"));
  assertEquals(res.status, 404);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals((await res.json()).error, "not found");
});

Deno.test("wrong method falls through to 404 (no HEAD/PUT surprises)", async () => {
  await setup();
  const res = await handler(req("/api/query", { method: "POST" }));
  assertEquals(res.status, 404);
});

Deno.test("OPTIONS preflight → 204 and echoes requested headers", async () => {
  await setup();
  const res = await handler(req("/api/create", {
    method: "OPTIONS",
    headers: {
      "Origin": "https://example.com",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,idempotency-key",
    },
  }));
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(res.headers.get("Access-Control-Allow-Headers"), "content-type,idempotency-key");
});

Deno.test("every non-OPTIONS response carries X-Request-Id (correlation)", async () => {
  await setup();
  const res = await handler(req("/api/health"));
  const rid = res.headers.get("X-Request-Id");
  assert(rid !== null && rid.length >= 8, "request id header required");
});

Deno.test("POST /api/create with invalid JSON → 400 through the real route", async () => {
  await setup();
  const res = await handler(req("/api/create", { method: "POST", body: "not json" }));
  assertEquals(res.status, 400);
});

Deno.test("GET /api/query without params → 400 through the real route", async () => {
  await setup();
  const res = await handler(req("/api/query"));
  assertEquals(res.status, 400);
});

Deno.test("GET /api/create/:id unknown id → 404 through the real route", async () => {
  await setup();
  const res = await handler(req("/api/create/no-such-id"));
  assertEquals(res.status, 404);
});
