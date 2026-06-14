import { PDFParse } from "pdf-parse";
import { parseTaxReturn } from "@/lib/tax-return-parser";
import type { OcrMode, ParsedTaxYear } from "@/lib/api/types";
import { assessParseQuality } from "@/lib/tax/parse-quality";
import { hintsFromPdfInspect } from "@/lib/tax/validate-upload";
import { inspectPdfBuffer } from "@/lib/tax/pdf-inspect";
import { isProcessTimeoutError, ocrTimeoutUserMessage } from "@/lib/tax/ocr-errors";
import { maxFilesPerApiRequest } from "@/lib/tax/upload-policy";
import { isVercelRuntime } from "@/lib/tax/resolve-ocr-mode";

export type ProcessFileResult =
  | { status: "ok"; parsed: ParsedTaxYear; ocrText?: string }
  | { status: "partial"; parsed: ParsedTaxYear; message: string; ocrText?: string }
  | { status: "error"; filename: string; message: string };

export function enforceFileCountLimit(fileCount: number): string | null {
  const max = maxFilesPerApiRequest(isVercelRuntime());
  if (fileCount > max) {
    return `Upload one PDF at a time on Vercel (received ${fileCount}). Process years sequentially from the client.`;
  }
  return null;
}

export async function processTaxPdfFile(
  file: File,
  ocrMode: OcrMode,
  options?: { yearOverride?: number; preOcrText?: string; log?: (msg: string) => void },
): Promise<ProcessFileResult> {
  const log = options?.log ?? (() => {});
  const master = Buffer.from(await file.arrayBuffer());
  const forParse = Buffer.from(master);
  const forPipeline = Buffer.from(master);

  let inspect;
  try {
    inspect = await inspectPdfBuffer(forParse);
    log(`  inspect pages=${inspect.pageCount} embeddedLen=${inspect.embeddedTextLen} scanned=${inspect.likelyScanned}`);
  } catch {
    return { status: "error", filename: file.name, message: "Could not read PDF — file may be corrupt or password-protected." };
  }

  const parser = new PDFParse({ data: forParse });
  let embedded: string;
  try {
    const textResult = await parser.getText();
    embedded = textResult.text ?? "";
    await parser.destroy?.();
  } catch {
    await parser.destroy?.();
    return { status: "error", filename: file.name, message: "Could not extract text from PDF." };
  }

  const hintWarnings = hintsFromPdfInspect(inspect, isVercelRuntime());

  try {
    const result = await parseTaxReturn(
      file.name,
      forPipeline,
      embedded,
      options?.yearOverride,
      ocrMode,
      options?.preOcrText,
    );

    const quality = assessParseQuality(result.values);
    const warnings = [...hintWarnings, ...(result.warnings ?? [])];
    if (quality.incomplete) {
      warnings.push(
        `Only ${quality.primaryFilled}/${quality.primaryTotal} primary fields extracted — upload may be incomplete, split across files, or need Balanced/Thorough OCR.`,
      );
    }

    const parsed: ParsedTaxYear = {
      filename: file.name,
      ...result,
      warnings,
      parseStatus: result.parseStatus ?? "ok",
    };
    delete (parsed as { ocrText?: string }).ocrText;

    if (result.parseStatus === "partial") {
      return {
        status: "partial",
        parsed,
        message: ocrTimeoutUserMessage(),
        ocrText: result.ocrText,
      };
    }
    return { status: "ok", parsed, ocrText: result.ocrText };
  } catch (e) {
    const message = isProcessTimeoutError(e)
      ? ocrTimeoutUserMessage()
      : e instanceof Error
        ? e.message
        : "Parse failed";
    log(`  error: ${message}`);
    return { status: "error", filename: file.name, message };
  }
}
