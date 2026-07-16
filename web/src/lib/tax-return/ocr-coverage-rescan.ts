import type { OcrCoverageDiagnostics } from "@/lib/tax-return/ocr-coverage-diagnostics";
import { scanComparisonOtherDeductionsTotal } from "@/lib/tax-return/comparison-opex";
import { extractComparisonExpenseLines } from "@/lib/tax-return/comparison-field-rows";
import {
  extractDocumentWideDeductionLines,
  extractStatementExpenseLines,
  scanStatement2Total,
} from "@/lib/tax-return/statement-extractors";
import { extractOperatingExpenseLinesFromText } from "@/lib/tax/operating-expenses";

const ATTACHMENT_DETAIL_CATEGORIES = [
  { id: "insurance", labelRe: /insur/i, hint: "other_operating_expenses" },
  { id: "supplies", labelRe: /suppl|job\s+suppl/i, hint: "other_operating_expenses" },
  { id: "repairs", labelRe: /repair|maint/i, hint: "advertising" },
  { id: "bank_credit_card", labelRe: /bank|credit\s+card|merchant/i, hint: "bank_credit_card" },
  { id: "professional_fees", labelRe: /profession|legal|account/i, hint: "professional_fees" },
  { id: "utilities", labelRe: /utilit/i, hint: "utilities" },
] as const;

function amountPresentInText(amount: number, text: string): boolean {
  const n = Math.round(Math.abs(amount));
  const withCommas = n.toLocaleString("en-US");
  return text.includes(withCommas) || text.includes(String(n));
}

function moneyClose(a: number, b: number): boolean {
  return Math.round(a) === Math.round(b);
}

/** Comparison worksheet shows a large category amount but Stmt detail / OCR lacks it. */
function probeComparisonAttachmentGaps(
  allText: string,
  ocrText: string,
  targetYear: number,
): { reasons: string[]; hintFields: string[] } {
  const reasons: string[] = [];
  const hintFields = new Set<string>();
  const mentionsAttach = /see\s+stmt|statement\s*\d{1,2}\b.*other\s+deduct|other\s+deduct.*(?:see\s+stmt|attach\s+statement)/i.test(
    allText,
  );
  if (!mentionsAttach) return { reasons, hintFields: [] };

  const compLines = extractComparisonExpenseLines(allText, targetYear);
  const stmtPool = [
    ...extractStatementExpenseLines(allText),
    ...extractDocumentWideDeductionLines(allText),
    ...extractOperatingExpenseLinesFromText(allText),
  ];

  for (const cat of ATTACHMENT_DETAIL_CATEGORIES) {
    const compHits = compLines.filter((l) => cat.labelRe.test(l.label) && l.amount >= 5_000);
    if (!compHits.length) continue;
    const expected = Math.max(...compHits.map((l) => l.amount));
    const stmtMatch = stmtPool.some((l) => cat.labelRe.test(l.label) && moneyClose(l.amount, expected));
    if (stmtMatch) continue;
    hintFields.add(cat.hint);
    if (!amountPresentInText(expected, ocrText)) {
      reasons.push(`attachment-page-missing (${cat.id} ${expected})`);
    } else {
      reasons.push(`attachment-detail-missing (${cat.id} ${expected})`);
    }
  }

  const stmtSum = stmtPool.reduce((s, l) => s + Math.round(l.amount), 0);
  const compOther = scanComparisonOtherDeductionsTotal(allText, targetYear);
  const stmt2Total = scanStatement2Total(allText);
  const anchor = compOther ?? stmt2Total;
  // Trigger rescan when Form/Stmt TOTAL is known but detail pool extracted nothing.
  if (anchor !== undefined && anchor >= 1 && stmtSum === 0) {
    reasons.push(`attachment-detail-missing (stmt sum ${stmtSum} vs anchor ${anchor})`);
    hintFields.add("other_operating_expenses");
    hintFields.add("bank_credit_card");
    hintFields.add("professional_fees");
    hintFields.add("utilities");
  }

  return { reasons, hintFields: [...hintFields] };
}

/** Form references Stmt 1/2 detail but OCR never captured the Description/Amount or caps rows. */
function probeStmtDetailTableMissing(allText: string, ocrText: string): string[] {
  if (!/see\s+stmt\s*[12]|other\s+deduct.*see\s+stmt/i.test(allText)) return [];

  const anchorM =
    allText.match(/other\s+deductions[\s\S]{0,220}?(\d{1,3}(?:,\d{3})+)/i) ??
    allText.match(/see\s+stmt\s*2[\s\S]{0,160}?(\d{1,3}(?:,\d{3})+)/i);
  const anchor = anchorM ? Number(anchorM[1]!.replace(/,/g, "")) : undefined;
  if (anchor === undefined || anchor < 1) return [];

  const hasCapsDetail = /^(?:INSURANCE|SUPPLIES|BANK|PROFESSIONAL|UTILIT|REPAIR)/im.test(ocrText);
  const hasLargeStmtRows =
    /insurance\s+\d{1,3}(?:,\d{3}){1,}/i.test(ocrText) ||
    /supplies\s+\d{1,3}(?:,\d{3}){1,}/i.test(ocrText) ||
    /bank\s+charg\w*\s+\d{1,3}(?:,\d{3})+/i.test(ocrText);
  const hasTableShell = /description\s+amount/i.test(ocrText);

  if (hasCapsDetail || hasLargeStmtRows) return [];
  // Form points at Stmt detail but OCR has neither labeled rows nor a table shell.
  if (!hasTableShell) {
    return [`attachment-page-missing (stmt detail table, anchor ${anchor})`];
  }
  return [];
}

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

  const mentionsComparison =
    /two\s*year\s*comparison|tax\s+projection\s+worksheet|t\w{0,3}\s*y\s*ear\s*\w{0,6}\s*omparison/i.test(
      allText,
    );
  if (mentionsComparison && targetYear !== undefined) {
    const compOpex = scanComparisonOtherDeductionsTotal(allText, targetYear);
    if (compOpex === undefined) {
      reasons.push("comparison-worksheet-unparseable");
      hintFields.add("other_operating_expenses");
    }
  }

  const mentionsStmt2 =
    /see\s+stmt\s*[12]|statement\s*[12]|stmt\s*[12].*other\s+deduct|other\s+deduct.*statement/i.test(
      allText,
    );
  const stmt2Total = scanStatement2Total(allText);
  if (mentionsStmt2 && stmt2Total === undefined) {
    reasons.push("stmt2-total-unparseable");
    hintFields.add("other_operating_expenses");
    hintFields.add("professional_fees");
    hintFields.add("utilities");
  }

  /** Stmt-2 total present but itemized bank/prof/util not found — attachment OCR gap. */
  if (stmt2Total !== undefined && stmt2Total >= 5_000) {
    const targeted = extractDocumentWideDeductionLines(allText);
    const stmt = extractStatementExpenseLines(allText);
    const pools = [...targeted, ...stmt];
    const hasCategory = (id: string) =>
      pools.some((l) => {
        const t = l.label.toLowerCase();
        if (id === "bank_credit_card") return /bank|credit\s+card|merchant/.test(t);
        if (id === "professional_fees") return /profession|legal|account/.test(t);
        if (id === "utilities") return /utilit/.test(t);
        return false;
      });
    const gaps = (["bank_credit_card", "professional_fees", "utilities"] as const).filter(
      (id) => !hasCategory(id),
    );
    if (gaps.length >= 2) {
      reasons.push(`stmt2-detail-missing (${gaps.join(", ")})`);
      for (const id of gaps) hintFields.add(id);
    }
  }

  if (targetYear !== undefined) {
    const attachGaps = probeComparisonAttachmentGaps(allText, ocrText, targetYear);
    for (const r of attachGaps.reasons) {
      if (/attachment-page-missing/i.test(r)) reasons.push(r);
      else if (/attachment-detail-missing/i.test(r)) reasons.push(r);
    }
    for (const h of attachGaps.hintFields) hintFields.add(h);
    for (const r of probeStmtDetailTableMissing(allText, ocrText)) reasons.push(r);
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
