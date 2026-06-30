/**
 * Input validation for API routes.
 * Prevents oversized inputs from consuming memory or polluting cache.
 */

// Max lengths for string fields (bytes)
const LIMITS = {
  rpId: 253,            // max DNS hostname length
  credentialId: 1024,   // WebAuthn spec allows variable length, 1KB is generous
  publicKey: 130,       // uncompressed P256: "04" + 64 hex bytes = 130 chars
  name: 256,            // display name
  walletRef: 66,        // "0x" + 32 bytes hex = 66 chars
  initialCredentialId: 1024,
  metadata: 4096,       // abi-encoded metadata
} as const;

// Fields that must be valid hex strings (with or without 0x prefix)
const HEX_FIELDS = new Set<string>(["publicKey", "walletRef", "metadata"]);
const HEX_RE = /^(0x)?[0-9a-fA-F]*$/;

export type FieldName = keyof typeof LIMITS;

export function validateStringLength(
  fields: Partial<Record<FieldName, string | undefined | null>>,
): string | null {
  for (const [name, value] of Object.entries(fields)) {
    if (value == null) continue;
    const limit = LIMITS[name as FieldName];
    if (limit && value.length > limit) {
      return `${name} exceeds max length (${limit})`;
    }
    if (HEX_FIELDS.has(name)) {
      if (!HEX_RE.test(value)) {
        return `${name} must be a valid hex string`;
      }
      // Fixed-width / byte-alignment enforcement. These fields are consumed as
      // ABI parameters (walletRef=bytes32, publicKey/metadata=bytes) in the
      // background worker; an out-of-spec value would throw inside the encoder
      // and — before this guard — crash the whole tx batch (queue-wide DoS).
      // Reject it at the trust boundary instead.
      const hex = value.startsWith("0x") ? value.slice(2) : value;
      if (name === "walletRef" && hex.length !== 64) {
        return "walletRef must be a 32-byte hex string (64 hex chars)";
      }
      if (name === "publicKey" && !/^04[0-9a-fA-F]{128}$/.test(hex)) {
        return "publicKey must be an uncompressed P256 key (04 + 128 hex chars)";
      }
      if (name === "metadata" && hex.length % 2 !== 0) {
        return "metadata must be byte-aligned hex (even number of hex chars)";
      }
    }
  }
  return null;
}
