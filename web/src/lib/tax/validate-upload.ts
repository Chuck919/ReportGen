import {
  MAX_PDF_BYTES,
  SCANNED_EMBEDDED_TEXT_THRESHOLD,
  WARN_FILES_PER_DROP,
  WARN_PAGE_COUNT_VERCEL,
  maxFilesPerApiRequest,
} from "./upload-policy";
import { SUPPORTED_TAX_FORMS_LABEL } from "./tax-form-copy";

export type UploadFileCheck = {
  filename: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
};

export function validatePdfFilename(name: string): string[] {
  const errors: string[] = [];
  if (!/\.pdf$/i.test(name)) errors.push("File must be a PDF (.pdf extension).");
  return errors;
}

export function validatePdfFileSize(size: number): string[] {
  if (size <= 0) return ["File is empty."];
  if (size > MAX_PDF_BYTES) {
    return [`File exceeds ${Math.round(MAX_PDF_BYTES / (1024 * 1024))} MB limit.`];
  }
  return [];
}

export function validateClientFileList(
  files: File[],
  options?: { isVercel?: boolean },
): { ok: boolean; checks: UploadFileCheck[]; batchWarnings: string[] } {
  const isVercel = options?.isVercel ?? false;
  const batchWarnings: string[] = [];
  const checks: UploadFileCheck[] = [];

  if (files.length > WARN_FILES_PER_DROP) {
    batchWarnings.push(
      `You selected ${files.length} files. Each is processed separately (~3–5 min on Vercel). Consider uploading one tax year at a time.`,
    );
  }

  if (isVercel && files.length > 1) {
    batchWarnings.push(
      "On Vercel, upload one PDF at a time for reliable results. Multiple files will be processed sequentially.",
    );
  }

  const maxPerRequest = maxFilesPerApiRequest(isVercel);

  for (const file of files) {
    const errors = [
      ...validatePdfFilename(file.name),
      ...validatePdfFileSize(file.size),
    ];
    if (file.type && file.type !== "application/pdf") {
      errors.push(`Expected application/pdf, got ${file.type}.`);
    }
    checks.push({ filename: file.name, ok: errors.length === 0, errors, warnings: [] });
  }

  if (files.length > maxPerRequest && isVercel) {
    batchWarnings.push(`API accepts ${maxPerRequest} file per request on Vercel (client queues automatically).`);
  }

  return { ok: checks.every((c) => c.ok), checks, batchWarnings };
}

export type PdfInspectHints = {
  pageCount: number;
  embeddedTextLen: number;
  likelyScanned: boolean;
  likelyTaxReturn: boolean;
};

export function hintsFromPdfInspect(inspect: PdfInspectHints, isVercel?: boolean): string[] {
  const warnings: string[] = [];
  if (!inspect.likelyTaxReturn) {
    warnings.push(
      `This PDF may not be a business tax return (no ${SUPPORTED_TAX_FORMS_LABEL} or Schedule L signals in embedded text).`,
    );
  }
  if (inspect.likelyScanned) {
    warnings.push(
      "PDF appears to be scanned (little embedded text). OCR will run and may take several minutes.",
    );
  }
  if (isVercel && inspect.pageCount > WARN_PAGE_COUNT_VERCEL) {
    warnings.push(
      `${inspect.pageCount} pages detected — large returns may approach the 5-minute Vercel limit. Use Balanced mode or a VPS.`,
    );
  }
  return warnings;
}

export function isLikelyScannedPdf(embeddedTextLen: number): boolean {
  return embeddedTextLen < SCANNED_EMBEDDED_TEXT_THRESHOLD;
}

export function isLikelyTaxReturnText(text: string): boolean {
  return /1120|1065|1041|schedule\s*l|balance\s*sheet|gross\s*receipt|form\s*1120|partnership\s+income|estates?\s+and\s+trusts/i.test(
    text,
  );
}
