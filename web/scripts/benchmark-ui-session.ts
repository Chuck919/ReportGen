/**
 * UI-session benchmark — exact Tax-tab path for a full company upload.
 *
 * Unlike per-year benchmarks, this:
 *   1. Parses every year for a client
 *   2. Merges via mergeParsedTaxYears (same as use-tax-upload → finalizeTaxColumns)
 *   3. Scores amounts, opex labels, trust-tier "green" dangerous failures, and FP rate
 *
 * Usage:
 *   npx tsx scripts/benchmark-ui-session.ts [mode] [clientId?]
 *
 * Also run UI route parity (progressive / session-restore / re-finalize) so a green
 * batch score cannot hide double-finalize regressions:
 *   npx tsx scripts/benchmark-ui-upload-routes.ts [mode] [clientId?]
 *
 * mode = balanced (default) | fast | thorough — uses OCR cache when present.
 * Live web API (exact Tax-tab server path):
 *   UI_BENCH_LIVE=1 BASE_URL=http://localhost:3000 npx tsx scripts/benchmark-ui-session.ts balanced
 *
 * Live forces HTTP /api/parse-tax-return per PDF, then mergeParsedTaxYears (same as the browser).
 *
 * Live batch (single multi-year, multi-file POST — not one request per year):
 *   UI_BENCH_LIVE=1 UI_BENCH_LIVE_BATCH=1 BASE_URL=http://localhost:3000 npx tsx scripts/benchmark-ui-session.ts balanced
 *
 * Thresholds (exit 1 if any fail):
 *   - avg field accuracy (excl opex slots) ≥ 99%
 *   - avg opex (top-8 amount multiset + other_operating_expenses) ≥ 99%
 *   - 0 dangerous failures (wrong + green tier, or wrong + high conf unflagged)
 *   - correct-but-low-confidence (false positive review) ≤ 5%
 *   - yellow/review highlight rate ≤ 10% of all scanned fields
 *   - 0 workbook formula mismatches
 *   (opex labels are informational only — not a gate in this phase)
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Agent, fetch as undiciFetch } from "undici";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { mergeParsedTaxYears } from "../src/lib/tax/client-merge";
import { rescanMissingAttachmentsExperimental } from "../src/lib/tax/ocr-recovery-experimental";
import { probeOcrCoverageGaps } from "../src/lib/tax-return/ocr-coverage-rescan";
import {
  scoreAllFieldsExcludingOpexSlots,
  scoreOpexBenchmark,
  detectExcelOpexDiscrepancies,
  enrichFixture,
  fieldMatches,
} from "./lib/tax-benchmark-score";
import { actualTop8Amounts } from "../src/lib/tax/fixture-top8";
import {
  aggregateConfidenceCalibration,
  computeConfidenceCalibration,
  formatCalibrationSummary,
  HIGH_CONFIDENCE_THRESHOLD,
  type ConfidenceCalibration,
} from "./lib/tax-benchmark-confidence";
import { fieldFlagsNeedReview } from "../src/lib/tax/field-review";
import { TAX_BENCHMARK_CLIENTS, fixtureKey, type TaxBenchmarkClient } from "./lib/tax-benchmark-clients";
import { forceExit } from "./lib/force-exit";
import { OPERATING_EXPENSE_SLOT_IDS, sharedOpexSlotLabels } from "../src/lib/tax/operating-expenses";
import { auditWorkbookMath } from "./lib/workbook-math-audit";
import type { ParsedTaxYear } from "../src/lib/api/types";
import type { TaxYearValues } from "../src/lib/tax-workbook";
import type { FieldTrustTier } from "../src/lib/tax/field-trust-tier";
import { resolveTrustTierFromColumn } from "../src/lib/tax/field-trust-tier";
import { WORKBOOK_COMPARISON_FIXTURES } from "../src/lib/workbook-comparison-fixtures";
import changwenFixtures from "./changwen-fixtures.json";

const mode = (process.argv[2] ?? "balanced") as "fast" | "balanced" | "thorough";
const onlyClient = process.argv[3];
const live = process.env.UI_BENCH_LIVE === "1";
// "sequential" (default) matches the real Tax-tab UI: one POST per PDF, then a single client-side
// mergeParsedTaxYears() over all returned rows. "batch" instead sends every year's PDF as multiple
// `files` fields on ONE POST (the API supports this — form.getAll("files")) — a genuine multi-year,
// single-request upload, to check the server's multi-file path and cross-year opex grouping when
// years truly arrive together server-side, not just merged client-side after N sequential calls.
const liveBatch = process.env.UI_BENCH_LIVE_BATCH === "1";
const base = process.env.BASE_URL ?? "http://localhost:3000";
const CACHE_DIR = path.join(process.cwd(), "scripts", "ocr-cache");
const OUT_DIR = path.join(process.cwd(), "scripts", "benchmark-output");
const timeoutMs = Number(process.env.BENCHMARK_TIMEOUT_MS) || 25 * 60_000;

let liveFetchAgent: Agent | undefined;

function liveApiHeaders(): Record<string, string> {
  const key = process.env.PARSE_TAX_API_KEY?.trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

function getLiveFetchAgent(): Agent {
  if (!liveFetchAgent) {
    liveFetchAgent = new Agent({
      connectTimeout: 60_000,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
  }
  return liveFetchAgent;
}

async function closeLiveFetchAgent(): Promise<void> {
  if (!liveFetchAgent) return;
  await liveFetchAgent.close();
  liveFetchAgent = undefined;
}

async function warmupLiveServer(): Promise<void> {
  const agent = new Agent({ connectTimeout: 10_000, headersTimeout: 120_000, bodyTimeout: 120_000 });
  try {
    const res = await undiciFetch(`${base}/api/parse-tax-return`, {
      method: "GET",
      headers: liveApiHeaders(),
      dispatcher: agent,
    });
    if (!res.ok) throw new Error(`warmup HTTP ${res.status}`);
    await res.text();
    console.log(`Server ready at ${base}\n`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Dev server not reachable at ${base} (${detail}). Start it first: cd web && npm run dev`,
    );
  } finally {
    await agent.close();
  }
}

/** UI cells that look trusted/green — wrong values here are dangerous. */
const TRUSTED_GREEN_TIERS = new Set<FieldTrustTier>([
  "multi-source",
  "authoritative",
  "comparison",
  "single-good",
]);

/** Amber/yellow review styling — should stay ≤10% of scanned fields. */
const YELLOW_REVIEW_TIERS = new Set<FieldTrustTier>([
  "moderate",
  "low",
  "ocr-only",
  "math-warning",
]);

const ALL_FIXTURES: Record<string, { values: Record<string, number> }> = {
  ...WORKBOOK_COMPARISON_FIXTURES.tax,
  ...(changwenFixtures as Record<string, { values: Record<string, number> }>),
};

type LabelIssue = { slotId: string; label: string; reason: string };
type GreenDanger = {
  year: number;
  field: string;
  expected: number;
  actual?: number;
  tier: FieldTrustTier;
  displayConfidence?: number;
  flags: string[];
};

type ClientSessionResult = {
  client: string;
  years: number[];
  fieldPctByYear: Record<number, number>;
  opexPctByYear: Record<number, number>;
  misses: string[];
  labelIssues: LabelIssue[];
  greenDangers: GreenDanger[];
  mathIssues: string[];
  /** Non-blocking — parser surplus amounts that may indicate fixture error. */
  excelDiscrepancies: string[];
  calibration: ConfidenceCalibration;
  avgField: number;
  avgOpex: number;
  /** Share of fixture fields with yellow/amber review styling. */
  yellowRate: number;
  yellowCount: number;
  fieldCount: number;
};

async function hasCache(p: string) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveCache(clientId: string, year: number): Promise<string | null> {
  const named = path.join(CACHE_DIR, `${clientId}-${year}-${mode}.txt`);
  if (await hasCache(named)) return named;
  if (clientId === "kcf") {
    const legacy = path.join(CACHE_DIR, `${year}-${mode}.txt`);
    if (await hasCache(legacy)) return legacy;
  }
  return null;
}

async function parseYearCached(client: TaxBenchmarkClient, year: number): Promise<ParsedTaxYear> {
  const pdfPath = await resolveTaxReturnPdf(path.resolve(process.cwd(), client.docsDir), year);
  const bytes = await readFile(pdfPath);
  const embedded = await getEmbeddedPdfText(bytes);
  const cp = await resolveCache(client.id, year);
  let ocr: string;
  if (cp) {
    ocr = await readFile(cp, "utf8");
  } else {
    console.log("(live OCR) ");
    const { parseTaxReturn } = await import("../src/lib/tax-return-parser");
    const live = await parseTaxReturn(path.basename(pdfPath), bytes, embedded, year, mode);
    return {
      ...live,
      filename: path.basename(pdfPath),
      parseStatus: live.parseStatus ?? "ok",
    } as ParsedTaxYear;
  }

  if (mode === "thorough" || mode === "balanced") {
    const gapProbe = probeOcrCoverageGaps(embedded, ocr, year);
    if (gapProbe.reasons.some((r) => /stmt2-detail-missing|stmt2-total-unparseable/i.test(r))) {
      const gap = await rescanMissingAttachmentsExperimental(
        bytes,
        embedded,
        ocr,
        path.basename(pdfPath),
        year,
        "balanced",
      );
      if (gap.ran) {
        ocr = gap.ocrText;
        console.log(`gap-rescan p${gap.pages.join(",")} `);
        // Never rewrite the balanced/thorough OCR cache from experimental gap-rescan —
        // a bad probe (or flaky page set) permanently poisons the holdout gate.
      }
    }
  }

  const parsed = parseTaxReturnFromText(path.basename(pdfPath), embedded, ocr, year, {
    ocrMode: mode,
  });
  return {
    ...parsed,
    filename: path.basename(pdfPath),
    parseStatus: "ok",
  } as ParsedTaxYear;
}

async function parseYearLive(client: TaxBenchmarkClient, year: number): Promise<ParsedTaxYear> {
  const pdfPath = await resolveTaxReturnPdf(path.resolve(process.cwd(), client.docsDir), year);
  const bytes = await readFile(pdfPath);
  const form = new FormData();
  form.append("files", new Blob([bytes], { type: "application/pdf" }), path.basename(pdfPath));
  form.append("ocrMode", mode);
  form.append("format", "json");
  const t0 = Date.now();
  const res = await undiciFetch(`${base}/api/parse-tax-return`, {
    method: "POST",
    headers: liveApiHeaders(),
    body: form as unknown as BodyInit,
    dispatcher: getLiveFetchAgent(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} for ${client.id} ${year}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { parsed?: ParsedTaxYear[]; error?: string };
  const row = json.parsed?.[0];
  if (!row) throw new Error(json.error ?? `No parse result for ${client.id} ${year}`);
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write(`(${sec}s) `);
  return row;
}

/** All of a client's PDFs (every year) attached as multiple `files` fields on one POST — a true
 * single-request, multi-year upload, exercising the server's own multi-file loop instead of N
 * separate client-simulated requests. */
async function parseYearsLiveBatch(client: TaxBenchmarkClient): Promise<ParsedTaxYear[]> {
  const form = new FormData();
  for (const year of client.years) {
    const pdfPath = await resolveTaxReturnPdf(path.resolve(process.cwd(), client.docsDir), year);
    const bytes = await readFile(pdfPath);
    form.append("files", new Blob([bytes], { type: "application/pdf" }), path.basename(pdfPath));
  }
  form.append("ocrMode", mode);
  form.append("format", "json");
  const t0 = Date.now();
  const res = await undiciFetch(`${base}/api/parse-tax-return`, {
    method: "POST",
    headers: liveApiHeaders(),
    body: form as unknown as BodyInit,
    dispatcher: getLiveFetchAgent(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} for ${client.id} batch upload: ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    parsed?: ParsedTaxYear[];
    error?: string;
    fileErrors?: Array<{ filename: string; message: string }>;
    partial?: boolean;
  };
  if (json.fileErrors?.length) {
    for (const fe of json.fileErrors) console.log(`  warn: OCR miss on ${fe.filename}: ${fe.message}`);
  }
  if (!json.parsed?.length) throw new Error(json.error ?? `No parse results for ${client.id} batch upload`);
  if (json.parsed.length !== client.years.length) {
    console.log(
      `  warn: batch upload returned ${json.parsed.length} row(s) for ${client.years.length} file(s)`,
    );
  }
  const elapsedSec = (Date.now() - t0) / 1000;
  const perPdf = elapsedSec / Math.max(client.years.length, 1);
  console.log(
    `ok  batch ${elapsedSec.toFixed(0)}s total (${perPdf.toFixed(0)}s/pdf avg, target balanced≤300s thorough≤600s)`,
  );
  return json.parsed;
}

function isCleanLabel(label: string): { ok: boolean; reason?: string } {
  const t = label.trim();
  if (t.length < 3) return { ok: false, reason: "too short" };
  if (t.length > 40) return { ok: false, reason: "too long" };
  if (/[|[\]]/.test(t)) return { ok: false, reason: "OCR punctuation" };
  if (/\bstatement\b/i.test(t)) return { ok: false, reason: "contains 'statement'" };
  if (!/[a-z]/i.test(t)) return { ok: false, reason: "no letters" };
  if (/^[a-z]{1,2}\s/i.test(t)) return { ok: false, reason: "OCR fragment prefix" };
  return { ok: true };
}

function auditLabels(columns: TaxYearValues[]): LabelIssue[] {
  const issues: LabelIssue[] = [];
  const shared = sharedOpexSlotLabels(columns);
  for (const id of OPERATING_EXPENSE_SLOT_IDS) {
    const label = shared[id] ?? id;
    const check = isCleanLabel(label);
    if (!check.ok) {
      issues.push({ slotId: id, label, reason: check.reason ?? "unclean" });
    }
  }
  return issues;
}

function auditYellowRate(
  columns: TaxYearValues[],
  client: TaxBenchmarkClient,
): { yellowCount: number; fieldCount: number; yellowRate: number } {
  let fieldCount = 0;
  let yellowCount = 0;
  for (const col of columns) {
    const fk = fixtureKey(client, col.year);
    const exp = ALL_FIXTURES[fk]?.values;
    if (!exp) continue;
    for (const [id, expected] of Object.entries(exp)) {
      fieldCount++;
      const match = fieldMatches(id, expected, col.values, exp);
      const correct =
        match.hit || (expected === 0 && (col.values[id] === undefined || col.values[id] === 0));
      // Only count false review highlights (correct but yellow) — wrong+yellow is desired.
      if (!correct) continue;
      const tier = col.fieldTrustTier?.[id] ?? resolveTrustTierFromColumn(col, id);
      const flags = col.fieldFlags?.[id] ?? [];
      if (YELLOW_REVIEW_TIERS.has(tier) || fieldFlagsNeedReview(flags)) yellowCount++;
    }
  }
  return {
    yellowCount,
    fieldCount,
    yellowRate: fieldCount ? yellowCount / fieldCount : 0,
  };
}

function auditGreenDangers(columns: TaxYearValues[], client: TaxBenchmarkClient): GreenDanger[] {
  const dangers: GreenDanger[] = [];
  const opexSlotSet = new Set<string>(OPERATING_EXPENSE_SLOT_IDS);
  for (const col of columns) {
    const fk = fixtureKey(client, col.year);
    const exp = ALL_FIXTURES[fk]?.values;
    if (!exp) continue;
    for (const [id, expected] of Object.entries(exp)) {
      // Opex paste rows are scored as an amount multiset — not per semantic slot id.
      if (opexSlotSet.has(id)) continue;
      const match = fieldMatches(id, expected, col.values, exp);
      if (match.hit) continue;
      if (expected === 0 && (col.values[id] === undefined || col.values[id] === 0)) continue;

      const tier = col.fieldTrustTier?.[id] ?? resolveTrustTierFromColumn(col, id);
      const flags = col.fieldFlags?.[id] ?? [];
      const flagged = fieldFlagsNeedReview(flags) || flags.length > 0;
      const displayConfidence = col.displayConfidence?.[id] ?? col.confidence?.[id] ?? 0;
      const green = TRUSTED_GREEN_TIERS.has(tier);
      const highUnflagged = displayConfidence >= HIGH_CONFIDENCE_THRESHOLD && !flagged;
      if (green || highUnflagged) {
        dangers.push({
          year: col.year,
          field: id,
          expected,
          actual: col.values[id],
          tier,
          displayConfidence,
          flags,
        });
      }
    }
  }
  return dangers;
}

/**
 * Simulate the Tax tab: parse each PDF, then merge all years in one session
 * (same as uploading a batch / progressive onTier).
 */
async function runClientSession(client: TaxBenchmarkClient): Promise<ClientSessionResult> {
  let incoming: ParsedTaxYear[] = [];
  if (live && liveBatch) {
    process.stdout.write(`  parse ${client.id} (batch upload, ${client.years.length} files)… `);
    incoming = await parseYearsLiveBatch(client);
    console.log("ok");
  } else {
    for (const year of client.years) {
      process.stdout.write(`  parse ${client.id} ${year}… `);
      const row = live ? await parseYearLive(client, year) : await parseYearCached(client, year);
      incoming.push(row);
      console.log("ok");
    }
  }

  // Exact UI merge: empty session → all years at once (batch upload).
  const { columns, warnings } = mergeParsedTaxYears([], incoming);
  if (warnings.length) {
    for (const w of warnings) console.log(`  warn: ${w}`);
  }

  const fieldPctByYear: Record<number, number> = {};
  const opexPctByYear: Record<number, number> = {};
  const misses: string[] = [];
  const mathIssues: string[] = [];
  const calibrations: ConfidenceCalibration[] = [];
  const excelDiscrepancies: string[] = [];
  const surplusAmountYears = new Map<number, Set<number>>();

  for (const col of columns) {
    const fk = fixtureKey(client, col.year);
    const fixture = enrichFixture(fk);
    const fields = scoreAllFieldsExcludingOpexSlots(fk, col.values);
    const opex = scoreOpexBenchmark(fk, col.values);
    fieldPctByYear[col.year] = fields.pct;
    opexPctByYear[col.year] = opex.pct;
    for (const m of fields.misses) misses.push(`${col.year} ${m}`);
    for (const m of opex.misses) misses.push(`${col.year} ${m}`);

    for (const w of detectExcelOpexDiscrepancies(fixture, col.values)) {
      const m = w.match(/parser_surplus_amount: (\d+)/);
      if (m) {
        const amt = Number(m[1]);
        const yrs = surplusAmountYears.get(amt) ?? new Set<number>();
        yrs.add(col.year);
        surplusAmountYears.set(amt, yrs);
      }
    }

    const math = auditWorkbookMath(col.values);
    for (const issue of math) mathIssues.push(`${col.year} ${issue.kind}: ${issue.detail}`);

    calibrations.push(computeConfidenceCalibration(fk, col));
  }

  for (const [amt, yrs] of surplusAmountYears) {
    if (yrs.size >= 2) {
      excelDiscrepancies.push(
        `excel_discrepancy: parser surplus $${amt} in years ${[...yrs].sort((a, b) => b - a).join(", ")} (not in fixture top-8)`,
      );
    }
  }

  const greenDangers = auditGreenDangers(columns, client);
  const yellow = auditYellowRate(columns, client);
  const calibration = aggregateConfidenceCalibration(calibrations);
  const labelIssues: LabelIssue[] = [];
  const years = columns.map((c) => c.year).sort((a, b) => a - b);
  const avgField = years.length
    ? years.reduce((s, y) => s + (fieldPctByYear[y] ?? 0), 0) / years.length
    : 0;
  const avgOpex = years.length
    ? years.reduce((s, y) => s + (opexPctByYear[y] ?? 0), 0) / years.length
    : 0;

  // Per-year summary: top-8 amounts (order irrelevant) + other_opex.
  for (const col of [...columns].sort((a, b) => b.year - a.year)) {
    const top8 = actualTop8Amounts(col.values).sort((a, b) => b - a);
    const ose = col.values.other_operating_expenses;
    console.log(
      `  ${col.year} fields ${fieldPctByYear[col.year]?.toFixed(1)}% opex ${opexPctByYear[col.year]?.toFixed(1)}%` +
        (ose !== undefined ? ` other_opex=${ose}` : ""),
    );
    console.log(`    top8 amounts: ${top8.join(", ")}`);
  }

  if (excelDiscrepancies.length) {
    for (const d of excelDiscrepancies) console.log(`  FLAG ${d}`);
  }

  return {
    client: client.id,
    years,
    fieldPctByYear,
    opexPctByYear,
    misses,
    labelIssues,
    greenDangers,
    mathIssues,
    excelDiscrepancies,
    calibration,
    avgField,
    avgOpex,
    yellowRate: yellow.yellowRate,
    yellowCount: yellow.yellowCount,
    fieldCount: yellow.fieldCount,
  };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const clients = onlyClient
    ? TAX_BENCHMARK_CLIENTS.filter((c) => c.id === onlyClient)
    : TAX_BENCHMARK_CLIENTS;

  console.log(
    `=== UI SESSION BENCHMARK mode=${mode} path=${live ? `live ${base}` : "cached+merge"} rankByAmount=cross-year-sum opexScore=amounts-only ===\n`,
  );

  if (live) await warmupLiveServer();

  const results: ClientSessionResult[] = [];
  try {
    for (const client of clients) {
      console.log(`\n── ${client.id} (${client.years.join(", ")}) ──`);
      try {
        results.push(await runClientSession(client));
      } catch (e) {
        console.error(`  ERROR: ${e instanceof Error ? e.message : e}`);
        forceExit(2);
      }
    }
  } finally {
    await closeLiveFetchAgent();
  }

  console.log("\n═══ SUMMARY ═══\n");
  let totalGreen = 0;
  let totalLabel = 0;
  let totalMath = 0;
  let totalYellow = 0;
  let totalFields = 0;
  const allCal: ConfidenceCalibration[] = [];

  for (const r of results) {
    const missN = r.misses.length;
    const greenN = r.greenDangers.length;
    const labelN = r.labelIssues.length;
    const mathN = r.mathIssues.length;
    totalGreen += greenN;
    totalLabel += labelN;
    totalMath += mathN;
    totalYellow += r.yellowCount;
    totalFields += r.fieldCount;
    allCal.push(r.calibration);

    const status =
      r.avgField >= 99 &&
      r.avgOpex >= 99 &&
      greenN === 0 &&
      mathN === 0 &&
      r.calibration.correctLowConfidenceRate <= 0.05 &&
      r.yellowRate <= 0.1
        ? "PASS"
        : "FAIL";

    console.log(
      `${r.client.padEnd(12)} ${status}  field ${r.avgField.toFixed(1)}%  opex ${r.avgOpex.toFixed(1)}%` +
        `  misses=${missN} greenDanger=${greenN} labels=${labelN} math=${mathN}` +
        `  excelFlags=${r.excelDiscrepancies.length}` +
        `  yellow=${(r.yellowRate * 100).toFixed(1)}%` +
        `  FP=${(r.calibration.correctLowConfidenceRate * 100).toFixed(1)}%` +
        `  dangerousHigh=${r.calibration.dangerousFailures}`,
    );

    if (r.misses.length) {
      for (const m of r.misses.slice(0, 8)) console.log(`    miss: ${m}`);
    }
    if (r.greenDangers.length) {
      for (const d of r.greenDangers) {
        console.log(
          `    GREEN DANGER ${d.year} ${d.field}: exp ${d.expected} got ${d.actual ?? "blank"}` +
            ` tier=${d.tier} conf=${d.displayConfidence ?? "?"} flags=[${d.flags.join(", ")}]`,
        );
      }
    }
    if (r.labelIssues.length) {
      for (const l of r.labelIssues.slice(0, 3)) console.log(`    label (info): ${l.slotId}="${l.label}" (${l.reason})`);
    }
    if (r.excelDiscrepancies.length) {
      for (const d of r.excelDiscrepancies) console.log(`    FLAG ${d}`);
    }
    if (r.mathIssues.length) {
      for (const m of r.mathIssues) console.log(`    math: ${m}`);
    }
  }

  const agg = aggregateConfidenceCalibration(allCal);
  const avgField = results.length ? results.reduce((s, r) => s + r.avgField, 0) / results.length : 0;
  const avgOpex = results.length ? results.reduce((s, r) => s + r.avgOpex, 0) / results.length : 0;

  console.log("\n--- aggregate confidence ---");
  console.log(formatCalibrationSummary(agg));
  console.log(`\nAVG field (UI session): ${avgField.toFixed(1)}%`);
  console.log(`AVG opex (UI session): ${avgOpex.toFixed(1)}%`);
  const yellowRate = totalFields ? totalYellow / totalFields : 0;
  console.log(`Green-tier dangers: ${totalGreen}`);
  console.log(`Yellow/review fields: ${totalYellow}/${totalFields} (${(yellowRate * 100).toFixed(1)}%)`);
  console.log(`Unclean labels: ${totalLabel}`);
  console.log(`Formula mismatches: ${totalMath}`);

  const outPath = path.join(OUT_DIR, `ui-session-${live ? "live-" : ""}${mode}-${Date.now()}.json`);
  await writeFile(outPath, JSON.stringify({ mode, live, results, aggregate: agg, yellowRate }, null, 2));
  console.log(`\nWrote ${outPath}`);

  const below =
    avgField < 99 ||
    avgOpex < 99 ||
    totalGreen > 0 ||
    totalMath > 0 ||
    agg.dangerousFailures > 0 ||
    agg.correctLowConfidenceRate > 0.05 ||
    yellowRate > 0.1;

  forceExit(below ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  forceExit(2);
});
