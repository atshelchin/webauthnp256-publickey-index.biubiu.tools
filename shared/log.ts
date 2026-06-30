/**
 * Minimal structured logger shared by both runtimes.
 *
 * Emits one JSON object per line so logs can be queried by field (dependency,
 * operation, error_category, latency_ms, job id, ...) instead of grepping free
 * text. Deliberately tiny — no deps, works in Deno and CF Workers.
 *
 * Secrets are never logged: any key matching SECRET_KEYS is redacted, and
 * callers are expected to pass already-safe values (hashed IPs, tx hashes).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  dependency?: string;       // "rpc" | "d1" | "sqlite" | "telegram" | "chain-data"
  operation?: string;        // "getRecord" | "batchCommit" | "enqueue" | ...
  outcome?: string;          // "success" | "retry" | "exhausted" | "permanent" | "poison"
  error_category?: string;   // ClassifiedError.category
  retryable?: boolean;
  attempt?: number;
  latency_ms?: number;
  timeout?: boolean;
  circuit_state?: string;
  queue_depth?: number;
  oldest_job_age_ms?: number;
  dlq_count?: number;
  job_id?: string;           // queue item id
  request_id?: string;       // correlation id for an inbound request
  idempotency_key?: string;
  [key: string]: unknown;
}

const SECRET_KEYS = /(privatekey|private_key|secret|token|password|authorization|cookie)/i;

/**
 * Strip credentials that leak into free-text values — most importantly the
 * Alchemy/Infura API key embedded in an RPC URL path (`.../v2/<key>`), which
 * otherwise ends up in viem error messages, our logs, AND the queue's stored
 * `error` column. Also scrubs key/token query params. Safe to call on any
 * string (URLs, error messages) before logging or persisting.
 */
export function redactSecrets(input: string): string {
  if (!input) return input;
  return input
    // Alchemy/Infura-style API key in the URL path: /v2/<key>, /v3/<key>
    .replace(/(\/v[0-9]\/)[A-Za-z0-9_-]{6,}/g, "$1***")
    // Telegram bot token in an api.telegram.org URL: /bot<id>:<secret>/
    .replace(/(\/bot)[0-9]{6,}:[A-Za-z0-9_-]{20,}/g, "$1***")
    // key / apikey / api_key / token / secret query params
    .replace(/([?&](?:api[_-]?key|apikey|key|token|secret|access_token)=)[^&\s"]+/gi, "$1***");
}

function redact(fields: LogFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (SECRET_KEYS.test(k)) { out[k] = "[redacted]"; continue; }
    out[k] = typeof v === "string" ? redactSecrets(v) : v;
  }
  return out;
}

function emit(level: LogLevel, msg: string, fields: LogFields): void {
  const record = { level, msg: redactSecrets(msg), ...redact(fields) };
  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    line = JSON.stringify({ level, msg: redactSecrets(msg), _serialize_error: true });
  }
  // Defense in depth: scrub the fully-serialized line too, in case a secret
  // slipped into a nested object value.
  line = redactSecrets(line);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, fields: LogFields = {}) => emit("debug", msg, fields),
  info: (msg: string, fields: LogFields = {}) => emit("info", msg, fields),
  warn: (msg: string, fields: LogFields = {}) => emit("warn", msg, fields),
  error: (msg: string, fields: LogFields = {}) => emit("error", msg, fields),
};

/** Short correlation id for an inbound request (not security-sensitive). */
export function newRequestId(): string {
  // crypto.randomUUID is available in both Deno and CF Workers.
  try {
    return crypto.randomUUID().slice(0, 8);
  } catch {
    return Math.floor(Date.now() % 1e8).toString(36);
  }
}
