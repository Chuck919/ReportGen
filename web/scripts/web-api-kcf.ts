/**
 * Hit live /api/parse-tax-return like the web UI does.
 * Usage: npx tsx scripts/web-api-kcf.ts [year] [mode]
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { scorePrimary, scoreAllFields } from "./lib/tax-benchmark-score";
import { TAX_BENCHMARK_CLIENTS, fixtureKey } from "./lib/tax-benchmark-clients";
import { TAX_WORKBOOK_ROWS } from "../src/lib/tax-workbook";

const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === "kcf")!;
const year = Number(process.argv[2] ?? 2023);
const mode = process.argv[3] ?? "thorough";
const base = process.argv[4] ?? "http://localhost:3000";

async function main() {
  const docsDir = path.resolve(process.cwd(), client.docsDir);
  const pdfPath = await resolveTaxReturnPdf(docsDir, year);
  const bytes = await readFile(pdfPath);
  const blob = new Blob([bytes], { type: "application/pdf" });
  const fd = new FormData();
  fd.append("files", blob, path.basename(pdfPath));
  fd.append("ocrMode", mode);

  console.log(`POST ${base}/api/parse-tax-return mode=${mode} file=${path.basename(pdfPath)}`);
  const t0 = Date.now();
  const timeoutMs = 25 * 60_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    // Node's default fetch headers timeout is 300s; thorough OCR often exceeds that.
    const prev = process.env.UNDICI_HEADERS_TIMEOUT;
    process.env.UNDICI_HEADERS_TIMEOUT = String(timeoutMs);
    try {
      res = await fetch(`${base}/api/parse-tax-return`, {
        method: "POST",
        body: fd,
        signal: controller.signal,
      });
    } finally {
      if (prev === undefined) delete process.env.UNDICI_HEADERS_TIMEOUT;
      else process.env.UNDICI_HEADERS_TIMEOUT = prev;
    }
  } finally {
    clearTimeout(timer);
  }
  const json = (await res.json()) as {
    parsed?: Array<{ year: number; values: Record<string, number>; fieldSources?: Record<string, string> }>;
    error?: string;
    partial?: boolean;
  };
  console.log(`status=${res.status} ${((Date.now() - t0) / 1000).toFixed(1)}s partial=${json.partial}`);
  if (!res.ok) throw new Error(json.error ?? "API failed");

  const row = json.parsed?.[0];
  if (!row) throw new Error("No parsed row");

  const score = scorePrimary(fixtureKey(client, year), row.values);
  const allScore = scoreAllFields(fixtureKey(client, year), row.values);
  console.log(`primary: ${score.ok}/${score.n} (${score.pct.toFixed(1)}%)`);
  console.log(`all fields: ${allScore.ok}/${allScore.n} (${allScore.pct.toFixed(1)}%)`);
  console.log("amortization:", row.values.amortization, row.fieldSources?.amortization);
  console.log("depreciation:", row.values.depreciation, row.fieldSources?.depreciation);

  if (score.misses.length) {
    console.log("\nMISSES:");
    for (const m of score.misses) {
      const id = m.split(":")[0]!;
      console.log(`  ${m} | src=${row.fieldSources?.[id]}`);
    }
  }

  const exp = (await import("../src/lib/workbook-comparison-fixtures")).WORKBOOK_COMPARISON_FIXTURES.tax[
    fixtureKey(client, year)
  ]!.values;
  const inputIds = TAX_WORKBOOK_ROWS.filter((r) => r.excelBehavior === "input").map((r) => r.id);
  console.log("\nALL INPUT FIELDS:");
  for (const id of inputIds) {
    const ev = exp[id];
    const av = row.values[id];
    if (ev === undefined && av === undefined) continue;
    const ok = ev === undefined ? true : ev === 0 ? av === 0 || av === undefined : av !== undefined && Math.abs(av - ev) / Math.abs(ev) <= 0.01;
    if (!ok || id === "amortization" || id === "depreciation") {
      console.log(`  ${id}: exp=${ev ?? "-"} got=${av ?? "blank"} ${ok ? "OK" : "MISS"} (${row.fieldSources?.[id] ?? ""})`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
