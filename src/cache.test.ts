import { assertEquals, assert } from "@std/assert/";
import { cacheGet, cacheSet, cacheClear, cacheSize, cacheMemoryUsage } from "./cache.ts";

function setup() {
  cacheClear();
}

Deno.test("cacheGet returns undefined for missing key", () => {
  setup();
  assertEquals(cacheGet("missing"), undefined);
});

Deno.test("cacheSet and cacheGet round-trip", () => {
  setup();
  cacheSet("key1", { data: "hello" });
  assertEquals(cacheGet("key1"), { data: "hello" });
});

Deno.test("cacheClear removes all entries", () => {
  setup();
  cacheSet("a", 1);
  cacheSet("b", 2);
  cacheClear();
  assertEquals(cacheSize(), 0);
});

Deno.test("cacheSize returns correct count", () => {
  setup();
  assertEquals(cacheSize(), 0);
  cacheSet("a", 1);
  cacheSet("b", 2);
  assertEquals(cacheSize(), 2);
});

// --- Memory usage & eviction ---

Deno.test("cacheMemoryUsage tracks size", () => {
  setup();
  assertEquals(cacheMemoryUsage(), 0);
  cacheSet("k1", { data: "hello" });
  assert(cacheMemoryUsage() > 0);
});

Deno.test("cacheMemoryUsage resets after cacheClear", () => {
  setup();
  cacheSet("k1", { data: "hello" });
  cacheClear();
  assertEquals(cacheMemoryUsage(), 0);
});

Deno.test("cacheSet overwrites existing key and updates size", () => {
  setup();
  cacheSet("k1", "short");
  const size1 = cacheMemoryUsage();
  cacheSet("k1", "a much longer string value here");
  const size2 = cacheMemoryUsage();
  assert(size2 > size1);
  assertEquals(cacheSize(), 1);
});
