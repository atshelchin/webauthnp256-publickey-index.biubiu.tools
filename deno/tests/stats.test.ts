import { assertEquals } from "@std/assert/";
import { cacheClear } from "../../shared/cache.ts";
import { handleListRpIds, handleListPublicKeys, handleTotalCredentials } from "../../shared/routes/stats.ts";

// LIVE-CHAIN suite: these tests read the real Gnosis contract, so results
// depend on live chain state and RPC availability — flaky-by-design in CI.
// Gated behind RUN_LIVE_TESTS=1 (docs 08 P2-11); run locally before deploys.
const LIVE = !!Deno.env.get("RUN_LIVE_TESTS");

function setup() {
  cacheClear();
}

Deno.test({ name: "handleListRpIds returns valid response", ignore: !LIVE, fn: async () => {
  setup();
  const req = new Request("http://localhost/api/stats/sites");
  const res = await handleListRpIds(req);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(typeof body.total, "number");
  assertEquals(typeof body.page, "number");
  assertEquals(typeof body.pageSize, "number");
  assertEquals(Array.isArray(body.items), true);
} });

Deno.test({ name: "handleListRpIds respects pagination params", ignore: !LIVE, fn: async () => {
  setup();
  const req = new Request("http://localhost/api/stats/sites?page=1&pageSize=2&order=asc");
  const res = await handleListRpIds(req);
  const body = await res.json();
  assertEquals(body.page, 1);
  assertEquals(body.pageSize, 2);
} });

Deno.test({ name: "handleListRpIds clamps pageSize to max 100", ignore: !LIVE, fn: async () => {
  setup();
  const req = new Request("http://localhost/api/stats/sites?pageSize=999");
  const res = await handleListRpIds(req);
  const body = await res.json();
  assertEquals(body.pageSize, 100);
} });

// --- handleTotalCredentials ---

Deno.test({ name: "handleTotalCredentials returns total count", ignore: !LIVE, fn: async () => {
  setup();
  const res = await handleTotalCredentials();
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(typeof body.totalCredentials, "number");
} });

// --- handleListPublicKeys ---

Deno.test({ name: "handleListPublicKeys returns 400 without rpId", ignore: !LIVE, fn: async () => {
  setup();
  const req = new Request("http://localhost/api/stats/keys");
  const res = await handleListPublicKeys(req);
  assertEquals(res.status, 400);
} });

Deno.test({ name: "handleListPublicKeys returns valid response for unknown rpId", ignore: !LIVE, fn: async () => {
  setup();
  const req = new Request("http://localhost/api/stats/keys?rpId=nonexistent-test-domain.invalid");
  const res = await handleListPublicKeys(req);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.total, 0);
  assertEquals(body.items, []);
} });
