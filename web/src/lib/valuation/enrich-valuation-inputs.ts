import type { TaxYearValues } from "@/lib/tax-workbook";
import type { AssumptionFieldSource } from "@/lib/valuation/assumption-sources";
import { sourceFor } from "@/lib/valuation/assumption-sources";
import type { ValuationInputDraft } from "@/lib/valuation/types";
import { inferValuationInputs, normalizedEarningsForYear } from "@/lib/valuation/infer-assumptions";
import { fetchLiveCapitalMarketSnapshot } from "@/lib/valuation/live-capital-market";
import { buildCapRateFromBuildup } from "@/lib/valuation/defaults";

/** Merge tax-inferred inputs with live FRED capital-market data (replaces static template defaults). */
export async function enrichValuationInputsFromLiveData(
  columns: TaxYearValues[],
  base?: ValuationInputDraft,
): Promise<ValuationInputDraft> {
  const draft = base ?? inferValuationInputs(columns);
  const live = await fetchLiveCapitalMarketSnapshot();

  const riskFreeRate = live.riskFreeRate;
  const equityRiskPremium = live.equityRiskPremium;
  const longTermGrowthRate =
    typeof draft.longTermGrowthRate === "number" && draft.longTermGrowthRate > 0
      ? draft.longTermGrowthRate
      : Math.min(0.02, Math.max(0.01, riskFreeRate * 0.57));
  const costOfDebt =
    typeof draft.costOfDebt === "number" && draft.costOfDebt > 0 ? draft.costOfDebt : live.costOfDebt;

  const preTaxNetIncomeCapRate =
    typeof draft.preTaxNetIncomeCapRate === "number" &&
    Number.isFinite(draft.preTaxNetIncomeCapRate) &&
    draft.preTaxNetIncomeCapRate > 0
      ? draft.preTaxNetIncomeCapRate
      : Math.max(
          buildCapRateFromBuildup({
            ...draft,
            riskFreeRate,
            equityRiskPremium,
            longTermGrowthRate,
          }),
          0.06,
        );

  const fieldSources: Record<string, AssumptionFieldSource> = {
    ...(draft.fieldSources ?? {}),
    riskFreeRate: sourceFor("fredTreasury10y", {
      detail: live.detail,
    }),
    equityRiskPremium: sourceFor("damodaranErp", {
      detail: `${(equityRiskPremium * 100).toFixed(2)}% U.S. implied ERP (Damodaran reference).`,
    }),
    longTermGrowthRate: sourceFor("fredTreasury10y", {
      detail: `Capped at ${(longTermGrowthRate * 100).toFixed(2)}% from live risk-free.`,
    }),
    costOfDebt: sourceFor("fredTreasury10y", {
      detail: `${(costOfDebt * 100).toFixed(2)}% pretax — treasury + 5.5% credit spread.`,
    }),
    preTaxNetIncomeCapRate: sourceFor("asaBvs", {
      detail:
        draft.preTaxNetIncomeCapRate === preTaxNetIncomeCapRate
          ? `Build-up cap rate ${(preTaxNetIncomeCapRate * 100).toFixed(2)}% (FRED ${live.asOfDate}).`
          : `User cap rate ${(preTaxNetIncomeCapRate * 100).toFixed(2)}% retained; live treasury ${live.asOfDate}.`,
    }),
  };

  return {
    ...draft,
    riskFreeRate,
    equityRiskPremium,
    longTermGrowthRate,
    costOfDebt,
    preTaxNetIncomeCapRate,
    fieldSources,
  };
}

export function latestSde(columns: TaxYearValues[]): number {
  const latest = [...columns].sort((a, b) => a.year - b.year).at(-1);
  if (!latest) return 0;
  return normalizedEarningsForYear(latest);
}
