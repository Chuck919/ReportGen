import type { ResolvedFields } from "./merge";
import {
  extractStatementDeductions,
  scanStatement2Total,
  sumStmt2BlockLineItems,
} from "./statement-extractors";
import { scanComparisonOtherDeductionsTotal } from "./comparison-opex";
import { knownStmt2AttachmentSum } from "./stmt2-total-inference";
import { extractScheduleLFields } from "./schedule-l";
import { exactClosureTolerance } from "./structural-tolerance";

export type OcrCoverageDiagnostics = {
  stmt2Found: boolean;
  stmt2Total?: number;
  exclusionLinesFound: number;
  comparisonWorksheetFound: boolean;
  scheduleLFound: boolean;
  opexClosureRatio?: number;
  ocrPageCount?: number;
  attachmentRescanPages?: number[];
  /** Stmt 2 detail sum vs comparison OTHER DEDUCTIONS — flags suspicious incompleteness. */
  stmt2DetailSum?: number;
  comparisonOtherDeductions?: number;
  flags: string[];
};

function countExclusionLines(allText: string, resolved: ResolvedFields): number {
  const ded = extractStatementDeductions(allText);
  const ids = [
    "bank_credit_card",
    "professional_fees",
    "utilities",
    "amortization",
  ] as const;
  let count = 0;
  for (const id of ids) {
    if (resolved.values[id] !== undefined || ded.values[id] !== undefined) count++;
  }
  return count;
}

function stmt2DetailIncompleteFlag(
  stmt2DetailSum: number,
  comparisonOtherDeductions: number,
): string | undefined {
  if (stmt2DetailSum <= 0 || comparisonOtherDeductions <= 0) return undefined;
  // Structural under-coverage: itemized detail cannot reach the comparison OD total.
  if (stmt2DetailSum >= comparisonOtherDeductions) return undefined;
  return "stmt2-detail-incomplete-vs-comparison";
}

/** Coverage signals for Stmt 2 / comparison / Schedule L — diagnose OCR vs parse vs selection. */
export function buildOcrCoverageDiagnostics(
  allText: string,
  resolved: ResolvedFields,
  options?: {
    targetYear?: number;
    opex?: number;
    ocrPageCount?: number;
    attachmentRescanPages?: number[];
  },
): OcrCoverageDiagnostics {
  const stmt2Total = scanStatement2Total(allText);
  const comparisonFound =
    options?.targetYear !== undefined
      ? scanComparisonOtherDeductionsTotal(allText, options.targetYear) !== undefined
      : /two\s*year\s*comparison|t\w{0,3}\s*y\s*ear\s*\w{0,6}\s*omparison/i.test(allText);

  const comparisonOtherDeductions =
    options?.targetYear !== undefined
      ? scanComparisonOtherDeductionsTotal(allText, options.targetYear)
      : undefined;

  const sl = extractScheduleLFields(allText);
  const scheduleLFound =
    sl.values.cash !== undefined ||
    sl.values.accounts_receivable !== undefined ||
    /schedule\s+l/i.test(allText);

  const exclusionLinesFound = countExclusionLines(allText, resolved);

  let opexClosureRatio: number | undefined;
  const opex = options?.opex;
  if (opex !== undefined && stmt2Total !== undefined && stmt2Total > 0) {
    const known = knownStmt2AttachmentSum(resolved, allText);
    const sum = known + opex;
    const diff = Math.abs(sum - stmt2Total);
    // Exact TOTAL closure only (0 or 1) — no soft 5% ratio bands on diagnostics.
    opexClosureRatio = diff <= exactClosureTolerance(stmt2Total) ? 1 : 0;
  }

  const stmt2DetailSum =
    sumStmt2BlockLineItems(allText) ??
    knownStmt2AttachmentSum(resolved, allText) +
      (resolved.values.other_operating_expenses ?? 0);

  const flags: string[] = [];
  const incomplete = stmt2DetailIncompleteFlag(
    stmt2DetailSum,
    comparisonOtherDeductions ?? 0,
  );
  if (incomplete) flags.push(incomplete);
  if (!stmt2Total && /statement\s*2|stmt\s*2|other\s+deductions/i.test(allText)) {
    flags.push("stmt2-missing-lines");
  }
  if (!comparisonFound && /two\s*year|comparison\s+worksheet/i.test(allText)) {
    flags.push("comparison-missing-in-ocr");
  }
  if (comparisonFound && comparisonOtherDeductions === undefined && options?.targetYear !== undefined) {
    flags.push("comparison-worksheet-missing-other-deductions-row");
  }
  if (!scheduleLFound && /form\s+112/i.test(allText)) {
    flags.push("schedule-l-not-detected");
  }
  if (opex !== undefined && stmt2Total !== undefined && opexClosureRatio === 0) {
    flags.push("formula-inconsistency-opex-closure");
  }
  if (options?.ocrPageCount !== undefined && options.ocrPageCount > 0 && options.ocrPageCount < 4) {
    flags.push("page-truncation-suspected");
  }

  return {
    stmt2Found: stmt2Total !== undefined,
    stmt2Total,
    exclusionLinesFound,
    comparisonWorksheetFound: comparisonFound,
    scheduleLFound,
    opexClosureRatio,
    ocrPageCount: options?.ocrPageCount,
    attachmentRescanPages: options?.attachmentRescanPages,
    stmt2DetailSum: stmt2DetailSum > 0 ? Math.round(stmt2DetailSum) : undefined,
    comparisonOtherDeductions,
    flags,
  };
}
