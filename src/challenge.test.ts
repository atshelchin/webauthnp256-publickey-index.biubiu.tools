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
  const clientData = JSON.stringify({
    type: "webauthn.get",
    challenge,
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
  ).toBe(true);
});

test("verifyWebAuthnSignature rejects wrong challenge", () => {
  const { secretKey, publicKey } = p256.keygen();
  const publicKeyHex = bytesToHex(publicKey);

  const { signatureHex, authenticatorDataBase64url, clientDataJSONBase64url } =
    makeWebAuthnAssertion(secretKey, "real-challenge");

  expect(
    verifyWebAuthnSignature(publicKeyHex, "wrong-challenge", signatureHex, authenticatorDataBase64url, clientDataJSONBase64url)
  ).toBe(false);
});

test("verifyWebAuthnSignature rejects wrong public key", () => {
  const { secretKey } = p256.keygen();
  const { publicKey: wrongPublicKey } = p256.keygen();
  const wrongPublicKeyHex = bytesToHex(wrongPublicKey);
  const challenge = "test-challenge";

  const { signatureHex, authenticatorDataBase64url, clientDataJSONBase64url } =
    makeWebAuthnAssertion(secretKey, challenge);

  expect(
    verifyWebAuthnSignature(wrongPublicKeyHex, challenge, signatureHex, authenticatorDataBase64url, clientDataJSONBase64url)
  ).toBe(false);
});

test("verifyWebAuthnSignature rejects tampered signature", () => {
  const { secretKey, publicKey } = p256.keygen();
  const publicKeyHex = bytesToHex(publicKey);
  const challenge = "test-challenge";

  const { authenticatorDataBase64url, clientDataJSONBase64url } =
    makeWebAuthnAssertion(secretKey, challenge);

  expect(
    verifyWebAuthnSignature(publicKeyHex, challenge, "deadbeef", authenticatorDataBase64url, clientDataJSONBase64url)
  ).toBe(false);
});

test("verifyWebAuthnSignature rejects wrong clientDataJSON type", () => {
  const { secretKey, publicKey } = p256.keygen();
  const publicKeyHex = bytesToHex(publicKey);
  const challenge = "test-challenge";

  // Build clientDataJSON with wrong type
  const clientData = JSON.stringify({ type: "webauthn.create", challenge, origin: "https://example.com" });
  const clientDataJSON = new TextEncoder().encode(clientData);
  const authenticatorData = new Uint8Array(37);
  const clientDataHash = sha256(clientDataJSON);
  const signedData = new Uint8Array(37 + clientDataHash.length);
  signedData.set(authenticatorData, 0);
  signedData.set(clientDataHash, 37);
  const signature = p256.sign(signedData, secretKey);

  expect(
    verifyWebAuthnSignature(
      publicKeyHex, challenge, bytesToHex(signature),
      toBase64url(authenticatorData), toBase64url(clientDataJSON)
    )
  ).toBe(false);
});

test("verifyWebAuthnSignature returns false for empty strings", () => {
  expect(verifyWebAuthnSignature("", "", "", "", "")).toBe(false);
});

test("verifyWebAuthnSignature returns false for malformed inputs", () => {
  expect(verifyWebAuthnSignature("zzzz", "challenge", "deadbeef", "xxx", "yyy")).toBe(false);
});
