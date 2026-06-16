/**
 * Local multi-pass matrix: reuse pass-1 scan, vary gap tier + retry batches.
 * Run: npx tsx scripts/benchmark-multipass-matrix.ts [year]
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import type { OcrMode } from "../src/lib/api/types";
import { VERCEL_MULTIPASS, type MultipassGapTier } from "../src/lib/tax/vercel-multipass-config";
import { mergeOcrPageTexts } from "../src/lib/api/batched-ocr";
import {
  getMissingAttachmentFieldIds,
  getMissingFieldsForNextTier,
  getMissingInputFieldIds,
  getMissingPrimaryFieldIds,
} from "../src/lib/tax/gap-analysis";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { runLocalOcr, runLocalOcrPages, runOcrPlan } from "../src/lib/tax-return/local-ocr";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import {
  TAX_ATTACHMENT_FIELD_IDS,
  WORKBOOK_COMPARISON_FIXTURES,
} from "../src/lib/workbook-comparison-fixtures";
import { TAX_WORKBOOK_ROWS } from "../src/lib/tax-workbook";
import { VERCEL_FUNCTION_MAX_MS } from "../src/lib/tax/resolve-ocr-mode";

const INPUT_IDS = TAX_WORKBOOK_ROWS.filter((r) => r.excelBehavior === "input").map((r) => r.id);
const YEAR = Number(process.argv[2] ?? 2024);
const LIMIT_MS = VERCEL_FUNCTION_MAX_MS - 5000;

type GapTier = MultipassGapTier;

type Strategy = {
  id: string;
  pass1?: OcrMode;
  pass2?: OcrMode;
  gapTier?: GapTier;
  maxBatches: number;
  batchSize: number;
  forcePhase3: boolean;
  singleMode?: OcrMode;
};

const STRATEGIES: Strategy[] = [
  { id: "fast-single", singleMode: "vercel-fast", maxBatches: 0, batchSize: 7, forcePhase3: false },
  { id: "scan-single", singleMode: "vercel-balanced-scan", maxBatches: 0, batchSize: 7, forcePhase3: false },
  { id: "balanced-primary-1x4", pass1: "vercel-balanced-scan", pass2: "vercel-balanced-retry", gapTier: "primary", maxBatches: 1, batchSize: 4, forcePhase3: false },
  { id: "balanced-all-1x4", pass1: "vercel-balanced-scan", pass2: "vercel-balanced-retry", gapTier: "all-input", maxBatches: 1, batchSize: 4, forcePhase3: false },
  { id: "balanced-all-2x4", pass1: "vercel-balanced-scan", pass2: "vercel-balanced-retry", gapTier: "all-input", maxBatches: 2, batchSize: 4, forcePhase3: false },
  { id: "balanced-all-2x6", pass1: "vercel-balanced-scan", pass2: "vercel-balanced-retry", gapTier: "all-input", maxBatches: 2, batchSize: 6, forcePhase3: false },
  { id: "thorough-tier-1x7", pass1: "vercel-balanced-scan", pass2: "vercel-thorough-retry", gapTier: "primary+attach", maxBatches: 1, batchSize: 7, forcePhase3: true },
  { id: "thorough-tier-3x7", pass1: "vercel-balanced-scan", pass2: "vercel-thorough-retry", gapTier: "primary+attach", maxBatches: 3, batchSize: 7, forcePhase3: true },
  { id: "thorough-all-3x7", pass1: "vercel-balanced-scan", pass2: "vercel-thorough-retry", gapTier: "all-input", maxBatches: 3, batchSize: 7, forcePhase3: true },
  { id: "pass1-wide-single", singleMode: "vercel-pass1-wide", maxBatches: 0, batchSize: 7, forcePhase3: false },
  { id: "balanced-config-2x", pass1: "vercel-balanced-scan", pass2: "vercel-balanced-retry", gapTier: "primary+attach", maxBatches: 2, batchSize: 5, forcePhase3: false },
  { id: "thorough-wide-3x", pass1: "vercel-pass1-wide", pass2: "vercel-thorough-retry", gapTier: "primary+attach", maxBatches: 3, batchSize: 7, forcePhase3: true },
];

function scoreFields(
  year: number,
  values: Record<string, number | undefined>,
  scope: "primary" | "all-input",
) {
  const exp = WORKBOOK_COMPARISON_FIXTURES.tax[`KCF MAIN CURRENT EXCEL.xlsx / ${year}`]?.values;
  if (!exp) throw new Error(`No fixture for ${year}`);
  let ok = 0;
  let n = 0;
  const misses: string[] = [];
  for (const id of INPUT_IDS) {
    if (scope === "primary" && TAX_ATTACHMENT_FIELD_IDS.has(id)) continue;
    const expected = exp[id];
    if (expected === undefined) continue;
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

function ocrPageNumbers(text: string): number[] {
  const nums = new Set<number>();
  for (const m of text.matchAll(/--- OCR PAGE (\d+)/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) nums.add(n);
  }
  return Array.from(nums).sort((a, b) => a - b);
}

function gapFields(
  parsed: ReturnType<typeof parseTaxReturnFromText>,
  tier: GapTier,
): string[] {
  const col = { values: parsed.values, confidence: parsed.confidence, warnings: parsed.warnings };
  if (tier === "primary") return getMissingPrimaryFieldIds(col);
  if (tier === "primary+attach") return getMissingFieldsForNextTier(col, "vercel-thorough");
  return getMissingInputFieldIds(col);
}

async function embeddedText(bytes: Uint8Array) {
  const p = new PDFParse({ data: Buffer.from(bytes) });
  const t = await p.getText();
  await p.destroy?.();
  return t.text ?? "";
}

async function runStrategy(
  strategy: Strategy,
  bytes: Uint8Array,
  embedded: string,
  pdfName: string,
  year: number,
  pass1Cache?: { text: string; ms: number },
) {
  const t0 = Date.now();
  let ocrText: string;
  let pass1Ms = 0;
  let pass2Ms = 0;
  let batchesRun = 0;

  if (strategy.singleMode) {
    const ocr = await runLocalOcr(bytes, { profile: "tax", mode: strategy.singleMode });
    ocrText = ocr.text;
    pass1Ms = ocr.timingMs?.total ?? Date.now() - t0;
  } else {
    if (pass1Cache) {
      ocrText = pass1Cache.text;
      pass1Ms = pass1Cache.ms;
    } else {
      const t1 = Date.now();
      const ocr = await runLocalOcr(bytes, { profile: "tax", mode: strategy.pass1! });
      ocrText = ocr.text;
      pass1Ms = Date.now() - t1;
    }

    const parsed1 = parseTaxReturnFromText(pdfName, embedded, ocrText, year);
    const missing = gapFields(parsed1, strategy.gapTier!);
    if (missing.length && strategy.pass2) {
      const plan = await runOcrPlan(bytes, strategy.pass2, {
        deltaFrom: strategy.pass1,
        alreadyPages: ocrPageNumbers(ocrText),
        missingFields: missing,
      });
      const batches = (plan.batches.length ? plan.batches : chunk(plan.targets, strategy.batchSize)).slice(
        0,
        strategy.maxBatches,
      );
      const t2 = Date.now();
      for (const pages of batches) {
        if (!pages.length) continue;
        const delta = await runLocalOcrPages(bytes, pages, {
          profile: "tax",
          mode: strategy.pass2,
          forcePhase3: strategy.forcePhase3,
        });
        ocrText = mergeOcrPageTexts([ocrText, delta.text]);
        batchesRun++;
      }
      pass2Ms = Date.now() - t2;
    }
  }

  const totalMs = Date.now() - t0;
  const parsed = parseTaxReturnFromText(pdfName, embedded, ocrText, year);
  const primary = scoreFields(year, parsed.values, "primary");
  const allInput = scoreFields(year, parsed.values, "all-input");
  return {
    id: strategy.id,
    totalMs,
    pass1Ms,
    pass2Ms,
    batchesRun,
    under: totalMs < LIMIT_MS,
    primary,
    allInput,
  };
}

function chunk(items: number[], size: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function main() {
  process.env.VERCEL = "1";
  process.env.FREE_OCR_WORKERS = "1";

  const docsDir = path.resolve(process.cwd(), "..", "Documents");
  const pdfPath = await resolveTaxReturnPdf(docsDir, YEAR);
  const pdfName = path.basename(pdfPath);
  const bytes = await readFile(pdfPath);
  const embedded = await embeddedText(bytes);

  console.log("\n=== configured UI plans ===");
for (const [mode, plan] of Object.entries(VERCEL_MULTIPASS)) {
  console.log(`  ${mode}: pass1=${plan.pass1} pass2=${plan.pass2} batches<=${plan.maxBatches} gap=${plan.gapTier}`);
}

console.log(`\n=== multi-pass matrix year=${YEAR} pdf=${pdfName} ===\n`);

  // Pass 1 once for all multi-pass strategies
  console.log("[pass1 cache] vercel-balanced-scan…");
  const t1 = Date.now();
  const scan = await runLocalOcr(bytes, { profile: "tax", mode: "vercel-balanced-scan" });
  const pass1Cache = { text: scan.text, ms: Date.now() - t1 };
  const scanParsed = parseTaxReturnFromText(pdfName, embedded, scan.text, YEAR);
  console.log(
    `  scan ${(pass1Cache.ms / 1000).toFixed(1)}s primary ${scoreFields(YEAR, scanParsed.values, "primary").ok}/${scoreFields(YEAR, scanParsed.values, "primary").n} all ${scoreFields(YEAR, scanParsed.values, "all-input").ok}/${scoreFields(YEAR, scanParsed.values, "all-input").n}`,
  );
  console.log(`  gaps primary=${getMissingPrimaryFieldIds(scanParsed).length} attach=${getMissingAttachmentFieldIds(scanParsed).length} all=${getMissingInputFieldIds(scanParsed).length}\n`);

  const rows: Awaited<ReturnType<typeof runStrategy>>[] = [];

  for (const s of STRATEGIES) {
    process.stdout.write(`[${s.id}] … `);
    const useCache = s.pass1 === "vercel-balanced-scan" ? pass1Cache : undefined;
    const r = await runStrategy(s, bytes, embedded, pdfName, YEAR, useCache);
    rows.push(r);
    console.log(
      `${(r.totalMs / 1000).toFixed(1)}s p1=${(r.pass1Ms / 1000).toFixed(1)} p2=${(r.pass2Ms / 1000).toFixed(1)} b=${r.batchesRun} primary ${r.primary.ok}/${r.primary.n} (${r.primary.pct.toFixed(0)}%) all ${r.allInput.ok}/${r.allInput.n} (${r.allInput.pct.toFixed(0)}%)`,
    );
    if (r.allInput.misses.length) console.log(`  all misses: ${r.allInput.misses.slice(0, 6).join("; ")}`);
  }

  console.log("\n=== summary (sorted by all-input accuracy, then time) ===");
  const sorted = [...rows].sort((a, b) => b.allInput.pct - a.allInput.pct || a.totalMs - b.totalMs);
  for (const r of sorted) {
    const timeOk = r.under ? "OK" : "SLOW";
    console.log(
      `${r.id.padEnd(26)} ${(r.totalMs / 1000).toFixed(1).padStart(6)}s ${timeOk.padEnd(4)} primary ${r.primary.pct.toFixed(0).padStart(3)}% all ${r.allInput.pct.toFixed(0).padStart(3)}% batches=${r.batchesRun}`,
    );
  }

  const outPath = path.join(process.cwd(), "scripts", "benchmark-multipass-matrix.json");
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(
    outPath,
    JSON.stringify({ at: new Date().toISOString(), year: YEAR, limitMs: LIMIT_MS, rows }, null, 2),
    "utf8",
  );
  console.log(`\nWrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
