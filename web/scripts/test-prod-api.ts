/**
 * Hit deployed /api/parse-tax-return with real PDFs (all OCR modes).
 * Run: npx tsx scripts/test-prod-api.ts [baseUrl] [year]
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { OcrMode } from "../src/lib/api/types";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import {
  TAX_ATTACHMENT_FIELD_IDS,
  WORKBOOK_COMPARISON_FIXTURES,
} from "../src/lib/workbook-comparison-fixtures";
import { TAX_WORKBOOK_ROWS } from "../src/lib/tax-workbook";

const INPUT_IDS = TAX_WORKBOOK_ROWS.filter((r) => r.excelBehavior === "input").map((r) => r.id);
const MODES: OcrMode[] = ["fast", "balanced", "thorough"];
const BASE = process.argv[2] ?? "https://reportgen.duckdns.org";
const YEAR = Number(process.argv[3] ?? 2024);
const MIN_PCT = Number(process.env.PROD_MIN_PRIMARY_PCT ?? 85);

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
    if (!hit) misses.push(`${id}: exp ${expected}, got ${actual ?? "blank"}`);
    else ok++;
  }
  return { ok, n, pct: n ? (ok / n) * 100 : 0, misses };
}

async function postMode(pdfPath: string, mode: OcrMode) {
  const buf = await readFile(pdfPath);
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "application/pdf" }), path.basename(pdfPath));
  form.append("ocrMode", mode);

  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/parse-tax-return?format=json`, {
    method: "POST",
    body: form,
  });
  const ms = Date.now() - t0;
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${mode}: HTTP ${res.status} non-JSON (${ms}ms): ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    throw new Error(`${mode}: HTTP ${res.status} (${(ms / 1000).toFixed(1)}s): ${JSON.stringify(body).slice(0, 400)}`);
  }
  const parsed = body.parsed as Array<{ year: number; values: Record<string, number> }> | undefined;
  const table = body.table as { tsv?: string; rows?: unknown[]; columns?: number[] } | undefined;
  const first = parsed?.[0];
  if (!first) throw new Error(`${mode}: no parsed result`);
  const score = scorePrimary(first.year, first.values);
  const tsvLines = (table?.tsv ?? "").split("\n").filter(Boolean);
  return { mode, ms, year: first.year, score, tsvLines: tsvLines.length, fieldCount: Object.keys(first.values).length };
}

async function main() {
  const docsDir = path.resolve(process.cwd(), "..", "Documents");
  const pdfPath = await resolveTaxReturnPdf(docsDir, YEAR);
  console.log(`=== prod API: ${BASE} year=${YEAR} ===`);
  console.log(`pdf: ${path.basename(pdfPath)}\n`);

  let failed = 0;
  for (const mode of MODES) {
    process.stdout.write(`[${mode}] uploading… `);
    try {
      const r = await postMode(pdfPath, mode);
      const ok = r.score.pct >= MIN_PCT && r.tsvLines === TAX_WORKBOOK_ROWS.length;
      console.log(
        `${(r.ms / 1000).toFixed(1)}s | primary ${r.score.ok}/${r.score.n} (${r.score.pct.toFixed(1)}%) | tsv ${r.tsvLines} lines | fields ${r.fieldCount} ${ok ? "PASS" : "FAIL"}`,
      );
      if (!ok) {
        failed++;
        if (r.score.misses.length) console.log(`  misses: ${r.score.misses.slice(0, 5).join("; ")}`);
        if (r.tsvLines !== TAX_WORKBOOK_ROWS.length) {
          console.log(`  tsv lines ${r.tsvLines} expected ${TAX_WORKBOOK_ROWS.length}`);
        }
      }
    } catch (e) {
      failed++;
      console.log("FAIL");
      console.error(`  ${e instanceof Error ? e.message : e}`);
    }
  }

  console.log(`\n=== prod API: ${MODES.length - failed}/${MODES.length} modes passed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
