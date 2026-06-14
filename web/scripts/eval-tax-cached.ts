/**
 * Regression eval with OCR text cache for fast iteration.
 *
 *   npm run eval:tax:cached           # use cache when present
 *   npm run eval:tax:cached -- --refresh  # re-OCR all years
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import {
  TAX_ATTACHMENT_FIELD_IDS,
  WORKBOOK_COMPARISON_FIXTURES,
} from "../src/lib/workbook-comparison-fixtures";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { runLocalOcr, type OcrMode } from "../src/lib/tax-return/local-ocr";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { TAX_WORKBOOK_ROWS } from "../src/lib/tax-workbook";

const INPUT_IDS = TAX_WORKBOOK_ROWS.filter((r) => r.excelBehavior === "input").map((r) => r.id);
const YEARS = [2023, 2024, 2025] as const;
const CACHE_DIR = path.join(process.cwd(), "scripts", "ocr-cache");

function scoreField(expected: number, actual: number | undefined): boolean {
  if (actual === undefined) return false;
  if (expected === 0 && actual === 0) return true;
  if (expected === 0) return actual === 0;
  return Math.abs(actual - expected) / Math.abs(expected) <= 0.01;
}

async function embeddedTextFromPdf(bytes: Uint8Array): Promise<string> {
  const p = new PDFParse({ data: Buffer.from(bytes) });
  const text = await p.getText();
  await p.destroy?.();
  return text.text ?? "";
}

async function ocrTextForYear(
  year: number,
  bytes: Uint8Array,
  refresh: boolean,
  mode: OcrMode,
): Promise<string> {
  await mkdir(CACHE_DIR, { recursive: true });
  const cachePath = path.join(CACHE_DIR, `${year}-${mode}.txt`);
  if (!refresh) {
    try {
      const cached = await readFile(cachePath, "utf8");
      if (cached.length > 500) return cached;
    } catch {
      // cache miss
    }
  }
  const ocr = await runLocalOcr(bytes, { profile: "tax", mode });
  await writeFile(cachePath, ocr.text, "utf8");
  console.log(`  [cache] wrote ${cachePath} (${ocr.text.length} chars, ${ocr.pages} pages)`);
  return ocr.text;
}

async function evalYear(year: number, docsDir: string, refresh: boolean, mode: OcrMode) {
  const pdfPath = await resolveTaxReturnPdf(docsDir, year);
  const bytes = await readFile(pdfPath);
  const embedded = await embeddedTextFromPdf(bytes);
  const t0 = Date.now();
  const ocrText = await ocrTextForYear(year, bytes, refresh, mode);
  const result = parseTaxReturnFromText(path.basename(pdfPath), embedded, ocrText, year);
  const elapsed = Date.now() - t0;

  const expected = WORKBOOK_COMPARISON_FIXTURES.tax[`KCF MAIN CURRENT EXCEL.xlsx / ${year}`]?.values;
  if (!expected) throw new Error(`No fixture for ${year}`);

  let primaryScored = 0;
  let primaryCorrect = 0;
  let attachScored = 0;
  let attachCorrect = 0;
  const misses: string[] = [];

  for (const id of INPUT_IDS) {
    const exp = expected[id];
    if (exp === undefined) continue;
    const tier = TAX_ATTACHMENT_FIELD_IDS.has(id) ? "attachment" : "primary";
    if (exp === 0 && result.values[id] === undefined) continue;
    const actual = result.values[id];
    const ok = scoreField(exp, actual);
    if (tier === "primary") {
      primaryScored++;
      if (ok) primaryCorrect++;
      else {
        const label = TAX_WORKBOOK_ROWS.find((r) => r.id === id)?.label ?? id;
        misses.push(`${label}: exp ${exp}, got ${actual ?? "(blank)"} (src ${result.fieldSources?.[id] ?? "—"})`);
      }
    } else {
      attachScored++;
      if (ok) attachCorrect++;
    }
  }

  const primaryPct = primaryScored ? (primaryCorrect / primaryScored) * 100 : 100;
  const attachPct = attachScored ? (attachCorrect / attachScored) * 100 : 100;
  console.log(`\n=== ${year} (${Math.round(elapsed / 1000)}s) ===`);
  console.log(`Primary: ${primaryCorrect}/${primaryScored} (${primaryPct.toFixed(1)}%) | Attachments: ${attachPct.toFixed(1)}%`);
  if (misses.length) {
    console.log("Primary misses:");
    for (const m of misses) console.log(`  ${m}`);
  }

  return { year, primaryPct, primaryPass: primaryPct >= 95 };
}

function parseModeArg(): OcrMode {
  const idx = process.argv.indexOf("--mode");
  const raw = idx >= 0 ? process.argv[idx + 1] : process.env.FREE_OCR_MODE;
  if (raw === "fast" || raw === "thorough") return raw;
  return "balanced";
}

async function main() {
  const refresh = process.argv.includes("--refresh");
  const mode = parseModeArg();
  const docsDir = path.resolve(process.cwd(), "..", "Documents");
  console.log(`OCR mode: ${mode}${refresh ? " (refresh cache)" : ""}`);
  const results = [];
  for (const year of YEARS) {
    results.push(await evalYear(year, docsDir, refresh, mode));
  }
  console.log("\n=== Summary ===");
  for (const r of results) {
    console.log(`${r.year}: primary ${r.primaryPct.toFixed(1)}% ${r.primaryPass ? "PASS" : "FAIL"}`);
  }
  process.exit(results.every((r) => r.primaryPass) ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
