import type { ValuationAssumptions } from "@/lib/valuation/types";

/** Valuation template defaults (KCF-class baseline when live data unavailable). */
export const VALUATION_DEFAULT_ASSUMPTIONS: ValuationAssumptions = {
  riskFreeRate: 0.035,
  equityRiskPremium: 0.05,
  sizePremium: 0.0437,
  companySpecificRisk: 0.0937,
  longTermGrowthRate: 0.02,
  dlomRate: 0.1,
  incomeWeight: 1,
  assetWeight: 0,
  marketWeight: 0,
};

/** @deprecated Use VALUATION_DEFAULT_ASSUMPTIONS */
export const BLUE_OWL_DEFAULT_ASSUMPTIONS = VALUATION_DEFAULT_ASSUMPTIONS;

export function buildCapRateFromBuildup(assumptions: ValuationAssumptions): number {
  return Math.max(
    assumptions.riskFreeRate +
      assumptions.equityRiskPremium +
      assumptions.sizePremium +
      assumptions.companySpecificRisk -
      assumptions.longTermGrowthRate,
    0.06,
  );
}

export type { ValuationInputDraft } from "@/lib/valuation/types";

export {
  inferAssetIndicatedValue,
  inferValuationInputs,
  normalizedEarningsForYear,
  recencyWeightedAverage,
} from "@/lib/valuation/infer-assumptions";
