import { buildValuationMath } from "@/lib/valuation/math";
import type { MarketMultiplesProfile } from "@/lib/valuation/types";
import type { TaxYearValues } from "@/lib/tax-workbook";

function assertClose(actual: number | undefined, expected: number, tolerance: number, label: string) {
  if (actual === undefined || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

const columns: TaxYearValues[] = [
  {
    year: 2023,
    values: {
      net_profit_before_taxes: 129_504,
      adjusted_net_profit_before_taxes: 129_504,
      total_equity: 5_000,
    },
    source: "fixture",
  },
  {
    year: 2024,
    values: {
      net_profit_before_taxes: 222_385,
      adjusted_net_profit_before_taxes: 222_385,
      total_equity: 5_000,
    },
    source: "fixture",
  },
  {
    year: 2025,
    values: {
      net_profit_before_taxes: 154_442,
      adjusted_net_profit_before_taxes: 154_442,
      total_equity: 5_000,
    },
    source: "fixture",
  },
];

const market: MarketMultiplesProfile = {
  vertical: "specialty-retail",
  bracket: "5m_25m_ev",
  metrics: [{ name: "ev_ebitda", multiple: 5.2, impliedValue: 789_875 }],
  source: { label: "fixture" },
};

// KCF-class WACC chain: weighted norm income ~168777, WC+CAPEX 25k, cap rate ~27.27%
const math = buildValuationMath({
  columns,
  market,
  valuationAssumptions: {
    normalizedEarnings: 168_777,
    preTaxNetIncomeCapRate: 0.272655,
    assetIndicatedValue: 5_000,
    workingCapitalAdjustment: 15_000,
    capexAdjustment: 10_000,
    equityWeight: 0.45,
    costOfDebt: 0.095,
    taxRate: 0.26,
    dlomRate: 0.1,
    incomeWeight: 1,
    assetWeight: 0,
    marketWeight: 0,
  },
});

assertClose(math.assetValue, 4_500, 1, "asset value");
assertClose(math.incomeValue, 801_929, 2_500, "income value");
assertClose(math.reconciledValue, 801_929, 2_500, "reconciled value");

console.log("valuation math ok");
