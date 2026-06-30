/**
 * Nonce manager (CF Worker version).
 * Same logic as Deno version, uses shared rpc.ts.
 */
import { createPublicClient, http } from "viem";
import { gnosis } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { getWriteRpc } from "../shared/rpc.ts";
import type { AppConfig } from "../shared/queue.ts";

interface NonceState {
  current: number | null;
  mutex: Promise<void>;
}

const pools = new Map<string, NonceState>();

function getPool(role: string): NonceState {
  let pool = pools.get(role);
  if (!pool) {
    pool = { current: null, mutex: Promise.resolve() };
    pools.set(role, pool);
  }
  return pool;
}

function getAccountForRole(role: string, config: AppConfig) {
  const pk = role === "commit" ? config.commitPrivateKey : config.privateKey;
  if (!pk) throw new Error(`Missing key for role: ${role}`);
  return privateKeyToAccount(pk as `0x${string}`);
}

async function fetchOnChainNonce(role: string, config: AppConfig): Promise<number> {
  const client = createPublicClient({
    chain: gnosis,
    // Bounded budget: runs inside the per-role nonce mutex (stalls the DO alarm
    // if slow). 5s × 1 retry instead of viem's ~40s default.
    transport: http(getWriteRpc(), { timeout: 5_000, retryCount: 1 }),
  });
  return await client.getTransactionCount({
    address: getAccountForRole(role, config).address,
    blockTag: "pending",
  });
}

export interface NonceHandle {
  nonce: number;
  release: () => void;
}

export function acquireNonce(role: "create" | "commit", config: AppConfig): Promise<NonceHandle> {
  const pool = getPool(role);
  return new Promise<NonceHandle>((resolve, reject) => {
    pool.mutex = pool.mutex.then(async () => {
      try {
        if (pool.current === null) {
          pool.current = await fetchOnChainNonce(role, config);
          console.log(`[nonce:${role}] Synced from chain: ${pool.current}`);
        }
        const nonce = pool.current;
        pool.current++;
        resolve({
          nonce,
          release: () => {
            pool.current = null;
            console.log(`[nonce:${role}] Released nonce ${nonce}, will resync`);
          },
        });
      } catch (err) {
        reject(err);
      }
    });
  });
}

export function resetNonce(role: "create" | "commit" = "create"): void {
  const pool = getPool(role);
  pool.current = null;
}
