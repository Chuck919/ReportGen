type CacheEntry<T> = { value: T; expiresAt: number };

const memory = new Map<string, CacheEntry<unknown>>();
const hostLastCall = new Map<string, number>();

export function cacheGet<T>(key: string): T | undefined {
  const entry = memory.get(key) as CacheEntry<T> | undefined;
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    memory.delete(key);
    return undefined;
  }
  return entry.value;
}

export function cacheSet<T>(key: string, value: T, ttlMs: number): T {
  memory.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

/** Simple per-host throttle for free public APIs. */
export async function throttleHost(host: string, minGapMs: number): Promise<void> {
  const last = hostLastCall.get(host) ?? 0;
  const wait = minGapMs - (Date.now() - last);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  hostLastCall.set(host, Date.now());
}
