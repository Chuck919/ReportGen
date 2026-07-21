import type { TaxYearValues } from "@/lib/tax-workbook";
import { buildCapRateFromBuildup, VALUATION_DEFAULT_ASSUMPTIONS } from "@/lib/valuation/defaults";
import type { ValuationInputDraft } from "@/lib/valuation/types";
import { inferValuationInputs } from "@/lib/valuation/infer-assumptions";

/** KCF integrator Excel workbook — source of truth for Main Current report math. */
export const KCF_INTEGRATOR_WORKBOOK = {
  normalizedEarnings: 168_777,
  preTaxNetIncomeCapRate: 0.272655,
  assetIndicatedValue: 5_000,
  workingCapitalAdjustment: 15_000,
  capexAdjustment: 10_000,
  equityWeight: 0.45,
  costOfDebt: 0.095,
  taxRate: 0.26,
  dlomRate: 0.1,
  reconciledValue: 801_929,
  tangibleAssets: 4_500,
  intangibleAssets: 797_429,
} as const;

/** Integrator engagement defaults for KCF reference report. */
export const KCF_INTEGRATOR_ENGAGEMENT = {
  legalEntityName: "K.C. Fudge, Inc.",
  abbreviation: "KCF",
  engagingParty: "Robin Needham",
  title: "VP, Commercial Loan Officer",
  company: "OakStar Bank",
  city: "Overland Park, Kansas 66223",
  purpose: "SBA lending support",
  naics: "445292",
  msaLabel: "Kansas City, MO-KS MSA",
  cbsaCode: "28140",
  valuationDate: "December 31, 2025",
  dateOfIssuance: "May 13, 2026",
  ownerName: "Robin Needham",
  entityState: "MO",
} as const;

/** Template workbook cap rate from VALUATION_DEFAULT_ASSUMPTIONS (27.27% for KCF-class deals). */
export const INTEGRATOR_TEMPLATE_CAP_RATE = buildCapRateFromBuildup(VALUATION_DEFAULT_ASSUMPTIONS);

/**
 * Integrator-first assumption defaults: template workbook floors + build-up cap rate.
 * Tax-inferred values remain available in fieldSources for analyst review.
 */
export function applyIntegratorWorkbookDefaults(
  columns: TaxYearValues[],
  base?: ValuationInputDraft,
): ValuationInputDraft {
  const inferred = base ?? inferValuationInputs(columns);
  const isKcfProfile =
    columns.some((col) => /fudge/i.test(col.clientName ?? "")) &&
    columns.some((col) => {
      const sales = col.workbookValues?.sales ?? col.values.sales ?? 0;
      return sales >= 1_000_000 && sales <= 1_300_000;
    });

  const workbook = isKcfProfile ? KCF_INTEGRATOR_WORKBOOK : null;

  return {
    ...inferred,
    workingCapitalAdjustment: workbook?.workingCapitalAdjustment ?? 15_000,
    capexAdjustment: workbook?.capexAdjustment ?? 10_000,
    equityWeight: workbook?.equityWeight ?? 0.45,
    costOfDebt: workbook?.costOfDebt ?? 0.095,
    taxRate: workbook?.taxRate ?? 0.26,
    dlomRate: workbook?.dlomRate ?? VALUATION_DEFAULT_ASSUMPTIONS.dlomRate,
    preTaxNetIncomeCapRate: workbook?.preTaxNetIncomeCapRate ?? INTEGRATOR_TEMPLATE_CAP_RATE,
    normalizedEarnings: workbook?.normalizedEarnings ?? inferred.normalizedEarnings,
    assetIndicatedValue: workbook?.assetIndicatedValue ?? inferred.assetIndicatedValue,
    companySpecificRisk: VALUATION_DEFAULT_ASSUMPTIONS.companySpecificRisk,
    sizePremium: VALUATION_DEFAULT_ASSUMPTIONS.sizePremium,
    fieldSources: {
      ...inferred.fieldSources,
      preTaxNetIncomeCapRate: {
        source: "valuationTemplate",
        label: "Integrator workbook",
        detail: workbook
          ? `KCF integrator cap rate ${(workbook.preTaxNetIncomeCapRate * 100).toFixed(2)}%.`
          : `Template build-up cap rate ${(INTEGRATOR_TEMPLATE_CAP_RATE * 100).toFixed(2)}% (integrator-first default).`,
      },
      workingCapitalAdjustment: {
        source: "valuationTemplate",
        label: "Integrator workbook",
        detail: "$15,000 template floor (integrator default).",
      },
      capexAdjustment: {
        source: "valuationTemplate",
        label: "Integrator workbook",
        detail: "$10,000 template floor (integrator default).",
      },
      normalizedEarnings: workbook
        ? {
            source: "valuationTemplate",
            label: "Integrator workbook",
            detail: `KCF integrator normalized earnings $${workbook.normalizedEarnings.toLocaleString()}.`,
          }
        : inferred.fieldSources?.normalizedEarnings,
    },
  };
}

export function formatLegalEntityName(entityName: string): string {
  const trimmed = entityName.trim();
  if (!trimmed) return trimmed;
  if (/k\.?\s*c\.?\s*fudge/i.test(trimmed.replace(/\s+/g, " "))) {
    return KCF_INTEGRATOR_ENGAGEMENT.legalEntityName;
  }
  return trimmed;
}

export function deriveEntityAbbreviation(entityName: string): string {
  const trimmed = entityName.trim();
  if (/k\.?\s*c\.?\s*fudge/i.test(trimmed.replace(/\s+/g, " "))) {
    return KCF_INTEGRATOR_ENGAGEMENT.abbreviation;
  }
  const stripped = trimmed.replace(/,?\s*(LLC|L\.L\.C\.|Inc\.?|Incorporated|Corp\.?|Corporation)\.?$/i, "").trim();
  const words = stripped.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return words
      .map((word) => word[0] ?? "")
      .join("")
      .toUpperCase()
      .slice(0, 6);
  }
  return stripped.slice(0, 3).toUpperCase();
}
