import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { loadEnvLocal } from "./lib/load-env-local";
import { buildValuationMath } from "@/lib/valuation/math";
import { buildValuationReport } from "@/lib/valuation/report";
import { exportValuationDocx } from "@/lib/valuation/docx-export";
import { buildWordMergeData, PREMERGE_MERGE_FIELD_NAMES } from "@/lib/valuation/premerge-merge-data";
import { extractLiveChartsFromReport } from "@/lib/valuation/word-chart-appendix";
import type { MarketMultiplesProfile } from "@/lib/valuation/types";
import type { TaxYearValues } from "@/lib/tax-workbook";
import { EMPTY_COMPANY_PROFILE } from "@/lib/valuation/company-profile";
import { countRemainingDataMergeFields } from "@/lib/valuation/word-merge-field-strip";

const repoRoot = join(process.cwd(), "..");
const premergeSrc = join(repoRoot, "Documents", "MAIN CURRENT REPORT premerge.docx");
const reportgenSrc = join(repoRoot, "Documents", "MAIN CURRENT REPORT reportgen.docx");
const reportgenDest = join(process.cwd(), "public", "templates", "main-current-reportgen.docx");

if (!existsSync(reportgenDest)) {
  if (existsSync(reportgenSrc)) {
    mkdirSync(join(process.cwd(), "public", "templates"), { recursive: true });
    copyFileSync(reportgenSrc, reportgenDest);
    console.log("copied reportgen template to public/templates/");
  } else if (existsSync(premergeSrc)) {
    execSync("npm run prepare:reportgen-template", { stdio: "inherit", cwd: process.cwd() });
  }
}

const columns: TaxYearValues[] = [
  {
    year: 2023,
    clientName: "KC Fudge LLC",
    values: {
      sales: 1_086_475,
      cogs: 273_131,
      rent: 49_749,
      salaries_wages: 111_549,
      officer_compensation: 60_000,
      depreciation: 14_203,
      net_profit_before_taxes: 129_504,
      adjusted_net_profit_before_taxes: 129_504,
      cash: 247_928,
      accounts_receivable: 0,
      inventory: 0,
      total_assets: 500_000,
      total_liabilities: 200_000,
      total_equity: 5_000,
      short_term_debt: 50_000,
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
      adjusted_net_profit_before_taxes: 222_385,
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
      adjusted_net_profit_before_taxes: 154_442,
      cash: 260_000,
      total_assets: 510_000,
      total_liabilities: 205_000,
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
  await loadEnvLocal();
  const useGroq = Boolean(process.env.GROQ_API_KEY?.trim());

  const math = buildValuationMath({ columns, market, valuationAssumptions: valuationInputs });
  if (math.reconciledValue < 790_000 || math.reconciledValue > 815_000) {
    throw new Error(`Unexpected reconciled value: ${math.reconciledValue}`);
  }

  const response = await buildValuationReport({
    columns,
    entityName: "KC Fudge LLC",
    purpose: "SBA lending support",
    engagingParty: "Robin Needham, OakStar Bank",
    naics: "445292",
    msaLabel: "Louisville/Jefferson County, KY-IN",
    cbsaCode: "31140",
    useGroq,
    valuationAssumptions: valuationInputs,
    companyProfile: {
      ...EMPTY_COMPANY_PROFILE,
      businessDescription: "KC Fudge LLC manufactures and retails gourmet fudge and confectionery products.",
      ownerName: "Robin Needham",
      entityState: "MO",
      normalizationNotes: "Normalized earnings include add-backs for depreciation, interest, and owner compensation per tax return.",
    },
  });

  const narrativeProvider = response.logs?.find((line) => line.startsWith("Narrative provider:")) ?? "";
  console.log("narrative:", narrativeProvider || "(no provider log)");
  const cacheOnly = process.env.VALUATION_DISK_CACHE_ONLY === "1";
  if (useGroq && !cacheOnly && !narrativeProvider.includes("groq")) {
    throw new Error(`Expected Groq narrative provider, got: ${narrativeProvider || "missing"}`);
  }
  const companyBlock = response.report.sections
    .flatMap((s) => s.blocks)
    .find((b) => b.kind === "paragraph" && b.id === "company-description");
  if (useGroq && !cacheOnly && companyBlock?.kind === "paragraph" && companyBlock.content.length < 80) {
    throw new Error("Groq company description too short");
  }

  const merge = buildWordMergeData({
    report: response.report,
    columns,
    valuationInputs,
    engagement: {
      city: "Overland Park, Kansas 66223",
      title: "VP, Commercial Loan Officer",
      company: "OakStar Bank",
    },
  });

  for (const key of PREMERGE_MERGE_FIELD_NAMES) {
    if (!merge[key]?.trim()) {
      throw new Error(`Missing merge field value: ${key}`);
    }
  }
  if (!merge.reconciled_value.includes("801")) {
    throw new Error(`reconciled_value unexpected: ${merge.reconciled_value}`);
  }
  if (!merge.IS_Rev.includes("Revenues have")) {
    throw new Error(`IS_Rev should be narrative prose, got: ${merge.IS_Rev.slice(0, 80)}`);
  }
  if (!merge.IS_COGS.includes("Industry benchmarks for COGS")) {
    throw new Error(`IS_COGS should be benchmark narrative, got: ${merge.IS_COGS.slice(0, 80)}`);
  }
  if (!merge.IS_NIEBITDA_CY.includes("net income")) {
    throw new Error(`IS_NIEBITDA_CY should be year bullet, got: ${merge.IS_NIEBITDA_CY}`);
  }
  if (!merge.Acct_rec_note?.trim()) {
    throw new Error("Acct_rec_note should be populated by balance-sheet footnote logic");
  }
  if (!merge.assets_?.includes("4,500")) {
    throw new Error(`assets_ tangible should be $4,500 post-DLOM, got: ${merge.assets_}`);
  }
  console.log("merge field map ok — reconciled_value =", merge.reconciled_value, "assets_ =", merge.assets_);

  const charts = extractLiveChartsFromReport(response.report);
  if (charts.length < 12) {
    throw new Error(`Expected 12+ live charts in report, got ${charts.length}`);
  }

  const firm = await exportValuationDocx({
    report: response.report,
    mode: "firm",
    mergeContext: { columns, valuationInputs, engagement: { city: "Overland Park, Kansas" } },
    includeLiveCharts: true,
  });
  if (firm.buffer.length < 400_000) {
    throw new Error(`Firm docx too small: ${firm.buffer.length}`);
  }

  const firmNoCharts = await exportValuationDocx({
    report: response.report,
    mode: "firm",
    mergeContext: { columns, valuationInputs },
    includeLiveCharts: false,
  });
  if (firm.buffer.length <= firmNoCharts.buffer.length) {
    throw new Error("Chart appendix did not increase document size");
  }

  const outPath = join(tmpdir(), "kcf-firm-export.docx");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(outPath, firm.buffer);

  const zipCopy = join(tmpdir(), "kcf-firm-export.zip");
  copyFileSync(outPath, zipCopy);
  const extractDir = join(tmpdir(), "kcf-firm-export-inspect");
  const { execSync } = await import("node:child_process");
  execSync(
    `powershell -NoProfile -Command "if (Test-Path '${extractDir}') { Remove-Item '${extractDir}' -Recurse -Force }; Expand-Archive -Path '${zipCopy}' -DestinationPath '${extractDir}' -Force"`,
    { stdio: "pipe" },
  );
  const mergedXml = readFileSync(join(extractDir, "word", "document.xml"), "utf8");
  const mediaFiles = readdirSync(join(extractDir, "word", "media"));
  const chartPngs = mediaFiles.filter(
    (file) => file.startsWith("chart-live-") || file.startsWith("chart-slot-"),
  );
  if (chartPngs.length < 8) {
    throw new Error(`Expected 8+ injected chart PNGs, got ${chartPngs.length}: ${chartPngs.join(", ")}`);
  }
  const legacyIbis = mediaFiles.filter((f) => /^image\d+\.(png|jpg)$/i.test(f));
  if (legacyIbis.length > 0) {
    throw new Error(`Legacy template images still present: ${legacyIbis.join(", ")}`);
  }
  const hasInlineCharts = mergedXml.includes("chart-slot-") || mergedXml.includes("<w:drawing");
  const hasAppendix = mergedXml.includes("Appendix");
  if (!hasInlineCharts && !hasAppendix) {
    throw new Error("Merged doc missing inline chart graphics or appendix");
  }
  const mergedText = [...mergedXml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");
  if (!mergedText.includes("KC Fudge") && !mergedText.includes("K.C. Fudge")) {
    throw new Error("Merged doc missing entity name");
  }
  if (countRemainingDataMergeFields(mergedXml) > 0) {
    throw new Error("Merged doc still contains data MERGEFIELD tokens — run npm run prepare:reportgen-template");
  }
  if (!/\$?801[, ]?93/.test(mergedText)) {
    throw new Error("Merged doc missing reconciled value near $801,930");
  }
  console.log("firm export contains reconciled value");

  const builtin = await exportValuationDocx({
    report: response.report,
    mode: "builtin",
    mergeContext: { columns, valuationInputs },
  });
  if (builtin.buffer.length < 5_000) throw new Error("builtin docx too small");

  console.log(`firm docx ok (${firm.buffer.length} bytes) → ${outPath}`);
  console.log("valuation premerge export workflow ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
