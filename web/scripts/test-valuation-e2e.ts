/**
 * End-to-end valuation draft test — KCF + Carithers from tax PDFs only.
 *
 * Uses frozen balanced OCR cache (same parse path as benchmark-ui-session) so we
 * exercise valuation + external APIs without waiting on live OCR.
 *
 * Logs every fetch (FRED / BEA / Census / ExitValue / Groq) to disk cache.
 *
 * Usage:
 *   cd web
 *   npm run test:valuation:e2e
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { mergeParsedTaxYears } from "../src/lib/tax/client-merge";
import { buildGenerateRequest } from "../src/lib/valuation/build-request";
import { inferValuationInputs } from "../src/lib/valuation/defaults";
import { applyIntegratorWorkbookDefaults } from "../src/lib/valuation/integrator-workbook";
import { EMPTY_COMPANY_PROFILE } from "../src/lib/valuation/company-profile";
import { buildValuationReport } from "../src/lib/valuation/report";
import type { GenerateValuationRequest, GenerateValuationResponse } from "../src/lib/valuation/types";
import { installValuationFetchDiskCache } from "../src/lib/valuation/valuation-disk-cache";
import { forceExit } from "./lib/force-exit";
import { loadEnvLocal } from "./lib/load-env-local";

type FetchLogEntry = {
  ts: string;
  url: string;
  method: string;
  status?: number;
  durationMs?: number;
  cacheHit?: boolean;
  error?: string;
  responseTextHead?: string;
};

type WordExtract = {
  path: string;
  mergeFields: string[];
  textSample: string;
  dollarAmounts: number[];
};

type ClientFixture = {
  id: string;
  docsDir: string;
  years: number[];
  naics?: string;
  msaLabel?: string;
  cbsaCode?: string;
  engagingParty?: string;
  wordDoc?: string;
  /** Golden reconciled value from reference Word/Excel when known */
  expectedReconciledValue?: number;
};

const CACHE_DIR = path.join(process.cwd(), "scripts", "ocr-cache");
const OUT_DIR = path.join(process.cwd(), "scripts", "benchmark-output");
const FETCH_CACHE_DIR = path.join(process.cwd(), ".cache", "valuation-e2e");
const MODE = "balanced";

const CLIENTS: ClientFixture[] = [
  {
    id: "kcf",
    docsDir: path.resolve(process.cwd(), "..", "Documents"),
    years: [2023, 2024, 2025],
    naics: "445292",
    msaLabel: "Kansas City, MO-KS MSA",
    cbsaCode: "28140",
    engagingParty: "Robin Needham (OakStar Bank)",
    wordDoc: path.resolve(process.cwd(), "..", "Documents", "KCF valuation.docx"),
    expectedReconciledValue: 801_929,
  },
  {
    id: "carithers",
    docsDir: path.resolve(process.cwd(), "..", "Documents", "For Changwen", "carithers-liquor"),
    years: [2021, 2022, 2023, 2024, 2025],
    naics: "445310",
    msaLabel: "Louisville/Jefferson County, KY-IN MSA",
    cbsaCode: "31140",
    engagingParty: "",
  },
];

function nowIso() {
  return new Date().toISOString();
}

function sha1(input: string): string {
  return crypto.createHash("sha1").update(input).digest("hex");
}

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function extractDollarAmounts(text: string): number[] {
  const amounts = new Set<number>();
  for (const m of text.matchAll(/\$?\s*([\d,]+(?:\.\d{2})?)/g)) {
    const n = Number(m[1]!.replace(/,/g, ""));
    if (Number.isFinite(n) && n >= 1000) amounts.add(Math.round(n));
  }
  return [...amounts].sort((a, b) => b - a);
}

async function readDocxExtract(docPath: string): Promise<WordExtract | null> {
  if (!(await fileExists(docPath))) return null;
  const tmpDocx = path.join(os.tmpdir(), `reportgen-docx-${sha1(docPath)}.docx`);
  const tmpZip = path.join(os.tmpdir(), `reportgen-docx-${sha1(docPath)}.zip`);
  await fs.copyFile(docPath, tmpDocx);
  await fs.copyFile(tmpDocx, tmpZip);
  const unpackDir = path.join(os.tmpdir(), `reportgen-docx-unpack-${sha1(docPath)}`);
  await fs.rm(unpackDir, { recursive: true, force: true });
  await ensureDir(unpackDir);

  const execFileAsync = promisify(execFile);
  await execFileAsync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Expand-Archive -LiteralPath "${tmpZip.replace(/"/g, '""')}" -DestinationPath "${unpackDir.replace(/"/g, '""')}" -Force`,
    ],
    { windowsHide: true },
  );

  const xmlPath = path.join(unpackDir, "word", "document.xml");
  const xml = await fs.readFile(xmlPath, "utf8");
  const mergeFields = Array.from(
    new Set((xml.match(/MERGEFIELD\s+(\w+)/gi) ?? []).map((s) => s.split(/\s+/)[1]!).filter(Boolean)),
  ).sort();
  const texts = Array.from(xml.matchAll(/<w:t[^>]*>([^<]+)<\/w:t>/g)).map((m) => m[1]);
  const full = texts.join(" ").replace(/\s+/g, " ").trim();
  return { path: docPath, mergeFields, textSample: full, dollarAmounts: extractDollarAmounts(full) };
}

async function resolveCache(clientId: string, year: number): Promise<string | null> {
  const named = path.join(CACHE_DIR, `${clientId}-${year}-${MODE}.txt`);
  if (await fileExists(named)) return named;
  if (clientId === "kcf") {
    const legacy = path.join(CACHE_DIR, `${year}-${MODE}.txt`);
    if (await fileExists(legacy)) return legacy;
  }
  return null;
}

function installFetchLogger(fetchLog: FetchLogEntry[]) {
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const started = Date.now();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const bodyKey = init?.body ? sha1(String(init.body).slice(0, 8000)) : "";
    const key = sha1(`${method}:${url}:${bodyKey}`);
    const cachePath = path.join(FETCH_CACHE_DIR, `${key}.json`);

    if (await fileExists(cachePath)) {
      const cached = JSON.parse(await fs.readFile(cachePath, "utf8")) as {
        status: number;
        headers: Record<string, string>;
        body: string;
      };
      fetchLog.push({
        ts: nowIso(),
        url,
        method,
        status: cached.status,
        durationMs: 0,
        cacheHit: true,
        responseTextHead: cached.body.slice(0, 600),
      });
      return new Response(cached.body, { status: cached.status, headers: cached.headers });
    }

    try {
      const res = await originalFetch(input, init);
      const cloned = res.clone();
      const text = await cloned.text();
      const headersObj: Record<string, string> = {};
      cloned.headers.forEach((value, header) => {
        headersObj[header] = value;
      });
      await fs.writeFile(cachePath, JSON.stringify({ status: res.status, headers: headersObj, body: text }, null, 2), "utf8");
      fetchLog.push({
        ts: nowIso(),
        url,
        method,
        status: res.status,
        durationMs: Date.now() - started,
        cacheHit: false,
        responseTextHead: text.slice(0, 600),
      });
      return res;
    } catch (e) {
      fetchLog.push({
        ts: nowIso(),
        url,
        method,
        durationMs: Date.now() - started,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  };
}

function reportSectionTitles(report: GenerateValuationResponse): string[] {
  return report.report.sections.map((s) => s.title);
}

function reportBlockCount(report: GenerateValuationResponse) {
  return report.report.sections.reduce(
    (acc, s) => {
      for (const b of s.blocks) acc[b.kind] = (acc[b.kind] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
}

function compareToWord(
  generated: GenerateValuationResponse,
  word: WordExtract | null,
  expectedReconciled?: number,
) {
  const reconciled = generated.report.valuation.reconciledValue;
  const genAmounts = extractDollarAmounts(
    generated.report.sections
      .flatMap((s) => s.blocks)
      .map((b) =>
        b.kind === "paragraph"
          ? b.content
          : b.kind === "list"
            ? b.items.join(" ")
            : b.kind === "table"
              ? b.rows.flat().join(" ")
              : "",
      )
      .join(" "),
  );

  const wordHasReconciled = word ? word.dollarAmounts.includes(Math.round(expectedReconciled ?? reconciled)) : null;
  const genHasExpected = expectedReconciled ? genAmounts.includes(Math.round(expectedReconciled)) : null;

  const sectionKeywords = [
    "Description of Assignment",
    "Survey of the Subject Company",
    "Economic Conditions",
    "Financial Performance",
    "Normalization",
    "Reconciliation",
    "Conclusion",
  ];
  const wordSectionHits = word
    ? sectionKeywords.map((kw) => ({ keyword: kw, found: word.textSample.toLowerCase().includes(kw.toLowerCase()) }))
    : [];

  return {
    reconciledValue: reconciled,
    expectedReconciledValue: expectedReconciled ?? null,
    reconciledDelta: expectedReconciled ? reconciled - expectedReconciled : null,
    reconciledPctDelta: expectedReconciled ? ((reconciled - expectedReconciled) / expectedReconciled) * 100 : null,
    wordHasExpectedReconciled: wordHasReconciled,
    generatedHasExpectedReconciled: genHasExpected,
    topGeneratedAmounts: genAmounts.slice(0, 15),
    topWordAmounts: word?.dollarAmounts.slice(0, 15) ?? null,
    wordSectionHits,
    generatedSectionTitles: reportSectionTitles(generated),
    wordMergeFieldCount: word?.mergeFields.length ?? null,
  };
}

async function parseClientYears(client: ClientFixture) {
  const parsedYears = [];
  for (const year of client.years) {
    const cachePath = await resolveCache(client.id, year);
    if (!cachePath) throw new Error(`Missing OCR cache for ${client.id} ${year} (${MODE})`);
    const pdfPath = await resolveTaxReturnPdf(client.docsDir, year);
    const bytes = await readFile(pdfPath);
    const embedded = await getEmbeddedPdfText(bytes);
    const ocr = await readFile(cachePath, "utf8");
    const parsed = parseTaxReturnFromText(path.basename(pdfPath), embedded, ocr, year, { ocrMode: MODE });
    parsedYears.push(parsed);
  }
  const merged = mergeParsedTaxYears([], parsedYears);
  return { parsedYears, columns: merged.columns };
}

async function runClient(client: ClientFixture): Promise<{
  client: string;
  request: GenerateValuationRequest;
  generated: GenerateValuationResponse;
  word: WordExtract | null;
  comparison: ReturnType<typeof compareToWord>;
  blockCounts: Record<string, number>;
  checklist: GenerateValuationResponse["report"]["checklist"];
  apiCallSummary: Record<string, number>;
}> {
  const { columns } = await parseClientYears(client);
  const valuationInputs = applyIntegratorWorkbookDefaults(columns);
  const request = buildGenerateRequest({
    columns,
    entityName: columns[0]?.clientName,
    engagingParty: client.engagingParty,
    purpose: "SBA lending support",
    naics: client.naics,
    msaLabel: client.msaLabel,
    cbsaCode: client.cbsaCode,
    useGroq: true,
    valuationInputs,
    companyProfile:
      client.id === "kcf"
        ? {
            ...EMPTY_COMPANY_PROFILE,
            businessDescription: "KC Fudge LLC manufactures and retails gourmet fudge products in the Kansas City area.",
            ownerName: "Robin Needham",
            entityState: "MO",
            normalizationNotes: "Normalized earnings per integrator workbook — NPBT plus depreciation, interest, and amortization.",
          }
        : undefined,
  });

  const generated = await buildValuationReport(request);
  const word = client.wordDoc ? await readDocxExtract(client.wordDoc) : null;
  const comparison = compareToWord(generated, word, client.expectedReconciledValue);

  return {
    client: client.id,
    request,
    generated,
    word,
    comparison,
    blockCounts: reportBlockCount(generated),
    checklist: generated.report.checklist,
    apiCallSummary: {},
  };
}

async function main() {
  await loadEnvLocal();
  await ensureDir(FETCH_CACHE_DIR);
  await ensureDir(OUT_DIR);

  const fetchLog: FetchLogEntry[] = [];
  const cacheOnly = process.env.VALUATION_DISK_CACHE_ONLY === "1";
  const restoreFetch = installValuationFetchDiskCache({ cacheOnly });

  console.log(`Valuation E2E — cached OCR (${MODE}), Groq=${Boolean(process.env.GROQ_API_KEY)}, fallback=${Boolean(process.env.GROQ_API_KEY_FALLBACK)}\n`);

  const results = [];
  const failures: string[] = [];
  for (const client of CLIENTS) {
    console.log(`--- ${client.id.toUpperCase()} ---`);
    const started = Date.now();
    const result = await runClient(client);
    console.log(`  reconciled: $${result.comparison.reconciledValue.toLocaleString()}`);
    if (result.comparison.expectedReconciledValue) {
      console.log(
        `  vs expected: $${result.comparison.expectedReconciledValue.toLocaleString()} (delta ${result.comparison.reconciledPctDelta?.toFixed(1)}%)`,
      );
    }
    console.log(`  sections: ${result.comparison.generatedSectionTitles.length}`);
    console.log(`  blocks: ${JSON.stringify(result.blockCounts)}`);
    console.log(`  checklist: ${result.checklist.filter((c) => c.pass).length}/${result.checklist.length} pass`);
    const providerLog = result.generated.logs?.find((l) => l.startsWith("Narrative provider:"));
    if (providerLog) console.log(`  ${providerLog}`);
    console.log(`  elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

    if (client.id === "kcf" && client.expectedReconciledValue) {
      const delta = Math.abs(result.comparison.reconciledValue - client.expectedReconciledValue);
      const tolerance = Math.max(15_000, Math.round(client.expectedReconciledValue * 0.05));
      const pct = ((result.comparison.reconciledValue - client.expectedReconciledValue) / client.expectedReconciledValue) * 100;
      console.log(
        `  KCF vs integrator: delta $${delta.toLocaleString()} (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%), tolerance $${tolerance.toLocaleString()}`,
      );
      if (delta > tolerance) {
        failures.push(
          `KCF reconciled $${result.comparison.reconciledValue.toLocaleString()} vs integrator $${client.expectedReconciledValue.toLocaleString()} (delta $${delta.toLocaleString()}, tolerance $${tolerance.toLocaleString()})`,
        );
      }
      if (process.env.GROQ_API_KEY && providerLog && !providerLog.includes("groq") && !cacheOnly) {
        failures.push(`KCF narrative expected Groq provider, got: ${providerLog}`);
      }
    }

    results.push(result);
  }

  if (failures.length) {
    throw new Error(`E2E failures:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  }

  const apiCallSummary: Record<string, { total: number; cacheHits: number; live: number }> = {};
  for (const entry of fetchLog) {
    let host = "unknown";
    try {
      host = new URL(entry.url).host;
    } catch {
      // ignore
    }
    if (!apiCallSummary[host]) apiCallSummary[host] = { total: 0, cacheHits: 0, live: 0 };
    apiCallSummary[host].total += 1;
    if (entry.cacheHit) apiCallSummary[host].cacheHits += 1;
    else apiCallSummary[host].live += 1;
  }

  const out = {
    generatedAt: nowIso(),
    mode: MODE,
    groqEnabled: Boolean(process.env.GROQ_API_KEY),
    results: results.map((r) => ({
      client: r.client,
      comparison: r.comparison,
      blockCounts: r.blockCounts,
      checklist: r.checklist,
      valuation: r.generated.report.valuation,
      normalizedEarnings: r.request.valuationAssumptions?.normalizedEarnings ?? r.request.excelAssumptions?.normalizedEarnings,
      capRate: r.generated.report.valuation.capitalizationRate,
      narrativeProvider: r.generated.logs?.find((l) => l.startsWith("Narrative provider:")) ?? null,
      macroCharts: {
        national: r.generated.macro.national.charts.map((c) => c.title),
        msa: r.generated.macro.msa.charts.map((c) => c.title),
      },
      wordSample: r.word?.textSample.slice(0, 2000) ?? null,
      wordMergeFields: r.word?.mergeFields ?? null,
      generatedLogs: r.generated.logs,
    })),
    fetchLog,
    apiCallSummary,
  };

  const outPath = path.join(OUT_DIR, `valuation-e2e-${Date.now()}.json`);
  await fs.writeFile(outPath, JSON.stringify(out, null, 2), "utf8");

  console.log("=== API CALL SUMMARY ===");
  for (const [host, stats] of Object.entries(apiCallSummary)) {
    console.log(`  ${host}: ${stats.total} calls (${stats.cacheHits} cached, ${stats.live} live)`);
  }
  console.log(`\nSaved: ${outPath}`);
  restoreFetch();
}

main()
  .then(() => forceExit(0))
  .catch((err) => {
    console.error(err);
    forceExit(1);
  });
