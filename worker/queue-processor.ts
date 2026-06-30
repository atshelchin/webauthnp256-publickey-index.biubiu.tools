/**
 * Durable Object for queue processing (CF Worker version).
 * Replaces Deno's setInterval-based worker with DO alarm.
 * Reuses shared logic from queue-shared.ts and contract-shared.ts.
 */
import { createPublicClient, http } from "viem";
import { gnosis } from "viem/chains";
import { getWriteRpc } from "../shared/rpc.ts";
import {
  CONTRACT_ADDRESS,
  CONTRACT_ABI,
  BATCH_HELPER_ADDRESS,
  BATCH_ABI,
} from "../shared/contract.ts";
import {
  type QueueItem,
  type AppConfig,
  MAX_RETRIES,
  QUERY_BATCH_SIZE,
  TX_BATCH_SIZE,
  MAX_GAS_PRICE_GWEI,
  GAS_BALANCE_THRESHOLD,
  FUND_THRESHOLD,
  FUND_AMOUNT,
  DONE_RETENTION,
  FAILED_RETENTION,
  CREATE_SUB_BATCH,
  buildCommitment,
  getCreateWallet,
  getCommitWallet,
  sendTelegram,
  splitByHasRecord,
  batchFailureAction,
  retryDelayMs,
} from "../shared/queue.ts";
import { acquireNonce } from "./nonce.ts";
import { buildConfig } from "./config.ts";
import { log, redactSecrets } from "../shared/log.ts";
import type { Env } from "./types.ts";

function shortMsg(err: unknown): string {
  // Redact embedded RPC credentials before storing in the 'error' column / logs.
  return redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 200);
}

const ALARM_INTERVAL = 10_000; // 10s
const ALERT_INTERVAL = 5 * 60_000;
const QUEUE_BACKLOG_THRESHOLD = 100;
const FAILURE_ALERT_BATCH = 10;

export class QueueProcessor implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private lastAlertAt = 0;
  private lastFailedCount = 0;
  private failuresSinceLastAlert = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/start") {
      const existing = await this.state.storage.getAlarm();
      if (!existing) {
        await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL);
      }
      return new Response("started");
    }
    return new Response("ok");
  }

  async alarm(): Promise<void> {
    const start = Date.now();
    try {
      await this.processQueue();
      log.info("queue alarm cycle done", { operation: "processQueue", latency_ms: Date.now() - start, outcome: "success" });
    } catch (err) {
      log.error("queue alarm cycle error", { operation: "processQueue", latency_ms: Date.now() - start, error: shortMsg(err) });
    }
    // Always re-schedule — a failed/slow cycle must never leave the alarm unset
    // (that would silently stop all queue processing).
    await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL);
  }

  private get db(): D1Database {
    return this.env.DB;
  }

  private async getConfig(): Promise<AppConfig> {
    return await buildConfig(this.env);
  }

  private async processQueue(): Promise<void> {
    const config = await this.getConfig();
    if (!config.privateKey) {
      console.warn("[queue-processor] No PRIVATE_KEY configured, skipping");
      return;
    }

    // Skip gas price check and RPC calls if nothing to process
    const pending = await this.db.prepare(
      "SELECT COUNT(*) as count FROM create_queue WHERE status IN ('pending', 'committed', 'creating')"
    ).first<{ count: number }>();

    if (!pending || pending.count === 0) {
      await this.cleanupDoneRecords();
      return;
    }

    // Check gas price
    try {
      const writeClient = createPublicClient({ chain: gnosis, transport: http(getWriteRpc(), { timeout: 10_000 }) });
      const gasPrice = await writeClient.getGasPrice();
      const gasPriceGwei = Number(gasPrice) / 1e9;
      if (gasPriceGwei > MAX_GAS_PRICE_GWEI) {
        console.warn(`[queue-processor] Gas price too high: ${gasPriceGwei.toFixed(4)} Gwei, ${pending.count} items waiting`);
        await this.checkAlerts(config);
        return;
      }
    } catch (err) {
      console.warn(`[queue-processor] Gas price check failed:`, err instanceof Error ? err.message : err);
      return;
    }

    await this.processCreating(config);
    await this.processCommitted(config);
    await this.processPending(config);
    await this.cleanupDoneRecords();
    await this.checkAlerts(config);
  }

  // Reconciles any item left in the legacy 'creating' status. No NEW item enters
  // 'creating' (the flow goes committed→done directly); retained as a rolling-
  // upgrade safety net so a row written 'creating' by an older build is confirmed
  // on-chain (→ done) or failed out rather than stranded.
  private async processCreating(_config: AppConfig): Promise<void> {
    const { results } = await this.db.prepare(
      "SELECT * FROM create_queue WHERE status = 'creating' ORDER BY createdAt ASC LIMIT ?"
    ).bind(QUERY_BATCH_SIZE).all<QueueItem>();

    if (results.length === 0) return;

    const client = createPublicClient({ chain: gnosis, transport: http(getWriteRpc(), { timeout: 10_000 }) });

    const calls = results.map((item) => ({
      address: CONTRACT_ADDRESS as `0x${string}`,
      abi: CONTRACT_ABI,
      functionName: "hasRecord" as const,
      args: [item.rpId, item.credentialId] as const,
    }));

    try {
      const multicallResults = await client.multicall({ contracts: calls });
      let doneCount = 0;
      for (let i = 0; i < results.length; i++) {
        const r = multicallResults[i];
        if (r.status === "success" && r.result) {
          await this.db.prepare("UPDATE create_queue SET status = 'done', error = '', updatedAt = ? WHERE id = ?")
            .bind(Date.now(), results[i].id).run();
          doneCount++;
        } else if (r.status === "success" && !r.result) {
          const CREATING_TIMEOUT = 2 * 60_000;
          if (Date.now() - results[i].updatedAt > CREATING_TIMEOUT) {
            await this.handleFailure(results[i], "createRecord tx not confirmed after 2min", "committed");
          }
        }
      }
      if (doneCount > 0) console.log(`[queue-processor] ${doneCount} items confirmed on-chain`);
    } catch (err) {
      console.warn(`[queue-processor] processCreating multicall failed:`, err instanceof Error ? err.message : err);
    }
  }

  private async processCommitted(config: AppConfig): Promise<void> {
    const { results: items } = await this.db.prepare(
      "SELECT * FROM create_queue WHERE status = 'committed' AND retryAfter <= ? ORDER BY createdAt ASC LIMIT ?"
    ).bind(Date.now(), TX_BATCH_SIZE).all<QueueItem>();

    if (items.length === 0) return;

    const client = createPublicClient({ chain: gnosis, transport: http(getWriteRpc(), { timeout: 10_000 }) });
    const currentBlock = await client.getBlockNumber();

    // Guard commitment building per item — a poison row is quarantined, not
    // allowed to crash the cycle before the try block (was a queue-wide DoS).
    const { valid, commitments } = await this.buildCommitmentsSafe(items, "committed");
    if (commitments.length === 0) return;

    const calls = commitments.map((commitment) => ({
      address: CONTRACT_ADDRESS as `0x${string}`,
      abi: CONTRACT_ABI,
      functionName: "getCommitBlock" as const,
      args: [commitment] as const,
    }));

    let results: { status: "success" | "failure"; result?: unknown; error?: unknown }[];
    try {
      results = await client.multicall({ contracts: calls }) as typeof results;
    } catch (err) {
      console.warn(`[queue-processor] processCommitted multicall failed:`, err instanceof Error ? err.message : err);
      return;
    }

    const ready: QueueItem[] = [];
    const needsHasRecordCheck: QueueItem[] = [];

    for (let i = 0; i < valid.length; i++) {
      const result = results[i];
      if (result.status !== "success") continue;
      const commitBlock = result.result as bigint;
      if (commitBlock > 0n && currentBlock >= commitBlock + 1n) {
        ready.push(valid[i]);
      } else if (commitBlock === 0n) {
        needsHasRecordCheck.push(valid[i]);
      }
    }

    if (needsHasRecordCheck.length > 0) {
      const hasRecordCalls = needsHasRecordCheck.map((item) => ({
        address: CONTRACT_ADDRESS as `0x${string}`,
        abi: CONTRACT_ABI,
        functionName: "hasRecord" as const,
        args: [item.rpId, item.credentialId] as const,
      }));
      try {
        const hasRecordResults = await client.multicall({ contracts: hasRecordCalls });
        for (let i = 0; i < needsHasRecordCheck.length; i++) {
          const item = needsHasRecordCheck[i];
          const r = hasRecordResults[i];
          if (r.status === "success" && r.result) {
            await this.db.prepare("UPDATE create_queue SET status = 'done', error = '', updatedAt = ? WHERE id = ?")
              .bind(Date.now(), item.id).run();
          } else {
            const COMMIT_COOLDOWN = 2 * 60_000;
            if (Date.now() - item.updatedAt >= COMMIT_COOLDOWN) {
              // Re-commit THROUGH handleFailure so retries/retryAfter advance —
              // otherwise a never-confirming commit oscillates committed↔pending
              // forever with no progress.
              await this.handleFailure(item, "commitment missing after cooldown, re-committing", "pending");
            }
          }
        }
      } catch (err) { console.warn(`[queue-processor] hasRecord multicall failed:`, err instanceof Error ? err.message : err); }
    }

    if (ready.length === 0) return;

    const { wallet, client: walletClient } = getCreateWallet(config);

    // Reconciliation: drop items already on-chain (a prior createRecord landed
    // while our receipt wait timed out, or was created out of band). Re-sending
    // them would revert the WHOLE batch (RecordAlreadyExists).
    const missing = await this.reconcileReady(walletClient, ready);
    if (missing.length === 0) return;

    for (let offset = 0; offset < missing.length; offset += CREATE_SUB_BATCH) {
      const batch = missing.slice(offset, offset + CREATE_SUB_BATCH);
      const params = batch.map((item) => {
        const { walletRefHex, publicKeyHex, metadataHex } = buildCommitment(item);
        return {
          rpId: item.rpId,
          credentialId: item.credentialId,
          walletRef: walletRefHex,
          publicKey: publicKeyHex,
          name: item.name,
          initialCredentialId: item.initialCredentialId,
          metadata: metadataHex,
        };
      });

      const handle = await acquireNonce("create", config);
      try {
        const gasEstimate = await walletClient.estimateContractGas({
          address: BATCH_HELPER_ADDRESS,
          abi: BATCH_ABI,
          functionName: "batchCreateRecord",
          args: [CONTRACT_ADDRESS, params],
          account: wallet.account,
        });

        const hash = await wallet.writeContract({
          address: BATCH_HELPER_ADDRESS,
          abi: BATCH_ABI,
          functionName: "batchCreateRecord",
          args: [CONTRACT_ADDRESS, params],
          nonce: handle.nonce,
          gas: gasEstimate * 120n / 100n,
        });

        // Wait for receipt and verify success before marking done
        const createReceipt = await walletClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
        if (createReceipt.status === "reverted") {
          throw new Error(`batchCreateRecord tx reverted: ${hash}`);
        }
        const now = Date.now();
        const stmts = batch.map((item) =>
          this.db.prepare("UPDATE create_queue SET status = 'done', txHash = ?, error = '', updatedAt = ? WHERE id = ?")
            .bind(hash, now, item.id)
        );
        await this.db.batch(stmts);
        log.info("batchCreateRecord confirmed", { operation: "batchCreateRecord", count: batch.length, outcome: "success" });
      } catch (err) {
        handle.release();
        const msg = shortMsg(err);
        if (batchFailureAction(err) === "retry-transient") {
          for (const item of batch) await this.handleFailure(item, `batchCreateRecord: ${msg}`, "committed");
          log.warn("batchCreateRecord transient failure, backing off", { operation: "batchCreateRecord", count: batch.length, error_category: "transient" });
          break;
        }
        log.warn("batchCreateRecord poison batch, isolating", { operation: "batchCreateRecord", count: batch.length, error_category: "poison" });
        await this.isolatePoisonCreate(walletClient, wallet, batch);
        // Do NOT break — let subsequent sub-batches proceed.
      }
    }
  }

  private markItemDone(item: QueueItem, txHash = ""): Promise<unknown> {
    return this.db.prepare("UPDATE create_queue SET status = 'done', txHash = ?, error = '', updatedAt = ? WHERE id = ?")
      .bind(txHash || item.txHash || "", Date.now(), item.id).run();
  }

  /** Mark already-on-chain 'ready' items done; return the genuinely-missing ones. */
  // deno-lint-ignore no-explicit-any
  private async reconcileReady(client: any, items: QueueItem[]): Promise<QueueItem[]> {
    const calls = items.map((item) => ({
      address: CONTRACT_ADDRESS as `0x${string}`,
      abi: CONTRACT_ABI,
      functionName: "hasRecord" as const,
      args: [item.rpId, item.credentialId] as const,
    }));
    let results;
    try {
      results = await client.multicall({ contracts: calls });
    } catch (err) {
      log.warn("reconcileReady multicall failed, retrying full set next cycle", { operation: "hasRecord", error_category: "transient", error: shortMsg(err) });
      return items;
    }
    const { present, missing } = splitByHasRecord(items, results);
    if (present.length > 0) {
      await this.db.batch(present.map((item) =>
        this.db.prepare("UPDATE create_queue SET status = 'done', error = '', updatedAt = ? WHERE id = ?").bind(Date.now(), item.id)
      ));
      log.info("reconciled already-on-chain items to done", { operation: "reconcile", count: present.length, outcome: "success" });
    }
    return missing;
  }

  /**
   * Poison isolation for createRecord: process each item INDIVIDUALLY so the
   * batch always makes forward progress, even when items conflict with EACH
   * OTHER (e.g. two credentials sharing a walletRef — only one can win).
   * Per item: already on-chain → done; else fresh estimate + single-item send +
   * receipt. Sequential, so once one lands the next conflicting one reverts and
   * is quarantined. Every item ends done / quarantined / transient-backoff.
   */
  // deno-lint-ignore no-explicit-any
  private async isolatePoisonCreate(client: any, wallet: any, items: QueueItem[]): Promise<void> {
    const config = await this.getConfig(); // hoisted: avoid re-deriving the key per item
    for (const item of items) {
      try {
        const has = await client.readContract({
          address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, functionName: "hasRecord", args: [item.rpId, item.credentialId],
        });
        if (has) { await this.markItemDone(item); continue; }
      } catch { /* fall through to per-item submit */ }

      const { walletRefHex, publicKeyHex, metadataHex } = buildCommitment(item);
      const param = {
        rpId: item.rpId, credentialId: item.credentialId, walletRef: walletRefHex,
        publicKey: publicKeyHex, name: item.name, initialCredentialId: item.initialCredentialId, metadata: metadataHex,
      };

      let gasEstimate: bigint;
      try {
        gasEstimate = await client.estimateContractGas({
          address: BATCH_HELPER_ADDRESS, abi: BATCH_ABI, functionName: "batchCreateRecord",
          args: [CONTRACT_ADDRESS, [param]], account: wallet.account,
        });
      } catch (err) {
        if (batchFailureAction(err) === "isolate-poison") {
          await this.handleFailure(item, `batchCreateRecord poison: ${shortMsg(err)}`, "committed", { poison: true });
        } else {
          await this.handleFailure(item, `batchCreateRecord transient during isolation: ${shortMsg(err)}`, "committed");
        }
        continue;
      }

      const handle = await acquireNonce("create", config);
      try {
        const hash = await wallet.writeContract({
          address: BATCH_HELPER_ADDRESS, abi: BATCH_ABI, functionName: "batchCreateRecord",
          args: [CONTRACT_ADDRESS, [param]], nonce: handle.nonce, gas: gasEstimate * 120n / 100n,
        });
        const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
        if (receipt.status === "reverted") throw new Error(`reverted: ${hash}`);
        await this.markItemDone(item, hash);
        log.info("isolated item created individually", { job_id: item.id, operation: "batchCreateRecord", outcome: "success" });
      } catch (err) {
        handle.release();
        if (batchFailureAction(err) === "isolate-poison") {
          await this.handleFailure(item, `batchCreateRecord poison (individual send): ${shortMsg(err)}`, "committed", { poison: true });
        } else {
          await this.handleFailure(item, `batchCreateRecord transient (individual send): ${shortMsg(err)}`, "committed");
        }
      }
    }
  }

  /** Poison isolation for batchCommit: quarantine items that deterministically revert. */
  // deno-lint-ignore no-explicit-any
  private async isolatePoisonCommit(client: any, wallet: any, items: QueueItem[]): Promise<void> {
    for (const item of items) {
      const { commitment } = buildCommitment(item);
      try {
        await client.estimateContractGas({
          address: BATCH_HELPER_ADDRESS, abi: BATCH_ABI, functionName: "batchCommit",
          args: [CONTRACT_ADDRESS, [commitment]], account: wallet.account,
        });
      } catch (err) {
        if (batchFailureAction(err) === "isolate-poison") {
          await this.handleFailure(item, `batchCommit poison: ${shortMsg(err)}`, "pending", { poison: true });
        } else {
          await this.handleFailure(item, `batchCommit transient during isolation: ${shortMsg(err)}`, "pending");
        }
      }
    }
  }

  private async processPending(config: AppConfig): Promise<void> {
    const { results: items } = await this.db.prepare(
      "SELECT * FROM create_queue WHERE status = 'pending' AND retryAfter <= ? ORDER BY createdAt ASC LIMIT ?"
    ).bind(Date.now(), TX_BATCH_SIZE).all<QueueItem>();

    if (items.length === 0) return;

    // Guard commitment building per item — quarantine poison rows, never crash.
    const { valid: items2, commitments } = await this.buildCommitmentsSafe(items, "pending");
    if (commitments.length === 0) return;

    const { wallet, client: commitClient } = getCommitWallet(config);
    const handle = await acquireNonce("commit", config);
    try {
      const gasEstimate = await commitClient.estimateContractGas({
        address: BATCH_HELPER_ADDRESS,
        abi: BATCH_ABI,
        functionName: "batchCommit",
        args: [CONTRACT_ADDRESS, commitments],
        account: wallet.account,
      });
      const hash = await wallet.writeContract({
        address: BATCH_HELPER_ADDRESS,
        abi: BATCH_ABI,
        functionName: "batchCommit",
        args: [CONTRACT_ADDRESS, commitments],
        nonce: handle.nonce,
        gas: gasEstimate * 120n / 100n,
      });

      // Wait for receipt and verify success
      const commitReceipt = await commitClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
      if (commitReceipt.status === "reverted") {
        throw new Error(`batchCommit tx reverted: ${hash}`);
      }

      const now = Date.now();
      const stmts = items2.map((item) =>
        this.db.prepare("UPDATE create_queue SET status = 'committed', updatedAt = ? WHERE id = ?")
          .bind(now, item.id)
      );
      await this.db.batch(stmts);
      log.info("batchCommit confirmed", { operation: "batchCommit", count: items2.length, outcome: "success" });
    } catch (err) {
      handle.release();
      const msg = shortMsg(err);
      if (batchFailureAction(err) === "retry-transient") {
        for (const item of items2) await this.handleFailure(item, `batchCommit: ${msg}`, "pending");
        log.warn("batchCommit transient failure, backing off", { operation: "batchCommit", count: items2.length, error_category: "transient" });
      } else {
        log.warn("batchCommit poison batch, isolating", { operation: "batchCommit", count: items2.length, error_category: "poison" });
        await this.isolatePoisonCommit(commitClient, wallet, items2);
      }
    }
  }

  /**
   * Build commitments for a batch, quarantining any row whose stored fields
   * can't be ABI-encoded (poison). MUST be used instead of items.map(build...)
   * so one bad row goes to the DLQ instead of crashing the whole worker cycle.
   */
  private async buildCommitmentsSafe(
    items: QueueItem[],
    retryStatus: "pending" | "committed",
  ): Promise<{ valid: QueueItem[]; commitments: `0x${string}`[] }> {
    const valid: QueueItem[] = [];
    const commitments: `0x${string}`[] = [];
    for (const item of items) {
      try {
        commitments.push(buildCommitment(item).commitment);
        valid.push(item);
      } catch (err) {
        await this.handleFailure(item, `uncommittable (bad encoding): ${shortMsg(err)}`, retryStatus, { poison: true });
      }
    }
    return { valid, commitments };
  }

  private async cleanupDoneRecords(): Promise<void> {
    const now = Date.now();
    // Bound the DLQ ('failed') alongside 'done' cleanup so neither grows forever.
    await this.db.prepare("DELETE FROM create_queue WHERE status = 'failed' AND updatedAt < ?")
      .bind(now - FAILED_RETENTION).run();
    const result = await this.db.prepare("DELETE FROM create_queue WHERE status = 'done' AND updatedAt < ?")
      .bind(now - DONE_RETENTION).run();
    if (result.meta.changes && result.meta.changes > 0) {
      console.log(`[queue-processor] Cleaned up ${result.meta.changes} done records`);
    }
  }

  private async handleFailure(
    item: QueueItem,
    error: string,
    retryStatus: "pending" | "committed" = "pending",
    opts?: { poison?: boolean },
  ): Promise<void> {
    const retries = item.retries + 1;
    const terminal = opts?.poison || retries >= MAX_RETRIES;
    if (terminal) {
      const prefix = opts?.poison ? "POISON" : "EXHAUSTED";
      await this.db.prepare("UPDATE create_queue SET status = 'failed', error = ?, retries = ?, updatedAt = ? WHERE id = ?")
        .bind(`${prefix}: ${error}`, retries, Date.now(), item.id).run();
      log.error("queue item quarantined to DLQ", {
        job_id: item.id, operation: "tx", outcome: opts?.poison ? "poison" : "exhausted",
        error_category: opts?.poison ? "poison" : "transient", retries,
      });
    } else {
      const delay = retryDelayMs(retries);
      const retryAfter = Date.now() + delay;
      await this.db.prepare("UPDATE create_queue SET status = ?, error = ?, retries = ?, retryAfter = ?, updatedAt = ? WHERE id = ?")
        .bind(retryStatus, error, retries, retryAfter, Date.now(), item.id).run();
      log.warn("queue item retry scheduled", {
        job_id: item.id, operation: "tx", outcome: "retry", attempt: retries,
        error_category: "transient", next_retry_in_s: Math.round(delay / 1000),
      });
    }

    this.failuresSinceLastAlert++;
    if (this.failuresSinceLastAlert >= FAILURE_ALERT_BATCH) {
      const config = await this.getConfig();
      const failed = await this.db.prepare("SELECT COUNT(*) as count FROM create_queue WHERE status = 'failed'")
        .first<{ count: number }>();
      await sendTelegram(config, `🔴 [webauthnp256-publickey-index] [CF Worker] [Gnosis]\n${this.failuresSinceLastAlert} tx failures\nTotal in DLQ (failed): ${failed?.count ?? 0}\nLatest: ${error}`);
      this.failuresSinceLastAlert = 0;
    }
  }

  private async checkAlerts(config: AppConfig): Promise<void> {
    const now = Date.now();
    if (now - this.lastAlertAt < ALERT_INTERVAL) return;
    this.lastAlertAt = now;

    const alerts: string[] = [];

    const pending = await this.db.prepare(
      "SELECT COUNT(*) as count FROM create_queue WHERE status IN ('pending', 'committed', 'creating')"
    ).first<{ count: number }>();
    if (pending && pending.count >= QUEUE_BACKLOG_THRESHOLD) {
      alerts.push(`⚠️ Queue backlog: ${pending.count} items pending`);
    }

    const failed = await this.db.prepare(
      "SELECT COUNT(*) as count FROM create_queue WHERE status = 'failed'"
    ).first<{ count: number }>();
    if (failed && failed.count > 0 && failed.count !== this.lastFailedCount) {
      alerts.push(`🔴 ${failed.count} items permanently failed`);
    }
    this.lastFailedCount = failed?.count ?? 0;

    try {
      const { wallet: createWallet, client } = getCreateWallet(config);
      const balance = await client.getBalance({ address: createWallet.account.address });
      const balanceXdai = Number(balance) / 1e18;
      if (balanceXdai < GAS_BALANCE_THRESHOLD) {
        alerts.push(`🪫 Create wallet balance low: ${balanceXdai.toFixed(6)} xDAI (${createWallet.account.address})`);
      }

      // Auto-fund commit wallet
      const { wallet: commitWallet } = getCommitWallet(config);
      if (commitWallet.account.address !== createWallet.account.address) {
        const commitBalance = await client.getBalance({ address: commitWallet.account.address });
        const commitBalanceXdai = Number(commitBalance) / 1e18;
        if (commitBalanceXdai < FUND_THRESHOLD) {
          await this.ensureCommitWalletFunded(config);
        }
      }
    } catch (err) { console.warn(`[queue-processor] checkAlerts gas/balance check failed:`, err instanceof Error ? err.message : err); }

    if (alerts.length > 0) {
      await sendTelegram(config, `[webauthnp256-publickey-index] [CF Worker] [Gnosis]\n${alerts.join("\n")}`);
    }
  }

  private async ensureCommitWalletFunded(config: AppConfig): Promise<void> {
    try {
      const { wallet: createWallet, client } = getCreateWallet(config);
      const { wallet: commitWallet } = getCommitWallet(config);
      if (commitWallet.account.address === createWallet.account.address) return;

      const commitBalance = await client.getBalance({ address: commitWallet.account.address });
      if (Number(commitBalance) / 1e18 >= FUND_THRESHOLD) return;

      const mainBalance = await client.getBalance({ address: createWallet.account.address });
      if (Number(mainBalance) / 1e18 < FUND_AMOUNT + GAS_BALANCE_THRESHOLD) return;

      const hash = await createWallet.sendTransaction({
        to: commitWallet.account.address,
        value: BigInt(Math.floor(FUND_AMOUNT * 1e18)),
      });
      const fundReceipt = await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
      if (fundReceipt.status === "reverted") {
        throw new Error(`Fund tx reverted: ${hash}`);
      }
      console.log(`[queue-processor] Commit wallet funded: ${hash}`);
    } catch (err) {
      console.warn(`[queue-processor] Auto-fund failed:`, err instanceof Error ? err.message : err);
    }
  }
}
