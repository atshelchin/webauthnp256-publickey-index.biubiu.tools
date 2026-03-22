import { test, expect } from "bun:test";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { generateChallenge, consumeChallenge, verifyWebAuthnSignature } from "./challenge.ts";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Simulate what a WebAuthn authenticator does:
 * - Build clientDataJSON containing the challenge
 * - Build authenticatorData (fake 37 bytes)
 * - Sign authenticatorData || SHA-256(clientDataJSON)
 */
function makeWebAuthnAssertion(secretKey: Uint8Array, challenge: string) {
  // Browser base64url-encodes the challenge bytes in clientDataJSON
  const challengeB64 = Buffer.from(new TextEncoder().encode(challenge)).toString("base64url");
  const clientData = JSON.stringify({
    type: "webauthn.get",
    challenge: challengeB64,
    origin: "https://example.com",
    crossOrigin: false,
  });
  const clientDataJSON = new TextEncoder().encode(clientData);
  const authenticatorData = new Uint8Array(37); // minimal fake authenticatorData
  crypto.getRandomValues(authenticatorData);

  const clientDataHash = sha256(clientDataJSON);
  const signedData = new Uint8Array(authenticatorData.length + clientDataHash.length);
  signedData.set(authenticatorData, 0);
  signedData.set(clientDataHash, authenticatorData.length);

  const signature = p256.sign(signedData, secretKey);

  return {
    signatureHex: bytesToHex(signature),
    authenticatorDataBase64url: toBase64url(authenticatorData),
    clientDataJSONBase64url: toBase64url(clientDataJSON),
  };
}

// --- generateChallenge ---

test("generateChallenge returns a base64url string", () => {
  const challenge = generateChallenge();
  expect(challenge.length).toBeGreaterThan(0);
  expect(/^[A-Za-z0-9_-]+$/.test(challenge)).toBe(true);
});

test("generateChallenge returns unique values", () => {
  const c1 = generateChallenge();
  const c2 = generateChallenge();
  expect(c1).not.toBe(c2);
});

// --- consumeChallenge ---

test("consumeChallenge returns true for valid challenge", () => {
  const challenge = generateChallenge();
  expect(consumeChallenge(challenge)).toBe(true);
});

test("consumeChallenge returns false for already consumed", () => {
  const challenge = generateChallenge();
  consumeChallenge(challenge);
  expect(consumeChallenge(challenge)).toBe(false);
});

test("consumeChallenge returns false for unknown challenge", () => {
  expect(consumeChallenge("nonexistent")).toBe(false);
});

// --- verifyWebAuthnSignature ---

test("verifyWebAuthnSignature validates a correct WebAuthn assertion", () => {
  const { secretKey, publicKey } = p256.keygen();
  const publicKeyHex = bytesToHex(publicKey);
  const challenge = "test-challenge-123";

  const { signatureHex, authenticatorDataBase64url, clientDataJSONBase64url } =
    makeWebAuthnAssertion(secretKey, challenge);

  expect(
    verifyWebAuthnSignature(publicKeyHex, challenge, signatureHex, authenticatorDataBase64url, clientDataJSONBase64url)
  ).toEqual({ ok: true });
});

test("verifyWebAuthnSignature rejects wrong challenge", () => {
  const { secretKey, publicKey } = p256.keygen();
  const publicKeyHex = bytesToHex(publicKey);

  const { signatureHex, authenticatorDataBase64url, clientDataJSONBase64url } =
    makeWebAuthnAssertion(secretKey, "real-challenge");

  const result = verifyWebAuthnSignature(publicKeyHex, "wrong-challenge", signatureHex, authenticatorDataBase64url, clientDataJSONBase64url);
  expect(result.ok).toBe(false);
  expect(result.error).toContain("challenge mismatch");
});

test("verifyWebAuthnSignature rejects wrong public key", () => {
  const { secretKey } = p256.keygen();
  const { publicKey: wrongPublicKey } = p256.keygen();
  const wrongPublicKeyHex = bytesToHex(wrongPublicKey);
  const challenge = "test-challenge";

  const { signatureHex, authenticatorDataBase64url, clientDataJSONBase64url } =
    makeWebAuthnAssertion(secretKey, challenge);

  const result = verifyWebAuthnSignature(wrongPublicKeyHex, challenge, signatureHex, authenticatorDataBase64url, clientDataJSONBase64url);
  expect(result.ok).toBe(false);
  expect(result.error).toContain("p256.verify failed");
});

test("verifyWebAuthnSignature rejects tampered signature", () => {
  const { secretKey, publicKey } = p256.keygen();
  const publicKeyHex = bytesToHex(publicKey);
  const challenge = "test-challenge";

  const { authenticatorDataBase64url, clientDataJSONBase64url } =
    makeWebAuthnAssertion(secretKey, challenge);

  const result = verifyWebAuthnSignature(publicKeyHex, challenge, "deadbeef", authenticatorDataBase64url, clientDataJSONBase64url);
  expect(result.ok).toBe(false);
});

test("verifyWebAuthnSignature rejects wrong clientDataJSON type", () => {
  const { secretKey, publicKey } = p256.keygen();
  const publicKeyHex = bytesToHex(publicKey);
  const challenge = "test-challenge";

  const challengeB64 = Buffer.from(new TextEncoder().encode(challenge)).toString("base64url");
  const clientData = JSON.stringify({ type: "webauthn.create", challenge: challengeB64, origin: "https://example.com" });
  const clientDataJSON = new TextEncoder().encode(clientData);
  const authenticatorData = new Uint8Array(37);
  const clientDataHash = sha256(clientDataJSON);
  const signedData = new Uint8Array(37 + clientDataHash.length);
  signedData.set(authenticatorData, 0);
  signedData.set(clientDataHash, 37);
  const signature = p256.sign(signedData, secretKey);

  const result = verifyWebAuthnSignature(
    publicKeyHex, challenge, bytesToHex(signature),
    toBase64url(authenticatorData), toBase64url(clientDataJSON)
  );
  expect(result.ok).toBe(false);
  expect(result.error).toContain("wrong type");
});

test("verifyWebAuthnSignature returns error for empty strings", () => {
  expect(verifyWebAuthnSignature("", "", "", "", "").ok).toBe(false);
});

test("verifyWebAuthnSignature returns error for malformed inputs", () => {
  expect(verifyWebAuthnSignature("zzzz", "challenge", "deadbeef", "xxx", "yyy").ok).toBe(false);
});
