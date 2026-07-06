/**
 * Web API benchmark — all clients vs Excel (same path as Tax tab upload).
 *
 * Usage:
 *   npx tsx scripts/benchmark-all-web-api.ts [mode] [baseUrl] [clientId?]
 *
 * Thorough OCR can exceed 5 min/PDF. Uses undici Agent with 25 min body timeout
 * (Node's global fetch defaults to 300s regardless of AbortSignal).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Agent, fetch as undiciFetch } from "undici";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { scoreAllFieldsExcludingOpexSlots, scoreOpexAmountsOnly, scorePrimary } from "./lib/tax-benchmark-score";
import {
  aggregateConfidenceCalibration,
  buildFieldMissDiagnostics,
  computeConfidenceCalibration,
  formatCalibrationSummary,
  type ConfidenceCalibration,
  type FieldMissDiagnostic,
  type ParsedBenchmarkContext,
} from "./lib/tax-benchmark-confidence";
import { TAX_BENCHMARK_CLIENTS, fixtureKey, type TaxBenchmarkClient } from "./lib/tax-benchmark-clients";
import { forceExit } from "./lib/force-exit";
import {
  buildClientYearDebugReport,
  printDebugReports,
  type ClientYearDebugReport,
} from "./lib/tax-benchmark-debug";

const mode = process.argv[2] ?? "thorough";
const base = process.argv[3] ?? "http://localhost:3000";
const onlyClient = process.argv[4];
/** Wall clock per PDF — thorough local OCR + attachment rescan; override with BENCHMARK_TIMEOUT_MS. */
const timeoutMs = Number(process.env.BENCHMARK_TIMEOUT_MS) || 25 * 60_000;

const longFetchAgent = new Agent({
  connectTimeout: 60_000,
  headersTimeout: timeoutMs,
  bodyTimeout: timeoutMs,
});

type RowResult = {
  client: string;
  year: number;
  status: number;
  primaryPct: number;
  allPct: number;
  fieldPct: number;
  opexAmountPct: number;
  allMisses: string[];
  missDiagnostics?: FieldMissDiagnostic[];
  debug?: ClientYearDebugReport;
  confidenceCalibration?: ConfidenceCalibration;
  elapsedMs: number;
  error?: string;
  timedOut?: boolean;
  retried?: boolean;
};

function isTimeoutError(message: string): boolean {
  return /fetch failed|aborted|timeout|UND_ERR|Headers Timeout|Body Timeout/i.test(message);
}

async function warmupServer(): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await undiciFetch(`${base}/api/parse-tax-return`, {
      method: "GET",
      signal: controller.signal,
      dispatcher: new Agent({ connectTimeout: 10_000, headersTimeout: 120_000, bodyTimeout: 120_000 }),
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
    clearTimeout(timer);
  }
}

async function postPdfOnce(client: TaxBenchmarkClient, year: number): Promise<RowResult> {
  const docsDir = path.resolve(process.cwd(), client.docsDir);
  const pdfPath = await resolveTaxReturnPdf(docsDir, year);
  const bytes = await readFile(pdfPath);
  const blob = new Blob([bytes], { type: "application/pdf" });
  const fd = new FormData();
  fd.append("files", blob, path.basename(pdfPath));
  fd.append("ocrMode", mode);

  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await undiciFetch(`${base}/api/parse-tax-return`, {
      method: "POST",
      body: fd,
      signal: controller.signal,
      dispatcher: longFetchAgent,
    });
    const elapsedMs = Date.now() - t0;
    const text = await res.text();
    let json: {
      parsed?: Array<ParsedBenchmarkContext & { values: Record<string, number> }>;
      error?: string;
    };
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      return {
        client: client.id,
        year,
        status: res.status,
        primaryPct: 0,
        allPct: 0,
        allMisses: [`parse error: ${text.slice(0, 120)}`],
        elapsedMs,
        error: "non-JSON response",
      };
    }
    if (!res.ok) {
      return {
        client: client.id,
        year,
        status: res.status,
        primaryPct: 0,
        allPct: 0,
        allMisses: [json.error ?? "API error"],
        elapsedMs,
        error: json.error,
      };
    }
    const row = json.parsed?.[0];
    if (!row) {
      return {
        client: client.id,
        year,
        status: res.status,
        primaryPct: 0,
        allPct: 0,
        allMisses: ["no parsed row"],
        elapsedMs,
        error: "no parsed row",
      };
    }
    const fk = fixtureKey(client, year);
    const primary = scorePrimary(fk, row.values);
    const fieldsNoOpex = scoreAllFieldsExcludingOpexSlots(fk, row.values);
    const opexAmounts = scoreOpexAmountsOnly(fk, row.values);
    const all = fieldsNoOpex;
    const missDiagnostics = buildFieldMissDiagnostics(row, all);
    const confidenceCalibration = computeConfidenceCalibration(fk, row);
    const debug = buildClientYearDebugReport(client.id, year, fk, row);
    return {
      client: client.id,
      year,
      status: res.status,
      primaryPct: primary.pct,
      fieldPct: fieldsNoOpex.pct,
      opexAmountPct: opexAmounts.pct,
      allPct: all.pct,
      allMisses: all.misses,
      missDiagnostics,
      debug,
      confidenceCalibration,
      elapsedMs,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      client: client.id,
      year,
      status: 0,
      primaryPct: 0,
      allPct: 0,
      allMisses: [message],
      elapsedMs: Date.now() - t0,
      error: message,
      timedOut: isTimeoutError(message) || Date.now() - t0 >= timeoutMs - 5000,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function postPdf(client: TaxBenchmarkClient, year: number): Promise<RowResult> {
  let row = await postPdfOnce(client, year);
  if (row.error && row.timedOut) {
    console.log(`\n    timeout — retrying once after 5s… `);
    await new Promise((r) => setTimeout(r, 5000));
    row = await postPdfOnce(client, year);
    row.retried = true;
  }
  return row;
}

async function main() {
  await warmupServer();

  const clients = onlyClient
    ? TAX_BENCHMARK_CLIENTS.filter((c) => c.id === onlyClient)
    : TAX_BENCHMARK_CLIENTS;

  console.log(`=== web-api benchmark mode=${mode} base=${base} timeout=${timeoutMs / 60_000}min ===\n`);
  const rows: RowResult[] = [];

  for (const client of clients) {
    for (const year of client.years) {
      process.stdout.write(`[${client.id} ${year}] `);
      const row = await postPdf(client, year);
      rows.push(row);
      if (row.error) {
        const tag = row.timedOut ? "TIMEOUT" : "FAIL";
        console.log(`${tag} ${row.error}${row.retried ? " (after retry)" : ""} (${(row.elapsedMs / 1000).toFixed(0)}s)`);
      } else {
        console.log(
          `primary ${row.primaryPct.toFixed(1)}% fields ${row.fieldPct.toFixed(1)}% opexAmt ${row.opexAmountPct.toFixed(1)}% (${(row.elapsedMs / 1000).toFixed(0)}s)`,
        );
        if (row.allMisses.length) {
          console.log(`  misses: ${row.allMisses.join("; ")}`);
          for (const d of row.missDiagnostics ?? []) {
            console.log(
              `    ↳ ${d.field}: conf=${d.confidence}% diagnosis=${d.diagnosis} flagged=${d.flagged}${d.flags.length ? ` flags=[${d.flags.join(", ")}]` : ""}`,
            );
          }
        }
      }
    }
  }

  const timeouts = rows.filter((r) => r.timedOut || (r.error && isTimeoutError(r.error)));
  const infraErrors = rows.filter((r) => r.error && !r.timedOut);
  const accuracyMisses = rows.filter((r) => !r.error && r.allMisses.length > 0);

  console.log("\n--- summary ---");
  console.log(`completed: ${rows.filter((r) => !r.error).length}/${rows.length}`);
  console.log(`timeouts: ${timeouts.length}`);
  console.log(`infra errors: ${infraErrors.length}`);
  console.log(`accuracy misses: ${accuracyMisses.length}`);

  const aggregateCalibration = aggregateConfidenceCalibration(
    rows.filter((r) => r.confidenceCalibration).map((r) => r.confidenceCalibration!),
  );

  console.log("\n--- confidence calibration (aggregate) ---");
  console.log(formatCalibrationSummary(aggregateCalibration));

  printDebugReports(
    rows.filter((r) => r.debug).map((r) => r.debug!),
  );

  const outDir = path.join(process.cwd(), "scripts", "benchmark-output");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `web-api-${mode}-${Date.now()}.json`);
  await writeFile(
    outPath,
    JSON.stringify(
      {
        mode,
        base,
        timeoutMs,
        rows,
        debugReports: rows.filter((r) => r.debug).map((r) => r.debug),
        summary: {
          timeouts: timeouts.length,
          infraErrors: infraErrors.length,
          accuracyMisses: accuracyMisses.length,
          confidenceCalibration: aggregateCalibration,
        },
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${outPath}`);

  if (timeouts.length || infraErrors.length) forceExit(2);
  forceExit(accuracyMisses.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  forceExit(2);
});
