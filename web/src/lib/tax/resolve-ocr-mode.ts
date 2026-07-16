import type { OcrMode } from "@/lib/api/types";

const LOCAL_MODES = new Set<OcrMode>(["fast", "balanced", "thorough"]);

export function defaultOcrModeForDeploy(): OcrMode {
  return "balanced";
}

/**
 * Normalize OCR mode for OVH / local deploy.
 * Unknown or empty values fall back to balanced.
 */
export function resolveOcrModeForDeploy(requested: unknown): OcrMode {
  const fallback = defaultOcrModeForDeploy();
  const raw = typeof requested === "string" ? requested.trim() : "";
  if (!raw || !LOCAL_MODES.has(raw as OcrMode)) return fallback;
  return raw as OcrMode;
}
