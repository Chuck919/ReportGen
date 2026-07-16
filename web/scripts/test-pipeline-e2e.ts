/**
 * End-to-end pipeline: PDF upload → OCR → parse → table export → merge.
 * Mirrors the server path used by POST /api/parse-tax-return (no browser).
 *
 *   npm run test:pipeline              # 2024, balanced (full OCR ~3–4 min)
 *   npm run test:pipeline -- --quick   # cached OCR text; validates parse/export only
 *   npm run test:pipeline -- 2023 fast
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import type { OcrMode } from "../src/lib/api/types";
import { buildTaxTable } from "../src/lib/tax/export-table";
import { mergeTaxYearsByYear } from "../src/lib/tax/merge-years";
import { processTaxPdfFile } from "../src/lib/tax/process-tax-upload";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { runLocalOcr } from "../src/lib/tax-return/local-ocr";
import {
  TAX_ATTACHMENT_FIELD_IDS,
  WORKBOOK_COMPARISON_FIXTURES,
} from "../src/lib/workbook-comparison-fixtures";
import { TAX_WORKBOOK_ROWS } from "../src/lib/tax-workbook";

const INPUT_IDS = TAX_WORKBOOK_ROWS.filter((r) => r.excelBehavior === "input").map((r) => r.id);
const CACHE_DIR = path.join(process.cwd(), "scripts", "ocr-cache");

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    console.log(`  ok: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function scorePrimary(year: number, values: Record<string, number | undefined>) {
  const exp = WORKBOOK_COMPARISON_FIXTURES.tax[`KCF MAIN CURRENT EXCEL.xlsx / ${year}`]?.values;
  if (!exp) throw new Error(`No fixture for ${year}`);
  let ok = 0;
  let n = 0;
  const misses: string[] = [];
  for (const id of INPUT_IDS) {
    const expected = exp[id];
    if (expected === undefined) continue;
    if (TAX_ATTACHMENT_FIELD_IDS.has(id)) continue;
    if (expected === 0 && values[id] === undefined) continue;
    n++;
    const actual = values[id];
    const hit =
      actual !== undefined &&
      (expected === 0 ? actual === 0 : Math.abs(actual - expected) / Math.abs(expected) <= 0.01);
    if (!hit) misses.push(`${id}: exp ${expected}, got ${actual ?? "(blank)"}`);
    else ok++;
  }
  return { ok, n, pct: n ? (ok / n) * 100 : 0, misses };
}

async function fileFromPdf(pdfPath: string): Promise<File> {
  const buf = await readFile(pdfPath);
  const name = path.basename(pdfPath);
  return new File([buf], name, { type: "application/pdf" });
}

async function embeddedText(bytes: Uint8Array): Promise<string> {
  const p = new PDFParse({ data: Buffer.from(bytes) });
  const t = await p.getText();
  await p.destroy?.();
  return t.text ?? "";
}

async function cachedOcrText(year: number, bytes: Uint8Array, mode: OcrMode): Promise<string> {
  await mkdir(CACHE_DIR, { recursive: true });
  const cachePath = path.join(CACHE_DIR, `${year}-${mode}.txt`);
  try {
    const cached = await readFile(cachePath, "utf8");
    if (cached.length > 500) {
      console.log(`  [cache] ${cachePath}`);
      return cached;
    }
  } catch {
    // miss
  }
  console.log(`  [ocr] running ${mode}…`);
  const ocr = await runLocalOcr(bytes, { profile: "tax", mode });
  await writeFile(cachePath, ocr.text, "utf8");
  return ocr.text;
}

const args = process.argv.slice(2);
const quick = args.includes("--quick");
const positional = args.filter((a) => !a.startsWith("--"));
const year = Number(positional[0] ?? 2024);
const mode = (positional[1] ?? "balanced") as OcrMode;
const docsDir = path.resolve(process.cwd(), process.env.DOCS_DIR ?? "../Documents");
const minPrimaryPct = Number(process.env.PIPELINE_MIN_PRIMARY_PCT ?? 85);

async function main() {
  console.log(`=== pipeline e2e: year=${year} mode=${mode} quick=${quick} ===\n`);

  const pdfPath = await resolveTaxReturnPdf(docsDir, year);
  const bytes = await readFile(pdfPath);
  const file = await fileFromPdf(pdfPath);

  const t0 = Date.now();
  let outcome;

  if (quick) {
    const ocrText = await cachedOcrText(year, bytes, mode);
    outcome = await processTaxPdfFile(file, mode, { preOcrText: ocrText });
  } else {
    outcome = await processTaxPdfFile(file, mode);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n--- process (${elapsed}s) ---`);
  assert(outcome.status !== "error", `process status not error (${outcome.status})`);

  if (outcome.status === "error") {
    console.error(outcome.message);
    process.exit(1);
  }

  const parsed = outcome.parsed;
  assert(parsed.year === year, `year inferred ${parsed.year}`);
  assert(Object.keys(parsed.values).length >= 10, "at least 10 fields extracted");

  const score = scorePrimary(year, parsed.values);
  console.log(`  primary: ${score.ok}/${score.n} (${score.pct.toFixed(1)}%)`);
  if (score.misses.length) console.log(`  misses: ${score.misses.slice(0, 6).join("; ")}`);
  assert(score.pct >= minPrimaryPct, `primary accuracy >= ${minPrimaryPct}%`);

  const table = buildTaxTable([parsed]);
  assert(table.columns.includes(year), "table has year column");
  assert(table.tsv.length > 100, "tsv non-trivial");
  assert(table.rows.some((r) => r.id === "sales"), "table has sales row");

  const merged = mergeTaxYearsByYear(
    [{ year: year - 1, values: { sales: 1 }, source: "old" }],
    [parsed],
  );
  assert(merged.some((c) => c.year === year), "merge keeps new year");
  assert(merged.some((c) => c.year === year - 1), "merge keeps prior year");

  if (outcome.status === "partial") {
    console.log("  note: partial OCR (timeout fallback) — still counted as pass if fields present");
  }

  console.log(`\n=== pipeline e2e: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
