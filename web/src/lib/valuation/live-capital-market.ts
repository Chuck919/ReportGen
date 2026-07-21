import { fredSeries } from "@/lib/valuation/macro-data";
import { VALUATION_DEFAULT_ASSUMPTIONS } from "@/lib/valuation/defaults";

export type LiveCapitalMarketSnapshot = {
  riskFreeRate: number;
  riskFreeSeries: string;
  costOfDebt: number;
  equityRiskPremium: number;
  asOfDate: string;
  detail: string;
};

function latestPoint(series: { points: Array<{ date: string; value: number }> }): { date: string; value: number } | undefined {
  const points = series.points.filter((p) => Number.isFinite(p.value) && p.value > 0);
  return points.at(-1);
}

/** Pull live Treasury yields from FRED (API key or public CSV fallback). */
export async function fetchLiveCapitalMarketSnapshot(): Promise<LiveCapitalMarketSnapshot> {
  const fallbackRf = VALUATION_DEFAULT_ASSUMPTIONS.riskFreeRate;
  const fallbackErp = VALUATION_DEFAULT_ASSUMPTIONS.equityRiskPremium;

  try {
    const [dgs10, dgs20] = await Promise.all([
      fredSeries("DGS10", "10-Year Treasury"),
      fredSeries("DGS20", "20-Year Treasury"),
    ]);
    const spot10 = latestPoint(dgs10);
    const spot20 = latestPoint(dgs20);
    const riskFreePct = spot20?.value ?? spot10?.value;
    if (!riskFreePct || riskFreePct <= 0) throw new Error("No treasury observation");

    const riskFreeRate = riskFreePct / 100;
    const costOfDebt = Math.min(Math.max(riskFreeRate + 0.055, 0.07), 0.14);
    const series = spot20 ? "DGS20" : "DGS10";

    return {
      riskFreeRate,
      riskFreeSeries: series,
      costOfDebt,
      equityRiskPremium: fallbackErp,
      asOfDate: (spot20 ?? spot10)!.date,
      detail: `FRED ${series} ${riskFreePct.toFixed(2)}% as of ${(spot20 ?? spot10)!.date}; cost of debt = treasury + 5.5% spread.`,
    };
  } catch {
    return {
      riskFreeRate: fallbackRf,
      riskFreeSeries: "default",
      costOfDebt: 0.095,
      equityRiskPremium: fallbackErp,
      asOfDate: new Date().toISOString().slice(0, 10),
      detail: "FRED unavailable — using valuation template defaults.",
    };
  }
}
