import { test, expect, beforeEach } from "bun:test";
import { initDb, createPublicKey } from "../db.ts";
import { cacheClear } from "../cache.ts";
import { handleListRpIds, handleListPublicKeys } from "./stats.ts";

beforeEach(() => {
  initDb(":memory:");
  cacheClear();
});

// --- handleListRpIds ---

test("handleListRpIds returns empty list", async () => {
  const req = new Request("http://localhost/api/stats/sites");
  const res = handleListRpIds(req);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.total).toBe(0);
  expect(body.items).toEqual([]);
  // No cache header for empty result
  expect(res.headers.get("Cache-Control")).toBeNull();
});

test("handleListRpIds returns sites with cache header", async () => {
  createPublicKey("a.com", "c1", "04a");
  const req = new Request("http://localhost/api/stats/sites");
  const res = handleListRpIds(req);
  const body = await res.json();
  expect(body.total).toBe(1);
  expect(body.items[0].rpId).toBe("a.com");
  expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
});

test("handleListRpIds respects pagination params", async () => {
  for (let i = 0; i < 5; i++) {
    createPublicKey(`site${i}.com`, "c1", `04${i}`);
  }
  const req = new Request("http://localhost/api/stats/sites?page=2&pageSize=2&order=asc");
  const res = handleListRpIds(req);
  const body = await res.json();
  expect(body.total).toBe(5);
  expect(body.page).toBe(2);
  expect(body.pageSize).toBe(2);
  expect(body.items.length).toBe(2);
});

test("handleListRpIds clamps pageSize to max 100", async () => {
  createPublicKey("a.com", "c1", "04a");
  const req = new Request("http://localhost/api/stats/sites?pageSize=999");
  const res = handleListRpIds(req);
  const body = await res.json();
  expect(body.pageSize).toBe(100);
});

// --- handleListPublicKeys ---

test("handleListPublicKeys returns 400 without rpId", async () => {
  const req = new Request("http://localhost/api/stats/keys");
  const res = handleListPublicKeys(req);
  expect(res.status).toBe(400);
});

test("handleListPublicKeys returns keys for rpId", async () => {
  createPublicKey("a.com", "c1", "04a");
  createPublicKey("a.com", "c2", "04b");
  const req = new Request("http://localhost/api/stats/keys?rpId=a.com");
  const res = handleListPublicKeys(req);
  const body = await res.json();
  expect(body.total).toBe(2);
  expect(body.items.length).toBe(2);
  expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
});

test("handleListPublicKeys returns empty for unknown rpId", async () => {
  const req = new Request("http://localhost/api/stats/keys?rpId=unknown.com");
  const res = handleListPublicKeys(req);
  const body = await res.json();
  expect(body.total).toBe(0);
  expect(res.headers.get("Cache-Control")).toBeNull();
});
