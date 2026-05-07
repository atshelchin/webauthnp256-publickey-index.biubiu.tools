import { createPublicClient, createWalletClient, http, keccak256, encodeAbiParameters, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gnosis } from "viem/chains";

const abi = [
  {
    type: "function",
    name: "commit",
    inputs: [{ name: "commitment", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "createRecord",
    inputs: [
      { name: "rpId", type: "string" },
      { name: "credentialId", type: "string" },
      { name: "publicKey", type: "bytes" },
      { name: "name", type: "string" },
      { name: "initialCredentialId", type: "string" },
      { name: "metadata", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
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

const CONTRACT_ADDRESS = "0xc1f7Ef155a0ee1B48edbbB5195608e336ae6542b" as const;

function getRpcUrl(): string {
  return Deno.env.get("RPC_URL") || "https://rpc.gnosischain.com";
}

function getClient() {
  return createPublicClient({
    chain: gnosis,
    transport: http(getRpcUrl()),
  });
}

function getWalletClient() {
  const pk = Deno.env.get("PRIVATE_KEY");
  if (!pk) throw new Error("Missing env: PRIVATE_KEY");
  const account = privateKeyToAccount(pk as `0x${string}`);
  return createWalletClient({
    account,
    chain: gnosis,
    transport: http(getRpcUrl()),
  });
}

// Strip leading "0x" from viem hex bytes
function stripHexPrefix(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
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

  return {
    rpId: record.rpId,
    credentialId: record.credentialId,
    publicKey: stripHexPrefix(record.publicKey),
    name: record.name,
    initialCredentialId: record.initialCredentialId,
    metadata: stripHexPrefix(record.metadata),
    createdAt: Number(record.createdAt) * 1000,
  };
}

// --- Create (commit-reveal) ---

export async function createPublicKey(
  rpId: string,
  credentialId: string,
  publicKey: string,
  name: string,
  initialCredentialId: string,
  metadata: string,
): Promise<{ txHash: string }> {
  const client = getClient();
  const wallet = getWalletClient();

  const publicKeyHex = (publicKey.startsWith("0x") ? publicKey : `0x${publicKey}`) as `0x${string}`;
  const metadataHex = (metadata ? (metadata.startsWith("0x") ? metadata : `0x${metadata}`) : "0x") as `0x${string}`;

  // 1. Compute commitment
  const commitment = keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "string" },
        { type: "bytes" },
        { type: "string" },
        { type: "string" },
        { type: "bytes" },
      ],
      [rpId, credentialId, publicKeyHex, name, initialCredentialId, metadataHex],
    ),
  );

  // 2. Send commit tx
  const commitHash = await wallet.writeContract({
    address: CONTRACT_ADDRESS,
    abi,
    functionName: "commit",
    args: [commitment],
  });
  await client.waitForTransactionReceipt({ hash: commitHash });

  // 3. Wait for 1 block (REVEAL_DELAY)
  await waitForNextBlock(client);

  // 4. Send createRecord tx
  const createHash = await wallet.writeContract({
    address: CONTRACT_ADDRESS,
    abi,
    functionName: "createRecord",
    args: [rpId, credentialId, publicKeyHex, name, initialCredentialId, metadataHex],
  });
  await client.waitForTransactionReceipt({ hash: createHash });

  return { txHash: createHash };
}

async function waitForNextBlock(client: ReturnType<typeof getClient>): Promise<void> {
  const current = await client.getBlockNumber();
  while (true) {
    await new Promise((r) => setTimeout(r, 2000));
    const now = await client.getBlockNumber();
    if (now > current) return;
  }
}

// --- Stats ---

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

  const items = records.map((r) => ({
    rpId: r.rpId,
    credentialId: r.credentialId,
    publicKey: stripHexPrefix(r.publicKey),
    name: r.name,
    initialCredentialId: r.initialCredentialId,
    metadata: stripHexPrefix(r.metadata),
    createdAt: Number(r.createdAt) * 1000,
  }));

  return { total: Number(total), page, pageSize, items };
}
