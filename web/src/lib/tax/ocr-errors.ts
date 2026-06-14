export function isProcessTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { message?: string; killed?: boolean; signal?: string; code?: string };
  if (e.killed || e.signal === "SIGTERM" || e.signal === "SIGKILL") return true;
  if (e.code === "ETIMEDOUT") return true;
  const msg = String(e.message ?? "").toLowerCase();
  return msg.includes("timed out") || msg.includes("timeout") || msg.includes("time limit");
}

export function ocrTimeoutUserMessage(): string {
  return "OCR exceeded the server time limit (~5 min on Vercel). Partial embedded-text results may be shown when available. Try Fast mode for a preview, Balanced for full coverage, or use a VPS for Thorough.";
}
