/**
 * Multi-client OCR tier regression with repeated cold runs (OCR variance).
 *
 *   npm run test:ocr-changwen              # validate benchmark-changwen-matrix.json
 *   npm run test:ocr-changwen -- --run     # fresh runs (~hours for full matrix)
 *   npm run test:ocr-changwen -- --run --client carithers --year 2024 --runs 1
 */
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import {
  TAX_BENCHMARK_CLIENTS,
  fixtureKey,
  resolveClientDocsDir,
  type TaxBenchmarkClient,
} from "./lib/tax-benchmark-clients";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { median, scorePrimary } from "./lib/tax-benchmark-score";
import { runLocalOcr, type OcrMode } from "../src/lib/tax-return/local-ocr";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";

const MODES: OcrMode[] = ["fast", "balanced", "thorough"];
const CACHE_DIR = path.join(process.cwd(), "scripts", "ocr-cache");

/** Fast preview — ~2 min; target ≥75% primary median. */
const FAST_MAX_MS = 120_000;
const FAST_MIN_MEDIAN_PCT = 75;

/** Balanced — ≥95% on every cold run; target ~5 min. */
const BALANCED_MIN_PASS_RATE = 1;
const BALANCED_MIN_PCT = 95;
const BALANCED_MAX_MS = 300_000;

/** Thorough — 100% primary on every cold run. */
const THOROUGH_MIN_PASS_RATE = 1;
const THOROUGH_MIN_PCT = 100;

type MissDetail = { field: string; expected: number; actual?: number; confidence?: number; source?: string };
type RunRow = {
  run: number;
  ms: number;
  pct: number;
  ok: number;
  n: number;
  misses: string[];
  missDetails: MissDetail[];
  lowConfidenceFields: string[];
};

function enrichMisses(
  misses: string[],
  parsed: ReturnType<typeof parseTaxReturnFromText>,
): { misses: string[]; missDetails: MissDetail[] } {
  const missDetails: MissDetail[] = [];
  const formatted = misses.map((m) => {
    const id = m.split(":")[0]!;
    const expMatch = m.match(/exp (-?\d+)/);
    const gotMatch = m.match(/got (-?\d+|blank)/);
    const expected = expMatch ? Number(expMatch[1]) : 0;
    const actual = gotMatch?.[1] === "blank" ? undefined : gotMatch ? Number(gotMatch[1]) : undefined;
    const conf = parsed.confidence[id];
    const src = parsed.fieldSources?.[id];
    missDetails.push({ field: id, expected, actual, confidence: conf, source: src });
    const confBit = conf != null ? ` conf=${conf}` : "";
    const srcBit = src ? ` (${src})` : "";
    return `${m}${confBit}${srcBit}`;
  });
  return { misses: formatted, missDetails };
}

function lowConfidenceFields(parsed: ReturnType<typeof parseTaxReturnFromText>): string[] {
  const out: string[] = [];
  for (const [id, conf] of Object.entries(parsed.confidence)) {
    if (conf <= 45) out.push(`${id}=${parsed.values[id]}@${conf}`);
  }
  return out;
}
type ModeSummary = {
  mode: OcrMode;
  runs: RunRow[];
  medianMs: number;
  medianPct: number;
  passRate: number;
  missFrequency: Record<string, number>;
};
type ClientYearResult = { clientId: string; year: number; modes: ModeSummary[] };
type Matrix = { at: string; runsPerMode: number; results: ClientYearResult[] };

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function has(flag: string): boolean {
  return process.argv.includes(flag);
}

async function embeddedText(bytes: Uint8Array) {
  return getEmbeddedPdfText(bytes);
}

function cachePath(clientId: string, year: number, mode: OcrMode, run?: number) {
  const suffix = run != null ? `-run${run}` : "";
  return path.join(CACHE_DIR, `${clientId}-${year}-${mode}${suffix}.txt`);
}

async function coldRun(
  client: TaxBenchmarkClient,
  year: number,
  mode: OcrMode,
  bytes: Uint8Array,
  embedded: string,
  pdfName: string,
  runNum: number,
): Promise<RunRow> {
  const cp = cachePath(client.id, year, mode);
  try {
    await unlink(cp);
  } catch {
    // cold run
  }
  // Legacy KCF cache keys (year-mode.txt) — never reuse across cold runs
  if (client.id === "kcf") {
    try {
      await unlink(path.join(CACHE_DIR, `${year}-${mode}.txt`));
    } catch {
      // cold run
    }
  }

  console.log(`  OCR started ${mode}…`);
  const t0 = Date.now();
  const ocr = await runLocalOcr(bytes, { profile: "tax", mode });
  const ms = Date.now() - t0;
  console.log(`  OCR done ${(ms / 1000).toFixed(0)}s, parsing…`);
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cachePath(client.id, year, mode, runNum), ocr.text, "utf8");
  await writeFile(cp, ocr.text, "utf8");

  const parsed = parseTaxReturnFromText(pdfName, embedded, ocr.text, year, { ocrMode: mode });
  const score = scorePrimary(fixtureKey(client, year), parsed.values);
  const { misses, missDetails } = enrichMisses(score.misses, parsed);
  return {
    run: runNum,
    ms,
    pct: score.pct,
    ok: score.ok,
    n: score.n,
    misses,
    missDetails,
    lowConfidenceFields: lowConfidenceFields(parsed),
  };
}

async function benchClientYear(
  client: TaxBenchmarkClient,
  year: number,
  runs: number,
): Promise<ClientYearResult> {
  const docsDir = resolveClientDocsDir(client);
  const pdfPath = await resolveTaxReturnPdf(docsDir, year);
  const bytes = await readFile(pdfPath);
  const embedded = await embeddedText(bytes);
  const pdfName = path.basename(pdfPath);
  const modes: ModeSummary[] = [];

  for (const mode of MODES) {
    const runRows: RunRow[] = [];
    for (let r = 1; r <= runs; r++) {
      console.log(`\n[${client.id} ${year} ${mode}] run ${r}/${runs}…`);
      const row = await coldRun(client, year, mode, bytes, embedded, pdfName, r);
      runRows.push(row);
      console.log(
        `  ${(row.ms / 1000).toFixed(1)}s | ${row.ok}/${row.n} (${row.pct.toFixed(1)}%)${row.misses.length ? ` | ${row.misses.slice(0, 3).join("; ")}` : ""}`,
      );
    }

    const pcts = runRows.map((r) => r.pct);
    const times = runRows.map((r) => r.ms);
    const passRate =
      runRows.filter((r) => r.pct >= (mode === "fast" ? 0 : 100)).length / runRows.length;
    const missFreq = new Map<string, number>();
    for (const r of runRows) {
      for (const m of r.misses) missFreq.set(m, (missFreq.get(m) ?? 0) + 1);
    }
    modes.push({
      mode,
      runs: runRows,
      medianMs: median(times),
      medianPct: median(pcts),
      passRate,
      missFrequency: Object.fromEntries([...missFreq.entries()].sort((a, b) => b[1] - a[1])),
    });
  }

  return { clientId: client.id, year, modes };
}

function selectClients(): TaxBenchmarkClient[] {
  const id = arg("--client");
  if (id) {
    const c = TAX_BENCHMARK_CLIENTS.find((x) => x.id === id);
    if (!c) throw new Error(`Unknown client ${id}`);
    return [c];
  }
  return TAX_BENCHMARK_CLIENTS;
}

async function runMatrix(): Promise<Matrix> {
  process.env.FREE_OCR_WORKERS = "1";
  process.env.FREE_OCR_TIMEOUT_MS = "1200000";

  const runs = Number(arg("--runs", "1"));
  const yearArg = arg("--year");
  const clients = selectClients();
  const results: ClientYearResult[] = [];

  for (const client of clients) {
    const years = yearArg ? [Number(yearArg)] : client.years;
    for (const year of years) {
      results.push(await benchClientYear(client, year, runs));
    }
  }

  const out: Matrix = { at: new Date().toISOString(), runsPerMode: runs, results };
  const outPath = path.join(process.cwd(), "scripts", "benchmark-changwen-matrix.json");
  await writeFile(outPath, JSON.stringify(out, null, 2), "utf8");
  console.log(`\nWrote ${outPath}`);
  return out;
}

function validate(data: Matrix): string[] {
  const errors: string[] = [];

  for (const { clientId, year, modes } of data.results) {
    const fast = modes.find((m) => m.mode === "fast");
    const balanced = modes.find((m) => m.mode === "balanced");
    const thorough = modes.find((m) => m.mode === "thorough");

    if (fast) {
      if (fast.medianMs > FAST_MAX_MS) {
        errors.push(`${clientId} ${year} fast: median ${(fast.medianMs / 1000).toFixed(0)}s > ${FAST_MAX_MS / 1000}s`);
      }
      if (fast.medianPct < FAST_MIN_MEDIAN_PCT) {
        errors.push(`${clientId} ${year} fast: median ${fast.medianPct.toFixed(0)}% < ${FAST_MIN_MEDIAN_PCT}%`);
      }
    }

    const balPassRate = balanced
      ? balanced.runs.filter((r) => r.pct >= BALANCED_MIN_PCT).length / balanced.runs.length
      : 0;
    const thorPassRate = thorough
      ? thorough.runs.filter((r) => r.pct >= THOROUGH_MIN_PCT).length / thorough.runs.length
      : 0;

    if (balanced) {
      if (balPassRate < BALANCED_MIN_PASS_RATE) {
        errors.push(
          `${clientId} ${year} balanced: ${(balPassRate * 100).toFixed(0)}% runs at ≥${BALANCED_MIN_PCT}% (need ${BALANCED_MIN_PASS_RATE * 100}%)`,
        );
        if (Object.keys(balanced.missFrequency).length) {
          errors.push(`  miss freq: ${JSON.stringify(balanced.missFrequency)}`);
        }
      }
      if (balanced.medianMs > BALANCED_MAX_MS) {
        errors.push(
          `${clientId} ${year} balanced: median ${(balanced.medianMs / 1000).toFixed(0)}s > ${BALANCED_MAX_MS / 1000}s`,
        );
      }
    }

    if (thorough) {
      if (thorPassRate < THOROUGH_MIN_PASS_RATE) {
        errors.push(
          `${clientId} ${year} thorough: ${(thorPassRate * 100).toFixed(0)}% runs at 100% (need 100%)`,
        );
        if (Object.keys(thorough.missFrequency).length) {
          errors.push(`  miss freq: ${JSON.stringify(thorough.missFrequency)}`);
        }
      }
    }

    if (fast && balanced && thorough) {
      if (balanced.medianPct < fast.medianPct) {
        errors.push(`${clientId} ${year}: balanced median ${balanced.medianPct}% < fast ${fast.medianPct}%`);
      }
      if (thorough.medianPct < balanced.medianPct) {
        errors.push(`${clientId} ${year}: thorough median ${thorough.medianPct}% < balanced ${balanced.medianPct}%`);
      }
      if (balPassRate < 1 && thorPassRate <= balPassRate) {
        errors.push(
          `${clientId} ${year}: thorough pass rate ${(thorPassRate * 100).toFixed(0)}% must exceed balanced ${(balPassRate * 100).toFixed(0)}%`,
        );
      }
    }
  }

  return errors;
}

async function main() {
  let data: Matrix;
  if (has("--run")) {
    console.log("=== CLIENT OCR TARGETS: cold runs (cache cleared each run) ===\n");
    data = await runMatrix();
  } else {
    const p = path.join(process.cwd(), "scripts", "benchmark-changwen-matrix.json");
    data = JSON.parse(await readFile(p, "utf8")) as Matrix;
    console.log(`=== CHANGWEN OCR TARGETS: validate ${p} (${data.at}) ===\n`);
  }

  console.log("client:year | fast (med%/s) | balanced | thorough");
  for (const { clientId, year, modes } of data.results) {
    const cells = MODES.map((m) => {
      const row = modes.find((x) => x.mode === m)!;
      return `${row.medianPct.toFixed(0)}%/${(row.medianMs / 1000).toFixed(0)}s`.padEnd(14);
    });
    console.log(`${clientId}:${year} | ${cells.join(" | ")}`);
  }

  const errors = validate(data);
  if (errors.length) {
    console.log("\n=== FAIL ===");
    for (const e of errors) console.log(`  ${e}`);
    process.exit(1);
  }
  console.log("\n=== PASS: all Changwen OCR tier targets met ===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
