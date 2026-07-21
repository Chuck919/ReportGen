import { computeWorkbookFormulas } from "@/lib/tax/workbook-formulas";
import type { TaxYearValues } from "@/lib/tax-workbook";
import type { AssumptionFieldSource } from "@/lib/valuation/assumption-sources";
import { sourceFor } from "@/lib/valuation/assumption-sources";
import { VALUATION_DEFAULT_ASSUMPTIONS } from "@/lib/valuation/defaults";
import type { ValuationInputDraft } from "@/lib/valuation/types";

function firstDefined(...values: Array<number | undefined>): number | undefined {
  return values.find((value) => typeof value === "number" && Number.isFinite(value));
}

function sortedColumns(columns: TaxYearValues[]): TaxYearValues[] {
  return [...columns].sort((a, b) => a.year - b.year);
}

function yearValues(column: TaxYearValues): Record<string, number> {
  return column.workbookValues ?? column.values;
}

/** Recency-weighted average (1, 2, 3, …) — standard in multi-year normalization. */
export function recencyWeightedAverage(values: number[]): number {
  if (!values.length) return 0;
  const weights = values.map((_, index) => index + 1);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  return Math.round(values.reduce((sum, value, index) => sum + value * weights[index]!, 0) / totalWeight);
}

export function normalizedEarningsForYear(column: TaxYearValues): number {
  const raw = yearValues(column);
  const computed = computeWorkbookFormulas(raw);
  const npbt = firstDefined(
    raw.adjusted_net_profit_before_taxes,
    raw.net_profit_before_taxes,
    computed.adjusted_net_profit_before_taxes,
    computed.net_profit_before_taxes,
  );
  if (npbt === undefined) return 0;
  const depreciation = raw.depreciation ?? 0;
  const amortization = raw.amortization ?? 0;
  const interest = raw.interest_expense ?? 0;
  return Math.round(npbt + depreciation + amortization + interest);
}

function latestSales(columns: TaxYearValues[]): number {
  const latest = sortedColumns(columns).at(-1);
  if (!latest) return 0;
  const raw = yearValues(latest);
  return raw.sales ?? 0;
}

function averageDepreciation(columns: TaxYearValues[]): number {
  const amounts = columns
    .map((column) => yearValues(column).depreciation ?? 0)
    .filter((value) => value > 0);
  if (!amounts.length) return 0;
  return Math.round(amounts.reduce((sum, value) => sum + value, 0) / amounts.length);
}

/** Approximate Kroll size deciles by revenue (public guidance + Damodaran size premium tables). */
export function sizePremiumFromRevenue(revenue: number): { rate: number; detail: string } {
  if (revenue <= 0) {
    return { rate: VALUATION_DEFAULT_ASSUMPTIONS.sizePremium, detail: "No sales in tax data — using small-company template default (4.37%)." };
  }
  if (revenue < 500_000) return { rate: 0.055, detail: `Revenue $${revenue.toLocaleString()} → micro-company tier (~5.5% size premium).` };
  if (revenue < 1_000_000) return { rate: 0.049, detail: `Revenue $${revenue.toLocaleString()} → under $1M tier (~4.9%).` };
  if (revenue < 5_000_000) return { rate: 0.0437, detail: `Revenue $${revenue.toLocaleString()} → $1M–$5M tier (4.37%, KCF-class size).` };
  if (revenue < 10_000_000) return { rate: 0.035, detail: `Revenue $${revenue.toLocaleString()} → $5M–$10M tier (~3.5%).` };
  if (revenue < 50_000_000) return { rate: 0.025, detail: `Revenue $${revenue.toLocaleString()} → $10M–$50M tier (~2.5%).` };
  return { rate: 0.015, detail: `Revenue $${revenue.toLocaleString()} → large private tier (~1.5%).` };
}

function marginSeries(columns: TaxYearValues[]): number[] {
  return columns
    .map((column) => {
      const raw = yearValues(column);
      const computed = computeWorkbookFormulas(raw);
      const sales = raw.sales ?? 0;
      const npbt = firstDefined(
        raw.adjusted_net_profit_before_taxes,
        raw.net_profit_before_taxes,
        computed.net_profit_before_taxes,
      );
      if (!sales || npbt === undefined) return undefined;
      return npbt / sales;
    })
    .filter((value): value is number => value !== undefined);
}

function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (Math.abs(mean) < 1e-6) return 1;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / Math.abs(mean);
}

/** Company-specific risk from tax-return ratios (Rev. Ruling 59-60 qualitative factors). */
export function companySpecificRiskFromTax(columns: TaxYearValues[]): { rate: number; detail: string } {
  const latest = sortedColumns(columns).at(-1);
  if (!latest) {
    return { rate: 0.09, detail: "No tax data — template default 9%." };
  }
  const raw = yearValues(latest);
  const computed = computeWorkbookFormulas(latest);
  let rate = 0.06;
  const notes: string[] = ["Base 6% (closely held private company)."];

  const margins = marginSeries(columns);
  const latestMargin = margins.at(-1) ?? 0;
  if (latestMargin < 0.03) {
    rate += 0.02;
    notes.push(`Low net margin (${(latestMargin * 100).toFixed(1)}% of sales) +2%.`);
  }
  if (coefficientOfVariation(margins) > 0.35) {
    rate += 0.02;
    notes.push("Earnings volatility across years +2%.");
  }

  const assets = firstDefined(computed.total_assets, raw.total_assets) ?? 0;
  const liabilities = firstDefined(computed.total_liabilities, raw.total_liabilities) ?? 0;
  if (assets > 0 && liabilities / assets > 0.55) {
    rate += 0.015;
    notes.push(`Leverage ${((liabilities / assets) * 100).toFixed(0)}% of assets +1.5%.`);
  }

  const intangibles = (raw.gross_intangible_assets ?? 0) - (raw.accumulated_amortization ?? 0);
  if (assets > 0 && intangibles / assets > 0.25) {
    rate += 0.01;
    notes.push("Intangible-heavy balance sheet +1%.");
  }

  return { rate: Math.min(Math.max(rate, 0.04), 0.15), detail: notes.join(" ") };
}

/** DLOM from Mandelbaum-style factors inferable from tax data. */
export function dlomFromTax(columns: TaxYearValues[]): { rate: number; detail: string } {
  let rate = 0.12;
  const notes: string[] = ["Starting 12% (private company baseline)."];

  rate -= 0.03;
  notes.push("100% equity / controlling interest −3%.");

  const latest = sortedColumns(columns).at(-1);
  if (latest) {
    const raw = yearValues(latest);
    const computed = computeWorkbookFormulas(latest);
    const assets = firstDefined(computed.total_assets, raw.total_assets) ?? 0;
    const intangibles = Math.max((raw.gross_intangible_assets ?? 0) - (raw.accumulated_amortization ?? 0), 0);
    if (assets > 0 && intangibles / assets > 0.2) {
      rate += 0.03;
      notes.push("Intangibles >20% of assets +3%.");
    }
    const cash = raw.cash ?? 0;
    if (assets > 0 && cash / assets > 0.15) {
      rate -= 0.02;
      notes.push("Liquid balance sheet −2%.");
    }
  }

  const margins = marginSeries(columns);
  if (coefficientOfVariation(margins) > 0.4) {
    rate += 0.02;
    notes.push("Volatile earnings +2%.");
  }

  return { rate: Math.min(Math.max(rate, 0.05), 0.35), detail: notes.join(" ") };
}

export function workingCapitalAdjustmentFromTax(columns: TaxYearValues[]): { amount: number; detail: string } {
  const sales = latestSales(columns);
  const pctBased = sales > 0 ? Math.round(sales * 0.05) : 0;
  const amount = Math.max(15_000, pctBased);
  if (sales > 0) {
    return {
      amount,
      detail: `max($15,000 template floor, 5% × sales $${sales.toLocaleString()} = $${pctBased.toLocaleString()}). Working capital needed to operate.`,
    };
  }
  return { amount: 15_000, detail: "Blue Owl template default $15,000 (no sales in tax data)." };
}

export function capexAdjustmentFromTax(columns: TaxYearValues[]): { amount: number; detail: string } {
  const sales = latestSales(columns);
  const avgDepr = averageDepreciation(columns);
  const pctBased = sales > 0 ? Math.round(sales * 0.015) : 0;
  const amount = Math.max(10_000, avgDepr, pctBased);
  const parts = ["$10,000 template floor"];
  if (avgDepr > 0) parts.push(`avg depreciation $${avgDepr.toLocaleString()}`);
  if (pctBased > 0) parts.push(`1.5% × sales $${pctBased.toLocaleString()}`);
  return { amount, detail: `max(${parts.join(", ")}). CAPEX proxy for ongoing operations.` };
}

export function inferAssetIndicatedValue(columns: TaxYearValues[]): number | undefined {
  const latest = sortedColumns(columns).at(-1);
  if (!latest) return undefined;
  const computed = computeWorkbookFormulas(yearValues(latest));
  const equity = firstDefined(computed.total_equity, latest.values.total_equity);
  if (equity !== undefined && equity > 0) return Math.round(equity);
  const assets = firstDefined(computed.total_assets, latest.values.total_assets);
  const liabilities = firstDefined(computed.total_liabilities, latest.values.total_liabilities);
  if (assets !== undefined && liabilities !== undefined) return Math.round(Math.max(assets - liabilities, 0));
  return undefined;
}

export function inferValuationInputs(columns: TaxYearValues[]): ValuationInputDraft {
  const perYear = columns.map(normalizedEarningsForYear).filter((value) => value > 0);
  const normalizedEarnings = perYear.length ? recencyWeightedAverage(perYear) : 0;

  const revenue = latestSales(columns);
  const sizePremium = sizePremiumFromRevenue(revenue);
  const companyRisk = companySpecificRiskFromTax(columns);
  const dlom = dlomFromTax(columns);
  const wc = workingCapitalAdjustmentFromTax(columns);
  const capex = capexAdjustmentFromTax(columns);
  const assetIndicatedValue = inferAssetIndicatedValue(columns);

  const riskFreeRate = VALUATION_DEFAULT_ASSUMPTIONS.riskFreeRate;
  const equityRiskPremium = 0.05;
  const longTermGrowthRate = Math.min(0.02, Math.max(0.01, riskFreeRate * 0.57));

  const assumptions = {
    riskFreeRate,
    equityRiskPremium,
    sizePremium: sizePremium.rate,
    companySpecificRisk: companyRisk.rate,
    longTermGrowthRate,
    dlomRate: dlom.rate,
    incomeWeight: 1,
    assetWeight: 0,
    marketWeight: 0,
  };

  const preTaxNetIncomeCapRate = Math.max(
    assumptions.riskFreeRate +
      assumptions.equityRiskPremium +
      assumptions.sizePremium +
      assumptions.companySpecificRisk -
      assumptions.longTermGrowthRate,
    0.06,
  );

  const fieldSources: Record<string, AssumptionFieldSource> = {
    normalizedEarnings: sourceFor("taxReturn", {
      detail: perYear.length
        ? `Recency-weighted NPBT + depreciation + amortization + interest across ${perYear.length} year(s): $${normalizedEarnings.toLocaleString()}.`
        : "No positive earnings years in tax data.",
    }),
    assetIndicatedValue: sourceFor("taxReturn", {
      detail: assetIndicatedValue
        ? `Latest balance sheet total equity: $${assetIndicatedValue.toLocaleString()}. Confirm for asset-sale transactions.`
        : "Could not read equity from tax return.",
    }),
    riskFreeRate: sourceFor("fredTreasury10y", {
      detail: `Default ${(riskFreeRate * 100).toFixed(2)}% until live FRED pull on report generation. Build-up starting point.`,
    }),
    equityRiskPremium: sourceFor("damodaranErp", {
      detail: `${(equityRiskPremium * 100).toFixed(2)}% U.S. implied ERP (Damodaran / Stern).`,
    }),
    sizePremium: sourceFor("krollSizePremium", { detail: sizePremium.detail }),
    companySpecificRisk: sourceFor("irs5960", { detail: companyRisk.detail }),
    longTermGrowthRate: sourceFor("fredTreasury10y", {
      detail: `Capped at ${(longTermGrowthRate * 100).toFixed(2)}% (min of 2% and ~57% of risk-free — sustainable growth convention).`,
    }),
    dlomRate: sourceFor("mandelbaumDlom", { detail: dlom.detail }),
    incomeWeight: sourceFor("sbaSop", { detail: "100% income weight — standard for SBA operating company valuations." }),
    assetWeight: sourceFor("sbaSop", { detail: "0% — asset approach shown for reference only." }),
    marketWeight: sourceFor("exitValue", { detail: "0% default; market multiples available as cross-check when ExitValue data loads." }),
    preTaxNetIncomeCapRate: sourceFor("asaBvs", {
      detail: `Build-up: Rf + ERP + size + company-specific − growth = ${(preTaxNetIncomeCapRate * 100).toFixed(2)}%.`,
    }),
    workingCapitalAdjustment: sourceFor("valuationTemplate", { detail: wc.detail }),
    capexAdjustment: sourceFor("valuationTemplate", { detail: capex.detail }),
    equityWeight: sourceFor("valuationTemplate", {
      detail: "45% equity / 55% debt — KCF-class SBA small deal capital structure preset.",
    }),
    costOfDebt: sourceFor("fredTreasury10y", {
      detail: "9.5% pretax cost of debt — template default for small-business LBO/SBA capital structure.",
    }),
    taxRate: sourceFor("valuationTemplate", { detail: "26% marginal tax rate — standard WACC assumption." }),
  };

  return {
    ...assumptions,
    normalizedEarnings,
    preTaxNetIncomeCapRate,
    assetIndicatedValue,
    workingCapitalAdjustment: wc.amount,
    capexAdjustment: capex.amount,
    equityWeight: 0.45,
    costOfDebt: 0.095,
    taxRate: 0.26,
    companyContext: "",
    fieldSources,
  };
}
