import type { AssumptionFieldSource } from "@/lib/valuation/assumption-sources";
import type { ValuationAssumptions, ValuationFormulaStep, ValuationMethodRow } from "@/lib/valuation/types";

function pct(rate: number, digits = 2): string {
  return `${(rate * 100).toFixed(digits)}%`;
}

function money(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

export function buildValuationFormulaSteps(input: {
  assumptions: ValuationAssumptions;
  normalizedEarnings: number;
  capitalizationRate: number;
  capRateFromBuildup: number;
  preTaxCapRate?: number;
  workingCapitalAdjustment: number;
  capexAdjustment: number;
  equityWeight: number;
  costOfDebt: number;
  taxRate: number;
  wacc?: number;
  benefitStream: number;
  incomeIndicatedPrecise: number;
  incomeIndicated: number;
  incomeAdjusted: number;
  assetIndicated: number;
  assetAdjusted: number;
  marketIndicated?: number;
  marketAdjusted?: number;
  reconciledValue: number;
  methods: ValuationMethodRow[];
  fieldSources?: Record<string, AssumptionFieldSource>;
}): ValuationFormulaStep[] {
  const src = input.fieldSources ?? {};
  const a = input.assumptions;
  const debtWeight = 1 - input.equityWeight;
  const afterTaxDebt = input.costOfDebt * (1 - input.taxRate);
  const wacc = input.wacc ?? 0;

  const steps: ValuationFormulaStep[] = [
    {
      id: "normalized-earnings",
      label: "Normalized earnings (benefit stream base)",
      expression: "Σ recency_weight × (NPBT + Depreciation + Amortization + Interest)",
      substitution: `Weighted average across tax years = ${money(input.normalizedEarnings)}`,
      result: money(input.normalizedEarnings),
      resultNumeric: input.normalizedEarnings,
      source: src.normalizedEarnings,
    },
    {
      id: "buildup-cap-rate",
      label: "Pre-tax capitalization rate (build-up)",
      expression: "Rf + ERP + Size premium + Company-specific risk − Long-term growth",
      substitution: `${pct(a.riskFreeRate)} + ${pct(a.equityRiskPremium)} + ${pct(a.sizePremium)} + ${pct(a.companySpecificRisk)} − ${pct(a.longTermGrowthRate)}`,
      result: pct(input.capRateFromBuildup, 3),
      resultNumeric: input.capRateFromBuildup,
      source: src.preTaxNetIncomeCapRate ?? src.riskFreeRate,
    },
    {
      id: "cap-rate-floor",
      label: "Capitalization rate (after 6% floor)",
      expression: "max(build-up cap rate, 6%)",
      substitution: input.preTaxCapRate
        ? `Override ${pct(input.preTaxCapRate, 3)} or build-up ${pct(input.capRateFromBuildup, 3)}`
        : `max(${pct(input.capRateFromBuildup, 3)}, 6.00%)`,
      result: pct(input.capitalizationRate, 3),
      resultNumeric: input.capitalizationRate,
      source: src.preTaxNetIncomeCapRate,
    },
    {
      id: "wacc",
      label: "Weighted average cost of capital (WACC)",
      expression: "(Equity% × Cost of equity) + (Debt% × Cost of debt × (1 − Tax rate))",
      substitution: `(${pct(input.equityWeight)} × ${pct(input.capitalizationRate, 3)}) + (${pct(debtWeight)} × ${pct(input.costOfDebt)} × (1 − ${pct(input.taxRate)}))`,
      result: pct(wacc, 3),
      resultNumeric: wacc,
      source: src.equityWeight,
    },
    {
      id: "wc-adjustment",
      label: "Working capital adjustment",
      expression: "max($15,000, 5% × latest sales) or template default",
      substitution: money(input.workingCapitalAdjustment),
      result: `− ${money(input.workingCapitalAdjustment)}`,
      resultNumeric: -input.workingCapitalAdjustment,
      source: src.workingCapitalAdjustment,
    },
    {
      id: "capex-adjustment",
      label: "CAPEX adjustment",
      expression: "max($10,000, avg depreciation, 1.5% × sales)",
      substitution: money(input.capexAdjustment),
      result: `− ${money(input.capexAdjustment)}`,
      resultNumeric: -input.capexAdjustment,
      source: src.capexAdjustment,
    },
    {
      id: "benefit-stream",
      label: "Cash flow to invested capital",
      expression: "Normalized earnings − WC adjustment − CAPEX adjustment",
      substitution: `${money(input.normalizedEarnings)} − ${money(input.workingCapitalAdjustment)} − ${money(input.capexAdjustment)}`,
      result: money(input.benefitStream),
      resultNumeric: input.benefitStream,
      source: src.normalizedEarnings,
    },
    {
      id: "income-indicated",
      label: "Income approach — indicated value",
      expression: "Benefit stream ÷ WACC",
      substitution: wacc > 0 ? `${money(input.benefitStream)} ÷ ${pct(wacc, 3)}` : `${money(input.normalizedEarnings)} ÷ ${pct(input.capitalizationRate, 3)}`,
      result: money(input.incomeIndicated),
      resultNumeric: input.incomeIndicatedPrecise,
      source: src.preTaxNetIncomeCapRate,
    },
    {
      id: "income-dlom",
      label: "Income approach — after DLOM",
      expression: "Indicated value × (1 − DLOM)",
      substitution: `${money(input.incomeIndicatedPrecise)} × (1 − ${pct(a.dlomRate)})`,
      result: money(input.incomeAdjusted),
      resultNumeric: input.incomeAdjusted,
      source: src.dlomRate,
    },
    {
      id: "asset-indicated",
      label: "Asset approach — indicated value",
      expression: "Total equity from balance sheet (or manual override)",
      substitution: money(input.assetIndicated),
      result: money(input.assetIndicated),
      resultNumeric: input.assetIndicated,
      source: src.assetIndicatedValue,
    },
    {
      id: "asset-dlom",
      label: "Asset approach — after DLOM",
      expression: "Indicated value × (1 − DLOM)",
      substitution: `${money(input.assetIndicated)} × (1 − ${pct(a.dlomRate)})`,
      result: money(input.assetAdjusted),
      resultNumeric: input.assetAdjusted,
      source: src.dlomRate,
    },
  ];

  if (input.marketIndicated !== undefined && input.marketAdjusted !== undefined) {
    steps.push(
      {
        id: "market-indicated",
        label: "Market approach — indicated value",
        expression: "Average implied value from transaction multiples",
        substitution: money(input.marketIndicated),
        result: money(input.marketIndicated),
        resultNumeric: input.marketIndicated,
        source: src.marketWeight,
      },
      {
        id: "market-dlom",
        label: "Market approach — after DLOM",
        expression: "Indicated value × (1 − DLOM)",
        substitution: `${money(input.marketIndicated)} × (1 − ${pct(a.dlomRate)})`,
        result: money(input.marketAdjusted),
        resultNumeric: input.marketAdjusted,
        source: src.dlomRate,
      },
    );
  }

  const weightParts = input.methods
    .filter((row) => row.weight > 0)
    .map((row) => `${money(row.adjustedValue)} × ${row.weight.toFixed(2)}`);
  const weightSum = input.methods.reduce((sum, row) => sum + row.adjustedValue * row.weight, 0);
  const activeWeight = input.methods.reduce((sum, row) => sum + (row.weight > 0 ? row.weight : 0), 0);

  steps.push({
    id: "reconciled",
    label: "Reconciled fair market value",
    expression: "Σ (Adjusted value × Method weight) ÷ Σ weights",
    substitution: activeWeight > 0 ? `(${weightParts.join(" + ")}) ÷ ${activeWeight.toFixed(2)}` : weightParts.join(" + "),
    result: money(input.reconciledValue),
    resultNumeric: input.reconciledValue,
    source: src.incomeWeight,
  });

  return steps;
}
