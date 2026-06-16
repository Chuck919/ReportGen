/**
 * Repeated cold OCR benchmarks — median accuracy across N runs per mode.
 *
 *   npx tsx scripts/benchmark-ocr-repeated.ts --year 2024 --mode balanced --runs 5
 *   npx tsx scripts/benchmark-ocr-repeated.ts --year 2024 --runs 3
 */
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
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

const INPUT_IDS = TAX_WORKBOOK_ROWS.filter((r) => r.excelBehavior === "input").map((r) => r.id);
const ALL_MODES: OcrMode[] = ["fast", "balanced", "thorough"];
const CACHE_DIR = path.join(process.cwd(), "scripts", "ocr-cache");

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
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
    if (!hit) misses.push(id);
    else ok++;
  }
  return { ok, n, pct: n ? (ok / n) * 100 : 0, misses };
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function stddev(nums: number[]): number {
  if (nums.length < 2) return 0;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  return Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (nums.length - 1));
}

async function embeddedText(bytes: Uint8Array) {
  const p = new PDFParse({ data: Buffer.from(bytes) });
  const t = await p.getText();
  await p.destroy?.();
  return t.text ?? "";
}

async function coldRun(
  year: number,
  mode: OcrMode,
  bytes: Uint8Array,
  embedded: string,
  pdfName: string,
  runNum: number,
) {
  const cachePath = path.join(CACHE_DIR, `${year}-${mode}.txt`);
  try {
    await unlink(cachePath);
  } catch {
    // fresh run
  }

  const t0 = Date.now();
  const ocr = await runLocalOcr(bytes, { profile: "tax", mode });
  const ms = Date.now() - t0;
  await mkdir(CACHE_DIR, { recursive: true });
  const runCache = path.join(CACHE_DIR, `${year}-${mode}-run${runNum}.txt`);
  await writeFile(runCache, ocr.text, "utf8");
  await writeFile(cachePath, ocr.text, "utf8");

  const parsed = parseTaxReturnFromText(pdfName, embedded, ocr.text, year);
  const score = scorePrimary(year, parsed.values);
  return { run: runNum, ms, pct: score.pct, ok: score.ok, n: score.n, misses: score.misses, pages: ocr.pages };
}

async function benchMode(year: number, mode: OcrMode, runs: number, docsDir: string) {
  const pdfPath = await resolveTaxReturnPdf(docsDir, year);
  const bytes = await readFile(pdfPath);
  const embedded = await embeddedText(bytes);
  const pdfName = path.basename(pdfPath);
  const results = [];

  for (let r = 1; r <= runs; r++) {
    console.log(`\n[${mode}] run ${r}/${runs}…`);
    const row = await coldRun(year, mode, bytes, embedded, pdfName, r);
    results.push(row);
    console.log(
      `  ${(row.ms / 1000).toFixed(1)}s | ${row.ok}/${row.n} (${row.pct.toFixed(1)}%)${row.misses.length ? ` | misses: ${row.misses.join(", ")}` : ""}`,
    );
  }

  const pcts = results.map((r) => r.pct);
  const times = results.map((r) => r.ms);
  const missFreq = new Map<string, number>();
  for (const r of results) {
    for (const m of r.misses) missFreq.set(m, (missFreq.get(m) ?? 0) + 1);
  }

  return {
    mode,
    runs: results,
    medianPct: median(pcts),
    meanPct: pcts.reduce((a, b) => a + b, 0) / pcts.length,
    stdPct: stddev(pcts),
    medianMs: median(times),
    missFrequency: Object.fromEntries([...missFreq.entries()].sort((a, b) => b[1] - a[1])),
  };
}

async function main() {
  process.env.VERCEL = "";
  process.env.FREE_OCR_TIMEOUT_MS = process.env.FREE_OCR_TIMEOUT_MS ?? "1200000";
  process.env.FREE_OCR_WORKERS = process.env.FREE_OCR_WORKERS ?? "1";

  const year = Number(arg("--year", "2024"));
  const runs = Number(arg("--runs", "5"));
  const modeArg = arg("--mode");
  const modes: OcrMode[] = modeArg ? [modeArg as OcrMode] : ALL_MODES;
  const docsDir = path.resolve(process.cwd(), process.env.DOCS_DIR ?? "../Documents");

  console.log(`Repeated benchmark: year=${year} runs=${runs} workers=${process.env.FREE_OCR_WORKERS}`);
  const summaries = [];
  for (const mode of modes) {
    summaries.push(await benchMode(year, mode, runs, docsDir));
  }

  const out = { at: new Date().toISOString(), year, runs, summaries };
  const outPath = path.join(process.cwd(), "scripts", `benchmark-repeated-${year}.json`);
  await writeFile(outPath, JSON.stringify(out, null, 2), "utf8");

  console.log("\n========== SUMMARY ==========");
  console.log("mode       | median % | mean % | std | median time");
  for (const s of summaries) {
    console.log(
      `${s.mode.padEnd(10)} | ${s.medianPct.toFixed(1).padStart(6)}% | ${s.meanPct.toFixed(1).padStart(5)}% | ${s.stdPct.toFixed(1).padStart(4)} | ${(s.medianMs / 1000).toFixed(0)}s`,
    );
    if (Object.keys(s.missFrequency).length) {
      console.log(`  miss freq: ${JSON.stringify(s.missFrequency)}`);
    }
  }
  console.log(`Wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
