import { test, expect, beforeEach } from "bun:test";
import { initDb } from "../db.ts";
import { createPublicKey } from "../db.ts";
import { cacheClear } from "../cache.ts";
import { handleQuery } from "./query.ts";

beforeEach(() => {
  initDb(":memory:");
  cacheClear();
});

test("handleQuery returns 400 when rpId missing", () => {
  const req = new Request("http://localhost/api/query?credentialId=c1");
  const res = handleQuery(req);
  expect(res.status).toBe(400);
});

test("handleQuery returns 400 when credentialId missing", () => {
  const req = new Request("http://localhost/api/query?rpId=site.com");
  const res = handleQuery(req);
  expect(res.status).toBe(400);
});

test("handleQuery returns 404 when not found", async () => {
  const req = new Request("http://localhost/api/query?rpId=site.com&credentialId=c1");
  const res = handleQuery(req);
  expect(res.status).toBe(404);
});

test("handleQuery returns public key when found", async () => {
  createPublicKey("site.com", "c1", "04abc");
  const req = new Request("http://localhost/api/query?rpId=site.com&credentialId=c1");
  const res = handleQuery(req);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.publicKey).toBe("04abc");
  expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
});

test("handleQuery serves from cache on second call", async () => {
  createPublicKey("site.com", "c1", "04abc");
  const req1 = new Request("http://localhost/api/query?rpId=site.com&credentialId=c1");
  handleQuery(req1);

  // Second call should hit cache
  const req2 = new Request("http://localhost/api/query?rpId=site.com&credentialId=c1");
  const res = handleQuery(req2);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.publicKey).toBe("04abc");
});
