/**
 * Multi-request OCR helpers for `/api/ocr-plan` and `/api/ocr-pages` (benchmarks, experiments).
 * Production UI uses a single `POST /api/parse-tax-return` per file — not this path.
 */
import type { OcrMode } from "./types";

/** Pages per OCR request batch (benchmark / progressive experiments). */
export const OCR_BATCH_SIZE = 7;

export type OcrPlanResponse = {
  totalPages: number;
  targets: number[];
  batches: number[][];
  batchSize: number;
  ocrMode: string;
  error?: string;
};

export type OcrPagesResponse = {
  text: string;
  confidence: number;
  pages: number;
  pageNumbers: number[];
  ocrMode?: string;
  logs?: string[];
  error?: string;
};

export function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Merge OCR page blocks; later batches overwrite the same page number. */
export function mergeOcrPageTexts(parts: string[]): string {
  const byPage = new Map<number, string>();
  const full = parts.filter(Boolean).join("\n");
  const blocks = full.split(/\n(?=--- OCR PAGE \d+ \([^)]+\) ---\n)/);
  for (const block of blocks) {
    const m = block.match(/^--- OCR PAGE (\d+) \([^)]+\) ---\n([\s\S]*)/);
    if (!m) continue;
    byPage.set(Number(m[1]), m[2]);
  }
  const pages = Array.from(byPage.keys()).sort((a, b) => a - b);
  return pages
    .map((n) => `\n--- OCR PAGE ${n} (full) ---\n${byPage.get(n) ?? ""}`)
    .join("\n");
}

export async function fetchOcrPlan(
  file: File,
  ocrMode: OcrMode,
  opts?: { deltaFrom?: OcrMode; alreadyPages?: number[]; missingFields?: string[] },
): Promise<OcrPlanResponse> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("ocrMode", ocrMode);
  if (opts?.deltaFrom) fd.append("deltaFrom", opts.deltaFrom);
  if (opts?.alreadyPages?.length) fd.append("alreadyPages", opts.alreadyPages.join(","));
  if (opts?.missingFields?.length) fd.append("missingFields", opts.missingFields.join(","));
  const res = await fetch("/api/ocr-plan", { method: "POST", body: fd });
  const json = (await res.json()) as OcrPlanResponse;
  if (!res.ok) throw new Error(json.error || "Could not plan OCR pages.");
  return json;
}

export async function fetchOcrPages(
  file: File,
  ocrMode: OcrMode,
  pages: number[],
  options?: { forcePhase3?: boolean },
): Promise<OcrPagesResponse> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("ocrMode", ocrMode);
  fd.append("pages", pages.join(","));
  if (options?.forcePhase3) fd.append("forcePhase3", "1");
  const res = await fetch("/api/ocr-pages", { method: "POST", body: fd });
  const json = (await res.json()) as OcrPagesResponse;
  if (!res.ok) throw new Error(json.error || "OCR batch failed.");
  return json;
}

export type BatchedOcrProgress = {
  batchIndex: number;
  batchCount: number;
  pages: number[];
  totalTargets: number;
};

export async function runBatchedOcr(
  file: File,
  ocrMode: OcrMode,
  onProgress?: (progress: BatchedOcrProgress) => void,
): Promise<{ text: string; logs: string[]; pageNumbers: number[] }> {
  const plan = await fetchOcrPlan(file, ocrMode);
  const batches = plan.batches.length ? plan.batches : chunkArray(plan.targets, OCR_BATCH_SIZE);
  const texts: string[] = [];
  const logs: string[] = [];
  const pageNumbers: number[] = [];

  for (let i = 0; i < batches.length; i++) {
    const pages = batches[i];
    onProgress?.({
      batchIndex: i,
      batchCount: batches.length,
      pages,
      totalTargets: plan.targets.length,
    });
    const result = await fetchOcrPages(file, ocrMode, pages);
    texts.push(result.text);
    if (result.logs?.length) logs.push(...result.logs);
    pageNumbers.push(...(result.pageNumbers ?? pages));
  }

  return {
    text: mergeOcrPageTexts(texts),
    logs,
    pageNumbers: Array.from(new Set(pageNumbers)).sort((a, b) => a - b),
  };
}
