import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import type { OcrMode } from "@/lib/api/types";
import { VERCEL_OCR_BUDGET_MS } from "@/lib/tax/resolve-ocr-mode";

export type { OcrMode };
export type LocalOcrProfile = "tax" | "benchmark";

export async function runLocalOcr(
  bytes: Uint8Array,
  options?: { profile?: LocalOcrProfile; mode?: OcrMode },
): Promise<{
  text: string;
  confidence: number;
  pages: number;
  logs: string[];
  pageNumbers: number[];
  ocrMode?: string;
  timingMs?: Record<string, number>;
}> {
  if (options?.mode === "thorough") {
    return runThoroughMerged(bytes, options);
  }
  return runOcrScript(bytes, options);
}

/** Local thorough: two balanced cold passes, per-page merge (beats Tesseract variance). */
async function runThoroughMerged(
  bytes: Uint8Array,
  options?: { profile?: LocalOcrProfile; mode?: OcrMode },
) {
  const balancedOpts = { ...options, mode: "balanced" as OcrMode };
  const pass1 = await runOcrScript(bytes, balancedOpts);
  const pass2 = await runOcrScript(bytes, balancedOpts);
  const merged = mergeOcrPageTexts(pass1.text, pass2.text);
  const totalMs =
    (pass1.timingMs?.total ?? 0) + (pass2.timingMs?.total ?? 0);
  return {
    ...pass1,
    text: merged.text,
    confidence: Math.max(pass1.confidence, pass2.confidence),
    ocrMode: "thorough",
    timingMs: { ...pass1.timingMs, total: totalMs, thorough_merge_picks: merged.picks },
    logs: [
      ...pass1.logs,
      "--- thorough pass 2 (balanced) ---",
      ...pass2.logs,
      `thorough: merged ${merged.picks}/${merged.pages} pages from pass 2`,
    ],
  };
}

function extractOcrPages(text: string): Map<number, string> {
  const chunks = new Map<number, string[]>();
  for (const part of text.split(/(?=--- OCR PAGE \d+)/)) {
    const m = part.match(/^--- OCR PAGE (\d+)/);
    if (!m) continue;
    const n = Number(m[1]);
    const arr = chunks.get(n) ?? [];
    arr.push(part.trimEnd());
    chunks.set(n, arr);
  }
  const joined = new Map<number, string>();
  for (const [n, arr] of chunks) joined.set(n, arr.join("\n"));
  return joined;
}

function ocrPageBlockScore(block: string): number {
  const money = (block.match(/\d{1,3}(?:,\d{3})+|\d{4,}/g) || []).length;
  const schedL = /schedule\s+l|line\s*(?:1[0-9]|2[0-4])\b/i.test(block) ? 4 : 0;
  const form1 = /\b1a\b|\[1c\]|gross receipt/i.test(block) ? 4 : 0;
  return money + schedL + form1 + block.length / 2500;
}

function mergeOcrPageTexts(a: string, b: string): { text: string; picks: number; pages: number } {
  const pagesA = extractOcrPages(a);
  const pagesB = extractOcrPages(b);
  const nums = [...new Set([...pagesA.keys(), ...pagesB.keys()])].sort((x, y) => x - y);
  const out: string[] = [];
  let picks = 0;
  for (const n of nums) {
    const blockA = pagesA.get(n) ?? "";
    const blockB = pagesB.get(n) ?? "";
    const scoreA = ocrPageBlockScore(blockA);
    const scoreB = ocrPageBlockScore(blockB);
    if (blockB && scoreB > scoreA) picks++;
    out.push(scoreB > scoreA ? blockB : blockA);
  }
  return { text: out.join("\n"), picks, pages: nums.length };
}

export type OcrPlanResult = {
  totalPages: number;
  targets: number[];
  batches: number[][];
  batchSize: number;
  ocrMode: string;
  kind?: string;
  deltaFrom?: string;
};

export type OcrPlanOptions = {
  deltaFrom?: OcrMode;
  alreadyPages?: number[];
  missingFields?: string[];
  full?: boolean;
};

export async function runOcrPlan(
  bytes: Uint8Array,
  mode: OcrMode,
  options?: OcrPlanOptions,
): Promise<OcrPlanResult> {
  const tempPath = path.join(tmpdir(), `reportgen-ocr-plan-${randomUUID()}.pdf`);
  await writeFile(tempPath, Buffer.from(bytes));
  try {
    const scriptPath = path.join(process.cwd(), "scripts", "ocr-plan.cjs");
    const env: NodeJS.ProcessEnv = { ...process.env, FREE_OCR_MODE: mode, FREE_OCR_PROFILE: "tax" };
    const nodeModules = path.join(process.cwd(), "node_modules");
    env.NODE_PATH = env.NODE_PATH ? `${nodeModules}${path.delimiter}${env.NODE_PATH}` : nodeModules;
    if (!env.FREE_OCR_WORKERS) {
      env.FREE_OCR_WORKERS = "1";
    }
    if (options?.deltaFrom) env.FREE_OCR_DELTA_FROM = options.deltaFrom;
    if (options?.alreadyPages?.length) env.FREE_OCR_ALREADY_PAGES = options.alreadyPages.join(",");
    if (options?.missingFields?.length) env.FREE_OCR_MISSING_FIELDS = options.missingFields.join(",");
    if (options?.full) env.FREE_OCR_PLAN_FULL = "1";
    const { stdout } = await execFileAsync(process.execPath, [scriptPath, tempPath], {
      env,
      maxBuffer: 1024 * 1024 * 4,
      timeout: 60_000,
    });
    return JSON.parse(stdout) as OcrPlanResult;
  } finally {
    await rm(tempPath, { force: true });
  }
}

export async function runLocalOcrPages(
  bytes: Uint8Array,
  pages: number[],
  options?: { profile?: LocalOcrProfile; mode?: OcrMode; forcePhase3?: boolean },
): Promise<{
  text: string;
  confidence: number;
  pages: number;
  logs: string[];
  pageNumbers: number[];
  ocrMode?: string;
  timingMs?: Record<string, number>;
}> {
  const env: NodeJS.ProcessEnv = { ...process.env, FREE_OCR_FORCE_PAGES: pages.join(",") };
  if (options?.forcePhase3) env.FREE_OCR_FORCE_PHASE3 = "1";
  return runOcrScript(bytes, options, env);
}

async function runOcrScript(
  bytes: Uint8Array,
  options?: { profile?: LocalOcrProfile; mode?: OcrMode },
  extraEnv?: NodeJS.ProcessEnv,
): Promise<{
  text: string;
  confidence: number;
  pages: number;
  logs: string[];
  pageNumbers: number[];
  ocrMode?: string;
  timingMs?: Record<string, number>;
}> {
  const tempPath = path.join(tmpdir(), `reportgen-ocr-${randomUUID()}.pdf`);
  await writeFile(tempPath, Buffer.from(bytes));
  try {
    const scriptPath = path.join(process.cwd(), "scripts", "free-ocr.cjs");
    const env = { ...process.env, ...extraEnv };
    const nodeModules = path.join(process.cwd(), "node_modules");
    env.NODE_PATH = env.NODE_PATH ? `${nodeModules}${path.delimiter}${env.NODE_PATH}` : nodeModules;
    if (!env.FREE_OCR_WORKERS) {
      env.FREE_OCR_WORKERS = "1";
    }
    if (process.env.VERCEL === "1" && !env.FREE_OCR_TIMEOUT_MS) {
      env.FREE_OCR_TIMEOUT_MS = String(VERCEL_OCR_BUDGET_MS);
    }
    if (options?.profile) env.FREE_OCR_PROFILE = options.profile;
    if (options?.mode) env.FREE_OCR_MODE = options.mode;
    const timeoutMs = Number(env.FREE_OCR_TIMEOUT_MS ?? 1000 * 60 * 20);
    const { stdout } = await execFileAsync(process.execPath, [scriptPath, tempPath], {
      env,
      maxBuffer: 1024 * 1024 * 80,
      timeout: timeoutMs,
    });
    const parsed = JSON.parse(stdout) as {
      text: string;
      confidence: number;
      pages: number;
      logs?: string[];
      pageNumbers?: number[];
      ocrMode?: string;
      timingMs?: Record<string, number>;
    };
    return {
      text: parsed.text,
      confidence: parsed.confidence,
      pages: parsed.pages,
      logs: parsed.logs ?? [],
      pageNumbers: parsed.pageNumbers ?? [],
      ocrMode: parsed.ocrMode,
      timingMs: parsed.timingMs,
    };
  } finally {
    await rm(tempPath, { force: true });
  }
}
