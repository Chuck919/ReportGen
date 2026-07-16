import type { OcrMode } from "@/lib/api/types";
import { defaultOcrModeForDeploy } from "@/lib/tax/resolve-ocr-mode";

export type OcrModeOption = {
  id: OcrMode;
  label: string;
  hint: string;
  detail: string;
};

export const LOCAL_OCR_MODE_OPTIONS: OcrModeOption[] = [
  {
    id: "fast",
    label: "Fast",
    hint: "",
    detail: "Quick preview — opening pages only. Numbers may be incomplete; use Balanced for Excel paste.",
  },
  {
    id: "balanced",
    label: "Balanced",
    hint: "",
    detail: "Recommended. Full extraction for Excel paste.",
  },
  {
    id: "thorough",
    label: "Thorough",
    hint: "",
    detail: "Maximum accuracy on difficult scans — balanced pass plus hi-DPI on weak pages.",
  },
];

export function getOcrModeOptions(): OcrModeOption[] {
  return LOCAL_OCR_MODE_OPTIONS;
}

export function defaultOcrMode(): OcrMode {
  return defaultOcrModeForDeploy();
}

/** Wall-clock estimate per PDF — progress bar reaches ~95% at this duration. */
export function estimateOcrDurationMs(mode: OcrMode, fileCount = 1): number {
  // Typical corporate return (≈40–80 pages). Very large packs (100+ pages) run longer.
  const perFile =
    mode === "fast" ? 2.5 * 60_000 : mode === "thorough" ? 8.5 * 60_000 : 5.5 * 60_000;
  return perFile * Math.max(fileCount, 1);
}

/** Progress bar caps at this fraction until the server responds. */
export const OCR_PROGRESS_CAP = 0.95;
