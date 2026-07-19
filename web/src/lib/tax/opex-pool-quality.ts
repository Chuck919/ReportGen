/**
 * Pool quality: amount-only gibberish filters + label assessment (never drop on label alone).
 */
import { isFormReferenceNumber, isReasonableMoneyAmount } from "@/lib/tax-return/money";
import { isEinOrPaymentInstructionBleed, repairOcrLabel } from "@/lib/tax-return/ocr-label-repair";

export type PoolExpenseLine = { label: string; amount: number; source?: string };

export type IllogicalAmountReason =
  | "below_min_amount"
  | "unreasonable_digits"
  | "collides_with_sales"
  | "collides_with_cogs"
  | "collides_with_gross_fixed_assets"
  | "collides_with_inventory"
  | "collides_with_payroll_sum"
  | "uncorroborated_mega_payroll"
  | "ein_or_payment_bleed"
  | "non_expense_anchor"
  | "mailing_or_form_footer_noise";

const ANCHOR_LABEL: Record<string, RegExp> = {
  sales: /\b(sales|gross\s+receipts|gross\s+income|total\s+income)\b/i,
  cogs: /\b(cogs|cost\s+of\s+goods|cost\s+of\s+sales)\b/i,
  gross_fixed_assets: /\b(fixed\s+assets|gross\s+fixed|property\s+plant)\b/i,
  inventory: /\b(inventory|inventories)\b/i,
};

/** Amount / anchor collision checks only — never rejects on label text alone for pool keep/drop. */
export function diagnoseIllogicalAmount(
  line: PoolExpenseLine,
  resolvedValues?: Record<string, number | undefined>,
): IllogicalAmountReason | undefined {
  const amount = Math.round(line.amount);
  const label = repairOcrLabel(line.label);
  const src = line.source ?? "";
  const opexComparisonRow = /\((officer_compensation|salaries_wages|advertising|rent|taxes_licenses|bank_credit_card|professional_fees|utilities|repairs|employee_benefits|insurance|supplies|gasoline|travel)\s+row\)/i.test(
    src,
  );
  if (amount < 1 || isFormReferenceNumber(amount) || (amount >= 1990 && amount <= 2035)) {
    return "below_min_amount";
  }
  if (!isReasonableMoneyAmount(amount)) return "unreasonable_digits";
  if (isEinOrPaymentInstructionBleed(line.label, amount)) return "ein_or_payment_bleed";
  if (isMailingOrFormFooterNoise(label)) return "mailing_or_form_footer_noise";
  // Comparison opex field-rows are trusted even when OCR caption is anchor-like ("employment credits").
  if (!opexComparisonRow && isNonExpenseAnchorLabel(line.label)) return "non_expense_anchor";
  if (resolvedValues) {
    const sales = resolvedValues.sales;
    // Accounting identity: an SG&A line cannot exceed known gross receipts.
    if (typeof sales === "number" && sales >= 1 && amount > Math.round(sales)) {
      return "collides_with_sales";
    }
    for (const id of ["sales", "cogs", "gross_fixed_assets", "inventory"] as const) {
      const v = resolvedValues[id];
      const anchorRe = ANCHOR_LABEL[id];
      if (
        v !== undefined &&
        anchorRe.test(label) &&
        Math.round(v) === amount
      ) {
        return `collides_with_${id}` as IllogicalAmountReason;
      }
    }
    const off = resolvedValues.officer_compensation;
    const sal = resolvedValues.salaries_wages;
    if (typeof off === "number" && typeof sal === "number" && off >= 1 && sal >= 1) {
      const sum = Math.round(off + sal);
      if (amount === sum) return "collides_with_payroll_sum";
    }
    // Non-Form payroll captions that still carry multi-column OCR (year cols + bracket total)
    // are worksheet rollups — not a single-year SG&A line.
    if (
      (/salar|\bwage/i.test(label) || /salaries_wages\s+row/i.test(src)) &&
      !/form\s*1120/i.test(src) &&
      isMultiColumnMoneyRollup(line.label, amount)
    ) {
      return "uncorroborated_mega_payroll";
    }
  }
  return undefined;
}

/** True when the caption retains multiple money tokens and `amount` is a sum/max rollup column. */
function isMultiColumnMoneyRollup(label: string, amount: number): boolean {
  // Comparison / worksheet rollups: bracketed columns, OCR `~~` change marks, or `[~ 565,880]`.
  if (/~~|\[\s*[~\d,]{3,}/.test(label)) return true;
  const nums = [...(label.match(/\d{1,3}(?:,\d{3})+/g) ?? [])].map((s) =>
    parseInt(s.replace(/,/g, ""), 10),
  );
  if (nums.length < 2) return false;
  const amt = Math.round(amount);
  for (let i = 0; i < nums.length; i++) {
    for (let j = i + 1; j < nums.length; j++) {
      if (Math.abs(nums[i]! + nums[j]! - amt) <= 1) return true;
    }
  }
  const sorted = [...nums].sort((a, b) => b - a);
  // Largest token equals the booked amount and at least one other year-column token exists.
  return sorted[0] === amt && sorted.length >= 2 && sorted[1]! >= 1;
}

export function filterIllogicalExpenseAmounts(
  lines: PoolExpenseLine[],
  context?: { values?: Record<string, number | undefined> },
): PoolExpenseLine[] {
  return lines.filter(
    (line) => diagnoseIllogicalAmount(line, context?.values) === undefined,
  );
}

export type LabelQualityAssessment = {
  originalLabel: string;
  repairedLabel: string;
  legible: boolean;
  /** Would old plausibility filter drop this line? Informational only. */
  weakByLegacyLabelGate: boolean;
  notes: string[];
};

const EXPENSE_WORD =
  /\b(fee|fees|rents?|utilit\w*|insur\w*|suppl\w*|office|bank|credit|merchant|profession\w*|legal|account\w*|repairs?|maint\w*|tax|licen\w*|benefit\w*|gasoline|payroll|salar\w*|wages?|officer|compens\w*|advert\w*|travel|telephone|dues|misc\w*|job|vehicle|fuel|amortization|janitorial|contract|labor|tolls|meals|education|software|equipment|recruit|auto|pension|profit-?shar\w*|charit\w*)\b/i;

/** P&L / B/S totals that sometimes bleed into comparison_raw — not SG&A detail lines. */
const NON_EXPENSE_ANCHOR_LABEL =
  /\b(gross receipts|gross profit|total income|total\s+(?:\w+\s+){0,2}deductions|ordinary business income|ordinary income|taxable income|net income|total assets|total liabilities|shareholders|paid in capital|distributions|schedule m|federal statements|federal asset|bonus depreciation|section 199a|employment credits|managing member|president|aggregate business activity|unadjusted basis|year beginning|tax[- ]exempt income|non[- ]taxable\s+ppp|ppp\s+income|tax deposited|estimated\s+tax|refundable\s+credit|total\s+business\s+income)\b/i;

/** Balance-sheet liability / asset captions (e.g. "Liquor tax payable") — not deductible operating expenses. */
const BALANCE_SHEET_POSITION_LABEL = /\b(payables?|receivables?|accrued\s+liabilit\w*)\b/i;

export const EXPENSE_DETAIL_SOURCES = new Set([
  "attachment_tables",
  "caps_label_amount",
  "statement_expense_lines",
  "other_deductions_stmt",
  "form_direct",
  "comparison_rules",
  "comparison_deduction_schedule",
]);

export function isBalanceSheetPositionLabel(label: string): boolean {
  return BALANCE_SHEET_POSITION_LABEL.test(repairOcrLabel(label));
}

/** Form 1120 payroll rows often include anchor-like phrases that are still deductible detail. */
function isPayrollFormDetailLabel(label: string): boolean {
  const t = repairOcrLabel(label);
  if (/\bofficer|compens/i.test(t) && /\bsee\s+instructions\b/i.test(t)) return true;
  if (/\bsalaries\s+and\s+wages\s+less\s+employment\s+credits\b/i.test(t)) return true;
  return false;
}

export function isNonExpenseAnchorLabel(label: string): boolean {
  const t = repairOcrLabel(label);
  if (isPayrollFormDetailLabel(t)) return false;
  if (NON_EXPENSE_ANCHOR_LABEL.test(t)) return true;
  if (isBalanceSheetPositionLabel(t)) return true;
  if (isMailingOrFormFooterNoise(t)) return true;
  if (/\b(inc|llc|corp)\b\.?\s*$/i.test(t) && t.split(/\s+/).length >= 3) return true;
  return false;
}

/** PO boxes, entity headers, and Form 1120 footer OCR — never rank as SG&A. */
export function isMailingOrFormFooterNoise(label: string): boolean {
  const t = repairOcrLabel(label);
  if (/\b(?:p\.?\s*o\.?\s*box|post\s+office\s+box)\b/i.test(t)) return true;
  if (/\bfor\s+office\s+use\s+only\b/i.test(t)) return true;
  if (/\buse\s+only\b/i.test(t) && /\b(?:firm|address|suite|phone)\b/i.test(t)) return true;
  if (/\bfirm'?s?\s+address\b/i.test(t)) return true;
  if (/\bpaperwork\s+reduction\s+act\b/i.test(t)) return true;
  if (/\bform\s+1120\b/i.test(t) && /\b(?:created|omb\s+no)\b/i.test(t)) return true;
  if (/\bform\s+1120[-\s]?[sb]?\s*\(\d{4}\)/i.test(t)) return true;
  if (/^\s*s\s*:?\s*corporation\s*$/i.test(t)) return true;
  if (/\b(?:see\s+)?separate\s+instructions\b/i.test(t) && /\bform\s+1120/i.test(t)) return true;
  return false;
}

/** State / federal return cover-sheet titles OCR'd as label+amount rows (e.g. K-120S headers). */
export function isTaxReturnTitleNoise(label: string): boolean {
  const t = repairOcrLabel(label);
  if (/\b(income\s+tax\s+return|corporate\s+income\s+tax|business\s+tax\s+return)\b/i.test(t)) return true;
  if (/\bform\s+1120[-\s]?[sb]?\b/i.test(t) && /\b\d{4}\b/.test(t) && t.length > 25) return true;
  if (/\bk[-\s]?\d{2,4}[a-z]?\b/i.test(t) && /\b(return|corporation|income\s+tax)\b/i.test(t)) return true;
  if (/\bs\s+corporation\s+income\s+tax\s+return\b/i.test(t)) return true;
  return false;
}

/** Stmt / form cross-reference fragments without a real expense caption. */
export function isStatementCrossRefNoise(label: string): boolean {
  const t = repairOcrLabel(label);
  // Form roll-up headers ("TOTAL TO FORM 1120-S … LINE 12") — not an SG&A detail line.
  if (/\btotal\s+to\s+form\b/i.test(t)) return true;
  if (EXPENSE_WORD.test(t)) return false;
  // Truncated OCR-caps "Other deductions..." without a real expense caption.
  if (/^other\s+deductions?\b/i.test(t) && t.length <= 40 && !EXPENSE_WORD.test(t.replace(/other\s+deductions?/i, ""))) {
    return true;
  }
  if (/\b(attach|see\s+stmt|see\s+statement|as\s+shown|refer\s+to)\b/i.test(t) && t.length <= 60) {
    return true;
  }
  if (/^statement\s*\d{1,2}\b/i.test(t) && t.length <= 30) return true;
  return false;
}

/**
 * Structural rank-pool rejection — no sales-ratio cutoffs; label/source shape only.
 * Never drops categorized Stmt/Form/comparison field-row lines.
 */
export function isRankPoolStructuralNoise(line: PoolExpenseLine): boolean {
  const label = repairOcrLabel(line.label);
  const src = line.source ?? "";
  if (/\(([a-z_]+)\s+row\)/i.test(src)) {
    const rowId = src.match(/\(([a-z_]+)\s+row\)/i)?.[1];
    // Known opex comparison field-rows keep their amount even when the OCR caption includes
    // anchor-like phrases (e.g. "salaries … employment credits").
    const opexComparisonRow =
      !!rowId &&
      rowId !== "raw" &&
      /^(officer_compensation|salaries_wages|advertising|rent|taxes_licenses|bank_credit_card|professional_fees|utilities|repairs|employee_benefits|insurance|supplies|gasoline|travel)$/.test(
        rowId,
      );
    if (opexComparisonRow) {
      if (isBalanceSheetPositionLabel(label)) return true;
      return false;
    }
    if (isBalanceSheetPositionLabel(label) || isNonExpenseAnchorLabel(label)) return true;
    return false;
  }
  if (/form\s*1120[-\s]?[sb]?\s*line\s*\d/i.test(src) && EXPENSE_WORD.test(label)) return false;
  if (/statement\s*\d|stmt\s*\d|attachment|caps\s+label|ocr\s+caps/i.test(src) && EXPENSE_WORD.test(label)) {
    return false;
  }
  if (/paperwork\s+reduction|see\s+separate\s+instructions/i.test(label)) return true;
  if (/form\s*1120/i.test(src) && /paperwork|instructions|created|omb\s+no/i.test(label)) return true;
  // Stmt headers often embed "Form 1120-S … Line 20"; that is not form-page boilerplate.
  if (
    /form\s*1120/i.test(src) &&
    !/statement\s*\d|stmt\s*\d|attachment/i.test(src) &&
    !EXPENSE_WORD.test(label) &&
    !/\([a-z_]+\s+row\)/i.test(src)
  ) {
    return true;
  }
  if (isTaxReturnTitleNoise(label)) return true;
  if (isStatementCrossRefNoise(label)) return true;
  if (isMailingOrFormFooterNoise(label)) return true;
  if (isNonExpenseAnchorLabel(label)) return true;
  if (/^\d{4}$/.test(label.trim())) return true;
  if (/comparison_raw|comparison_deduction_schedule/i.test(src)) {
    return !EXPENSE_WORD.test(label);
  }
  if (/two.year\s+comparison|comparison\s*\(/i.test(src) && !EXPENSE_WORD.test(label)) {
    if (!/\b(officer|compens|salar|wage|payroll|rent|tax|licen|insur|benefit)\b/i.test(label)) return true;
  }
  return false;
}

export function selectExpenseDetailLines(
  lines: PoolExpenseLine[],
  bySource?: Record<string, PoolExpenseLine[]>,
): PoolExpenseLine[] {
  if (!bySource) return lines.filter((l) => !isNonExpenseAnchorLabel(l.label));
  const out: PoolExpenseLine[] = [];
  for (const [tag, tagLines] of Object.entries(bySource)) {
    if (!EXPENSE_DETAIL_SOURCES.has(tag)) continue;
    out.push(...tagLines);
  }
  return out.length ? out : lines.filter((l) => !isNonExpenseAnchorLabel(l.label));
}

/** Assess label readability — does not affect whether the amount is kept. */
export function assessExpenseLabelQuality(label: string): LabelQualityAssessment {
  const originalLabel = label.trim();
  let repairedLabel = repairOcrLabel(originalLabel)
    .replace(/\s*\|\s*\|?\s*$/g, "")
    .replace(/\s+a\s*\|$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  const notes: string[] = [];
  if (/calendar year|tax year beginning|for calendar year/i.test(repairedLabel)) {
    notes.push("form_boilerplate_text");
  }
  if (/^\d+$/.test(repairedLabel)) notes.push("digits_only");
  if (repairedLabel.length < 3) notes.push("too_short");
  if (repairedLabel.length > 60) notes.push("truncated_long");
  if (/^w\s+wages?\b/i.test(originalLabel)) {
    repairedLabel = repairedLabel.replace(/^w\s+wages?\b/i, "wages");
    notes.push("repaired_leading_w_wages");
  }
  if (/^[a-z]{1,2}\s+[a-z]/i.test(repairedLabel) && !EXPENSE_WORD.test(repairedLabel)) {
    notes.push("missing_leading_char_guess");
  }
  if (!/[a-z]{3,}/i.test(repairedLabel)) notes.push("no_word_chars");

  const legible =
    repairedLabel.length >= 3 &&
    /[a-z]{3,}/i.test(repairedLabel) &&
    !/^(form|schedule|total|description|amount)\b/i.test(repairedLabel) &&
    !notes.includes("form_boilerplate_text") &&
    !notes.includes("digits_only");

  const weakByLegacyLabelGate =
    legible && !EXPENSE_WORD.test(repairedLabel) && !notes.includes("form_boilerplate_text");

  if (weakByLegacyLabelGate) notes.push("no_expense_keyword_match");

  return {
    originalLabel,
    repairedLabel,
    legible,
    weakByLegacyLabelGate,
    notes,
  };
}

export function normalizeExtractedExpenseLabel(label: string): string {
  const q = assessExpenseLabelQuality(label);
  if (q.legible && q.repairedLabel.length >= 3) return q.repairedLabel;
  return q.repairedLabel || label.trim().slice(0, 50);
}
