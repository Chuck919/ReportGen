import type { TaxYearValues } from "@/lib/tax-workbook";
import {
  isAuthoritativeSource,
  isResidualOpexSource,
  isSuspiciousTaxValue,
  isWeakSource,
} from "@/lib/tax-return/confidence-gates";
import { classifySourceFamily } from "./source-agreement";

export type FieldTrustTier =
  | "empty"
  | "math-warning"
  | "ocr-only"
  | "low"
  | "moderate"
  | "single-good"
  | "comparison"
  | "authoritative"
  | "multi-source"
  | "user-confirmed";

export type TrustTierMeta = {
  tier: FieldTrustTier;
  label: string;
  description: string;
  cellClass: string;
  swatchClass: string;
};

export const TRUST_TIER_LEGEND: TrustTierMeta[] = [
  {
    tier: "user-confirmed",
    label: "User confirmed",
    description: "Corrected or confirmed by you",
    cellClass: "bg-indigo-200 text-indigo-950 ring-1 ring-inset ring-indigo-300",
    swatchClass: "bg-indigo-500",
  },
  {
    tier: "multi-source",
    label: "Multi-source",
    description: "2+ independent reads agree",
    cellClass: "bg-emerald-200 text-emerald-950",
    swatchClass: "bg-emerald-500",
  },
  {
    tier: "authoritative",
    label: "Form / Schedule L",
    description: "High-trust form or schedule line",
    cellClass: "bg-green-200 text-green-950",
    swatchClass: "bg-green-500",
  },
  {
    tier: "comparison",
    label: "Comparison sheet",
    description: "Two-year comparison worksheet",
    cellClass: "bg-teal-200 text-teal-950",
    swatchClass: "bg-teal-500",
  },
  {
    tier: "single-good",
    label: "Single source (OK)",
    description: "One trusted source, good confidence",
    cellClass: "bg-sky-200 text-sky-950",
    swatchClass: "bg-sky-500",
  },
  {
    tier: "moderate",
    label: "Moderate",
    description: "Extracted but not fully corroborated",
    cellClass: "bg-amber-200 text-amber-950",
    swatchClass: "bg-amber-400",
  },
  {
    tier: "low",
    label: "Low confidence",
    description: "Parser confidence below 65%",
    cellClass: "bg-orange-200 text-orange-950",
    swatchClass: "bg-orange-500",
  },
  {
    tier: "ocr-only",
    label: "OCR only",
    description: "Label match with no form anchor",
    cellClass: "bg-rose-200 text-rose-950",
    swatchClass: "bg-rose-500",
  },
  {
    tier: "math-warning",
    label: "Math warning",
    description: "Fails reconciliation check",
    cellClass: "bg-red-200 text-red-950 ring-1 ring-inset ring-red-300",
    swatchClass: "bg-red-600",
  },
  {
    tier: "empty",
    label: "Not extracted",
    description: "No value found",
    cellClass: "bg-stone-100 text-stone-400",
    swatchClass: "bg-stone-300",
  },
];

const TIER_META = new Map(TRUST_TIER_LEGEND.map((item) => [item.tier, item]));

const HARD_FLAG =
  /exceeds sales|does not balance|structural-mismatch|formula-disagreement|high-confidence-no-closure/i;

export function hasHardFieldFlag(flags?: string[]): boolean {
  return (flags ?? []).some((f) => HARD_FLAG.test(f));
}

function isComparisonSource(source?: string): boolean {
  return /comparison/i.test(source ?? "");
}

function isTrustedSingleSource(source: string | undefined, parserConf: number): boolean {
  if (isAuthoritativeSource(source)) return parserConf >= 65;
  if (isComparisonSource(source) && parserConf >= 84) return true;
  if (/structured financial/i.test(source ?? "")) return true;
  if (/^Operating expenses \(top-8/i.test(source ?? "") && parserConf >= 70) return true;
  if (/^Coherence:/i.test(source ?? "") && parserConf >= 80) return true;
  return false;
}

export type TrustTierInput = {
  fieldId?: string;
  value: number | undefined;
  source?: string;
  parserConfidence?: number;
  displayConfidence?: number;
  agreement?: number;
  flags?: string[];
  taxYear?: number;
};

/** Assign a visual trust tier for table coloring and copy gating. */
export function resolveFieldTrustTier(input: TrustTierInput): FieldTrustTier {
  if (input.value === undefined) return "empty";
  if (/^user correction|user confirmed|user selected/i.test(input.source ?? "")) return "user-confirmed";

  const flags = input.flags ?? [];
  const agreement = input.agreement ?? 0;
  const parserConf = input.parserConfidence ?? 70;
  const trust = input.displayConfidence ?? parserConf;
  const source = input.source;

  if (hasHardFieldFlag(flags)) return "math-warning";
  if (flags.some((f) => /formula-disagreement|structural-mismatch|Subtractive formula/i.test(f))) {
    return "math-warning";
  }
  if (flags.some((f) => /Other reads|Sources disagree/i.test(f))) return "moderate";

  const value = input.value;
  if (
    input.fieldId &&
    isSuspiciousTaxValue(input.fieldId, value, source, input.taxYear)
  ) {
    return value !== 0 && Math.abs(value) <= 99 ? "low" : "moderate";
  }

  if (flags.some((f) => /verify manually|verify against|inferred from|residual/i.test(f))) {
    return parserConf >= 80 ? "moderate" : "low";
  }

  if (isResidualOpexSource(source) || /verify|residual|post-verification|inferred/i.test(source ?? "")) {
    // Keep residual other_opex out of trusted-green tiers so $2–$4 crumb misses are not
    // "green dangers"; correct residuals may still show amber until stmt footers are exact.
    return trust >= 80 ? "moderate" : "low";
  }

  // Categorized Stmt-2 line fills (repairs/insurance/etc.) — intentional, not low-trust OCR.
  if (/^Operating expenses \(/i.test(source ?? "") && parserConf >= 70) {
    return trust >= 75 ? "single-good" : "moderate";
  }

  const family = classifySourceFamily(source);

  if (agreement >= 2) return "multi-source";
  if (family === "ocr" || isWeakSource(source)) return "ocr-only";
  if (parserConf < 65) return "low";

  if (isAuthoritativeSource(source)) {
    return trust >= 80 ? "authoritative" : "single-good";
  }
  if (/closes\s+stmt|detail\s+sum|summed\s+detail|misc\s+detail/i.test(source ?? "") && parserConf >= 85) {
    return "single-good";
  }
  if (isComparisonSource(source) && isTrustedSingleSource(source, parserConf)) return "comparison";
  if (isTrustedSingleSource(source, parserConf)) {
    return trust >= 70 ? "single-good" : "moderate";
  }

  return "moderate";
}

export function resolveTrustTierFromColumn(col: TaxYearValues | undefined, rowId: string): FieldTrustTier {
  if (!col) return "empty";
  return resolveFieldTrustTier({
    fieldId: rowId,
    value: col.values[rowId],
    source: col.fieldSources?.[rowId],
    parserConfidence: col.confidence?.[rowId],
    displayConfidence: col.displayConfidence?.[rowId],
    agreement: col.sourceAgreement?.[rowId],
    flags: col.fieldFlags?.[rowId],
    taxYear: col.year,
  });
}

export function trustTierCellClass(tier: FieldTrustTier): string {
  return TIER_META.get(tier)?.cellClass ?? "";
}

export function isTierSafeForConfirmedCopy(tier: FieldTrustTier): boolean {
  return (
    tier === "multi-source" ||
    tier === "authoritative" ||
    tier === "comparison" ||
    tier === "single-good" ||
    tier === "user-confirmed"
  );
}

export function buildFieldTrustTiers(col: TaxYearValues, rowIds: string[]): Record<string, FieldTrustTier> {
  const out: Record<string, FieldTrustTier> = {};
  for (const id of rowIds) {
    out[id] = resolveTrustTierFromColumn(col, id);
  }
  return out;
}
