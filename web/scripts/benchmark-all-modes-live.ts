/**
 * Live OCR benchmark across fast / balanced / thorough — accuracy + wall time + workbook math.
 *
 * Usage:
 *   npx tsx scripts/benchmark-all-modes-live.ts [mode?]
 *   npx tsx scripts/benchmark-all-modes-live.ts fast
 *
 * Omit mode to run all three sequentially (expect ~3–6 h for 15 client-years × 3 modes).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { parseTaxReturn } from "../src/lib/tax-return-parser";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import type { OcrMode } from "../src/lib/tax-return/local-ocr";
import {
  scoreAllFieldsExcludingOpexSlots,
  scoreOpexAmountsOnly,
} from "./lib/tax-benchmark-score";
import { TAX_BENCHMARK_CLIENTS, fixtureKey } from "./lib/tax-benchmark-clients";
import { forceExit } from "./lib/force-exit";
import { auditWorkbookMath } from "./lib/workbook-math-audit";
import { applyOperatingExpensesToSingleYear } from "../src/lib/tax/operating-expenses";

const ALL_MODES: OcrMode[] = ["fast", "balanced", "thorough"];
const modeArg = process.argv[2];
const MODES: OcrMode[] =
  modeArg && ALL_MODES.includes(modeArg as OcrMode) ? [modeArg as OcrMode] : ALL_MODES;
const onlyClient = process.argv[3];

type RowResult = {
  client: string;
  year: number;
  mode: OcrMode;
  fieldPct: number;
  opexAmountPct: number;
  misses: string[];
  elapsedMs: number;
  ocrPageCount?: number;
  mathIssues: ReturnType<typeof auditWorkbookMath>;
  error?: string;
};

async function runYear(client: (typeof TAX_BENCHMARK_CLIENTS)[number], year: number, mode: OcrMode): Promise<RowResult> {
  const docsDir = path.resolve(process.cwd(), client.docsDir);
  const pdfPath = await resolveTaxReturnPdf(docsDir, year);
  const bytes = await readFile(pdfPath);
  const embedded = await getEmbeddedPdfText(bytes);
  const t0 = Date.now();
  try {
    const live = await parseTaxReturn(path.basename(pdfPath), bytes, embedded, year, mode);
    const aligned = applyOperatingExpensesToSingleYear({
      values: live.values,
      confidence: live.confidence,
      fieldSources: live.fieldSources,
      operatingExpenseLines: live.operatingExpenseLines,
    });
    const values = { ...live.values, ...aligned.values };
    const fk = fixtureKey(client, year);
    const fields = scoreAllFieldsExcludingOpexSlots(fk, values);
    const opex = scoreOpexAmountsOnly(fk, values);
    const mathIssues = auditWorkbookMath(values);
    return {
      client: client.id,
      year,
      mode,
      fieldPct: fields.pct,
      opexAmountPct: opex.pct,
      misses: [...fields.misses, ...opex.misses],
      elapsedMs: Date.now() - t0,
      ocrPageCount: live.debug.ocrPageCount,
      mathIssues,
    };
  } catch (e) {
    return {
      client: client.id,
      year,
      mode,
      fieldPct: 0,
      opexAmountPct: 0,
      misses: [],
      elapsedMs: Date.now() - t0,
      mathIssues: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function summarizeMode(rows: RowResult[]) {
  const ok = rows.filter((r) => !r.error);
  const avgField = ok.length ? ok.reduce((s, r) => s + r.fieldPct, 0) / ok.length : 0;
  const avgOpex = ok.length ? ok.reduce((s, r) => s + r.opexAmountPct, 0) / ok.length : 0;
  const totalMs = rows.reduce((s, r) => s + r.elapsedMs, 0);
  const avgMs = rows.length ? totalMs / rows.length : 0;
  const missCount = ok.filter((r) => r.misses.length > 0).length;
  const mathCount = ok.filter((r) => r.mathIssues.length > 0).length;
  return { avgField, avgOpex, totalMs, avgMs, missCount, mathCount, errors: rows.filter((r) => r.error).length };
}

async function main() {
  const clients = onlyClient
    ? TAX_BENCHMARK_CLIENTS.filter((c) => c.id === onlyClient)
    : TAX_BENCHMARK_CLIENTS;

  console.log(`=== LIVE OCR MULTI-MODE BENCHMARK modes=${MODES.join(",")} ===\n`);
  const allRows: RowResult[] = [];

  for (const mode of MODES) {
    console.log(`\n── mode: ${mode.toUpperCase()} ──\n`);
    const modeRows: RowResult[] = [];
    for (const client of clients) {
      for (const year of client.years) {
        process.stdout.write(`[${mode} ${client.id} ${year}] `);
        const row = await runYear(client, year, mode);
        modeRows.push(row);
        allRows.push(row);
        if (row.error) {
          console.log(`ERROR ${row.error} (${(row.elapsedMs / 1000).toFixed(0)}s)`);
        } else {
          const math = row.mathIssues.length ? ` math=${row.mathIssues.length}` : "";
          console.log(
            `fields ${row.fieldPct.toFixed(1)}% opex ${row.opexAmountPct.toFixed(1)}% (${(row.elapsedMs / 1000).toFixed(0)}s)${math}`,
          );
          if (row.misses.length) console.log(`  misses: ${row.misses.join("; ")}`);
          if (row.mathIssues.length) {
            for (const m of row.mathIssues) console.log(`  math: ${m.kind}: ${m.detail}`);
          }
        }
      }
    }
    const s = summarizeMode(modeRows);
    console.log(
      `\n${mode} summary: avgField=${s.avgField.toFixed(1)}% avgOpex=${s.avgOpex.toFixed(1)}% ` +
        `misses=${s.missCount}/${modeRows.length} mathIssues=${s.mathCount} ` +
        `avgTime=${(s.avgMs / 1000).toFixed(0)}s total=${(s.totalMs / 60000).toFixed(1)}min errors=${s.errors}`,
    );
  }

  if (MODES.length > 1) {
    console.log("\n── MODE COMPARISON ──");
    for (const mode of MODES) {
      const s = summarizeMode(allRows.filter((r) => r.mode === mode));
      console.log(
        `${mode.padEnd(9)} field ${s.avgField.toFixed(1)}%  opex ${s.avgOpex.toFixed(1)}%  avg ${(s.avgMs / 1000).toFixed(0)}s/PDF  misses ${s.missCount}`,
      );
    }
    const fast = summarizeMode(allRows.filter((r) => r.mode === "fast"));
    const bal = summarizeMode(allRows.filter((r) => r.mode === "balanced"));
    const thor = summarizeMode(allRows.filter((r) => r.mode === "thorough"));
    if (fast.avgMs && bal.avgMs && thor.avgMs) {
      const speedOk = fast.avgMs <= bal.avgMs && bal.avgMs <= thor.avgMs;
      const accOk = thor.avgField >= bal.avgField - 0.5 && bal.avgField >= fast.avgField - 0.5;
      console.log(`\nTiming order (fast≤balanced≤thorough): ${speedOk ? "OK" : "UNEXPECTED"}`);
      console.log(`Accuracy order (thorough≥balanced≥fast): ${accOk ? "OK" : "mixed — see per-client rows"}`);
    }
  }

  const outDir = path.join(process.cwd(), "scripts", "benchmark-output");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `all-modes-live-${MODES.join("-")}-${Date.now()}.json`);
  await writeFile(outPath, JSON.stringify({ modes: MODES, rows: allRows }, null, 2));
  console.log(`\nWrote ${outPath}`);

  forceExit(allRows.some((r) => r.error || r.misses.length > 0) ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  forceExit(2);
});
