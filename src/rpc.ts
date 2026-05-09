/**
 * Gnosis RPC provider with auto-failover.
 * Fetches RPC list from ethereum-data.awesometools.dev, then cycles
 * through endpoints on failure.
 */

const CHAIN_DATA_URL = "https://ethereum-data.awesometools.dev/chains/eip155-100.json";
const REFRESH_INTERVAL = 15 * 60_000; // refresh RPC list every 15 minutes
const HEALTH_CHECK_TIMEOUT = 5000; // 5s

// Fallback RPCs in case the remote list is unreachable
const FALLBACK_RPCS = [
  "https://rpc.gnosischain.com",
  "https://gnosis-rpc.publicnode.com",
  "https://gnosis.drpc.org",
  "https://1rpc.io/gnosis",
];

let rpcList: string[] = [...FALLBACK_RPCS];
let currentIndex = 0;
let lastRefresh = 0;

async function fetchRpcList(): Promise<string[]> {
  try {
    const res = await fetch(CHAIN_DATA_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const data = await res.json();
    const rpcs: string[] = [];
    // Extract HTTP(S) RPC URLs from the chain data
    for (const provider of data.rpc ?? []) {
      const url = typeof provider === "string" ? provider : provider?.url;
      if (typeof url === "string" && url.startsWith("https://") && !url.includes("${")) {
        rpcs.push(url);
      }
    }
    return rpcs;
  } catch {
    return [];
  }
}

async function refreshIfNeeded(): Promise<void> {
  const now = Date.now();
  if (now - lastRefresh < REFRESH_INTERVAL) return;
  lastRefresh = now;

  const fetched = await fetchRpcList();
  if (fetched.length > 0) {
    rpcList = fetched;
    currentIndex = 0;
    console.log(`[rpc] Refreshed RPC list: ${rpcList.length} endpoints`);
  }
}

export function getCurrentRpc(): string {
  const rpc = rpcList[currentIndex % rpcList.length];
  // Round-robin: advance to next RPC for the next caller
  currentIndex = (currentIndex + 1) % rpcList.length;
  return rpc;
}

export function failover(): string {
  const next = rpcList[currentIndex % rpcList.length];
  currentIndex = (currentIndex + 1) % rpcList.length;
  console.warn(`[rpc] Failover to: ${next}`);
  return next;
}

export async function initRpc(): Promise<void> {
  const fetched = await fetchRpcList();
  if (fetched.length > 0) {
    rpcList = fetched;
    console.log(`[rpc] Loaded ${rpcList.length} RPC endpoints`);
  } else {
    console.log(`[rpc] Using ${FALLBACK_RPCS.length} fallback RPC endpoints`);
  }
  lastRefresh = Date.now();

  // Periodic refresh
  setInterval(() => {
    refreshIfNeeded().catch(() => {});
  }, REFRESH_INTERVAL);
}

/**
 * Get a working RPC URL. Tries current, on failure cycles through the list.
 */
export async function getHealthyRpc(): Promise<string> {
  await refreshIfNeeded();

  // Try current first
  const current = getCurrentRpc();
  if (await isHealthy(current)) return current;

  // Cycle through others
  for (let i = 1; i < rpcList.length; i++) {
    const url = failover();
    if (await isHealthy(url)) return url;
  }

  // All failed, return current anyway and let caller handle error
  return getCurrentRpc();
}

async function isHealthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }),
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return !!data.result;
  } catch {
    return false;
  }
}
