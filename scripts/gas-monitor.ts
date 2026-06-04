/**
 * Gnosis gas price monitor.
 * Checks every minute, sends Telegram alert when gas > 0.1 Gwei.
 * Cooldown: only alerts once per 30 minutes to avoid spam.
 *
 * Usage: deno run --allow-net --allow-env --env scripts/gas-monitor.ts
 */

const RPC_URL = "https://rpc.gnosischain.com";
const THRESHOLD_GWEI = 0.1;
const CHECK_INTERVAL = 60_000; // 1 minute
const ALERT_COOLDOWN = 30 * 60_000; // 30 minutes between alerts

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") || "";

let lastAlertTime = 0;

async function getGasPrice(): Promise<number> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_gasPrice", params: [], id: 1 }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json();
  return parseInt(data.result, 16);
}

async function sendTelegram(message: string) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("[telegram] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
    return;
  }
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
  });
}

async function check() {
  try {
    const gasPrice = await getGasPrice();
    const gwei = gasPrice / 1e9;
    const now = new Date().toLocaleTimeString();
    console.log(`[${now}] Gnosis gas: ${gwei.toFixed(4)} Gwei`);

    if (gwei > THRESHOLD_GWEI) {
      const elapsed = Date.now() - lastAlertTime;
      if (elapsed >= ALERT_COOLDOWN) {
        lastAlertTime = Date.now();
        await sendTelegram(`⛽ [Gnosis Gas Alert]\nGas price: ${gwei.toFixed(4)} Gwei\nThreshold: ${THRESHOLD_GWEI} Gwei`);
        console.log(`  → Telegram alert sent`);
      } else {
        const mins = Math.round((ALERT_COOLDOWN - elapsed) / 60_000);
        console.log(`  → High gas, but cooldown active (${mins}min left)`);
      }
    }
  } catch (e) {
    console.error(`[check] Error:`, e instanceof Error ? e.message : e);
  }
}

console.log(`Gas monitor started. Threshold: ${THRESHOLD_GWEI} Gwei, check: 1min, cooldown: 30min`);
await check();
setInterval(check, CHECK_INTERVAL);
