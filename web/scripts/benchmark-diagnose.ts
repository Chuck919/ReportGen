/**
 * Categorized benchmark report — every miss tagged OCR / parse / selection / mapping.
 *
 * Usage:
 *   npx tsx scripts/benchmark-diagnose.ts [mode] [baseUrl] [clientId?] [--holdout=sssi]
 *   npx tsx scripts/benchmark-diagnose.ts thorough --direct [clientId?] [--holdout=sssi]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Agent, fetch as undiciFetch } from "undici";
import { parseTaxReturn } from "../src/lib/tax-return-parser";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { scoreAllFields } from "./lib/tax-benchmark-score";
import { bucketSummary, categorizeMiss, type DiagnosedMiss } from "./lib/tax-benchmark-diagnose";
import { TAX_BENCHMARK_CLIENTS, fixtureKey, type TaxBenchmarkClient } from "./lib/tax-benchmark-clients";
import type { OcrMode } from "../src/lib/tax-return/local-ocr";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { forceExit } from "./lib/force-exit";

const argv = process.argv.slice(2);
const direct = argv.includes("--direct");
const holdoutArg = argv.find((a) => a.startsWith("--holdout="));
const holdoutClient = holdoutArg?.split("=")[1];
const positional = argv.filter((a) => !a.startsWith("--"));
const mode = (positional[0] ?? "thorough") as OcrMode;
const base = direct ? "" : (positional[1] ?? "http://localhost:3000");
const onlyClient = direct ? positional[1] : positional[2];
const timeoutMs = Number(process.env.BENCHMARK_TIMEOUT_MS) || 25 * 60_000;

type ParseRow = {
  values: Record<string, number>;
  fieldSources?: Record<string, string>;
  debug?: {
    coverage?: import("../src/lib/tax-return/ocr-coverage-diagnostics").OcrCoverageDiagnostics;
    opexCandidates?: import("../src/lib/tax-return/opex-candidate-ranking").OpexCandidate[];
    opexChosenSource?: string;
  };
};

async function parseDirect(client: TaxBenchmarkClient, year: number): Promise<ParseRow | { error: string }> {
  const pdfPath = await resolveTaxReturnPdf(path.resolve(process.cwd(), client.docsDir), year);
  const bytes = new Uint8Array(await readFile(pdfPath));
  const embedded = await getEmbeddedPdfText(bytes);
  const result = await parseTaxReturn(path.basename(pdfPath), bytes, embedded, year, mode);
  return {
    values: result.values,
    fieldSources: result.fieldSources,
    debug: result.debug,
  };
}

async function parseHttp(
  client: TaxBenchmarkClient,
  year: number,
): Promise<ParseRow | { error: string }> {
  const docsDir = path.resolve(process.cwd(), client.docsDir);
  const pdfPath = await resolveTaxReturnPdf(docsDir, year);
  const bytes = await readFile(pdfPath);
  const fd = new FormData();
  fd.append("files", new Blob([bytes], { type: "application/pdf" }), path.basename(pdfPath));
  fd.append("ocrMode", mode);

  const agent = new Agent({ connectTimeout: 60_000, headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
  const res = await undiciFetch(`${base}/api/parse-tax-return`, {
    method: "POST",
    body: fd,
    dispatcher: agent,
  });
  const json = (await res.json()) as {
    parsed?: ParseRow[];
    error?: string;
  };
  const row = json.parsed?.[0];
  if (!row) return { error: json.error ?? "no parsed row" };
  return row;
}

async function diagnoseClientYear(
  client: TaxBenchmarkClient,
  year: number,
): Promise<{ allPct: number; misses: DiagnosedMiss[]; elapsedMs: number; error?: string }> {
  const t0 = Date.now();
  try {
    const row = direct ? await parseDirect(client, year) : await parseHttp(client, year);
    if ("error" in row) {
      return { allPct: 0, misses: [], elapsedMs: Date.now() - t0, error: row.error };
    }

    const fk = fixtureKey(client, year);
    const score = scoreAllFields(fk, row.values);
    const diagnosed: DiagnosedMiss[] = score.missDetails.map((m) =>
      categorizeMiss(m.field, m.expected, m.actual, {
        client: client.id,
        year,
        severity: m.severity,
        errorPct: m.errorPct,
        fieldSource: row.fieldSources?.[m.field] ?? row.debug?.opexChosenSource,
        coverage: row.debug?.coverage,
        opexCandidates: row.debug?.opexCandidates,
      }),
    );

    return { allPct: score.pct, misses: diagnosed, elapsedMs: Date.now() - t0 };
  } catch (e) {
    return {
      allPct: 0,
      misses: [],
      elapsedMs: Date.now() - t0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function main() {
  let clients = onlyClient
    ? TAX_BENCHMARK_CLIENTS.filter((c) => c.id === onlyClient)
    : TAX_BENCHMARK_CLIENTS;

  if (holdoutClient) {
    console.log(`Holdout: ${holdoutClient} (excluded)\n`);
    clients = clients.filter((c) => c.id !== holdoutClient);
  }

  console.log(
    `=== benchmark-diagnose mode=${mode} ${direct ? "direct-parse" : `base=${base}`} ===\n`,
  );

  const allMisses: DiagnosedMiss[] = [];
  const rows: Array<{ client: string; year: number; allPct: number; error?: string }> = [];

  for (const client of clients) {
    for (const year of client.years) {
      process.stdout.write(`[${client.id} ${year}] `);
      const r = await diagnoseClientYear(client, year);
      rows.push({ client: client.id, year, allPct: r.allPct, error: r.error });
      allMisses.push(...r.misses);
      if (r.error) {
        console.log(`FAIL ${r.error}`);
      } else {
        console.log(`${r.allPct.toFixed(1)}% (${(r.elapsedMs / 1000).toFixed(0)}s) misses=${r.misses.length}`);
        for (const m of r.misses) {
          const err = m.errorPct !== null ? ` err=${m.errorPct.toFixed(1)}%` : "";
          const better = m.betterCandidate
            ? ` better=${m.betterCandidate.value}@${m.betterCandidate.source.slice(0, 40)}`
            : "";
          console.log(
            `  [${m.severity}] ${m.field}: ${m.rootCause} exp=${m.expected} got=${m.got ?? "blank"}${err}${better}`,
          );
        }
      }
    }
  }

  const buckets = bucketSummary(allMisses);
  console.log("\n--- error buckets ---");
  console.log(JSON.stringify(buckets, null, 2));

  const outDir = path.join(process.cwd(), "scripts", "benchmark-output");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `diagnose-${direct ? "direct-" : ""}${mode}-${Date.now()}.json`);
  await writeFile(
    outPath,
    JSON.stringify({ mode, direct, holdoutClient, rows, buckets, misses: allMisses }, null, 2),
  );
  console.log(`\nWrote ${outPath}`);
  forceExit(allMisses.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  forceExit(2);
});
