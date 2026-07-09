/**
 * Unified reliability primitives shared by both runtimes (Deno + CF Worker).
 *
 * Goal: a transient failure of an external dependency (RPC, D1/SQLite, HTTP,
 * Telegram) must NOT surface as instability of our service. This module is the
 * single place that decides:
 *   1. classifyError()  — structured error taxonomy (NOT text-only guessing)
 *   2. withRetry()      — bounded, jittered, deadline-capped retry that only
 *                         retries TRANSIENT errors and honours Retry-After
 *   3. Deadline/withDeadline — total time budget + cancellation
 *
 * Everything here is platform-agnostic (Web standard APIs only) and pure enough
 * to unit-test with injected clock / sleep / rng — no real network or timers.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Error taxonomy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * - transient: temporary technical fault → safe to retry within a deadline
 *   (timeouts, conn reset, 408/425/429/5xx, DB busy/deadlock, network jitter).
 * - permanent: a definitive business/client failure → retrying is pointless
 *   (4xx validation/auth/not-found, contract business revert on a read).
 * - poison:    deterministic data/program defect → stop retrying AND isolate
 *   (a write that always reverts, malformed/undeserializable response, bug).
 */
export type ErrorCategory = "transient" | "permanent" | "poison";

export interface ClassifiedError {
  category: ErrorCategory;
  /** Convenience: category === "transient". */
  retryable: boolean;
  /** Upstream HTTP status, if one could be extracted. */
  httpStatus?: number;
  /** Honour-this delay before the next attempt (from Retry-After), in ms. */
  retryAfterMs?: number;
  /** Short, log-safe reason describing why this category was chosen. */
  reason: string;
}

/** Calling context lets us classify the same wire error differently. */
export type CallContext = "rpc-read" | "rpc-write" | "db" | "http" | "telegram";

const TRANSIENT_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);
// 4xx that are definitively the caller's/business problem — never retry.
const PERMANENT_HTTP = new Set([400, 401, 402, 403, 404, 405, 409, 410, 413, 422, 451]);

const TIMEOUT_PATTERNS = [
  "timed out",
  "timeout",
  "aborted",
  "the operation was aborted",
  "request timed out",
];

const NETWORK_PATTERNS = [
  "fetch failed",
  "network connection lost",
  "connection reset",
  "econnreset",
  "econnrefused",
  "ehostunreach",
  "enetunreach",
  "eai_again",
  "socket hang up",
  "connection closed",
  "connection refused",
  "load failed",
  "failed to fetch",
];

// D1 (single-writer SQLite) hiccups under contention / cold start.
const DB_TRANSIENT_PATTERNS = [
  "exceeded timeout",
  "object to be reset",
  "network connection lost",
  "d1_error",
  "storage operation",
  "database is locked",
  "sqlite_busy",
  "sqlite_locked",
  "busy",
  "deadlock",
];

// Responses that violate the contract / cannot be parsed → poison, never retry.
const POISON_PATTERNS = [
  "cannot read properties",
  "is not a function",
  "unexpected token",
  "unexpected end of json",
  "invalid json",
  "is not valid json",
  "could not be deserialized",
  "constraint failed",
  "unique constraint",
];

function lower(err: unknown): string {
  return (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).toLowerCase();
}

function some(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

/**
 * Walk a (possibly nested / viem-wrapped) error and pull out an HTTP status and
 * Retry-After, plus whether it is a contract revert. Structured fields first,
 * text only as a last resort.
 */
function inspect(err: unknown): {
  status?: number;
  retryAfterMs?: number;
  isRevert: boolean;
} {
  let status: number | undefined;
  let retryAfterMs: number | undefined;
  let isRevert = false;

  const visit = (e: unknown, depth: number) => {
    if (!e || typeof e !== "object" || depth > 6) return;
    const o = e as Record<string, unknown>;

    if (typeof o.status === "number") status ??= o.status;
    if (typeof o.statusCode === "number") status ??= o.statusCode as number;

    const name = typeof o.name === "string" ? o.name : "";
    if (
      name === "ContractFunctionRevertedError" ||
      name === "ContractFunctionExecutionError" ||
      name === "CallExecutionError"
    ) {
      // Only a *revert* is permanent; an execution error may wrap a network fault,
      // so we keep walking and let the wrapped cause decide unless we see a revert.
      if (name === "ContractFunctionRevertedError") isRevert = true;
    }

    // Retry-After header (viem HttpRequestError exposes .headers as Headers).
    const headers = o.headers;
    if (headers && typeof (headers as Headers).get === "function") {
      const ra = (headers as Headers).get("retry-after");
      const parsed = parseRetryAfter(ra);
      if (parsed !== undefined) retryAfterMs ??= parsed;
    }

    visit(o.cause, depth + 1);
    // viem aggregates nested errors on .walk(); also check common nesting keys.
    if (Array.isArray((o as { errors?: unknown[] }).errors)) {
      for (const child of (o as { errors: unknown[] }).errors) visit(child, depth + 1);
    }
  };
  visit(err, 0);

  const text = lower(err);
  if (!isRevert && (text.includes("reverted") || text.includes("execution reverted"))) {
    isRevert = true;
  }
  return { status, retryAfterMs, isRevert };
}

/**
 * Structured revert detection: walks viem's nested error chain for
 * ContractFunctionRevertedError (text match only as a last resort). Exported
 * so isContractRevert stops being a bare `includes("revert")` that could
 * misread provider prose as a business revert (→ false 404s).
 */
export function isRevertError(err: unknown): boolean {
  return inspect(err).isRevert;
}

/** Parse an HTTP Retry-After value (delta-seconds or HTTP-date) into ms. */
export function parseRetryAfter(value: string | null | undefined, nowMs = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - nowMs);
  return undefined;
}

/**
 * Classify an error into the transient / permanent / poison taxonomy.
 * `context` disambiguates a contract revert: on a read it is a benign
 * "business" outcome (record not found); on a write it is poison (the tx will
 * deterministically revert forever and must be isolated, not retried).
 */
export function classifyError(err: unknown, context: CallContext = "rpc-read"): ClassifiedError {
  const { status, retryAfterMs, isRevert } = inspect(err);
  const text = lower(err);

  const permanent = (reason: string): ClassifiedError => ({ category: "permanent", retryable: false, httpStatus: status, retryAfterMs, reason });
  const transient = (reason: string): ClassifiedError => ({ category: "transient", retryable: true, httpStatus: status, retryAfterMs, reason });
  const poison = (reason: string): ClassifiedError => ({ category: "poison", retryable: false, httpStatus: status, retryAfterMs, reason });

  // 1. Contract revert: context-dependent.
  if (isRevert) {
    return context === "rpc-write"
      ? poison("contract reverted (deterministic) on write")
      : permanent("contract reverted (business outcome) on read");
  }

  // 2. HTTP status — most reliable signal.
  if (status !== undefined) {
    if (TRANSIENT_HTTP.has(status)) return transient(`http ${status}`);
    if (PERMANENT_HTTP.has(status)) {
      // In an RPC context we round-robin across heterogeneous providers, so a
      // provider-specific 4xx (e.g. drpc "can't route your request", a node that
      // rejects a method) is worth retrying on a DIFFERENT endpoint rather than
      // failing the whole read. Only a contract revert (handled above) is a true
      // permanent outcome here. For non-RPC HTTP (chain-data, Telegram) a 4xx is
      // genuinely permanent.
      const rpcCtx = context === "rpc-read" || context === "rpc-write";
      return rpcCtx ? transient(`http ${status} (rpc rotate)`) : permanent(`http ${status}`);
    }
  }

  // 3. Timeouts / aborts — transient.
  if (some(text, TIMEOUT_PATTERNS)) return transient("timeout/abort");

  // 4. Network faults — transient.
  if (some(text, NETWORK_PATTERNS)) return transient("network fault");

  // 5. DB contention — transient (busy/locked/deadlock/D1 reset).
  if (context === "db" && some(text, DB_TRANSIENT_PATTERNS)) return transient("db contention");
  if (some(text, ["d1_error", "storage operation exceeded timeout", "object to be reset"])) {
    return transient("db contention");
  }

  // 6. Poison: contract/parse violations & constraint contradictions.
  if (some(text, POISON_PATTERNS)) return poison("malformed/contract-violation");

  // 6b. EVM write-path faults. These are NOT reverts (handled in #1) and have no
  //     HTTP status, so without explicit handling they'd be buried under
  //     "unknown". They are kept TRANSIENT on purpose — they auto-recover once
  //     the wallet is funded / the nonce resyncs — and must NOT be poison, or a
  //     funding/nonce blip would wrongly quarantine every good item in a batch.
  //     The distinct reason lets logs/alerts pinpoint the real cause.
  if (some(text, ["insufficient funds"])) return transient("insufficient-funds");
  if (some(text, ["nonce too low", "already known", "transaction already imported", "replacement transaction underpriced", "nonce has already been used"])) {
    return transient("nonce-mempool");
  }
  if (some(text, ["intrinsic gas too low", "max fee per gas less than block base fee", "fee cap", "transaction underpriced"])) {
    return transient("gas-config");
  }

  // 7. Unknown. Bounded retry is still safer than failing a request on a blip,
  //    and withRetry()'s attempt cap + deadline prevent runaway loops. We mark
  //    it transient but with an explicit "unknown" reason so it is observable.
  return transient("unknown");
}

// ─────────────────────────────────────────────────────────────────────────────
// Deadline
// ─────────────────────────────────────────────────────────────────────────────

export interface Clock {
  now: () => number;
}
const SYSTEM_CLOCK: Clock = { now: () => Date.now() };

/** A monotonic-ish total time budget with an AbortSignal for cancellation. */
export class Deadline {
  private readonly start: number;
  private readonly budgetMs: number;
  private readonly clock: Clock;
  readonly controller: AbortController;

  constructor(budgetMs: number, clock: Clock = SYSTEM_CLOCK, parentSignal?: AbortSignal) {
    this.budgetMs = budgetMs;
    this.clock = clock;
    this.start = clock.now();
    this.controller = new AbortController();
    if (parentSignal) {
      if (parentSignal.aborted) this.controller.abort(parentSignal.reason);
      else parentSignal.addEventListener("abort", () => this.controller.abort(parentSignal.reason), { once: true });
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Milliseconds left before the budget is exhausted (never negative). */
  remaining(): number {
    return Math.max(0, this.budgetMs - (this.clock.now() - this.start));
  }

  expired(): boolean {
    return this.remaining() <= 0;
  }

  /** Cancel any in-flight work bound to this deadline's signal. */
  cancel(reason?: unknown): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
  }
}

export class DeadlineExceededError extends Error {
  constructor(label: string, ms: number) {
    super(`deadline exceeded: ${label} did not complete within ${ms}ms`);
    this.name = "DeadlineExceededError";
  }
}

/**
 * Race a promise against a hard timeout. Use for operations that cannot accept
 * an AbortSignal themselves (the underlying work may keep running, but the
 * caller stops waiting — preventing an unbounded hang).
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, label = "operation"): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceededError(label, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Retry
// ─────────────────────────────────────────────────────────────────────────────

export interface RetryAttemptInfo {
  attempt: number;          // 1-based
  classified: ClassifiedError;
  delayMs: number;          // delay scheduled before the next attempt (0 if none)
  elapsedMs: number;
  willRetry: boolean;
}

export interface RetryOptions {
  /** Max total attempts (including the first). Default 4. */
  attempts?: number;
  /** Base backoff in ms. Default 200. */
  baseDelayMs?: number;
  /** Backoff cap in ms. Default 5000. */
  maxDelayMs?: number;
  /** Total time budget across ALL attempts (incl. backoff). Default: unbounded. */
  deadlineMs?: number;
  /** External cancellation. */
  signal?: AbortSignal;
  /** Classification context (read vs write vs db ...). Default "rpc-read". */
  context?: CallContext;
  /** Labels for structured logs. */
  dependency?: string;
  operation?: string;
  /** Per-attempt observability hook. */
  onAttempt?: (info: RetryAttemptInfo) => void;
  // Injection points for deterministic tests:
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  rng?: () => number;
}

/** Error thrown when retries are exhausted or the deadline is hit. */
export class RetryError extends Error {
  readonly attempts: number;
  readonly classified: ClassifiedError;
  override readonly cause: unknown;
  constructor(message: string, attempts: number, classified: ClassifiedError, cause: unknown) {
    super(message);
    this.name = "RetryError";
    this.attempts = attempts;
    this.classified = classified;
    this.cause = cause;
  }
}

/**
 * Raised when a dependency could not be reached after exhausting retries within
 * the deadline. Lets route handlers distinguish "upstream is unavailable"
 * (→ 503 + Retry-After) from a genuine business outcome (→ 404 / null).
 */
export class DependencyError extends Error {
  readonly dependency: string;
  readonly classified: ClassifiedError;
  readonly retryAfterMs?: number;
  override readonly cause: unknown;
  constructor(dependency: string, classified: ClassifiedError, cause: unknown) {
    super(`dependency '${dependency}' unavailable: ${classified.reason}`);
    this.name = "DependencyError";
    this.dependency = dependency;
    this.classified = classified;
    this.retryAfterMs = classified.retryAfterMs;
    this.cause = cause;
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Full-jitter exponential backoff: random in [0, min(max, base*2^attempt)]. */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number, rng: () => number): number {
  const exp = Math.min(maxMs, baseMs * Math.pow(2, attempt));
  return Math.floor(rng() * exp);
}

/**
 * Run `fn` with bounded, jittered retries. Retries ONLY transient errors,
 * honours Retry-After, and never sleeps or runs past the deadline. Permanent
 * and poison errors are re-thrown immediately (wrapped so callers can branch on
 * `.classified.category`).
 */
export async function withRetry<T>(fn: (attempt: number) => T | Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 200;
  const maxDelayMs = opts.maxDelayMs ?? 5000;
  const context = opts.context ?? "rpc-read";
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;
  const rng = opts.rng ?? Math.random;
  const start = now();
  const deadlineAt = opts.deadlineMs !== undefined ? start + opts.deadlineMs : Infinity;

  let lastClassified: ClassifiedError = { category: "transient", retryable: true, reason: "no-attempt" };
  let lastErr: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (opts.signal?.aborted) {
      throw new RetryError(`aborted before attempt ${attempt}`, attempt - 1, lastClassified, opts.signal.reason);
    }
    if (now() >= deadlineAt) {
      throw new RetryError(`deadline exceeded before attempt ${attempt}`, attempt - 1, lastClassified, lastErr);
    }
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const classified = classifyError(err, context);
      lastClassified = classified;
      const isLast = attempt >= attempts;

      // Permanent / poison: never retry.
      if (!classified.retryable) {
        opts.onAttempt?.({ attempt, classified, delayMs: 0, elapsedMs: now() - start, willRetry: false });
        throw new RetryError(`${classified.category}: ${classified.reason}`, attempt, classified, err);
      }

      if (isLast) {
        opts.onAttempt?.({ attempt, classified, delayMs: 0, elapsedMs: now() - start, willRetry: false });
        throw new RetryError(`retries exhausted (${attempts}): ${classified.reason}`, attempt, classified, err);
      }

      // Compute backoff, never exceeding the deadline. Honour Retry-After.
      let delay = backoffDelay(attempt, baseDelayMs, maxDelayMs, rng);
      if (classified.retryAfterMs !== undefined) delay = Math.max(delay, classified.retryAfterMs);
      const remaining = deadlineAt - now();
      if (remaining <= 0 || delay >= remaining) {
        opts.onAttempt?.({ attempt, classified, delayMs: 0, elapsedMs: now() - start, willRetry: false });
        throw new RetryError(`deadline would be exceeded by backoff after attempt ${attempt}`, attempt, classified, err);
      }

      opts.onAttempt?.({ attempt, classified, delayMs: delay, elapsedMs: now() - start, willRetry: true });
      await sleep(delay, opts.signal);
    }
  }

  // Unreachable, but satisfies the type checker.
  throw new RetryError(`retries exhausted (${attempts})`, attempts, lastClassified, lastErr);
}
