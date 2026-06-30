const DEFAULT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_MEMORY_BYTES = 100 * 1024 * 1024; // 100MB

let CACHE_TTL = DEFAULT_CACHE_TTL;
let MAX_MEMORY_BYTES = DEFAULT_MAX_MEMORY_BYTES;

interface CacheEntry {
  value: unknown;
  size: number;
  expiresAt: number;
  storedAt: number;
}

// Map preserves insertion order — oldest entries are first
const store = new Map<string, CacheEntry>();
let totalSize = 0;

const encoder = new TextEncoder();

function estimateSize(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

// Approximate LRU: a touched entry moves to the Map tail (most-recently-used),
// so evictOldest (which deletes from the front) reclaims the COLDEST entries
// first — keeping hot entries, including hot last-known-good, available for an
// outage instead of evicting them in blind insertion order.
function touch(key: string, entry: CacheEntry): void {
  store.delete(key);
  store.set(key, entry);
}

function evictOldest(): void {
  for (const [key, entry] of store) {
    if (totalSize <= MAX_MEMORY_BYTES) break;
    totalSize -= entry.size;
    store.delete(key);
  }
}

export function cacheGet<T>(key: string): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  // Expired: not fresh, but RETAINED (not deleted) so it can still serve as
  // last-known-good if an upstream read fails. Don't promote it on this path —
  // a fresh fetch will re-cache it. cacheGetStale() reads/promotes these.
  if (Date.now() > entry.expiresAt) return undefined;
  touch(key, entry); // hot fresh entry → keep it
  return entry.value as T;
}

/**
 * Last-known-good read: returns the value even if the TTL has expired, with its
 * age. Used to degrade gracefully ("serve slightly stale, marked") when the
 * authoritative upstream (chain RPC) is unreachable, instead of erroring.
 */
export function cacheGetStale<T>(key: string): { value: T; ageMs: number } | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  touch(key, entry); // a served LKG entry is hot → protect it from eviction
  return { value: entry.value as T, ageMs: Date.now() - entry.storedAt };
}

export function cacheSet<T>(key: string, value: T): void {
  const existing = store.get(key);
  if (existing) {
    totalSize -= existing.size;
    store.delete(key);
  }

  const size = estimateSize(value);
  totalSize += size;
  const now = Date.now();
  store.set(key, { value, size, expiresAt: now + CACHE_TTL, storedAt: now });

  if (totalSize > MAX_MEMORY_BYTES) {
    evictOldest();
  }
}

/**
 * Build a collision-safe cache key. User-controlled parts are percent-escaped so
 * a ':' inside a value cannot merge into the delimiter and ALIAS another key —
 * e.g. (rpId="x", credentialId="a:b") and (rpId="x:a", credentialId="b") would
 * otherwise both produce "query:x:a:b" and serve each other's record (a targeted
 * key-substitution). encodeURIComponent escapes ':' (→ %3A), removing the alias.
 */
export function cacheKey(...parts: (string | number)[]): string {
  return parts.map((p) => encodeURIComponent(String(p))).join(":");
}

export function cacheClear(): void {
  store.clear();
  totalSize = 0;
}

export function cacheSize(): number {
  return store.size;
}

export function cacheMemoryUsage(): number {
  return totalSize;
}

/** Override TTL and memory limit (for testing only). */
export function _configureForTest(opts: { ttl?: number; maxBytes?: number }): void {
  if (opts.ttl !== undefined) CACHE_TTL = opts.ttl;
  if (opts.maxBytes !== undefined) MAX_MEMORY_BYTES = opts.maxBytes;
}

/** Reset configuration to defaults (for testing only). */
export function _resetConfigForTest(): void {
  CACHE_TTL = DEFAULT_CACHE_TTL;
  MAX_MEMORY_BYTES = DEFAULT_MAX_MEMORY_BYTES;
}
