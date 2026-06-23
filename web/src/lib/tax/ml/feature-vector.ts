import type { OpexCandidate } from "@/lib/tax-return/opex-candidate-ranking";

export const OPEX_FEATURE_NAMES = [
  "closureScore",
  "evidenceScore",
  "consistencyScore",
  "valid",
  "isDetailSource",
  "isResidualSource",
  "isComparisonSource",
  "flagCount",
  "logValue",
  "valueOverSales",
  "valueOverStmt2",
] as const;

export type OpexFeatureName = (typeof OPEX_FEATURE_NAMES)[number];

export function isDetailSource(source: string): boolean {
  return /summed detail|detail lines|other deductions \(office|office\/supplies|misc detail closes|total minus util/i.test(
    source,
  );
}

export function isResidualSource(source: string): boolean {
  return /residual|comparison.*residual|total minus/i.test(source);
}

export function isComparisonSource(source: string): boolean {
  return /comparison/i.test(source);
}

export function opexCandidateFeatures(
  candidate: Pick<OpexCandidate, "value" | "source" | "closureScore" | "evidenceScore" | "consistencyScore" | "valid" | "plausibilityFlags">,
  ctx?: { sales?: number; stmt2Total?: number },
): number[] {
  const sales = ctx?.sales ?? 0;
  const stmt2 = ctx?.stmt2Total ?? 0;
  const value = candidate.value;
  return [
    candidate.closureScore,
    candidate.evidenceScore,
    candidate.consistencyScore,
    candidate.valid ? 1 : 0,
    isDetailSource(candidate.source) ? 1 : 0,
    isResidualSource(candidate.source) ? 1 : 0,
    isComparisonSource(candidate.source) ? 1 : 0,
    (candidate.plausibilityFlags?.length ?? 0) / 5,
    Math.log1p(Math.max(0, value)) / 16,
    sales > 0 ? Math.min(2, value / sales) : 0,
    stmt2 > 0 ? Math.min(2, value / stmt2) : 0,
  ];
}
