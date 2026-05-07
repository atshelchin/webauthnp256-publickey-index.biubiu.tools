import { assertEquals } from "@std/assert/";
import { cacheClear } from "../cache.ts";
import { handleListRpIds, handleListPublicKeys } from "./stats.ts";

function setup() {
  cacheClear();
}

Deno.test("handleListRpIds returns valid response", async () => {
  setup();
  const req = new Request("http://localhost/api/stats/sites");
  const res = await handleListRpIds(req);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(typeof body.total, "number");
  assertEquals(typeof body.page, "number");
  assertEquals(typeof body.pageSize, "number");
  assertEquals(Array.isArray(body.items), true);
});

Deno.test("handleListRpIds respects pagination params", async () => {
  setup();
  const req = new Request("http://localhost/api/stats/sites?page=1&pageSize=2&order=asc");
  const res = await handleListRpIds(req);
  const body = await res.json();
  assertEquals(body.page, 1);
  assertEquals(body.pageSize, 2);
});

Deno.test("handleListRpIds clamps pageSize to max 100", async () => {
  setup();
  const req = new Request("http://localhost/api/stats/sites?pageSize=999");
  const res = await handleListRpIds(req);
  const body = await res.json();
  assertEquals(body.pageSize, 100);
});

// --- handleListPublicKeys ---

Deno.test("handleListPublicKeys returns 400 without rpId", async () => {
  setup();
  const req = new Request("http://localhost/api/stats/keys");
  const res = await handleListPublicKeys(req);
  assertEquals(res.status, 400);
});

Deno.test("handleListPublicKeys returns valid response for unknown rpId", async () => {
  setup();
  const req = new Request("http://localhost/api/stats/keys?rpId=nonexistent-test-domain.invalid");
  const res = await handleListPublicKeys(req);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.total, 0);
  assertEquals(body.items, []);
});
