import type { TaxYearValues } from "@/lib/tax-workbook";
import type { BenchmarkEntryRow } from "@/lib/benchmark-entry";
import { defaultOcrModeForDeploy, resolveOcrModeForDeploy } from "@/lib/tax/resolve-ocr-mode";

export type OcrMode = "fast" | "balanced" | "thorough";

const OCR_MODES = new Set<OcrMode>(["fast", "balanced", "thorough"]);

export function parseOcrMode(raw: unknown): OcrMode {
  const key = typeof raw === "string" ? raw : "";
  if (!OCR_MODES.has(key as OcrMode)) return defaultOcrModeForDeploy();
  return resolveOcrModeForDeploy(key);
}

export type ParseTaxReturnDebug = {
  embeddedTextLen: number;
  ocrPageCount?: number;
  ocrTimingMs?: Record<string, number>;
  ocrLogs?: string[];
  resolvedFieldCount?: number;
  comparisonLinesMatched?: number;
  opexCandidates?: import("@/lib/tax-return/opex-candidate-ranking").OpexCandidate[];
  opexChosenSource?: string;
  coverage?: import("@/lib/tax-return/ocr-coverage-diagnostics").OcrCoverageDiagnostics;
};

export type ParsedTaxYear = TaxYearValues & {
  filename: string;
  debug?: ParseTaxReturnDebug;
  /** ok | partial (e.g. OCR timeout with embedded fallback) | error */
  parseStatus?: "ok" | "partial" | "error";
};

export type ParseFileError = {
  filename: string;
  message: string;
};

export type ParseTaxReturnResponse = {
  parsed: ParsedTaxYear[];
  fileErrors?: ParseFileError[];
  partial?: boolean;
  serverLogs?: string[];
  /** Present when POST includeOcrText=1 (thorough pass-1 baseline for client merge). */
  ocrText?: string;
  error?: string;
};

export type ParseBenchmarkResponse = {
  filename: string;
  benchmarkRows: BenchmarkEntryRow[];
  ocrUsed?: boolean;
  ocr?: { pages: number; confidence: number };
  parsed: {
    industry?: string;
    naics?: string;
    yearLabels: string[];
    scorecard: Record<string, number | undefined>;
    factKeys: string[];
    industryCommonSizeColumn?: number;
    industryCommonSizeKeys?: string[];
  };
  error?: string;
};
