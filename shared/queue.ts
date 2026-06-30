/**
 * Shared queue types, constants, and pure logic.
 * Used by both Deno (node:sqlite) and CF Worker (D1) queue implementations.
 */
import { createWalletClient, createPublicClient, http, keccak256, encodeAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gnosis } from "viem/chains";
import { getWriteRpc } from "./rpc.ts";
import { classifyError } from "./reliability.ts";

// --- Types ---

export type QueueStatus = "pending" | "committing" | "committed" | "creating" | "done" | "failed";

export interface QueueItem {
  id: string;
  status: QueueStatus;
  rpId: string;
  credentialId: string;
  walletRef: string;
  publicKey: string;
  name: string;
  initialCredentialId: string;
  metadata: string;
  txHash: string;
  error: string;
  retries: number;
  retryAfter: number;
  ip: string;
  createdAt: number;
  updatedAt: number;
}

// --- Constants ---

export const MAX_RETRIES = 10;
export const WORKER_INTERVAL = 60_000;
export const QUERY_BATCH_SIZE = 100;
export const TX_BATCH_SIZE = 50;
export const RATE_WINDOW = 60_000;
export const DEFAULT_RATE_LIMIT = 5;
export const MAX_GAS_PRICE_GWEI = 0.1;
export const GAS_BALANCE_THRESHOLD = 0.01;
export const FUND_THRESHOLD = 0.005;
export const FUND_AMOUNT = 0.05;
export const DONE_RETENTION = 7 * 24 * 60 * 60_000;
export const CREATE_SUB_BATCH = 10;

// --- Table DDL ---

export const CREATE_QUEUE_DDL = `
  CREATE TABLE IF NOT EXISTS create_queue (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending',
    rpId TEXT NOT NULL,
    credentialId TEXT NOT NULL,
    walletRef TEXT NOT NULL DEFAULT '',
    publicKey TEXT NOT NULL,
    name TEXT NOT NULL,
    initialCredentialId TEXT NOT NULL,
    metadata TEXT NOT NULL,
    txHash TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    retries INTEGER NOT NULL DEFAULT 0,
    retryAfter INTEGER NOT NULL DEFAULT 0,
    ip TEXT NOT NULL DEFAULT '',
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  )
`;

// Idempotency: at most one ACTIVE (non-failed) row per (rpId, credentialId).
// This closes the race between findDuplicate's SELECT and enqueue's INSERT that
// previously let two concurrent identical POSTs create duplicate queue rows
// (which then poisoned the whole on-chain batch with RecordAlreadyExists).
// Partial index so a NEW attempt is still allowed after a row goes 'failed'.
export const CREATE_ACTIVE_UNIQUE_INDEX =
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_active_unique ON create_queue(rpId, credentialId) WHERE status != 'failed'";

// Migration safety: existing DBs may already contain duplicate active rows (from
// the pre-fix behaviour). Keep the BEST active row per (rpId, credentialId) and
// demote the rest to 'failed' so the unique index can be built. "Best" =
// already-on-chain ('done') beats anything (never lose a recorded success),
// then newest createdAt, then id as a deterministic tiebreak. Idempotent: a
// no-op once no active duplicates remain. Bind param: now (updatedAt).
export const DEDUPE_ACTIVE_DUPLICATES_SQL = `
  UPDATE create_queue SET status = 'failed', error = 'superseded-duplicate', updatedAt = ?
  WHERE status != 'failed' AND EXISTS (
    SELECT 1 FROM create_queue n
    WHERE n.rpId = create_queue.rpId AND n.credentialId = create_queue.credentialId
      AND n.status != 'failed' AND n.id != create_queue.id
      AND (
        (n.status = 'done') > (create_queue.status = 'done')
        OR ((n.status = 'done') = (create_queue.status = 'done')
            AND (n.createdAt > create_queue.createdAt
              OR (n.createdAt = create_queue.createdAt AND n.id > create_queue.id)))
      )
  )
`;

/** True when an error is a unique-constraint violation (duplicate active row). */
export function isUniqueConstraintError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes("unique constraint") || msg.includes("constraint failed");
}

// --- Queue worker pure decision helpers (testable without a chain) ---

/** A multicall-style result row (viem returns { status, result } per call). */
export interface CallResult { status: "success" | "failure"; result?: unknown; error?: unknown }

/**
 * Split items by an aligned `hasRecord` multicall result into those already
 * present on-chain (→ mark done) and those genuinely missing (→ must submit).
 * Used for reconciliation BEFORE re-sending createRecord so a record that
 * already landed (duplicate / receipt-timeout-but-succeeded) does not revert
 * the whole batch.
 */
export function splitByHasRecord<T>(items: T[], results: CallResult[]): { present: T[]; missing: T[] } {
  const present: T[] = [];
  const missing: T[] = [];
  for (let i = 0; i < items.length; i++) {
    const r = results[i];
    if (r && r.status === "success" && r.result) present.push(items[i]);
    else missing.push(items[i]);
  }
  return { present, missing };
}

/**
 * Decide how to handle a failed batch WRITE (commit / createRecord):
 * - "retry-transient": an RPC/timeout/gas hiccup — the whole batch is fine,
 *   apply backoff and retry later.
 * - "isolate-poison": a deterministic revert — at least one item is poison;
 *   re-check items individually, quarantine the culprit(s), let the rest pass.
 */
export function batchFailureAction(err: unknown): "retry-transient" | "isolate-poison" {
  return classifyError(err, "rpc-write").category === "transient" ? "retry-transient" : "isolate-poison";
}

/** Exponential backoff for a failed queue item (full of jitter-free determinism for tx scheduling). */
export function retryDelayMs(retries: number): number {
  return Math.min(5000 * Math.pow(3, retries - 1), 12 * 60 * 60_000);
}

// --- Pure helpers ---

export async function hashIp(ip: string): Promise<string> {
  const data = new TextEncoder().encode(ip);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

export function buildCommitment(item: QueueItem) {
  const walletRefHex = item.walletRef as `0x${string}`;
  const publicKeyHex = (item.publicKey.startsWith("0x") ? item.publicKey : `0x${item.publicKey}`) as `0x${string}`;
  const metadataHex = (item.metadata.startsWith("0x") ? item.metadata : `0x${item.metadata}`) as `0x${string}`;

  return {
    commitment: keccak256(
      encodeAbiParameters(
        [{ type: "string" }, { type: "string" }, { type: "bytes32" }, { type: "bytes" }, { type: "string" }, { type: "string" }, { type: "bytes" }],
        [item.rpId, item.credentialId, walletRefHex, publicKeyHex, item.name, item.initialCredentialId, metadataHex],
      ),
    ),
    walletRefHex,
    publicKeyHex,
    metadataHex,
  };
}

// --- Wallet helpers ---

export interface AppConfig {
  privateKey: string;
  commitPrivateKey: string;
  telegramBotToken: string;
  telegramChatId: string;
}

// Explicit transport budget for write-path clients. Without this they fell back
// to viem's defaults (10s × retryCount 3 ≈ 40s), and balance/gas calls in the
// best-effort alerting path could dominate the single-flight worker's wall time.
const WRITE_TRANSPORT = { timeout: 8_000, retryCount: 1 } as const;

export function getCreateWallet(config: AppConfig) {
  const pk = config.privateKey;
  if (!pk) throw new Error("Missing env: PRIVATE_KEY");
  const rpcUrl = getWriteRpc();
  return {
    wallet: createWalletClient({
      account: privateKeyToAccount(pk as `0x${string}`),
      chain: gnosis,
      transport: http(rpcUrl, WRITE_TRANSPORT),
    }),
    client: createPublicClient({ chain: gnosis, transport: http(rpcUrl, WRITE_TRANSPORT) }),
  };
}

export function getCommitWallet(config: AppConfig) {
  const pk = config.commitPrivateKey;
  if (!pk) throw new Error("Missing env: COMMIT_PRIVATE_KEY or PRIVATE_KEY");
  const rpcUrl = getWriteRpc();
  return {
    wallet: createWalletClient({
      account: privateKeyToAccount(pk as `0x${string}`),
      chain: gnosis,
      transport: http(rpcUrl, WRITE_TRANSPORT),
    }),
    client: createPublicClient({ chain: gnosis, transport: http(rpcUrl, WRITE_TRANSPORT) }),
  };
}

// --- Telegram ---

const TELEGRAM_TIMEOUT = 5_000;

export async function sendTelegram(config: AppConfig, message: string): Promise<void> {
  const { telegramBotToken: botToken, telegramChatId: chatId } = config;
  if (!botToken || !chatId) return;
  try {
    // Bounded: a hung Telegram API must never stall the single-flight queue
    // worker / Durable Object alarm (which awaits this during checkAlerts).
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT),
    });
  } catch { /* alerting is best-effort — never let it affect the caller */ }
}
