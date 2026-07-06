/**
 * Fast benchmark on cached balanced OCR — same parse path, no live OCR wait.
 *   npx tsx scripts/benchmark-all-cached.ts [mode]
 */
import { readFile, access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import {
  scoreAllFieldsExcludingOpexSlots,
  scoreOpexAmountsOnly,
} from "./lib/tax-benchmark-score";
import {
  aggregateConfidenceCalibration,
  computeConfidenceCalibration,
  formatCalibrationSummary,
} from "./lib/tax-benchmark-confidence";
import { TAX_BENCHMARK_CLIENTS, fixtureKey } from "./lib/tax-benchmark-clients";
import {
  buildClientYearDebugReport,
  printDebugReports,
  type ClientYearDebugReport,
} from "./lib/tax-benchmark-debug";
import { forceExit } from "./lib/force-exit";

const mode = process.argv[2] ?? "balanced";
const CACHE_DIR = path.join(process.cwd(), "scripts", "ocr-cache");

async function hasCache(p: string) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveCache(clientId: string, year: number): Promise<string | null> {
  const named = path.join(CACHE_DIR, `${clientId}-${year}-${mode}.txt`);
  if (await hasCache(named)) return named;
  if (clientId === "kcf") {
    const legacy = path.join(CACHE_DIR, `${year}-${mode}.txt`);
    if (await hasCache(legacy)) return legacy;
  }
  return null;
}

async function main() {
  const rows: Array<{
    client: string;
    year: number;
    fieldPct: number;
    opexAmountPct: number;
    misses: string[];
    confidenceCalibration?: ReturnType<typeof computeConfidenceCalibration>;
    debug?: ClientYearDebugReport;
  }> = [];
  const calibrations: ReturnType<typeof computeConfidenceCalibration>[] = [];
  const debugReports: ClientYearDebugReport[] = [];

  for (const client of TAX_BENCHMARK_CLIENTS) {
    for (const year of client.years) {
      const cp = await resolveCache(client.id, year);
      if (!cp) {
        console.log(`[${client.id} ${year}] SKIP no cache`);
        continue;
      }
      const pdfPath = await resolveTaxReturnPdf(path.resolve(process.cwd(), client.docsDir), year);
      const bytes = await readFile(pdfPath);
      const embedded = await getEmbeddedPdfText(bytes);
      const ocr = await readFile(cp, "utf8");
      const parsed = parseTaxReturnFromText(path.basename(pdfPath), embedded, ocr, year, {
        ocrMode: mode as "balanced" | "thorough" | "fast",
      });
      const fk = fixtureKey(client, year);
      const fields = scoreAllFieldsExcludingOpexSlots(fk, parsed.values);
      const opex = scoreOpexAmountsOnly(fk, parsed.values);
      const cal = computeConfidenceCalibration(fk, parsed);
      calibrations.push(cal);
      const debug = buildClientYearDebugReport(client.id, year, fk, parsed);
      debugReports.push(debug);
      rows.push({
        client: client.id,
        year,
        fieldPct: fields.pct,
        opexAmountPct: opex.pct,
        misses: fields.misses,
        confidenceCalibration: cal,
        debug,
      });
    }
  }

  console.log(`\n=== CACHED ${mode.toUpperCase()} BENCHMARK (${rows.length} client-years) ===\n`);
  let fieldOk = 0;
  let fieldN = 0;
  let opexOk = 0;
  let opexN = 0;
  for (const r of rows.sort((a, b) => a.client.localeCompare(b.client) || a.year - b.year)) {
    fieldOk += (r.fieldPct / 100) * 34;
    fieldN += 34;
    opexOk += (r.opexAmountPct / 100) * 8;
    opexN += 8;
    const miss = r.misses.length ? ` | ${r.misses.join("; ")}` : "";
    console.log(
      `${r.client.padEnd(12)} ${r.year}  fields ${r.fieldPct.toFixed(1).padStart(5)}%  opexAmt ${r.opexAmountPct.toFixed(1).padStart(5)}%${miss}`,
    );
  }
  const avgField = rows.length ? rows.reduce((s, r) => s + r.fieldPct, 0) / rows.length : 0;
  const avgOpex = rows.length ? rows.reduce((s, r) => s + r.opexAmountPct, 0) / rows.length : 0;
  console.log(`\nAVG field (excl opex slots): ${avgField.toFixed(1)}%`);
  console.log(`AVG opex amount multiset: ${avgOpex.toFixed(1)}%`);
  console.log(`Misses: ${rows.filter((r) => r.misses.length).length}/${rows.length} client-years`);

  const aggregateCalibration = aggregateConfidenceCalibration(calibrations);
  console.log("\n--- confidence calibration (aggregate) ---");
  console.log(formatCalibrationSummary(aggregateCalibration));

  printDebugReports(debugReports);

  const outDir = path.join(process.cwd(), "scripts", "benchmark-output");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `cached-${mode}-${Date.now()}.json`);
  await writeFile(
    outPath,
    JSON.stringify(
      {
        mode,
        avgField,
        avgOpex,
        rows,
        debugReports,
        confidenceCalibration: aggregateCalibration,
      },
      null,
      2,
    ),
  );
  console.log(`Wrote ${outPath}`);

  const below =
    avgField < 99 ||
    avgOpex < 99 ||
    aggregateCalibration.dangerousFailures > 0 ||
    aggregateCalibration.correctLowConfidenceRate > 0.05;
  forceExit(below ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  forceExit(2);
});
