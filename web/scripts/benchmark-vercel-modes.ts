/**
 * Benchmark all Vercel OCR modes — must finish under 300s on sample PDF.
 * Run: npm run benchmark:vercel-modes
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import {
  TAX_ATTACHMENT_FIELD_IDS,
  WORKBOOK_COMPARISON_FIXTURES,
} from "../src/lib/workbook-comparison-fixtures";
import { runLocalOcr, type OcrMode } from "../src/lib/tax-return/local-ocr";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { TAX_WORKBOOK_ROWS } from "../src/lib/tax-workbook";
import { VERCEL_FUNCTION_MAX_MS } from "../src/lib/tax/resolve-ocr-mode";

const INPUT_IDS = TAX_WORKBOOK_ROWS.filter((r) => r.excelBehavior === "input").map((r) => r.id);
const MODES: OcrMode[] = ["vercel-fast", "vercel-balanced", "vercel-thorough"];
const YEARS = [2023, 2024, 2025] as const;
const LIMIT_MS = VERCEL_FUNCTION_MAX_MS - 5000;

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
    if (hit) ok++;
    else misses.push(`${id}: exp ${expected}, got ${actual ?? "blank"}`);
  }
  return { ok, n, pct: n ? (ok / n) * 100 : 0, misses };
}

async function embeddedText(bytes: Uint8Array) {
  const p = new PDFParse({ data: Buffer.from(bytes) });
  const t = await p.getText();
  await p.destroy?.();
  return t.text ?? "";
}

async function bench(year: number, mode: OcrMode, docsDir: string) {
  const pdfPath = await resolveTaxReturnPdf(docsDir, year);
  const bytes = await readFile(pdfPath);
  const embedded = await embeddedText(bytes);
  process.env.FREE_OCR_WORKERS = "1";
  const t0 = Date.now();
  const ocr = await runLocalOcr(bytes, { profile: "tax", mode });
  const ms = Date.now() - t0;
  await mkdir(path.join(process.cwd(), "scripts", "ocr-cache"), { recursive: true });
  await writeFile(path.join(process.cwd(), "scripts", "ocr-cache", `${year}-${mode}.txt`), ocr.text, "utf8");
  const parsed = parseTaxReturnFromText(path.basename(pdfPath), embedded, ocr.text, year);
  const score = scorePrimary(year, parsed.values);
  const under = ms < LIMIT_MS;
  return { mode, year, ms, score, under, pages: ocr.pages };
}

async function main() {
  process.env.VERCEL = "1";
  process.env.FREE_OCR_WORKERS = "1";
  const docsDir = path.resolve(process.cwd(), "..", "Documents");
  const rows: Array<Awaited<ReturnType<typeof bench>> & { misses: string[] }> = [];

  console.log("=== COLD START: fresh OCR, no cache reads, workers=1 ===\n");

  for (const year of YEARS) {
    for (const mode of MODES) {
      console.log(`\n[${mode}] ${year} OCR…`);
      const r = await bench(year, mode, docsDir);
      rows.push({ ...r, misses: r.score.misses });
      if (r.score.misses.length) {
        console.log(`  misses: ${r.score.misses.join("; ")}`);
      }
    }
  }

  console.log("\n=== Vercel mode benchmark (cold start) ===");
  console.log(`Limit: ${LIMIT_MS / 1000}s (5s buffer under ${VERCEL_FUNCTION_MAX_MS / 1000}s)\n`);
  let allUnder = true;
  for (const r of rows) {
    const status = r.under ? "PASS" : "FAIL TIME";
    if (!r.under) allUnder = false;
    const missNote = r.misses.length ? `  misses: ${r.misses.join("; ")}` : "";
    console.log(
      `${r.mode.padEnd(18)} ${r.year}  ${(r.ms / 1000).toFixed(1)}s  ${status}  primary ${r.score.ok}/${r.score.n} (${r.score.pct.toFixed(1)}%)  pages ${r.pages}${missNote}`,
    );
  }

  const outPath = path.join(process.cwd(), "scripts", "benchmark-vercel-modes.json");
  await writeFile(
    outPath,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        coldStart: true,
        limitMs: LIMIT_MS,
        rows: rows.map((r) => ({
          mode: r.mode,
          year: r.year,
          ms: r.ms,
          under: r.under,
          primary: `${r.score.ok}/${r.score.n} (${r.score.pct.toFixed(1)}%)`,
          misses: r.misses,
          pages: r.pages,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\nWrote ${outPath}`);
  process.exit(allUnder ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
