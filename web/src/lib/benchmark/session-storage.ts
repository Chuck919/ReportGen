import type { ParseBenchmarkResponse } from "@/lib/api/types";

const STORAGE_KEY = "reportgen-benchmark-session-v1";

export type BenchmarkSession = {
  data: ParseBenchmarkResponse | null;
  busy?: boolean;
  progressLabel?: string;
  progressPercent?: number;
  error?: string;
};

function readSession(): BenchmarkSession {
  if (typeof window === "undefined") return { data: null };
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return { data: null };
    const parsed = JSON.parse(raw) as BenchmarkSession;
    if (!parsed || typeof parsed !== "object") return { data: null };
    return { data: parsed.data ?? null, ...parsed };
  } catch {
    return { data: null };
  }
}

function writeSession(session: BenchmarkSession): void {
  if (typeof window === "undefined") return;
  try {
    if (!session.data && !session.busy) {
      sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // quota or private mode
  }
}

export function loadBenchmarkSession(): BenchmarkSession {
  return readSession();
}

export function saveBenchmarkSession(session: BenchmarkSession): void {
  writeSession(session);
}

export function clearBenchmarkSession(): void {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(STORAGE_KEY);
}
