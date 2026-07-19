import type { OcrCoverageDiagnostics } from "../../src/lib/tax-return/ocr-coverage-diagnostics";
import type { OpexCandidate } from "../../src/lib/tax-return/opex-candidate-ranking";
import type { TaxYearValues } from "../../src/lib/tax-workbook";
import { TAX_WORKBOOK_ROWS } from "../../src/lib/tax-workbook";
import { WORKBOOK_COMPARISON_FIXTURES } from "./workbook-comparison-fixtures";
import { flagCodeInText } from "../../src/lib/tax-confidence/confidence-flags";
import changwenFixtures from "../changwen-fixtures.json";
import {
  fieldMatches,
  moneyTolerance,
  type FieldMiss,
  type PrimaryScore,
} from "./tax-benchmark-score";
import { OPERATING_EXPENSE_SLOT_IDS } from "../../src/lib/tax/operating-expenses";

const INPUT_IDS = TAX_WORKBOOK_ROWS.filter((r) => r.excelBehavior === "input").map((r) => r.id);
const OPEX_SLOT_SET = new Set<string>(OPERATING_EXPENSE_SLOT_IDS);

/** displayConfidence at or above this is treated as "high confidence" for calibration. */
export const HIGH_CONFIDENCE_THRESHOLD = 75;
/** Below this is "low confidence". */
export const LOW_CONFIDENCE_THRESHOLD = 65;

export type MissDiagnosis =
  | "ocr_coverage"
  | "candidate_selection"
  | "source_disagreement"
  | "parsing_failure"
  | "formula_inconsistency"
  | "low_trust_source"
  | "correct"
  | "unknown";

export type FieldMissDiagnostic = {
  field: string;
  expected: number;
  actual?: number;
  confidence: number;
  parserConfidence?: number;
  source?: string;
  flags: string[];
  flagged: boolean;
  diagnosis: MissDiagnosis;
  whyChosen?: string;
  whyLowConfidence?: string;
  alternatives?: Array<{ value: number; score?: number; source: string }>;
  ocrFlags?: string[];
};

export type FieldCalibrationBucket =
  | "correct_high"
  | "correct_low"
  | "wrong_high_unflagged"
  | "wrong_low_flagged"
  | "wrong_high_flagged"
  | "wrong_low_unflagged";

export type FieldCalibrationRow = {
  field: string;
  expected: number;
  actual?: number;
  correct: boolean;
  displayConfidence: number;
  flags: string[];
  flagged: boolean;
  bucket: FieldCalibrationBucket;
};

export type ConfidenceCalibrationCurveBin = {
  bin: string;
  min: number;
  max: number;
  total: number;
  correct: number;
  wrong: number;
  accuracyPct: number;
};

export type ConfidenceCalibration = {
  totalFields: number;
  wrongFields: number;
  correctFields: number;
  wrongFlagged: number;
  wrongUnflagged: number;
  failureDetectionRate: number;
  wrongHighConfidence: number;
  wrongLowConfidence: number;
  correctLowConfidence: number;
  wrongHighConfidenceRate: number;
  wrongLowConfidenceRate: number;
  correctLowConfidenceRate: number;
  dangerousFailures: number;
  curve: ConfidenceCalibrationCurveBin[];
  rows: FieldCalibrationRow[];
};

const WARNING_FLAG =
  /candidate_conflict|source_disagreement|formula_inconsistency|ocr_incomplete|comparison_missing|stmt2_missing|page_truncation|low_numeric_density|verify manually|other reads|sources disagree|subtractive|low-trust|residual opex|formula-disagreement/i;

function getFixtureValues(fixtureKey: string): Record<string, number> {
  const all: Record<string, { values: Record<string, number> }> = {
    ...WORKBOOK_COMPARISON_FIXTURES.tax,
    ...(changwenFixtures as Record<string, { values: Record<string, number> }>),
  };
  const exp = all[fixtureKey]?.values;
  if (!exp) throw new Error(`No fixture for ${fixtureKey}`);
  return exp;
}

function normalizeFlags(raw?: string[]): string[] {
  if (!raw?.length) return [];
  const codes = new Set<string>();
  for (const f of raw) {
    const code = flagCodeInText(f);
    if (code) codes.add(code);
    else if (WARNING_FLAG.test(f)) codes.add(f);
  }
  return [...codes];
}

export function isFieldFlagged(flags: string[]): boolean {
  return flags.length > 0;
}

function hasOcrCoverageIssue(coverage?: OcrCoverageDiagnostics): boolean {
  if (!coverage) return false;
  return coverage.flags.some((f) =>
    /comparison-missing|stmt2-missing|page-truncation|low-numeric-density|schedule-l-not|detail-incomplete/i.test(f),
  );
}

function diagnoseField(params: {
  field: string;
  expected: number;
  actual?: number;
  correct: boolean;
  source?: string;
  flags: string[];
  coverage?: OcrCoverageDiagnostics;
  opexCandidates?: OpexCandidate[];
}): Pick<FieldMissDiagnostic, "diagnosis" | "whyChosen" | "whyLowConfidence"> {
  const { field, actual, correct, source, flags, coverage, opexCandidates } = params;
  const flagText = flags.join(" ").toLowerCase();

  if (correct) return { diagnosis: "correct" };

  if (actual === undefined) {
    if (hasOcrCoverageIssue(coverage)) {
      return {
        diagnosis: "ocr_coverage",
        whyChosen: "Value missing — OCR likely did not capture required attachment pages",
        whyLowConfidence: flags.length ? `Flags: ${flags.join(", ")}` : "No value returned",
      };
    }
    return {
      diagnosis: "parsing_failure",
      whyChosen: "Parser found no value despite text being present",
      whyLowConfidence: flags.length ? `Flags: ${flags.join(", ")}` : undefined,
    };
  }

  if (/candidate_conflict/.test(flagText)) {
    return {
      diagnosis: "candidate_selection",
      whyChosen: source ? `Chosen source: ${source}` : undefined,
      whyLowConfidence: "Top candidates have close scores but different values",
    };
  }

  if (/source_disagreement|other reads|sources disagree/.test(flagText)) {
    return {
      diagnosis: "source_disagreement",
      whyChosen: source ? `Chosen source: ${source}` : undefined,
      whyLowConfidence: "Independent extraction families disagree",
    };
  }

  if (/formula_inconsistency|formula-disagreement/.test(flagText)) {
    return {
      diagnosis: "formula_inconsistency",
      whyChosen: source ? `Chosen source: ${source}` : undefined,
      whyLowConfidence: "Statement total does not close with exclusions + field value",
    };
  }

  if (hasOcrCoverageIssue(coverage) && field === "other_operating_expenses") {
    const expectedInCandidates = opexCandidates?.some(
      (c) => Math.abs(c.value - params.expected) <= moneyTolerance(params.expected),
    );
    if (!expectedInCandidates) {
      return {
        diagnosis: "ocr_coverage",
        whyChosen: source ? `Chosen source: ${source}` : undefined,
        whyLowConfidence: "Expected value not present in any candidate — OCR gap likely",
      };
    }
  }

  if (/ocr_incomplete|comparison_missing|stmt2_missing|page_truncation/.test(flagText)) {
    return {
      diagnosis: "ocr_coverage",
      whyChosen: source ? `Chosen source: ${source}` : undefined,
      whyLowConfidence: `OCR completeness flags: ${flags.join(", ")}`,
    };
  }

  if (/low_trust|verify manually|subtractive/.test(flagText)) {
    return {
      diagnosis: "low_trust_source",
      whyChosen: source ? `Chosen source: ${source}` : undefined,
      whyLowConfidence: flags.join(", "),
    };
  }

  if (field === "other_operating_expenses" && opexCandidates?.length) {
    const winner = opexCandidates.find((c) => c.value === actual);
    const closeCompetitors = opexCandidates.filter(
      (c) => c.valid !== false && c.value !== actual && winner && winner.totalScore - c.totalScore <= 8,
    );
    if (winner && closeCompetitors.length) {
      return {
        diagnosis: "candidate_selection",
        whyChosen: winner.source,
        whyLowConfidence: "Multiple valid candidates with similar scores",
      };
    }
  }

  return {
    diagnosis: "unknown",
    whyChosen: source,
    whyLowConfidence: flags.length ? flags.join(", ") : undefined,
  };
}

function calibrationBucket(
  correct: boolean,
  displayConfidence: number,
  flagged: boolean,
): FieldCalibrationBucket {
  const high = displayConfidence >= HIGH_CONFIDENCE_THRESHOLD;
  const low = displayConfidence < LOW_CONFIDENCE_THRESHOLD;
  if (correct) return low ? "correct_low" : "correct_high";
  if (high && !flagged) return "wrong_high_unflagged";
  if (high && flagged) return "wrong_high_flagged";
  if (low || flagged) return "wrong_low_flagged";
  return "wrong_low_unflagged";
}

function buildCurve(rows: FieldCalibrationRow[]): ConfidenceCalibrationCurveBin[] {
  const bins: Array<{ label: string; min: number; max: number }> = [
    { label: "0-39", min: 0, max: 39 },
    { label: "40-54", min: 40, max: 54 },
    { label: "55-64", min: 55, max: 64 },
    { label: "65-74", min: 65, max: 74 },
    { label: "75-84", min: 75, max: 84 },
    { label: "85-100", min: 85, max: 100 },
  ];

  return bins.map(({ label, min, max }) => {
    const inBin = rows.filter((r) => r.displayConfidence >= min && r.displayConfidence <= max);
    const correct = inBin.filter((r) => r.correct).length;
    const wrong = inBin.filter((r) => !r.correct).length;
    const total = inBin.length;
    return {
      bin: label,
      min,
      max,
      total,
      correct,
      wrong,
      accuracyPct: total ? (correct / total) * 100 : 0,
    };
  });
}

export type ParsedBenchmarkContext = TaxYearValues & {
  debug?: {
    opexCandidates?: OpexCandidate[];
    opexChosenSource?: string;
    coverage?: OcrCoverageDiagnostics;
    ocrPageCount?: number;
  };
  ocrCoverage?: OcrCoverageDiagnostics;
};

export function buildFieldMissDiagnostics(
  parsed: ParsedBenchmarkContext,
  score: PrimaryScore,
): FieldMissDiagnostic[] {
  const coverage = parsed.ocrCoverage ?? parsed.debug?.coverage;
  const opexCandidates = parsed.debug?.opexCandidates;

  return score.missDetails.map((miss: FieldMiss) => {
    const flags = normalizeFlags(parsed.fieldFlags?.[miss.field]);
    const displayConfidence =
      parsed.displayConfidence?.[miss.field] ?? parsed.confidence?.[miss.field] ?? 70;
    const diag = diagnoseField({
      field: miss.field,
      expected: miss.expected,
      actual: miss.actual,
      correct: false,
      source: parsed.fieldSources?.[miss.field],
      flags,
      coverage,
      opexCandidates,
    });

    const alternatives: FieldMissDiagnostic["alternatives"] = [];
    if (miss.field === "other_operating_expenses") {
      for (const c of opexCandidates ?? []) {
        if (c.value === miss.actual) continue;
        alternatives.push({ value: c.value, score: c.totalScore, source: c.source });
      }
      for (const opt of parsed.fieldCandidateOptions?.[miss.field] ?? []) {
        if (alternatives.some((a) => a.value === opt.value)) continue;
        alternatives.push({
          value: opt.value,
          score: opt.totalScore ?? opt.confidence,
          source: opt.source,
        });
      }
    }
    for (const alt of parsed.fieldAlternates?.[miss.field] ?? []) {
      if (alternatives.some((a) => a.value === alt.value)) continue;
      alternatives.push({
        value: alt.value,
        score: alt.confidence,
        source: alt.sourceLabel ?? alt.family,
      });
    }

    return {
      field: miss.field,
      expected: miss.expected,
      actual: miss.actual,
      confidence: displayConfidence,
      parserConfidence: parsed.confidence?.[miss.field],
      source: parsed.fieldSources?.[miss.field],
      flags,
      flagged: isFieldFlagged(flags),
      ...diag,
      alternatives: alternatives.length ? alternatives.slice(0, 5) : undefined,
      ocrFlags: coverage?.flags,
    };
  });
}

export function computeConfidenceCalibration(
  fixtureKey: string,
  parsed: ParsedBenchmarkContext,
): ConfidenceCalibration {
  const exp = getFixtureValues(fixtureKey);
  const rows: FieldCalibrationRow[] = [];

  for (const id of INPUT_IDS) {
    // Rank-path paste rows are scored as an amount multiset — per-slot fixture ids are not identity.
    if (OPEX_SLOT_SET.has(id)) continue;
    const expected = exp[id];
    if (expected === undefined) continue;
    let correct = false;
    let actual: number | undefined;

    if (expected === 0 && (parsed.values[id] === undefined || parsed.values[id] === 0)) {
      correct = true;
      actual = parsed.values[id] ?? 0;
    } else {
      const match = fieldMatches(id, expected, parsed.values, exp);
      correct = match.hit;
      actual = match.actual;
    }

    const flags = normalizeFlags(parsed.fieldFlags?.[id]);
    const displayConfidence =
      parsed.displayConfidence?.[id] ?? parsed.confidence?.[id] ?? 70;
    const flagged = isFieldFlagged(flags);

    rows.push({
      field: id,
      expected,
      actual,
      correct,
      displayConfidence,
      flags,
      flagged,
      bucket: calibrationBucket(correct, displayConfidence, flagged),
    });
  }

  const wrong = rows.filter((r) => !r.correct);
  const correctRows = rows.filter((r) => r.correct);
  const wrongFlagged = wrong.filter((r) => r.flagged).length;
  const wrongHigh = wrong.filter((r) => r.displayConfidence >= HIGH_CONFIDENCE_THRESHOLD);
  const wrongLow = wrong.filter((r) => r.displayConfidence < LOW_CONFIDENCE_THRESHOLD);
  const correctLow = correctRows.filter((r) => r.displayConfidence < LOW_CONFIDENCE_THRESHOLD);

  return {
    totalFields: rows.length,
    wrongFields: wrong.length,
    correctFields: correctRows.length,
    wrongFlagged,
    wrongUnflagged: wrong.length - wrongFlagged,
    failureDetectionRate: wrong.length ? wrongFlagged / wrong.length : 1,
    wrongHighConfidence: wrongHigh.length,
    wrongLowConfidence: wrongLow.length,
    correctLowConfidence: correctLow.length,
    wrongHighConfidenceRate: wrong.length ? wrongHigh.length / wrong.length : 0,
    wrongLowConfidenceRate: wrong.length ? wrongLow.length / wrong.length : 0,
    correctLowConfidenceRate: correctRows.length ? correctLow.length / correctRows.length : 0,
    dangerousFailures: wrong.filter((r) => r.bucket === "wrong_high_unflagged").length,
    curve: buildCurve(rows),
    rows,
  };
}

export function formatCalibrationSummary(cal: ConfidenceCalibration): string {
  return [
    `Total fields: ${cal.totalFields}`,
    `Wrong fields: ${cal.wrongFields}`,
    `  Flagged: ${cal.wrongFlagged}/${cal.wrongFields}`,
    `  Unflagged: ${cal.wrongUnflagged}/${cal.wrongFields}`,
    `Failure detection: ${(cal.failureDetectionRate * 100).toFixed(1)}%`,
    `Dangerous (wrong + high confidence + unflagged): ${cal.dangerousFailures}`,
    `wrong_high_confidence_rate: ${(cal.wrongHighConfidenceRate * 100).toFixed(1)}%`,
    `wrong_low_confidence_rate: ${(cal.wrongLowConfidenceRate * 100).toFixed(1)}%`,
    `correct_low_confidence_rate: ${(cal.correctLowConfidenceRate * 100).toFixed(1)}%`,
  ].join("\n");
}

export function aggregateConfidenceCalibration(
  cals: ConfidenceCalibration[],
): ConfidenceCalibration {
  const rows = cals.flatMap((c) => c.rows);
  const wrong = rows.filter((r) => !r.correct);
  const correctRows = rows.filter((r) => r.correct);
  const wrongFlagged = wrong.filter((r) => r.flagged).length;
  const wrongHigh = wrong.filter((r) => r.displayConfidence >= HIGH_CONFIDENCE_THRESHOLD);
  const wrongLow = wrong.filter((r) => r.displayConfidence < LOW_CONFIDENCE_THRESHOLD);
  const correctLow = correctRows.filter((r) => r.displayConfidence < LOW_CONFIDENCE_THRESHOLD);

  return {
    totalFields: rows.length,
    wrongFields: wrong.length,
    correctFields: correctRows.length,
    wrongFlagged,
    wrongUnflagged: wrong.length - wrongFlagged,
    failureDetectionRate: wrong.length ? wrongFlagged / wrong.length : 1,
    wrongHighConfidence: wrongHigh.length,
    wrongLowConfidence: wrongLow.length,
    correctLowConfidence: correctLow.length,
    wrongHighConfidenceRate: wrong.length ? wrongHigh.length / wrong.length : 0,
    wrongLowConfidenceRate: wrong.length ? wrongLow.length / wrong.length : 0,
    correctLowConfidenceRate: correctRows.length ? correctLow.length / correctRows.length : 0,
    dangerousFailures: wrong.filter((r) => r.bucket === "wrong_high_unflagged").length,
    curve: buildCurve(rows),
    rows,
  };
}
