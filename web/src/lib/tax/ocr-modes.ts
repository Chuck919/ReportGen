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
    hint: "~2 min",
    detail: "14-page preview — quick sanity check, not for full Excel paste.",
  },
  {
    id: "balanced",
    label: "Balanced",
    hint: "~4 min",
    detail: "Default. 26 pages + selective hi-DPI. Target 100% primary for Excel paste.",
  },
  {
    id: "thorough",
    label: "Thorough",
    hint: "~6–8 min",
    detail: "Two balanced passes merged per page. Maximum reliability on hard scans (local/VPS).",
  },
];

/** Vercel Hobby — mirrors local tiers (workers=1). */
export const VERCEL_OCR_MODE_OPTIONS: OcrModeOption[] = [
  {
    id: "vercel-fast",
    label: "Fast",
    hint: "~2 min",
    detail: "Same as local Fast — 14 pages, preview only.",
  },
  {
    id: "vercel-balanced",
    label: "Balanced",
    hint: "~4 min",
    detail: "Same as local Balanced — 26 pages + selective hi-DPI. Default for Excel paste.",
  },
  {
    id: "vercel-thorough",
    label: "Thorough",
    hint: "~5 min",
    detail: "Same as local Thorough — full hi-DPI when Balanced misses fields.",
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
