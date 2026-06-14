/**
 * Progressive multi-tier OCR — **benchmark / CLI only** (`benchmark-progressive-ocr.ts`).
 * Not used by production UI (`parse-tax-return.ts` is single-pass only).
 */
import type { OcrMode, ParseTaxReturnResponse, ParsedTaxYear } from "./types";
import {
  chunkArray,
  fetchOcrPages,
  mergeOcrPageTexts,
  OCR_BATCH_SIZE,
  type OcrPlanResponse,
} from "./batched-ocr";
import { getMissingFieldsForNextTier } from "@/lib/tax/gap-analysis";

export const PROGRESSIVE_TIERS: Partial<Record<OcrMode, OcrMode[]>> = {
  "vercel-fast": ["vercel-fast"],
  "vercel-balanced": ["vercel-fast", "vercel-balanced"],
  "vercel-thorough": ["vercel-fast", "vercel-balanced", "vercel-thorough"],
};

export function shouldUseProgressiveOcr(): boolean {
  /**
   * Single-pass only in production. Multi-request progressive OCR was benchmarked:
   * - preview + full rescan: same accuracy, ~25% slower
   * - preview + delta pages: 75% accuracy (bad tier-1 text on untouched pages)
   * Page batching across API calls does not reduce total OCR work — only splits the wall clock.
   */
  return false;
}

export type ProgressiveOcrProgress = {
  tierIndex: number;
  tierCount: number;
  tierMode: OcrMode;
  label: string;
  batchIndex?: number;
  batchCount?: number;
  missingFields?: number;
};

async function ocrPageBatch(
  file: File,
  mode: OcrMode,
  pages: number[],
  forcePhase3: boolean,
  onProgress?: (p: ProgressiveOcrProgress) => void,
  tierMeta?: { tierIndex: number; tierCount: number },
): Promise<{ text: string; pageNumbers: number[]; logs: string[] }> {
  const batches = chunkArray(pages, OCR_BATCH_SIZE);
  const texts: string[] = [];
  const logs: string[] = [];
  const pageNumbers: number[] = [];

  for (let i = 0; i < batches.length; i++) {
    onProgress?.({
      tierIndex: tierMeta?.tierIndex ?? 0,
      tierCount: tierMeta?.tierCount ?? 1,
      tierMode: mode,
      label: `OCR ${mode} batch ${i + 1}/${batches.length} (${pages.length} pages)`,
      batchIndex: i,
      batchCount: batches.length,
    });
    const result = await fetchOcrPages(file, mode, batches[i], { forcePhase3 });
    texts.push(result.text);
    if (result.logs?.length) logs.push(...result.logs);
    pageNumbers.push(...(result.pageNumbers ?? batches[i]));
  }

  return {
    text: mergeOcrPageTexts(texts),
    pageNumbers: Array.from(new Set(pageNumbers)).sort((a, b) => a - b),
    logs,
  };
}

async function parseFileWithOcr(
  file: File,
  ocrText: string,
  options: { targetYear?: string; ocrMode: OcrMode },
): Promise<ParsedTaxYear> {
  const fd = new FormData();
  fd.append("files", file);
  if (options.targetYear && /^20\d{2}$/.test(options.targetYear)) {
    fd.append("targetYear", options.targetYear);
  }
  fd.append("ocrMode", options.ocrMode);
  fd.append("ocrText", ocrText);

  const res = await fetch("/api/parse-tax-return", { method: "POST", body: fd });
  const json = (await res.json()) as ParseTaxReturnResponse;
  if (!res.ok) throw new Error(json.error || "Parse failed");
  const row = json.parsed[0];
  if (!row) throw new Error("No parse result returned");
  return row;
}

async function fetchTierPlan(
  file: File,
  tierMode: OcrMode,
  opts?: { deltaFrom?: OcrMode; alreadyPages?: number[]; missingFields?: string[] },
): Promise<OcrPlanResponse> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("ocrMode", tierMode);
  if (opts?.deltaFrom) fd.append("deltaFrom", opts.deltaFrom);
  if (opts?.alreadyPages?.length) fd.append("alreadyPages", opts.alreadyPages.join(","));
  if (opts?.missingFields?.length) fd.append("missingFields", opts.missingFields.join(","));

  const res = await fetch("/api/ocr-plan", { method: "POST", body: fd });
  const json = (await res.json()) as OcrPlanResponse;
  if (!res.ok) throw new Error(json.error || "Could not plan OCR pages.");
  return json;
}

export async function runProgressiveOcrAndParse(
  file: File,
  targetMode: OcrMode,
  options?: { targetYear?: string; onTierParsed?: (parsed: ParsedTaxYear) => void },
  onProgress?: (p: ProgressiveOcrProgress) => void,
): Promise<{ parsed: ParsedTaxYear; ocrText: string; logs: string[]; tiersRun: OcrMode[] }> {
  const tiers = PROGRESSIVE_TIERS[targetMode] ?? [targetMode];
  let ocrText = "";
  let ocrPages: number[] = [];
  const logs: string[] = [];
  const tiersRun: OcrMode[] = [];
  let parsed: ParsedTaxYear | null = null;

  for (let i = 0; i < tiers.length; i++) {
    const tierMode = tiers[i]!;
    const isFirst = i === 0;
    const prevMode = i > 0 ? tiers[i - 1]! : undefined;

    if (!isFirst) {
      const missing = parsed ? getMissingFieldsForNextTier(parsed, tierMode) : [];
      onProgress?.({
        tierIndex: i,
        tierCount: tiers.length,
        tierMode,
        label: missing.length
          ? `${missing.length} fields need ${tierMode} (new pages only)`
          : `Skipping ${tierMode} — primary fields complete`,
        missingFields: missing.length,
      });
      if (!missing.length) break;
    }

    if (isFirst) {
      onProgress?.({
        tierIndex: i,
        tierCount: tiers.length,
        tierMode,
        label: "Fast preview scan",
      });
      const plan = await fetchTierPlan(file, tierMode);
      const preview = await ocrPageBatch(file, tierMode, plan.targets, false, onProgress, {
        tierIndex: i,
        tierCount: tiers.length,
      });
      ocrText = preview.text;
      ocrPages = preview.pageNumbers;
      if (preview.logs.length) logs.push(...preview.logs);
    } else {
      const missing = parsed ? getMissingFieldsForNextTier(parsed, tierMode) : [];
      const plan = await fetchTierPlan(file, tierMode, {
        deltaFrom: prevMode,
        alreadyPages: ocrPages,
        missingFields: missing,
      });

      if (plan.targets.length > 0) {
        onProgress?.({
          tierIndex: i,
          tierCount: tiers.length,
          tierMode,
          label: `Delta OCR: ${plan.targets.length} new/retry pages`,
        });
        const delta = await ocrPageBatch(
          file,
          tierMode,
          plan.targets,
          tierMode !== "vercel-fast",
          onProgress,
          { tierIndex: i, tierCount: tiers.length },
        );
        ocrText = mergeOcrPageTexts([ocrText, delta.text]);
        ocrPages = Array.from(new Set([...ocrPages, ...delta.pageNumbers])).sort((a, b) => a - b);
        if (delta.logs.length) logs.push(...delta.logs);
      }
    }

    tiersRun.push(tierMode);

    parsed = await parseFileWithOcr(file, ocrText, {
      targetYear: options?.targetYear,
      ocrMode: tierMode,
    });

    if (!isFirst && parsed) {
      const stillMissing = getMissingFieldsForNextTier(parsed, tierMode);
      if (stillMissing.length) {
        onProgress?.({
          tierIndex: i,
          tierCount: tiers.length,
          tierMode,
          label: `${stillMissing.length} fields still missing after delta (no full rescan)`,
        });
      }
    }

    options?.onTierParsed?.({ ...parsed, filename: file.name });

    const nextTier = tiers[i + 1];
    if (nextTier && getMissingFieldsForNextTier(parsed, nextTier).length === 0) break;
  }

  if (!parsed) {
    parsed = await parseFileWithOcr(file, ocrText, {
      targetYear: options?.targetYear,
      ocrMode: tiers[0]!,
    });
  }

  return { parsed, ocrText, logs, tiersRun };
}
