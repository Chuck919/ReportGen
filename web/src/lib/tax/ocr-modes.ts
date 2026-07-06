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
    detail: "Quick preview — scans the opening pages only. Use Balanced for a complete workbook.",
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
    detail: "Maximum accuracy on difficult scans. Takes longer.",
  },
];

/** Vercel Hobby — mirrors local tiers (workers=1). */
export const VERCEL_OCR_MODE_OPTIONS: OcrModeOption[] = [
  {
    id: "vercel-fast",
    label: "Fast",
    hint: "",
    detail: "Quick preview — opening pages only. Use Balanced for a complete workbook.",
  },
  {
    id: "vercel-balanced",
    label: "Balanced",
    hint: "",
    detail: "Recommended default for Excel paste.",
  },
  {
    id: "vercel-thorough",
    label: "Thorough",
    hint: "",
    detail: "Maximum accuracy. Takes longer.",
  },
];

export function isVercelDeploy(): boolean {
  return process.env.NEXT_PUBLIC_VERCEL === "1";
}

export function getOcrModeOptions(): OcrModeOption[] {
  return isVercelDeploy() ? VERCEL_OCR_MODE_OPTIONS : LOCAL_OCR_MODE_OPTIONS;
}

export function defaultOcrMode(): OcrMode {
  return defaultOcrModeForDeploy();
}

/** Wall-clock estimate per PDF — progress bar reaches ~95% at this duration. */
export function estimateOcrDurationMs(mode: OcrMode, fileCount = 1): number {
  const perFile =
    mode === "fast" || mode === "vercel-fast"
      ? 90_000
      : mode === "thorough" || mode === "vercel-thorough"
        ? 8 * 60_000
        : 5 * 60_000;
  return perFile * Math.max(fileCount, 1);
}

/** Progress bar caps at this fraction until the server responds. */
export const OCR_PROGRESS_CAP = 0.95;
