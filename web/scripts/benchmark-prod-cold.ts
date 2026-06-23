/**
 * Cold-start production benchmark — full UI pipeline (single + multi-pass).
 * Run: npx tsx scripts/benchmark-prod-cold.ts [baseUrl]
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import {
  TAX_ATTACHMENT_FIELD_IDS,
  WORKBOOK_COMPARISON_FIXTURES,
} from "../src/lib/workbook-comparison-fixtures";
import { TAX_WORKBOOK_ROWS } from "../src/lib/tax-workbook";
import { VERCEL_FUNCTION_MAX_MS } from "../src/lib/tax/resolve-ocr-mode";
import {
  PROD_CANDIDATES,
  runMultipass,
  runSinglePass,
  type CandidatePlan,
} from "./lib/prod-pipeline";

const BASE = process.argv[2] ?? "https://reportgen-three.vercel.app";
if (!process.env.OCR_DEPLOY && !BASE.includes("vercel.app")) {
  process.env.OCR_DEPLOY = "vps";
}
const YEARS = [2023, 2024, 2025] as const;
const LIMIT_MS = VERCEL_FUNCTION_MAX_MS - 5000;
const INPUT_IDS = TAX_WORKBOOK_ROWS.filter((r) => r.excelBehavior === "input").map((r) => r.id);

function score(year: number, values: Record<string, number | undefined>, scope: "primary" | "all") {
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

async function runCandidate(base: string, pdfPath: string, year: number, c: CandidatePlan) {
  const r =
    c.kind === "single" && c.ocrMode
      ? await runSinglePass(base, pdfPath, c.id, c.ocrMode)
      : c.plan
        ? await runMultipass(base, pdfPath, c.id, c.plan)
        : null;
  if (!r) throw new Error(`bad candidate ${c.id}`);
  const primary = r.error ? { ok: 0, n: 0, pct: 0, misses: [r.error] } : score(year, r.parsed.values, "primary");
  const allInput = r.error ? { ok: 0, n: 0, pct: 0, misses: [] } : score(year, r.parsed.values, "all");
  return {
    ...r,
    year,
    under: r.totalMs < LIMIT_MS,
    primary,
    allInput,
  };
}

async function main() {
  const docsDir = path.resolve(process.cwd(), "..", "Documents");
  const rows: Awaited<ReturnType<typeof runCandidate>>[] = [];

  console.log(`=== PROD COLD START: ${BASE} ===\n`);

  for (const year of YEARS) {
    const pdfPath = await resolveTaxReturnPdf(docsDir, year);
    console.log(`\n--- ${year} ${path.basename(pdfPath)} ---`);
    for (const c of PROD_CANDIDATES) {
      process.stdout.write(`  [${c.id}] `);
      const r = await runCandidate(BASE, pdfPath, year, c);
      rows.push(r);
      if (r.error) {
        console.log(`FAIL ${(r.totalMs / 1000).toFixed(0)}s — ${r.error.slice(0, 80)}`);
      } else {
        console.log(
          `${(r.totalMs / 1000).toFixed(0)}s p2=${r.batchesRun}b primary ${r.primary.ok}/${r.primary.n} (${r.primary.pct.toFixed(0)}%) all ${r.allInput.ok}/${r.allInput.n} (${r.allInput.pct.toFixed(0)}%)`,
        );
      }
    }
  }

  console.log("\n=== SUMMARY (avg primary % / avg time) ===");
  for (const c of PROD_CANDIDATES) {
    const subset = rows.filter((r) => r.id === c.id && !r.error);
    const avgPct = subset.length ? subset.reduce((s, r) => s + r.primary.pct, 0) / subset.length : 0;
    const avgAll = subset.length ? subset.reduce((s, r) => s + r.allInput.pct, 0) / subset.length : 0;
    const avgMs = subset.length ? subset.reduce((s, r) => s + r.totalMs, 0) / subset.length : 0;
    const fails = rows.filter((r) => r.id === c.id && r.error).length;
    console.log(
      `${c.id.padEnd(16)} avg ${(avgMs / 1000).toFixed(0)}s  primary ${avgPct.toFixed(0)}%  all ${avgAll.toFixed(0)}%  fails=${fails}`,
    );
  }

  const outPath = path.join(process.cwd(), "scripts", "benchmark-prod-cold.json");
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(
    outPath,
    JSON.stringify({ at: new Date().toISOString(), base: BASE, limitMs: LIMIT_MS, rows }, null, 2),
    "utf8",
  );
  console.log(`\nWrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
