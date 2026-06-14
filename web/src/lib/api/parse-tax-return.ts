import type { OcrMode, ParseTaxReturnResponse, ParsedTaxYear, ParseFileError } from "./types";
import {
  chunkArray,
  fetchOcrPages,
  fetchOcrPlan,
  mergeOcrPageTexts,
  OCR_BATCH_SIZE,
} from "./batched-ocr";
import { defaultOcrMode, isVercelDeploy } from "@/lib/tax/ocr-modes";
import { getMissingFieldsForNextTier } from "@/lib/tax/gap-analysis";
import { VERCEL_OCR_BUDGET_MS } from "@/lib/tax/resolve-ocr-mode";
import { validateClientFileList } from "@/lib/tax/validate-upload";

function ocrPageNumbers(text: string): number[] {
  const nums = new Set<number>();
  for (const m of text.matchAll(/--- OCR PAGE (\d+)/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) nums.add(n);
  }
  return Array.from(nums).sort((a, b) => a - b);
}

/** Vercel Hobby kills each function at 300s; thorough uses multiple requests under that cap. */
async function postParseTaxReturn(body: FormData, options?: { multiPass?: boolean }): Promise<Response> {
  const timeoutMs = isVercelDeploy()
    ? options?.multiPass
      ? VERCEL_OCR_BUDGET_MS * 2 + 60_000
      : VERCEL_OCR_BUDGET_MS + 15_000
    : 25 * 60_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch("/api/parse-tax-return", { method: "POST", body, signal: controller.signal });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(
        options?.multiPass
          ? "Thorough mode timed out (~10 min). Balanced pass may have saved partial data — retry or use Balanced."
          : "Request timed out (~5 min on Vercel). If other years finished, they are already saved. Retry with Fast or Balanced mode.",
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function parseApiError(res: Response, json: ParseTaxReturnResponse): string {
  if (json.error) return json.error;
  if (json.fileErrors?.length) return json.fileErrors.map((f) => `${f.filename}: ${f.message}`).join(" ");
  if (res.status === 504 || res.status === 502) {
    return "OCR timed out on the server (~5 min limit per request on Vercel Hobby). Try Balanced mode or one file at a time.";
  }
  return "Could not parse the uploaded tax return.";
}

export type ParseTaxReturnProgress = {
  fileIndex: number;
  fileCount: number;
  label: string;
  percent?: number;
};

export type ParseTaxReturnBatchResult = ParseTaxReturnResponse & {
  batchWarnings: string[];
};

/**
 * Thorough on Vercel: pass 1 = full Balanced OCR (one API call), pass 2 = hi-DPI delta
 * on blank fields via /api/ocr-pages (each call stays under 300s), then re-parse.
 */
async function parseThoroughTwoPass(
  file: File,
  options?: { targetYear?: string; onTierParsed?: (parsed: ParsedTaxYear) => void },
  onProgress?: (progress: ParseTaxReturnProgress) => void,
  fileMeta?: { fileIndex: number; fileCount: number },
): Promise<{ parsed: ParsedTaxYear; partial: boolean; logs: string[] }> {
  const idx = fileMeta?.fileIndex ?? 0;
  const count = fileMeta?.fileCount ?? 1;
  const logs: string[] = [];

  onProgress?.({
    fileIndex: idx,
    fileCount: count,
    label: "Thorough 1/2: Balanced scan…",
    percent: (idx / count) * 100 + 5,
  });

  const fd1 = new FormData();
  fd1.append("files", file);
  if (options?.targetYear && /^20\d{2}$/.test(options.targetYear)) {
    fd1.append("targetYear", options.targetYear);
  }
  fd1.append("ocrMode", "vercel-balanced");
  fd1.append("includeOcrText", "1");

  const res1 = await postParseTaxReturn(fd1, { multiPass: true });
  const json1 = (await res1.json()) as ParseTaxReturnResponse;
  if (!res1.ok && !json1.parsed?.length) {
    throw new Error(parseApiError(res1, json1));
  }
  if (json1.serverLogs?.length) logs.push(...json1.serverLogs);

  let parsed = json1.parsed[0]!;
  let ocrText = json1.ocrText ?? "";
  options?.onTierParsed?.({ ...parsed, filename: file.name });

  const missing = getMissingFieldsForNextTier(parsed, "vercel-thorough");
  if (!missing.length) {
    logs.push("Thorough pass 2 skipped — primary fields complete after Balanced.");
    return { parsed, partial: Boolean(json1.partial), logs };
  }

  onProgress?.({
    fileIndex: idx,
    fileCount: count,
    label: `Thorough 2/2: Hi-DPI retry (${missing.length} fields)…`,
    percent: (idx / count) * 100 + 45,
  });

  const plan = await fetchOcrPlan(file, "vercel-thorough", {
    deltaFrom: "vercel-balanced",
    alreadyPages: ocrPageNumbers(ocrText),
    missingFields: missing,
  });

  const batches = plan.batches.length ? plan.batches : chunkArray(plan.targets, OCR_BATCH_SIZE);
  for (let b = 0; b < batches.length; b++) {
    const pages = batches[b]!;
    onProgress?.({
      fileIndex: idx,
      fileCount: count,
      label: `Hi-DPI batch ${b + 1}/${batches.length} (${pages.length} pages)…`,
      percent: (idx / count) * 100 + 50 + (b / Math.max(batches.length, 1)) * 40,
    });
    const delta = await fetchOcrPages(file, "vercel-thorough", pages, { forcePhase3: true });
    ocrText = mergeOcrPageTexts([ocrText, delta.text]);
    if (delta.logs?.length) logs.push(...delta.logs);
  }

  const fd2 = new FormData();
  fd2.append("files", file);
  if (options?.targetYear && /^20\d{2}$/.test(options.targetYear)) {
    fd2.append("targetYear", options.targetYear);
  }
  fd2.append("ocrMode", "vercel-thorough");
  fd2.append("ocrText", ocrText);

  const res2 = await postParseTaxReturn(fd2, { multiPass: true });
  const json2 = (await res2.json()) as ParseTaxReturnResponse;
  if (json2.serverLogs?.length) logs.push(...json2.serverLogs);
  if (json2.parsed[0]) {
    parsed = json2.parsed[0];
    options?.onTierParsed?.({ ...parsed, filename: file.name });
  }

  return { parsed, partial: Boolean(json1.partial || json2.partial), logs };
}

function shouldRunThoroughMultiPass(ocrMode: OcrMode): boolean {
  return isVercelDeploy() && ocrMode === "vercel-thorough";
}

export async function parseTaxReturnFiles(
  files: File[],
  options?: { targetYear?: string; ocrMode?: OcrMode; onTierParsed?: (parsed: ParsedTaxYear) => void },
  onProgress?: (progress: ParseTaxReturnProgress) => void,
): Promise<ParseTaxReturnBatchResult> {
  const ocrMode = options?.ocrMode ?? defaultOcrMode();
  const validation = validateClientFileList(files, { isVercel: isVercelDeploy() });
  if (!validation.ok) {
    const msg = validation.checks.flatMap((c) => c.errors.map((e) => `${c.filename}: ${e}`)).join(" ");
    throw new Error(msg || "Invalid upload");
  }

  const allParsed: ParsedTaxYear[] = [];
  const allLogs: string[] = [];
  const fileErrors: ParseFileError[] = [];
  let partial = false;

  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;

    onProgress?.({
      fileIndex: i,
      fileCount: files.length,
      label: `Processing ${file.name} (${i + 1}/${files.length})`,
      percent: (i / files.length) * 100,
    });

    try {
      if (shouldRunThoroughMultiPass(ocrMode)) {
        const result = await parseThoroughTwoPass(
          file,
          options,
          onProgress,
          { fileIndex: i, fileCount: files.length },
        );
        allLogs.push(...result.logs);
        if (result.partial) partial = true;
        allParsed.push({ ...result.parsed, filename: file.name });
        continue;
      }

      const fd = new FormData();
      fd.append("files", file);
      if (options?.targetYear && /^20\d{2}$/.test(options.targetYear)) {
        fd.append("targetYear", options.targetYear);
      }
      fd.append("ocrMode", ocrMode);

      const res = await postParseTaxReturn(fd);
      const json = (await res.json()) as ParseTaxReturnResponse;
      if (!res.ok && !json.parsed?.length) {
        fileErrors.push({ filename: file.name, message: parseApiError(res, json) });
        continue;
      }
      if (json.serverLogs?.length) allLogs.push(...json.serverLogs);
      if (json.partial) partial = true;
      if (json.fileErrors?.length) {
        fileErrors.push(...json.fileErrors);
        partial = true;
      }
      for (const row of json.parsed ?? []) {
        allParsed.push(row);
        options?.onTierParsed?.(row);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Upload failed";
      fileErrors.push({ filename: file.name, message });
    }
  }

  if (!allParsed.length && fileErrors.length) {
    throw new Error(fileErrors.map((f) => `${f.filename}: ${f.message}`).join("\n"));
  }

  return {
    parsed: allParsed,
    fileErrors: fileErrors.length ? fileErrors : undefined,
    partial,
    serverLogs: allLogs,
    batchWarnings: validation.batchWarnings,
  };
}
