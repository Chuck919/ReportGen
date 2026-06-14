import type { OcrMode } from "@/lib/api/types";
import { mergeOcrPageTexts, chunkArray, OCR_BATCH_SIZE } from "@/lib/api/batched-ocr";
import { getMissingFieldsForNextTier } from "@/lib/tax/gap-analysis";
import { parseTaxReturnFromText } from "@/lib/tax-return/parse-from-text";
import { runLocalOcrPages, runOcrPlan } from "@/lib/tax-return/local-ocr";
import type { TaxYearValues } from "@/lib/tax-workbook";

export const PROGRESSIVE_TIERS: Partial<Record<OcrMode, OcrMode[]>> = {
  "vercel-fast": ["vercel-fast"],
  "vercel-balanced": ["vercel-fast", "vercel-balanced"],
  "vercel-thorough": ["vercel-fast", "vercel-balanced", "vercel-thorough"],
};

export type ProgressiveTierResult = {
  tierMode: OcrMode;
  ms: number;
  pages: number[];
  missingAfter: number;
  skipped?: boolean;
  deltaOnly?: boolean;
};

export type ProgressiveOcrResult = {
  ocrText: string;
  ocrPages: number[];
  tiersRun: OcrMode[];
  tierResults: ProgressiveTierResult[];
  parsed: TaxYearValues;
  totalMs: number;
};

async function ocrPageBatch(
  bytes: Uint8Array,
  mode: OcrMode,
  pages: number[],
  forcePhase3: boolean,
): Promise<{ text: string; pageNumbers: number[]; ms: number }> {
  if (!pages.length) return { text: "", pageNumbers: [], ms: 0 };
  const batches = chunkArray(pages, OCR_BATCH_SIZE);
  const texts: string[] = [];
  const pageNumbers: number[] = [];
  let ms = 0;

  for (const batch of batches) {
    const t0 = Date.now();
    const result = await runLocalOcrPages(bytes, batch, {
      profile: "tax",
      mode,
      forcePhase3,
    });
    ms += Date.now() - t0;
    texts.push(result.text);
    pageNumbers.push(...(result.pageNumbers ?? batch));
  }

  return {
    text: mergeOcrPageTexts(texts),
    pageNumbers: Array.from(new Set(pageNumbers)).sort((a, b) => a - b),
    ms,
  };
}

/**
 * Tier 1 = fast preview. Tier 2+ = delta pages only (merge; never full-document rescan).
 */
export async function runProgressiveOcrLocal(
  bytes: Uint8Array,
  filename: string,
  embeddedText: string,
  targetMode: OcrMode,
  year?: number,
): Promise<ProgressiveOcrResult> {
  const tiers = PROGRESSIVE_TIERS[targetMode] ?? [targetMode];
  let ocrText = "";
  let ocrPages: number[] = [];
  const tiersRun: OcrMode[] = [];
  const tierResults: ProgressiveTierResult[] = [];
  let parsed: TaxYearValues | null = null;
  const totalT0 = Date.now();

  for (let i = 0; i < tiers.length; i++) {
    const tierMode = tiers[i]!;
    const isFirst = i === 0;
    const prevMode = i > 0 ? tiers[i - 1]! : undefined;

    if (!isFirst) {
      const missing = parsed ? getMissingFieldsForNextTier(parsed, tierMode) : [];
      if (!missing.length) {
        tierResults.push({ tierMode, ms: 0, pages: [], missingAfter: 0, skipped: true });
        break;
      }
    }

    let tierMs = 0;
    let tierPages: number[] = [];

    if (isFirst) {
      const plan = await runOcrPlan(bytes, tierMode);
      const preview = await ocrPageBatch(bytes, tierMode, plan.targets, false);
      ocrText = preview.text;
      ocrPages = preview.pageNumbers;
      tierMs = preview.ms;
      tierPages = preview.pageNumbers;
    } else {
      let prevMissing = parsed ? getMissingFieldsForNextTier(parsed, tierMode) : [];
      /** Up to 2 delta batches per tier — new pages + targeted re-OCR only. */
      for (let pass = 0; pass < 2 && prevMissing.length > 0; pass++) {
        const plan = await runOcrPlan(bytes, tierMode, {
          deltaFrom: prevMode,
          alreadyPages: ocrPages,
          missingFields: prevMissing,
        });
        if (!plan.targets.length) break;

        const usePhase3 = tierMode !== "vercel-fast";
        const delta = await ocrPageBatch(bytes, tierMode, plan.targets, usePhase3);
        tierMs += delta.ms;
        tierPages = Array.from(new Set([...tierPages, ...plan.targets])).sort((a, b) => a - b);
        ocrText = mergeOcrPageTexts([ocrText, delta.text]);
        ocrPages = Array.from(new Set([...ocrPages, ...delta.pageNumbers])).sort((a, b) => a - b);

        parsed = parseTaxReturnFromText(filename, embeddedText, ocrText, year);
        const nextMissing = getMissingFieldsForNextTier(parsed, tierMode);
        if (nextMissing.length >= prevMissing.length) break;
        prevMissing = nextMissing;
      }
    }

    tiersRun.push(tierMode);
    parsed = parseTaxReturnFromText(filename, embeddedText, ocrText, year);
    const nextTier = tiers[i + 1];
    const missingAfter = nextTier ? getMissingFieldsForNextTier(parsed, nextTier).length : 0;

    tierResults.push({
      tierMode,
      ms: tierMs,
      pages: tierPages,
      missingAfter,
      deltaOnly: !isFirst,
    });

    if (!isFirst && missingAfter === 0) break;
  }

  if (!parsed) {
    parsed = parseTaxReturnFromText(filename, embeddedText, ocrText, year);
  }

  return {
    ocrText,
    ocrPages,
    tiersRun,
    tierResults,
    parsed,
    totalMs: Date.now() - totalT0,
  };
}
