import { assertEquals, assert } from "@std/assert/";
import { handleListRpIds } from "../../shared/routes/stats.ts";
import { cacheSet, cacheClear, _configureForTest, _resetConfigForTest } from "../../shared/cache.ts";
import { markFailed, getReadCircuitState, _resetForTest } from "../../shared/rpc.ts";

const TEST_RPCS = ["https://a.test", "https://b.test"];

/** Open the read circuit so contract reads fast-fail with DependencyError — no network. */
function openCircuit() {
  _resetForTest(TEST_RPCS);
  for (const r of TEST_RPCS) markFailed(r);
  assertEquals(getReadCircuitState(), "open");
}

function cleanup() {
  _resetForTest();        // clear failedRpcs + restore default RPC list
  _resetConfigForTest();  // restore default cache TTL/limits
  cacheClear();
}

Deno.test("stats handler serves last-known-good when the chain is unreachable", async () => {
  cacheClear();
  _resetConfigForTest();
  _configureForTest({ ttl: 5 }); // expire fast so the entry becomes stale (retained)
  try {
    // Seed LKG under the exact key handleListRpIds computes for page1/size20/desc.
    cacheSet("stats:rpIds:1:20:desc", {
      total: 7, page: 1, pageSize: 20,
      items: [{ rpId: "old.com", publicKeyCount: 3, createdAt: 1 }],
    });
    await new Promise((r) => setTimeout(r, 15)); // now stale, but retained

    openCircuit();

    const res = await handleListRpIds(new Request("http://localhost/api/stats/sites"));
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("X-Served-Stale"), "true");
    assertEquals(res.headers.get("Cache-Control"), "no-cache");
    const body = await res.json();
    assertEquals(body._stale, true);
    assertEquals(body.total, 7);
    assert(typeof body._staleAgeMs === "number" && body._staleAgeMs >= 15);
  } finally {
    cleanup();
  }
});

Deno.test("stats handler returns 503 + Retry-After when there is no last-known-good", async () => {
  cacheClear();
  _resetConfigForTest();
  try {
    openCircuit();
    // page=99 was never cached → no stale fallback → stable retryable 503.
    const res = await handleListRpIds(new Request("http://localhost/api/stats/sites?page=99"));
    assertEquals(res.status, 503);
    assert(res.headers.get("Retry-After") !== null, "must hint Retry-After");
    const body = await res.json();
    assertEquals(body.retryable, true);
    assertEquals(body.dependency, "rpc");
  } finally {
    cleanup();
  }
});

// --- Negative-cache sentinel must never be served as a stale record body ---
import { NOT_FOUND, NEGATIVE_TTL_MS, cacheSet as _cs, cacheGetStale as _cgs } from "../../shared/cache.ts";

Deno.test("a cached NOT_FOUND sentinel is retained but callers can distinguish it from a record", () => {
  _cs("neg:test:key", NOT_FOUND, NEGATIVE_TTL_MS);
  const stale = _cgs<object>("neg:test:key");
  // The sentinel is reference-comparable — the query routes rely on this to
  // return 503 (not a fabricated 200 body) when the chain is down and the
  // only cached state is a negative.
  if (!stale) throw new Error("sentinel should be retained for stale reads");
  if (stale.value !== NOT_FOUND) throw new Error("sentinel must compare by reference");
});
