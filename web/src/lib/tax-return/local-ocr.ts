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
  return runOcrScript(bytes, options);
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
    if (process.env.VERCEL === "1" && !env.FREE_OCR_WORKERS) {
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
    if (process.env.VERCEL === "1" && !env.FREE_OCR_WORKERS) {
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
