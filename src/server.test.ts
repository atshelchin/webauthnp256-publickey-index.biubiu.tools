import { assertEquals, assert } from "@std/assert/";
import { cacheClear } from "./cache.ts";
import { initQueue } from "./queue.ts";
import { handleQuery } from "./routes/query.ts";
import { handleCreate } from "./routes/create.ts";
import { handleListRpIds, handleListPublicKeys } from "./routes/stats.ts";

let HOME_HTML: string;
try {
  HOME_HTML = Deno.readTextFileSync(new URL("./index.html", import.meta.url));
} catch {
  HOME_HTML = "<!DOCTYPE html><html><body>test</body></html>";
}

function setup() {
  cacheClear();
  initQueue(":memory:");
}

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

async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return withCors(new Response(null, { status: 204 }));
  }
  const url = new URL(req.url);
  const path = url.pathname;
  let response: Response;
  try {
    if (path === "/" && req.method === "GET") {
      response = new Response(HOME_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    } else if (path === "/api/health" && req.method === "GET") {
      response = Response.json({
        service: "webauthn-p256-publickey-index",
        version: "1.0.0",
        chainId: 100,
        contract: "0xdd93420BD49baaBdFF4A363DdD300622Ae87E9c3",
        status: "ok",
      });
    } else if (path === "/api/query" && req.method === "GET") {
      response = await handleQuery(req);
    } else if (path === "/api/create" && req.method === "POST") {
      response = await handleCreate(req);
    } else if (path === "/api/stats/sites" && req.method === "GET") {
      response = await handleListRpIds(req);
    } else if (path === "/api/stats/keys" && req.method === "GET") {
      response = await handleListPublicKeys(req);
    } else {
      response = Response.json({ error: "not found" }, { status: 404 });
    }
  } catch {
    response = Response.json({ error: "internal server error" }, { status: 500 });
  }
  return withCors(response);
}

// --- Health check ---

Deno.test("GET /api/health returns ok", async () => {
  setup();
  const res = await handleRequest(new Request("http://localhost/api/health"));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.service, "webauthn-p256-publickey-index");
  assertEquals(body.version, "1.0.0");
  assertEquals(body.chainId, 100);
  assertEquals(body.contract, "0xdd93420BD49baaBdFF4A363DdD300622Ae87E9c3");
  assertEquals(body.status, "ok");
});

// --- Homepage ---

Deno.test("GET / returns HTML", async () => {
  setup();
  const res = await handleRequest(new Request("http://localhost/"));
  assertEquals(res.status, 200);
  assert(res.headers.get("Content-Type")!.includes("text/html"));
  const text = await res.text();
  assert(text.includes("<!DOCTYPE html"));
});

// --- CORS ---

Deno.test("OPTIONS returns CORS headers", async () => {
  setup();
  const res = await handleRequest(new Request("http://localhost/api/query", { method: "OPTIONS" }));
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert(res.headers.get("Access-Control-Allow-Methods")!.includes("GET"));
});

Deno.test("API responses include CORS headers", async () => {
  setup();
  const res = await handleRequest(new Request("http://localhost/api/health"));
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
});

// --- 404 ---

Deno.test("unknown route returns 404", async () => {
  setup();
  const res = await handleRequest(new Request("http://localhost/api/nonexistent"));
  assertEquals(res.status, 404);
  const body = await res.json();
  assertEquals(body.error, "not found");
});

Deno.test("wrong HTTP method returns 404", async () => {
  setup();
  const res = await handleRequest(new Request("http://localhost/api/query", { method: "POST" }));
  assertEquals(res.status, 404);
});

// --- Query param validation ---

Deno.test("GET /api/query without params returns 400", async () => {
  setup();
  const res = await handleRequest(new Request("http://localhost/api/query"));
  assertEquals(res.status, 400);
});

Deno.test("GET /api/stats/keys without rpId returns 400", async () => {
  setup();
  const res = await handleRequest(new Request("http://localhost/api/stats/keys"));
  assertEquals(res.status, 400);
});

// --- 404 also has CORS ---

Deno.test("404 response includes CORS headers", async () => {
  setup();
  const res = await handleRequest(new Request("http://localhost/nonexistent"));
  assertEquals(res.status, 404);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
});
