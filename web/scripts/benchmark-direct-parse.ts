/**
 * Full parse pipeline benchmark — same code path as POST /api/parse-tax-return, no HTTP.
 * Use when dev server / .next is unavailable (OneDrive EPERM, port conflicts).
 *
 * Usage:
 *   npx tsx scripts/benchmark-direct-parse.ts [mode] [clientId?] [year?]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseTaxReturn } from "../src/lib/tax-return-parser";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import {
  scoreAllFieldsExcludingOpexSlots,
  scoreOpexAmountsOnly,
  scorePrimary,
} from "./lib/tax-benchmark-score";
import {
  aggregateConfidenceCalibration,
  buildFieldMissDiagnostics,
  computeConfidenceCalibration,
  formatCalibrationSummary,
  type ConfidenceCalibration,
  type FieldMissDiagnostic,
} from "./lib/tax-benchmark-confidence";
import { TAX_BENCHMARK_CLIENTS, fixtureKey, type TaxBenchmarkClient } from "./lib/tax-benchmark-clients";
import type { OcrMode } from "../src/lib/tax-return/local-ocr";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import {
  buildClientYearDebugReport,
  printDebugReports,
  type ClientYearDebugReport,
} from "./lib/tax-benchmark-debug";
import { forceExit } from "./lib/force-exit";

const mode = (process.argv[2] ?? "thorough") as OcrMode;
const onlyClient = process.argv[3];
const onlyYear = process.argv[4] ? Number(process.argv[4]) : undefined;

type RowResult = {
  client: string;
  year: number;
  primaryPct: number;
  fieldPct: number;
  opexAmountPct: number;
  allPct: number;
  allMisses: string[];
  missDiagnostics?: FieldMissDiagnostic[];
  debug?: ClientYearDebugReport;
  confidenceCalibration?: ConfidenceCalibration;
  elapsedMs: number;
  error?: string;
};

async function runClientYear(client: TaxBenchmarkClient, year: number): Promise<RowResult> {
  const pdfPath = await resolveTaxReturnPdf(path.resolve(process.cwd(), client.docsDir), year);
  const bytes = new Uint8Array(await readFile(pdfPath));
  const embedded = await getEmbeddedPdfText(bytes);
  const t0 = Date.now();
  const result = await parseTaxReturn(path.basename(pdfPath), bytes, embedded, year, mode);
  if (result.ocrText && result.ocrText.length > 500) {
    const cacheDir = path.join(process.cwd(), "scripts", "ocr-cache");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      path.join(cacheDir, `${client.id}-${year}-${mode}.txt`),
      result.ocrText,
      "utf8",
    );
  }
  const elapsedMs = Date.now() - t0;
  const fk = fixtureKey(client, year);
  const primary = scorePrimary(fk, result.values);
  const fieldsNoOpex = scoreAllFieldsExcludingOpexSlots(fk, result.values);
  const opexAmounts = scoreOpexAmountsOnly(fk, result.values);
  const parsedCtx = {
    values: result.values,
    confidence: result.confidence,
    fieldSources: result.fieldSources,
    fieldFlags: result.fieldFlags,
    displayConfidence: result.displayConfidence,
    fieldCandidateOptions: result.fieldCandidateOptions,
    fieldAlternates: result.fieldAlternates,
    ocrCoverage: result.ocrCoverage,
    operatingExpenseLines: result.operatingExpenseLines,
    opexSlotLabels: result.opexSlotLabels,
  };
  const missDiagnostics = buildFieldMissDiagnostics(parsedCtx, fieldsNoOpex);
  const confidenceCalibration = computeConfidenceCalibration(fk, parsedCtx);
  const debug = buildClientYearDebugReport(client.id, year, fk, parsedCtx);
  return {
    client: client.id,
    year,
    primaryPct: primary.pct,
    fieldPct: fieldsNoOpex.pct,
    opexAmountPct: opexAmounts.pct,
    allPct: fieldsNoOpex.pct,
    allMisses: fieldsNoOpex.misses,
    missDiagnostics,
    debug,
    confidenceCalibration,
    elapsedMs,
  };
}

async function main() {
  const clients = onlyClient
    ? TAX_BENCHMARK_CLIENTS.filter((c) => c.id === onlyClient)
    : TAX_BENCHMARK_CLIENTS;

  console.log(`=== direct parse benchmark mode=${mode} ===\n`);
  const rows: RowResult[] = [];

  for (const client of clients) {
    const years = onlyYear ? client.years.filter((y) => y === onlyYear) : client.years;
    for (const year of years) {
      process.stdout.write(`[${client.id} ${year}] `);
      try {
        const row = await runClientYear(client, year);
        rows.push(row);
        console.log(
          `fields ${row.fieldPct.toFixed(1)}% opexAmt ${row.opexAmountPct.toFixed(1)}% (${(row.elapsedMs / 1000).toFixed(0)}s)`,
        );
        if (row.allMisses.length) {
          console.log(`  misses: ${row.allMisses.join("; ")}`);
          for (const d of row.missDiagnostics ?? []) {
            console.log(
              `    ↳ ${d.field}: conf=${d.confidence}% diagnosis=${d.diagnosis} flagged=${d.flagged}`,
            );
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`FAIL ${msg}`);
        rows.push({
          client: client.id,
          year,
          primaryPct: 0,
          fieldPct: 0,
          opexAmountPct: 0,
          allPct: 0,
          allMisses: [msg],
          elapsedMs: 0,
          error: msg,
        });
      }
    }
  }

  const ok = rows.filter((r) => !r.error);
  const avgField =
    ok.length > 0 ? ok.reduce((s, r) => s + r.fieldPct, 0) / ok.length : 0;
  const avgOpex =
    ok.length > 0 ? ok.reduce((s, r) => s + r.opexAmountPct, 0) / ok.length : 0;
  const aggregateCalibration = aggregateConfidenceCalibration(
    ok.filter((r) => r.confidenceCalibration).map((r) => r.confidenceCalibration!),
  );

  console.log("\n--- summary ---");
  console.log(`completed: ${ok.length}/${rows.length}`);
  console.log(`avg field (excl opex slots): ${avgField.toFixed(1)}%`);
  console.log(`avg opex amount multiset: ${avgOpex.toFixed(1)}%`);
  console.log("\n--- confidence calibration (aggregate) ---");
  console.log(formatCalibrationSummary(aggregateCalibration));

  printDebugReports(ok.map((r) => r.debug).filter((d): d is ClientYearDebugReport => !!d));

  const outDir = path.join(process.cwd(), "scripts", "benchmark-output");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `direct-${mode}-${Date.now()}.json`);
  await writeFile(
    outPath,
    JSON.stringify(
      {
        mode,
        rows,
        debugReports: ok.map((r) => r.debug).filter(Boolean),
        aggregateCalibration,
        avgField,
        avgOpex,
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${outPath}`);

  const belowThreshold =
    avgField < 99 ||
    avgOpex < 99 ||
    aggregateCalibration.dangerousFailures > 0 ||
    aggregateCalibration.correctLowConfidenceRate > 0.05;

  forceExit(belowThreshold ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  forceExit(2);
});
