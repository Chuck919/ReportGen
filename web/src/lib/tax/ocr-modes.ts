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
    hint: "~3–4 min",
    detail: "Quickest full pass. Good when the PDF is clean.",
  },
  {
    id: "balanced",
    label: "Balanced",
    hint: "~4–5 min",
    detail: "Default. Best mix of speed and field coverage.",
  },
  {
    id: "thorough",
    label: "Thorough",
    hint: "~6–8 min",
    detail: "Extra hi-DPI on Schedule L and statement attachments.",
  },
];

/** Vercel Hobby — one OCR request per mode (under 5 min). Use Oracle/VPS for local 100% presets. */
export const VERCEL_OCR_MODE_OPTIONS: OcrModeOption[] = [
  {
    id: "vercel-fast",
    label: "Fast",
    hint: "~1 min",
    detail: "14 key pages. Quick preview — verify totals or use Balanced for full coverage.",
  },
  {
    id: "vercel-balanced",
    label: "Balanced",
    hint: "~3–4 min",
    detail: "Full local-Fast pipeline in one request. Default — best speed/accuracy tradeoff.",
  },
  {
    id: "vercel-thorough",
    label: "Thorough",
    hint: "~5–8 min",
    detail:
      "Two API passes: full Balanced scan, then hi-DPI retries on blank fields. Best when Balanced leaves gaps.",
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
