/**
 * Simulates a real user walking the valuation wizard for KCF (integrator path).
 * Uses frozen OCR + disk API cache only — no live network calls when cache is warm.
 *
 * Usage:
 *   cd web
 *   set VALUATION_DISK_CACHE_ONLY=1
 *   npx tsx scripts/test-valuation-user-workflow.ts
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { loadEnvLocal } from "./lib/load-env-local";
import { forceExit } from "./lib/force-exit";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { mergeParsedTaxYears } from "../src/lib/tax/client-merge";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { readFile } from "node:fs/promises";
import { applyIntegratorWorkbookDefaults, KCF_INTEGRATOR_ENGAGEMENT, KCF_INTEGRATOR_WORKBOOK } from "@/lib/valuation/integrator-workbook";
import { buildGenerateRequest } from "@/lib/valuation/build-request";
import { buildValuationReport } from "@/lib/valuation/report";
import { exportValuationDocx } from "@/lib/valuation/docx-export";
import { buildWordMergeData } from "@/lib/valuation/premerge-merge-data";
import { EMPTY_COMPANY_PROFILE } from "@/lib/valuation/company-profile";
import { installValuationFetchDiskCache } from "@/lib/valuation/valuation-disk-cache";
import type { MarketMultiplesProfile } from "@/lib/valuation/types";

const repoRoot = join(process.cwd(), "..");
const integratorPath = join(repoRoot, "Documents", "KCF valuation.docx");
const outDir = join(process.cwd(), "scripts", "benchmark-output");
const ocrCacheDir = join(process.cwd(), "scripts", "ocr-cache");
const MODE = "balanced";
const YEARS = [2023, 2024, 2025];

function extractDocx(path: string) {
  const zip = join(tmpdir(), `user-wf-${Date.now()}.zip`);
  const dir = join(tmpdir(), `user-wf-unpack-${Date.now()}`);
  copyFileSync(path, zip);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  execSync(
    `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}' -Force"`,
    { stdio: "pipe" },
  );
  const xml = readFileSync(join(dir, "word", "document.xml"), "utf8");
  const text = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)]
    .map((m) => m[1]!)
    .join("")
    .replace(/\s+/g, " ");
  const mergeFieldCount = (xml.match(/MERGEFIELD/gi) ?? []).length;
  const media = existsSync(join(dir, "word", "media")) ? readdirSync(join(dir, "word", "media")) : [];
  return { xml, text, mergeFieldCount, media };
}

async function loadKcfColumns() {
  const parsedYears = [];
  const docsDir = join(repoRoot, "Documents");
  for (const year of YEARS) {
    const cacheNamed = join(ocrCacheDir, `kcf-${year}-${MODE}.txt`);
    const cacheLegacy = join(ocrCacheDir, `${year}-${MODE}.txt`);
    const cachePath = existsSync(cacheNamed) ? cacheNamed : cacheLegacy;
    if (!existsSync(cachePath)) throw new Error(`Missing OCR cache: ${cachePath}`);
    const pdfPath = await resolveTaxReturnPdf(docsDir, year);
    const bytes = await readFile(pdfPath);
    const embedded = await getEmbeddedPdfText(bytes);
    const ocr = await readFile(cachePath, "utf8");
    parsedYears.push(parseTaxReturnFromText(pdfPath.split(/[/\\]/).pop()!, embedded, ocr, year, { ocrMode: MODE }));
  }
  return mergeParsedTaxYears([], parsedYears).columns;
}

async function main() {
  await loadEnvLocal();
  process.env.VALUATION_DISK_CACHE_ONLY = process.env.VALUATION_DISK_CACHE_ONLY ?? "1";
  const restoreFetch = installValuationFetchDiskCache({ cacheOnly: true });

  console.log("=== KCF USER WORKFLOW SIMULATION (cache-only) ===\n");

  // Step 1: Upload / parse tax returns (cached OCR)
  console.log("Step 1: Parse tax returns from frozen OCR…");
  const columns = await loadKcfColumns();
  console.log(`  ${columns.length} years parsed`);

  // Step 2: User fills company profile (short description + entity)
  console.log("Step 2: Company profile form…");
  const companyProfile = {
    ...EMPTY_COMPANY_PROFILE,
    businessDescription:
      "K.C. Fudge manufactures and retails gourmet fudge and confectionery products in the Kansas City metro.",
    productsServices: "Handcrafted fudge, seasonal confections, wholesale and retail sales.",
    customersMarkets: "Retail customers, gift buyers, and local wholesale accounts in the KC MSA.",
    ownershipSummary: "Closely held; Robin Needham is the principal owner seeking SBA financing.",
    ownerName: KCF_INTEGRATOR_ENGAGEMENT.ownerName,
    entityState: KCF_INTEGRATOR_ENGAGEMENT.entityState,
    entityFileNumber: "N00000000",
    entityFormationDate: "2010-01-15",
    normalizationNotes: "Normalized per integrator workbook — NPBT plus depreciation, interest, and amortization.",
  };

  // Step 3: Engagement fields
  console.log("Step 3: Engagement details…");
  const engagement = {
    entityName: KCF_INTEGRATOR_ENGAGEMENT.legalEntityName,
    engagingParty: KCF_INTEGRATOR_ENGAGEMENT.engagingParty,
    purpose: KCF_INTEGRATOR_ENGAGEMENT.purpose,
    naics: KCF_INTEGRATOR_ENGAGEMENT.naics,
    msaLabel: KCF_INTEGRATOR_ENGAGEMENT.msaLabel,
    cbsaCode: KCF_INTEGRATOR_ENGAGEMENT.cbsaCode,
    useGroq: Boolean(process.env.GROQ_API_KEY),
    city: KCF_INTEGRATOR_ENGAGEMENT.city,
    title: KCF_INTEGRATOR_ENGAGEMENT.title,
    company: KCF_INTEGRATOR_ENGAGEMENT.company,
  };

  // Step 4: Assumptions (integrator workbook defaults)
  console.log("Step 4: Integrator workbook assumptions…");
  const valuationInputs = applyIntegratorWorkbookDefaults(columns);
  console.log(`  normalized: $${valuationInputs.normalizedEarnings?.toLocaleString()}`);
  console.log(`  cap rate: ${((valuationInputs.preTaxNetIncomeCapRate ?? 0) * 100).toFixed(2)}%`);

  const market: MarketMultiplesProfile = {
    vertical: "specialty-retail",
    bracket: "5m_25m_ev",
    metrics: [{ name: "ev_ebitda", multiple: 5.2, impliedValue: 789_875 }],
    source: { label: "ExitValue fixture" },
  };

  // Step 5: Generate report
  console.log("Step 5: Generate valuation report…");
  const request = buildGenerateRequest({
    columns,
    ...engagement,
    dateOfIssuance: "2026-05-13",
    valuationInputs,
    companyProfile,
  });
  const response = await buildValuationReport(request);
  const { valuation } = response.report;

  // Step 6: Export firm Word doc
  console.log("Step 6: Export firm Word document…");
  const { buffer } = await exportValuationDocx({
    report: response.report,
    mode: "firm",
    mergeContext: {
      columns,
      valuationInputs,
      engagement: {
        city: engagement.city,
        title: engagement.title,
        company: engagement.company,
        owner: companyProfile.ownerName,
        companyProfile,
        transactionTypeLanguage: "The transaction has been presented as an asset sale.",
      },
    },
  });

  mkdirSync(outDir, { recursive: true });
  const generatedPath = join(outDir, "kcf-user-workflow.docx");
  writeFileSync(generatedPath, buffer);

  const merge = buildWordMergeData({
    report: response.report,
    columns,
    valuationInputs,
    engagement: {
      city: engagement.city,
      title: engagement.title,
      company: engagement.company,
      owner: companyProfile.ownerName,
      companyProfile,
    },
  });

  const generated = extractDocx(generatedPath);
  const integrator = existsSync(integratorPath) ? extractDocx(integratorPath) : null;

  const failures: string[] = [];

  if (generated.mergeFieldCount > 0) {
    failures.push(`Generated doc still has ${generated.mergeFieldCount} MERGEFIELD token(s) — template merge incomplete`);
  }
  if (!generated.text.includes("K.C. Fudge")) {
    failures.push("Missing legal entity name K.C. Fudge, Inc.");
  }
  if (!generated.text.includes("OakStar Bank")) {
    failures.push("Missing engaging company OakStar Bank on cover");
  }
  if (!generated.text.includes("VP, Commercial Loan Officer") && !generated.text.includes("VP")) {
    failures.push("Missing engagement title on cover");
  }
  if (!/\$801[, ]?93/.test(generated.text)) {
    failures.push(`Missing reconciled value ~$801,930 (got valuation ${valuation.reconciledValue})`);
  }
  if (!generated.text.includes("$4,500") && !merge.assets_?.includes("4,500")) {
    failures.push(`Tangible assets should be $4,500 (merge assets_=${merge.assets_}, tangible=${valuation.tangibleAssetValue})`);
  }
  if (!generated.text.includes("asset sale")) {
    failures.push("Missing asset sale transaction language");
  }
  if (generated.text.includes("MERGEFIELD")) {
    failures.push("Visible MERGEFIELD text in document body");
  }
  if (Math.abs(valuation.reconciledValue - KCF_INTEGRATOR_WORKBOOK.reconciledValue) > 2) {
    failures.push(
      `Reconciled ${valuation.reconciledValue} vs integrator ${KCF_INTEGRATOR_WORKBOOK.reconciledValue}`,
    );
  }
  if (valuation.tangibleAssetValue !== KCF_INTEGRATOR_WORKBOOK.tangibleAssets) {
    failures.push(
      `Tangible ${valuation.tangibleAssetValue} vs integrator ${KCF_INTEGRATOR_WORKBOOK.tangibleAssets}`,
    );
  }
  if (!merge.IS_Rev?.includes("Revenues have")) {
    failures.push("IS_Rev narrative missing");
  }
  if (!merge.Acct_rec_note?.trim()) {
    failures.push("Balance sheet footnote Acct_rec_note empty");
  }
  if (generated.media.filter((f) => f.startsWith("chart-slot-")).length < 2) {
    failures.push("Expected live chart-slot PNGs in document media");
  }

  const report = {
    comparedAt: new Date().toISOString(),
    cacheOnly: true,
    valuation: {
      reconciled: valuation.reconciledValue,
      tangible: valuation.tangibleAssetValue,
      intangible: valuation.intangibleValue,
      capRate: valuation.capitalizationRate,
      normalized: valuation.normalizedEarnings,
    },
    mergeSample: {
      entity: merge.entity,
      abbreviation: merge.abbreviation,
      assets_: merge.assets_,
      goodwill: merge.goodwill,
      title: merge.title,
      company: merge.company,
      Transaction_Type_Language: merge.Transaction_Type_Language,
    },
    generated: {
      mergeFieldCount: generated.mergeFieldCount,
      chartCount: generated.media.filter((f) => f.startsWith("chart-slot-")).length,
      textSample: generated.text.slice(0, 1500),
    },
    integrator: integrator
      ? { mergeFieldCount: integrator.mergeFieldCount, textSample: integrator.text.slice(0, 800) }
      : null,
    narrativeProvider: response.logs?.find((l) => l.startsWith("Narrative provider:")),
    failures,
  };

  const jsonPath = join(outDir, `kcf-user-workflow-${Date.now()}.json`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  console.log("\n--- Results ---");
  console.log(`  Reconciled: $${valuation.reconciledValue.toLocaleString()}`);
  console.log(`  Tangible:   $${valuation.tangibleAssetValue.toLocaleString()}`);
  console.log(`  Intangible: $${valuation.intangibleValue.toLocaleString()}`);
  console.log(`  MERGEFIELD count: ${generated.mergeFieldCount}`);
  console.log(`  Charts: ${report.generated.chartCount}`);
  console.log(`  Groq: ${report.narrativeProvider ?? "n/a"}`);
  console.log(`  Output: ${generatedPath}`);
  console.log(`  JSON: ${jsonPath}`);

  restoreFetch();

  if (failures.length) {
    throw new Error(`User workflow failures:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  }
  console.log("\nKCF user workflow PASS");
}

main()
  .then(() => forceExit(0))
  .catch((err) => {
    console.error(err);
    forceExit(1);
  });
