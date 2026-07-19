import type { ResolvedFields } from "./merge";
import { isFormReferenceNumber, isKeepableWorksheetAmount, isKeepableWorksheetAmountOnLine, isReasonableMoneyAmount, keepableWorksheetMoneyTokens, lineMoneyTokens } from "./money";
import {
  comparisonRowHasBlankCurrentColumn,
  pickComparisonColumnIndex,
  shrinkToYearColumns,
} from "@/lib/two-year-comparison-parser";
import { scanComparisonOtherDeductionsTotal } from "./comparison-opex";
import { extractOtherDeductionsBlockOpex, blockStmtTotalCorroborated, scanStatement2Total, extractStatementTaxesSplit, isComparisonWorksheetContext } from "./statement-extractors";
import { lineMatchesLabelPattern, repairOcrLabel } from "./ocr-label-repair";
import { exactClosureTolerance } from "./structural-tolerance";
import { scanFormPageRent } from "./form-anchors";
import { detectTaxForm } from "./detect-tax-form";

type RowRule = {
  id: string;
  labelRe: RegExp;
};

const COMPARISON_ROW_RULES: RowRule[] = [
  { id: "officer_compensation", labelRe: /OFFICER|COMPENSATION\s+OF\s+OFFICER/i },
  {
    id: "salaries_wages",
    // Match "salaries and wages", "wages and salaries", and G&A payroll captions.
    // Do NOT match bare "employment credits" (tax-credit schedule row).
    labelRe:
      /SALAR.*WAGE|WAGE.*SALAR|SALARIES\s+AND\s+WAGES|GENERAL\s+AND\s+ADMINISTRATIVE.*(?:WAGE|SALAR)|WAGES?\s+LESS\s+EMPLOYMENT\s+CREDITS?/i,
  },
  { id: "utilities", labelRe: /UTILIT|UTILITY|ELECTRIC/i },
  { id: "bank_credit_card", labelRe: /BANK|CREDIT\s+CARD|MERCHANT/i },
  { id: "professional_fees", labelRe: /PROFESSIONAL|LEGAL\s+AND|ACCOUNTING/i },
  { id: "repairs", labelRe: /REPAIR|MAINT/i },
  { id: "insurance", labelRe: /^INSURANCE\b/i },
  { id: "advertising", labelRe: /ADVERT/i },
  { id: "taxes_paid", labelRe: /TAXES\s+PAID|STATE\s+INCOME\s+TAX/i },
  { id: "rent", labelRe: /\bRENTS?\b/i },
  { id: "taxes_licenses", labelRe: /(?:TAXES|AXES)\s+AND\s+LIC/i },
  { id: "employee_benefits", labelRe: /EMPLOYEE\s+BENEFIT/i },
  { id: "gasoline", labelRe: /GASOLINE|\bFUEL\b/i },
  { id: "supplies", labelRe: /JOB\s+SUPPL|MISC\s+OFFICE|OFFICE\s+EXPENSE/i },
  { id: "vehicle_insurance", labelRe: /VEHICLE\s+INSUR/i },
  { id: "other_operating_income", labelRe: /OTHER\s+OPERATING\s+INCOME/i },
  { id: "cogs", labelRe: /COST\s+OF\s+(?:GOODS|SALES)|COGS|\bC\.?\s*O\.?\s*G/i },
  { id: "depreciation", labelRe: /DEPRECIATION/i },
];

const STMT2_UTIL =
  /utilities|utility\s+expense|electric/i;

function findComparisonBlock(allText: string): { text: string; start: number } | undefined {
  const anchor = allText.search(
    /t\w{0,3}\s*y\s*ear\s*\w{0,6}\s*omparison|two\s*year\s*comparison|tax\s+projection\s+worksheet|(?:\bg\s*|ross\s+)receipts?\s+or\s+sales|ross\s+receipts?\s+or\s+sales/i,
  );
  if (anchor < 0) return undefined;
  // Page-2 headers often OCR after the page-1 comparison rows. Include preceding
  // pages so field rows are not replaced by later Form line tags.
  const start = Math.max(0, anchor - 12_000);
  return { text: allText.slice(start, start + 80_000), start };
}

function headerYearsInBlock(block: string): [number, number] | undefined {
  const marker = block.search(
    /t\w{0,3}[\s-]*y\s*ear\s*[^\w\n]{0,3}\w{0,6}\s*omparison|two[\s-]*year[\s-]*comparison/i,
  );
  const windows: string[] = [
    marker >= 0
      ? block.slice(Math.max(0, marker - 800), marker + 800)
      : block.slice(0, 800),
  ];
  for (const w of windows) {
    // Single-year title ("Two-Year Comparison 2023") with Prior/Current column
    // captions — the title year IS the current (right) column. Structural; must win
    // over the loose year-pair fallback, which can pair the title year with unrelated
    // cover-letter years ("… 2024 estimated tax …").
    const titled = w.match(/omparison\s*[^\w\n]{0,3}(20\d{2})\b/i);
    if (titled && /prior\s+year/i.test(w) && /current\s+year/i.test(w)) {
      const current = Number(titled[1]);
      return [current - 1, current];
    }
    const m =
      w.match(/\b(20\d{2})\s*[\&\-–]\s*(20\d{2})\b/) ??
      w.match(/\b(20\d{2})\s+and\s+(20\d{2})\b/i) ??
      w.match(/\b(20\d{2})\b[^\d]{0,40}\b(20\d{2})\b/);
    if (m) return [Number(m[1]), Number(m[2])];
  }
  return undefined;
}

function pickColumn(
  nums: number[],
  targetYear: number,
  years?: [number, number],
  line?: string,
): number | undefined {
  const filtered = nums.filter(isKeepableWorksheetAmount);
  if (!filtered.length) return undefined;
  const col = years ? pickComparisonColumnIndex(years[0], years[1], targetYear) : 1;
  // Blank current-year cell (prior + self-negating change) — no dollars for this year.
  if (col === 1 && line !== undefined && comparisonRowHasBlankCurrentColumn(line)) {
    return undefined;
  }
  const pair = shrinkToYearColumns(filtered);
  if (!pair) return filtered.length >= 2 ? filtered[1] : filtered[0];
  return col === 0 ? pair[0] : pair[1];
}

/** Max utilities amount from Stmt 2 detail block (comparison worksheet often omits utilities). */
function scanStmt2UtilitiesMax(allText: string): number | undefined {
  let inStmt2 = false;
  let best: number | undefined;
  const considerLine = (line: string) => {
    if (!STMT2_UTIL.test(line)) return;
    for (const n of lineMoneyTokens(line)) {
      const abs = Math.round(Math.abs(n));
      // Keepable util dollars only — not a $500 size floor.
      if (
        abs < 1 ||
        !isReasonableMoneyAmount(abs) ||
        isFormReferenceNumber(abs) ||
        (abs >= 1990 && abs <= 2035)
      ) {
        continue;
      }
      if (best === undefined || abs > best) best = abs;
    }
  };
  for (const rawLine of allText.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;
    if (/statement\s*2|stmt\s*2|line\s*(?:19|20)\b.*other\s+deductions|other\s+deduct/i.test(line)) {
      inStmt2 = true;
      best = undefined;
      continue;
    }
    if (/statement\s*[3-9]|stmt\s*[3-9]/i.test(line)) inStmt2 = false;
    if (inStmt2) considerLine(line);
  }
  if (best !== undefined) return best;
  for (const rawLine of allText.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line || !STMT2_UTIL.test(line)) continue;
    if (!/other\s+deduct|federal\s+statements|description\s+amount/i.test(line)) continue;
    considerLine(line);
  }
  return best;
}

/** Max rent amount from Stmt 2 / Federal Statements detail (comparison often double-counts). */
function scanStmt2RentMax(allText: string, formKind?: import("./detect-tax-form").TaxFormKind): number | undefined {
  const formRent = scanFormPageRent(allText, formKind);
  let inStmt2 = false;
  const candidates: number[] = [];
  const considerLine = (line: string) => {
    if (/gross\s+rent|rental\s+real\s+estate|net\s+rental|total\s+inc|gross\s+profit/i.test(line)) return;
    if (!/\brents?\b/i.test(line)) return;
    for (const n of lineMoneyTokens(line)) {
      const abs = Math.round(Math.abs(n));
      if (!isKeepableWorksheetAmountOnLine(abs, line)) continue;
      candidates.push(abs);
    }
  };
  for (const rawLine of allText.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;
    if (/statement\s*2|stmt\s*2|federal\s+statements|line\s*(?:19|20|26)\b.*other\s+deduct/i.test(line)) {
      inStmt2 = true;
      continue;
    }
    if (/statement\s*[3-9]|stmt\s*[3-9]/i.test(line) && !/other\s+deduct/i.test(line)) inStmt2 = false;
    if (inStmt2) considerLine(line);
  }
  if (!candidates.length) {
    for (const rawLine of allText.split(/\n/)) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (!line || !/\brents?\b/i.test(line) || /gross\s+rent/i.test(line)) continue;
      if (!/other\s+deduct|federal\s+statements|description\s+amount/i.test(line)) continue;
      considerLine(line);
    }
  }
  if (formRent !== undefined) {
    const near = candidates.find((c) => Math.round(c) === Math.round(formRent));
    if (near !== undefined) return near;
    return formRent;
  }
  if (!candidates.length) return undefined;
  candidates.sort((a, b) => a - b);
  return candidates[Math.floor(candidates.length / 2)];
}

/** Refill attachment / P&L lines from labeled two-year comparison rows. */
export function refillFromComparisonLabeledRows(
  allText: string,
  resolved: ResolvedFields,
  targetYear?: number,
): void {
  const blockInfo = findComparisonBlock(allText);
  if (targetYear === undefined) return;
  const block = blockInfo?.text;
  const years = block ? headerYearsInBlock(block) : undefined;

  const stmt2Util = scanStmt2UtilitiesMax(allText);
  if (stmt2Util !== undefined) {
    const cur = resolved.values.utilities;
    const src = resolved.sources.utilities ?? "";
    const weak = !src || /OCR label|fuzzy|label match|embedded detail|tail scan/i.test(src);
    // Stmt util fills missing/weak only (max-line scan can over-pick).
    if (cur === undefined || weak) {
      resolved.values.utilities = stmt2Util;
      resolved.confidence.utilities = 93;
      resolved.sources.utilities = "Statement 2 (utilities detail max)";
    }
  }

  const stmt2Rent = scanStmt2RentMax(allText, detectTaxForm(allText).kind);
  const formRent = scanFormPageRent(allText);
  const authoritativeRent = formRent ?? stmt2Rent;
  if (authoritativeRent !== undefined) {
    const cur = resolved.values.rent;
    // Form/Stmt rent dollars win whenever current disagrees — replaces soft % overwrite.
    if (
      cur === undefined ||
      Math.round(Math.abs(cur)) !== Math.round(Math.abs(authoritativeRent))
    ) {
      resolved.values.rent = authoritativeRent;
      resolved.confidence.rent = formRent !== undefined ? 96 : 93;
      resolved.sources.rent =
        formRent !== undefined ? "Form page 1 (rents line)" : "Statement 2 (rent detail max)";
    }
  }

  if (!block) return;

  let labelPrefix = "";
  for (const rawLine of block.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;
    // OCR often wraps "SALARIES AND WAGES LESS" onto the next "EMPLOYMENT CREDITS … amounts" line.
    if (!/\d/.test(line)) {
      // Only carry expense-row captions — bare "officer" matches Form 8879 signature boilerplate.
      if (
        /salar.*wage|wage.*salar|compensation\s+of\s+officer|employee\s+benefit|pension|profit-?shar|wages?\s+less\s+employment/i.test(
          line,
        )
      ) {
        labelPrefix = line;
      }
      continue;
    }
    // Do not bleed a prior label onto a money line that already has its own caption
    // (e.g. "Salaries…" header + "Repairs… 4212" must not book 4212 as salaries).
    // Also block rollup / P&L footer rows ("Total business deductions 596,314") — a blank
    // prior expense caption must not inherit those dollars.
    const lineHasOwnCaption =
      COMPARISON_ROW_RULES.some(
        (r) => r.labelRe.test(line) || r.labelRe.test(repairOcrLabel(line)),
      ) ||
      /^(?:total|net|gross|other\s+deduct|cost\s+of)\b/i.test(line) ||
      /total\s+business\s+(?:income|deductions)\b/i.test(line);
    const continuationNums = keepableWorksheetMoneyTokens(line);
    const isColumnContinuation =
      !/[a-z]{3,}/i.test(line) ||
      (/employment\s+credits/i.test(line) && continuationNums.length >= 2) ||
      (/[|[\]~]/.test(line) && continuationNums.length >= 2);
    const matchLine =
      labelPrefix && !lineHasOwnCaption && isColumnContinuation
        ? `${labelPrefix} ${line}`
        : line;
    labelPrefix = "";
    const lineIdx = allText.indexOf(rawLine);
    const recentContext =
      lineIdx >= 0
        ? allText.slice(Math.max(0, lineIdx - 800), lineIdx + rawLine.length).replace(/\s+/g, " ")
        : matchLine;
    if (isCogsOtherCostsContext(recentContext, matchLine)) continue;

    for (const rule of COMPARISON_ROW_RULES) {
      const labelLine = repairOcrLabel(matchLine);
      if (!lineMatchesLabelPattern(matchLine, rule.labelRe) && !rule.labelRe.test(labelLine)) continue;
      const nums = keepableWorksheetMoneyTokens(line);
      const picked = pickColumn(nums, targetYear, years, line);
      if (picked === undefined) continue;

      const cur = resolved.values[rule.id];
      const src = resolved.sources[rule.id] ?? "";
      // Keep Stmt/Form utilities/rent when comparison disagrees on dollars.
      if (
        rule.id === "utilities" &&
        cur !== undefined &&
        /statement\s*2/i.test(src) &&
        Math.round(Math.abs(cur)) !== Math.round(Math.abs(picked))
      ) {
        continue;
      }
      if (
        rule.id === "utilities" &&
        stmt2Util !== undefined &&
        Math.round(Math.abs(picked)) !== Math.round(Math.abs(stmt2Util))
      ) {
        continue;
      }
      if (
        rule.id === "rent" &&
        cur !== undefined &&
        /statement\s*2|federal\s+statements|form\s+1120/i.test(src) &&
        Math.round(Math.abs(picked)) !== Math.round(Math.abs(cur))
      ) {
        continue;
      }
      const weak = !src || /OCR label|fuzzy|label match|embedded detail|tail scan/i.test(src);
      // Replace only missing/weak, or structural Form salaries caption — no relative %/$ bands.
      const replace =
        cur === undefined ||
        weak ||
        (rule.id === "salaries_wages" &&
          cur !== undefined &&
          /wages?\s+less\s+employment|salaries\s+and\s+wages\s+less/i.test(matchLine));

      if (!replace) continue;
      // Expense rows are absolute dollars — variance/change columns are signed OCR noise.
      resolved.values[rule.id] = Math.round(Math.abs(picked));
      resolved.confidence[rule.id] = 90;
      resolved.sources[rule.id] = `Two-year comparison (${rule.id} row)`;
    }
  }

  const compTaxes = resolved.values.taxes_licenses;
  let paid = resolved.values.taxes_paid;
  if (paid === undefined || paid <= 0) {
    paid = extractStatementTaxesSplit(allText).values.taxes_paid;
  }
  const compBlock = findComparisonBlock(allText);
  if ((paid === undefined || paid <= 0) && compBlock) {
    for (const rawLine of compBlock.text.split(/\n/)) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (!/TAXES\s+PAID|STATE\s+INCOME\s+TAX/i.test(line)) continue;
      const nums = keepableWorksheetMoneyTokens(line);
      const picked = pickColumn(nums, targetYear, years, line);
      if (picked !== undefined && picked > 0) {
        paid = Math.round(picked);
        break;
      }
    }
  }
  // Identity split when comparison taxes row embeds taxes paid (no size/% gates).
  // Only when taxes_licenses itself came from the comparison worksheet — never shrink
  // Form page-1 line 17 SG&A taxes by Form line 31 income-tax liability (different lines).
  const taxSrc = resolved.sources.taxes_licenses ?? "";
  const paidSrc = resolved.sources.taxes_paid ?? "";
  const taxesFromComparison = /two[\s.-]?year\s+comparison|taxes\s+minus\s+taxes\s+paid/i.test(taxSrc);
  const paidIsFormIncomeTaxLiability = /form\s*1120[-\s]?[sb]?\s*line\s*31|total\s+tax/i.test(paidSrc);
  if (
    taxesFromComparison &&
    !paidIsFormIncomeTaxLiability &&
    compTaxes !== undefined &&
    paid !== undefined &&
    paid > 0 &&
    paid < compTaxes
  ) {
    const split = Math.round(compTaxes - paid);
    if (split >= 1) {
      resolved.values.taxes_licenses = split;
      resolved.confidence.taxes_licenses = 91;
      resolved.sources.taxes_licenses = "Two-year comparison (taxes minus taxes paid)";
    }
  }

  const stmt2Total = scanComparisonOtherDeductionsTotal(allText, targetYear);
  const blockOpex = extractOtherDeductionsBlockOpex(allText);

  const cur = resolved.values.other_operating_expenses;
  const curSource = resolved.sources.other_operating_expenses ?? "";
  const curIsOfficeDetail = /office\/supplies|telephone\/travel\/bank detail/i.test(curSource);

  const blockOfficeDetail =
    blockOpex.opex !== undefined &&
    blockOpex.stmtTotal !== undefined &&
    /office\/supplies|telephone\/travel\/bank detail/i.test(blockOpex.source) &&
    blockStmtTotalCorroborated(blockOpex.stmtTotal, [
      stmt2Total,
      scanStatement2Total(allText),
      scanComparisonOtherDeductionsTotal(allText, targetYear),
    ])
      ? blockOpex
      : undefined;

  if (blockOfficeDetail && !curIsOfficeDetail) {
    const blockExcluded = blockOfficeDetail.stmtTotal! - blockOfficeDetail.opex!;
    const blockCloses =
      Math.abs(blockExcluded + blockOfficeDetail.opex! - blockOfficeDetail.stmtTotal!) <=
      exactClosureTolerance(blockOfficeDetail.stmtTotal!);
    // Inventory overlay only when missing — never overwrite via soft % disagreement.
    if (blockCloses && cur === undefined) {
      resolved.values.other_operating_expenses = blockOfficeDetail.opex!;
      resolved.confidence.other_operating_expenses = blockOfficeDetail.confidence;
      resolved.sources.other_operating_expenses = blockOfficeDetail.source;
    }
  }
  // other_operating_expenses comparison residual left to reconcileOtherOperatingExpenses ranking.
}

const COMPARISON_LEDGER_LABELS: Record<string, string> = {
  officer_compensation: "Officer compensation",
  salaries_wages: "Salaries and wages",
  repairs: "Repairs and maintenance",
  insurance: "Insurance",
  utilities: "Utilities",
  bank_credit_card: "Bank and credit card",
  professional_fees: "Professional fees",
  employee_benefits: "Employee benefit programs",
  gasoline: "Gasoline",
  supplies: "Misc office expense",
  vehicle_insurance: "Vehicle insurance",
  advertising: "Advertising",
  rent: "Rent",
  taxes_licenses: "Taxes and Licenses",
};

const COMPARISON_LEDGER_IDS = new Set(Object.keys(COMPARISON_LEDGER_LABELS));

/** Comparison-worksheet expense rows for top-8 ledger (repairs, insurance, utilities, etc.). */
export function extractComparisonExpenseLines(
  allText: string,
  targetYear: number,
): Array<{ label: string; amount: number; source: string }> {
  const blockInfo = findComparisonBlock(allText);
  if (!blockInfo) return [];
  const years = headerYearsInBlock(blockInfo.text);
  const out: Array<{ label: string; amount: number; source: string }> = [];
  const rawLines = blockInfo.text.split(/\n/);

  let blockCtx = "";
  for (let i = 0; i < rawLines.length; i++) {
    let line = rawLines[i]!.replace(/\s+/g, " ").trim();
    if (!line) continue;
    blockCtx = `${blockCtx} ${line}`.slice(-800);
    if (!/\d/.test(line) && i + 1 < rawLines.length) {
      const next = rawLines[i + 1]!.replace(/\s+/g, " ").trim();
      // Never glue a blank expense caption onto the next rollup/total row.
      if (
        /\d/.test(next) &&
        !/^(?:total|net|gross|other\s+deduct|cost\s+of)\b/i.test(next) &&
        !/total\s+business\s+(?:income|deductions)\b/i.test(next) &&
        /salar|wage|officer|repair|insur|advert|rent|tax|utilit|bank|profession|benefit|supply/i.test(
          `${line} ${next}`,
        )
      ) {
        line = `${line} ${next}`;
        i += 1;
        blockCtx = `${blockCtx} ${next}`.slice(-800);
      }
    }
    if (!/\d/.test(line)) continue;
    if (isCogsOtherCostsContext(blockCtx, line)) continue;
    pushComparisonLine(line, years, targetYear, out);
  }

  // Fallback: comparison rows OCR'd outside the primary block window.
  for (const rawLine of allText.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line || !/\d/.test(line)) continue;
    const lineIdx = allText.indexOf(rawLine);
    const recentContext =
      lineIdx >= 0
        ? allText.slice(Math.max(0, lineIdx - 1200), lineIdx + rawLine.length).replace(/\s+/g, " ")
        : "";
    if (isCogsOtherCostsContext(recentContext, line)) continue;
    if (!isComparisonExpenseRowContext(recentContext)) continue;
    pushComparisonLine(line, years, targetYear, out);
  }

  return dedupeComparisonLines(out);
}

/**
 * Permissive comparison-worksheet pass: every row with an OCR text label + dollar amount.
 * Use this to see all candidate top-8 lines before category rules filter them.
 */
export function extractAllComparisonLabelValueLines(
  allText: string,
  targetYear: number,
): Array<{ label: string; amount: number; source: string }> {
  const blockInfo = findComparisonBlock(allText);
  if (!blockInfo) return [];
  const years = headerYearsInBlock(blockInfo.text);
  const out: Array<{ label: string; amount: number; source: string }> = [];

  const pushRawRow = (line: string, ctx = "") => {
    if (!/\d/.test(line)) return;
    if (isCogsOtherCostsContext(ctx, line)) return;
    if (/^(total|gross receipts|ordinary business|taxable income|net income)\b/i.test(line)) return;
    if (/total\s+business\s+(?:income|deductions)\b/i.test(line)) return;
    if (/SECTION\s+199A|SCHEDULE\s+K\b|DISTRIBUTIONS/i.test(line)) return;
    const nums = keepableWorksheetMoneyTokens(line);
    if (!nums.length) return;
    const picked = pickColumn(nums, targetYear, years, line);
    if (picked === undefined) return;
    const rounded = Math.round(Math.abs(picked));
    if (!isKeepableWorksheetAmount(rounded)) return;
    const label = labelFromComparisonOcrLine(line, "");
    if (!label || label.length < 2 || !/[a-z]{2,}/i.test(label)) return;
    out.push({
      label,
      amount: rounded,
      source: "Two-year comparison (raw row)",
    });
  };

  const rawLines = blockInfo.text.split(/\n/);
  let rawCtx = "";
  for (let i = 0; i < rawLines.length; i++) {
    let line = rawLines[i]!.replace(/\s+/g, " ").trim();
    if (!line) continue;
    rawCtx = `${rawCtx} ${line}`.slice(-800);
    if (!/\d/.test(line) && i + 1 < rawLines.length) {
      const next = rawLines[i + 1]!.replace(/\s+/g, " ").trim();
      if (
        /\d/.test(next) &&
        /[a-z]{3,}/i.test(line) &&
        !/^(?:total|net|gross|other\s+deduct|cost\s+of)\b/i.test(next) &&
        !/total\s+business\s+(?:income|deductions)\b/i.test(next)
      ) {
        line = `${line} ${next}`;
        i += 1;
        rawCtx = `${rawCtx} ${next}`.slice(-800);
      }
    }
    pushRawRow(line, rawCtx);
  }

  for (const rawLine of allText.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;
    const lineIdx = allText.indexOf(rawLine);
    const recentContext =
      lineIdx >= 0
        ? allText.slice(Math.max(0, lineIdx - 1200), lineIdx + rawLine.length).replace(/\s+/g, " ")
        : "";
    if (!isComparisonExpenseRowContext(recentContext)) continue;
    pushRawRow(line, recentContext);
  }

  const seen = new Set<string>();
  const deduped: Array<{ label: string; amount: number; source: string }> = [];
  for (const row of out.sort((a, b) => b.amount - a.amount)) {
    const key = `${row.label.toLowerCase()}:${row.amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

/** Deduction-schedule rows inside comparison worksheets (bracket/pipe columns, any OCR label). */
export function extractComparisonDeductionScheduleLines(
  allText: string,
  targetYear: number,
): Array<{ label: string; amount: number; source: string }> {
  const blockInfo = findComparisonBlock(allText);
  const years = blockInfo
    ? headerYearsInBlock(blockInfo.text)
    : undefined;
  const out: Array<{ label: string; amount: number; source: string }> = [];

  for (const rawLine of allText.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line || !/\d/.test(line) || !/[a-z]{3,}/i.test(line)) continue;
    const lineIdx = allText.indexOf(rawLine);
    const recentContext =
      lineIdx >= 0
        ? allText.slice(Math.max(0, lineIdx - 1200), lineIdx + rawLine.length).replace(/\s+/g, " ")
        : "";
    if (!isComparisonWorksheetContext(recentContext) && !/\[\s*\d{1,3}(?:,\d{3})+/.test(line)) {
      continue;
    }
    const nums = keepableWorksheetMoneyTokens(line);
    if (!nums.length) continue;
    const picked = pickColumn(nums, targetYear, years, line);
    if (picked === undefined) continue;
    const rounded = Math.round(Math.abs(picked));
    if (!isKeepableWorksheetAmount(rounded)) continue;
    const label = labelFromComparisonOcrLine(line, "");
    if (!label || label.length < 3) continue;
    if (/^(total|gross receipts|taxable income|net income|other income|total deductions)\b/i.test(label)) {
      continue;
    }
    out.push({
      label,
      amount: rounded,
      source: "Comparison deduction schedule",
    });
  }

  const seen = new Set<string>();
  const deduped: Array<{ label: string; amount: number; source: string }> = [];
  for (const row of out.sort((a, b) => b.amount - a.amount)) {
    const key = `${row.label.toLowerCase()}:${row.amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

function isComparisonExpenseRowContext(ctx: string): boolean {
  return (
    isComparisonWorksheetContext(ctx) ||
    /prior\s+year\s+current\s+year|gross\s+receipts|deductions\s*:/i.test(ctx)
  );
}

/** Form 1125-A / line-5 Other costs schedules — COGS, not SG&A comparison rows. */
function isCogsOtherCostsContext(ctx: string, line = ""): boolean {
  const t = `${ctx} ${line}`;
  // Require Form 1125-A or an explicit Other-costs statement header — not the bare phrase alone
  // (comparison worksheets sometimes mention "other costs" in narrative).
  return /form\s*1125-?a\b|other\s+costs?\s+statement|total\s+to\s+line\s*5\b/i.test(t);
}

function labelFromComparisonOcrLine(line: string, fallback: string): string {
  const t = repairOcrLabel(line)
    .replace(/[\d,.$()[\]-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^axes and licen/i, "taxes and licen");
  if (t.length >= 3 && t.length <= 60 && /[a-z]/i.test(t)) return t;
  return fallback;
}

function pushComparisonLine(
  line: string,
  years: [number, number] | undefined,
  targetYear: number,
  out: Array<{ label: string; amount: number; source: string }>,
): void {
  for (const rule of COMPARISON_ROW_RULES) {
    if (!COMPARISON_LEDGER_IDS.has(rule.id)) continue;
    const labelLine = repairOcrLabel(line);
    if (!lineMatchesLabelPattern(line, rule.labelRe) && !rule.labelRe.test(labelLine)) continue;
    const nums = keepableWorksheetMoneyTokens(line);
    const picked = pickColumn(nums, targetYear, years, line);
    if (picked === undefined) continue;
    out.push({
      label: labelFromComparisonOcrLine(line, COMPARISON_LEDGER_LABELS[rule.id] ?? rule.id),
      amount: Math.round(Math.abs(picked)),
      source: `Two-year comparison (${rule.id} row)`,
    });
    break;
  }
}

function dedupeComparisonLines(
  lines: Array<{ label: string; amount: number; source: string }>,
): Array<{ label: string; amount: number; source: string }> {
  const byLabel = new Map<string, { label: string; amount: number; source: string }>();
  for (const line of lines) {
    const prev = byLabel.get(line.label);
    if (!prev || line.amount > prev.amount) byLabel.set(line.label, line);
  }
  return [...byLabel.values()];
}
