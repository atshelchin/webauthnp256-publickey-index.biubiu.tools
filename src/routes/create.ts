import { createPublicKey, getPublicKey } from "../contract.ts";

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

  const { rpId, credentialId, publicKey, name, initialCredentialId, metadata } = body;

  if (!rpId || !credentialId || !publicKey || !name || !initialCredentialId || !metadata) {
    return Response.json(
      { error: "rpId, credentialId, publicKey, name, initialCredentialId, and metadata are required" },
      { status: 400 },
    );
  }

  // Check if already exists
  const existing = await getPublicKey(rpId, credentialId);
  if (existing) {
    return Response.json({ error: "public key already exists" }, { status: 409 });
  }

  try {
    const { txHash } = await createPublicKey(rpId, credentialId, publicKey, name, initialCredentialId, metadata);
    return Response.json({ rpId, credentialId, publicKey, name, txHash }, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ error: `create failed: ${message}` }, { status: 500 });
  }
}
