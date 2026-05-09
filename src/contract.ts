import { createPublicClient, http, type Abi } from "viem";
import { gnosis } from "viem/chains";
import { getCurrentRpc, markFailed } from "./rpc.ts";

const abi = [
  {
    type: "function",
    name: "getRecord",
    inputs: [
      { name: "rpId", type: "string" },
      { name: "credentialId", type: "string" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "rpId", type: "string" },
          { name: "credentialId", type: "string" },
          { name: "walletRef", type: "bytes32" },
          { name: "publicKey", type: "bytes" },
          { name: "name", type: "string" },
          { name: "initialCredentialId", type: "string" },
          { name: "metadata", type: "bytes" },
          { name: "createdAt", type: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getRecordByWalletRef",
    inputs: [{ name: "walletRef", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "rpId", type: "string" },
          { name: "credentialId", type: "string" },
          { name: "walletRef", type: "bytes32" },
          { name: "publicKey", type: "bytes" },
          { name: "name", type: "string" },
          { name: "initialCredentialId", type: "string" },
          { name: "metadata", type: "bytes" },
          { name: "createdAt", type: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "hasRecord",
    inputs: [
      { name: "rpId", type: "string" },
      { name: "credentialId", type: "string" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getCommitBlock",
    inputs: [{ name: "commitment", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getTotalCredentials",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getRpIds",
    inputs: [
      { name: "offset", type: "uint256" },
      { name: "limit", type: "uint256" },
      { name: "desc", type: "bool" },
    ],
    outputs: [
      { name: "total", type: "uint256" },
      { name: "rpIds", type: "string[]" },
      { name: "counts", type: "uint256[]" },
      { name: "createdAts", type: "uint256[]" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getKeysByRpId",
    inputs: [
      { name: "rpId", type: "string" },
      { name: "offset", type: "uint256" },
      { name: "limit", type: "uint256" },
      { name: "desc", type: "bool" },
    ],
    outputs: [
      { name: "total", type: "uint256" },
      {
        name: "records",
        type: "tuple[]",
        components: [
          { name: "rpId", type: "string" },
          { name: "credentialId", type: "string" },
          { name: "walletRef", type: "bytes32" },
          { name: "publicKey", type: "bytes" },
          { name: "name", type: "string" },
          { name: "initialCredentialId", type: "string" },
          { name: "metadata", type: "bytes" },
          { name: "createdAt", type: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
  },
] as const satisfies Abi;

export const CONTRACT_ADDRESS = "0xdd93420BD49baaBdFF4A363DdD300622Ae87E9c3" as const;
export const CONTRACT_ABI = abi;

export function getClient() {
  const rpcUrl = getCurrentRpc();
  const client = createPublicClient({
    chain: gnosis,
    transport: http(rpcUrl),
  });
  return { client, rpcUrl };
}

// Strip leading "0x" from viem hex bytes
function stripHexPrefix(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

function formatRecord(record: { rpId: string; credentialId: string; walletRef: string; publicKey: string; name: string; initialCredentialId: string; metadata: string; createdAt: bigint }) {
  return {
    rpId: record.rpId,
    credentialId: record.credentialId,
    walletRef: record.walletRef,
    publicKey: stripHexPrefix(record.publicKey),
    name: record.name,
    initialCredentialId: record.initialCredentialId,
    metadata: stripHexPrefix(record.metadata),
    createdAt: Number(record.createdAt) * 1000,
  };
}

function isContractRevert(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("reverted") || msg.includes("revert");
}

const MAX_RPC_RETRIES = 3;

/**
 * Read contract with automatic RPC retry.
 * On RPC failure, marks the RPC as failed and retries with the next one.
 * On contract revert, throws immediately (no retry).
 */
// deno-lint-ignore no-explicit-any
async function readWithRetry(params: any): Promise<any> {
  let lastErr: unknown;
  for (let i = 0; i < MAX_RPC_RETRIES; i++) {
    const { client, rpcUrl } = getClient();
    try {
      return await client.readContract({ address: CONTRACT_ADDRESS, abi, ...params });
    } catch (err) {
      if (isContractRevert(err)) throw err; // contract revert, no retry
      markFailed(rpcUrl);
      lastErr = err;
    }
  }
  throw lastErr;
}

// --- Query ---

export async function getPublicKey(rpId: string, credentialId: string) {
  try {
    const record = await readWithRetry({
      functionName: "getRecord",
      args: [rpId, credentialId],
    });
    return formatRecord(record);
  } catch {
    return null;
  }
}

export async function getPublicKeyByWalletRef(walletRef: `0x${string}`) {
  try {
    const record = await readWithRetry({
      functionName: "getRecordByWalletRef",
      args: [walletRef],
    });
    return formatRecord(record);
  } catch {
    return null;
  }
}

// --- Stats ---

export async function getTotalCredentials(): Promise<number> {
  const total = await readWithRetry({ functionName: "getTotalCredentials" });
  return Number(total);
}

export async function listRpIds(page: number, pageSize: number, order: "asc" | "desc" = "desc") {
  const offset = (page - 1) * pageSize;

  const [total, rpIds, counts, createdAts] = await readWithRetry({
    functionName: "getRpIds",
    args: [BigInt(offset), BigInt(pageSize), order === "desc"],
  });

  const items = (rpIds as string[]).map((rpId: string, i: number) => ({
    rpId,
    publicKeyCount: Number(counts[i]),
    createdAt: Number(createdAts[i]) * 1000,
  }));

  return { total: Number(total), page, pageSize, items };
}

export async function listPublicKeysByRpId(rpId: string, page: number, pageSize: number, order: "asc" | "desc" = "desc") {
  const offset = (page - 1) * pageSize;

  const [total, records] = await readWithRetry({
    functionName: "getKeysByRpId",
    args: [rpId, BigInt(offset), BigInt(pageSize), order === "desc"],
  });

  const items = (records as Array<{ rpId: string; credentialId: string; walletRef: string; publicKey: string; name: string; initialCredentialId: string; metadata: string; createdAt: bigint }>).map((r) => formatRecord(r));

  return { total: Number(total), page, pageSize, items };
}
