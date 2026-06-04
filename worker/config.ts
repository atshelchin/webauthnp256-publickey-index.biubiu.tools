/**
 * Config builder for CF Worker.
 * Uses crypto.subtle instead of node:crypto for key derivation.
 */
import type { Env } from "./types.ts";
import type { AppConfig } from "../shared/queue.ts";

async function deriveCommitKey(privateKey: string): Promise<string> {
  const hex = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
  const bytes = new Uint8Array(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return "0x" + Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function buildConfig(env: Env): Promise<AppConfig> {
  const privateKey = env.PRIVATE_KEY || "";
  return {
    privateKey,
    commitPrivateKey: privateKey ? await deriveCommitKey(privateKey) : "",
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: env.TELEGRAM_CHAT_ID || "",
  };
}
