import { extractComparisonExpenseLines, extractAllComparisonLabelValueLines, extractComparisonDeductionScheduleLines } from "@/lib/tax-return/comparison-field-rows";
import {
  extractDocumentWideDeductionLines,
  extractStatementExpenseLines,
} from "@/lib/tax-return/statement-extractors";
import { isForm1120Line, isFormReferenceNumber, isReasonableMoneyAmount, lineTailAmount, parseMoney, scheduleLineAmount, statementLineAmount } from "@/lib/tax-return/money";
import { repairOcrLabel } from "@/lib/tax-return/ocr-label-repair";
import { detectTaxForm } from "@/lib/tax-return/detect-tax-form";
import {
  isPlausibleOtherOperatingExpense,
} from "@/lib/tax-return/opex-plausibility";
import { TAX_WORKBOOK_ROWS, type TaxYearValues } from "@/lib/tax-workbook";
import { resolveExpectedTop8Amounts, type FixtureWithTop8 } from "@/lib/tax/fixture-top8";
import {
  diagnoseIllogicalAmount,
  filterIllogicalExpenseAmounts,
  isBalanceSheetPositionLabel,
  isMailingOrFormFooterNoise,
  isNonExpenseAnchorLabel,
  isRankPoolStructuralNoise,
  isStatementCrossRefNoise,
  isTaxReturnTitleNoise,
  normalizeExtractedExpenseLabel,
} from "@/lib/tax/opex-pool-quality";

export const OPERATING_EXPENSE_SLOT_IDS = [
  "officer_compensation",
  "salaries_wages",
  "advertising",
  "rent",
  "taxes_licenses",
  "bank_credit_card",
  "professional_fees",
  "utilities",
] as const;

export type OperatingExpenseSlotId = (typeof OPERATING_EXPENSE_SLOT_IDS)[number];

export type OperatingExpenseLine = {
  label: string;
  amount: number;
  source?: string;
};

/**
 * Soft $100 floor removed (charter). Rank/paste eligibility uses
 * {@link isExpenseRankCrumb} + {@link isKeepableResidualAmount}.
 */

/** Structurally valid dollar for stmt residual / detail extraction — no arbitrary $100 floor. */
function isKeepableResidualAmount(amount: number): boolean {
  const abs = Math.round(Math.abs(amount));
  if (abs < 1) return false;
  if (!isReasonableMoneyAmount(abs)) return false;
  if (isFormReferenceNumber(abs)) return false;
  if (abs >= 1990 && abs <= 2035) return false;
  return true;
}

/** Rank-pool OCR crumbs: form refs, tax years, line-number identity — not a sales/% / size band. */
function isExpenseRankCrumb(
  amount: number,
  meta?: { taxYear?: number; source?: string; label?: string },
): boolean {
  const abs = Math.round(Math.abs(amount));
  if (abs < 1) return true;
  if (isFormReferenceNumber(abs)) return true;
  const y = meta?.taxYear;
  if (y !== undefined && (abs === y || abs === y % 100)) return true;
  if (abs >= 1990 && abs <= 2035) return true;
  const src = meta?.source ?? "";
  const lab = meta?.label ?? "";
  const lineM = src.match(/\bline\s*(\d{1,3})\b/i) ?? lab.match(/^\s*(\d{1,3})\b/);
  if (lineM && abs === Number(lineM[1])) return true;
  if (/see\s+instructions|reserved\s+for\s+future|paperwork\s+reduction/i.test(`${src} ${lab}`)) {
    return abs <= 999;
  }
  return false;
}

/** Eligible to occupy a top-8 paste seat — keepable dollars, not OCR crumbs. */
function isTop8EligibleAmount(
  amount: number,
  meta?: { taxYear?: number; source?: string; label?: string },
): boolean {
  return isKeepableResidualAmount(amount) && !isExpenseRankCrumb(amount, meta);
}

/** Exact dollar match for internal opex placement checks. */
function moneyTolerance(_expected: number): number {
  return 0;
}

function withinMoneyTolerance(actual: number, expected: number): boolean {
  return Math.round(actual) === Math.round(expected);
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Canonical category for cross-year matching — collapses OCR variants of the same line. */
const EXPENSE_CATEGORY_RULES: Array<{ key: string; display: string; re: RegExp }> = [
  { key: "officer_compensation", display: "Officer compensation", re: /compensation of officers?|\bofficers?'?\s+compens/i },
  {
    key: "salaries_wages",
    display: "Salaries and wages",
    // "payroll" alone matches apportionment worksheet titles — require wage/salary context.
    re: /\bsalar|\bwage|(?:^|\b)payroll(?!\s*tax)(?!\s+and\s+sales)/i,
  },
  { key: "advertising", display: "Advertising", re: /advert|marketing|promotion|aovensng|adetsing|advets/i },
  { key: "repairs", display: "Repairs and maintenance", re: /repair|maint/i },
  { key: "rent", display: "Rent", re: /\brents?\b|\brens\b/i },
  { key: "taxes_licenses", display: "Taxes and Licenses", re: /tax(?:es)?\s*(?:and|&)?\s*licen|licen(?:se|ces)?\s*(?:and|&)?\s*tax|taxesandlicen/i },
  { key: "insurance", display: "Insurance", re: /insur/i },
  { key: "bank_credit_card", display: "Bank and credit card", re: /bank|credit\s*card|merchant|card\s*charg/i },
  { key: "professional_fees", display: "Professional fees", re: /profession|legal|account(?:ing|ant)|attorney|consult/i },
  { key: "utilities", display: "Utilities", re: /utilit|electric|\bgas\b|water\b|telephone|\bphone\s*(?:expense|bill|service|charg)|internet/i },
  { key: "supplies", display: "Supplies", re: /job\s+suppl|suppl|misc\s+office|office\s+expense/i },
  { key: "employee_benefits", display: "Employee benefit programs", re: /employee\s+benefit|benefit\s+program/i },
  { key: "gasoline", display: "Gasoline", re: /gasoline|\bfuel\b/i },
  { key: "travel", display: "Travel", re: /travel|mileage|auto\b|vehicle/i },
];

export function expenseCategoryKey(label: string): string | undefined {
  const t = normalizeWhitespace(label);
  // Apportionment / factor worksheets mention payroll but are not SG&A lines.
  if (/\bapportionment\b|\bpayroll\s+and\s+sales\b|\bfactor\s+only\b/i.test(t)) return undefined;
  if (/\bnet\s+rental|\brental\s+real\s+estate/i.test(t)) {
    const hits = EXPENSE_CATEGORY_RULES.filter((r) => r.key !== "rent" && r.re.test(t)).map((r) => r.key);
    if (!hits.length) return undefined;
    if (hits.includes("officer_compensation") && hits.includes("salaries_wages")) return undefined;
    return hits[0];
  }
  const hits = EXPENSE_CATEGORY_RULES.filter((r) => r.re.test(t)).map((r) => r.key);
  if (!hits.length) return undefined;
  // Combined payroll lines ("officers and salaries") must not fill a single slot.
  if (hits.includes("officer_compensation") && hits.includes("salaries_wages")) return undefined;
  return hits[0];
}

/**
 * The bank/credit-card row is sometimes filled by a structural "closes the Statement total" residual
 * guess (`pickStmt2BankCreditCard`) rather than a directly labeled line — a lower-certainty computed
 * figure. When a genuinely itemized category line exists for the same row (e.g. an explicit
 * "Insurance" or "Bank charges" Statement line) and materially disagrees with that guess, prefer the
 * itemized line; the residual guess is folded into other operating expenses instead of being lost.
 */
function isHeuristicResidualSource(source: string | undefined): boolean {
  return /closes\s+stmt\s*\d*\s*total|bank\/credit card\s*[-—]\s*verify/i.test(source ?? "");
}

function heuristicResidualBlocksItemizedLine(
  slotId: OperatingExpenseSlotId,
  cur: unknown,
  curSource: string | undefined,
  lineAmt: number,
): cur is number {
  return (
    slotId === "bank_credit_card" &&
    typeof cur === "number" &&
    isKeepableResidualAmount(cur) &&
    isHeuristicResidualSource(curSource) &&
    !withinMoneyTolerance(cur, lineAmt)
  );
}

/** Tight tolerance for literal-duplicate detection — much stricter than money-match tolerance,
 * since two genuinely different SG&A categories can easily land within the loose $500/1% band
 * (e.g. rent $18,000 vs repairs $18,046) without being the same line item. */
function isExactDuplicateAmount(a: number, b: number): boolean {
  if (b === 0) return a === 0;
  return Math.round(a) === Math.round(b);
}

/** True when amount equals another slot (literal duplicate line) or the sum of two other slots
 * (double-count guard, e.g. an "other deductions" residual that is really bank + utilities). */
function isAggregateOfOtherSlots(
  amount: number,
  values: Record<string, number | undefined>,
  slotId: string,
): boolean {
  const others = OPERATING_EXPENSE_SLOT_IDS.filter((id) => id !== slotId)
    .map((id) => values[id])
    .filter((n): n is number => typeof n === "number" && isKeepableResidualAmount(n));
  for (let i = 0; i < others.length; i++) {
    if (isExactDuplicateAmount(others[i]!, amount)) return true;
    for (let j = i + 1; j < others.length; j++) {
      if (withinMoneyTolerance(others[i]! + others[j]!, amount)) return true;
    }
  }
  return false;
}

export function expenseLabelKey(label: string): string {
  const category = expenseCategoryKey(label);
  if (category) return category;
  const t = normalizeWhitespace(label)
    .toLowerCase()
    .replace(/[^a-z0-9\s&/.-]/g, "")
    .replace(/\b(expense|expenses|deduction|deductions|other|statement|stmt)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t;
}

function displayLabelForKey(key: string, fallbackLabel: string): string {
  const rule = EXPENSE_CATEGORY_RULES.find((r) => r.key === key);
  if (rule) return rule.display;
  const cleaned = normalizeWhitespace(fallbackLabel)
    .replace(/[|[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length >= 3 && cleaned.length <= 40 && !/statement/i.test(cleaned)) return cleaned;
  return slotDefaultLabel(key) !== key ? slotDefaultLabel(key) : cleaned || key;
}

function isPlausibleExpenseLabel(label: string): boolean {
  const t = normalizeWhitespace(label);
  if (t.length < 3 || t.length > 80) return false;
  if (!/[a-z]/i.test(t)) return false;
  if (/^total\b/i.test(t)) return false;
  if (/\b(schedule|sch\.?|form)\b/i.test(t) && /\b\d{3,4}\b/.test(t)) return false;
  if (
    /\b(total assets|gross profit|total deductions|ordinary business income|taxable income|taxable business income|gross taxable|distributions?|tax year|business activity code|enter amount from line|did the corporation|attach form|credit for federal|biofuel producer|portion of dividends|compensation of officers see instructions|net rental real estate|ordinary income|page line|prone no|credited to estimated|salaries and wages less employment|enterprise zone|electronically filed|fein number|payment type|omb no|indiana corporate|state form|check the box for the tax return)\b/i.test(
      t,
    )
  ) {
    return false;
  }
  if (
    /\b(form\s+\d|see instructions|mailit to|reserved for future|minimum tax from form|tax adjustment from form|declaration of e)\b/i.test(
      t,
    )
  ) {
    return false;
  }
  if (/\bvehicle\s*\/\s*\/|(?:volvo|mercedes)\s+vehicle\b/i.test(t)) return false;
  if (isBalanceSheetPositionLabel(t)) return false;
  if (isMailingOrFormFooterNoise(t)) return false;
  if (
    !/\b(fee|fees|rent|util|insur\w*|suppl\w*|office|bank|credit|merchant|profession|legal|account|advert|tax|licen|payroll|repair|maint|travel|telephone|dues|charit|misc|other deduct|benefit\w*|gasoline|fuel|job|vehicle)/i.test(
      t,
    )
  ) {
    return false;
  }
  return true;
}

/** Broader label gate for rank-by-amount pool only (includes payroll rows). */
function isPlausibleRankPoolLabel(label: string): boolean {
  const t = normalizeWhitespace(label);
  if (/\bofficer|compens/i.test(t) && /\bsee\s+instructions\b/i.test(t)) return true;
  if (/\bsalaries\s+and\s+wages\s+less\s+employment\s+credits\b/i.test(t)) return true;
  if (isPlausibleExpenseLabel(label)) return true;
  if (t.length < 3 || t.length > 80 || !/[a-z]/i.test(t)) return false;
  return /\b(salar|wage|officer|compens|benefit|gasoline|fuel)\b/i.test(t);
}

/**
 * Form page-1 payroll vs comparison year-column for the same field — when Form OCR
 * carries a multi-year rollup (≥2× the comparison year column), drop the Form line.
 * OCR defense: Form often bleeds year columns into one amount; comparison is year-aligned.
 * Multiplier is structural (rollup vs single year), not a sales-% / company-size floor.
 */
function isFormFieldRollupVsComparisonRow(
  line: OperatingExpenseLine,
  pool: OperatingExpenseLine[],
): boolean {
  const src = line.source ?? "";
  if (!/form\s*1120/i.test(src)) return false;
  const cat = expenseCategoryKey(line.label);
  if (cat !== "salaries_wages" && cat !== "officer_compensation") return false;
  const formAmt = Math.round(Math.abs(line.amount));
  const compRow = pool.find(
    (l) =>
      l !== line &&
      new RegExp(`\\(${cat}\\s+row\\)`, "i").test(l.source ?? "") &&
      isKeepableResidualAmount(l.amount),
  );
  if (!compRow) return false;
  const compAmt = Math.round(Math.abs(compRow.amount));
  // Year crumbs (Form 8879 / calendar headers) must not displace Form page-1 payroll.
  if (compAmt >= 2015 && compAmt <= 2035) return false;
  // Form is a multi-year rollup only when comparison is a plausible single-year column
  // (near digit length). A crumb comparison (e.g. repairs bleed $4212 vs Form $182k) must
  // not displace Form — digit-length gap ≥2 → keep Form.
  if (String(formAmt).length - String(compAmt).length >= 2) return false;
  return formAmt >= 2 * compAmt;
}

/** Company-name OCR bleed (Inc/LLC entity captions) — not a paste-row label. */
function isEntityNameExpenseNoise(label: string): boolean {
  const t = normalizeWhitespace(label);
  if (t.length < 8) return false;
  if (!/\b(inc|llc|l\.l\.c|corp|corporation)\b\.?\s*$/i.test(t)) return false;
  if (
    /\b(fee|rent|util|insur|repair|tax|bank|merchant|profession|suppl|benefit|gasoline|payroll|salar|wage|officer|compens|advert)\b/i.test(
      t,
    )
  ) {
    return false;
  }
  return t.split(/\s+/).length >= 3;
}

/** Payroll tax detail on Stmt/caps — rolls into other_opex, not integrator top-8 rows. */
function isPayrollTaxDetailNoise(line: OperatingExpenseLine): boolean {
  const t = normalizeWhitespace(line.label);
  if (!/payroll\s+tax/i.test(t)) return false;
  if (comparisonRowGroupKey(line.source)) return false;
  return true;
}

/** Duplicate state/local income-tax captions from caps OCR — not SG&A paste rows. */
function isLocalIncomeTaxCaptionNoise(line: OperatingExpenseLine): boolean {
  const t = normalizeWhitespace(line.label);
  if (!/tax/i.test(t)) return false;
  if (comparisonRowGroupKey(line.source)) return false;
  if (/payroll\s+tax/i.test(t)) return false;
  if (/tax(?:es)?\s*(?:and|&)?\s*licen/i.test(t)) return false;
  if (/\b(based on income|state and city\s+tax|city\s+tax\s+based|profits?\s+tax)\b/i.test(t)) {
    return true;
  }
  // Standalone "Total tax" / "Total tax due" captions are liability totals, not SG&A.
  if (/^total\s+tax\b/i.test(t)) return true;
  return false;
}

/** Other-income statement rows (discount income, cash over/short, misc income) — not SG&A. */
function isOtherIncomeStatementNoise(line: OperatingExpenseLine): boolean {
  const t = normalizeWhitespace(line.label);
  const src = line.source ?? "";
  if (/other\s+deduct/i.test(src)) return false;
  if (comparisonRowGroupKey(src)) return false;
  if (/discount\s+income|cash\s+over\s*\/?\s*short/i.test(t)) return true;
  if (/^other\s+income\b/i.test(t) && /statement\s*1\b|federal\s+statements|form\s+attachment/i.test(src)) {
    return true;
  }
  // Bare "miscellaneous" on federal-statements / attachment pages is usually the income block.
  if (/^miscellaneous\b/i.test(t) && /federal\s+statements|form\s+attachment|statement\s*1\b/i.test(src)) {
    return true;
  }
  return false;
}

/** Employee benefit caps lines without a comparison field-row — Stmt residual, not top-8. */
function isEmployeeBenefitDetailNoise(line: OperatingExpenseLine): boolean {
  const t = normalizeWhitespace(line.label);
  if (!/employee\s+benefit/i.test(t)) return false;
  if (comparisonRowGroupKey(line.source)) return false;
  return true;
}

/** Merchant fees on Form 1125-A / COGS other-costs — not SG&A. Other-deductions merchant stays. */
function isMerchantCogsNoise(line: OperatingExpenseLine): boolean {
  const t = normalizeWhitespace(line.label);
  if (!/merchant/i.test(t)) return false;
  if (comparisonRowGroupKey(line.source)) return false;
  const src = line.source ?? "";
  // Other-deductions / trade-or-business deduction attachments keep merchant as SG&A.
  if (/other\s+deduct|trade\s+or\s+business\s+deduct/i.test(src)) return false;
  const blob = `${t} ${src}`;
  if (/total\s+to\s+line\s*5|form\s*1125|other\s+costs?\b|cogs|cost\s+of\s+(?:goods|sales)/i.test(blob)) {
    return true;
  }
  // Mis-tagged Stmt-2 federal-table rows that are really Form 1125-A merchant fees.
  if (/merchant\s+fees?\b/i.test(t) && /federal\s+statements\s+table/i.test(src)) return true;
  return false;
}

/** Small office/supplies detail — residual other_opex, not integrator top-8. */
function isOfficeSuppliesResidualNoise(line: OperatingExpenseLine): boolean {
  const t = normalizeWhitespace(line.label);
  if (comparisonRowGroupKey(line.source)) return false;
  if (!/office\s+expense|misc\s+office|office\s+suppl/i.test(t)) return false;
  // Exclude from top-8 competition; stmt-total − stmt-in-top-8 still counts these in other_opex.
  return /caps|document|attachment|statement\s*\d|stmt\s*\d|form\s+attachment/i.test(
    line.source ?? "",
  );
}

/** Property / deposit tax captions that are not the Taxes-and-licenses SG&A row. */
function isNonSgaTaxCaptionNoise(line: OperatingExpenseLine): boolean {
  const t = normalizeWhitespace(line.label);
  if (comparisonRowGroupKey(line.source)) return false;
  if (/tax(?:es)?\s*(?:and|&)?\s*licen/i.test(t)) return false;
  if (/tax\s+deposited|deposited\s+with\s+form|property\s+tax|estimated\s+tax/i.test(t)) return true;
  return false;
}

/** COGS "Other costs" attachment lines (Form line 5) — not SG&A Other Deductions. */
function isCogsOtherCostsNoise(line: OperatingExpenseLine): boolean {
  const src = line.source ?? "";
  const t = normalizeWhitespace(line.label);
  if (/total\s+to\s+line\s*5\b/i.test(t)) return true;
  if (/other\s+costs?\b/i.test(t)) return true;
  if (/line\s*5\b/i.test(src) && /other\s+cost|cogs|cost\s+of\s+(?:goods|sales)/i.test(src)) return true;
  if (/form\s*1120[-\s]?[sb]?\s*(?:page\s*\d+[.,]?\s*)?line\s*5\b/i.test(src)) return true;
  return false;
}

/** Section 199A / W-2 wage schedule lines — not integrator SG&A top-8. */
function isSection199aWageNoise(line: OperatingExpenseLine): boolean {
  const t = normalizeWhitespace(line.label);
  if (/section\s+199a/i.test(t)) return true;
  if (/\bw-?2\s+wages?\b/i.test(t) && !comparisonRowGroupKey(line.source)) return true;
  return false;
}

/** Calendar-year tokens OCR'd as expense amounts on worksheet titles (e.g. amount=2024). */
function isCalendarYearWorksheetNoise(line: OperatingExpenseLine): boolean {
  const y = Math.round(line.amount);
  if (y < 2000 || y > 2099) return false;
  const t = normalizeWhitespace(line.label);
  if (/\b(apportionment|worksheet|payroll\s+and\s+sales|tax\s+year|detail\s+worksheet)\b/i.test(t)) {
    return true;
  }
  // Entity header + year, not an SG&A caption.
  if (/\b(inc|llc|corp|corporation)\b/i.test(t) && t.split(/\s+/).length >= 3) return true;
  return false;
}

/** Tax-credit / overpayment schedule fragments — not deductible SG&A. */
function isTaxCreditScheduleNoise(line: OperatingExpenseLine): boolean {
  const t = normalizeWhitespace(line.label);
  if (/bond\s+credits?|credit for tax withheld|overpayment\s+credited/i.test(t)) return true;
  if (/section\s+\d+\s+tax from form|credits? from form/i.test(t)) return true;
  if (/vehicle\s*\/\s*\/|vehicles?\s*\/\s*\//i.test(t)) return true;
  return false;
}

/** Stmt-2 detail lines that usually roll into other_operating_expenses — not integrator top-8 rows. */
function isStmt2ResidualDetail(line: OperatingExpenseLine): boolean {
  const src = line.source ?? "";
  if (!/statement\s*\d|stmt\s*\d|form\s+attachment|federal\s+statements\s+table|ocr\s+caps|caps\s+label/i.test(src)) {
    return false;
  }
  const t = normalizeWhitespace(line.label);
  // Keep canonical SG&A captions that often are real top-8 rows.
  if (
    /^(?:bank|credit\s*card|merchant|professional|legal|account|utilities|insurance|rent|repair|advert|officer|salar|wage)\b/i.test(
      t,
    )
  ) {
    return false;
  }
  return /payroll\s+tax|charitable\s+contr|settlement|staff\s+meetings?|temporary\s+labor|50\s*%\s*of\s+meals|telephone|tolls?|parking|software|dues\s*&?\s*subscriptions?|fuel\s+charg|continuing\s+edu/i.test(
    t,
  );
}

function expenseLineSourcePriority(source: string | undefined): number {
  const src = source ?? "";
  if (/comparison\s*\([^)]+row\)/i.test(src)) return 4;
  if (/form\s*1120/i.test(src)) return 3;
  if (/statement\s*\d|stmt\s*\d/i.test(src)) return 2;
  if (/two.year\s+comparison/i.test(src)) return 2;
  if (/attachment|caps\s+label|ocr\s+caps/i.test(src)) return 2;
  if (/document[\s._-]*scan/i.test(src)) return 2;
  if (/comparison/i.test(src)) return 0;
  return 0;
}

function rankPoolLineQuality(line: OperatingExpenseLine): number {
  let score = expenseLineSourcePriority(line.source) * 100;
  const cat = expenseCategoryKey(line.label);
  if (cat) score += 60;
  if (isNonExpenseAnchorLabel(line.label)) score -= 500;
  if (isTaxReturnTitleNoise(line.label)) score -= 500;
  if (isStatementCrossRefNoise(line.label)) score -= 400;
  if (isRankPoolStructuralNoise(line)) score -= 400;
  if (/comparison_raw|comparison_deduction_schedule/i.test(line.source ?? "")) score -= 500;
  if (/caps\s+label/i.test(line.source ?? "") && !cat) score -= 50;
  return score;
}

function preferRankPoolLine(next: OperatingExpenseLine, cur: OperatingExpenseLine): boolean {
  const nDoc = /document[\s._-]*scan/i.test(next.source ?? "");
  const cDoc = /document[\s._-]*scan/i.test(cur.source ?? "");
  const nRow = /\([a-z_]+\s+row\)/i.test(next.source ?? "");
  const cRow = /\([a-z_]+\s+row\)/i.test(cur.source ?? "");
  const nForm = /form\s*1120[-\s]?[sb]?\s*line\s*\d/i.test(next.source ?? "");
  // Comparison field-rows beat document-scan category guesses (e.g. rent 504k vs scan 204k).
  if (nRow && cDoc) return true;
  if (nDoc && cRow) return false;
  // Form page-1 lines may replace a comparison row for the same category.
  if (nForm && cRow && expenseCategoryKey(next.label)) return true;
  // Prefer the canonical "utilities" caption over narrower utility sub-lines.
  const nUtil = /^utilities\b/i.test(normalizeWhitespace(next.label));
  const cUtil = /^utilities\b/i.test(normalizeWhitespace(cur.label));
  if (nUtil !== cUtil && expenseCategoryKey(next.label) === "utilities") return nUtil;
  const nq = rankPoolLineQuality(next);
  const cq = rankPoolLineQuality(cur);
  if (nq !== cq) return nq > cq;
  return Math.round(next.amount) > Math.round(cur.amount);
}

/** When two lines share a category, prefer authoritative form/statement sources over comparison noise. */
function prefersExpenseLineForCategory(next: OperatingExpenseLine, cur: OperatingExpenseLine): boolean {
  const nq = rankPoolLineQuality(next);
  const cq = rankPoolLineQuality(cur);
  if (nq !== cq) return nq > cq;
  return Math.round(next.amount) > Math.round(cur.amount);
}

/**
 * Extraction pipeline (strict order — do not skip phases):
 *
 * 1. OCR — embedded text + balanced/thorough OCR + attachment-gap rescan when Stmt detail missing.
 * 2. Raw capture — union every label+amount candidate; structural gates only (has letters, ≥ $100).
 * 3. Completeness gate — every integrator amount present in raw pool (amount match, any label OK);
 *    production: Stmt detail sum vs comparison OTHER DEDUCTIONS + `buildOcrCoverageDiagnostics`.
 * 4. Label cleaning — `cleanOperatingExpenseLines` (plausibility, sales cap, entity noise) — OFF until phase 3 passes.
 * 5. Ranking / slot assignment — OFF until phases 3–4 pass (`useOpexRankByAmount`).
 */

/**
 * Ranking is blocked until every integrator (label, amount) pair is extractable from OCR.
 * Use `auditExpectedPairExtraction` + dump `--human` to verify the pool before re-enabling.
 */
export function useOpexRankByAmount(): boolean {
  return true;
}

/** Label plausibility filters for rank pool — reject OCR noise, keep real expense lines. */
export function useOpexLabelCleaning(): boolean {
  return true;
}

/** Filtered expense-line pool for rank-by-amount (plausibility + sales cap, labels for filtering only). */
function prepareOpexRankPool(col: TaxYearValues): OperatingExpenseLine[] {
  const raw = [...(col.operatingExpenseLines ?? [])];
  const taxSrc = col.fieldSources?.taxes_licenses ?? "";
  const taxSplit =
    /statement\s*\d*\s*taxes|payroll\/sales|payroll\/licenses|taxes\s+minus\s+taxes\s+paid/i.test(
      taxSrc,
    ) &&
    col.values.taxes_licenses !== undefined &&
    isKeepableResidualAmount(col.values.taxes_licenses)
      ? Math.round(Math.abs(col.values.taxes_licenses))
      : undefined;
  // Re-inject parser slot amounts that may lack a matching OCR expense line.
  for (const slotId of OPERATING_EXPENSE_SLOT_IDS) {
    const amount = col.values[slotId];
    if (amount === undefined || !isKeepableResidualAmount(amount)) continue;
    const src = col.fieldSources?.[slotId] ?? "";
    // Comparison field-rows, Form page-1 lines, OCR label matches, cross-year comparison
    // backfill, statement taxes split, and comparison taxes−taxes_paid (AZ payroll/sales).
    if (
      !/\([a-z_]+\s+row\)/i.test(src) &&
      !/form\s*1120/i.test(src) &&
      !/ocr\s+label\s+match/i.test(src) &&
      !/two[\s.-]?year\s+comparison/i.test(src) &&
      !/statement\s*\d*\s*taxes|payroll\/sales|payroll\/licenses|taxes\s+minus\s+taxes\s+paid/i.test(
        src,
      )
    ) {
      continue;
    }
    // When statement/comparison payroll/sales split is authoritative, skip Form line-12 roll-up reinject.
    if (
      slotId === "taxes_licenses" &&
      taxSplit !== undefined &&
      /form\s*1120/i.test(src) &&
      Math.round(Math.abs(amount)) !== taxSplit
    ) {
      continue;
    }
    const row = TAX_WORKBOOK_ROWS.find((r) => r.id === slotId);
    const reinjectLine: OperatingExpenseLine = {
      label: row?.label ?? slotId,
      amount: Math.round(Math.abs(amount)),
      source: src,
    };
    if (isFormFieldRollupVsComparisonRow(reinjectLine, raw)) continue;
    raw.push(reinjectLine);
  }
  // Drop competing Form/OCR taxes roll-ups when payroll+sales split is the field amount.
  const deduped =
    taxSplit === undefined
      ? raw
      : raw.filter((line) => {
          const cat = expenseCategoryKey(line.label);
          if (cat !== "taxes_licenses") return true;
          const amt = Math.round(Math.abs(line.amount));
          if (amt === taxSplit) return true;
          // Keep labeled payroll / sales-use crumbs; drop Form line-12 totals and other tax roll-ups.
          if (/payroll|sales\s+and\s+use/i.test(line.label)) return true;
          return false;
        });
  return filterRankExpensePool(deduped, col.values.sales, col.values, col.fieldSources);
}

/** Sources allowed in the rank pool — Stmt/Form/comparison rows; raw comparison grids excluded. */
const RANK_POOL_SOURCE_ALLOW =
  /form\s*1120|statement\s*\d|stmt\s*\d|attachment|other\s+deduct|federal\s+statements|caps\s+label|comparison_rules|comparison\s*deduction|two[\s.-]?year\s+comparison|comparison\s*\(|document[\s._-]*scan|ocr\s+caps|ocr\s+label\s+match|parser\s+field/i;

const COMPARISON_ROW_FIELD_IDS = new Set([
  "officer_compensation",
  "salaries_wages",
  "advertising",
  "rent",
  "taxes_licenses",
  "bank_credit_card",
  "professional_fees",
  "utilities",
  "repairs",
  "employee_benefits",
  "insurance",
  "supplies",
  "gasoline",
  "travel",
]);

function isUnsupportedComparisonRow(line: OperatingExpenseLine): boolean {
  const m = line.source?.match(/\(([a-z_]+)\s+row\)/i);
  if (!m?.[1]) return false;
  return !COMPARISON_ROW_FIELD_IDS.has(m[1]);
}

function isWeakComparisonGridLine(line: OperatingExpenseLine): boolean {
  const src = line.source ?? "";
  if (!/comparison|two.year/i.test(src)) return false;
  if (/\([a-z_]+_row\)|\([a-z_]+\s+row\)/i.test(src)) return false;
  if (expenseCategoryKey(line.label)) return false;
  if (isPlausibleRankPoolLabel(line.label)) return false;
  return true;
}

function isComparisonVarianceNoise(line: OperatingExpenseLine): boolean {
  const src = line.source ?? "";
  const opexComparisonRow =
    /\((officer_compensation|salaries_wages|advertising|rent|taxes_licenses|bank_credit_card|professional_fees|utilities|repairs|employee_benefits|insurance|supplies|gasoline|travel)\s+row\)/i.test(
      src,
    );
  if (!opexComparisonRow && isNonExpenseAnchorLabel(line.label)) return true;
  if (!/comparison|two.year/i.test(src)) return false;
  const t = normalizeWhitespace(line.label).toLowerCase();
  if (/\b(change|increase|decrease|variance|percent|%|difference|prior|column)\b/i.test(t)) return true;
  if (/\btotal\s+(deduct|expense|income)\b/i.test(t)) return true;
  if ((line.label.match(/[\d,]{4,}/g) ?? []).length > 1) return true;
  return false;
}

function isExcludedRankPoolSource(line: OperatingExpenseLine): boolean {
  const src = line.source ?? "";
  // Raw comparison / document-scan: keep when caption is a known category OR expense vocabulary
  // (not bare “readable” — that re-admits sales/balance-sheet OCR into top-8).
  if (/\(raw\s+row\)/i.test(src) || /comparison_raw/i.test(src)) {
    return !expenseCategoryKey(line.label) && !isPlausibleRankPoolLabel(line.label);
  }
  if (/comparison_deduction_schedule/i.test(src) || /document[\s._-]*scan/i.test(src)) {
    return !expenseCategoryKey(line.label) && !isPlausibleRankPoolLabel(line.label);
  }
  if (src && !RANK_POOL_SOURCE_ALLOW.test(src)) return true;
  return isComparisonVarianceNoise(line) || isWeakComparisonGridLine(line);
}

/**
 * Rank pool collision checks — balance-sheet anchors + payroll + authoritative taxes.
 * Do not treat rank-paste seat values as category anchors: after assignByRankOrder,
 * `values.taxes_licenses` is "whatever landed in paste index 4", not taxes. Re-finalizing
 * (progressive upload / session restore) would otherwise force the taxes pool line to
 * professional-fees dollars and drop real taxes from top-8.
 */
function isAuthoritativeTaxesFieldSource(source?: string): boolean {
  return /form\s*1120|two[\s.-]?year\s+comparison|statement\s*\d*\s*taxes|payroll\/sales|payroll\/licenses|taxes\s+minus\s+taxes\s+paid/i.test(
    source ?? "",
  );
}

function rankPoolAnchorValues(
  resolvedValues?: Record<string, number | undefined>,
  fieldSources?: Record<string, string>,
): Record<string, number | undefined> | undefined {
  if (!resolvedValues) return undefined;
  return {
    sales: resolvedValues.sales,
    cogs: resolvedValues.cogs,
    gross_fixed_assets: resolvedValues.gross_fixed_assets,
    inventory: resolvedValues.inventory,
    officer_compensation: resolvedValues.officer_compensation,
    salaries_wages: resolvedValues.salaries_wages,
    taxes_licenses: isAuthoritativeTaxesFieldSource(fieldSources?.taxes_licenses)
      ? resolvedValues.taxes_licenses
      : undefined,
  };
}

/**
 * Per-year rank pool: drop OCR noise, comparison variance columns, then one best line per expense group
 * (duplicate schedule renders deduped here — not in the cross-year sum step).
 */
export function filterRankExpensePool(
  lines: OperatingExpenseLine[],
  sales?: number,
  resolvedValues?: Record<string, number | undefined>,
  fieldSources?: Record<string, string>,
): OperatingExpenseLine[] {
  const anchors = rankPoolAnchorValues(resolvedValues, fieldSources);
  const passed: OperatingExpenseLine[] = [];
  for (const line of lines) {
    const amount = Math.round(Math.abs(line.amount));
    const crumbMeta = { source: line.source, label: line.label };
    // OCR crumbs stay for residual math only; keepable non-crumbs compete in top-8 by amount.
    if (!isKeepableResidualAmount(amount) || isExpenseRankCrumb(amount, crumbMeta)) {
      if (
        isKeepableResidualAmount(amount) &&
        isStmtDetailSource(line.source) &&
        !isMailingOrFormFooterNoise(line.label) &&
        !isTaxReturnTitleNoise(line.label)
      ) {
        passed.push({
          ...line,
          amount,
          source: `${line.source ?? "expense"} (residual crumb)`,
        });
      }
      continue;
    }
    if (diagnoseIllogicalAmount(line, sales, anchors)) continue;
    if (diagnoseRankPoolLineRejection(line, sales, anchors)) continue;
    if (isUnsupportedComparisonRow(line)) continue;
    if (isRankPoolStructuralNoise(line)) continue;
    if (isExcludedRankPoolSource(line)) continue;
    if (isEntityNameExpenseNoise(line.label)) continue;
    if (isPayrollTaxDetailNoise(line)) continue;
    if (isLocalIncomeTaxCaptionNoise(line)) continue;
    if (isOtherIncomeStatementNoise(line)) continue;
    // Employee benefits / office supplies may be top-8 winners — rank by amount, do not demote.
    if (isSection199aWageNoise(line)) continue;
    if (isNonSgaTaxCaptionNoise(line)) continue;
    if (isMerchantCogsNoise(line)) continue;
    if (isTaxCreditScheduleNoise(line)) continue;
    if (isCalendarYearWorksheetNoise(line)) continue;
    if (isCogsOtherCostsNoise(line)) continue;
    if (isFormFieldRollupVsComparisonRow(line, lines)) continue;
    // Stmt-2 "residual detail" (meals, dues, telephone, …) may still be a real top-8
    // winner at an unseen company — do not demote by caption; rank by amount only.
    passed.push(line);
  }

  const byGroup = new Map<string, OperatingExpenseLine>();
  for (const line of passed) {
    const key = crossYearExpenseGroupKey(line);
    const existing = byGroup.get(key);
    if (!existing) {
      byGroup.set(key, line);
      continue;
    }
    if (preferRankPoolLine(line, existing)) byGroup.set(key, line);
  }

  // When comparison field-row id exists for a category, merge cat: into row: keeping the better line.
  for (const key of [...byGroup.keys()]) {
    if (!key.startsWith("cat:")) continue;
    const rowKey = `row:${key.slice(4)}`;
    const rowLine = byGroup.get(rowKey);
    if (!rowLine) continue;
    const catLine = byGroup.get(key)!;
    const sameAmount = Math.round(catLine.amount) === Math.round(rowLine.amount);
    const catIsItemizedDetail =
      /statement\s*\d|stmt\s*\d|form\s+attachment|attachment\s+table|ocr\s+caps|caps\s+label/i.test(
        catLine.source ?? "",
      );
    const rowIsComparison = /\([a-z_]+\s+row\)/i.test(rowLine.source ?? "");
    const catLabelOk =
      !!expenseCategoryKey(catLine.label) &&
      isPlausibleRankPoolLabel(catLine.label) &&
      !isNonExpenseAnchorLabel(catLine.label);
    // Itemized stmt/attachment detail may replace a comparison-row echo of the same category
    // only when the detail itself is a real expense caption (not worksheet/year OCR junk).
    if (!sameAmount && catIsItemizedDetail && rowIsComparison && catLabelOk) {
      byGroup.set(rowKey, catLine);
    } else if (preferRankPoolLine(catLine, rowLine)) {
      byGroup.set(rowKey, catLine);
    }
    byGroup.delete(key);
  }

  // Drop document-scan repairs when a form/stmt repairs line exists (same category, better source).
  const authRepairs = [...byGroup.entries()].find(
    ([, l]) =>
      expenseCategoryKey(l.label) === "repairs" &&
      /form\s*1120|statement\s*\d|stmt\s*\d/i.test(l.source ?? ""),
  );
  if (authRepairs) {
    for (const [key, line] of [...byGroup.entries()]) {
      if (key === authRepairs[0]) continue;
      if (expenseCategoryKey(line.label) !== "repairs") continue;
      if (/document[\s._-]*scan/i.test(line.source ?? "")) byGroup.delete(key);
    }
  }

  // Stmt partial rent when comparison/form rent exists for the same year.
  const rowRent = byGroup.get("row:rent");
  const spotRent = byGroup.get("spot:form1120:16");
  const canonicalRent = rowRent ?? spotRent;
  if (canonicalRent) {
    for (const key of [...byGroup.keys()]) {
      if (key === "row:rent" || key === "spot:form1120:16") continue;
      if (key !== "cat:rent" && key !== "spot:stmt2:rent") continue;
      // Same-category partial stmt/cat rent when a comparison/form rent already exists.
      byGroup.delete(key);
    }
  }

  // Form page-1 officer/salaries win over Statement-N wage schedules (e.g. Stmt 7 "w wages"
  // duplicate that is not the Form line 7/8 total and crowds utilities out of top-8).
  for (const [formKey, cat] of [
    ["spot:form1120:7", "officer_compensation"],
    ["spot:form1120:8", "salaries_wages"],
    ["spot:form1120:12", "officer_compensation"],
    ["spot:form1120:13", "salaries_wages"],
  ] as const) {
    const formLine = byGroup.get(formKey);
    if (!formLine) continue;
    // 1120-S line 12 is taxes — only collapse when the form line is actually this category.
    if (expenseCategoryKey(formLine.label) !== cat) continue;
    for (const key of [...byGroup.keys()]) {
      if (key === formKey) continue;
      if (key.startsWith("spot:form1120:")) continue;
      const line = byGroup.get(key)!;
      const lineCat = expenseCategoryKey(line.label);
      if (lineCat !== cat && !key.endsWith(`:${cat}`)) continue;
      // Stmt/attachment wage schedules are form-line echoes — drop them.
      if (/statement\s*\d|stmt\s*\d|form\s+attachment/i.test(line.source ?? "")) {
        byGroup.delete(key);
        continue;
      }
      // Comparison/cat duplicate of the same form category — prefer source quality, not raw amount.
      if (key === `row:${cat}` || key === `cat:${cat}`) {
        if (preferRankPoolLine(formLine, line)) byGroup.delete(key);
        else byGroup.delete(formKey);
      }
    }
  }

  // Form page-1 taxes/rent win over weaker comparison/cat duplicates for the same category.
  for (const [formKey, cat] of [
    ["spot:form1120:11", "rent"],
    ["spot:form1120:12", "taxes_licenses"],
  ] as const) {
    const formLine = byGroup.get(formKey);
    if (!formLine) continue;
    // 1120 C-corp uses line 12 for officers — only collapse when the form line matches.
    if (expenseCategoryKey(formLine.label) !== cat) continue;
    for (const key of [...byGroup.keys()]) {
      if (key === formKey) continue;
      if (!key.startsWith("row:") && !key.startsWith("cat:")) continue;
      const line = byGroup.get(key)!;
      const lineCat = expenseCategoryKey(line.label);
      if (lineCat !== cat && key !== `row:${cat}` && key !== `cat:${cat}`) continue;
      byGroup.delete(key);
    }
  }
  // 1120 (C-corp) rents are line 16 — do not treat 1120-S advertising line 16 as rent.
  const form16 = byGroup.get("spot:form1120:16");
  if (form16 && expenseCategoryKey(form16.label) === "rent") {
    for (const key of [...byGroup.keys()]) {
      if (key === "spot:form1120:16") continue;
      if (key !== "row:rent" && key !== "cat:rent") continue;
      byGroup.delete(key);
    }
  }

  // Stmt/attachment itemized detail wins over same-category comparison/cat echoes.
  for (const cat of [
    "bank_credit_card",
    "professional_fees",
    "utilities",
    "insurance",
    "officer_compensation",
    "salaries_wages",
  ] as const) {
    const stmt = [...byGroup.entries()].find(
      ([key, l]) =>
        key.startsWith("spot:stmt") &&
        (key.endsWith(`:${cat}`) || expenseCategoryKey(l.label) === cat) &&
        // Require the label itself to be that category — avoid address/OCR bleed spots.
        expenseCategoryKey(l.label) === cat,
    );
    if (!stmt) continue;
    for (const key of [...byGroup.keys()]) {
      if (key === stmt[0]) continue;
      if (key !== `row:${cat}` && key !== `cat:${cat}`) continue;
      const other = byGroup.get(key)!;
      if (preferRankPoolLine(stmt[1], other)) byGroup.delete(key);
      else byGroup.delete(stmt[0]);
    }
  }

  // Prefer parser field amounts for taxes when comparison OCR multi-column rows
  // picked the wrong year (taxes seat inflated vs Form). Do not force utilities /
  // professional from workbook fields — those are often blank while Stmt detail is right.
  {
    const cat = "taxes_licenses" as const;
    const auth = anchors?.[cat];
    if (auth !== undefined && isKeepableResidualAmount(auth)) {
      const target = Math.round(Math.abs(auth));
      const matches = [...byGroup.entries()].filter(
        ([, l]) => expenseCategoryKey(l.label) === cat,
      );
      if (matches.length) {
        const exact = matches.find(([, l]) => Math.round(Math.abs(l.amount)) === target);
        for (const [key] of matches) {
          if (exact && key === exact[0]) continue;
          byGroup.delete(key);
        }
        if (exact) {
          byGroup.set(exact[0], { ...exact[1], amount: target });
        } else {
          const keepKey = matches[0]![0];
          byGroup.set(keepKey, {
            ...matches[0]![1],
            amount: target,
            source: matches[0]![1].source ?? `parser field (${cat})`,
          });
        }
      }
    }
  }

  return [...byGroup.values()].filter((line) => !isRankPoolStructuralNoise(line));
}

function inferStmtTotalFromPool(lines: OperatingExpenseLine[]): number | undefined {
  for (const line of lines) {
    const t = normalizeWhitespace(line.label);
    if (!/other\s+deduct/i.test(t)) continue;
    if (!/comparison|statement|stmt|total|two.year/i.test(line.source ?? "")) continue;
    if (isComparisonVarianceNoise(line)) continue;
    if (isTop8EligibleAmount(line.amount, { source: line.source, label: line.label })) return Math.round(line.amount);
  }
  return undefined;
}

/** Dedupe expense lines by semantic label key + rounded amount (first source wins). */
export function dedupeOperatingExpenseLines(lines: OperatingExpenseLine[]): OperatingExpenseLine[] {
  const seen = new Set<string>();
  const deduped: OperatingExpenseLine[] = [];
  for (const line of lines) {
    const key = `${expenseLabelKey(line.label)}:${Math.round(line.amount)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(line);
  }
  return deduped.sort((a, b) => b.amount - a.amount);
}

/**
 * Minimal label gate for exhaustive attachment-table capture — rejects only obvious OCR noise.
 */
function isMinimalExtractableLabel(label: string): boolean {
  const t = normalizeWhitespace(label);
  if (t.length < 2 || t.length > 80) return false;
  if (!/[a-z]{2,}/i.test(t)) return false;
  if (/^total\b|^description\b|^amount\b/i.test(t)) return false;
  if (
    /\b(see instructions|omb no|form 8879|sign and return|mailit to|reserved for future|minimum tax from form|declaration of e)\b/i.test(
      t,
    )
  ) {
    return false;
  }
  if (/\bvehicle\s*\/\s*\/|(?:volvo|mercedes)\s+vehicle\b/i.test(t)) return false;
  return true;
}

/**
 * Scan every Description/Amount attachment table (Federal Statements, state stmt pages, etc.).
 */
export function extractAllAttachmentTableLines(allText: string): OperatingExpenseLine[] {
  const out: OperatingExpenseLine[] = [];
  let inTable = false;
  let tableIsExpense = false;
  let tableSource = "Attachment table";
  let pendingExpenseHeader = false;

  for (const raw of allText.split(/\n/)) {
    const line = normalizeWhitespace(raw);
    if (!line) continue;

    const lineIdx = allText.indexOf(raw);
    const recentContext =
      lineIdx >= 0
        ? allText.slice(Math.max(0, lineIdx - 500), lineIdx + raw.length).replace(/\s+/g, " ")
        : "";

    if (
      /(?:form\s+1120|form\s+1125|statement\s*\d{1,2})/i.test(line) &&
      /line\s*\d{1,2}|page\s*\d|other\s+costs?/i.test(line) &&
      line.length < 140
    ) {
      // Form 1125-A "Other costs" (COGS line 5) is not an SG&A attachment.
      const isCogsOtherCosts = /form\s*1125|other\s+costs?\b|total\s+to\s+line\s*5/i.test(line);
      pendingExpenseHeader =
        !isCogsOtherCosts &&
        /line\s*(?:9|14|16|17|19|20|24|26)\b|other\s+deduct|other\s+trade\s+or\s+business|benefit|insurance|rent|repair|taxes?\s+and\s+licen|salaries|officer|utilities|deduction/i.test(
          line,
        );
      const stmtM = line.match(/statement\s*(\d{1,2})\b/i);
      const lineM = line.match(/line\s*(\d{1,2})\b/i);
      tableSource = isCogsOtherCosts
        ? `Form 1125-A other costs (${line.slice(0, 40)})`
        : stmtM
          ? `Statement ${stmtM[1]} (${line.slice(0, 55)})`
          : `Form attachment (line ${lineM?.[1] ?? "?"})`;
    }

    if (/^description[\s_]*amount\b/i.test(line.replace(/_/g, " "))) {
      inTable = true;
      const cogsCtx = /form\s*1125|other\s+costs?\b|total\s+to\s+line\s*5/i.test(recentContext + " " + tableSource);
      tableIsExpense =
        !cogsCtx &&
        (pendingExpenseHeader ||
          /other\s+deduct|other\s+trade\s+or\s+business|federal\s+statements/i.test(recentContext + line));
      pendingExpenseHeader = false;
      continue;
    }

    if (inTable && /^total\b/i.test(line)) {
      inTable = false;
      tableIsExpense = false;
      continue;
    }

    if (!inTable || !tableIsExpense) continue;

    const amount = statementLineAmount(line);
    if (amount === undefined) continue;
    const rounded = Math.round(Math.abs(amount));
    if (!isKeepableResidualAmount(rounded)) continue;
    const label = stripMoneyTokens(repairOcrLabel(line));
    if (!isMinimalExtractableLabel(label)) continue;
    out.push({ label, amount: rounded, source: tableSource });
  }

  return dedupeOperatingExpenseLines(out);
}

/**
 * Loose pass: "ALL CAPS LABEL    12,345." rows common on state attachment pages (e.g. Stmt 21).
 */
export function extractCapsLabelAmountLines(allText: string): OperatingExpenseLine[] {
  const out: OperatingExpenseLine[] = [];
  const capsRawRe = /^([A-Za-z][A-Za-z0-9\s&/'().-]{2,80}?)\s{2,}(\d[\d,]*\.?\d*)\s*$/;
  const capsCollapsedRe = /^([A-Za-z][A-Za-z0-9\s&/'().-]{2,55}?)\s+(\d[\d,]*\.?\d*)\s*$/;
  const expenseLabelRe =
    /\b(tax|payroll|licen|rent|utilit|insur|repair|suppl|fee|officer|salar|wage|advert|professional|gasoline|benefit|dues|telephone|bank|merchant)\b/i;

  for (const raw of allText.split(/\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 200) continue;

    let m = trimmed.match(capsRawRe);
    let labelSrc = m?.[1];
    let amountSrc = m?.[2];
    if (!m) {
      const line = normalizeWhitespace(trimmed);
      if (!line || line.length > 120) continue;
      const cm = line.match(capsCollapsedRe);
      if (!cm || !expenseLabelRe.test(cm[1]!)) continue;
      if (isBalanceSheetPositionLabel(cm[1]!)) continue;
      labelSrc = cm[1];
      amountSrc = cm[2];
    } else if (isBalanceSheetPositionLabel(labelSrc!)) {
      continue;
    }

    const lineIdx = allText.indexOf(raw);
    const ctx =
      lineIdx >= 0
        ? allText.slice(Math.max(0, lineIdx - 500), lineIdx + raw.length).replace(/\s+/g, " ")
        : "";
    if (/depreciation and amortization|cost or basis|accumulated depreciation|schedule\s+l\b/i.test(ctx)) {
      continue;
    }
    // Form 1125-A Other costs (COGS line 5) — not SG&A.
    if (/form\s*1125|other\s+costs?\b|total\s+to\s+line\s*5/i.test(ctx)) {
      continue;
    }
    if (isBalanceSheetPositionLabel(labelSrc!) && /schedule\s+l\b|total\s+liabilit|current\s+liabilit/i.test(ctx)) {
      continue;
    }
    if (
      /other\s+trade\s+or\s+business\s+deduct|statement\s*\d{1,2}\b|federal\s+statements|other\s+deduct|taxes?\s+and\s+licen|payroll\s+tax/i.test(
        ctx,
      )
    ) {
      // Stmt / tax attachment / deduction context
    } else if (!/deduct|expense|description\s+amount/i.test(ctx)) {
      continue;
    }

    const label = normalizeWhitespace(labelSrc!.replace(/^axes\b/i, "taxes"));
    const amount = parseMoney(amountSrc!);
    if (amount === null || !isKeepableResidualAmount(amount)) continue;
    if (!isMinimalExtractableLabel(label)) continue;
    out.push({
      label,
      amount: Math.round(Math.abs(amount)),
      source: "OCR caps label+amount",
    });
  }
  return dedupeOperatingExpenseLines(out);
}

export type ExpenseExtractionInventory = {
  /** All unique (label, amount) pairs gathered from every extractor. */
  accepted: OperatingExpenseLine[];
  bySource: Record<string, OperatingExpenseLine[]>;
  totalCount: number;
};

/**
 * Gather every expense label+amount candidate from Stmt tables, comparison, form, and document scan.
 * No ranking — use for audits and `--all` dumps.
 */
export function gatherExpenseExtractionInventory(
  allText: string,
  targetYear: number,
): ExpenseExtractionInventory {
  const pools: Array<{ tag: string; lines: OperatingExpenseLine[] }> = [
    { tag: "attachment_tables", lines: extractAllAttachmentTableLines(allText) },
    { tag: "caps_label_amount", lines: extractCapsLabelAmountLines(allText) },
    { tag: "statement_expense_lines", lines: extractStatementExpenseLines(allText) },
    { tag: "other_deductions_stmt", lines: extractOperatingExpenseLinesFromText(allText) },
    { tag: "document_scan", lines: extractDocumentWideDeductionLines(allText) },
    { tag: "form_direct", lines: extractDirectFormExpenseLines(allText) },
    {
      tag: "comparison_rules",
      lines: extractComparisonExpenseLines(allText, targetYear).map((l) => ({
        label: l.label,
        amount: l.amount,
        source: l.source,
      })),
    },
    {
      tag: "comparison_raw",
      lines: extractAllComparisonLabelValueLines(allText, targetYear).map((l) => ({
        label: l.label,
        amount: l.amount,
        source: l.source,
      })),
    },
    {
      tag: "comparison_deduction_schedule",
      lines: extractComparisonDeductionScheduleLines(allText, targetYear).map((l) => ({
        label: l.label,
        amount: l.amount,
        source: l.source,
      })),
    },
  ];

  const bySource: Record<string, OperatingExpenseLine[]> = {};
  const merged: OperatingExpenseLine[] = [];
  for (const { tag, lines } of pools) {
    bySource[tag] = lines;
    merged.push(...lines);
  }

  return {
    accepted: dedupeOperatingExpenseLines(merged),
    bySource,
    totalCount: dedupeOperatingExpenseLines(merged).length,
  };
}

/** Union inventories from separate text sources (OCR vs embedded) without concatenating text. */
export function mergeExpenseExtractionInventories(
  ...inventories: ExpenseExtractionInventory[]
): ExpenseExtractionInventory {
  const bySource: Record<string, OperatingExpenseLine[]> = {};
  const merged: OperatingExpenseLine[] = [];
  for (const inv of inventories) {
    merged.push(...inv.accepted);
    for (const [tag, lines] of Object.entries(inv.bySource)) {
      bySource[tag] = [...(bySource[tag] ?? []), ...lines];
    }
  }
  const accepted = dedupeOperatingExpenseLines(merged);
  return { accepted, bySource, totalCount: accepted.length };
}

/**
 * Phase 2 — maximal label+amount capture. No plausibility, sales-cap, or category filters.
 * Audits and dumps should score against this pool, not the cleaned pool.
 */
export function extractRawExpenseLinePool(allText: string, targetYear: number): OperatingExpenseLine[] {
  const { accepted } = gatherExpenseExtractionInventory(allText, targetYear);
  return dedupeOperatingExpenseLines(
    accepted.filter((line) => isMinimalExtractableLabel(normalizeWhitespace(line.label))),
  );
}

/**
 * Phase 4 — amount gibberish filter + label repair. Never drops a line solely for a weak label.
 */
export function cleanOperatingExpenseLines(
  raw: OperatingExpenseLine[],
  context?: { sales?: number; values?: Record<string, number> },
): OperatingExpenseLine[] {
  return filterIllogicalExpenseAmounts(raw, context).map((line) => ({
    ...line,
    label: normalizeExtractedExpenseLabel(line.label),
  }));
}

/**
 * Union Stmt-2/attachment, Form page-1, and comparison-worksheet lines — no source priority.
 * Returns the raw pool (alias for `extractRawExpenseLinePool`).
 */
export function buildOperatingExpenseLinePool(allText: string, targetYear: number): OperatingExpenseLine[] {
  return extractRawExpenseLinePool(allText, targetYear);
}

function cleanPasteLabelFromLine(line: OperatingExpenseLine): string {
  const category = expenseCategoryKey(line.label);
  if (category) return displayLabelForKey(category, line.label);
  const cleaned = normalizeWhitespace(repairOcrLabel(line.label));
  if (cleaned.length >= 3 && cleaned.length <= 40) return cleaned;
  return cleaned.slice(0, 40) || "Expense";
}

/**
 * Fill the eight paste positions from the highest-dollar OCR expense lines (labels from OCR text).
 * Gated by OPEX_RANK_BY_AMOUNT=1 — slot IDs are paste mechanics only, not semantic categories.
 */
export function applyRankByAmountOpex(col: TaxYearValues): TaxYearValues {
  const rawLines = col.operatingExpenseLines ?? [];
  const lines = filterPlausibleRankPoolLines(rawLines, col.values.sales, col.values);

  const ranked = rankOperatingExpenseCandidates(lines, {
    sales: col.values.sales,
    values: col.values,
  }).top8;

  const values = { ...col.values };
  const fieldSources = { ...(col.fieldSources ?? {}) };
  const confidence = { ...(col.confidence ?? {}) };
  const opexSlotLabels: Record<string, string> = { ...(col.opexSlotLabels ?? {}) };

  for (let i = 0; i < OPERATING_EXPENSE_SLOT_IDS.length; i++) {
    const slotId = OPERATING_EXPENSE_SLOT_IDS[i]!;
    const cand = ranked[i];
    if (cand) {
      values[slotId] = cand.amount;
      opexSlotLabels[slotId] = cleanPasteLabelFromLine({
        label: cand.label,
        amount: cand.amount,
        source: cand.source,
      });
      fieldSources[slotId] = `Operating expenses (rank by amount${cand.source ? `: ${cand.source}` : ""})`;
      confidence[slotId] = Math.min(confidence[slotId] ?? 86, 86);
    } else if (!col.userOpexSlotLabels?.[slotId]) {
      values[slotId] = 0;
      opexSlotLabels[slotId] = slotDefaultLabel(slotId);
      fieldSources[slotId] = "Operating expenses (rank by amount — empty row)";
      confidence[slotId] = Math.min(confidence[slotId] ?? 75, 75);
    }
  }

  return {
    ...col,
    values,
    fieldSources,
    confidence,
    opexSlotLabels,
    operatingExpenseLines: rawLines,
  };
}

function stripMoneyTokens(line: string): string {
  return normalizeWhitespace(line.replace(/[\d$,.()-]+/g, " ").replace(/\s+/g, " "));
}

/**
 * Most returns attach the "Other deductions" itemized breakdown as Statement 2, but some preparers
 * number it differently (e.g. Statement 3, when Statement 1/2 cover other income/taxes first). Read
 * the actual number off the "Other deductions (attach statement) ... STATEMENT N" reference on the
 * form page itself, or the attachment's own "... OTHER DEDUCTIONS STATEMENT N" header, instead of
 * assuming it is always Statement 2.
 */
function resolveOtherDeductionsStatementNumber(allText: string): number {
  // Prefer the attachment's own header (e.g. "Statement 1 - Form 1120, Line 26 - Other Deductions")
  // over a form cross-ref like "SEE STMT 2" — preparers often disagree on the number.
  for (const raw of allText.split(/\n/)) {
    const line = normalizeWhitespace(raw);
    if (!/(?:statement|stmt)\s*\d/i.test(line)) continue;
    if (!/other\s+deduct/i.test(line)) continue;
    if (!/form\s+1120|line\s*(?:19|20|26)/i.test(line)) continue;
    const m = line.match(/(?:statement|stmt)\s*(\d{1,2})\b/i);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 1 && n <= 20) {
      if (process.env.DEBUG_STMT_N) console.error(`[stmtN-attachment-header]`, JSON.stringify(line), "n=", n);
      return n;
    }
  }
  for (const raw of allText.split(/\n/)) {
    const line = normalizeWhitespace(raw);
    if (!/other\s+deduct/i.test(line)) continue;
    if (!/attach\s+statement|line\s*(?:19|20|26)\b/i.test(line)) continue;
    const m = line.match(/(?:statement|stmt)\.?\s*(\d{1,2})\b/i);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 1 && n <= 20) {
      if (process.env.DEBUG_STMT_N) console.error(`[stmtN] matched line=`, JSON.stringify(line), "n=", n);
      return n;
    }
  }
  for (const raw of allText.split(/\n/)) {
    const line = normalizeWhitespace(raw);
    if (!/^(?:form|schedule)\s*\S*\s*other\s+deductions\b/i.test(line)) continue;
    const m = line.match(/statement\s*(\d{1,2})\b/i);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 1 && n <= 20) return n;
  }
  return 2;
}

/**
 * Extract operating expense detail lines from the "Other deductions" attachment region (usually
 * Statement 2, but the number is read dynamically — see `resolveOtherDeductionsStatementNumber`).
 * This intentionally stays simple — it prefers fewer false positives over exhaustive capture.
 */
export function extractOperatingExpenseLinesFromText(allText: string): OperatingExpenseLine[] {
  const out: OperatingExpenseLine[] = [];
  let inStmt2 = false;
  let inFederalTable = false;
  const stmtN = resolveOtherDeductionsStatementNumber(allText);
  const stmtNPattern = `(?:statement|stmt|tatement)\\s*${stmtN}\\b`;
  const otherStmtPattern = `(?:statement|stmt)\\s*(?!${stmtN}\\b)[1-9]\\d?\\b`;

  for (const raw of allText.split(/\n/)) {
    const line = normalizeWhitespace(raw);
    if (!line) continue;

    const lineIdx = allText.indexOf(raw);
    const recentContext =
      lineIdx >= 0
        ? allText.slice(Math.max(0, lineIdx - 600), lineIdx + raw.length).replace(/\s+/g, " ")
        : "";

    if (/^description\s+amount\b/i.test(line) && /federal\s+statements/i.test(recentContext)) {
      inFederalTable = true;
      inStmt2 = true;
      continue;
    }
    if (
      new RegExp(`${stmtNPattern}\\s*-\\s*form\\s+1120`, "i").test(repairOcrLabel(line)) ||
      (/(?:statement|stmt)\s*\d{1,2}\b/i.test(repairOcrLabel(line)) &&
        /other\s+deduct/i.test(line) &&
        /form\s+1120|line\s*(?:19|20|26)/i.test(line)) ||
      (new RegExp(stmtNPattern, "i").test(repairOcrLabel(line)) &&
        (/other\s+deduct|other\s+ions|other\s+expense|line\s*(?:19|20|26)\b/i.test(line) ||
          /see\s+statement/i.test(line)) &&
        !/two\s*year\s*comparison|comparison\s+worksheet/i.test(recentContext))
    ) {
      inStmt2 = true;
      inFederalTable = /federal\s+statements/i.test(recentContext + line);
      if (process.env.DEBUG_STMT_N) console.error(`[enter-main]`, JSON.stringify(line));
      continue;
    }
    if (/^description\s+amount\b/i.test(line) && new RegExp(stmtNPattern, "i").test(recentContext)) {
      inFederalTable = true;
      inStmt2 = true;
      if (process.env.DEBUG_STMT_N) console.error(`[enter-federal]`, JSON.stringify(line));
      continue;
    }
    if (inStmt2 && new RegExp(otherStmtPattern, "i").test(line) && !/other\s+deduct/i.test(line)) {
      if (process.env.DEBUG_STMT_N) console.error(`[exit-otherStmt]`, JSON.stringify(line));
      inStmt2 = false;
      inFederalTable = false;
    }
    if (inStmt2 && /two\s*year\s*comparison|comparison\s+worksheet/i.test(line)) {
      if (process.env.DEBUG_STMT_N) console.error(`[exit-comparison]`, JSON.stringify(line));
      inStmt2 = false;
      inFederalTable = false;
    }
    if (!inStmt2) continue;

    if (/^total\b/i.test(line)) continue;
    if (/\bdepreciation\b/i.test(line) && !/accumulated/i.test(line)) continue;
    if (/\bamortization\b/i.test(line) && !/accumulated/i.test(line)) continue;

    const amount = statementLineAmount(line);
    if (amount === undefined) continue;
    const rounded = Math.round(Math.abs(amount));
    if (!isKeepableResidualAmount(rounded)) continue;

    const label = stripMoneyTokens(repairOcrLabel(line));
    if (!isMinimalExtractableLabel(label)) continue;

    out.push({
      label,
      amount: rounded,
      source: `Statement ${stmtN}`,
    });
  }

  // Dedupe exact (labelKey, amount) pairs, keep first (source is stable here).
  const seen = new Set<string>();
  const deduped: OperatingExpenseLine[] = [];
  for (const line of out) {
    const key = `${expenseLabelKey(line.label)}:${line.amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(line);
  }
  return deduped.sort((a, b) => b.amount - a.amount);
}

/**
 * Some SG&A categories (e.g. "Repairs and maintenance") are reported directly on Form 1120 /
 * 1120-S page 1, not inside the "Other deductions" attachment — so they never appear in
 * `extractOperatingExpenseLinesFromText`'s Statement-2/3 scan. Surface them as high-trust
 * expense-line candidates for the rank pool (amount + readable label).
 */
function pushDirectFormLine(
  allText: string,
  out: OperatingExpenseLine[],
  opts: {
    lineNumber: number;
    label: string;
    labelRe: RegExp;
    source: string;
    skipRe?: RegExp;
  },
): void {
  let best: OperatingExpenseLine | undefined;
  for (const raw of allText.split(/\n/)) {
    const line = normalizeWhitespace(raw);
    if (!line || !opts.labelRe.test(line)) continue;
    if (opts.skipRe?.test(line)) continue;
    if (!isForm1120Line(line, opts.lineNumber)) continue;
    // OCR sometimes inserts a space in thousands ("193, 583") — normalize before parse.
    const normalized = line.replace(/(\d), (\d{3})\b/g, "$1,$2");
    const amount = scheduleLineAmount(normalized) ?? lineTailAmount(normalized);
    if (amount === undefined) continue;
    const rounded = Math.round(Math.abs(amount));
    if (!isKeepableResidualAmount(rounded)) continue;
    const cand = { label: opts.label, amount: rounded, source: opts.source };
    if (!best || rounded > best.amount) best = cand;
  }
  if (best) out.push(best);
}

export function extractDirectFormExpenseLines(allText: string): OperatingExpenseLine[] {
  const kind = detectTaxForm(allText).kind;
  const out: OperatingExpenseLine[] = [];
  const skipCtx = /accumulated|schedule\s*l|comparison/i;

  if (kind === "1120") {
    pushDirectFormLine(allText, out, {
      lineNumber: 12,
      label: "Compensation of officers",
      labelRe: /officer|compens/i,
      source: "Form 1120 line 12",
      skipRe: skipCtx,
    });
    pushDirectFormLine(allText, out, {
      lineNumber: 13,
      label: "Salaries and wages",
      labelRe: /salar|wage/i,
      source: "Form 1120 line 13",
      skipRe: skipCtx,
    });
    pushDirectFormLine(allText, out, {
      lineNumber: 14,
      label: "Repairs and maintenance",
      labelRe: /repair/i,
      source: "Form 1120 line 14",
      skipRe: skipCtx,
    });
    pushDirectFormLine(allText, out, {
      lineNumber: 16,
      label: "Rents",
      labelRe: /\brents?\b/i,
      source: "Form 1120 line 16",
      skipRe: skipCtx,
    });
    pushDirectFormLine(allText, out, {
      lineNumber: 22,
      label: "Advertising",
      labelRe: /advert/i,
      source: "Form 1120 line 22",
      skipRe: skipCtx,
    });
  } else if (kind === "1120-s" || kind === "1065") {
    pushDirectFormLine(allText, out, {
      lineNumber: 7,
      label: "Compensation of officers",
      labelRe: /officer|compens/i,
      source: kind === "1120-s" ? "Form 1120-S line 7" : "Form 1065 line 7",
      skipRe: skipCtx,
    });
    pushDirectFormLine(allText, out, {
      lineNumber: 8,
      label: "Salaries and wages",
      labelRe: /salar|wage/i,
      source: kind === "1120-s" ? "Form 1120-S line 8" : "Form 1065 line 8",
      skipRe: skipCtx,
    });
    pushDirectFormLine(allText, out, {
      lineNumber: 9,
      label: "Repairs and maintenance",
      labelRe: /repair/i,
      source: kind === "1120-s" ? "Form 1120-S line 9" : "Form 1065 line 9",
      skipRe: skipCtx,
    });
    pushDirectFormLine(allText, out, {
      lineNumber: 11,
      label: "Rents",
      labelRe: /\brents?\b/i,
      source: kind === "1120-s" ? "Form 1120-S line 11" : "Form 1065 line 11",
      skipRe: skipCtx,
    });
    pushDirectFormLine(allText, out, {
      lineNumber: 12,
      label: "Taxes and licenses",
      labelRe: /taxes?\s+and\s+licen/i,
      source: kind === "1120-s" ? "Form 1120-S line 12" : "Form 1065 line 12",
      skipRe: skipCtx,
    });
    pushDirectFormLine(allText, out, {
      lineNumber: 16,
      label: "Advertising",
      labelRe: /advert/i,
      source: kind === "1120-s" ? "Form 1120-S line 16" : "Form 1065 line 16",
      skipRe: skipCtx,
    });
  }

  return out;
}

/** Pull parser-resolved opex slot values into the expense-line pool before top-8 selection. */
export function supplementOperatingExpenseLines(
  lines: OperatingExpenseLine[],
  values: Record<string, number>,
  fieldSources?: Record<string, string>,
): OperatingExpenseLine[] {
  const out = [...lines];
  for (const slotId of OPERATING_EXPENSE_SLOT_IDS) {
    const amount = values[slotId];
    if (amount === undefined || !isKeepableResidualAmount(amount)) continue;
    const row = TAX_WORKBOOK_ROWS.find((r) => r.id === slotId);
    out.push({
      label: row?.label ?? slotId,
      amount: Math.round(Math.abs(amount)),
      source: fieldSources?.[slotId] ?? "Parser field",
    });
  }
  const seen = new Set<string>();
  const deduped: OperatingExpenseLine[] = [];
  for (const line of out) {
    const key = `${expenseLabelKey(line.label)}:${line.amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(line);
  }
  return deduped.sort((a, b) => b.amount - a.amount);
}

function filterPlausibleExpenseLines(
  lines: OperatingExpenseLine[],
  sales?: number,
  resolvedValues?: Record<string, number>,
): OperatingExpenseLine[] {
  return lines.filter((line) => {
    const amount = Math.round(line.amount);
    if (!isKeepableResidualAmount(amount)) return false;
    if (diagnoseIllogicalAmount(line, sales, resolvedValues)) return false;
    if (/form\s*1120/i.test(line.source ?? "") && expenseCategoryKey(line.label)) {
      return isPlausibleExpenseLabel(line.label);
    }
    return isPlausibleExpenseLabel(line.label);
  });
}

function shouldApplyTop8Policy(
  _lines: OperatingExpenseLine[],
  _sales?: number,
  _priorValues?: Record<string, number>,
  _priorSources?: Record<string, string>,
): boolean {
  // Blocked: do not rank or remap slot amounts until extraction audit shows all integrator pairs.
  return false;
}

function selectTop8ForYear(lines: OperatingExpenseLine[]): SharedTop8 {
  const ranked = [...lines]
    .filter((l) => isTop8EligibleAmount(l.amount, { source: l.source, label: l.label }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 8);
  return {
    labelKeys: ranked.map((l) => expenseLabelKey(l.label)),
    labels: ranked.map((l) => l.label),
    maxAmounts: ranked.map((l) => l.amount),
  };
}

/** Per-year top 8 expense groups from an already-filtered pool (one line per group). */
function selectTop8GroupsForYear(lines: OperatingExpenseLine[]): SharedTop8 {
  const ranked: OperatingExpenseLine[] = [];
  const seenGroups = new Set<string>();
  for (const line of [...lines].sort((a, b) => b.amount - a.amount)) {
    if (
      isExpenseRankCrumb(line.amount, {
        taxYear: undefined,
        source: line.source,
        label: line.label,
      })
    ) {
      continue;
    }
    // Identity = group key (label category + extraction source spot), NOT dollar amount.
    // Distinct SG&A lines may share the same or nearly-same amount.
    const key = crossYearExpenseGroupKey(line);
    if (seenGroups.has(key)) continue;
    seenGroups.add(key);
    ranked.push(line);
    if (ranked.length >= 8) break;
  }
  return {
    labelKeys: ranked.map((l) => crossYearExpenseGroupKey(l)),
    labels: ranked.map((l) => l.label),
    maxAmounts: ranked.map((l) => l.amount),
  };
}

/**
 * Pre-merge labeled OD detail (office/supplies/telephone/travel) is a constructed residual
 * from Stmt captions — prefer it when stmtTOTAL−stmtInTop8 amount-matching disagrees
 * (top-8 paste indices can false-match supplemental lines into stmtInTop8).
 * Comparison OD residuals still lose to partition identity (soft scrapes).
 */
function isLabeledDetailOpexSource(source?: string): boolean {
  return /office\/supplies|telephone\/travel/i.test(source ?? "");
}

function isAuthoritativeOpexSource(source?: string): boolean {
  return (
    isLabeledDetailOpexSource(source) ||
    /comparison.*OTHER DEDUCTIONS residual/i.test(source ?? "")
  );
}

function resolveOtherOperatingExpenses(
  residual: number,
  priorValue: number | undefined,
  priorSource: string | undefined,
  sales?: number,
): number | undefined {
  const ctx = { sales };
  const priorOk = priorValue !== undefined && isPlausibleOtherOperatingExpense(priorValue, ctx);
  const residualOk = residual >= 1 && isPlausibleOtherOperatingExpense(residual, ctx);

  if (
    priorOk &&
    isLabeledDetailOpexSource(priorSource) &&
    residualOk &&
    Math.round(priorValue!) !== Math.round(residual)
  ) {
    return priorValue;
  }
  // Charter partition identity when no labeled detail inventory disagrees.
  if (residualOk) return residual;
  if (priorOk && isAuthoritativeOpexSource(priorSource)) return priorValue;
  if (priorOk) return priorValue;
  return undefined;
}

function resolveStmtPartitionTotal(
  col: TaxYearValues,
  lines: OperatingExpenseLine[],
  _top8Sum: number,
): number | undefined {
  const candidates = [
    col.stmtOtherDeductionsTotal,
    inferStmtTotalFromPool(col.operatingExpenseLines ?? lines),
    inferStmtTotalFromPool(lines),
  ].filter((n): n is number => typeof n === "number" && isKeepableResidualAmount(n));

  // Prefer the largest reading — form "Other deductions" total and Stmt-2 footer should agree;
  // do NOT require total >= full top-8 sum (top-8 includes form page-1 lines outside Stmt-2).
  if (!candidates.length) return undefined;
  return Math.max(...candidates);
}

/**
 * Traditional Stmt / form-attachment detail sources for the Other-deductions residual.
 */
function isTraditionalStmtDetailSource(source?: string): boolean {
  return /statement\s*\d|stmt\s*\d|form\s+attachment|federal\s+statements\s+table|other\s+deduct/i.test(
    source ?? "",
  );
}

/**
 * Supplemental extractors that often carry the same Stmt lines when Statement-N
 * tagging was missed (OCR caps, two-year comparison, bare Attachment table).
 * Capped by stmt TOTAL in {@link sumStmtAmountsInTop8}.
 */
function isSupplementalStmtDetailSource(source?: string): boolean {
  return /ocr\s+caps|caps\s+label|two-year comparison|comparison\s+(?:deduction|raw)|attachment\s+table/i.test(
    source ?? "",
  );
}

/** Union of traditional + supplemental stmt-detail sources. */
function isStmtDetailSource(source?: string): boolean {
  return isTraditionalStmtDetailSource(source) || isSupplementalStmtDetailSource(source);
}

/**
 * Form page-1 expense categories — never part of the Other-deductions stmt total,
 * even when OCR tags them with a Statement/attachment/comparison source.
 */
function isFormPage1ExpenseCategory(label: string): boolean {
  const cat = expenseCategoryKey(label);
  return (
    cat === "officer_compensation" ||
    cat === "salaries_wages" ||
    cat === "rent" ||
    cat === "taxes_licenses" ||
    cat === "advertising" ||
    cat === "repairs" ||
    cat === "employee_benefits"
  );
}

/**
 * Sum of pasted top-8 amounts that came from the Other-deductions statement/attachment.
 * Form page-1 lines (officer, salaries, rent, repairs, …) are excluded — they were
 * never in stmt total. Supplemental OCR-caps/comparison hits are added only while
 * the running sum stays ≤ stmtTotal (prevents over-subtraction when caps pick up
 * out-of-partition lines).
 */
function sumStmtAmountsInTop8(
  lines: OperatingExpenseLine[],
  top8Amounts: number[],
  stmtTotal?: number,
): number {
  let sum = 0;
  const claimed = new Set<number>();

  const consider = (line: OperatingExpenseLine, supplemental: boolean) => {
    // Form page-1 categories stay outside the partition even with Statement tags.
    // Do NOT use isDirectFormLineSource — Statement headers embed "Form 1120-S … Line 19".
    if (isFormPage1ExpenseCategory(line.label)) return;
    const label = normalizeWhitespace(line.label);
    if (/^amortization\b/i.test(label)) return;
    const amt = Math.round(line.amount);
    if (claimed.has(amt)) return;
    if (!top8Amounts.includes(amt)) return;
    if (supplemental && stmtTotal !== undefined && sum + amt > stmtTotal) return;
    claimed.add(amt);
    sum += amt;
  };

  for (const line of lines) {
    if (isTraditionalStmtDetailSource(line.source)) consider(line, false);
  }
  for (const line of lines) {
    if (isSupplementalStmtDetailSource(line.source)) consider(line, true);
  }
  return sum;
}

/** Amortization dollars sitting inside the Stmt-2 total (also reported on the amort workbook row). */
function sumStmtAmortization(col: TaxYearValues, lines: OperatingExpenseLine[]): number {
  const seen = new Set<number>();
  let sum = 0;
  for (const line of lines) {
    if (!isStmtDetailSource(line.source)) continue;
    if (!/^amortization\b/i.test(normalizeWhitespace(line.label))) continue;
    const amt = Math.round(line.amount);
    if (seen.has(amt)) continue;
    seen.add(amt);
    sum += amt;
  }
  if (sum > 0) return sum;
  // Filtered rank pool may have dropped the amort line — still remove it from stmt total when
  // the parser already booked amortization on its own workbook row.
  const booked = col.values.amortization;
  if (typeof booked === "number" && isKeepableResidualAmount(booked)) return Math.round(booked);
  return 0;
}

/**
 * Form page-1 SG&A amounts that lost the top-8 multiset — never part of the Other-deductions
 * stmt residual, so fold into other_operating_expenses (e.g. Form page-1 advertising outside top-8).
 * Source-class only: Form 1120 line / OCR-caps. No paste-seat / category-vs-seat gates.
 */
function sumFormPage1AmountsOutsideTop8(
  lines: OperatingExpenseLine[],
  top8Amounts: number[],
): number {
  let total = 0;
  const seen = new Set<number>();
  for (const line of lines) {
    if (!isFormPage1ExpenseCategory(line.label)) continue;
    const src = line.source ?? "";
    const amt = Math.round(line.amount);
    if (!isKeepableResidualAmount(amt)) continue;
    const isFormOrCaps =
      (/form\s*1120/i.test(src) && /line\s*\d/i.test(src) && !/statement\s*\d/i.test(src)) ||
      /ocr\s+caps|caps\s+label/i.test(src);
    if (!isFormOrCaps) continue;
    if (top8Amounts.includes(amt)) continue;
    if (seen.has(amt)) continue;
    seen.add(amt);
    total += amt;
  }
  return total;
}

/** Map a cross-year group to a workbook paste row when the group id matches a slot id (from comparison row source). */
function groupKeyToPasteSlotId(groupKey: string): OperatingExpenseSlotId | undefined {
  // Rank path pastes by rank order; slot IDs are paste indices only — no category→seat remap.
  const suffix = groupKey.startsWith("row:")
    ? groupKey.slice(4)
    : groupKey.startsWith("cat:")
      ? groupKey.slice(4)
      : groupKey.startsWith("spot:stmt")
        ? groupKey.slice(groupKey.lastIndexOf(":") + 1)
        : undefined;
  if (suffix && (OPERATING_EXPENSE_SLOT_IDS as readonly string[]).includes(suffix)) {
    return suffix as OperatingExpenseSlotId;
  }
  return undefined;
}

function pasteLabelFromGroupLine(
  lines: OperatingExpenseLine[],
  groupKey: string,
  fallbackLabel: string,
): string {
  const rep = representativeLineForGroup(lines, groupKey);
  const cleaned = normalizeExtractedExpenseLabel(rep?.label ?? fallbackLabel);
  if (cleaned.length >= 3 && cleaned.length <= 50) return cleaned;
  const slot = groupKeyToPasteSlotId(groupKey);
  return slot ? slotDefaultLabel(slot) : cleaned || "Expense";
}

function applySharedTop8ToColumn(
  col: TaxYearValues,
  shared: SharedTop8,
  lines: OperatingExpenseLine[],
  opts?: { assignByRankOrder?: boolean },
): TaxYearValues {
  const next = { ...col.values };
  const nextConf = { ...(col.confidence ?? {}) };
  const nextSources = { ...(col.fieldSources ?? {}) };
  const priorOtherOpex = next.other_operating_expenses;
  const priorOtherOpexSource = nextSources.other_operating_expenses;
  const opexSlotLabels: Record<string, string> = {};

  const usedSlots = new Set<string>();
  const unassigned: Array<{ groupKey: string; label: string; amount: number }> = [];

  if (opts?.assignByRankOrder) {
    // Paste row i = ith cross-year-ranked group; slot IDs are indices, not categories.
    for (let i = 0; i < OPERATING_EXPENSE_SLOT_IDS.length; i++) {
      const slotId = OPERATING_EXPENSE_SLOT_IDS[i]!;
      const groupKey = shared.labelKeys[i];
      const label = shared.labels[i] ?? groupKey ?? slotDefaultLabel(slotId);
      if (!groupKey) {
        next[slotId] = 0;
        nextConf[slotId] = Math.min(nextConf[slotId] ?? 75, 75);
        nextSources[slotId] = "Operating expenses (top-8 — not present this year)";
        opexSlotLabels[slotId] = col.userOpexSlotLabels?.[slotId] ?? slotDefaultLabel(slotId);
        continue;
      }
      const amount = amountForGroupKey(lines, groupKey);
      if (isKeepableResidualAmount(amount)) {
        next[slotId] = amount;
        nextConf[slotId] = Math.min(nextConf[slotId] ?? 88, 88);
        nextSources[slotId] = "Operating expenses (top-8 by cross-year sum)";
        opexSlotLabels[slotId] =
          col.userOpexSlotLabels?.[slotId] ?? pasteLabelFromGroupLine(lines, groupKey, label);
      } else {
        next[slotId] = 0;
        nextConf[slotId] = Math.min(nextConf[slotId] ?? 75, 75);
        nextSources[slotId] = "Operating expenses (top-8 — not present this year)";
        opexSlotLabels[slotId] =
          col.userOpexSlotLabels?.[slotId] ?? pasteLabelFromGroupLine(lines, groupKey, label);
      }
      usedSlots.add(slotId);
    }
  } else {
    for (let i = 0; i < shared.labelKeys.length; i++) {
      const groupKey = shared.labelKeys[i]!;
      const amount = amountForGroupKey(lines, groupKey);
      if (!isKeepableResidualAmount(amount)) continue;
      const slotId = groupKeyToPasteSlotId(groupKey);
      if (slotId && !usedSlots.has(slotId)) {
        next[slotId] = amount;
        nextConf[slotId] = Math.min(nextConf[slotId] ?? 88, 88);
        nextSources[slotId] = "Operating expenses (top-8 by cross-year sum)";
        opexSlotLabels[slotId] =
          col.userOpexSlotLabels?.[slotId] ??
          pasteLabelFromGroupLine(lines, groupKey, shared.labels[i] ?? groupKey);
        usedSlots.add(slotId);
      } else {
        unassigned.push({ groupKey, label: shared.labels[i] ?? groupKey, amount });
      }
    }

    unassigned.sort((a, b) => b.amount - a.amount);
    for (const slotId of OPERATING_EXPENSE_SLOT_IDS) {
      if (usedSlots.has(slotId)) continue;
      const row = unassigned.shift();
      if (row && isTop8EligibleAmount(row.amount)) {
        next[slotId] = row.amount;
        nextConf[slotId] = Math.min(nextConf[slotId] ?? 88, 88);
        nextSources[slotId] = "Operating expenses (top-8 by cross-year sum)";
        opexSlotLabels[slotId] =
          col.userOpexSlotLabels?.[slotId] ?? pasteLabelFromGroupLine(lines, row.groupKey, row.label);
      } else {
        next[slotId] = 0;
        nextConf[slotId] = Math.min(nextConf[slotId] ?? 75, 75);
        nextSources[slotId] = "Operating expenses (top-8 — not present this year)";
        opexSlotLabels[slotId] = col.userOpexSlotLabels?.[slotId] ?? slotDefaultLabel(slotId);
      }
    }
  }

  const top8Amounts = OPERATING_EXPENSE_SLOT_IDS.map((id) => next[id] ?? 0).filter(
    (a) => isKeepableResidualAmount(a),
  );
  const top8Sum = sumTop8Amounts(top8Amounts);
  const stmtTotalRaw = resolveStmtPartitionTotal(col, lines, top8Sum);
  const stmtAmort = sumStmtAmortization(col, lines);
  const stmtTotal =
    stmtTotalRaw !== undefined ? Math.max(0, stmtTotalRaw - stmtAmort) : undefined;
  const stmtInTop8 = sumStmtAmountsInTop8(lines, top8Amounts, stmtTotal);
  const formPage1OutsideTop8 = sumFormPage1AmountsOutsideTop8(lines, top8Amounts);

  let otherOpex: number | undefined;
  let otherOpexSource: string | undefined;
  let usedStmtPartition = false;
  // Prefer stmt partition when present (Other-deductions total − stmt lines in top-8).
  // Pool residual (sum(all scanned) − top-8) is the charter fallback when stmt total is absent.
  // Authoritative pre-merge residuals (summed detail / comparison OD residual) win when the
  // stmt partition disagrees materially — AZ 2023 parse had exact 262517 before align overwrote.
  if (
    stmtTotal !== undefined &&
    isKeepableResidualAmount(stmtTotal) &&
    isKeepableResidualAmount(stmtInTop8) &&
    stmtTotal >= stmtInTop8
  ) {
    const stmtResidual = Math.max(0, Math.round(stmtTotal - stmtInTop8));
    otherOpex = resolveOtherOperatingExpenses(
      stmtResidual,
      priorOtherOpex,
      priorOtherOpexSource,
      next.sales,
    );
    // Identity dollars win; keep inventory source label only when amounts already match.
    // Always mark partition used when residual is kept — otherwise form page-1 outside
    // top-8 double-adds on top of stmtTOTAL − stmtInTop8.
    if (otherOpex === stmtResidual) {
      usedStmtPartition = true;
      otherOpexSource =
        otherOpex === priorOtherOpex &&
        priorOtherOpex !== undefined &&
        isAuthoritativeOpexSource(priorOtherOpexSource)
          ? priorOtherOpexSource ?? "Other operating expenses (reconciled)"
          : "Operating expenses (stmt total − stmt lines in top-8)";
    } else {
      otherOpexSource =
        priorOtherOpexSource ?? "Other operating expenses (reconciled)";
      usedStmtPartition = false;
    }
  } else {
    const residual = Math.max(0, sumAmounts(lines) - top8Sum);
    otherOpex = resolveOtherOperatingExpenses(
      residual,
      priorOtherOpex,
      priorOtherOpexSource,
      next.sales,
    );
    otherOpexSource =
      otherOpex === priorOtherOpex && priorOtherOpex !== undefined
        ? priorOtherOpexSource ?? "Other operating expenses (reconciled)"
        : "Operating expenses residual (sum(pool) − sum(top-8))";
  }

  // Statement summed-detail / itemized residuals already exclude top-8 — folding form page-1
  // lines on top double-counts when form SG&A already folded into the residual.
  const keptPriorStmtResidual =
    !usedStmtPartition &&
    otherOpex === priorOtherOpex &&
    /statement\s*\d|summed detail|itemized closure/i.test(priorOtherOpexSource ?? "");
  if (isKeepableResidualAmount(formPage1OutsideTop8) && !keptPriorStmtResidual) {
    otherOpex = Math.round((otherOpex ?? 0) + formPage1OutsideTop8);
    otherOpexSource =
      (otherOpexSource ?? "Other operating expenses") + " (includes form lines outside top-8)";
  }

  if (otherOpex !== undefined) {
    next.other_operating_expenses = otherOpex;
    nextConf.other_operating_expenses = Math.min(nextConf.other_operating_expenses ?? 88, 88);
    nextSources.other_operating_expenses = otherOpexSource ?? "Other operating expenses (reconciled)";
  }

  return {
    ...col,
    values: next,
    confidence: nextConf,
    fieldSources: nextSources,
    opexSlotLabels,
    operatingExpenseLines: lines,
  };
}

/** Apply top-8 opex policy to a single parsed year (API / benchmark path). */
export function applyOperatingExpensesToSingleYear(col: {
  values: Record<string, number>;
  confidence?: Record<string, number>;
  fieldSources?: Record<string, string>;
  operatingExpenseLines?: OperatingExpenseLine[];
}): {
  values: Record<string, number>;
  confidence?: Record<string, number>;
  fieldSources?: Record<string, string>;
  opexSlotLabels?: Record<string, string>;
  operatingExpenseLines?: OperatingExpenseLine[];
} {
  const rawLines = col.operatingExpenseLines ?? [];
  const lines = useOpexLabelCleaning()
    ? cleanOperatingExpenseLines(rawLines, { sales: col.values.sales, values: col.values })
    : rawLines;
  if (!shouldApplyTop8Policy(lines, col.values.sales, col.values, col.fieldSources)) {
    return { ...col, operatingExpenseLines: lines };
  }

  const shared = selectTop8ForYear(lines);
  if (!shared.labelKeys.length) return { ...col, operatingExpenseLines: lines };

  const applied = applySharedTop8ToColumn(
    {
      year: 0,
      source: "parser",
      values: col.values,
      confidence: col.confidence,
      fieldSources: col.fieldSources,
      operatingExpenseLines: lines,
    },
    shared,
    lines,
  );
  return {
    values: applied.values,
    confidence: applied.confidence,
    fieldSources: applied.fieldSources,
    opexSlotLabels: applied.opexSlotLabels,
    operatingExpenseLines: lines,
  };
}

type SharedTop8 = {
  labelKeys: string[];
  labels: string[];
  /** Cross-year sum (rank path) or per-year max (legacy path). */
  maxAmounts: number[];
};

/** Form / Stmt extraction spot — groups lines when OCR labels drift but source is the same row. */
function sourceSpotKey(source?: string, label?: string): string | undefined {
  if (!source) return undefined;
  const form = source.match(/form\s*1120[-\s]?[sb]?\s*line\s*(\d+)/i);
  if (form) return `spot:form1120:${form[1]}`;
  const stmt = source.match(/statement\s*(\d+)|stmt\s*(\d+)/i);
  if (stmt) {
    const n = stmt[1] ?? stmt[2];
    const cat = label ? expenseCategoryKey(label) : undefined;
    if (cat) return `spot:stmt${n}:${cat}`;
    const lk = label ? expenseLabelKey(label) : "";
    if (lk) return `spot:stmt${n}:${lk}`;
    return `spot:stmt${n}`;
  }
  return undefined;
}

/** Parser field id from comparison source, e.g. `(officer_compensation row)` — not OCR label text. */
function comparisonRowGroupKey(source?: string): string | undefined {
  const m = source?.match(/\(([a-z_]+)\s+row\)/i);
  if (!m?.[1] || m[1] === "raw") return undefined;
  return `row:${m[1]}`;
}

/**
 * Cross-year grouping: comparison row id → form/Stmt spot → category regex fallback.
 * Amount identity is stable across years; OCR label text is not used for grouping when source has row id.
 */
export function crossYearExpenseGroupKey(line: OperatingExpenseLine): string {
  const row = comparisonRowGroupKey(line.source);
  if (row) return row;
  const spot = sourceSpotKey(line.source, line.label);
  if (spot) return spot;
  const cat = expenseCategoryKey(line.label);
  if (cat) return `cat:${cat}`;
  const lk = expenseLabelKey(line.label);
  if (lk) return `label:${lk}`;
  return `raw:${Math.round(line.amount)}`;
}

function lineMatchesGroupKey(line: OperatingExpenseLine, groupKey: string): boolean {
  if (groupKey.startsWith("cat:")) {
    // Any source spot/row with this category counts — avoid splitting Σ across years.
    return expenseCategoryKey(line.label) === groupKey.slice(4);
  }
  if (
    groupKey.startsWith("row:") ||
    groupKey.startsWith("spot:") ||
    groupKey.startsWith("label:") ||
    groupKey.startsWith("raw:")
  ) {
    return crossYearExpenseGroupKey(line) === groupKey;
  }
  return expenseLabelKey(line.label) === groupKey;
}

/** Group key for cross-year Σ ranking — category first so Form/Stmt/comparison rows merge. */
function crossYearSumGroupKey(line: OperatingExpenseLine): string {
  const cat = expenseCategoryKey(line.label);
  if (cat) return `cat:${cat}`;
  return crossYearExpenseGroupKey(line);
}

function sumAmountForGroupKey(lines: OperatingExpenseLine[], groupKey: string): number {
  let sum = 0;
  for (const line of lines) {
    if (!lineMatchesGroupKey(line, groupKey)) continue;
    if (!isTop8EligibleAmount(line.amount, { source: line.source, label: line.label })) continue;
    sum += Math.round(line.amount);
  }
  return sum;
}

function representativeLineForGroup(lines: OperatingExpenseLine[], groupKey: string): OperatingExpenseLine | undefined {
  let best: OperatingExpenseLine | undefined;
  for (const line of lines) {
    if (!lineMatchesGroupKey(line, groupKey)) continue;
    if (!isTop8EligibleAmount(line.amount, { source: line.source, label: line.label })) continue;
    if (!best || prefersExpenseLineForCategory(line, best)) best = line;
  }
  return best;
}

function amountForGroupKey(lines: OperatingExpenseLine[], groupKey: string): number {
  return sumAmountForGroupKey(lines, groupKey);
}

function displayLabelForGroupKey(groupKey: string, fallbackLabel: string): string {
  if (groupKey.startsWith("cat:")) {
    return displayLabelForKey(groupKey.slice(4), fallbackLabel);
  }
  const cleaned = normalizeWhitespace(repairOcrLabel(fallbackLabel));
  if (cleaned.length >= 3 && cleaned.length <= 40 && !/statement\s*\|/i.test(cleaned)) {
    return cleaned;
  }
  return displayLabelForKey(expenseCategoryKey(fallbackLabel) ?? "", fallbackLabel);
}

/**
 * Scan all uploaded years: per year sum every filtered line in each group, add year totals across years, rank top 8.
 */
export function selectSharedTop8ByCrossYearSum(
  linesByYear: Map<number, OperatingExpenseLine[]>,
): SharedTop8 {
  const groups = new Map<string, { label: string; crossYearSum: number; bestLine?: OperatingExpenseLine }>();

  for (const [, lines] of linesByYear.entries()) {
    for (const line of lines) {
      if (!isTop8EligibleAmount(line.amount, { source: line.source, label: line.label })) continue;
      if (isRankPoolStructuralNoise(line)) continue;
      const key = crossYearSumGroupKey(line);
      // Drop amount-only garbage and unlabeled groups. label: re-admission flooded top-8 with
      // OCR caption junk that outranked real cat:/row: SG&A with mega OCR amounts.
      // Known OCR defense until unlabeled expense vocabulary + noise filters are stronger.
      if (key.startsWith("raw:") || key.startsWith("label:")) continue;
      const amt = Math.round(line.amount);
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, {
          label: line.label,
          crossYearSum: amt,
          bestLine: line,
        });
        continue;
      }
      existing.crossYearSum += amt;
      if (!existing.bestLine || prefersExpenseLineForCategory(line, existing.bestLine)) {
        existing.bestLine = line;
        existing.label = line.label;
      }
    }
  }

  // Rank by Σ across years. Only cat:/row:/spot: groups (label:/raw: excluded — see above).
  const ranked = [...groups.entries()]
    .filter(([key]) => !key.startsWith("raw:") && !key.startsWith("label:"))
    .sort((a, b) => b[1].crossYearSum - a[1].crossYearSum)
    .slice(0, 8);

  return {
    labelKeys: ranked.map(([k]) => k),
    labels: ranked.map(([, v]) => v.label),
    maxAmounts: ranked.map(([, v]) => v.crossYearSum),
  };
}

function selectSharedTop8AcrossYears(linesByYear: Map<number, OperatingExpenseLine[]>): SharedTop8 {
  const aggregates = new Map<string, { label: string; maxAmount: number }>();
  for (const lines of linesByYear.values()) {
    for (const line of lines) {
      if (!isTop8EligibleAmount(line.amount, { source: line.source, label: line.label })) continue;
      const key = expenseLabelKey(line.label);
      if (!key) continue;
      const existing = aggregates.get(key);
      if (!existing) {
        aggregates.set(key, { label: line.label, maxAmount: line.amount });
        continue;
      }
      if (line.amount > existing.maxAmount) {
        existing.maxAmount = line.amount;
        existing.label = line.label;
      }
    }
  }

  const ranked = [...aggregates.entries()]
    .sort((a, b) => b[1].maxAmount - a[1].maxAmount)
    .slice(0, 8);

  return {
    labelKeys: ranked.map(([k]) => k),
    labels: ranked.map(([, v]) => v.label),
    maxAmounts: ranked.map(([, v]) => v.maxAmount),
  };
}

/** @deprecated Legacy — max-per-year ranking; rank path uses {@link selectSharedTop8ByCrossYearSum}. */
function amountForLabelKey(lines: OperatingExpenseLine[], labelKey: string): number {
  return amountForGroupKey(lines, labelKey);
}

function countStrongOpexSlots(col: TaxYearValues): number {
  return OPERATING_EXPENSE_SLOT_IDS.filter((id) => {
    const amt = col.values[id];
    const src = col.fieldSources?.[id] ?? "";
    return (
      typeof amt === "number" &&
      isKeepableResidualAmount(amt) &&
      !/top-8|shared top-8|not present this year/i.test(src)
    );
  }).length;
}

/** Keep per-year amounts; only share clean display labels across columns. */
function unifyOpexLabelsOnly(columns: TaxYearValues[]): TaxYearValues[] {
  const labels: Record<string, string> = {};
  for (const id of OPERATING_EXPENSE_SLOT_IDS) {
    for (const col of columns) {
      const user = col.userOpexSlotLabels?.[id];
      if (user) {
        labels[id] = user;
        break;
      }
      const existing = col.opexSlotLabels?.[id];
      if (existing && !/statement\s*\|/i.test(existing) && existing.length <= 40) {
        labels[id] = displayLabelForKey(expenseLabelKey(existing) || id, existing);
        break;
      }
    }
    if (!labels[id]) labels[id] = slotDefaultLabel(id);
  }
  return columns.map((col) => ({
    ...col,
    opexSlotLabels: { ...labels, ...(col.userOpexSlotLabels ?? {}) },
  }));
}

function sumAmounts(lines: OperatingExpenseLine[]): number {
  return Math.round(lines.reduce((s, l) => s + Math.round(l.amount), 0));
}

function sumTop8Amounts(amounts: number[]): number {
  return Math.round(amounts.reduce((s, n) => s + Math.round(n), 0));
}

export function slotDefaultLabel(slotId: string): string {
  return TAX_WORKBOOK_ROWS.find((r) => r.id === slotId)?.label ?? slotId;
}

/**
 * Align operating expenses across uploaded years for integrator paste.
 *
 * Rank path: prepare per-year label+value pools → filter absurd → sum groups across years →
 * shared top-8 by cross-year total → paste each year's amount for those 8 groups (slot i = rank i).
 * other_opex stays stmt residual (stmtTotal − stmt lines in top-8), not reverse-math overwrite.
 */
export function alignOperatingExpensesAcrossYears(columns: TaxYearValues[]): TaxYearValues[] {
  if (columns.length === 0) return columns;

  if (useOpexRankByAmount()) {
    const prepared = columns.map((col) => ({
      ...col,
      operatingExpenseLines: prepareOpexRankPool(col),
    }));

    const linesByYear = new Map<number, OperatingExpenseLine[]>();
    for (const col of prepared) {
      linesByYear.set(col.year, col.operatingExpenseLines ?? []);
    }
    const shared = selectSharedTop8ByCrossYearSum(linesByYear);
    if (!shared.labelKeys.length) return prepared;

    const cleanShared: SharedTop8 = {
      labelKeys: shared.labelKeys,
      labels: shared.labelKeys.map((k, i) => displayLabelForGroupKey(k, shared.labels[i] ?? k)),
      maxAmounts: shared.maxAmounts,
    };

    return prepared.map((col) => {
      const lines = col.operatingExpenseLines ?? [];
      if (!lines.length) return col;
      return applySharedTop8ToColumn(col, cleanShared, lines, { assignByRankOrder: true });
    });
  }

  const perYear = columns.map((col) => {
    const applied = applyOperatingExpensesToSingleYear(col);
    return {
      ...col,
      values: applied.values,
      confidence: applied.confidence ?? col.confidence,
      fieldSources: applied.fieldSources ?? col.fieldSources,
      opexSlotLabels: applied.opexSlotLabels ?? col.opexSlotLabels,
      operatingExpenseLines: applied.operatingExpenseLines ?? col.operatingExpenseLines,
    };
  });

  if (perYear.length === 1) return unifyOpexLabelsOnly(perYear);

  const strongCount = perYear.filter((col) => countStrongOpexSlots(col) >= 4).length;
  // When the parser already filled most years, only share display labels — do not remap amounts.
  if (strongCount >= Math.ceil(perYear.length / 2)) {
    return unifyOpexLabelsOnly(perYear);
  }

  const byYearLines = new Map<number, OperatingExpenseLine[]>();
  for (const col of perYear) {
    const lines = filterPlausibleExpenseLines(
      supplementOperatingExpenseLines(
        col.operatingExpenseLines ?? [],
        col.values,
        col.fieldSources,
      ),
      col.values.sales,
      col.values,
    );
    if (lines.length) byYearLines.set(col.year, lines);
  }
  if (byYearLines.size < 2) return unifyOpexLabelsOnly(perYear);

  const shared = selectSharedTop8AcrossYears(byYearLines);
  if (!shared.labelKeys.length) return unifyOpexLabelsOnly(perYear);

  // Clean display labels (category names, not OCR fragments).
  const cleanShared: SharedTop8 = {
    labelKeys: shared.labelKeys,
    labels: shared.labelKeys.map((k, i) => displayLabelForKey(k, shared.labels[i] ?? k)),
    maxAmounts: shared.maxAmounts,
  };

  const remapped = perYear.map((col) => {
    // Preserve years that already have strong parser slots.
    if (countStrongOpexSlots(col) >= 4) return col;
    const lines = byYearLines.get(col.year);
    if (!lines?.length) return col;
    return applySharedTop8ToColumn(col, cleanShared, lines);
  });
  return unifyOpexLabelsOnly(remapped);
}

/** Shared display labels for the eight operating-expense workbook rows. */
export function sharedOpexSlotLabels(columns: TaxYearValues[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of OPERATING_EXPENSE_SLOT_IDS) {
    for (const col of columns) {
      const user = col.userOpexSlotLabels?.[id];
      if (user) {
        out[id] = user;
        break;
      }
    }
    if (!out[id]) {
      const col = columns.find((c) => c.opexSlotLabels?.[id]);
      out[id] = col?.opexSlotLabels?.[id] ?? slotDefaultLabel(id);
    }
  }
  return out;
}

export function resolveOpexSlotLabel(col: TaxYearValues | undefined, slotId: string): string | undefined {
  return col?.userOpexSlotLabels?.[slotId] ?? col?.opexSlotLabels?.[slotId];
}

export type RankedOpexCandidate = {
  rank: number;
  label: string;
  amount: number;
  source?: string;
  categoryKey?: string;
  labelKey: string;
};

export type RejectedOpexLine = {
  label: string;
  amount: number;
  source?: string;
  reason: string;
};

export type RankOperatingExpenseCandidatesResult = {
  candidates: RankedOpexCandidate[];
  rejected: RejectedOpexLine[];
  /** Top 8 by dollar amount among passing candidates. */
  top8: RankedOpexCandidate[];
  stats: {
    rawLineCount: number;
    dedupedCount: number;
    passedCount: number;
    rejectedCount: number;
  };
};

/** Why a line was dropped from the ranked pool (undefined = would pass filter). */
export function diagnoseExpenseLineRejection(
  line: OperatingExpenseLine,
  sales?: number,
  resolvedValues?: Record<string, number | undefined>,
): string | undefined {
  return diagnoseRankPoolLineRejection(line, sales, resolvedValues);
}

function diagnoseRankPoolLineRejection(
  line: OperatingExpenseLine,
  sales?: number,
  resolvedValues?: Record<string, number | undefined>,
): string | undefined {
  const amount = Math.round(line.amount);
  if (
    isExpenseRankCrumb(amount, {
      source: line.source,
      label: line.label,
    })
  ) {
    return "rank_pool_crumb";
  }
  const opexComparisonRow = /\((officer_compensation|salaries_wages|advertising|rent|taxes_licenses|bank_credit_card|professional_fees|utilities|repairs|employee_benefits|insurance|supplies|gasoline|travel)\s+row\)/i.test(
    line.source ?? "",
  );
  // Amount/anchor collisions are handled by diagnoseIllogicalAmount (label-aware).
  if (diagnoseIllogicalAmount(line, sales, resolvedValues)) return "illogical_amount";
  if (!opexComparisonRow && isNonExpenseAnchorLabel(line.label)) return "non_expense_anchor";
  if (isTaxReturnTitleNoise(line.label)) return "tax_return_title";
  if (isStatementCrossRefNoise(line.label)) return "statement_cross_ref";
  // Expense vocabulary OR known category — not a forced cat: slot. Novel SG&A with
  // expense words (contract labor, software, …) may enter as label: and compete by $.
  if (
    !opexComparisonRow &&
    !expenseCategoryKey(line.label) &&
    !isPlausibleRankPoolLabel(line.label)
  ) {
    return "implausible_label";
  }
  if (isMailingOrFormFooterNoise(line.label)) return "mailing_or_form_footer_noise";
  return undefined;
}

function filterPlausibleRankPoolLines(
  lines: OperatingExpenseLine[],
  sales?: number,
  resolvedValues?: Record<string, number>,
): OperatingExpenseLine[] {
  return lines.filter((line) => {
    if (diagnoseIllogicalAmount(line, sales, resolvedValues)) return false;
    if (isMailingOrFormFooterNoise(line.label)) return false;
    return isPlausibleRankPoolLabel(line.label) && !isEntityNameExpenseNoise(line.label);
  });
}

/**
 * Rank all OCR expense lines by dollar amount for top-8-by-amount paste (see `applyRankByAmountOpex`).
 */
export function rankOperatingExpenseCandidates(
  lines: OperatingExpenseLine[],
  context: {
    sales?: number;
    values?: Record<string, number | undefined>;
  },
  options?: { limit?: number },
): RankOperatingExpenseCandidatesResult {
  const seen = new Set<string>();
  const deduped: OperatingExpenseLine[] = [];
  for (const line of lines) {
    const key = `${expenseLabelKey(line.label)}:${Math.round(line.amount)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(line);
  }

  const candidates: RankedOpexCandidate[] = [];
  const rejected: RejectedOpexLine[] = [];
  for (const line of deduped) {
    const reason = diagnoseExpenseLineRejection(line, context.sales, context.values);
    if (reason) {
      rejected.push({
        label: line.label,
        amount: Math.round(line.amount),
        source: line.source,
        reason,
      });
      continue;
    }
    candidates.push({
      rank: 0,
      label: line.label,
      amount: Math.round(line.amount),
      source: line.source,
      categoryKey: expenseCategoryKey(line.label),
      labelKey: expenseLabelKey(line.label),
    });
  }

  candidates.sort((a, b) => b.amount - a.amount);
  const limit = options?.limit ?? 20;
  const ranked: RankedOpexCandidate[] = [];
  const top8: RankedOpexCandidate[] = [];
  for (const c of candidates) {
    const dup = (arr: RankedOpexCandidate[]) =>
      arr.some((t) => isExactDuplicateAmount(t.amount, c.amount));
    if (dup(ranked) || dup(top8)) continue;
    if (ranked.length < limit) ranked.push({ ...c, rank: ranked.length + 1 });
    if (top8.length < 8) top8.push({ ...c, rank: top8.length + 1 });
    if (ranked.length >= limit && top8.length >= 8) break;
  }

  return {
    candidates: ranked,
    rejected: rejected.sort((a, b) => b.amount - a.amount).slice(0, limit),
    top8,
    stats: {
      rawLineCount: lines.length,
      dedupedCount: deduped.length,
      passedCount: candidates.length,
      rejectedCount: rejected.length,
    },
  };
}

export type OpexSlotDiagnosticRow = {
  slotId: string;
  slotLabel: string;
  actual: number;
  expectedInFixture?: number;
  matched: boolean;
  matchedExpected?: number;
  tolerance?: number;
};

export type OpexMultisetDiagnostic = {
  ok: number;
  n: number;
  pct: number;
  misses: string[];
  slotRows: OpexSlotDiagnosticRow[];
  unmatchedExpected: Array<{ amount: number; tolerance: number; nearestActual?: number; nearestSlot?: string }>;
  surplusActual: Array<{ amount: number; slotId: string; slotLabel: string }>;
};

/**
 * Detailed multiset pairing for benchmark debugging. Uses `resolveExpectedTop8Amounts` so the
 * gate scores the true eight integrator-row amounts (`fixture.top8Amounts`) when present,
 * falling back to whatever `fixture.values[slotId]` entries exist for older fixtures.
 */
export function diagnoseTop8OpexMultiset(
  fixture: FixtureWithTop8,
  actual: Record<string, number | undefined>,
): OpexMultisetDiagnostic {
  const expAmounts = resolveExpectedTop8Amounts(fixture).map((amount) => ({
    amount,
    tolerance: moneyTolerance(amount),
  }));

  const actRows = OPERATING_EXPENSE_SLOT_IDS.map((id) => ({
    slotId: id,
    slotLabel: slotDefaultLabel(id),
    actual: Math.round(actual[id] ?? 0),
    expectedInFixture: fixture.values[id],
  }));

  const used = new Set<number>();
  const slotRows: OpexSlotDiagnosticRow[] = [];
  let ok = 0;

  for (const row of actRows) {
    const pairedIdx = expAmounts.findIndex(
      (e, i) => !used.has(i) && withinMoneyTolerance(row.actual, e.amount),
    );
    if (pairedIdx >= 0) {
      used.add(pairedIdx);
      ok++;
      const exp = expAmounts[pairedIdx]!;
      slotRows.push({
        slotId: row.slotId,
        slotLabel: row.slotLabel,
        actual: row.actual,
        expectedInFixture: row.expectedInFixture,
        matched: true,
        matchedExpected: exp.amount,
        tolerance: moneyTolerance(exp.amount),
      });
    } else {
      slotRows.push({
        slotId: row.slotId,
        slotLabel: row.slotLabel,
        actual: row.actual,
        expectedInFixture: row.expectedInFixture,
        matched: false,
      });
    }
  }

  const unmatchedExpected: OpexMultisetDiagnostic["unmatchedExpected"] = [];
  const misses: string[] = [];
  for (let i = 0; i < expAmounts.length; i++) {
    if (used.has(i)) continue;
    const exp = expAmounts[i]!.amount;
    const tol = moneyTolerance(exp);
    let nearestActual: number | undefined;
    let nearestSlot: string | undefined;
    let bestDiff = Infinity;
    for (const row of actRows) {
      const diff = Math.abs(row.actual - exp);
      if (diff < bestDiff) {
        bestDiff = diff;
        nearestActual = row.actual;
        nearestSlot = row.slotId;
      }
    }
    unmatchedExpected.push({ amount: exp, tolerance: tol, nearestActual, nearestSlot });
    misses.push(
      `opex_amount: exp ${exp} (±${tol}), nearest got ${nearestActual ?? "none"} in slot ${nearestSlot ?? "?"}`,
    );
  }

  const surplusActual = slotRows
    .filter((r) => !r.matched && isKeepableResidualAmount(r.actual))
    .map((r) => ({ amount: r.actual, slotId: r.slotId, slotLabel: r.slotLabel }));

  const n = expAmounts.length;
  return {
    ok,
    n,
    pct: n ? (ok / n) * 100 : 0,
    misses,
    slotRows,
    unmatchedExpected,
    surplusActual,
  };
}

