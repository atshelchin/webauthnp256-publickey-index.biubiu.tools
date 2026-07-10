import { assertEquals } from "@std/assert/";
import { cacheClear } from "../../shared/cache.ts";
import { initQueue } from "../queue.ts";
import { handleCreate, handleCreateStatus } from "../routes/create.ts";

async function setup() {
  cacheClear();
  await initQueue(":memory:");
}

function makeCreateRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  rpId: "example.com",
  credentialId: "cred123",
  // A REAL P-256 point (the curve generator G) — validation now rejects
  // format-valid-but-off-curve keys at the trust boundary.
  publicKey: "046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5",
  name: "Test Key",
};

// --- Missing required fields ---

Deno.test("handleCreate returns 400 when body is not JSON", async () => {
  await setup();
  const req = new Request("http://localhost/api/create", {
    method: "POST",
    body: "not json",
  });
  const res = await handleCreate(req);
  assertEquals(res.status, 400);
});

Deno.test("handleCreate returns 400 when rpId is missing", async () => {
  await setup();
  const res = await handleCreate(makeCreateRequest({ ...VALID_BODY, rpId: undefined }));
  assertEquals(res.status, 400);
});

Deno.test("handleCreate returns 400 when credentialId is missing", async () => {
  await setup();
  const res = await handleCreate(makeCreateRequest({ ...VALID_BODY, credentialId: undefined }));
  assertEquals(res.status, 400);
});

Deno.test("handleCreate returns 400 when publicKey is missing", async () => {
  await setup();
  const res = await handleCreate(makeCreateRequest({ ...VALID_BODY, publicKey: undefined }));
  assertEquals(res.status, 400);
});

Deno.test("handleCreate returns 400 when name is missing", async () => {
  await setup();
  const res = await handleCreate(makeCreateRequest({ ...VALID_BODY, name: undefined }));
  assertEquals(res.status, 400);
});

// --- Input length validation ---

Deno.test("handleCreate returns 400 when rpId exceeds max length", async () => {
  await setup();
  const res = await handleCreate(makeCreateRequest({ ...VALID_BODY, rpId: "a".repeat(254) }));
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error.includes("rpId"), true);
});

Deno.test("handleCreate returns 400 when name exceeds max length", async () => {
  await setup();
  const res = await handleCreate(makeCreateRequest({ ...VALID_BODY, name: "n".repeat(257) }));
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error.includes("name"), true);
});

Deno.test("handleCreate returns 400 when publicKey exceeds max length", async () => {
  await setup();
  const res = await handleCreate(makeCreateRequest({ ...VALID_BODY, publicKey: "0".repeat(131) }));
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error.includes("publicKey"), true);
});

// --- Security: walletRef binding (identity-forgery guard) ---

Deno.test("handleCreate rejects a walletRef that does not match the publicKey", async () => {
  await setup();
  const res = await handleCreate(makeCreateRequest({
    ...VALID_BODY,
    credentialId: "wr-bind-test",
    // valid 32-byte hex, but NOT the address derived from publicKey → forgery attempt
    walletRef: "0x" + "11".repeat(32),
  }));
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error.includes("walletRef"), true);
});

// --- handleCreateStatus ---

Deno.test("handleCreateStatus returns 404 for unknown id", async () => {
  await setup();
  const req = new Request("http://localhost/api/create/nonexistent-id");
  const res = handleCreateStatus(req);
  assertEquals(res.status, 404);
});

Deno.test("handleCreateStatus returns 400 when id is empty", async () => {
  await setup();
  const req = new Request("http://localhost/api/create/");
  const res = handleCreateStatus(req);
  // path.split("/").pop() returns "" → treated as missing
  assertEquals(res.status, 400);
});

// --- P0 regression: negative-cache sentinel must NEVER be served as a record ---
import { cacheSet as _cset, cacheKey as _ckey, NOT_FOUND as _NF, NEGATIVE_TTL_MS as _NTTL } from "../../shared/cache.ts";

Deno.test("handleCreate: a cached NOT_FOUND does NOT short-circuit to 201 — the create is still enqueued", async () => {
  await setup();
  const rpId = "sentinel.test", credentialId = "cred-sentinel";
  // Simulate a prior /api/query that negatively-cached this exact key.
  _cset(_ckey("query", rpId, credentialId), _NF, _NTTL);
  const res = await handleCreate(makeCreateRequest({ ...VALID_BODY, rpId, credentialId }));
  // Must NOT be 201 "done" (that would silently drop the user's account) —
  // either 202 (enqueued) or a 503 if the chain precheck was skipped/busy,
  // but never a fabricated success.
  assertEquals(res.status === 201, false, "sentinel must not be treated as an existing record");
  const body = await res.json();
  assertEquals(body.status === "done", false);
});
