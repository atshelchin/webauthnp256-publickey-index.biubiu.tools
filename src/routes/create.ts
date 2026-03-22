import { createPublicKey, getPublicKey } from "../db.ts";
import { cacheInvalidateByRpId } from "../cache.ts";
import { generateChallenge, consumeChallenge, verifyWebAuthnSignature } from "../challenge.ts";

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
    authenticatorData?: string;
    clientDataJSON?: string;
    name?: string;
  };

  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { rpId, credentialId, publicKey, challenge, signature, authenticatorData, clientDataJSON } = body;

  if (!rpId || !credentialId || !publicKey || !challenge || !signature || !authenticatorData || !clientDataJSON) {
    return Response.json(
      { error: "rpId, credentialId, publicKey, challenge, signature, authenticatorData, and clientDataJSON are required" },
      { status: 400 }
    );
  }

  if (!consumeChallenge(challenge)) {
    return Response.json({ error: "invalid or expired challenge" }, { status: 400 });
  }

  const verification = verifyWebAuthnSignature(publicKey, challenge, signature, authenticatorData, clientDataJSON);
  if (!verification.ok) {
    return Response.json({ error: `signature verification failed: ${verification.error}` }, { status: 400 });
  }

  const existing = getPublicKey(rpId, credentialId);
  if (existing) {
    return Response.json({ error: "public key already exists" }, { status: 409 });
  }

  const name = body.name || "";
  const result = createPublicKey(rpId, credentialId, publicKey, name);
  cacheInvalidateByRpId(rpId);

  return Response.json(result, { status: 201 });
}
