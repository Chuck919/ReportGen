import type { OcrCoverageDiagnostics } from "@/lib/tax-return/ocr-coverage-diagnostics";
import { scanComparisonOtherDeductionsTotal } from "@/lib/tax-return/comparison-opex";
import { scanStatement2Total } from "@/lib/tax-return/statement-extractors";

export type CoverageGapProbe = {
  needsRescan: boolean;
  reasons: string[];
  /** Fields to pass to OCR plan missing-field hints. */
  hintFields: string[];
};

/**
 * Detect when OCR text mentions Stmt 2 / comparison but parsers cannot read key totals.
 * Generic — no client-specific logic.
 */
export function probeOcrCoverageGaps(
  embeddedText: string,
  ocrText: string,
  targetYear?: number,
  coverage?: OcrCoverageDiagnostics,
): CoverageGapProbe {
  const allText = `${embeddedText}\n${ocrText}`;
  const reasons: string[] = [];
  const hintFields = new Set<string>();

  for (const flag of coverage?.flags ?? []) {
    if (/comparison-worksheet-missing|comparison-missing/i.test(flag)) {
      reasons.push(flag);
      hintFields.add("other_operating_expenses");
    }
    if (/stmt2-detail-incomplete|stmt2-missing|formula-inconsistency/i.test(flag)) {
      reasons.push(flag);
      hintFields.add("other_operating_expenses");
      hintFields.add("taxes_licenses");
      hintFields.add("advertising");
    }
    if (/low-numeric-density|page-truncation/i.test(flag)) {
      reasons.push(flag);
    }
  }

  const mentionsComparison = /two\s*year\s*comparison|t\w{0,3}\s*y\s*ear\s*\w{0,6}\s*omparison/i.test(
    allText,
  );
  if (mentionsComparison && targetYear !== undefined) {
    const compOpex = scanComparisonOtherDeductionsTotal(allText, targetYear);
    if (compOpex === undefined) {
      reasons.push("comparison-worksheet-unparseable");
      hintFields.add("other_operating_expenses");
    }
  }

  const mentionsStmt2 = /see\s+stmt\s*2|statement\s*2|stmt\s*2.*other\s+deduct|other\s+deduct.*statement/i.test(
    allText,
  );
  if (mentionsStmt2 && scanStatement2Total(allText) === undefined) {
    reasons.push("stmt2-total-unparseable");
    hintFields.add("other_operating_expenses");
    hintFields.add("professional_fees");
    hintFields.add("utilities");
  }

  return {
    needsRescan: reasons.length > 0,
    reasons: [...new Set(reasons)],
    hintFields: [...hintFields],
  };
}

/** Stmt 2 / comparison attachment line IDs — flag when document OCR is incomplete. */
export const STMT_ATTACHMENT_FIELD_IDS = new Set([
  "advertising",
  "taxes_licenses",
  "bank_credit_card",
  "professional_fees",
  "utilities",
  "other_operating_expenses",
  "rent",
  "officer_compensation",
  "salaries_wages",
]);

export function isStatementSourcedField(source?: string): boolean {
  return /statement|stmt\s*\d|comparison|other\s+deduct|attachment/i.test(source ?? "");
}
