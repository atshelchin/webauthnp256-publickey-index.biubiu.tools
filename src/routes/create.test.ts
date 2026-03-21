import { test, expect, beforeEach } from "bun:test";
import { p256 } from "@noble/curves/nist.js";
import { initDb, getPublicKey } from "../db.ts";
import { cacheClear, cacheSet, cacheGet } from "../cache.ts";
import { generateChallenge } from "../challenge.ts";
import { handleChallenge, handleCreate } from "./create.ts";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

beforeEach(() => {
  initDb(":memory:");
  cacheClear();
});

// --- handleChallenge ---

test("handleChallenge returns a challenge", async () => {
  const res = handleChallenge();
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.challenge).toBeDefined();
  expect(body.challenge.length).toBeGreaterThan(0);
});

// --- handleCreate ---

function makeSignedBody(overrides: Record<string, unknown> = {}) {
  const { secretKey, publicKey } = p256.keygen();
  const publicKeyHex = bytesToHex(publicKey);
  const challenge = generateChallenge();
  const message = new TextEncoder().encode(challenge);
  const signature = p256.sign(message, secretKey);
  const signatureHex = bytesToHex(signature);

  return {
    rpId: "site.com",
    credentialId: "cred1",
    publicKey: publicKeyHex,
    challenge,
    signature: signatureHex,
    ...overrides,
  };
}

function makeRequest(body: object): Request {
  return new Request("http://localhost/api/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("handleCreate returns 400 for invalid JSON", async () => {
  const req = new Request("http://localhost/api/create", {
    method: "POST",
    body: "not json",
  });
  const res = await handleCreate(req);
  expect(res.status).toBe(400);
});

test("handleCreate returns 400 for missing fields", async () => {
  const res = await handleCreate(makeRequest({ rpId: "site.com" }));
  expect(res.status).toBe(400);
});

test("handleCreate returns 400 for invalid challenge", async () => {
  const body = makeSignedBody({ challenge: "bogus" });
  const res = await handleCreate(makeRequest(body));
  expect(res.status).toBe(400);
  const json = await res.json();
  expect(json.error).toContain("challenge");
});

test("handleCreate returns 400 for bad signature", async () => {
  const challenge = generateChallenge();
  const { publicKey } = p256.keygen();
  const publicKeyHex = bytesToHex(publicKey);

  const body = {
    rpId: "site.com",
    credentialId: "c1",
    publicKey: publicKeyHex,
    challenge,
    signature: "deadbeef",
  };
  const res = await handleCreate(makeRequest(body));
  expect(res.status).toBe(400);
  const json = await res.json();
  expect(json.error).toContain("signature");
});

test("handleCreate succeeds with valid data", async () => {
  const body = makeSignedBody();
  const res = await handleCreate(makeRequest(body));
  expect(res.status).toBe(201);
  const json = await res.json();
  expect(json.rpId).toBe("site.com");
  expect(json.publicKey).toBe(body.publicKey);

  const record = getPublicKey("site.com", "cred1");
  expect(record).not.toBeNull();
});

test("handleCreate returns 409 for duplicate", async () => {
  const body = makeSignedBody();
  await handleCreate(makeRequest(body));

  const body2 = makeSignedBody({ credentialId: "cred1" });
  const res = await handleCreate(makeRequest(body2));
  expect(res.status).toBe(409);
});

test("handleCreate invalidates cache", async () => {
  cacheSet("query:site.com:cred1", { cached: true });
  cacheSet("stats:rpIds:1:10:desc", { cached: true });

  const body = makeSignedBody();
  await handleCreate(makeRequest(body));

  expect(cacheGet("query:site.com:cred1")).toBeUndefined();
  expect(cacheGet("stats:rpIds:1:10:desc")).toBeUndefined();
});
