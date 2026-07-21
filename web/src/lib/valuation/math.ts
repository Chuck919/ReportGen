import { computeWorkbookFormulas } from "@/lib/tax/workbook-formulas";
import type { TaxYearValues } from "@/lib/tax-workbook";
import { VALUATION_DEFAULT_ASSUMPTIONS } from "@/lib/valuation/defaults";
import { buildValuationFormulaSteps } from "@/lib/valuation/valuation-formulas";
import type { MarketMultiplesProfile, SourceTag, ValuationAssumptions, ValuationMath, ValuationMethodRow } from "@/lib/valuation/types";

function latestColumn(columns: TaxYearValues[]): TaxYearValues {
  return [...columns].sort((a, b) => a.year - b.year)[columns.length - 1]!;
}

function averageWeighted(values: number[]): number {
  if (!values.length) return 0;
  const weights = values.map((_, index) => index + 1);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  return Math.round(values.reduce((sum, value, index) => sum + value * weights[index]!, 0) / totalWeight);
}

function safeNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function firstDefined(...values: Array<number | undefined>): number | undefined {
  return values.find((value) => typeof value === "number" && Number.isFinite(value));
}

function applyDlom(indicated: number, dlomRate: number): number {
  return Math.round(Math.max(indicated, 0) * (1 - dlomRate));
}

export function buildValuationMath(input: {
  columns: TaxYearValues[];
  market: MarketMultiplesProfile;
  customAssumptions?: Partial<ValuationAssumptions>;
  valuationAssumptions?: Partial<ValuationAssumptions> & {
    preTaxNetIncomeCapRate?: number;
    normalizedEarnings?: number;
    assetIndicatedValue?: number;
    workingCapitalAdjustment?: number;
    capexAdjustment?: number;
    equityWeight?: number;
    costOfDebt?: number;
    taxRate?: number;
    fieldSources?: Record<string, import("@/lib/valuation/assumption-sources").AssumptionFieldSource>;
  };
  /** @deprecated Use valuationAssumptions */
  excelAssumptions?: Partial<ValuationAssumptions> & {
    preTaxNetIncomeCapRate?: number;
    normalizedEarnings?: number;
    assetIndicatedValue?: number;
    workingCapitalAdjustment?: number;
    capexAdjustment?: number;
    equityWeight?: number;
    costOfDebt?: number;
    taxRate?: number;
    fieldSources?: Record<string, import("@/lib/valuation/assumption-sources").AssumptionFieldSource>;
  };
  sourceTags?: SourceTag[];
}): ValuationMath {
  const userAssumptions = input.valuationAssumptions ?? input.excelAssumptions;
  const assumptions: ValuationAssumptions = {
    ...VALUATION_DEFAULT_ASSUMPTIONS,
    ...(userAssumptions ?? {}),
    ...(input.customAssumptions ?? {}),
  };
  const latest = latestColumn(input.columns);
  const latestComputed = computeWorkbookFormulas(latest.workbookValues ?? latest.values);

  const normalizedCandidates = input.columns
    .map((column) => {
      const computed = computeWorkbookFormulas(column.workbookValues ?? column.values);
      return safeNumber(
        firstDefined(
          column.workbookValues?.adjusted_net_profit_before_taxes,
          column.values.adjusted_net_profit_before_taxes,
          column.workbookValues?.net_profit_before_taxes,
          column.values.net_profit_before_taxes,
          computed.adjusted_net_profit_before_taxes,
          computed.net_profit_before_taxes,
        ),
      );
    })
    .filter((value) => value > 0);

  const normalizedEarnings =
    typeof userAssumptions?.normalizedEarnings === "number" && Number.isFinite(userAssumptions.normalizedEarnings)
      ? Math.round(userAssumptions.normalizedEarnings)
      : averageWeighted(normalizedCandidates);

  const capRateFromExcel =
    typeof userAssumptions?.preTaxNetIncomeCapRate === "number" &&
    Number.isFinite(userAssumptions.preTaxNetIncomeCapRate) &&
    userAssumptions.preTaxNetIncomeCapRate > 0
      ? userAssumptions.preTaxNetIncomeCapRate
      : undefined;

  const capRateFromBuildup =
    assumptions.riskFreeRate +
    assumptions.equityRiskPremium +
    assumptions.sizePremium +
    assumptions.companySpecificRisk -
    assumptions.longTermGrowthRate;

  const capitalizationRate = Math.max(capRateFromExcel ?? capRateFromBuildup, 0.06);

  const assetIndicatedRaw =
    userAssumptions?.assetIndicatedValue ??
    (safeNumber(latestComputed.total_equity) ||
      Math.max(safeNumber(latestComputed.total_assets) - safeNumber(latestComputed.total_liabilities), 0));

  // Excel-compatible chain (KCF baseline):
  // - Use pre-tax cap rate as "cost of equity"
  // - Convert to WACC using template defaults (4 weight sheet)
  // - Use a benefit stream net of working capital + capex, then divide by WACC
  // - Apply DLOM to the unrounded indicated value, round at the end
  const equityWeight = userAssumptions?.equityWeight ?? 0.45;
  const costOfDebt = userAssumptions?.costOfDebt ?? 0.095;
  const taxRate = userAssumptions?.taxRate ?? 0.26;
  const workingCapitalAdjustment = userAssumptions?.workingCapitalAdjustment ?? 15_000;
  const capexAdjustment = userAssumptions?.capexAdjustment ?? 10_000;

  const costOfEquity = capitalizationRate;
  const wacc =
    costOfEquity > 0
      ? equityWeight * costOfEquity + (1 - equityWeight) * costOfDebt * (1 - taxRate)
      : undefined;

  const benefitStream = normalizedEarnings - workingCapitalAdjustment - capexAdjustment;
  const incomeIndicatedPrecise =
    wacc !== undefined && wacc > 0
      ? Math.max(benefitStream / wacc, 0)
      : capitalizationRate > 0
        ? Math.max(normalizedEarnings / capitalizationRate, 0)
        : 0;

  const incomeIndicated = Math.round(incomeIndicatedPrecise);
  const incomeAdjusted = applyDlom(incomeIndicatedPrecise, assumptions.dlomRate);
  const assetIndicated = Math.round(Math.max(assetIndicatedRaw, 0));
  const assetAdjusted = applyDlom(assetIndicated, assumptions.dlomRate);

  const marketImplied = input.market.metrics.map((metric) => metric.impliedValue).filter((value) => value > 0);
  const marketIndicated = marketImplied.length
    ? Math.round(marketImplied.reduce((sum, value) => sum + value, 0) / marketImplied.length)
    : undefined;
  const marketAdjusted = marketIndicated !== undefined ? applyDlom(marketIndicated, assumptions.dlomRate) : undefined;

  const methods: ValuationMethodRow[] = [
    {
      method: "asset",
      label: "Adjusted net assets",
      indicatedValue: assetIndicated,
      dlomRate: assumptions.dlomRate,
      adjustedValue: assetAdjusted,
      weight: assumptions.assetWeight,
    },
    {
      method: "income",
      label: "Capitalization of earnings",
      indicatedValue: incomeIndicated,
      dlomRate: assumptions.dlomRate,
      adjustedValue: incomeAdjusted,
      weight: assumptions.incomeWeight,
    },
  ];

  if (marketIndicated !== undefined && marketAdjusted !== undefined) {
    methods.push({
      method: "market",
      label: "Completed transaction / market",
      indicatedValue: marketIndicated,
      dlomRate: assumptions.dlomRate,
      adjustedValue: marketAdjusted,
      weight: assumptions.marketWeight,
    });
  }

  const activeWeight =
    assumptions.incomeWeight +
    assumptions.assetWeight +
    (marketAdjusted !== undefined ? assumptions.marketWeight : 0);

  const weightedSum =
    incomeAdjusted * assumptions.incomeWeight +
    assetAdjusted * assumptions.assetWeight +
    (marketAdjusted ?? 0) * (marketAdjusted !== undefined ? assumptions.marketWeight : 0);

  const reconciledValue = activeWeight > 0 ? Math.round(weightedSum / activeWeight) : incomeAdjusted;
  const tangibleAssetValue = assetAdjusted;
  const intangibleValue = Math.max(reconciledValue - tangibleAssetValue, 0);

  const formulas = buildValuationFormulaSteps({
    assumptions,
    normalizedEarnings,
    capitalizationRate,
    capRateFromBuildup,
    preTaxCapRate: capRateFromExcel,
    workingCapitalAdjustment,
    capexAdjustment,
    equityWeight,
    costOfDebt,
    taxRate,
    wacc,
    benefitStream,
    incomeIndicatedPrecise,
    incomeIndicated,
    incomeAdjusted,
    assetIndicated,
    assetAdjusted,
    marketIndicated,
    marketAdjusted,
    reconciledValue,
    methods,
    fieldSources: userAssumptions?.fieldSources,
  });

  return {
    latestYear: latest.year,
    normalizedEarnings,
    capitalizationRate,
    assetValue: assetAdjusted,
    incomeValue: incomeAdjusted,
    marketValue: marketAdjusted,
    reconciledValue,
    tangibleAssetValue,
    intangibleValue,
    methods,
    assumptions,
    sources: input.sourceTags ?? [],
    formulas,
  };
}
