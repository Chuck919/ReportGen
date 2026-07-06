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

function scheduleLRetainLine(block: string): string | undefined {
  return block.split(/\n/).find((r) => /\b24\b/i.test(r) && /retain/i.test(r));
}

function isScheduleLContaminated(block: string): boolean {
  return (
    /schedule\s+l|balance\s*sheets?\s*per\s*books/i.test(block) &&
    /schedule\s+k|pro\s*rata|shareholder.{0,20}items|investment\s+income/i.test(block)
  );
}

/** Schedule L block has usable column amounts (not cross-form OCR garbage). */
function scheduleLUsable(block: string): boolean {
  if (!/schedule\s+l|balance\s*sheets?\s*per\s*books|\b15\b.{0,40}total\s+assets/i.test(block)) {
    return false;
  }
  if (isScheduleLContaminated(block)) return false;
  const commaMoney = (block.match(/\d{1,3}(?:,\d{3})+/g) || []).length;
  const l24 = scheduleLRetainLine(block);
  if (l24) return /\d{1,3}(?:,\d{3})+/.test(l24);
  return commaMoney >= 6;
}

function ocrPageBlockScore(block: string): number {
  const commaMoney = (block.match(/\d{1,3}(?:,\d{3})+/g) || []).length;
  const plainMoney = Math.min((block.match(/\d{4,}/g) || []).length, commaMoney * 2 + 5);
  const schedL = /schedule\s+l|line\s*(?:1[0-9]|2[0-4])\b/i.test(block) ? 5 : 0;
  const form1 = /\b1a\b|\[1c\]|gross receipt|caution:\s*include\s+only\s+trade/i.test(block) ? 5 : 0;
  const rentLine = /\brents?\b|\brens\b/i.test(block) && /\b11\b/.test(block) ? 3 : 0;
  let score = commaMoney * 3 + plainMoney + schedL + form1 + rentLine + block.length / 2500;
  if (isScheduleLContaminated(block)) score -= 20;
  const l24 = scheduleLRetainLine(block);
  if (l24 && !/\d{1,3}(?:,\d{3})+/.test(l24)) score -= 12;
  return score;
}

/** True when balanced (pass-1) page still needs hi-DPI help — only then may pass-2 replace it. */
function pageIsWeakBaseline(block: string): boolean {
  if (!block.trim()) return true;
  const commaMoney = (block.match(/\d{1,3}(?:,\d{3})+/g) || []).length;
  const isSchedL = /schedule\s+l|balance\s*sheets?\s*per\s*books/i.test(block);
  const isForm1 = /caution:\s*include\s+only\s+trade|gross receipts or sales/i.test(block);
  // Non-critical pages: never replace balanced baseline (avoids thorough < balanced regressions).
  if (!isSchedL && !isForm1) return false;
  if (isScheduleLContaminated(block)) return true;
  const missingRent = isForm1 && !/\brents?\b|\brens\b/i.test(block);
  const sparseSchedL = isSchedL && commaMoney < 4;
  const l24 = scheduleLRetainLine(block);
  const weakL24 = Boolean(l24 && !/\d{1,3}(?:,\d{3})+/.test(l24));
  return missingRent || sparseSchedL || weakL24;
}

/**
 * Merge thorough hi-DPI pages (b) onto balanced baseline (a).
 * Default is always pass-1 (balanced) so thorough cannot be worse than balanced.
 */
function mergeOcrPageTexts(a: string, b: string): { text: string; picks: number; pages: number } {
  const pagesA = extractOcrPages(a);
  const pagesB = extractOcrPages(b);
  const nums = [...new Set([...pagesA.keys(), ...pagesB.keys()])].sort((x, y) => x - y);
  const out: string[] = [];
  let picks = 0;
  for (const n of nums) {
    const blockA = pagesA.get(n) ?? "";
    const blockB = pagesB.get(n) ?? "";
    if (!blockB) {
      out.push(blockA);
      continue;
    }
    if (!blockA) {
      out.push(blockB);
      picks++;
      continue;
    }
    // Keep balanced unless that page is still weak and pass-2 is clearly better.
    if (!pageIsWeakBaseline(blockA)) {
      out.push(blockA);
      continue;
    }
    if (isScheduleLContaminated(blockB) && !isScheduleLContaminated(blockA)) {
      out.push(blockA);
      continue;
    }
    const aUsable = scheduleLUsable(blockA);
    const bUsable = scheduleLUsable(blockB);
    if (bUsable && !aUsable) {
      out.push(blockB);
      picks++;
      continue;
    }
    const scoreA = ocrPageBlockScore(blockA);
    const scoreB = ocrPageBlockScore(blockB);
    if (scoreB > scoreA + 8) {
      out.push(blockB);
      picks++;
      continue;
    }
    out.push(blockA);
  }
  return { text: out.join("\n"), picks, pages: nums.length };
}

/** Pages with Schedule L / form-1 that still look weak after merge — hi-DPI retry targets. */
function weakPagesForRetry(text: string): number[] {
  const weak: number[] = [];
  for (const [n, block] of extractOcrPages(text)) {
    const commaMoney = (block.match(/\d{1,3}(?:,\d{3})+/g) || []).length;
    const isSchedL = /schedule\s+l/i.test(block);
    const isForm1 = /caution:\s*include\s+only\s+trade|gross receipts or sales/i.test(block);
    if (!isSchedL && !isForm1) continue;
    const missingRent = isForm1 && !/\brents?\b|\brens\b/i.test(block);
    const missingLine17 =
      isSchedL &&
      /less\s+than\s+1\s+year|payable\s+in\s+less/i.test(block) &&
      commaMoney < 2;
    const sparseSchedL = isSchedL && commaMoney < 4;
    if (missingRent || missingLine17 || sparseSchedL) weak.push(n);
  }
  return [...new Set(weak)].sort((a, b) => a - b).slice(0, 8);
}

/** Thorough: balanced baseline + hi-DPI retry on weak pages only (never full heavy re-OCR). */
async function runThoroughMerged(
  bytes: Uint8Array,
  options?: { profile?: LocalOcrProfile; mode?: OcrMode },
) {
  const pass1 = await runOcrScript(bytes, { ...options, mode: "balanced" });
  let merged = { text: pass1.text, picks: 0, pages: extractOcrPages(pass1.text).size };
  let totalMs = pass1.timingMs?.total ?? 0;
  let mergePicks = 0;

  const retryPages = weakPagesForRetry(pass1.text);
  let pass2Logs: string[] = [];
  if (retryPages.length) {
    const pass2 = await runOcrScript(bytes, options, {
      FREE_OCR_MODE: "thorough",
      FREE_OCR_FORCE_PAGES: retryPages.join(","),
      FREE_OCR_FORCE_PHASE3: "1",
    });
    const merged2 = mergeOcrPageTexts(pass1.text, pass2.text);
    merged = merged2;
    mergePicks = merged2.picks;
    totalMs += pass2.timingMs?.total ?? 0;
    pass2Logs = [
      "--- thorough pass 2 (hi-dpi weak pages) ---",
      `pages: ${retryPages.join(",")}`,
      `merged ${merged2.picks}/${merged2.pages} from pass 2`,
    ];
  }

  return {
    ...pass1,
    text: merged.text,
    confidence: pass1.confidence,
    ocrMode: "thorough",
    timingMs: {
      ...pass1.timingMs,
      total: totalMs,
      thorough_merge_picks: mergePicks,
      thorough_retry_pages: retryPages.length,
    },
    logs: [
      ...pass1.logs,
      retryPages.length
        ? "thorough: balanced baseline + targeted hi-dpi retry"
        : "thorough: balanced baseline (no weak pages)",
      ...pass2Logs,
    ],
  };
}

export type OcrPlanResult = {
  totalPages: number;
  targets: number[];
  batches: number[][];
  batchSize: number;
  ocrMode: string;
  kind?: string;
  deltaFrom?: string;
  deltaOnly?: number[];
  reOcr?: number[];
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
  const env: Record<string, string> = { FREE_OCR_FORCE_PAGES: pages.join(",") };
  if (options?.forcePhase3) env.FREE_OCR_FORCE_PHASE3 = "1";
  return runOcrScript(bytes, options, env);
}

async function runOcrScript(
  bytes: Uint8Array,
  options?: { profile?: LocalOcrProfile; mode?: OcrMode },
  extraEnv?: Record<string, string>,
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
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [k, v] of Object.entries(extraEnv ?? {})) {
      env[k] = v;
    }
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
