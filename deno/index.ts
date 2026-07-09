import { initConfig } from "./config.ts";
import { initRpc, setAlchemyRpc } from "../shared/rpc.ts";
import { initQueue, startQueueWorker, setGlobalWriteLimit, waitForQueueIdle } from "./queue.ts";
import { setIpHashSalt, deriveIpSalt } from "../shared/queue.ts";
import { configureCache } from "../shared/cache.ts";
import { log, setLogLevel } from "../shared/log.ts";
import { createHandler } from "./handler.ts";

const HOME_HTML = await Deno.readTextFile(new URL("./index.html", import.meta.url));

const config = initConfig();
if (config.alchemyApiKey) setAlchemyRpc(config.alchemyApiKey);
// Salt IP hashing with a DERIVED secret (never the raw signing key) so stored
// hashes can't be brute-forced back to raw IPs if the DB leaks.
setIpHashSalt(await deriveIpSalt(config.privateKey || "webauthnp256-index"));
setLogLevel(Deno.env.get("LOG_LEVEL") || "debug");
await initRpc();
await initQueue(config.queueDbPath);
// Operator-tunable budgets (docs: .env.example). Defaults are safe; the knobs
// exist so capacity changes don't require a code release.
const cacheMaxMb = Number(Deno.env.get("CACHE_MAX_MB"));
if (Number.isFinite(cacheMaxMb) && cacheMaxMb > 0) configureCache({ maxBytes: cacheMaxMb * 1024 * 1024 });
const globalWriteLimit = Number(Deno.env.get("GLOBAL_WRITE_LIMIT"));
if (Number.isFinite(globalWriteLimit) && globalWriteLimit > 0) setGlobalWriteLimit(globalWriteLimit);

const server = Deno.serve({ port: config.port }, createHandler(HOME_HTML));

console.log(`Server running at http://localhost:${config.port}`);

// The background worker signs mainnet txs and (via ensureCommitWalletFunded) can
// send real xDAI on startup / every hot-reload. Opt-OUT so `deno task dev` — which
// auto-loads the funded .env — never turns a laptop into a second live mainnet
// signer racing the production host's nonces. Production leaves this unset (worker
// runs); the dev task sets QUEUE_WORKER=0. Read-only APIs work either way.
if ((Deno.env.get("QUEUE_WORKER") ?? "1") !== "0") {
  startQueueWorker();
} else {
  console.warn("[queue] QUEUE_WORKER=0 — background worker DISABLED (read-only / dev mode); creates will queue but not be processed on-chain");
}

// Graceful shutdown: systemd sends SIGTERM on every deploy/restart. Stop
// accepting requests, then give an in-flight queue cycle (receipt waits run up
// to 60s) a bounded window to finish so we don't kill a batch mid-broadcast —
// the unstick sweep + reconcile would converge it anyway, but exiting cleanly
// avoids the duplicate-send churn entirely.
let shuttingDown = false;
Deno.addSignalListener("SIGTERM", () => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.warn("SIGTERM received — draining", { operation: "shutdown" });
  (async () => {
    try {
      await server.shutdown(); // stop accepting; in-flight HTTP completes
      const clean = await waitForQueueIdle(75_000);
      log.warn(clean ? "shutdown: queue idle, exiting" : "shutdown: queue still busy after 75s, exiting anyway", { operation: "shutdown" });
    } finally {
      Deno.exit(0);
    }
  })();
});

export { server };
