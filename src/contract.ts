import { createPublicClient, http, type Abi } from "viem";
import { gnosis } from "viem/chains";
import { getCurrentRpc } from "./rpc.ts";

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
  return createPublicClient({
    chain: gnosis,
    transport: http(getCurrentRpc()),
  });
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

// --- Query ---

export async function getPublicKey(rpId: string, credentialId: string) {
  const client = getClient();

  const exists = await client.readContract({
    address: CONTRACT_ADDRESS,
    abi,
    functionName: "hasRecord",
    args: [rpId, credentialId],
  });

  if (!exists) return null;

  const record = await client.readContract({
    address: CONTRACT_ADDRESS,
    abi,
    functionName: "getRecord",
    args: [rpId, credentialId],
  });

  return formatRecord(record);
}

export async function getPublicKeyByWalletRef(walletRef: `0x${string}`) {
  const client = getClient();

  try {
    const record = await client.readContract({
      address: CONTRACT_ADDRESS,
      abi,
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
  const client = getClient();
  const total = await client.readContract({
    address: CONTRACT_ADDRESS,
    abi,
    functionName: "getTotalCredentials",
  });
  return Number(total);
}

export async function listRpIds(page: number, pageSize: number, order: "asc" | "desc" = "desc") {
  const client = getClient();
  const offset = (page - 1) * pageSize;

  const [total, rpIds, counts, createdAts] = await client.readContract({
    address: CONTRACT_ADDRESS,
    abi,
    functionName: "getRpIds",
    args: [BigInt(offset), BigInt(pageSize), order === "desc"],
  });

  const items = rpIds.map((rpId, i) => ({
    rpId,
    publicKeyCount: Number(counts[i]),
    createdAt: Number(createdAts[i]) * 1000,
  }));

  return { total: Number(total), page, pageSize, items };
}

export async function listPublicKeysByRpId(rpId: string, page: number, pageSize: number, order: "asc" | "desc" = "desc") {
  const client = getClient();
  const offset = (page - 1) * pageSize;

  const [total, records] = await client.readContract({
    address: CONTRACT_ADDRESS,
    abi,
    functionName: "getKeysByRpId",
    args: [rpId, BigInt(offset), BigInt(pageSize), order === "desc"],
  });

  const items = records.map((r) => formatRecord(r));

  return { total: Number(total), page, pageSize, items };
}
