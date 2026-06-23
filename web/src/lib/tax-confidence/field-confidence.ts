import type { OcrCoverageDiagnostics } from "@/lib/tax-return/ocr-coverage-diagnostics";
import {
  STMT_ATTACHMENT_FIELD_IDS,
} from "@/lib/tax-return/ocr-coverage-rescan";
import type { OpexCandidate } from "@/lib/tax-return/opex-candidate-ranking";
import {
  capConfidenceForFlags,
  type ConfidenceFlag,
  confidenceFlagMessage,
  mergeConfidenceFlags,
} from "./confidence-flags";
import { opexCandidateUncertainty } from "./candidate-uncertainty";
import { isSuspiciousTaxValue } from "@/lib/tax-return/confidence-gates";
import {
  hasSourceDisagreement,
  sourceDisagreementDetail,
  type SourceSnapshot,
} from "./source-agreement";

export type FieldAlternative = {
  value: number;
  score: number;
  source: string;
  closureScore?: number;
  evidenceScore?: number;
  consistencyScore?: number;
};

export type FieldConfidence = {
  value: number;
  confidence: number;
  warnings: ConfidenceFlag[];
  alternatives?: FieldAlternative[];
};

export type ApplyFieldConfidenceInput = {
  fieldId: string;
  value: number;
  parserConfidence: number;
  displayConfidence: number;
  source?: string;
  taxYear?: number;
  existingFlags?: string[];
  sourceSnapshots?: SourceSnapshot[];
  opexCandidates?: OpexCandidate[];
  ocrCoverage?: OcrCoverageDiagnostics;
};

function ocrCoverageFlags(coverage: OcrCoverageDiagnostics): ConfidenceFlag[] {
  const flags: ConfidenceFlag[] = [];
  for (const raw of coverage.flags) {
    if (/stmt2-detail-incomplete|stmt2.?missing/i.test(raw)) flags.push("stmt2_missing_lines");
    if (/comparison-worksheet-missing/i.test(raw)) flags.push("comparison_missing");
    if (/schedule-l-not-detected/i.test(raw)) flags.push("missing_key_schedule");
  }
  if (!coverage.stmt2Found && coverage.comparisonWorksheetFound) {
    flags.push("stmt2_missing_lines");
  }
  if (!coverage.comparisonWorksheetFound) {
    flags.push("comparison_missing");
  }
  if (coverage.opexClosureRatio !== undefined && coverage.opexClosureRatio < 0.5) {
    flags.push("formula_inconsistency");
  }
  if (coverage.ocrPageCount !== undefined && coverage.ocrPageCount < 3) {
    flags.push("page_truncation");
  }
  const numericDensity = coverage.ocrPageCount
    ? (coverage.stmt2DetailSum ?? 0) / Math.max(coverage.ocrPageCount, 1)
    : undefined;
  if (numericDensity !== undefined && numericDensity < 5_000 && coverage.stmt2Found) {
    flags.push("low_numeric_density");
  }
  if (
    flags.some((f) =>
      ["stmt2_missing_lines", "comparison_missing", "page_truncation", "missing_key_schedule"].includes(f),
    )
  ) {
    flags.push("ocr_incomplete");
  }
  return [...new Set(flags)];
}

/** When document OCR is incomplete, flag statement-sourced attachment fields. */
function propagateDocumentOcrFlags(
  fieldId: string,
  _source: string | undefined,
  _existingFlags: string[] | undefined,
  ocrCoverage?: OcrCoverageDiagnostics,
): ConfidenceFlag[] {
  if (!ocrCoverage?.flags.length) return [];
  if (!STMT_ATTACHMENT_FIELD_IDS.has(fieldId)) return [];
  return ["ocr_incomplete"];
}

/**
 * Adjust display confidence and attach standardized warnings for one field.
 * Never changes the extracted value — confidence calibration only.
 */
export function applyFieldConfidence(input: ApplyFieldConfidenceInput): {
  displayConfidence: number;
  fieldFlags: string[];
  alternatives?: FieldAlternative[];
  warningCodes: ConfidenceFlag[];
} {
  const codes: ConfidenceFlag[] = [];

  if (input.sourceSnapshots?.length && hasSourceDisagreement(input.sourceSnapshots)) {
    codes.push("source_disagreement");
  }

  if (input.fieldId === "other_operating_expenses" && input.opexCandidates?.length) {
    const uncertainty = opexCandidateUncertainty(input.value, input.opexCandidates);
    codes.push(...uncertainty.flags);
  }

  if (input.fieldId === "other_operating_expenses" && input.ocrCoverage) {
    codes.push(...ocrCoverageFlags(input.ocrCoverage));
  }

  codes.push(
    ...propagateDocumentOcrFlags(
      input.fieldId,
      input.source,
      input.existingFlags,
      input.ocrCoverage,
    ),
  );

  if (
    isSuspiciousTaxValue(input.fieldId, input.value, input.source, input.taxYear)
  ) {
    codes.push("low_trust_source");
  }

  if (
    input.fieldId === "depreciation" &&
    input.value > 100_000 &&
    !/form 1120|schedule|comparison/i.test(input.source ?? "")
  ) {
    codes.push("low_trust_source");
  }

  if (
    input.fieldId === "interest_expense" &&
    input.value > 1_000 &&
    !/form 1120|schedule|comparison/i.test(input.source ?? "")
  ) {
    codes.push("low_trust_source");
  }

  if (
    (input.fieldId === "taxes_paid" || input.fieldId === "other_current_liabilities") &&
    input.value > 0 &&
    input.value < 100_000 &&
    !/form 1120|schedule|comparison|statement \(line/i.test(input.source ?? "")
  ) {
    codes.push("low_trust_source");
  }

  const displayConfidence = capConfidenceForFlags(input.displayConfidence, codes);

  let fieldFlags = mergeConfidenceFlags(input.existingFlags, codes);

  if (input.sourceSnapshots?.length) {
    const detail = sourceDisagreementDetail(input.sourceSnapshots, input.value);
    if (detail && !fieldFlags.some((f) => /other reads/i.test(f))) {
      fieldFlags = [...fieldFlags, detail];
    }
  }

  for (const code of codes) {
    const msg = confidenceFlagMessage(code);
    if (!fieldFlags.includes(code) && !fieldFlags.includes(msg)) {
      fieldFlags.push(msg);
    }
  }

  const alternatives =
    input.fieldId === "other_operating_expenses" && input.opexCandidates?.length
      ? opexCandidateUncertainty(input.value, input.opexCandidates).alternatives
      : undefined;

  return {
    displayConfidence,
    fieldFlags,
    alternatives: alternatives?.length ? alternatives : undefined,
    warningCodes: codes,
  };
}

/** Build a structured confidence view for API/debug consumers. */
export function buildFieldConfidence(
  input: ApplyFieldConfidenceInput,
): FieldConfidence {
  const result = applyFieldConfidence(input);
  return {
    value: input.value,
    confidence: result.displayConfidence,
    warnings: result.warningCodes,
    alternatives: result.alternatives,
  };
}

/**
 * Apply confidence layer across all input fields on a parsed year column.
 */
export function applyWorkbookConfidenceLayer(input: {
  values: Record<string, number>;
  confidence: Record<string, number>;
  displayConfidence: Record<string, number>;
  fieldFlags: Record<string, string[]>;
  fieldSources?: Record<string, string>;
  sourceSnapshots?: Record<string, SourceSnapshot[]>;
  opexCandidates?: OpexCandidate[];
  ocrCoverage?: OcrCoverageDiagnostics;
  fieldIds: string[];
  taxYear?: number;
}): {
  displayConfidence: Record<string, number>;
  fieldFlags: Record<string, string[]>;
  fieldAlternatives: Record<string, FieldAlternative[]>;
} {
  const displayConfidence = { ...input.displayConfidence };
  const fieldFlags = { ...input.fieldFlags };
  const fieldAlternatives: Record<string, FieldAlternative[]> = {};

  for (const fieldId of input.fieldIds) {
    const value = input.values[fieldId];
    if (value === undefined) continue;

    const result = applyFieldConfidence({
      fieldId,
      value,
      parserConfidence: input.confidence[fieldId] ?? 70,
      displayConfidence: displayConfidence[fieldId] ?? input.confidence[fieldId] ?? 70,
      source: input.fieldSources?.[fieldId],
      taxYear: input.taxYear,
      existingFlags: fieldFlags[fieldId],
      sourceSnapshots: input.sourceSnapshots?.[fieldId],
      opexCandidates: fieldId === "other_operating_expenses" ? input.opexCandidates : undefined,
      ocrCoverage: input.ocrCoverage,
    });

    displayConfidence[fieldId] = result.displayConfidence;
    fieldFlags[fieldId] = result.fieldFlags;
    if (result.alternatives?.length) {
      fieldAlternatives[fieldId] = result.alternatives;
    }
  }

  return { displayConfidence, fieldFlags, fieldAlternatives };
}
