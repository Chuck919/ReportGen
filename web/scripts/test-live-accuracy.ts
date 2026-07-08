/**
 * Live API smoke test: one PDF, real OCR, score vs integrator fixtures.
 * Usage: npx tsx scripts/test-live-accuracy.ts <clientId> <year> [mode]
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fetch as undiciFetch, Agent } from "undici";
import { TAX_BENCHMARK_CLIENTS } from "./lib/tax-benchmark-clients";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import {
  scoreAllFieldsExcludingOpexSlots,
  scoreOpexAmountsOnly,
} from "./lib/tax-benchmark-score";
import changwenFixtures from "./changwen-fixtures.json";
import { WORKBOOK_COMPARISON_FIXTURES } from "../src/lib/workbook-comparison-fixtures";

type ParsedRow = {
  year: number;
  values: Record<string, number | undefined>;
  fieldSources?: Record<string, string>;
  debug?: {
    ocrPageCount?: number;
    ocrTimingMs?: Record<string, number>;
    ocrLogs?: string[];
  };
};

const ALL_FIXTURES: Record<string, { year: number; values: Record<string, number> }> = {
  ...WORKBOOK_COMPARISON_FIXTURES.tax,
  ...(changwenFixtures as Record<string, { year: number; values: Record<string, number> }>),
};

async function main() {
  const clientId = process.argv[2] ?? "arizona-sun";
  const year = Number(process.argv[3] ?? 2025);
  const mode = process.argv[4] ?? "balanced";
  const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === clientId);
  if (!client) {
    console.error("Unknown client:", clientId);
    process.exit(1);
  }

  const pdfPath = await resolveTaxReturnPdf(path.resolve(process.cwd(), client.docsDir), year);
  const bytes = await readFile(pdfPath);
  const form = new FormData();
  form.append("files", new Blob([bytes], { type: "application/pdf" }), path.basename(pdfPath));
  form.append("ocrMode", mode);
  form.append("format", "json");

  console.log(`\n=== LIVE ${clientId} ${year} mode=${mode} ===`);
  console.log(`PDF: ${path.basename(pdfPath)} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);

  const t0 = Date.now();
  const res = await undiciFetch("http://localhost:3000/api/parse-tax-return", {
    method: "POST",
    body: form as unknown as BodyInit,
    dispatcher: new Agent({ headersTimeout: 1_500_000, bodyTimeout: 1_500_000 }),
  });
  const wallMs = Date.now() - t0;

  if (!res.ok) {
    console.log("HTTP", res.status, (await res.text()).slice(0, 500));
    process.exit(1);
  }

  const json = (await res.json()) as { parsed?: ParsedRow[] };
  const row = json.parsed?.[0];
  if (!row) {
    console.log("No parse result");
    process.exit(1);
  }

  const fixtureKey = Object.keys(ALL_FIXTURES).find(
    (k) => k.startsWith(client.fixturePrefix) && ALL_FIXTURES[k]!.year === year,
  );
  const fixture = fixtureKey ? ALL_FIXTURES[fixtureKey] : undefined;

  if (!fixtureKey || !fixture) {
    console.error("No fixture for", client.fixturePrefix, year);
    process.exit(1);
  }

  const fieldScore = scoreAllFieldsExcludingOpexSlots(fixtureKey, row.values);
  const opexScore = scoreOpexAmountsOnly(fixtureKey, row.values);

  const ocrTotal = row.debug?.ocrTimingMs?.total;
  const gapLog = row.debug?.ocrLogs?.find((l) => /Attachment gap rescan/i.test(l));

  console.log(`\nTiming: wall=${(wallMs / 1000).toFixed(0)}s` + (ocrTotal ? ` ocr=${(ocrTotal / 1000).toFixed(0)}s` : ""));
  console.log(`OCR pages: ${row.debug?.ocrPageCount ?? "?"}`);
  if (gapLog) console.log(`Gap rescan: ${gapLog}`);

  if (fieldScore) {
    console.log(`Fields (excl opex): ${fieldScore.pct.toFixed(1)}% (${fieldScore.ok}/${fieldScore.n})`);
    for (const m of fieldScore.misses.slice(0, 6)) console.log(`  miss: ${m}`);
  }
  if (opexScore) {
    console.log(`Opex multiset: ${opexScore.pct.toFixed(1)}% (${opexScore.ok}/${opexScore.n})`);
    for (const m of opexScore.misses.slice(0, 6)) console.log(`  miss: ${m}`);
  }

  const targetMs = mode === "fast" ? 120_000 : mode === "thorough" ? 600_000 : 300_000;
  const timeOk = wallMs <= targetMs;
  console.log(`\nTime gate (${mode}): ${timeOk ? "PASS" : "FAIL"} (target ≤${targetMs / 1000}s, got ${(wallMs / 1000).toFixed(0)}s)`);

  process.exit(timeOk && fieldScore && fieldScore.pct >= 95 ? 0 : 1);
}

main();
