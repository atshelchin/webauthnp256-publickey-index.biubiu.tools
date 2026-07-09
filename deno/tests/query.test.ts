import { assertEquals } from "@std/assert/";
import { cacheClear } from "../../shared/cache.ts";
import { initQueue } from "../queue.ts";
import { handleQuery } from "../routes/query.ts";

// LIVE-CHAIN suite: these tests read the real Gnosis contract, so results
// depend on live chain state and RPC availability — flaky-by-design in CI.
// Gated behind RUN_LIVE_TESTS=1 (docs 08 P2-11); run locally before deploys.
const LIVE = !!Deno.env.get("RUN_LIVE_TESTS");

async function setup() {
  cacheClear();
  await initQueue(":memory:");
}

Deno.test({ name: "handleQuery returns 400 when rpId missing", ignore: !LIVE, fn: async () => {
  await setup();
  const req = new Request("http://localhost/api/query?credentialId=c1");
  const res = await handleQuery(req);
  assertEquals(res.status, 400);
} });

Deno.test({ name: "handleQuery returns 400 when credentialId missing", ignore: !LIVE, fn: async () => {
  await setup();
  const req = new Request("http://localhost/api/query?rpId=site.com");
  const res = await handleQuery(req);
  assertEquals(res.status, 400);
} });

Deno.test({ name: "handleQuery returns 404 when not found", ignore: !LIVE, fn: async () => {
  await setup();
  const req = new Request("http://localhost/api/query?rpId=nonexistent-test-domain.invalid&credentialId=c1");
  const res = await handleQuery(req);
  assertEquals(res.status, 404);
} });

// --- walletRef negative-cache must still consult the queue (offline; no chain) ---
import { initQueue as _initQ, enqueue as _enqueue } from "../queue.ts";
import { cacheClear as _cc } from "../../shared/cache.ts";
import { handleQuery as _hq } from "../routes/query.ts";
import { buildWalletRef as _bwr } from "../../shared/wallet-ref.ts";

Deno.test("query by walletRef falls back to the queue for a just-enqueued create (redacted)", async () => {
  _cc();
  await _initQ(":memory:");
  const pub = "046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5";
  const walletRef = _bwr(pub);
  await _enqueue({ rpId: "wr.test", credentialId: "wr-cred", walletRef, publicKey: pub, name: "n", initialCredentialId: "wr-cred", metadata: "0x00", ip: "1.2.3.4" });
  const res = await _hq(new Request(`http://localhost/api/query?walletRef=${walletRef}`));
  // Not on-chain, but pending in the queue → 200 with _queue and NO credentialId/walletRef.
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body._queue?.status, "pending");
  assertEquals(body.publicKey, pub);
  assertEquals("credentialId" in body, false, "front-running redaction on the walletRef fallback too");
  assertEquals("walletRef" in body, false);
});
