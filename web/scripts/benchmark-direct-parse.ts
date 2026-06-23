/**
 * Full parse pipeline benchmark — same code path as POST /api/parse-tax-return, no HTTP.
 * Use when dev server / .next is unavailable (OneDrive EPERM, port conflicts).
 *
 * Usage:
 *   npx tsx scripts/benchmark-direct-parse.ts [mode] [clientId?] [year?]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseTaxReturn } from "../src/lib/tax-return-parser";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { scoreAllFields, scorePrimary } from "./lib/tax-benchmark-score";
import { categorizeMiss } from "./lib/tax-benchmark-diagnose";
import { TAX_BENCHMARK_CLIENTS, fixtureKey, type TaxBenchmarkClient } from "./lib/tax-benchmark-clients";
import type { OcrMode } from "../src/lib/tax-return/local-ocr";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { forceExit } from "./lib/force-exit";

const mode = (process.argv[2] ?? "thorough") as OcrMode;
const onlyClient = process.argv[3];
const onlyYear = process.argv[4] ? Number(process.argv[4]) : undefined;

async function runClientYear(client: TaxBenchmarkClient, year: number) {
  const pdfPath = await resolveTaxReturnPdf(path.resolve(process.cwd(), client.docsDir), year);
  const bytes = new Uint8Array(await readFile(pdfPath));
  const embedded = await getEmbeddedPdfText(bytes);
  const t0 = Date.now();
  const result = await parseTaxReturn(path.basename(pdfPath), bytes, embedded, year, mode);
  if (result.ocrText && result.ocrText.length > 500) {
    const cacheDir = path.join(process.cwd(), "scripts", "ocr-cache");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      path.join(cacheDir, `${client.id}-${year}-${mode}.txt`),
      result.ocrText,
      "utf8",
    );
  }
  const elapsedMs = Date.now() - t0;
  const fk = fixtureKey(client, year);
  const primary = scorePrimary(fk, result.values);
  const all = scoreAllFields(fk, result.values);
  const diagnosed = all.missDetails.map((m) =>
    categorizeMiss(m.field, m.expected, m.actual, {
      client: client.id,
      year,
      severity: m.severity,
      errorPct: m.errorPct,
      fieldSource: result.fieldSources?.[m.field] ?? result.debug.opexChosenSource,
      coverage: result.debug.coverage,
      opexCandidates: result.debug.opexCandidates,
    }),
  );
  return {
    client: client.id,
    year,
    primaryPct: primary.pct,
    allPct: all.pct,
    allMisses: all.misses,
    missDetails: all.missDetails,
    diagnosed,
    elapsedMs,
    coverage: result.debug.coverage,
    opexChosenSource: result.debug.opexChosenSource,
    opexCandidateCount: result.debug.opexCandidates?.length ?? 0,
  };
}

async function main() {
  const clients = onlyClient
    ? TAX_BENCHMARK_CLIENTS.filter((c) => c.id === onlyClient)
    : TAX_BENCHMARK_CLIENTS;

  console.log(`=== direct parse benchmark mode=${mode} ===\n`);
  const rows = [];

  for (const client of clients) {
    const years = onlyYear ? client.years.filter((y) => y === onlyYear) : client.years;
    for (const year of years) {
      process.stdout.write(`[${client.id} ${year}] `);
      try {
        const row = await runClientYear(client, year);
        rows.push(row);
        console.log(
          `all ${row.allPct.toFixed(1)}% (${(row.elapsedMs / 1000).toFixed(0)}s) opex=${row.opexChosenSource?.slice(0, 50) ?? "?"}`,
        );
        if (row.allMisses.length) {
          console.log(`  misses: ${row.allMisses.join("; ")}`);
          for (const d of row.diagnosed ?? []) {
            const err = d.errorPct !== null ? ` ${d.errorPct.toFixed(1)}%` : "";
            console.log(`    [${d.severity}/${d.rootCause}] ${d.field}${err}`);
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`FAIL ${msg}`);
        rows.push({ client: client.id, year, primaryPct: 0, allPct: 0, allMisses: [msg], elapsedMs: 0, error: msg });
      }
    }
  }

  const outDir = path.join(process.cwd(), "scripts", "benchmark-output");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `direct-${mode}-${Date.now()}.json`);
  await writeFile(outPath, JSON.stringify({ mode, rows }, null, 2));
  console.log(`\nWrote ${outPath}`);

  const misses = rows.filter((r) => r.allMisses?.length && !("error" in r && r.error));
  forceExit(misses.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  forceExit(2);
});
