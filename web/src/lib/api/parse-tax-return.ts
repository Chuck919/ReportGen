import type { OcrMode, ParseTaxReturnResponse, ParsedTaxYear, ParseFileError } from "./types";
import { defaultOcrMode, estimateOcrDurationMs, OCR_PROGRESS_CAP } from "@/lib/tax/ocr-modes";
import { validateClientFileList } from "@/lib/tax/validate-upload";

async function postParseTaxReturn(body: FormData): Promise<Response> {
  const timeoutMs = 25 * 60_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch("/api/parse-tax-return", { method: "POST", body, signal: controller.signal });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(
        "Request timed out. If other years finished, they are already saved. Try Balanced mode or process one file at a time.",
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
    return "Processing timed out on the server. Try Balanced mode or one file at a time.";
  }
  return "Could not parse the uploaded tax return.";
}

export type ParseTaxReturnProgress = {
  fileIndex: number;
  fileCount: number;
  label: string;
  percent?: number;
  hint?: string;
};

async function postParseTaxReturnWithProgress(
  body: FormData,
  meta: { fileIndex: number; fileCount: number; filename: string; ocrMode: OcrMode },
  onProgress?: (progress: ParseTaxReturnProgress) => void,
): Promise<Response> {
  const perFileMs = estimateOcrDurationMs(meta.ocrMode, 1);
  const fileSpan = 100 / Math.max(meta.fileCount, 1);
  const basePercent = (meta.fileIndex / meta.fileCount) * 100;
  const start = Date.now();

  const tick = () => {
    const elapsed = Date.now() - start;
    const slice = Math.min(OCR_PROGRESS_CAP, elapsed / perFileMs);
    const modeLabel =
      meta.ocrMode === "fast" ? "Fast" : meta.ocrMode === "thorough" ? "Thorough" : "Balanced";
    onProgress?.({
      fileIndex: meta.fileIndex,
      fileCount: meta.fileCount,
      label: `OCR (${modeLabel}): ${meta.filename} (${meta.fileIndex + 1}/${meta.fileCount})`,
      percent: basePercent + slice * fileSpan,
      hint:
        meta.fileCount > 1
          ? `Processing ${meta.fileCount} files one at a time.`
          : "Extracting values from your PDF…",
    });
  };

  tick();
  const timer = setInterval(tick, 400);
  try {
    return await postParseTaxReturn(body);
  } finally {
    clearInterval(timer);
  }
}

export type ParseTaxReturnBatchResult = ParseTaxReturnResponse & {
  batchWarnings: string[];
};

export async function parseTaxReturnFiles(
  files: File[],
  options?: { targetYear?: string; ocrMode?: OcrMode; onTierParsed?: (parsed: ParsedTaxYear) => void },
  onProgress?: (progress: ParseTaxReturnProgress) => void,
): Promise<ParseTaxReturnBatchResult> {
  const ocrMode = options?.ocrMode ?? defaultOcrMode();
  const validation = validateClientFileList(files);
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
      label: `Starting ${file.name} (${i + 1}/${files.length})`,
      percent: (i / files.length) * 100,
      hint: "Uploading PDF to server…",
    });

    try {
      const fd = new FormData();
      fd.append("files", file);
      if (options?.targetYear && /^20\d{2}$/.test(options.targetYear)) {
        fd.append("targetYear", options.targetYear);
      }
      fd.append("ocrMode", ocrMode);

      const res = await postParseTaxReturnWithProgress(
        fd,
        { fileIndex: i, fileCount: files.length, filename: file.name, ocrMode },
        onProgress,
      );
      const raw = await res.text();
      let json: ParseTaxReturnResponse;
      try {
        json = (raw ? JSON.parse(raw) : {}) as ParseTaxReturnResponse;
      } catch {
        fileErrors.push({
          filename: file.name,
          message:
            raw.trim().length === 0
              ? `Empty response from server (HTTP ${res.status}) — retry this year`
              : `Invalid JSON from server (HTTP ${res.status}): ${raw.slice(0, 120)}`,
        });
        partial = true;
        continue;
      }
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

      onProgress?.({
        fileIndex: i,
        fileCount: files.length,
        label: `Finished ${file.name}`,
        percent: ((i + 1) / files.length) * 100,
      });
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
