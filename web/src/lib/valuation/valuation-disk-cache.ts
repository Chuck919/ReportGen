import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_CACHE_ROOT = join(process.cwd(), ".cache", "valuation-api");
const LEGACY_E2E_CACHE = join(process.cwd(), ".cache", "valuation-e2e");

function cacheRoot(): string {
  return process.env.VALUATION_DISK_CACHE_DIR?.trim() || DEFAULT_CACHE_ROOT;
}

export function diskCacheOnly(): boolean {
  return process.env.VALUATION_DISK_CACHE_ONLY === "1" || process.env.VALUATION_DISK_CACHE_ONLY === "true";
}

export function diskCacheKey(parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

export function readDiskCache<T>(namespace: string, key: string): T | undefined {
  const path = join(cacheRoot(), namespace, `${key}.json`);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function writeDiskCache<T>(namespace: string, key: string, value: T): T {
  const dir = join(cacheRoot(), namespace);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${key}.json`);
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
  return value;
}

export function readOrThrowDiskCache<T>(namespace: string, key: string, label: string): T {
  const cached = readDiskCache<T>(namespace, key);
  if (cached !== undefined) return cached;
  if (diskCacheOnly()) {
    throw new Error(
      `Disk cache miss (${label}). Run once without VALUATION_DISK_CACHE_ONLY to populate .cache/valuation-api/${namespace}/`,
    );
  }
  throw new Error(`Disk cache miss (${label})`);
}

function legacyFetchKey(method: string, url: string, bodyKey: string): string {
  return createHash("sha1").update(`${method}:${url}:${bodyKey}`).digest("hex");
}

type FetchCacheBlob = { status: number; headers: Record<string, string>; body: string };

function readFetchCache(method: string, url: string, bodyKey: string): FetchCacheBlob | undefined {
  const key = diskCacheKey([method, url, bodyKey]);
  const primary = readDiskCache<FetchCacheBlob>("fetch", key);
  if (primary) return primary;

  const legacyPath = join(LEGACY_E2E_CACHE, `${legacyFetchKey(method, url, bodyKey)}.json`);
  if (!existsSync(legacyPath)) return undefined;
  try {
    const legacy = JSON.parse(readFileSync(legacyPath, "utf8")) as FetchCacheBlob;
    writeDiskCache("fetch", key, legacy);
    return legacy;
  } catch {
    return undefined;
  }
}

function writeFetchCache(method: string, url: string, bodyKey: string, value: FetchCacheBlob): FetchCacheBlob {
  const key = diskCacheKey([method, url, bodyKey]);
  return writeDiskCache("fetch", key, value);
}

/** Wrap fetch for tests/scripts — reads/writes JSON { status, headers, body } blobs. */
export function installValuationFetchDiskCache(options?: { cacheOnly?: boolean }): () => void {
  const original = globalThis.fetch.bind(globalThis);
  const cacheOnly = options?.cacheOnly ?? diskCacheOnly();

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const bodyKey = init?.body ? createHash("sha1").update(String(init.body).slice(0, 12_000)).digest("hex") : "";
    const cached = readFetchCache(method, url, bodyKey);
    if (cached) {
      return new Response(cached.body, { status: cached.status, headers: cached.headers });
    }
    if (cacheOnly) {
      throw new Error(`Fetch cache miss (cache-only mode): ${method} ${url}`);
    }
    const res = await original(input, init);
    const text = await res.clone().text();
    const headersObj: Record<string, string> = {};
    res.headers.forEach((value, header) => {
      headersObj[header] = value;
    });
    writeFetchCache(method, url, bodyKey, { status: res.status, headers: headersObj, body: text });
    return new Response(text, { status: res.status, headers: headersObj });
  };

  return () => {
    globalThis.fetch = original;
  };
}
