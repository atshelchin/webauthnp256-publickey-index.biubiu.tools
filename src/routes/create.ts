import { createPublicKey, getPublicKey } from "../db.ts";
import { cacheInvalidateByRpId } from "../cache.ts";
import { generateChallenge, consumeChallenge, verifySignature } from "../challenge.ts";

export function handleChallenge(): Response {
  const challenge = generateChallenge();
  return Response.json({ challenge });
}

export async function handleCreate(req: Request): Promise<Response> {
  let body: {
    rpId?: string;
    credentialId?: string;
    publicKey?: string;
    challenge?: string;
    signature?: string;
  };

  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { rpId, credentialId, publicKey, challenge, signature } = body;

  if (!rpId || !credentialId || !publicKey || !challenge || !signature) {
    return Response.json(
      { error: "rpId, credentialId, publicKey, challenge, and signature are required" },
      { status: 400 }
    );
  }

  if (!consumeChallenge(challenge)) {
    return Response.json({ error: "invalid or expired challenge" }, { status: 400 });
  }

  if (!verifySignature(publicKey, challenge, signature)) {
    return Response.json({ error: "signature verification failed" }, { status: 400 });
  }

  const existing = getPublicKey(rpId, credentialId);
  if (existing) {
    return Response.json({ error: "public key already exists" }, { status: 409 });
  }

  const result = createPublicKey(rpId, credentialId, publicKey);
  cacheInvalidateByRpId(rpId);

  return Response.json(result, { status: 201 });
}
