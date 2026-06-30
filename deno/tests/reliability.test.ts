import { assertEquals, assert } from "@std/assert/";
import {
  classifyError,
  parseRetryAfter,
  backoffDelay,
  withRetry,
  withDeadline,
  Deadline,
  DeadlineExceededError,
  RetryError,
  type RetryAttemptInfo,
} from "../../shared/reliability.ts";

// ── Fakes ──────────────────────────────────────────────────────────────────

/** Deterministic clock advanced manually (or auto-advanced by fake sleep). */
function fakeClock(startMs = 0) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
    set: (ms: number) => { t = ms; },
  };
}

/** A viem-ish HttpRequestError with a status and optional Retry-After header. */
function httpError(status: number, retryAfter?: string): Error {
  const e = new Error(`HTTP request failed. Status: ${status}`);
  e.name = "HttpRequestError";
  (e as unknown as { status: number }).status = status;
  if (retryAfter !== undefined) {
    (e as unknown as { headers: Headers }).headers = new Headers({ "retry-after": retryAfter });
  }
  return e;
}

function revertError(): Error {
  const inner = new Error("execution reverted: RecordNotFound");
  inner.name = "ContractFunctionRevertedError";
  const outer = new Error("ContractFunctionExecutionError: reverted");
  outer.name = "ContractFunctionExecutionError";
  (outer as unknown as { cause: unknown }).cause = inner;
  return outer;
}

// ── classifyError ────────────────────────────────────────────────────────────

Deno.test("classifyError: transient HTTP statuses are retryable", () => {
  for (const s of [408, 425, 429, 500, 502, 503, 504]) {
    const c = classifyError(httpError(s), "rpc-read");
    assertEquals(c.category, "transient", `status ${s}`);
    assertEquals(c.retryable, true);
    assertEquals(c.httpStatus, s);
  }
});

Deno.test("classifyError: permanent 4xx are NOT retryable", () => {
  for (const s of [400, 401, 403, 404, 409, 413, 422]) {
    const c = classifyError(httpError(s), "http");
    assertEquals(c.category, "permanent", `status ${s}`);
    assertEquals(c.retryable, false);
  }
});

Deno.test("classifyError: provider 4xx rotates (transient) in RPC context, permanent for plain HTTP", () => {
  // A flaky RPC provider returning 400/403 must rotate to another endpoint,
  // not fail the whole read — only a contract revert is permanent for RPC.
  assertEquals(classifyError(httpError(400), "rpc-read").category, "transient");
  assertEquals(classifyError(httpError(403), "rpc-write").category, "transient");
  // But for a non-RPC external API, 4xx is a genuine permanent failure.
  assertEquals(classifyError(httpError(400), "http").category, "permanent");
  assertEquals(classifyError(httpError(403), "telegram").category, "permanent");
});

Deno.test("classifyError: contract revert is permanent on read, poison on write", () => {
  assertEquals(classifyError(revertError(), "rpc-read").category, "permanent");
  assertEquals(classifyError(revertError(), "rpc-write").category, "poison");
  assertEquals(classifyError(revertError(), "rpc-write").retryable, false);
});

Deno.test("classifyError: timeouts and aborts are transient", () => {
  assertEquals(classifyError(new Error("The operation timed out."), "rpc-read").category, "transient");
  const ab = new Error("The operation was aborted");
  ab.name = "AbortError";
  assertEquals(classifyError(ab, "rpc-read").category, "transient");
});

Deno.test("classifyError: network faults are transient", () => {
  assertEquals(classifyError(new Error("fetch failed"), "rpc-read").category, "transient");
  assertEquals(classifyError(new Error("read ECONNRESET"), "rpc-read").category, "transient");
});

Deno.test("classifyError: D1/SQLite contention is transient in db context", () => {
  assertEquals(classifyError(new Error("D1_ERROR: storage operation exceeded timeout which caused object to be reset"), "db").category, "transient");
  assertEquals(classifyError(new Error("database is locked"), "db").category, "transient");
  assertEquals(classifyError(new Error("SQLITE_BUSY: database is busy"), "db").category, "transient");
});

Deno.test("classifyError: malformed responses & constraint violations are poison", () => {
  assertEquals(classifyError(new Error("Unexpected token < in JSON at position 0"), "rpc-read").category, "poison");
  assertEquals(classifyError(new TypeError("Cannot read properties of undefined (reading 'foo')"), "rpc-read").category, "poison");
  assertEquals(classifyError(new Error("UNIQUE constraint failed: create_queue.rpId"), "db").category, "poison");
});

Deno.test("classifyError: Retry-After header is parsed", () => {
  const c = classifyError(httpError(429, "2"), "rpc-read");
  assertEquals(c.retryAfterMs, 2000);
});

Deno.test("classifyError: unknown errors default to transient with explicit reason", () => {
  const c = classifyError(new Error("something weird"), "rpc-read");
  assertEquals(c.category, "transient");
  assertEquals(c.reason, "unknown");
});

Deno.test("classifyError: EVM write faults are transient with distinct (non-unknown) reasons", () => {
  // Must stay TRANSIENT (auto-recover; must NOT poison/quarantine good batch
  // items), but tagged so they are not buried under "unknown".
  const funds = classifyError(new Error("insufficient funds for gas * price + value"), "rpc-write");
  assertEquals(funds.category, "transient");
  assertEquals(funds.reason, "insufficient-funds");

  const nonce = classifyError(new Error("nonce too low"), "rpc-write");
  assertEquals(nonce.category, "transient");
  assertEquals(nonce.reason, "nonce-mempool");

  assertEquals(classifyError(new Error("already known"), "rpc-write").reason, "nonce-mempool");
  assertEquals(classifyError(new Error("replacement transaction underpriced"), "rpc-write").reason, "nonce-mempool");
  assertEquals(classifyError(new Error("intrinsic gas too low"), "rpc-write").reason, "gas-config");
});

// ── parseRetryAfter ──────────────────────────────────────────────────────────

Deno.test("parseRetryAfter: delta-seconds and HTTP-date", () => {
  assertEquals(parseRetryAfter("5"), 5000);
  assertEquals(parseRetryAfter(null), undefined);
  assertEquals(parseRetryAfter("garbage"), undefined);
  const future = parseRetryAfter(new Date(10_000).toUTCString(), 4000);
  assert(future !== undefined && future >= 5000 && future <= 6000);
});

// ── backoffDelay ─────────────────────────────────────────────────────────────

Deno.test("backoffDelay: full-jitter bounded by exponential cap", () => {
  // rng=1 → returns the cap (minus flooring); rng=0 → 0.
  assertEquals(backoffDelay(0, 200, 5000, () => 0), 0);
  assertEquals(backoffDelay(0, 200, 5000, () => 0.999999), 199);
  assertEquals(backoffDelay(3, 200, 5000, () => 0.999999), 1599); // 200*2^3=1600
  assertEquals(backoffDelay(10, 200, 5000, () => 0.999999), 4999); // capped at 5000
});

// ── withRetry ────────────────────────────────────────────────────────────────

function fakeSleepWith(clock: ReturnType<typeof fakeClock>) {
  // Advances the fake clock instead of waiting real time.
  return (ms: number) => { clock.advance(ms); return Promise.resolve(); };
}

Deno.test("withRetry: succeeds after N transient failures", async () => {
  const clock = fakeClock();
  let calls = 0;
  const result = await withRetry(() => {
    calls++;
    if (calls < 3) throw httpError(503);
    return "ok";
  }, { attempts: 5, now: clock.now, sleep: fakeSleepWith(clock), rng: () => 0.5 });
  assertEquals(result, "ok");
  assertEquals(calls, 3);
});

Deno.test("withRetry: gives up after max attempts (perpetual timeout)", async () => {
  const clock = fakeClock();
  let calls = 0;
  await assertRejectsRetry(() => withRetry(() => {
    calls++;
    throw new Error("timed out");
  }, { attempts: 4, now: clock.now, sleep: fakeSleepWith(clock), rng: () => 0.5 }), "transient");
  assertEquals(calls, 4);
});

Deno.test("withRetry: does NOT retry permanent errors", async () => {
  let calls = 0;
  await assertRejectsRetry(() => withRetry(() => {
    calls++;
    throw httpError(400);
  }, { attempts: 5, context: "http" }), "permanent");
  assertEquals(calls, 1, "permanent error must not be retried");
});

Deno.test("withRetry: does NOT retry poison (write revert)", async () => {
  let calls = 0;
  await assertRejectsRetry(() => withRetry(() => {
    calls++;
    throw revertError();
  }, { attempts: 5, context: "rpc-write" }), "poison");
  assertEquals(calls, 1);
});

Deno.test("withRetry: honours Retry-After over computed backoff", async () => {
  const clock = fakeClock();
  const delays: number[] = [];
  let calls = 0;
  await withRetry(() => {
    calls++;
    if (calls < 2) throw httpError(429, "3"); // Retry-After: 3s
    return "ok";
  }, {
    attempts: 3, baseDelayMs: 10, maxDelayMs: 50,
    now: clock.now, sleep: (ms) => { delays.push(ms); clock.advance(ms); return Promise.resolve(); },
    rng: () => 0,
  });
  assertEquals(delays[0], 3000, "should wait the full Retry-After");
});

Deno.test("withRetry: stops when backoff would exceed the deadline", async () => {
  const clock = fakeClock();
  let calls = 0;
  await assertRejectsRetry(() => withRetry(() => {
    calls++;
    throw httpError(503);
  }, {
    attempts: 100, baseDelayMs: 1000, maxDelayMs: 10_000, deadlineMs: 500,
    now: clock.now, sleep: fakeSleepWith(clock), rng: () => 0.999,
  }), "transient");
  // First attempt runs immediately; backoff (~1000ms) exceeds the 500ms budget.
  assertEquals(calls, 1);
});

Deno.test("withRetry: reports each attempt via onAttempt", async () => {
  const clock = fakeClock();
  const seen: RetryAttemptInfo[] = [];
  let calls = 0;
  await withRetry(() => {
    calls++;
    if (calls < 3) throw httpError(500);
    return 1;
  }, {
    attempts: 5, now: clock.now, sleep: fakeSleepWith(clock), rng: () => 0.5,
    onAttempt: (i) => seen.push(i),
  });
  assertEquals(seen.length, 2);
  assert(seen.every((s) => s.classified.category === "transient"));
  assert(seen.every((s) => s.willRetry));
});

Deno.test("withRetry: aborts immediately on a pre-aborted signal", async () => {
  const ctrl = new AbortController();
  ctrl.abort(new Error("cancelled"));
  let calls = 0;
  await assertRejectsRetry(() => withRetry(() => { calls++; return 1; }, { signal: ctrl.signal }), "transient");
  assertEquals(calls, 0);
});

// ── Deadline / withDeadline ──────────────────────────────────────────────────

Deno.test("Deadline: tracks remaining budget and expiry", () => {
  const clock = fakeClock(1000);
  const d = new Deadline(500, { now: clock.now });
  assertEquals(d.remaining(), 500);
  clock.advance(200);
  assertEquals(d.remaining(), 300);
  clock.advance(400);
  assertEquals(d.remaining(), 0);
  assert(d.expired());
});

Deno.test("Deadline: cancel() aborts the signal", () => {
  const d = new Deadline(1000);
  assertEquals(d.signal.aborted, false);
  d.cancel(new Error("stop"));
  assertEquals(d.signal.aborted, true);
});

Deno.test("withDeadline: rejects a hung promise after ms", async () => {
  const never = new Promise<number>(() => {});
  await assertRejects(() => withDeadline(never, 20, "hang-test"), DeadlineExceededError);
});

Deno.test("withDeadline: resolves a fast promise", async () => {
  const fast = Promise.resolve(42);
  assertEquals(await withDeadline(fast, 1000, "fast"), 42);
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function assertRejectsRetry(fn: () => Promise<unknown>, expectedCategory: string): Promise<void> {
  let err: unknown;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  assert(err instanceof RetryError, `expected RetryError, got ${err}`);
  assertEquals((err as RetryError).classified.category, expectedCategory);
}

async function assertRejects(fn: () => Promise<unknown>, ctor: new (...a: never[]) => Error): Promise<void> {
  let err: unknown;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  assert(err instanceof ctor, `expected ${ctor.name}, got ${err}`);
}
