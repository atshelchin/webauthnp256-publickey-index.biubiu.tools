import { assertEquals } from "@std/assert/";
import { cacheClear } from "../cache.ts";
import { handleQuery } from "./query.ts";

function setup() {
  cacheClear();
}

Deno.test("handleQuery returns 400 when rpId missing", async () => {
  setup();
  const req = new Request("http://localhost/api/query?credentialId=c1");
  const res = await handleQuery(req);
  assertEquals(res.status, 400);
});

Deno.test("handleQuery returns 400 when credentialId missing", async () => {
  setup();
  const req = new Request("http://localhost/api/query?rpId=site.com");
  const res = await handleQuery(req);
  assertEquals(res.status, 400);
});

Deno.test("handleQuery returns 404 when not found", async () => {
  setup();
  const req = new Request("http://localhost/api/query?rpId=nonexistent-test-domain.invalid&credentialId=c1");
  const res = await handleQuery(req);
  assertEquals(res.status, 404);
});
