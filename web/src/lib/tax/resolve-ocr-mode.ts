import type { OcrMode } from "@/lib/api/types";

/** Hobby / Fluid Compute wall clock per serverless invocation. */
export const VERCEL_FUNCTION_MAX_MS = 300_000;

/** Client abort + server subprocess budget (buffer before platform kill). */
export const VERCEL_OCR_BUDGET_MS = 280_000;

const LOCAL_MODES: OcrMode[] = ["fast", "balanced", "thorough"];
const VERCEL_MODES: OcrMode[] = [
  "vercel-fast",
  "vercel-balanced-scan",
  "vercel-pass1-wide",
  "vercel-balanced-retry",
  "vercel-balanced",
  "vercel-thorough-retry",
  "vercel-thorough-full",
  "vercel-thorough",
];
const ALL_MODES = new Set<OcrMode>([...LOCAL_MODES, ...VERCEL_MODES]);

export function isVercelRuntime(): boolean {
  return process.env.VERCEL === "1";
}

export function defaultOcrModeForDeploy(): OcrMode {
  return isVercelRuntime() ? "vercel-balanced" : "balanced";
}

/**
 * Normalize OCR mode for the current deploy target.
 * On Vercel: only vercel-* presets (local modes map to closest Vercel equivalent).
 */
export function resolveOcrModeForDeploy(requested: unknown): OcrMode {
  const fallback = defaultOcrModeForDeploy();
  const raw = typeof requested === "string" ? requested.trim() : "";
  if (!raw || !ALL_MODES.has(raw as OcrMode)) return fallback;

  if (isVercelRuntime()) {
    if (raw === "fast" || raw === "balanced") return "vercel-balanced";
    if (raw === "thorough") return "vercel-thorough";
    return raw as OcrMode;
  }

  return raw as OcrMode;
}

export function isVercelOcrMode(mode: OcrMode): boolean {
  return VERCEL_MODES.includes(mode);
}
