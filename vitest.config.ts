import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["worker/tests/**/*.test.ts"],
    poolOptions: {
      workers: {
        isolatedStorage: false,
        main: "./worker/index.ts",
        miniflare: {
          compatibilityDate: "2024-09-23",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          durableObjects: {
            QUEUE_PROCESSOR: "QueueProcessor",
          },
          bindings: {
            PRIVATE_KEY: "",
            TELEGRAM_BOT_TOKEN: "",
            TELEGRAM_CHAT_ID: "",
          },
        },
      },
    },
  },
});
