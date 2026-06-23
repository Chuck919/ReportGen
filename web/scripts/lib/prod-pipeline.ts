/**
 * Mirrors production UI OCR pipeline via HTTP (parse + ocr-plan + ocr-pages).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { OcrMode } from "../../src/lib/api/types";
import type { MultipassGapTier, MultipassStopWhen, VercelMultipassPlan } from "../../src/lib/tax/vercel-multipass-config";
import {
  gapsForTier,
  shouldStopMultipass,
} from "../../src/lib/tax/vercel-multipass-config";

export type ParsedRow = {
  year: number;
  values: Record<string, number | undefined>;
  confidence?: Record<string, number | undefined>;
  warnings?: string[];
};

export type ParseApiResult = {
  parsed: ParsedRow[];
  ocrText?: string;
  partial?: boolean;
  error?: string;
};

function ocrPageNumbers(text: string): number[] {
  const nums = new Set<number>();
  for (const m of text.matchAll(/--- OCR PAGE (\d+)/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) nums.add(n);
  }
  return Array.from(nums).sort((a, b) => a - b);
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function postParse(
  base: string,
  pdfPath: string,
  fields: Record<string, string>,
): Promise<{ ms: number; body: ParseApiResult & { table?: { tsv?: string } } }> {
  const buf = await readFile(pdfPath);
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "application/pdf" }), path.basename(pdfPath));
  for (const [k, v] of Object.entries(fields)) form.append(k, v);

  const t0 = Date.now();
  const res = await fetch(`${base}/api/parse-tax-return?format=json`, { method: "POST", body: form });
  const ms = Date.now() - t0;
  const text = await res.text();
  let body: ParseApiResult & { table?: { tsv?: string }; fileErrors?: Array<{ message: string }> };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new Error(`parse HTTP ${res.status} non-JSON (${ms}ms): ${text.slice(0, 200)}`);
  }
  if (!res.ok && !body.parsed?.length) {
    throw new Error(`parse HTTP ${res.status} (${ms}ms): ${body.error ?? text.slice(0, 300)}`);
  }
  return { ms, body };
}

async function postOcrPlan(
  base: string,
  pdfPath: string,
  ocrMode: OcrMode,
  opts: { deltaFrom: OcrMode; alreadyPages: number[]; missingFields: string[] },
): Promise<{ targets: number[]; batches: number[][] }> {
  const buf = await readFile(pdfPath);
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "application/pdf" }), path.basename(pdfPath));
  form.append("ocrMode", ocrMode);
  form.append("deltaFrom", opts.deltaFrom);
  form.append("alreadyPages", opts.alreadyPages.join(","));
  form.append("missingFields", opts.missingFields.join(","));

  const res = await fetch(`${base}/api/ocr-plan`, { method: "POST", body: form });
  const json = (await res.json()) as { targets?: number[]; batches?: number[][]; error?: string };
  if (!res.ok) throw new Error(`ocr-plan: ${json.error ?? res.status}`);
  return { targets: json.targets ?? [], batches: json.batches ?? [] };
}

async function postOcrPages(
  base: string,
  pdfPath: string,
  ocrMode: OcrMode,
  pages: number[],
  forcePhase3: boolean,
): Promise<{ ms: number; text: string }> {
  const buf = await readFile(pdfPath);
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "application/pdf" }), path.basename(pdfPath));
  form.append("ocrMode", ocrMode);
  form.append("pages", pages.join(","));
  if (forcePhase3) form.append("forcePhase3", "1");

  const t0 = Date.now();
  const res = await fetch(`${base}/api/ocr-pages`, { method: "POST", body: form });
  const ms = Date.now() - t0;
  const json = (await res.json()) as { text?: string; error?: string };
  if (!res.ok) throw new Error(`ocr-pages: ${json.error ?? res.status}`);
  return { ms, text: json.text ?? "" };
}

function mergeOcrPageTexts(parts: string[]): string {
  const byPage = new Map<number, string>();
  const full = parts.filter(Boolean).join("\n");
  const blocks = full.split(/\n(?=--- OCR PAGE \d+ \([^)]+\) ---\n)/);
  for (const block of blocks) {
    const m = block.match(/^--- OCR PAGE (\d+) \([^)]+\) ---\n([\s\S]*)/);
    if (!m) continue;
    byPage.set(Number(m[1]), m[2]);
  }
  const pages = Array.from(byPage.keys()).sort((a, b) => a - b);
  return pages.map((n) => `\n--- OCR PAGE ${n} (full) ---\n${byPage.get(n) ?? ""}`).join("\n");
}

export type PipelineRunResult = {
  id: string;
  totalMs: number;
  pass1Ms: number;
  pass2Ms: number;
  batchesRun: number;
  parsed: ParsedRow;
  tsvLines: number;
  error?: string;
};

export async function runSinglePass(
  base: string,
  pdfPath: string,
  id: string,
  ocrMode: OcrMode,
): Promise<PipelineRunResult> {
  const t0 = Date.now();
  try {
    const { ms, body } = await postParse(base, pdfPath, { ocrMode });
    const row = body.parsed?.[0];
    if (!row) throw new Error("no parsed row");
    return {
      id,
      totalMs: Date.now() - t0,
      pass1Ms: ms,
      pass2Ms: 0,
      batchesRun: 0,
      parsed: row,
      tsvLines: (body.table?.tsv ?? "").split("\n").filter(Boolean).length,
    };
  } catch (e) {
    return {
      id,
      totalMs: Date.now() - t0,
      pass1Ms: 0,
      pass2Ms: 0,
      batchesRun: 0,
      parsed: { year: 0, values: {} },
      tsvLines: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export type MultipassRunPlan = Pick<
  VercelMultipassPlan,
  "pass1" | "pass2" | "reparse" | "gapTier" | "maxBatches" | "batchSize" | "forcePhase3" | "iterateGaps" | "stopWhen"
>;

export async function runMultipass(
  base: string,
  pdfPath: string,
  id: string,
  plan: MultipassRunPlan,
): Promise<PipelineRunResult> {
  const t0 = Date.now();
  let pass1Ms = 0;
  let pass2Ms = 0;
  let batchesRun = 0;

  try {
    const p1 = await postParse(base, pdfPath, { ocrMode: plan.pass1, includeOcrText: "1" });
    pass1Ms = p1.ms;
    let parsed = p1.body.parsed?.[0];
    let ocrText = p1.body.ocrText ?? "";
    if (!parsed) throw new Error("pass1: no parsed row");

    if (shouldStopMultipass(parsed, plan.stopWhen)) {
      return {
        id,
        totalMs: Date.now() - t0,
        pass1Ms,
        pass2Ms: 0,
        batchesRun: 0,
        parsed,
        tsvLines: (p1.body.table?.tsv ?? "").split("\n").filter(Boolean).length,
      };
    }

    while (batchesRun < plan.maxBatches) {
      const missing = gapsForTier(parsed, plan.gapTier);
      if (!missing.length || shouldStopMultipass(parsed, plan.stopWhen)) break;

      const ocrPlan = await postOcrPlan(base, pdfPath, plan.pass2, {
        deltaFrom: plan.pass1,
        alreadyPages: ocrPageNumbers(ocrText),
        missingFields: missing,
      });
      const batches = (ocrPlan.batches.length ? ocrPlan.batches : chunkArray(ocrPlan.targets, plan.batchSize));
      const pages = batches[0];
      if (!pages?.length) break;

      const delta = await postOcrPages(base, pdfPath, plan.pass2, pages, plan.forcePhase3);
      pass2Ms += delta.ms;
      batchesRun++;
      ocrText = mergeOcrPageTexts([ocrText, delta.text]);

      const rep = await postParse(base, pdfPath, { ocrMode: plan.reparse, ocrText });
      if (rep.body.parsed?.[0]) parsed = rep.body.parsed[0];

      if (!plan.iterateGaps) break;
    }

    const final = await postParse(base, pdfPath, { ocrMode: plan.reparse, ocrText });
    const row = final.body.parsed?.[0] ?? parsed;

    return {
      id,
      totalMs: Date.now() - t0,
      pass1Ms,
      pass2Ms,
      batchesRun,
      parsed: row!,
      tsvLines: (final.body.table?.tsv ?? "").split("\n").filter(Boolean).length,
    };
  } catch (e) {
    return {
      id,
      totalMs: Date.now() - t0,
      pass1Ms,
      pass2Ms,
      batchesRun,
      parsed: { year: 0, values: {} },
      tsvLines: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export type CandidatePlan = {
  id: string;
  kind: "single" | "multipass";
  ocrMode?: OcrMode;
  plan?: MultipassRunPlan;
};

export const VERCEL_CANDIDATES: CandidatePlan[] = [
  { id: "fast", kind: "single", ocrMode: "vercel-fast" },
  { id: "balanced", kind: "single", ocrMode: "vercel-balanced" },
  { id: "thorough", kind: "single", ocrMode: "vercel-thorough" },
];

export const VPS_CANDIDATES: CandidatePlan[] = [
  { id: "fast", kind: "single", ocrMode: "fast" },
  { id: "balanced", kind: "single", ocrMode: "balanced" },
  { id: "thorough", kind: "single", ocrMode: "thorough" },
];

/** Default: Vercel presets. Set OCR_DEPLOY=vps for Hetzner/Oracle. */
export const PROD_CANDIDATES: CandidatePlan[] =
  process.env.OCR_DEPLOY === "vps" ? VPS_CANDIDATES : VERCEL_CANDIDATES;
