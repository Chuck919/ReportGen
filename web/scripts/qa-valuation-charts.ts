/**
 * Visual QA for valuation chart SVGs — checks label length, bad values, canvas size.
 * Exports PNG previews for manual review.
 *
 * Usage: npx tsx scripts/qa-valuation-charts.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { loadEnvLocal } from "./lib/load-env-local";
import { buildValuationReport } from "@/lib/valuation/report";
import { extractLiveChartsFromReport } from "@/lib/valuation/word-chart-appendix";
import { qaChartSvg } from "@/lib/valuation/chart-svg-utils";
import { EMPTY_COMPANY_PROFILE } from "@/lib/valuation/company-profile";
import type { TaxYearValues } from "@/lib/tax-workbook";

const outDir = join(process.cwd(), "scripts", "benchmark-output", "chart-qa");
mkdirSync(outDir, { recursive: true });

const columns: TaxYearValues[] = [
  {
    year: 2023,
    clientName: "KC Fudge LLC",
    values: {
      sales: 1_086_475,
      cogs: 273_131,
      rent: 49_749,
      salaries_wages: 111_549,
      net_profit_before_taxes: 129_504,
      cash: 247_928,
      total_assets: 500_000,
      total_liabilities: 200_000,
      total_equity: 5_000,
    },
    source: "fixture",
  },
  {
    year: 2024,
    clientName: "KC Fudge LLC",
    values: {
      sales: 1_200_000,
      cogs: 300_000,
      rent: 52_000,
      net_profit_before_taxes: 222_385,
      cash: 280_000,
      total_assets: 520_000,
      total_liabilities: 210_000,
      total_equity: 5_000,
    },
    source: "fixture",
  },
  {
    year: 2025,
    clientName: "KC Fudge LLC",
    values: {
      sales: 1_150_000,
      cogs: 290_000,
      rent: 50_000,
      net_profit_before_taxes: 154_442,
      cash: 260_000,
      total_assets: 510_000,
      total_liabilities: 205_000,
      total_equity: 5_000,
    },
    source: "fixture",
  },
];

async function main() {
  await loadEnvLocal();
  process.env.VALUATION_DISK_CACHE_ONLY = process.env.VALUATION_DISK_CACHE_ONLY ?? "1";

  const response = await buildValuationReport({
    columns,
    entityName: "K.C. Fudge, Inc.",
    purpose: "SBA lending support",
    engagingParty: "Robin Needham, OakStar Bank",
    naics: "445292",
    msaLabel: "Kansas City, MO-KS MSA",
    cbsaCode: "28140",
    useGroq: false,
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
    },
    companyProfile: {
      ...EMPTY_COMPANY_PROFILE,
      businessDescription: "Specialty food retail and confectionery.",
      entityState: "MO",
    },
  });

  const charts = extractLiveChartsFromReport(response.report);
  const issues = charts.flatMap((chart) => qaChartSvg(chart.id, chart.svg));

  for (const chart of charts) {
    const png = await sharp(Buffer.from(chart.svg)).resize(620, undefined, { fit: "inside" }).png().toBuffer();
    writeFileSync(join(outDir, `${chart.id}.png`), png);
    writeFileSync(join(outDir, `${chart.id}.svg`), chart.svg);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    chartCount: charts.length,
    chartIds: charts.map((c) => c.id),
    errors: issues.filter((i) => i.severity === "error"),
    warnings: issues.filter((i) => i.severity === "warn"),
    outputDir: outDir,
  };
  writeFileSync(join(outDir, "qa-report.json"), JSON.stringify(report, null, 2));

  console.log(`Exported ${charts.length} charts to ${outDir}`);
  console.log(`QA: ${report.errors.length} error(s), ${report.warnings.length} warning(s)`);
  if (report.errors.length) {
    console.error(report.errors);
    process.exit(1);
  }
  if (report.warnings.length) {
    console.warn("Warnings (first 8):", report.warnings.slice(0, 8));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
