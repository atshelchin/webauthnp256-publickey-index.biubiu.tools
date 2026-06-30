/**
 * Dependency-aware health, derived purely from local queue state (no live
 * external calls — health checks must be cheap and must not themselves hammer
 * RPC/chain). Reports queue depth, DLQ size, and oldest-job age so operators
 * and load balancers can see degradation, while keeping `status` backward
 * compatible (still "ok" in the healthy case; adds "degraded").
 */

export interface QueueStats {
  queueDepth: number;        // active items: pending + committed + creating
  dlqCount: number;          // failed (quarantined / retry-exhausted) items
  oldestActiveAgeMs: number; // age of the oldest active item (0 if none)
}

// Thresholds at which the service reports itself degraded. The raw numbers are
// always reported regardless, so monitoring can alert on exact values.
export const HEALTH_QUEUE_DEPTH_DEGRADED = 2_000;
export const HEALTH_DLQ_DEGRADED = 25;
export const HEALTH_OLDEST_JOB_DEGRADED_MS = 30 * 60_000; // 30 min stuck

/** Hard cap on active queue size — new creates are shed (503) beyond this. */
export const MAX_ACTIVE_QUEUE_DEPTH = 10_000;

export function isDegraded(stats: QueueStats): boolean {
  return (
    stats.queueDepth >= HEALTH_QUEUE_DEPTH_DEGRADED ||
    stats.dlqCount >= HEALTH_DLQ_DEGRADED ||
    stats.oldestActiveAgeMs >= HEALTH_OLDEST_JOB_DEGRADED_MS
  );
}

export function buildHealthBody(
  base: Record<string, unknown>,
  stats: QueueStats | null,
): Record<string, unknown> {
  if (!stats) {
    // Could not read queue state — that is itself a degraded signal.
    return { ...base, status: "degraded", queue: { error: "queue stats unavailable" } };
  }
  return {
    ...base,
    status: isDegraded(stats) ? "degraded" : "ok",
    queue: {
      depth: stats.queueDepth,
      dlq: stats.dlqCount,
      oldestJobAgeMs: stats.oldestActiveAgeMs,
    },
  };
}
