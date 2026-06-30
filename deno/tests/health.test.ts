import { assertEquals } from "@std/assert/";
import {
  buildHealthBody,
  isDegraded,
  HEALTH_DLQ_DEGRADED,
  HEALTH_QUEUE_DEPTH_DEGRADED,
  HEALTH_OLDEST_JOB_DEGRADED_MS,
  type QueueStats,
} from "../../shared/routes/health.ts";

const ok: QueueStats = { queueDepth: 3, dlqCount: 0, oldestActiveAgeMs: 1000 };

Deno.test("isDegraded: healthy queue is not degraded", () => {
  assertEquals(isDegraded(ok), false);
});

Deno.test("isDegraded: trips on DLQ / depth / stuck-job thresholds", () => {
  assertEquals(isDegraded({ ...ok, dlqCount: HEALTH_DLQ_DEGRADED }), true);
  assertEquals(isDegraded({ ...ok, queueDepth: HEALTH_QUEUE_DEPTH_DEGRADED }), true);
  assertEquals(isDegraded({ ...ok, oldestActiveAgeMs: HEALTH_OLDEST_JOB_DEGRADED_MS }), true);
});

Deno.test("buildHealthBody: reports ok + queue metrics, preserves base fields", () => {
  const body = buildHealthBody({ service: "svc", version: "1.0.0" }, ok);
  assertEquals(body.status, "ok");
  assertEquals(body.service, "svc");
  assertEquals(body.queue, { depth: 3, dlq: 0, oldestJobAgeMs: 1000 });
});

Deno.test("buildHealthBody: degraded when stats indicate trouble", () => {
  const body = buildHealthBody({ service: "svc" }, { queueDepth: 5, dlqCount: 100, oldestActiveAgeMs: 0 });
  assertEquals(body.status, "degraded");
});

Deno.test("buildHealthBody: null stats (DB unreadable) → degraded", () => {
  const body = buildHealthBody({ service: "svc" }, null);
  assertEquals(body.status, "degraded");
});
