import { getPublicKey } from "../contract.ts";
import { enqueue, findDuplicate, getQueueItem, checkRateLimit } from "../queue.ts";
import { encodeAbiParameters } from "viem";

export async function handleCreate(req: Request): Promise<Response> {
  let body: {
    rpId?: string;
    credentialId?: string;
    publicKey?: string;
    name?: string;
    initialCredentialId?: string;
    metadata?: string;
  };

  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const name = body.name;
  const { rpId, credentialId, publicKey } = body;

  if (!rpId || !credentialId || !publicKey || !name) {
    return Response.json(
      { error: "rpId, credentialId, publicKey, and name are required" },
      { status: 400 },
    );
  }

  // Rate limit by IP
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("x-real-ip")
    || "unknown";
  if (!checkRateLimit(ip)) {
    return Response.json({ error: "rate limit exceeded, max 5 requests per minute" }, { status: 429 });
  }

  const initialCredentialId = body.initialCredentialId || credentialId;
  const publicKeyHex = (publicKey.startsWith("0x") ? publicKey : `0x${publicKey}`) as `0x${string}`;
  const metadata = body.metadata || encodeAbiParameters(
    [{ type: "string" }, { type: "bytes" }],
    ["VelaWalletV1", publicKeyHex],
  );

  // Check if already exists on-chain
  const existing = await getPublicKey(rpId, credentialId);
  if (existing) {
    return Response.json({ error: "public key already exists" }, { status: 409 });
  }

  // Check if already in queue
  const queued = findDuplicate(rpId, credentialId);
  if (queued) {
    return Response.json({ id: queued.id, status: queued.status }, { status: 202 });
  }

  // Enqueue
  const id = enqueue({ rpId, credentialId, publicKey, name, initialCredentialId, metadata, ip });
  return Response.json({ id, status: "pending" }, { status: 202 });
}

export function handleCreateStatus(req: Request): Response {
  const url = new URL(req.url);
  const id = url.pathname.split("/").pop();
  if (!id) {
    return Response.json({ error: "id is required" }, { status: 400 });
  }

  const item = getQueueItem(id);
  if (!item) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  return Response.json({
    id: item.id,
    status: item.status,
    rpId: item.rpId,
    credentialId: item.credentialId,
    publicKey: item.publicKey,
    name: item.name,
    txHash: item.txHash || undefined,
    error: item.error || undefined,
    createdAt: item.createdAt,
  });
}
