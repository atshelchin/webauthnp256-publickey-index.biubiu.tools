import { assertEquals } from "@std/assert/";
import {
  splitByHasRecord,
  batchFailureAction,
  retryDelayMs,
  type CallResult,
} from "../../shared/queue.ts";

// ── splitByHasRecord ─────────────────────────────────────────────────────────

Deno.test("splitByHasRecord: partitions already-on-chain vs missing", () => {
  const items = ["a", "b", "c", "d"];
  const results: CallResult[] = [
    { status: "success", result: true },   // a present
    { status: "success", result: false },  // b missing
    { status: "failure", error: "x" },     // c unknown → treated missing
    { status: "success", result: true },   // d present
  ];
  const { present, missing } = splitByHasRecord(items, results);
  assertEquals(present, ["a", "d"]);
  assertEquals(missing, ["b", "c"]);
});

Deno.test("splitByHasRecord: all missing when no results", () => {
  const items = ["a", "b"];
  const { present, missing } = splitByHasRecord(items, [] as CallResult[]);
  assertEquals(present, []);
  assertEquals(missing, ["a", "b"]);
});

// ── batchFailureAction ───────────────────────────────────────────────────────

function revertErr(): Error {
  const e = new Error("execution reverted: RecordAlreadyExists");
  e.name = "ContractFunctionRevertedError";
  return e;
}
function httpErr(status: number): Error {
  const e = new Error(`HTTP ${status}`);
  e.name = "HttpRequestError";
  (e as unknown as { status: number }).status = status;
  return e;
}

Deno.test("batchFailureAction: deterministic revert → isolate-poison", () => {
  assertEquals(batchFailureAction(revertErr()), "isolate-poison");
});

Deno.test("batchFailureAction: timeouts/5xx/network → retry-transient", () => {
  assertEquals(batchFailureAction(new Error("request timed out")), "retry-transient");
  assertEquals(batchFailureAction(httpErr(503)), "retry-transient");
  assertEquals(batchFailureAction(new Error("fetch failed")), "retry-transient");
  // A provider 4xx on a write rotates endpoints rather than poisoning the item.
  assertEquals(batchFailureAction(httpErr(429)), "retry-transient");
});

// ── retryDelayMs ─────────────────────────────────────────────────────────────

Deno.test("retryDelayMs: exponential 5s·3^(n-1), capped at 12h", () => {
  assertEquals(retryDelayMs(1), 5_000);
  assertEquals(retryDelayMs(2), 15_000);
  assertEquals(retryDelayMs(3), 45_000);
  assertEquals(retryDelayMs(100), 12 * 60 * 60_000); // capped
});
