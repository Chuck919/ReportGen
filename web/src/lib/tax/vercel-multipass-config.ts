import type { OcrMode } from "@/lib/api/types";
import {
  getMissingAttachmentFieldIds,
  getMissingFieldsForNextTier,
  getMissingPrimaryFieldIds,
} from "@/lib/tax/gap-analysis";
import type { TaxYearValues } from "@/lib/tax-workbook";

/** Gap sets used by benchmark scripts only (production UI is single-pass). */
export type MultipassGapTier = "primary" | "primary+attach" | "all-input";

export type MultipassStopWhen = "primary-complete" | "tier-complete";

export type VercelMultipassPlan = {
  pass1: OcrMode;
  pass2: OcrMode;
  reparse: OcrMode;
  gapTier: MultipassGapTier;
  maxBatches: number;
  batchSize: number;
  forcePhase3: boolean;
  iterateGaps: boolean;
  stopWhen: MultipassStopWhen;
  pass1Label: string;
  pass2Label: (missing: number, batch: number, maxBatches: number) => string;
};

/** Retired for production — kept for benchmark-multipass-matrix.ts experiments. */
export const VERCEL_MULTIPASS: Partial<Record<OcrMode, VercelMultipassPlan>> = {};

export function getVercelMultipassPlan(mode: OcrMode): VercelMultipassPlan | undefined {
  return VERCEL_MULTIPASS[mode];
}

export function gapsForTier(
  column: Pick<TaxYearValues, "values" | "confidence" | "warnings">,
  tier: MultipassGapTier,
): string[] {
  return getMissingFieldsForNextTier(column, tier);
}

export function shouldStopMultipass(
  column: Pick<TaxYearValues, "values" | "confidence" | "warnings">,
  stopWhen: MultipassStopWhen,
): boolean {
  if (stopWhen === "primary-complete") {
    return getMissingPrimaryFieldIds(column).length === 0;
  }
  return (
    getMissingPrimaryFieldIds(column).length === 0 &&
    getMissingAttachmentFieldIds(column).length === 0
  );
}
