/**
 * Score all benchmark clients/years vs Excel fixtures (embedded text only — fast iteration).
 * NOT a substitute for web API benchmark; use for parser debugging only.
 *
 * Usage:
 *   npx tsx scripts/score-all-embedded.ts [clientId?]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { scoreAllFields, scorePrimary } from "./lib/tax-benchmark-score";
import { TAX_BENCHMARK_CLIENTS, fixtureKey, type TaxBenchmarkClient } from "./lib/tax-benchmark-clients";
import { forceExit } from "./lib/force-exit";

const onlyClient = process.argv[2];

function log(msg: string): void {
  process.stdout.write(msg + "\n");
}

async function scoreYear(client: TaxBenchmarkClient, year: number) {
  const label = `${client.id}/${year}`;
  log(`[${label}] resolving PDF…`);
  const docsDir = path.resolve(process.cwd(), client.docsDir);
  const pdfPath = await resolveTaxReturnPdf(docsDir, year);
  log(`[${label}] reading ${path.basename(pdfPath)}…`);
  const bytes = await readFile(pdfPath);
  log(`[${label}] extracting embedded text…`);
  const embedded = await getEmbeddedPdfText(bytes);
  log(`[${label}] parsing (${embedded.length.toLocaleString()} chars)…`);
  const t0 = Date.now();
  const parsed = parseTaxReturnFromText(path.basename(pdfPath), embedded, "", year);
  const fk = fixtureKey(client, year);
  const primary = scorePrimary(fk, parsed.values);
  const all = scoreAllFields(fk, parsed.values);
  const elapsedMs = Date.now() - t0;
  return { client: client.id, year, primaryPct: primary.pct, allPct: all.pct, allMisses: all.misses, elapsedMs };
}

async function main() {
  const clients = onlyClient
    ? TAX_BENCHMARK_CLIENTS.filter((c) => c.id === onlyClient)
    : TAX_BENCHMARK_CLIENTS;

  if (onlyClient && !clients.length) {
    console.error(`Unknown client: ${onlyClient}`);
    process.exit(1);
  }

  log(`=== embedded score (parse path only) clients=${clients.map((c) => c.id).join(", ")} ===\n`);
  const rows = [];

  for (const client of clients) {
    log(`\n# ${client.id}`);
    for (const year of client.years) {
      try {
        const row = await scoreYear(client, year);
        rows.push(row);
        const miss = row.allMisses.length ? ` | ${row.allMisses.join("; ")}` : " | OK";
        log(
          `  ${year}: primary ${row.primaryPct.toFixed(1)}% all ${row.allPct.toFixed(1)}% (${(row.elapsedMs / 1000).toFixed(1)}s)${miss}`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`  ${year}: ERROR ${msg}`);
        rows.push({
          client: client.id,
          year,
          primaryPct: 0,
          allPct: 0,
          allMisses: [msg],
          elapsedMs: 0,
          error: msg,
        });
      }
    }
  }

  const misses = rows.filter((r) => r.allMisses.length > 0 || (r as { error?: string }).error);
  log(`\n--- summary: ${rows.length - misses.length}/${rows.length} clean ---`);

  const outDir = path.join(process.cwd(), "scripts", "benchmark-output");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `embedded-score-${Date.now()}.json`);
  await writeFile(outPath, JSON.stringify({ rows }, null, 2));
  log(`Wrote ${outPath}`);

  forceExit(misses.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  forceExit(2);
});
