import { p256 } from "@noble/curves/nist.js";

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

// p256 v2 hashes message internally with sha256
export function verifySignature(publicKeyHex: string, challenge: string, signatureHex: string): boolean {
  try {
    const message = new TextEncoder().encode(challenge);
    const sigBytes = hexToBytes(signatureHex);
    const pubBytes = hexToBytes(publicKeyHex);
    return p256.verify(sigBytes, message, pubBytes);
  } catch {
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
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
