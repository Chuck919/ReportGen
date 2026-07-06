import type { FieldTrustTier } from "@/lib/tax/field-trust-tier";
import type { FieldReviewStatus, TaxYearValues } from "@/lib/tax-workbook";

const REVIEW_FLAG =
  /candidate_conflict|source_disagreement|formula.disagreement|formula_inconsistency|ocr_incomplete|verify manually|verify against|residual opex|low.trust|low_trust|ocr label|likely form line|structural|disagree|outside typical range|comparison_missing/i;

export function fieldFlagsNeedReview(flags?: string[]): boolean {
  return Boolean(flags?.some((f) => REVIEW_FLAG.test(f)));
}

export function isFieldMathCorroborated(col: TaxYearValues | undefined, fieldId: string): boolean {
  if (!col) return false;
  const flags = col.fieldFlags?.[fieldId];
  if (
    flags?.some((f) =>
      /formula-disagreement|formula_inconsistency|does not balance|exceeds sales|structural-mismatch/i.test(f),
    )
  ) {
    return false;
  }
  return !flags?.some((f) => /formula/i.test(f));
}

/** Whether an input or formula cell should show review styling before the user verifies it. */
export function inputFieldNeedsReview(args: {
  verified: boolean;
  value: number | null;
  status?: FieldReviewStatus;
  tier: FieldTrustTier;
  displayConfidence?: number;
  fieldFlags?: string[];
  mathCorroborated?: boolean;
}): boolean {
  if (args.verified) return false;
  if (args.mathCorroborated) return false;
  if (args.value == null || args.status === "missing" || args.tier === "empty") return true;
  if (args.status === "review" && !args.mathCorroborated) return true;
  if (
    !args.mathCorroborated &&
    (args.tier === "low" || args.tier === "ocr-only" || args.tier === "math-warning")
  ) {
    return true;
  }
  if (!args.mathCorroborated && args.displayConfidence !== undefined && args.displayConfidence < 55) {
    return true;
  }
  if (args.mathCorroborated) return false;
  return fieldFlagsNeedReview(args.fieldFlags);
}
