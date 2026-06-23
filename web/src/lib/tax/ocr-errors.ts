export function isProcessTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { message?: string; killed?: boolean; signal?: string; code?: string };
  if (e.killed || e.signal === "SIGTERM" || e.signal === "SIGKILL") return true;
  if (e.code === "ETIMEDOUT") return true;
  const msg = String(e.message ?? "").toLowerCase();
  return msg.includes("timed out") || msg.includes("timeout") || msg.includes("time limit");
}

export function ocrTimeoutUserMessage(): string {
  return "Processing exceeded the server time limit. Partial results may be shown when available. Try Fast for a quick preview or Balanced for full coverage.";
}
