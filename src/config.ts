/**
 * Global config from environment variables.
 * Deployed via .env file written by `deno task deploy`.
 */

export interface AppConfig {
  port: number;
  privateKey: string;
  queueDbPath: string;
  telegramBotToken: string;
  telegramChatId: string;
}

let config: AppConfig;

export function initConfig(): AppConfig {
  config = {
    port: parseInt(Deno.env.get("PORT") || "11256"),
    privateKey: Deno.env.get("PRIVATE_KEY") || "",
    queueDbPath: Deno.env.get("QUEUE_DB_PATH") || "queue.db",
    telegramBotToken: Deno.env.get("TELEGRAM_BOT_TOKEN") || "",
    telegramChatId: Deno.env.get("TELEGRAM_CHAT_ID") || "",
  };
  return config;
}

export function getConfig(): AppConfig {
  if (!config) throw new Error("Config not initialized. Call initConfig() first.");
  return config;
}
