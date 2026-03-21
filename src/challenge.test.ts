import { test, expect } from "bun:test";
import { p256 } from "@noble/curves/nist.js";
import { generateChallenge, consumeChallenge, verifySignature } from "./challenge.ts";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

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

test("verifySignature validates a correct signature", () => {
  const { secretKey, publicKey } = p256.keygen();
  const publicKeyHex = bytesToHex(publicKey);

  const challenge = "test-challenge-123";
  const message = new TextEncoder().encode(challenge);
  const signature = p256.sign(message, secretKey);
  const signatureHex = bytesToHex(signature);

  expect(verifySignature(publicKeyHex, challenge, signatureHex)).toBe(true);
});

test("verifySignature rejects wrong signature", () => {
  const { publicKey } = p256.keygen();
  const publicKeyHex = bytesToHex(publicKey);

  expect(verifySignature(publicKeyHex, "challenge", "deadbeef")).toBe(false);
});

test("verifySignature rejects wrong public key", () => {
  const { secretKey } = p256.keygen();
  const { publicKey: wrongPublicKey } = p256.keygen();
  const wrongPublicKeyHex = bytesToHex(wrongPublicKey);

  const challenge = "test-challenge";
  const message = new TextEncoder().encode(challenge);
  const signature = p256.sign(message, secretKey);
  const signatureHex = bytesToHex(signature);

  expect(verifySignature(wrongPublicKeyHex, challenge, signatureHex)).toBe(false);
});

test("verifySignature returns false for malformed hex public key", () => {
  expect(verifySignature("zzzz", "challenge", "deadbeef")).toBe(false);
});

test("verifySignature returns false for empty strings", () => {
  expect(verifySignature("", "", "")).toBe(false);
});

test("verifySignature returns false for odd-length hex", () => {
  expect(verifySignature("abc", "challenge", "def")).toBe(false);
});
