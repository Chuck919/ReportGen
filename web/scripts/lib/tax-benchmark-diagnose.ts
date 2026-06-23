import type { OpexCandidate } from "../../src/lib/tax-return/opex-candidate-ranking";
import type { OcrCoverageDiagnostics } from "../../src/lib/tax-return/ocr-coverage-diagnostics";
import { moneyTolerance } from "./tax-benchmark-score";

export type RootCause =
  | "ocr_coverage"
  | "parsing_extraction"
  | "candidate_selection"
  | "workbook_mapping"
  | "post_processing";

export type DiagnosedMiss = {
  client: string;
  year: number;
  field: string;
  expected: number;
  got?: number;
  errorPct: number | null;
  severity: "critical" | "moderate" | "minor";
  rootCause: RootCause;
  chosenSource?: string;
  betterCandidateExisted?: boolean;
  betterCandidate?: { value: number; source: string; closure: number };
  coverage?: OcrCoverageDiagnostics;
  opexCandidates?: OpexCandidate[];
};

export function categorizeMiss(
  field: string,
  expected: number,
  got: number | undefined,
  ctx: {
    client: string;
    year: number;
    severity?: "critical" | "moderate" | "minor";
    errorPct?: number | null;
    fieldSource?: string;
    coverage?: OcrCoverageDiagnostics;
    opexCandidates?: OpexCandidate[];
  },
): DiagnosedMiss {
  const miss: DiagnosedMiss = {
    client: ctx.client,
    year: ctx.year,
    field,
    expected,
    got,
    errorPct: ctx.errorPct ?? null,
    severity: ctx.severity ?? (got === undefined ? "critical" : "moderate"),
    rootCause: "parsing_extraction",
    chosenSource: ctx.fieldSource,
    coverage: ctx.coverage,
    opexCandidates: field === "other_operating_expenses" ? ctx.opexCandidates : undefined,
  };

  const cov = ctx.coverage;
  const opexFields = new Set([
    "other_operating_expenses",
    "bank_credit_card",
    "professional_fees",
    "utilities",
  ]);

  if (opexFields.has(field) && cov) {
    if (!cov.stmt2Found && expected > 0) {
      miss.rootCause = "ocr_coverage";
      return miss;
    }
    if (field === "other_operating_expenses" && cov.exclusionLinesFound < 2 && expected > 10_000) {
      miss.rootCause = "ocr_coverage";
      return miss;
    }
  }

  if (field === "other_operating_expenses" && ctx.opexCandidates?.length) {
    const tol = moneyTolerance(expected);
    const exactMatch = ctx.opexCandidates.find((c) => Math.abs(c.value - expected) <= tol);
    const chosen =
      ctx.opexCandidates.find((c) => c.source === ctx.fieldSource) ?? ctx.opexCandidates[0];
    if (exactMatch && got !== undefined && Math.abs(got - expected) > tol) {
      miss.rootCause = "candidate_selection";
      miss.betterCandidateExisted = true;
      miss.betterCandidate = {
        value: exactMatch.value,
        source: exactMatch.source,
        closure: exactMatch.closureScore,
      };
      return miss;
    }
    if (
      exactMatch &&
      got === undefined &&
      exactMatch.valid &&
      exactMatch.totalScore > (chosen?.totalScore ?? 0) + 5
    ) {
      miss.rootCause = "candidate_selection";
      miss.betterCandidateExisted = true;
      miss.betterCandidate = {
        value: exactMatch.value,
        source: exactMatch.source,
        closure: exactMatch.closureScore,
      };
      return miss;
    }
    const nearValid = ctx.opexCandidates.find(
      (c) => c.valid && Math.abs(c.value - expected) <= tol && c.totalScore > (chosen?.totalScore ?? 0),
    );
    if (nearValid && got !== undefined && Math.abs(got - expected) > tol) {
      miss.rootCause = "candidate_selection";
      miss.betterCandidateExisted = true;
      miss.betterCandidate = {
        value: nearValid.value,
        source: nearValid.source,
        closure: nearValid.closureScore,
      };
      return miss;
    }
  }

  if (
    (field === "other_stock_equity" || field === "unclassified_equity") &&
    got !== undefined &&
    expected > 0 &&
    Math.abs(got - expected) / Math.max(Math.abs(expected), 1) <= 0.05
  ) {
    miss.rootCause = "workbook_mapping";
    return miss;
  }

  if (
    field === "unclassified_equity" &&
    expected === 0 &&
    got !== undefined &&
    got > 0 &&
    got < 50_000
  ) {
    miss.rootCause = "post_processing";
    return miss;
  }

  if (cov && !cov.comparisonWorksheetFound && /comparison/i.test(ctx.fieldSource ?? "")) {
    miss.rootCause = "ocr_coverage";
    return miss;
  }

  if (/coherence:/i.test(ctx.fieldSource ?? "")) {
    miss.rootCause = "post_processing";
  }

  return miss;
}

export function bucketSummary(misses: DiagnosedMiss[]): Record<RootCause, number> {
  const counts: Record<RootCause, number> = {
    ocr_coverage: 0,
    parsing_extraction: 0,
    candidate_selection: 0,
    workbook_mapping: 0,
    post_processing: 0,
  };
  for (const m of misses) counts[m.rootCause]++;
  return counts;
}
