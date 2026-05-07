/**
 * Global config from CLI args. No .env needed.
 *
 * Usage: deno task start -- --port 11256 --private-key 0x...
 */

export interface AppConfig {
  port: number;
  privateKey: string;
  queueDbPath: string;
  telegramBotToken: string;
  telegramChatId: string;
}

let config: AppConfig;

export function initConfig(args: string[] = Deno.args): AppConfig {
  const parsed = parseArgs(args);
  config = {
    port: parseInt(parsed["port"] ?? "11256"),
    privateKey: parsed["private-key"] ?? "",
    queueDbPath: parsed["queue-db"] ?? "queue.db",
    telegramBotToken: parsed["telegram-bot-token"] ?? "",
    telegramChatId: parsed["telegram-chat-id"] ?? "",
  };
  return config;
}

export function getConfig(): AppConfig {
  if (!config) throw new Error("Config not initialized. Call initConfig() first.");
  return config;
}

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--") && i + 1 < args.length && !args[i + 1].startsWith("--")) {
      result[arg.slice(2)] = args[i + 1];
      i++;
    }
  }
  return result;
}
