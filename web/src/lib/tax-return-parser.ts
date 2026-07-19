import { parseFinancialTablesFromText, type YearSeries } from "@/lib/financial-text-parser";
import { TAX_WORKBOOK_ROWS, type TaxYearValues } from "@/lib/tax-workbook";
import { inferTaxYear } from "@/lib/tax-return/infer-year";
import { findHitsLineScoped } from "@/lib/tax-return/line-hits";
import { runLocalOcr, type OcrMode } from "@/lib/tax-return/local-ocr";
import { rescanMissingAttachmentsExperimental } from "@/lib/tax/ocr-recovery-experimental";
import { parseTaxReturnFromText } from "@/lib/tax-return/parse-from-text";
import { buildOcrCoverageDiagnostics } from "@/lib/tax-return/ocr-coverage-diagnostics";
import { isProcessTimeoutError, ocrTimeoutUserMessage } from "@/lib/tax/ocr-errors";
import { clientIdentityFromText } from "@/lib/tax-return/extract-business-name";
import { applyTaxYearVerification, buildVerificationSnapshots } from "@/lib/tax/reconcile-tax-year";

export { extractFormAnchors } from "@/lib/tax-return/form-anchors";
export { parseTaxReturnFromText } from "@/lib/tax-return/parse-from-text";
export { extractStatementDeductions, extractStatementOtherIncome } from "@/lib/tax-return/statement-extractors";
export { inferTaxYear } from "@/lib/tax-return/infer-year";
export { runLocalOcr } from "@/lib/tax-return/local-ocr";

const INPUT_ROW_IDS = new Set(
  TAX_WORKBOOK_ROWS.filter((row) => row.excelBehavior === "input").map((row) => row.id),
);

function usesAttachmentGapRescan(mode: OcrMode): boolean {
  return mode === "thorough" || mode === "balanced";
}

const FACT_TO_TAX_ID: Record<string, string> = {
  sales: "sales",
  cogs: "cogs",
  depreciation_is: "depreciation",
  amortization_is: "amortization",
  officer_comp: "officer_compensation",
  ga_payroll: "salaries_wages",
  rent: "rent",
  advertising: "advertising",
  taxes_licenses: "taxes_licenses",
  bank_cc_fees: "bank_credit_card",
  professional_fees: "professional_fees",
  utilities: "utilities",
  other_operating_expenses: "other_operating_expenses",
  interest_expense: "interest_expense",
  other_income: "other_income",
  cash: "cash",
  ar: "accounts_receivable",
  inventory: "inventory",
  other_ca: "other_current_assets",
  gross_fixed: "gross_fixed_assets",
  acc_dep: "accumulated_depreciation",
  gross_intangible: "gross_intangible_assets",
  acc_amortization: "accumulated_amortization",
  other_assets: "other_assets",
  ap: "accounts_payable",
  other_cl: "other_current_liabilities",
  senior_debt: "notes_minus_short_term",
  unclassified_equity: "unclassified_equity",
};

function mapFinancialFacts(facts: Record<string, YearSeries>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [factKey, taxId] of Object.entries(FACT_TO_TAX_ID)) {
    if (!INPUT_ROW_IDS.has(taxId)) continue;
    const series = facts[factKey];
    if (!series || typeof series[2] !== "number") continue;
    out[taxId] = Math.round(series[2]);
  }
  return out;
}

function tryStructuredTable(text: string) {
  if (text.length < 80) return null;
  const parsed = parseFinancialTablesFromText(text);
  if (Object.keys(parsed.facts).length < 5) return null;
  const values = mapFinancialFacts(parsed.facts);
  if (Object.keys(values).length < 5) return null;
  const confidence: Record<string, number> = {};
  const sources: Record<string, string> = {};
  for (const id of Object.keys(values)) {
    confidence[id] = 99;
    sources[id] = "Structured financial table";
  }
  return { values, confidence, sources };
}

import type { OpexCandidate } from "@/lib/tax-return/opex-candidate-ranking";
import type { OcrCoverageDiagnostics } from "@/lib/tax-return/ocr-coverage-diagnostics";

export type ParseTaxReturnDebug = {
  embeddedTextLen: number;
  structuredTableFields?: number;
  embeddedLineHits?: number;
  ocrPageCount?: number;
  ocrTimingMs?: Record<string, number>;
  ocrLogs?: string[];
  combinedHitCount?: number;
  resolvedFieldCount?: number;
  relaxedSecondPass?: boolean;
  comparisonLinesMatched?: number;
  comparisonHeaderYears?: [number, number];
  comparisonColumnUsed?: 0 | 1;
  coverage?: OcrCoverageDiagnostics;
  opexCandidates?: OpexCandidate[];
  opexChosenSource?: string;
};

function tryEmbeddedFullParse(
  filename: string,
  embeddedText: string,
  yearOverride?: number,
  ocrMode?: OcrMode,
): (TaxYearValues & { fieldSources?: Record<string, string> }) | null {
  if (ocrMode === "thorough" || ocrMode === "balanced") return null;
  if (embeddedText.trim().length < 600) return null;
  if (!/1120|schedule\s*l|balance\s*sheet|gross\s*receipt/i.test(embeddedText)) return null;

  const yearProbe =
    yearOverride && yearOverride >= 2000 && yearOverride <= 2100
      ? yearOverride
      : inferTaxYear(filename, embeddedText);
  if (!yearProbe) return null;

  const parsed = parseTaxReturnFromText(filename, embeddedText, "", yearOverride);
  const filled = Object.values(parsed.values).filter((v) => v !== undefined).length;
  const hits = findHitsLineScoped(embeddedText, 55, parsed.year ?? yearProbe).length;
  const hasBalanceSheet = /schedule\s*l|total\s*assets|total\s*liabilit/i.test(embeddedText);

  if (filled >= 14 && hits >= 10 && hasBalanceSheet) {
    return parsed;
  }
  return null;
}

export async function parseTaxReturn(
  filename: string,
  bytes: Uint8Array,
  embeddedText: string,
  yearOverride?: number,
  ocrMode: OcrMode = "balanced",
  preOcrText?: string,
): Promise<
  TaxYearValues & {
    debug: ParseTaxReturnDebug;
    fieldSources?: Record<string, string>;
    parseStatus?: "ok" | "partial";
    /** Raw OCR text from this request (when OCR ran server-side). */
    ocrText?: string;
  }
> {
  const debug: ParseTaxReturnDebug = { embeddedTextLen: embeddedText.length };

  const structured = tryStructuredTable(embeddedText);
  if (structured) {
    const year =
      yearOverride && yearOverride >= 2000 && yearOverride <= 2100
        ? yearOverride
        : inferTaxYear(filename, embeddedText);
    if (!year) throw new Error("Could not determine tax year from document text.");
    const identity = clientIdentityFromText(embeddedText, filename);
    const verified = applyTaxYearVerification(
      {
        year,
        values: structured.values,
        confidence: structured.confidence,
        fieldSources: structured.sources,
        warnings: [`Structured financial table extracted (${Object.keys(structured.values).length} fields).`],
        source: "embedded-financial-table",
        ...identity,
      },
      buildVerificationSnapshots({
        formAnchors: { values: {}, confidence: {}, sources: {} },
        statements: { values: {}, confidence: {}, sources: {} },
        fuzzy: { values: {}, confidence: {}, sources: {} },
        embeddedScheduleL: { values: {}, confidence: {}, sources: {} },
        structured,
      }),
    );
    return { ...verified, debug };
  }

  const yearProbe =
    yearOverride && yearOverride >= 2000 && yearOverride <= 2100
      ? yearOverride
      : inferTaxYear(filename, embeddedText);
  debug.embeddedLineHits = findHitsLineScoped(embeddedText, 99, yearProbe).length;

  const embeddedOnly = tryEmbeddedFullParse(filename, embeddedText, yearOverride, ocrMode);
  if (embeddedOnly) {
    debug.resolvedFieldCount = Object.keys(embeddedOnly.values).length;
    debug.combinedHitCount = findHitsLineScoped(embeddedText, 65, embeddedOnly.year).length;
    return {
      ...embeddedOnly,
      warnings: [
        `Parsed from embedded PDF text (${Object.keys(embeddedOnly.values).length} fields, no OCR).`,
        ...(embeddedOnly.warnings ?? []),
      ],
      source: "embedded-text",
      debug,
    };
  }

  let ocrText: string;
  let ocrModeLabel = ocrMode;
  if (preOcrText !== undefined) {
    ocrText = preOcrText;
    debug.ocrPageCount = (preOcrText.match(/--- OCR PAGE \d+/g) || []).length;
    debug.ocrLogs = [`Pre-built OCR text (${debug.ocrPageCount} pages, batched client OCR).`];
  } else {
    try {
      const ocr = await runLocalOcr(bytes, { profile: "tax", mode: ocrMode });
      ocrText = ocr.text;
      debug.ocrPageCount = ocr.pages;
      debug.ocrTimingMs = ocr.timingMs;
      debug.ocrLogs = [...ocr.logs];
      ocrModeLabel = (ocr.ocrMode ?? ocrMode) as OcrMode;

      if (usesAttachmentGapRescan(ocrMode)) {
        // Baseline for "which pages have we already OCR'd" is the balanced-tier equivalent
        // of whatever mode actually ran (thorough modes build on top of balanced internally;
        // balanced modes already are that baseline).
        const baselineMode = "balanced";
        const gap = await rescanMissingAttachmentsExperimental(
          bytes,
          embeddedText,
          ocrText,
          filename,
          yearProbe ?? undefined,
          baselineMode,
        );
        if (gap.ran) {
          ocrText = gap.ocrText;
          debug.ocrPageCount = (ocrText.match(/--- OCR PAGE \d+/g) || []).length;
          debug.ocrLogs!.push(
            `Attachment gap rescan: ${gap.pages.length} pages (${gap.pages.join(",")}), ${gap.ms}ms`,
          );
          if (debug.ocrTimingMs?.total !== undefined) {
            debug.ocrTimingMs.total += gap.ms;
          }
        }
      }
    } catch (e) {
      if (isProcessTimeoutError(e)) {
        const embeddedFallback = tryEmbeddedFullParse(filename, embeddedText, yearOverride, ocrMode);
        if (embeddedFallback) {
          debug.resolvedFieldCount = Object.keys(embeddedFallback.values).length;
          return {
            ...embeddedFallback,
            parseStatus: "partial",
            warnings: [
              ocrTimeoutUserMessage(),
              `Partial result from embedded PDF text only (${Object.keys(embeddedFallback.values).length} fields).`,
              ...(embeddedFallback.warnings ?? []),
            ],
            source: "embedded-text-timeout-fallback",
            debug,
          };
        }
        const minimal = parseTaxReturnFromText(filename, embeddedText, "", yearOverride);
        if (Object.keys(minimal.values).length > 0) {
          debug.resolvedFieldCount = Object.keys(minimal.values).length;
          return {
            ...minimal,
            parseStatus: "partial",
            warnings: [ocrTimeoutUserMessage(), "Partial result from embedded text before OCR completed."],
            source: "embedded-partial-timeout",
            debug,
          };
        }
      }
      throw e;
    }
  }

  const parsed = parseTaxReturnFromText(filename, embeddedText, ocrText, yearOverride, {
    ocrMode: ocrModeLabel,
    parseDebug: {
      onOpexReconcile: (d) => {
        debug.opexCandidates = d.candidates;
        debug.opexChosenSource = d.chosenSource;
      },
    },
  });
  debug.resolvedFieldCount = Object.keys(parsed.values).length;
  debug.combinedHitCount = findHitsLineScoped(`${embeddedText}\n${ocrText}`, 65, parsed.year).length;

  const allText = `${embeddedText}\n${ocrText}`;
  const rescanMatch = debug.ocrLogs?.find((l) => /Attachment gap rescan:/.test(l));
  const rescanPages = rescanMatch
    ? rescanMatch.match(/\(([^)]+)\)/)?.[1]?.split(",").map(Number).filter(Boolean)
    : undefined;
  debug.coverage = buildOcrCoverageDiagnostics(
    allText,
    { values: parsed.values, confidence: parsed.confidence ?? {}, sources: parsed.fieldSources ?? {}, warnings: [] },
    {
      targetYear: parsed.year,
      opex: parsed.values.other_operating_expenses,
      ocrPageCount: debug.ocrPageCount,
      attachmentRescanPages: rescanPages,
    },
  );

  const warnings = [
    preOcrText !== undefined
      ? `OCR (${ocrModeLabel}, batched): ${debug.ocrPageCount} page(s).`
      : `OCR (${ocrModeLabel}): ${debug.ocrPageCount} page(s).`,
    ...(parsed.warnings ?? []),
  ];

  if (!Object.keys(parsed.values).length) {
    throw new Error(`No workbook input rows detected after OCR.`);
  }

  return {
    ...parsed,
    ocrText: preOcrText === undefined ? ocrText : undefined,
    warnings,
    debug,
  };
}
