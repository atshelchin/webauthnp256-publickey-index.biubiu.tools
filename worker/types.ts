export interface Env {
  DB: D1Database;
  PRIVATE_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  QUEUE_PROCESSOR: DurableObjectNamespace;
}
