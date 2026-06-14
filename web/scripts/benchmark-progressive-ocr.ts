/**
 * Regression + speed benchmark: single-pass vs progressive tier OCR.
 *
 *   npx tsx scripts/benchmark-progressive-ocr.ts           # 2024 only
 *   npx tsx scripts/benchmark-progressive-ocr.ts --all     # 2023–2025
 *   npx tsx scripts/benchmark-progressive-ocr.ts --cached  # parse-only using ocr-cache
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
import { runProgressiveOcrLocal } from "../src/lib/tax/progressive-ocr-core";
import { TAX_WORKBOOK_ROWS } from "../src/lib/tax-workbook";

const INPUT_IDS = TAX_WORKBOOK_ROWS.filter((r) => r.excelBehavior === "input").map((r) => r.id);
const CACHE_DIR = path.join(process.cwd(), "scripts", "ocr-cache");

type Score = { ok: number; n: number; pct: number; misses: string[] };

function scorePrimary(year: number, values: Record<string, number | undefined>): Score {
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

async function embeddedText(bytes: Uint8Array) {
  const p = new PDFParse({ data: Buffer.from(bytes) });
  const t = await p.getText();
  await p.destroy?.();
  return t.text ?? "";
}

type BenchRow = {
  label: string;
  ms: number;
  primary: string;
  pct: number;
  tiers?: string;
  pages?: number;
  misses: string[];
};

async function benchSingle(
  label: string,
  bytes: Uint8Array,
  embedded: string,
  pdfName: string,
  year: number,
  mode: OcrMode,
  cached?: string,
): Promise<BenchRow> {
  let ocrText: string;
  let ms: number;
  let pages: number;

  if (cached) {
    ocrText = cached;
    ms = 0;
    pages = (cached.match(/--- OCR PAGE \d+/g) || []).length;
  } else {
    const t0 = Date.now();
    const ocr = await runLocalOcr(bytes, { profile: "tax", mode });
    ms = Date.now() - t0;
    ocrText = ocr.text;
    pages = ocr.pages;
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(path.join(CACHE_DIR, `${year}-${label.replace(/\W+/g, "-")}.txt`), ocrText, "utf8");
  }

  const parsed = parseTaxReturnFromText(pdfName, embedded, ocrText, year);
  const score = scorePrimary(year, parsed.values);
  return {
    label,
    ms,
    primary: `${score.ok}/${score.n} (${score.pct.toFixed(1)}%)`,
    pct: score.pct,
    pages,
    misses: score.misses,
  };
}

async function benchProgressive(
  bytes: Uint8Array,
  embedded: string,
  pdfName: string,
  year: number,
  mode: OcrMode,
): Promise<BenchRow> {
  const result = await runProgressiveOcrLocal(bytes, pdfName, embedded, mode, year);
  const score = scorePrimary(year, result.parsed.values);
  const tierSummary = result.tierResults
    .map((t) => {
      const kind = t.skipped ? "skip" : t.deltaOnly ? "delta" : "preview";
      return `${t.tierMode}:${(t.ms / 1000).toFixed(0)}s/${t.pages.length}p/${kind}`;
    })
    .join(" + ");

  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(path.join(CACHE_DIR, `${year}-progressive-${mode}.txt`), result.ocrText, "utf8");

  return {
    label: `progressive-${mode}`,
    ms: result.totalMs,
    primary: `${score.ok}/${score.n} (${score.pct.toFixed(1)}%)`,
    pct: score.pct,
    tiers: tierSummary || result.tiersRun.join(" → "),
    pages: result.ocrPages.length,
    misses: score.misses,
  };
}

async function benchYear(year: number, docsDir: string, cachedOnly: boolean) {
  const pdfPath = await resolveTaxReturnPdf(docsDir, year);
  const pdfName = path.basename(pdfPath);
  const bytes = await readFile(pdfPath);
  const embedded = await embeddedText(bytes);

  console.log(`\n========== ${year} ${pdfName} ==========`);

  const rows: BenchRow[] = [];

  if (cachedOnly) {
    const modes: Array<{ label: string; file: string }> = [
      { label: "local-fast", file: `${year}-fast.txt` },
      { label: "local-balanced", file: `${year}-balanced.txt` },
      { label: "vercel-balanced-single", file: `${year}-vercel-balanced.txt` },
    ];
    for (const { label, file } of modes) {
      try {
        const text = await readFile(path.join(CACHE_DIR, file), "utf8");
        rows.push(await benchSingle(label, bytes, embedded, pdfName, year, "fast", text));
      } catch {
        console.log(`  skip ${label} (no cache ${file})`);
      }
    }
  } else if (progressiveOnly) {
    rows.push(await benchProgressive(bytes, embedded, pdfName, year, "vercel-fast"));
    rows.push(await benchProgressive(bytes, embedded, pdfName, year, "vercel-balanced"));
  } else {
    rows.push(await benchSingle("local-fast", bytes, embedded, pdfName, year, "fast"));
    rows.push(await benchSingle("vercel-balanced-single", bytes, embedded, pdfName, year, "vercel-balanced"));
    rows.push(await benchProgressive(bytes, embedded, pdfName, year, "vercel-fast"));
    rows.push(await benchProgressive(bytes, embedded, pdfName, year, "vercel-balanced"));
  }

  console.log("\nlabel                      | time   | primary        | pages | tiers");
  console.log("-".repeat(90));
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(26)} | ${(r.ms / 1000).toFixed(1).padStart(5)}s | ${r.primary.padEnd(14)} | ${String(r.pages ?? "—").padStart(5)} | ${r.tiers ?? "—"}`,
    );
    if (r.misses.length) console.log(`  misses: ${r.misses.slice(0, 4).join("; ")}`);
  }

  const single = rows.find((r) => r.label === "vercel-balanced-single");
  const prog = rows.find((r) => r.label === "progressive-vercel-balanced");
  if (single && prog) {
    const speedDelta = ((single.ms - prog.ms) / single.ms) * 100;
    const accDelta = prog.pct - single.pct;
    console.log(
      `\nprogressive vs single vercel-balanced: ${speedDelta >= 0 ? `${speedDelta.toFixed(0)}% faster` : `${(-speedDelta).toFixed(0)}% slower`}, accuracy ${accDelta >= 0 ? "+" : ""}${accDelta.toFixed(1)}pp`,
    );
  }

  return rows;
}

const runAll = process.argv.includes("--all");
const cachedOnly = process.argv.includes("--cached");
const progressiveOnly = process.argv.includes("--progressive-only");
const docsDir = path.resolve(process.cwd(), process.env.DOCS_DIR ?? "../Documents");
const yearArg = process.argv.find((a) => /^20\d{2}$/.test(a));
const years = runAll ? [2023, 2024, 2025] : [Number(yearArg ?? 2024)];

async function main() {
  console.log(`Docs: ${docsDir}${cachedOnly ? " (cached parse only)" : ""}`);
  const allRows: Array<{ year: number; rows: BenchRow[] }> = [];
  for (const year of years) {
    allRows.push({ year, rows: await benchYear(year, docsDir, cachedOnly) });
  }

  const outPath = path.join(process.cwd(), "scripts", "benchmark-progressive.json");
  await writeFile(outPath, JSON.stringify({ at: new Date().toISOString(), allRows }, null, 2), "utf8");
  console.log(`\nWrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
