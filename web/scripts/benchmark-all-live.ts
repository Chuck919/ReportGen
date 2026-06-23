/**
 * Fresh OCR benchmark — all clients vs Excel fixtures (live pipeline = web upload).
 * Usage: npx tsx scripts/benchmark-all-live.ts [mode] [clientId?]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { parseTaxReturn } from "../src/lib/tax-return-parser";
import { scoreAllFields, scorePrimary } from "./lib/tax-benchmark-score";
import { TAX_BENCHMARK_CLIENTS, fixtureKey, type TaxBenchmarkClient } from "./lib/tax-benchmark-clients";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import type { OcrMode } from "../src/lib/tax-return/local-ocr";

const mode: OcrMode = (process.argv[2] as OcrMode) ?? "thorough";
const onlyClient = process.argv[3];

type RowResult = {
  client: string;
  year: number;
  primaryPct: number;
  allPct: number;
  primaryMisses: string[];
  allMisses: string[];
  values: Record<string, number | undefined>;
  sources: Record<string, string | undefined>;
  elapsedMs: number;
};

async function runYear(client: TaxBenchmarkClient, year: number): Promise<RowResult> {
  const docsDir = path.resolve(process.cwd(), client.docsDir);
  const pdfPath = await resolveTaxReturnPdf(docsDir, year);
  const bytes = await readFile(pdfPath);
  const embedded = await getEmbeddedPdfText(bytes);
  const t0 = Date.now();
  const live = await parseTaxReturn(path.basename(pdfPath), bytes, embedded, year, mode);
  const fk = fixtureKey(client, year);
  const primary = scorePrimary(fk, live.values);
  const all = scoreAllFields(fk, live.values);
  return {
    client: client.id,
    year,
    primaryPct: primary.pct,
    allPct: all.pct,
    primaryMisses: primary.misses,
    allMisses: all.misses,
    values: live.values,
    sources: live.fieldSources ?? {},
    elapsedMs: Date.now() - t0,
  };
}

function aggregateMisses(rows: RowResult[], key: "primaryMisses" | "allMisses") {
  const byField = new Map<string, { count: number; examples: string[] }>();
  for (const row of rows) {
    for (const m of row[key]) {
      const field = m.split(":")[0]!;
      const entry = byField.get(field) ?? { count: 0, examples: [] };
      entry.count += 1;
      if (entry.examples.length < 4) entry.examples.push(`${row.client}/${row.year}: ${m}`);
      byField.set(field, entry);
    }
  }
  return [...byField.entries()].sort((a, b) => b[1].count - a[1].count);
}

async function main() {
  const clients = onlyClient
    ? TAX_BENCHMARK_CLIENTS.filter((c) => c.id === onlyClient)
    : TAX_BENCHMARK_CLIENTS;
  if (!clients.length) throw new Error(`Unknown client: ${onlyClient}`);

  const rows: RowResult[] = [];
  console.log(`=== benchmark-all-live mode=${mode} clients=${clients.map((c) => c.id).join(",")} ===\n`);

  for (const client of clients) {
    for (const year of client.years) {
      process.stdout.write(`[${client.id} ${year}] `);
      try {
        const row = await runYear(client, year);
        rows.push(row);
        console.log(
          `primary ${row.primaryPct.toFixed(1)}% all ${row.allPct.toFixed(1)}% (${(row.elapsedMs / 1000).toFixed(0)}s)`,
        );
        if (row.allMisses.length) console.log(`  misses: ${row.allMisses.join("; ")}`);
      } catch (e) {
        console.log(`ERROR: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  const agg = aggregateMisses(rows, "allMisses");
  console.log("\n=== ALL-FIELDS MISS FREQUENCY ===");
  for (const [field, { count, examples }] of agg) {
    console.log(`${field}: ${count}x`);
    for (const ex of examples) console.log(`  ${ex}`);
  }

  const outDir = path.join(process.cwd(), "scripts", "benchmark-output");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `all-live-${mode}-${Date.now()}.json`);
  await writeFile(outPath, JSON.stringify({ mode, rows, agg: Object.fromEntries(agg) }, null, 2));
  console.log(`\nWrote ${outPath}`);

  const perfect = rows.filter((r) => r.allMisses.length === 0).length;
  console.log(`\nSummary: ${perfect}/${rows.length} years at 100% all-fields`);
  process.exit(rows.some((r) => r.allMisses.length > 0) ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
