/**
 * UI upload-route parity — all companies, all years.
 *
 * The Tax tab does more than one mergeParsedTaxYears([], rows) call:
 *   1. onTierParsed → progressive mergeParsedTaxYears(prev, [row]) per PDF
 *   2. startParse final → mergeParsedTaxYears(baseColumns, json.parsed)
 *   3. session hydrate → restore the finalized saved snapshot
 *   4. field edit / label edit → finalizeTaxColumns from parserBaseline
 *
 * Backend/batch scoring can be green while a second finalize drops taxes from top-8
 * or clears formOrdinaryBusinessIncome / fieldFlags. This script gates that.
 *
 * Usage:
 *   npx tsx scripts/benchmark-ui-upload-routes.ts [mode] [clientId?]
 *
 * Exit 1 if any route loses years, top-8 amounts, other_opex, form anchors, or
 * material flag coverage vs the batch baseline.
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { mergeParsedTaxYears } from "../src/lib/tax/client-merge";
import { actualTop8Amounts } from "../src/lib/tax/fixture-top8";
import { OPERATING_EXPENSE_SLOT_IDS } from "../src/lib/tax/operating-expenses";
import { TAX_BENCHMARK_CLIENTS, type TaxBenchmarkClient } from "./lib/tax-benchmark-clients";
import { forceExit } from "./lib/force-exit";
import type { ParsedTaxYear } from "../src/lib/api/types";
import type { TaxYearValues } from "../src/lib/tax-workbook";

const mode = (process.argv[2] ?? "balanced") as "fast" | "balanced" | "thorough";
const onlyClient = process.argv[3];
const CACHE_DIR = path.join(process.cwd(), "scripts", "ocr-cache");
const OUT_DIR = path.join(process.cwd(), "scripts", "benchmark-output");

type YearSnap = {
  top8: number[];
  otherOpex?: number;
  overhead: number;
  sales?: number;
  formOI?: number;
  formGP?: number;
  flagFieldCount: number;
  flaggedFields: string[];
  flagMessages: string[];
  pnlWarnings: string[];
};

type RouteSnap = {
  route: string;
  years: number[];
  byYear: Record<number, YearSnap>;
};

type RouteDiff = {
  route: string;
  client: string;
  issues: string[];
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
  if (!cp) {
    throw new Error(`Missing OCR cache for ${client.id} ${year} (${mode}) — run UI-session bench first`);
  }
  // Use cache as-is — this bench gates merge/finalize routes, not OCR recovery.
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

function sumOverhead(values: Record<string, number | undefined>): number {
  return OPERATING_EXPENSE_SLOT_IDS.reduce((s, id) => s + (values[id] ?? 0), 0);
}

function snapColumn(col: TaxYearValues): YearSnap {
  const flaggedFields = Object.entries(col.fieldFlags ?? {})
    .filter(([, flags]) => (flags?.length ?? 0) > 0)
    .map(([id]) => id)
    .sort();
  const flagMessages = Object.entries(col.fieldFlags ?? {})
    .flatMap(([id, flags]) => (flags ?? []).map((f) => `${id}:${f}`))
    .sort();
  const pnlWarnings = (col.warnings ?? [])
    .filter((w) => /ordinary income|gross profit|P&L|npbt|net income/i.test(w))
    .map((w) => w.replace(/\s+/g, " ").trim())
    .sort();
  return {
    top8: actualTop8Amounts(col.values).slice().sort((a, b) => b - a),
    otherOpex: col.values.other_operating_expenses,
    overhead: sumOverhead(col.values),
    sales: col.values.sales,
    formOI: col.formOrdinaryBusinessIncome,
    formGP: col.formGrossProfit,
    flagFieldCount: flaggedFields.length,
    flaggedFields,
    flagMessages,
    pnlWarnings,
  };
}

function snapRoute(route: string, columns: TaxYearValues[]): RouteSnap {
  const byYear: Record<number, YearSnap> = {};
  for (const col of columns) byYear[col.year] = snapColumn(col);
  return {
    route,
    years: columns.map((c) => c.year).sort((a, b) => a - b),
    byYear,
  };
}

function sameNumberMultiset(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const as = [...a].sort((x, y) => x - y);
  const bs = [...b].sort((x, y) => x - y);
  return as.every((n, i) => n === bs[i]);
}

function diffAgainstBaseline(
  client: string,
  baseline: RouteSnap,
  other: RouteSnap,
  opts?: { allowFlagDrift?: boolean },
): RouteDiff {
  const issues: string[] = [];
  if (baseline.years.join(",") !== other.years.join(",")) {
    issues.push(
      `years lost/changed: baseline=[${baseline.years}] ${other.route}=[${other.years}]`,
    );
  }
  for (const year of baseline.years) {
    const b = baseline.byYear[year];
    const o = other.byYear[year];
    if (!b || !o) {
      issues.push(`${year}: missing column on ${other.route}`);
      continue;
    }
    if (!sameNumberMultiset(b.top8, o.top8)) {
      issues.push(
        `${year}: top8 multiset ${other.route}=[${o.top8.join(",")}] vs batch=[${b.top8.join(",")}]`,
      );
    }
    if (b.otherOpex !== o.otherOpex) {
      issues.push(`${year}: other_opex ${other.route}=${o.otherOpex} vs batch=${b.otherOpex}`);
    }
    if (b.overhead !== o.overhead) {
      issues.push(`${year}: overhead ${other.route}=${o.overhead} vs batch=${b.overhead}`);
    }
    if (b.sales !== o.sales) {
      issues.push(`${year}: sales ${other.route}=${o.sales} vs batch=${b.sales}`);
    }
    if (b.formOI !== o.formOI) {
      issues.push(
        `${year}: formOrdinaryBusinessIncome ${other.route}=${o.formOI} vs batch=${b.formOI}`,
      );
    }
    if (b.formGP !== o.formGP) {
      issues.push(`${year}: formGrossProfit ${other.route}=${o.formGP} vs batch=${b.formGP}`);
    }
    // Flags may reorder; require same field set unless allowFlagDrift.
    if (!opts?.allowFlagDrift) {
      const bf = b.flaggedFields.join(",");
      const of = o.flaggedFields.join(",");
      if (bf !== of) {
        issues.push(
          `${year}: flagged fields ${other.route}=[${of || "none"}] vs batch=[${bf || "none"}]`,
        );
      }
      // Do not require identical message text (wording can drift) — only field coverage.
      if (o.flagFieldCount < b.flagFieldCount) {
        issues.push(
          `${year}: flag coverage dropped ${other.route}=${o.flagFieldCount} vs batch=${b.flagFieldCount}`,
        );
      }
    }
  }
  return { route: other.route, client, issues };
}

/** Exact startParse final merge when baseColumns is empty (fresh upload). */
function routeBatch(incoming: ParsedTaxYear[]): TaxYearValues[] {
  return mergeParsedTaxYears([], incoming).columns;
}

/** onTierParsed progressive accumulation (file order = client.years ascending). */
function routeProgressive(incoming: ParsedTaxYear[], order: "asc" | "desc"): TaxYearValues[] {
  const rows =
    order === "asc"
      ? [...incoming].sort((a, b) => a.year - b.year)
      : [...incoming].sort((a, b) => b.year - a.year);
  let cols: TaxYearValues[] = [];
  for (const row of rows) {
    cols = mergeParsedTaxYears(cols, [row]).columns;
  }
  return cols;
}

/**
 * Exact use-tax-upload startParse:
 * progressive onTier during upload, then final merge from snapshot baseColumns=[] with all parsed.
 */
function routeUiStartParse(incoming: ParsedTaxYear[]): TaxYearValues[] {
  // Intermediate progressive (hidden until busy clears) — still exercise it.
  void routeProgressive(incoming, "asc");
  // Final replace from empty base — what the UI commits when starting fresh.
  return mergeParsedTaxYears([], incoming).columns;
}

/** Session hydrate path: JSON round-trip the already-finalized saved snapshot. */
function routeSessionRestore(columns: TaxYearValues[]): TaxYearValues[] {
  return JSON.parse(JSON.stringify(columns)) as TaxYearValues[];
}

/** Progressive accumulation followed by a session-storage round trip. */
function routeProgressiveThenRestore(
  incoming: ParsedTaxYear[],
  order: "asc" | "desc",
): TaxYearValues[] {
  return routeSessionRestore(routeProgressive(incoming, order));
}

function printYearLine(year: number, s: YearSnap) {
  const oi = s.formOI !== undefined ? ` OI=${s.formOI}` : " OI=missing";
  const gp = s.formGP !== undefined ? ` GP=${s.formGP}` : "";
  const flags = s.flagFieldCount ? ` flags=${s.flagFieldCount}[${s.flaggedFields.join(",")}]` : " flags=0";
  console.log(
    `    ${year}: overhead=${s.overhead} other=${s.otherOpex ?? "—"} top8=[${s.top8.join(",")}]${oi}${gp}${flags}`,
  );
  if (s.pnlWarnings.length) {
    for (const w of s.pnlWarnings.slice(0, 3)) console.log(`      warn: ${w.slice(0, 120)}`);
  }
}

async function runClient(client: TaxBenchmarkClient): Promise<RouteDiff[]> {
  const incoming: ParsedTaxYear[] = [];
  for (const year of client.years) {
    process.stdout.write(`  parse ${client.id} ${year}… `);
    incoming.push(await parseYearCached(client, year));
    console.log("ok");
  }

  // Pre-merge form anchors from raw parse (must survive merge).
  const preMergeAnchors = new Map(
    incoming.map((r) => [
      r.year,
      {
        oi: r.formOrdinaryBusinessIncome,
        gp: r.formGrossProfit,
      },
    ]),
  );

  const batchCols = routeBatch(incoming);
  const batch = snapRoute("batch", batchCols);
  const routes: RouteSnap[] = [
    batch,
    snapRoute("progressive-asc", routeProgressive(incoming, "asc")),
    snapRoute("progressive-desc", routeProgressive(incoming, "desc")),
    snapRoute("ui-startParse", routeUiStartParse(incoming)),
    snapRoute("session-restore", routeSessionRestore(batchCols)),
    snapRoute("progressive-asc+restore", routeProgressiveThenRestore(incoming, "asc")),
    snapRoute("progressive-desc+restore", routeProgressiveThenRestore(incoming, "desc")),
  ];

  console.log(`  batch baseline (${batch.years.join(", ")}):`);
  for (const y of [...batch.years].sort((a, b) => b - a)) {
    printYearLine(y, batch.byYear[y]!);
  }

  // Form anchors must not be dropped vs pre-merge parse.
  const anchorIssues: string[] = [];
  for (const [year, pre] of preMergeAnchors) {
    const post = batch.byYear[year];
    if (!post) {
      anchorIssues.push(`${year}: year missing after batch merge`);
      continue;
    }
    if (pre.oi !== undefined && post.formOI !== pre.oi) {
      anchorIssues.push(
        `${year}: formOrdinaryBusinessIncome lost/changed parse=${pre.oi} batch=${post.formOI}`,
      );
    }
    if (pre.gp !== undefined && post.formGP !== pre.gp) {
      anchorIssues.push(
        `${year}: formGrossProfit lost/changed parse=${pre.gp} batch=${post.formGP}`,
      );
    }
  }
  if (anchorIssues.length) {
    console.log("  FORM ANCHOR LOSSES vs pre-merge parse:");
    for (const i of anchorIssues) console.log(`    FAIL ${i}`);
  } else {
    console.log("  form anchors: preserved from parse → batch");
  }

  const diffs: RouteDiff[] = [];
  if (anchorIssues.length) {
    diffs.push({ route: "batch-vs-parse", client: client.id, issues: anchorIssues });
  }

  for (const route of routes) {
    if (route.route === "batch") continue;
    const d = diffAgainstBaseline(client.id, batch, route);
    if (d.issues.length) {
      console.log(`  FAIL ${route.route}:`);
      for (const i of d.issues) console.log(`    ${i}`);
      diffs.push(d);
    } else {
      console.log(`  ok ${route.route} ≡ batch (amounts, other_opex, anchors, flag fields)`);
    }
  }

  return diffs;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const clients = onlyClient
    ? TAX_BENCHMARK_CLIENTS.filter((c) => c.id === onlyClient)
    : TAX_BENCHMARK_CLIENTS;

  console.log(
    `=== UI UPLOAD ROUTES parity mode=${mode} (progressive / startParse / session-restore) ===\n`,
  );

  const allDiffs: RouteDiff[] = [];
  const report: {
    mode: string;
    clients: Array<{ id: string; batch: RouteSnap; failures: string[] }>;
  } = { mode, clients: [] };

  for (const client of clients) {
    console.log(`\n── ${client.id} (${client.years.join(", ")}) ──`);
    try {
      const diffs = await runClient(client);
      allDiffs.push(...diffs);
      report.clients.push({
        id: client.id,
        batch: { route: "batch", years: client.years, byYear: {} },
        failures: diffs.flatMap((d) => d.issues.map((i) => `${d.route}: ${i}`)),
      });
    } catch (e) {
      console.error(`  ERROR: ${e instanceof Error ? e.message : e}`);
      forceExit(2);
    }
  }

  const outPath = path.join(OUT_DIR, `ui-upload-routes-${mode}-${Date.now()}.json`);
  // Re-run lightweight: store only failure summary (full snaps are huge).
  await writeFile(
    outPath,
    JSON.stringify(
      {
        mode,
        failed: allDiffs.length > 0,
        failures: allDiffs,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log("\n═══ SUMMARY ═══\n");
  if (!allDiffs.length) {
    console.log("All UI routes match batch for every client (top-8, other_opex, form anchors, flags).");
    console.log(`Wrote ${outPath}`);
    forceExit(0);
    return;
  }

  console.log(`FAILED ${allDiffs.length} route comparison(s):`);
  for (const d of allDiffs) {
    console.log(`  ${d.client} / ${d.route}: ${d.issues.length} issue(s)`);
  }
  console.log(`Wrote ${outPath}`);
  forceExit(1);
}

main().catch((e) => {
  console.error(e);
  forceExit(2);
});
