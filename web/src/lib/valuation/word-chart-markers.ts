/** Sentinel text embedded via merge fields; replaced with rasterized charts after docxtemplater merge. */
export const CHART_MARKER_PREFIX = "[[CHART:";
export const CHART_MARKER_SUFFIX = "]]";

export function chartMarker(chartId: string): string {
  return `${CHART_MARKER_PREFIX}${chartId}${CHART_MARKER_SUFFIX}`;
}

/**
 * Ordered slots matching premerge.docx image paragraph sequence (23 body + 1 footer).
 * See web/docs/VALUATION_GRAPHIC_REPLACEMENT_MAP.md for original IBIS/static mapping.
 */
export const REPORTGEN_GRAPHIC_SLOT_NAMES = [
  "GRAPHIC_slot_01_cover",
  "GRAPHIC_slot_02_conclusion",
  "GRAPHIC_slot_03_purpose",
  "GRAPHIC_slot_04_national_1",
  "GRAPHIC_slot_05_national_2",
  "GRAPHIC_slot_06_national_3",
  "GRAPHIC_slot_07_national_4",
  "GRAPHIC_slot_08_national_5",
  "GRAPHIC_slot_09_national_6",
  "GRAPHIC_slot_10_national_7",
  "GRAPHIC_slot_11_national_8",
  "GRAPHIC_slot_12_industry_1",
  "GRAPHIC_slot_13_industry_2",
  "GRAPHIC_slot_14_industry_3",
  "GRAPHIC_slot_15_normalized_bs",
  "GRAPHIC_slot_16_normalized_is",
  "GRAPHIC_slot_17_income_method",
  "GRAPHIC_slot_18_buildup_risk",
  "GRAPHIC_slot_19_wacc",
  "GRAPHIC_slot_20_market_dealstats",
  "GRAPHIC_slot_21_market_percentiles",
  "GRAPHIC_slot_22_market_indicated",
  "GRAPHIC_slot_23_reconciliation",
  "GRAPHIC_firm_logo",
] as const;

/** Maps ReportGen template graphic slots → live session chart block ids. */
export const GRAPHIC_SLOT_CHART_MAP: Record<string, string> = {
  GRAPHIC_slot_01_cover: "cover-graphic",
  GRAPHIC_slot_02_conclusion: "firm-logo",
  GRAPHIC_slot_03_purpose: "purpose-summary",
  GRAPHIC_slot_04_national_1: "national-unemployment",
  GRAPHIC_slot_05_national_2: "national-treasury",
  GRAPHIC_slot_06_national_3: "national-cpi",
  GRAPHIC_slot_07_national_4: "national-gdp",
  GRAPHIC_slot_08_national_5: "national-households",
  GRAPHIC_slot_09_national_6: "national-income",
  GRAPHIC_slot_10_national_7: "msa-population",
  GRAPHIC_slot_11_national_8: "msa-unemployment",
  GRAPHIC_slot_12_industry_1: "benchmark-entry-table",
  GRAPHIC_slot_13_industry_2: "benchmark-is-compare",
  GRAPHIC_slot_14_industry_3: "benchmark-bs-compare",
  GRAPHIC_slot_15_normalized_bs: "benchmark-bs-compare",
  GRAPHIC_slot_16_normalized_is: "sales-trend",
  GRAPHIC_slot_17_income_method: "buildup-waterfall",
  GRAPHIC_slot_18_buildup_risk: "benchmark-metrics-compare",
  GRAPHIC_slot_19_wacc: "buildup-waterfall",
  GRAPHIC_slot_20_market_dealstats: "market-multiples-table",
  GRAPHIC_slot_21_market_percentiles: "market-comps-scatter",
  GRAPHIC_slot_22_market_indicated: "market-multiples-table",
  GRAPHIC_slot_23_reconciliation: "reconciliation-summary",
  GRAPHIC_firm_logo: "firm-logo",
  // Legacy aliases (older 14-slot templates)
  GRAPHIC_industry_1: "national-unemployment",
  GRAPHIC_industry_2: "national-treasury",
  GRAPHIC_industry_3: "msa-unemployment",
  GRAPHIC_financial_1: "sales-trend",
  GRAPHIC_financial_2: "npbt-trend",
  GRAPHIC_financial_3: "margin-trend",
  GRAPHIC_financial_4: "sales-npbt-bars",
  CHART_sales_trend: "sales-trend",
  CHART_npbt_trend: "npbt-trend",
  CHART_margin_trend: "margin-trend",
  CHART_sales_npbt_bars: "sales-npbt-bars",
  CHART_national_unemployment: "national-unemployment",
  CHART_national_treasury: "national-treasury",
  CHART_msa_unemployment: "msa-unemployment",
};

export function buildChartMarkerMergeData(availableChartIds: Set<string>): Record<string, string> {
  const data: Record<string, string> = {};
  const allSlots = new Set([...REPORTGEN_GRAPHIC_SLOT_NAMES, ...Object.keys(GRAPHIC_SLOT_CHART_MAP)]);
  for (const slot of allSlots) {
    const chartId = GRAPHIC_SLOT_CHART_MAP[slot];
    data[slot] = chartId && availableChartIds.has(chartId) ? chartMarker(chartId) : "";
  }
  return data;
}
