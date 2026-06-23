/**
 * All-fields benchmark on cached thorough OCR (training clients only, no SSSI).
 *   npx tsx scripts/benchmark-all-cached.ts
 */
import { readFile, access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { scoreAllFields } from "./lib/tax-benchmark-score";
import {
  aggregateConfidenceCalibration,
  computeConfidenceCalibration,
  formatCalibrationSummary,
} from "./lib/tax-benchmark-confidence";
import { TAX_BENCHMARK_CLIENTS, fixtureKey } from "./lib/tax-benchmark-clients";
import { forceExit } from "./lib/force-exit";

const HOLDOUT = "sssi";
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
  const named = path.join(CACHE_DIR, `${clientId}-${year}-thorough.txt`);
  if (await hasCache(named)) return named;
  if (clientId === "kcf") {
    const legacy = path.join(CACHE_DIR, `${year}-thorough.txt`);
    if (await hasCache(legacy)) return legacy;
  }
  return null;
}

async function main() {
  const rows: Array<{
    client: string;
    year: number;
    allPct: number;
    ok: number;
    n: number;
    misses: string[];
    opex?: number;
    opexSrc?: string;
    confidenceCalibration?: ReturnType<typeof computeConfidenceCalibration>;
  }> = [];
  const calibrations: ReturnType<typeof computeConfidenceCalibration>[] = [];

  for (const client of TAX_BENCHMARK_CLIENTS) {
    if (client.id === HOLDOUT) continue;
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
        ocrMode: "thorough",
      });
      const score = scoreAllFields(fixtureKey(client, year), parsed.values);
      const fk = fixtureKey(client, year);
      const cal = computeConfidenceCalibration(fk, parsed);
      calibrations.push(cal);
      rows.push({
        client: client.id,
        year,
        allPct: score.pct,
        ok: score.ok,
        n: score.n,
        misses: score.misses,
        opex: parsed.values.other_operating_expenses,
        opexSrc: parsed.fieldSources?.other_operating_expenses,
        confidenceCalibration: cal,
      });
    }
  }

  console.log("\n=== ALL-FIELDS BENCHMARK (cached thorough OCR, holdout SSSI) ===\n");
  let totalOk = 0;
  let totalN = 0;
  for (const r of rows.sort((a, b) => a.client.localeCompare(b.client) || a.year - b.year)) {
    totalOk += r.ok;
    totalN += r.n;
    const miss = r.misses.length ? ` | ${r.misses.join("; ")}` : "";
    console.log(
      `${r.client.padEnd(12)} ${r.year}  ${r.allPct.toFixed(1).padStart(5)}% (${r.ok}/${r.n})${miss}`,
    );
  }
  const agg = totalN ? (totalOk / totalN) * 100 : 0;
  console.log(`\nAGGREGATE: ${agg.toFixed(1)}% (${totalOk}/${totalN}) across ${rows.length} client-years`);
  console.log(`Misses: ${rows.filter((r) => r.misses.length).length}/${rows.length} client-years`);

  const aggregateCalibration = aggregateConfidenceCalibration(calibrations);
  console.log("\n--- confidence calibration (aggregate) ---");
  console.log(formatCalibrationSummary(aggregateCalibration));

  const outDir = path.join(process.cwd(), "scripts", "benchmark-output");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `all-cached-thorough-${Date.now()}.json`);
  await writeFile(
    outPath,
    JSON.stringify({ aggregatePct: agg, rows, confidenceCalibration: aggregateCalibration }, null, 2),
  );
  console.log(`Wrote ${outPath}`);
  forceExit(rows.some((r) => r.misses.length) ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  forceExit(2);
});
