import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";

const CHALLENGE_TTL = 5 * 60 * 1000; // 5 minutes
const challenges = new Map<string, number>(); // challenge -> expiresAt

export function generateChallenge(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const challenge = Buffer.from(bytes).toString("base64url");
  challenges.set(challenge, Date.now() + CHALLENGE_TTL);
  return challenge;
}

export function consumeChallenge(challenge: string): boolean {
  const expiresAt = challenges.get(challenge);
  if (!expiresAt) return false;
  challenges.delete(challenge);
  return Date.now() <= expiresAt;
}

/**
 * Verify a WebAuthn assertion signature.
 *
 * WebAuthn signs: authenticatorData || SHA-256(clientDataJSON)
 * ECDSA P256 then hashes that with SHA-256 internally.
 *
 * clientDataJSON contains the challenge, so we verify it matches.
 */
export function verifyWebAuthnSignature(
  publicKeyHex: string,
  challenge: string,
  signatureHex: string,
  authenticatorDataBase64url: string,
  clientDataJSONBase64url: string,
): boolean {
  try {
    // 1. Decode and verify clientDataJSON contains the expected challenge
    const clientDataJSON = Buffer.from(clientDataJSONBase64url, "base64url");
    const clientData = JSON.parse(clientDataJSON.toString("utf-8"));
    // Browser base64url-encodes the challenge bytes in clientDataJSON
    // Client passes TextEncoder.encode(challenge) as challenge bytes
    const expectedChallengeB64 = Buffer.from(new TextEncoder().encode(challenge)).toString("base64url");
    if (clientData.challenge !== expectedChallengeB64) return false;
    if (clientData.type !== "webauthn.get") return false;

    // 2. Build the signed message: authenticatorData || SHA-256(clientDataJSON)
    const authenticatorData = Buffer.from(authenticatorDataBase64url, "base64url");
    const clientDataHash = sha256(new Uint8Array(clientDataJSON));
    const signedData = new Uint8Array(authenticatorData.length + clientDataHash.length);
    signedData.set(new Uint8Array(authenticatorData), 0);
    signedData.set(clientDataHash, authenticatorData.length);

    // 3. Verify signature
    const sigBytes = hexToBytes(signatureHex);
    const pubBytes = hexToBytes(publicKeyHex);
    return p256.verify(sigBytes, signedData, pubBytes);
  } catch {
    return false;
  }
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) hex = "0" + hex;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// Cleanup expired challenges periodically
setInterval(() => {
  const now = Date.now();
  for (const [challenge, expiresAt] of challenges) {
    if (now > expiresAt) {
      challenges.delete(challenge);
    }
  }
}, 60 * 1000);
