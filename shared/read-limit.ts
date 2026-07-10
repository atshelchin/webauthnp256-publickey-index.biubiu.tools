/**
 * Lightweight per-IP limiter for CHAIN reads — shared by both runtimes.
 *
 * Purpose: bound read amplification (each cache-miss query/stats call costs a
 * real RPC read; an attacker sweeping random keys can burn provider quotas and
 * trip the read circuit, degrading reads for everyone). This is applied ONLY
 * on the cache-miss path — cached responses are free and never counted.
 *
 * AVAILABILITY-FIRST by design (operator requirement: users must never be
 * blocked by our own protections): the limit is generous (a real client does a
 * handful of reads), state is in-memory (per process/isolate — approximate on
 * CF), and any internal error FAILS OPEN.
 */
import { hashIp } from "./queue.ts";

const READ_LIMIT = 120; // chain reads per IP per minute — far above legit use
const WINDOW_MS = 60_000;
const SWEEP_INTERVAL_MS = 5 * 60_000;

const hits = new Map<string, number[]>();
// Lazy sweep (no module-level setInterval — CF Workers forbid timers outside
// request context; Deno simply sweeps on the next call after the interval).
let lastSweepAt = 0;

function sweep(now: number): void {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  for (const [key, times] of hits) {
    const recent = times.filter((t) => now - t < WINDOW_MS);
    if (recent.length === 0) hits.delete(key);
    else hits.set(key, recent);
  }
}

/** True when this IP may perform a chain read now. Fails OPEN on any error. */
export async function allowChainRead(ip: string): Promise<boolean> {
  try {
    const now = Date.now();
    sweep(now);
    const key = await hashIp(ip);
    const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= READ_LIMIT) return false;
    recent.push(now);
    hits.set(key, recent);
    return true;
  } catch {
    return true; // never let the limiter itself block a legitimate read
  }
}

/** Extract the client IP with the same precedence as the create route. */
export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
}

/** Reset internal state (for testing only). */
export function _resetReadLimitForTest(): void {
  hits.clear();
  lastSweepAt = 0;
}
