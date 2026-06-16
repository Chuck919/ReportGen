import type { OcrMode, ParseTaxReturnResponse, ParsedTaxYear, ParseFileError } from "./types";
import { defaultOcrMode, isVercelDeploy } from "@/lib/tax/ocr-modes";
import { VERCEL_OCR_BUDGET_MS } from "@/lib/tax/resolve-ocr-mode";
import { validateClientFileList } from "@/lib/tax/validate-upload";

async function postParseTaxReturn(body: FormData): Promise<Response> {
  const timeoutMs = isVercelDeploy() ? VERCEL_OCR_BUDGET_MS + 15_000 : 25 * 60_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch("/api/parse-tax-return", { method: "POST", body, signal: controller.signal });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(
        "Request timed out (~5 min on Vercel). If other years finished, they are already saved. Retry with Fast mode.",
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
