/**
 * Stable, client-safe error responses for route handlers.
 *
 * Never leaks upstream/provider internals or stack traces to clients. A
 * dependency outage becomes a uniform, retryable 503 with a Retry-After hint so
 * a transient RPC/DB hiccup is communicated as "try again", not as a 404/500
 * that looks like our service is broken or the data is gone.
 */
import { DependencyError } from "../reliability.ts";

/** Default client-facing retry hint when upstream gave no Retry-After. */
const DEFAULT_RETRY_AFTER_SECONDS = 2;

export function dependencyErrorResponse(err: DependencyError, extraHeaders?: Record<string, string>): Response {
  const retryAfterSec = err.retryAfterMs !== undefined
    ? Math.max(1, Math.ceil(err.retryAfterMs / 1000))
    : DEFAULT_RETRY_AFTER_SECONDS;
  return Response.json(
    {
      error: "upstream dependency temporarily unavailable, please retry",
      retryable: true,
      dependency: err.dependency,
    },
    {
      status: 503,
      headers: { "Retry-After": String(retryAfterSec), ...extraHeaders },
    },
  );
}

/** True if `err` is a retryable upstream-dependency failure. */
export function isDependencyError(err: unknown): err is DependencyError {
  return err instanceof DependencyError;
}

/**
 * Serve last-known-good (slightly stale) data when the authoritative upstream is
 * unreachable. Marked explicitly (`_stale`, `X-Served-Stale`) and `no-cache` so
 * neither client nor CDN mistakes it for fresh data. Availability over strict
 * freshness for read-only public data — but never silently.
 */
export function staleResponse(value: object, ageMs: number): Response {
  return Response.json(
    { ...value, _stale: true, _staleAgeMs: ageMs },
    { status: 200, headers: { "X-Served-Stale": "true", "Cache-Control": "no-cache" } },
  );
}

// Max age we'll serve last-known-good for. Stats are aggregate counts/listings
// that DRIFT as records are registered, so cap them at 1h — past that a stale
// total is misleading and a stable 503 is better. Per-record query results are
// IMMUTABLE on-chain, so they tolerate a much wider window.
export const STALE_MAX_MS_STATS = 60 * 60_000;
export const STALE_MAX_MS_RECORD = 24 * 60 * 60_000;

/** Serve last-known-good only if it's within `maxStaleMs`; otherwise a 503. */
export function serveStaleOrDependency(
  stale: { value: object; ageMs: number } | undefined,
  maxStaleMs: number,
  err: DependencyError,
): Response {
  if (stale && stale.ageMs <= maxStaleMs) return staleResponse(stale.value, stale.ageMs);
  return dependencyErrorResponse(err);
}
