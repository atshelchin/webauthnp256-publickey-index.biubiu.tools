import { assertEquals } from "@std/assert/";
import { validateStringLength } from "../../shared/validation.ts";

Deno.test("validateStringLength passes valid inputs", () => {
  assertEquals(validateStringLength({
    rpId: "example.com",
    credentialId: "abc123",
    publicKey: "04" + "aa".repeat(64),
    name: "My Key",
  }), null);
});

Deno.test("validateStringLength passes when fields are undefined", () => {
  assertEquals(validateStringLength({
    rpId: "example.com",
    walletRef: undefined,
    metadata: undefined,
  }), null);
});

Deno.test("validateStringLength rejects oversized rpId", () => {
  const result = validateStringLength({ rpId: "a".repeat(254) });
  assertEquals(typeof result, "string");
  assertEquals(result!.includes("rpId"), true);
});

Deno.test("validateStringLength rejects oversized credentialId", () => {
  const result = validateStringLength({ credentialId: "x".repeat(1025) });
  assertEquals(typeof result, "string");
  assertEquals(result!.includes("credentialId"), true);
});

Deno.test("validateStringLength rejects oversized publicKey", () => {
  const result = validateStringLength({ publicKey: "0".repeat(131) });
  assertEquals(typeof result, "string");
  assertEquals(result!.includes("publicKey"), true);
});

Deno.test("validateStringLength rejects oversized name", () => {
  const result = validateStringLength({ name: "n".repeat(257) });
  assertEquals(typeof result, "string");
  assertEquals(result!.includes("name"), true);
});

Deno.test("validateStringLength rejects oversized walletRef", () => {
  const result = validateStringLength({ walletRef: "0x" + "f".repeat(65) });
  assertEquals(typeof result, "string");
  assertEquals(result!.includes("walletRef"), true);
});

Deno.test("validateStringLength rejects oversized metadata", () => {
  const result = validateStringLength({ metadata: "0x" + "ff".repeat(2048) });
  assertEquals(typeof result, "string");
  assertEquals(result!.includes("metadata"), true);
});

Deno.test("validateStringLength accepts values at exact limit", () => {
  assertEquals(validateStringLength({ rpId: "a".repeat(253) }), null);
  assertEquals(validateStringLength({ name: "n".repeat(256) }), null);
});

Deno.test("validateStringLength rejects non-hex publicKey", () => {
  const result = validateStringLength({ publicKey: "04" + "zz".repeat(64) });
  assertEquals(typeof result, "string");
  assertEquals(result!.includes("hex"), true);
});

Deno.test("validateStringLength rejects non-hex walletRef", () => {
  const result = validateStringLength({ walletRef: "0xNOTHEX" });
  assertEquals(typeof result, "string");
  assertEquals(result!.includes("hex"), true);
});

Deno.test("validateStringLength rejects non-hex metadata", () => {
  const result = validateStringLength({ metadata: "not-hex-at-all!" });
  assertEquals(typeof result, "string");
  assertEquals(result!.includes("hex"), true);
});

Deno.test("validateStringLength accepts valid hex with 0x prefix", () => {
  assertEquals(validateStringLength({ publicKey: "04" + "ab".repeat(64) }), null);
  assertEquals(validateStringLength({ walletRef: "0x" + "ff".repeat(32) }), null);
  assertEquals(validateStringLength({ metadata: "0x" + "00".repeat(10) }), null);
});

// --- Security: reject out-of-spec hex that would crash the ABI encoder in the
// background worker (was a queue-wide DoS via a single POST /api/create). ---

Deno.test("validateStringLength rejects a non-32-byte walletRef (queue-poison guard)", () => {
  for (const bad of ["0xdead", "0x" + "ff".repeat(31), "ff".repeat(33), "0x"]) {
    const r = validateStringLength({ walletRef: bad });
    assertEquals(typeof r, "string", `should reject walletRef ${bad}`);
    assertEquals(r!.includes("walletRef"), true);
  }
  // exactly 32 bytes still accepted
  assertEquals(validateStringLength({ walletRef: "0x" + "ab".repeat(32) }), null);
  assertEquals(validateStringLength({ walletRef: "ab".repeat(32) }), null);
});

Deno.test("validateStringLength rejects a non-P256 / odd-length publicKey", () => {
  // odd-length / wrong-prefix / short keys would break encode or buildWalletRef
  for (const bad of ["04abc", "00" + "aa".repeat(64), "04" + "a".repeat(127)]) {
    const r = validateStringLength({ publicKey: bad });
    assertEquals(typeof r, "string", `should reject publicKey ${bad}`);
  }
  assertEquals(validateStringLength({ publicKey: "04" + "aa".repeat(64) }), null);
});

Deno.test("validateStringLength rejects odd-length (non-byte-aligned) metadata", () => {
  const r = validateStringLength({ metadata: "0xabc" });
  assertEquals(typeof r, "string");
  assertEquals(r!.includes("metadata"), true);
  assertEquals(validateStringLength({ metadata: "0xabcd" }), null);
});
