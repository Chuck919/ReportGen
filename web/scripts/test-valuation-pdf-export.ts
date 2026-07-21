import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildValuationReport } from "@/lib/valuation/report";
import { buildValuationPdf } from "@/lib/valuation/valuation-pdf-export";
import type { MarketMultiplesProfile } from "@/lib/valuation/types";
import type { TaxYearValues } from "@/lib/tax-workbook";

const columns: TaxYearValues[] = [
  {
    year: 2023,
    clientName: "KC Fudge LLC",
    values: { sales: 1_086_475, cogs: 273_131, net_profit_before_taxes: 129_504, total_equity: 5_000 },
    source: "fixture",
  },
  {
    year: 2024,
    clientName: "KC Fudge LLC",
    values: { sales: 1_200_000, cogs: 300_000, net_profit_before_taxes: 222_385, total_equity: 5_000 },
    source: "fixture",
  },
  {
    year: 2025,
    clientName: "KC Fudge LLC",
    values: { sales: 1_150_000, cogs: 290_000, net_profit_before_taxes: 154_442, total_equity: 5_000 },
    source: "fixture",
  },
];

const market: MarketMultiplesProfile = {
  vertical: "specialty-retail",
  bracket: "5m_25m_ev",
  metrics: [{ name: "ev_ebitda", multiple: 5.2, impliedValue: 789_875 }],
  source: { label: "fixture" },
};

const valuationInputs = {
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
};

async function main() {
  const response = await buildValuationReport({
    columns,
    entityName: "KC Fudge LLC",
    purpose: "SBA lending support",
    engagingParty: "OakStar Bank",
    naics: "445292",
    msaLabel: "Louisville/Jefferson County, KY-IN",
    useGroq: false,
    valuationAssumptions: valuationInputs,
  });

  const chartBlocks = response.report.sections.flatMap((s) => s.blocks).filter((b) => b.kind === "chart" || b.kind === "cover");
  if (chartBlocks.length < 2) {
    throw new Error(`Expected charts in report, got ${chartBlocks.length}`);
  }

  const pdf = await buildValuationPdf(response.report);
  if (pdf.length < 20_000) {
    throw new Error(`PDF too small: ${pdf.length} bytes`);
  }
  if (pdf.subarray(0, 4).toString() !== "%PDF") {
    throw new Error("Invalid PDF header");
  }

  const out = join(tmpdir(), "kcf-valuation-export.pdf");
  writeFileSync(out, pdf);
  console.log(`pdf ok (${pdf.length} bytes, ${chartBlocks.length} graphic blocks) → ${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
