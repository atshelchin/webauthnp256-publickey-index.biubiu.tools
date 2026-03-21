import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { initDb } from "./db.ts";
import { cacheClear } from "./cache.ts";
import HOME_HTML from "./index.html" with { type: "text" };
import { handleQuery } from "./routes/query.ts";
import { handleChallenge, handleCreate } from "./routes/create.ts";
import { handleListRpIds, handleListPublicKeys } from "./routes/stats.ts";

beforeEach(() => {
  initDb(":memory:");
  cacheClear();
});

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
      response = Response.json({ status: "ok" });
    } else if (path === "/api/query" && req.method === "GET") {
      response = handleQuery(req);
    } else if (path === "/api/challenge" && req.method === "GET") {
      response = handleChallenge();
    } else if (path === "/api/create" && req.method === "POST") {
      response = await handleCreate(req);
    } else if (path === "/api/stats/sites" && req.method === "GET") {
      response = handleListRpIds(req);
    } else if (path === "/api/stats/keys" && req.method === "GET") {
      response = handleListPublicKeys(req);
    } else {
      response = Response.json({ error: "not found" }, { status: 404 });
    }
  } catch (error) {
    response = Response.json({ error: "internal server error" }, { status: 500 });
  }
  return withCors(response);
}

// --- Health check ---

test("GET /api/health returns ok", async () => {
  const res = await handleRequest(new Request("http://localhost/api/health"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.status).toBe("ok");
});

// --- Homepage ---

test("GET / returns HTML", async () => {
  const res = await handleRequest(new Request("http://localhost/"));
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toContain("text/html");
  const text = await res.text();
  expect(text).toContain("<!DOCTYPE html");
});

// --- CORS ---

test("OPTIONS returns CORS headers", async () => {
  const res = await handleRequest(new Request("http://localhost/api/query", { method: "OPTIONS" }));
  expect(res.status).toBe(204);
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
});

test("API responses include CORS headers", async () => {
  const res = await handleRequest(new Request("http://localhost/api/health"));
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
});

// --- 404 ---

test("unknown route returns 404", async () => {
  const res = await handleRequest(new Request("http://localhost/api/nonexistent"));
  expect(res.status).toBe(404);
  const body = await res.json();
  expect(body.error).toBe("not found");
});

test("wrong HTTP method returns 404", async () => {
  const res = await handleRequest(new Request("http://localhost/api/query", { method: "POST" }));
  expect(res.status).toBe(404);
});

// --- Query param validation ---

test("GET /api/query without params returns 400", async () => {
  const res = await handleRequest(new Request("http://localhost/api/query"));
  expect(res.status).toBe(400);
});

test("GET /api/stats/keys without rpId returns 400", async () => {
  const res = await handleRequest(new Request("http://localhost/api/stats/keys"));
  expect(res.status).toBe(400);
});

// --- 404 also has CORS ---

test("404 response includes CORS headers", async () => {
  const res = await handleRequest(new Request("http://localhost/nonexistent"));
  expect(res.status).toBe(404);
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
});
