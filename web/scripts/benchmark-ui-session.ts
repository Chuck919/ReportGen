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
 * mode = balanced (default) | fast | thorough — uses OCR cache when present.
 * Live web API (exact Tax-tab server path):
 *   UI_BENCH_LIVE=1 BASE_URL=http://localhost:3000 npx tsx scripts/benchmark-ui-session.ts balanced
 *
 * Live forces HTTP /api/parse-tax-return per PDF, then mergeParsedTaxYears (same as the browser).
 *
 * Thresholds (exit 1 if any fail):
 *   - avg field accuracy (excl opex slots) ≥ 99%
 *   - avg opex amount multiset ≥ 99%
 *   - 0 dangerous failures (wrong + green tier, or wrong + high conf unflagged)
 *   - correct-but-low-confidence (false positive review) ≤ 5%
 *   - yellow/review highlight rate ≤ 10% of all scanned fields
 *   - 0 unclean opex labels
 *   - 0 workbook formula mismatches
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Agent, fetch as undiciFetch } from "undici";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { mergeParsedTaxYears } from "../src/lib/tax/client-merge";
import {
  scoreAllFieldsExcludingOpexSlots,
  scoreOpexAmountsOnly,
  fieldMatches,
} from "./lib/tax-benchmark-score";
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
const base = process.env.BASE_URL ?? "http://localhost:3000";
const CACHE_DIR = path.join(process.cwd(), "scripts", "ocr-cache");

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
  if (cp) {
    const ocr = await readFile(cp, "utf8");
    const parsed = parseTaxReturnFromText(path.basename(pdfPath), embedded, ocr, year, {
      ocrMode: mode,
    });
    return {
      ...parsed,
      filename: path.basename(pdfPath),
      parseStatus: "ok",
    } as ParsedTaxYear;
  }
  // No cache for this mode — run live local OCR (same as Tax tab server path).
  console.log("(live OCR) ");
  const { parseTaxReturn } = await import("../src/lib/tax-return-parser");
  const live = await parseTaxReturn(path.basename(pdfPath), bytes, embedded, year, mode);
  return {
    ...live,
    filename: path.basename(pdfPath),
    parseStatus: live.parseStatus ?? "ok",
  } as ParsedTaxYear;
}

async function parseYearLive(client: TaxBenchmarkClient, year: number): Promise<ParsedTaxYear> {
  const pdfPath = await resolveTaxReturnPdf(path.resolve(process.cwd(), client.docsDir), year);
  const bytes = await readFile(pdfPath);
  const form = new FormData();
  form.append("files", new Blob([bytes], { type: "application/pdf" }), path.basename(pdfPath));
  form.append("ocrMode", mode);
  form.append("format", "json");
  const timeoutMs = Number(process.env.BENCHMARK_TIMEOUT_MS) || 25 * 60_000;
  const agent = new Agent({ connectTimeout: 60_000, headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
  const res = await undiciFetch(`${base}/api/parse-tax-return`, {
    method: "POST",
    body: form as unknown as BodyInit,
    dispatcher: agent,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${client.id} ${year}`);
  const json = (await res.json()) as { parsed?: ParsedTaxYear[]; error?: string };
  const row = json.parsed?.[0];
  if (!row) throw new Error(json.error ?? `No parse result for ${client.id} ${year}`);
  return row;
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
  for (const col of columns) {
    const fk = fixtureKey(client, col.year);
    const exp = ALL_FIXTURES[fk]?.values;
    if (!exp) continue;
    for (const [id, expected] of Object.entries(exp)) {
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
  const incoming: ParsedTaxYear[] = [];
  for (const year of client.years) {
    process.stdout.write(`  parse ${client.id} ${year}… `);
    const row = live ? await parseYearLive(client, year) : await parseYearCached(client, year);
    incoming.push(row);
    console.log("ok");
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

  for (const col of columns) {
    const fk = fixtureKey(client, col.year);
    const fields = scoreAllFieldsExcludingOpexSlots(fk, col.values);
    const opex = scoreOpexAmountsOnly(fk, col.values);
    fieldPctByYear[col.year] = fields.pct;
    opexPctByYear[col.year] = opex.pct;
    for (const m of fields.misses) misses.push(`${col.year} ${m}`);
    for (const m of opex.misses) misses.push(`${col.year} ${m}`);

    const math = auditWorkbookMath(col.values);
    for (const issue of math) mathIssues.push(`${col.year} ${issue.kind}: ${issue.detail}`);

    calibrations.push(computeConfidenceCalibration(fk, col));
  }

  const labelIssues = auditLabels(columns);
  const greenDangers = auditGreenDangers(columns, client);
  const yellow = auditYellowRate(columns, client);
  const calibration = aggregateConfidenceCalibration(calibrations);
  const years = columns.map((c) => c.year).sort((a, b) => a - b);
  const avgField = years.length
    ? years.reduce((s, y) => s + (fieldPctByYear[y] ?? 0), 0) / years.length
    : 0;
  const avgOpex = years.length
    ? years.reduce((s, y) => s + (opexPctByYear[y] ?? 0), 0) / years.length
    : 0;

  // Print per-year summary with key opex slots for debugging.
  for (const col of [...columns].sort((a, b) => b.year - a.year)) {
    const labels = sharedOpexSlotLabels([col]);
    console.log(
      `  ${col.year} fields ${fieldPctByYear[col.year]?.toFixed(1)}% opex ${opexPctByYear[col.year]?.toFixed(1)}%` +
        ` officer=${col.values.officer_compensation ?? "—"} salaries=${col.values.salaries_wages ?? "—"}` +
        ` ose=${col.values.other_stock_equity ?? "—"} uni=${col.values.unclassified_equity ?? "—"}`,
    );
    const labelStr = OPERATING_EXPENSE_SLOT_IDS.map((id) => labels[id] ?? id).join(" | ");
    console.log(`    labels: ${labelStr}`);
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
    calibration,
    avgField,
    avgOpex,
    yellowRate: yellow.yellowRate,
    yellowCount: yellow.yellowCount,
    fieldCount: yellow.fieldCount,
  };
}

async function main() {
  const clients = onlyClient
    ? TAX_BENCHMARK_CLIENTS.filter((c) => c.id === onlyClient)
    : TAX_BENCHMARK_CLIENTS;

  console.log(
    `=== UI SESSION BENCHMARK mode=${mode} path=${live ? `live ${base}` : "cached+merge"} ===\n`,
  );

  const results: ClientSessionResult[] = [];
  for (const client of clients) {
    console.log(`\n── ${client.id} (${client.years.join(", ")}) ──`);
    try {
      results.push(await runClientSession(client));
    } catch (e) {
      console.error(`  ERROR: ${e instanceof Error ? e.message : e}`);
      forceExit(2);
    }
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
      labelN === 0 &&
      mathN === 0 &&
      r.calibration.correctLowConfidenceRate <= 0.05 &&
      r.yellowRate <= 0.1
        ? "PASS"
        : "FAIL";

    console.log(
      `${r.client.padEnd(12)} ${status}  field ${r.avgField.toFixed(1)}%  opex ${r.avgOpex.toFixed(1)}%` +
        `  misses=${missN} greenDanger=${greenN} labels=${labelN} math=${mathN}` +
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
      for (const l of r.labelIssues) console.log(`    label: ${l.slotId}="${l.label}" (${l.reason})`);
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

  const outDir = path.join(process.cwd(), "scripts", "benchmark-output");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `ui-session-${mode}-${Date.now()}.json`);
  await writeFile(outPath, JSON.stringify({ mode, live, results, aggregate: agg, yellowRate }, null, 2));
  console.log(`\nWrote ${outPath}`);

  const below =
    avgField < 99 ||
    avgOpex < 99 ||
    totalGreen > 0 ||
    totalLabel > 0 ||
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
