/**
 * Deep compare integrator KCF valuation.docx vs ReportGen firm export.
 * Usage: cd web && npx tsx scripts/compare-kcf-reports.ts
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { loadEnvLocal } from "./lib/load-env-local";
import { buildValuationMath } from "@/lib/valuation/math";
import { buildValuationReport } from "@/lib/valuation/report";
import { exportValuationDocx } from "@/lib/valuation/docx-export";
import { buildWordMergeData } from "@/lib/valuation/premerge-merge-data";
import { EMPTY_COMPANY_PROFILE } from "@/lib/valuation/company-profile";
import { applyIntegratorWorkbookDefaults, KCF_INTEGRATOR_ENGAGEMENT } from "@/lib/valuation/integrator-workbook";
import type { MarketMultiplesProfile } from "@/lib/valuation/types";
import type { TaxYearValues } from "@/lib/tax-workbook";

const repoRoot = join(process.cwd(), "..");
const integratorPath = join(repoRoot, "Documents", "KCF valuation.docx");
const outDir = join(process.cwd(), "scripts", "benchmark-output");

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
  source: { label: "ExitValue fixture" },
};

const valuationInputs = applyIntegratorWorkbookDefaults(columns, {
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
  companyContext: "",
  fieldSources: {},
});

function extractDocx(path: string, label: string) {
  const zip = join(tmpdir(), `compare-${label}.zip`);
  const dir = join(tmpdir(), `compare-${label}-unpack`);
  copyFileSync(path, zip);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  execSync(
    `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}' -Force"`,
    { stdio: "pipe" },
  );
  const xml = readFileSync(join(dir, "word", "document.xml"), "utf8");
  const text = xml
    .replace(/<w:tab[^/]*\/>/g, "\t")
    .replace(/<w:br[^/]*\/>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n");
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 2);
  const mediaDir = join(dir, "word", "media");
  const images = existsSync(mediaDir) ? readdirSync(mediaDir) : [];
  const mergeFields = [...new Set([...xml.matchAll(/MERGEFIELD\s+(\w+)/gi)].map((m) => m[1]!))].sort();
  const placeholders = [...new Set([...xml.matchAll(/«([^»]+)»/g)].map((m) => m[1]!))].sort();
  const dollarAmounts = [...new Set(
    [...text.matchAll(/\$[\d,]+(?:\.\d{2})?/g)].map((m) => m[0]!),
  )].slice(0, 40);
  const sectionHeadings = lines.filter((l) =>
    /^(I{1,3}V?|VI{0,3}|IX|X{0,3}|XI{0,3})\.\s|TABLE OF CONTENTS|VALUATION SUMMARY|APPENDIX|RECONCILIATION/i.test(l) &&
    l.length < 120,
  );
  return {
    label,
    path,
    textChars: text.length,
    lineCount: lines.length,
    tables: (xml.match(/<w:tbl/g) ?? []).length,
    drawings: (xml.match(/<w:drawing/g) ?? []).length,
    images: images.length,
    imageNames: images,
    mergeFields,
    placeholders,
    sectionHeadings,
    dollarAmounts,
    sampleProse: lines.filter((l) => l.length > 80 && l.length < 500).slice(0, 8),
    fullTextSample: text.slice(0, 4000),
  };
}

function findAmounts(text: string): Record<string, number | null> {
  const pick = (re: RegExp) => {
    const m = text.match(re);
    if (!m?.[1]) return null;
    return Number(m[1].replace(/,/g, ""));
  };
  return {
    reconciled: pick(/\$?\s*([\d,]+)\s*(?:reconciled|indicated|fair market)/i) ?? pick(/801,?929/),
    income: pick(/income[^$]{0,40}\$?\s*([\d,]+)/i),
    capRate: pick(/cap(?:italization)?\s*rate[^%]{0,30}(\d+\.?\d*)\s*%/i),
    wacc: pick(/WACC[^%]{0,30}(\d+\.?\d*)\s*%/i),
    normalized: pick(/normaliz[^$]{0,40}\$?\s*([\d,]+)/i),
  };
}

async function main() {
  await loadEnvLocal();
  if (!existsSync(integratorPath)) throw new Error(`Missing ${integratorPath}`);

  const response = await buildValuationReport({
    columns,
    entityName: KCF_INTEGRATOR_ENGAGEMENT.legalEntityName,
    purpose: "SBA lending support",
    engagingParty: "Robin Needham, OakStar Bank",
    naics: "445292",
    msaLabel: "Kansas City, MO-KS MSA",
    cbsaCode: "28140",
    dateOfIssuance: "2026-05-13",
    useGroq: Boolean(process.env.GROQ_API_KEY),
    valuationAssumptions: valuationInputs,
    companyProfile: {
      ...EMPTY_COMPANY_PROFILE,
      businessDescription: "KC Fudge LLC manufactures and retails gourmet fudge products.",
      ownerName: "Robin Needham",
      entityState: "MO",
    },
  });

  const merge = buildWordMergeData({
    report: response.report,
    columns,
    valuationInputs,
    engagement: { city: "Overland Park, Kansas", title: "VP, Commercial Loan Officer", company: "OakStar Bank" },
  });

  const { buffer } = await exportValuationDocx({
    report: response.report,
    mode: "firm",
    mergeContext: {
      columns,
      valuationInputs,
      engagement: {
        city: "Overland Park, Kansas 66223",
        title: "VP, Commercial Loan Officer",
        company: "OakStar Bank",
        owner: "Robin Needham",
        companyProfile: {
          ...EMPTY_COMPANY_PROFILE,
          ownerName: "Robin Needham",
          entityState: "MO",
        },
      },
    },
    includeLiveCharts: true,
  });

  const generatedPath = join(outDir, "kcf-reportgen-compare.docx");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(generatedPath, buffer);

  const integrator = extractDocx(integratorPath, "integrator");
  const generated = extractDocx(generatedPath, "reportgen");

  const math = buildValuationMath({ columns, market, valuationAssumptions: valuationInputs });

  const report = {
    comparedAt: new Date().toISOString(),
    groqProvider: response.logs?.find((l) => l.includes("Narrative provider")),
    valuationMath: {
      reconciled: math.reconciledValue,
      income: math.incomeValue,
      capRate: math.capitalizationRate,
      normalizedEarnings: math.normalizedEarnings,
    },
    mergeFieldsPopulated: Object.entries(merge).filter(([, v]) => String(v).trim()).length,
    mergeFieldsEmpty: Object.entries(merge).filter(([, v]) => !String(v).trim()).map(([k]) => k).slice(0, 40),
    integrator,
    generated,
    integratorAmounts: findAmounts(integrator.fullTextSample + integrator.sampleProse.join(" ")),
    sectionGap: {
      onlyIntegrator: integrator.sectionHeadings.filter((h) => !generated.sectionHeadings.some((g) => g.includes(h.slice(0, 20)))),
      onlyGenerated: generated.sectionHeadings.filter((h) => !integrator.sectionHeadings.some((g) => g.includes(h.slice(0, 20)))),
    },
    charts: {
      integratorImages: integrator.images,
      generatedImages: generated.imageNames,
    },
    narrativeSamples: {
      integrator: integrator.sampleProse,
      generated: generated.sampleProse,
      groqCompany: response.report.sections
        .flatMap((s) => s.blocks)
        .find((b) => b.kind === "paragraph" && b.id === "company-description"),
    },
    isNarrativeFields: {
      IS_Rev: merge.IS_Rev?.slice(0, 200),
      IS_COGS: merge.IS_COGS?.slice(0, 200),
    },
  };

  const outJson = join(outDir, `kcf-report-compare-${Date.now()}.json`);
  writeFileSync(outJson, JSON.stringify(report, null, 2));

  console.log("=== KCF REPORT COMPARISON ===\n");
  console.log("Integrator:", integratorPath);
  console.log("Generated:", generatedPath);
  console.log("JSON:", outJson);
  console.log("\n--- Document stats ---");
  console.log(
    JSON.stringify(
      {
        integrator: {
          chars: integrator.textChars,
          lines: integrator.lineCount,
          tables: integrator.tables,
          images: integrator.images,
          drawings: integrator.drawings,
        },
        generated: {
          chars: generated.textChars,
          lines: generated.lineCount,
          tables: generated.tables,
          images: generated.images,
          drawings: generated.drawings,
        },
      },
      null,
      2,
    ),
  );
  console.log("\n--- Valuation (integrator-path math) ---");
  console.log(`  Reconciled: $${math.reconciledValue.toLocaleString()}`);
  console.log(`  Cap rate: ${(math.capitalizationRate * 100).toFixed(2)}%`);
  console.log(`  Normalized earnings: $${math.normalizedEarnings.toLocaleString()}`);
  console.log(`  Groq: ${report.groqProvider ?? "n/a"}`);
  console.log("\n--- Section headings (integrator) ---");
  integrator.sectionHeadings.slice(0, 20).forEach((h) => console.log(" ", h));
  console.log("\n--- Section headings (generated) ---");
  generated.sectionHeadings.slice(0, 20).forEach((h) => console.log(" ", h));
  console.log("\n--- Empty merge fields (sample) ---");
  console.log(report.mergeFieldsEmpty.slice(0, 15).join(", ") || "(none)");
  console.log("\n--- Images ---");
  console.log("  Integrator:", integrator.imageNames.length, integrator.imageNames.slice(0, 5).join(", "));
  console.log("  Generated:", generated.imageNames.length, generated.imageNames.slice(0, 8).join(", "));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
