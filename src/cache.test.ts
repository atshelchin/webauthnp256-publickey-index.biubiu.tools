import { test, expect, beforeEach } from "bun:test";
import { cacheGet, cacheSet, cacheInvalidateByRpId, cacheClear, cacheSize, cacheMemoryUsage } from "./cache.ts";

beforeEach(() => {
  cacheClear();
});

test("cacheGet returns undefined for missing key", () => {
  expect(cacheGet("missing")).toBeUndefined();
});

test("cacheSet and cacheGet round-trip", () => {
  cacheSet("key1", { data: "hello" });
  expect(cacheGet("key1")).toEqual({ data: "hello" });
});

test("cacheInvalidateByRpId clears matching query keys", () => {
  cacheSet("query:example.com:cred1", { pk: "04abc" });
  cacheSet("query:other.com:cred1", { pk: "04def" });

  cacheInvalidateByRpId("example.com");

  expect(cacheGet("query:example.com:cred1")).toBeUndefined();
  expect(cacheGet("query:other.com:cred1")).not.toBeUndefined();
});

test("cacheInvalidateByRpId clears stats keys", () => {
  cacheSet("stats:rpIds:1:10:desc", { total: 1 });
  cacheSet("stats:keys:example.com:1:10:desc", { total: 1 });

  cacheInvalidateByRpId("example.com");

  expect(cacheGet("stats:rpIds:1:10:desc")).toBeUndefined();
  expect(cacheGet("stats:keys:example.com:1:10:desc")).toBeUndefined();
});

test("cacheClear removes all entries", () => {
  cacheSet("a", 1);
  cacheSet("b", 2);
  cacheClear();
  expect(cacheSize()).toBe(0);
});

test("cacheSize returns correct count", () => {
  expect(cacheSize()).toBe(0);
  cacheSet("a", 1);
  cacheSet("b", 2);
  expect(cacheSize()).toBe(2);
});

// --- Memory usage & eviction ---

test("cacheMemoryUsage tracks size", () => {
  expect(cacheMemoryUsage()).toBe(0);
  cacheSet("k1", { data: "hello" });
  expect(cacheMemoryUsage()).toBeGreaterThan(0);
});

test("cacheMemoryUsage resets after cacheClear", () => {
  cacheSet("k1", { data: "hello" });
  cacheClear();
  expect(cacheMemoryUsage()).toBe(0);
});

test("cacheSet overwrites existing key and updates size", () => {
  cacheSet("k1", "short");
  const size1 = cacheMemoryUsage();
  cacheSet("k1", "a much longer string value here");
  const size2 = cacheMemoryUsage();
  expect(size2).toBeGreaterThan(size1);
  expect(cacheSize()).toBe(1);
});

test("cacheInvalidateByRpId decreases memory usage", () => {
  cacheSet("query:x.com:c1", { pk: "04abc" });
  const before = cacheMemoryUsage();
  cacheInvalidateByRpId("x.com");
  expect(cacheMemoryUsage()).toBeLessThan(before);
});
