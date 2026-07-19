import type { FieldTrustTier } from "@/lib/tax/field-trust-tier";
import { computeWorkbookFormulas } from "@/lib/tax/workbook-formulas";
import type { OcrCoverageDiagnostics } from "@/lib/tax-return/ocr-coverage-diagnostics";

export type TaxWorkbookRow = {
  row: number;
  id: string;
  label: string;
  section: "Income Statement Data" | "Balance Sheet Data";
  excelBehavior: "input" | "formula";
};

export type FieldReviewStatus = "verified" | "review" | "missing";

/** Per-field review state captured after initial parse — restored when user unchecks verify. */
export type ParserReviewSnapshot = {
  values: Record<string, number>;
  fieldSources?: Record<string, string>;
  fieldFlags?: Record<string, string[]>;
  fieldStatus?: Record<string, FieldReviewStatus>;
  displayConfidence?: Record<string, number>;
  fieldTrustTier?: Record<string, FieldTrustTier>;
};

export type TaxYearValues = {
  year: number;
  values: Record<string, number>;
  /** Detected taxpayer — prevents merging unrelated companies by year. */
  clientName?: string;
  clientKey?: string;
  confidence?: Record<string, number>;
  /** Where each value was extracted (e.g. "Form 1120-S line 7", "Statement 2"). */
  fieldSources?: Record<string, string>;
  /** UI-safe confidence — capped unless multiple sources agree. */
  displayConfidence?: Record<string, number>;
  /** Independent source families agreeing with the final value. */
  sourceAgreement?: Record<string, number>;
  /** Human-review reasons (reconciliation failures, single source, etc.). */
  fieldFlags?: Record<string, string[]>;
  fieldStatus?: Record<string, FieldReviewStatus>;
  /** Visual trust tier for table coloring. */
  fieldTrustTier?: Record<string, FieldTrustTier>;
  /** Other source reads when independent extractions disagreed (chosen value is highest confidence). */
  fieldAlternates?: Record<string, Array<{ family: string; value: number; confidence?: number; sourceLabel?: string }>>;
  /** Parser output before any user edits — used for ML training. */
  parserBaseline?: Record<string, number>;
  /** Fields the user corrected in the UI — protected from re-upload overwrite. */
  userEditedFields?: Record<string, boolean>;
  /** Ranked extraction options shown in the edit picker (OPEX candidates + alternates). */
  fieldCandidateOptions?: Record<
    string,
    Array<{
      value: number;
      source: string;
      kind?: "alternate" | "opex" | "manual";
      confidence?: number;
      closureScore?: number;
      totalScore?: number;
      valid?: boolean;
    }>
  >;
  /** Parser field sources before user verification toggles — used to restore on uncheck. */
  parserFieldSources?: Record<string, string>;
  /** Explicit user verification checkboxes (separate from edits). */
  userVerifiedFields?: Record<string, boolean>;
  /** User overrides for the eight operating-expense row titles (shared across years). */
  userOpexSlotLabels?: Record<string, string>;
  /** Workbook layout values after opex alignment (may differ from raw parser values). */
  workbookValues?: Record<string, number>;
  /** User overrides on auto-calculated (formula) rows — display only until inputs reconcile. */
  formulaOverrides?: Record<string, number>;
  /** Formula totals computed from parser inputs at upload — for extraction mismatch hints. */
  parserFormulaBaseline?: Record<string, number>;
  /** Post-parse review metadata — restored when user unchecks verify on a field. */
  parserReviewSnapshot?: ParserReviewSnapshot;
  /** When a two-year comparison block includes the prior tax year, values from that column. */
  comparisonPriorYear?: number;
  comparisonPriorValues?: Record<string, number>;
  /** PDF-derived operating expense detail lines (for cross-year shared top-8 selection). */
  operatingExpenseLines?: Array<{ label: string; amount: number; source?: string }>;
  /** Stmt / comparison "Other deductions" total anchor for top-8 + other_opex partition. */
  stmtOtherDeductionsTotal?: number;
  /**
   * Form page-1 anchors scanned at parse time — used to re-flag P&L closure after
   * multi-year opex alignment (OCR text is not available at merge).
   */
  formOrdinaryBusinessIncome?: number;
  formGrossProfit?: number;
  /** Display labels for the eight operating expense rows after shared top-8 alignment. */
  opexSlotLabels?: Record<string, string>;
  /** OCR coverage / missing-block diagnostics (debug + confidence tooling). */
  ocrCoverage?: OcrCoverageDiagnostics;
  warnings?: string[];
  source: string;
};

export const TAX_YEARS = [2023, 2024, 2025] as const;

export const TAX_WORKBOOK_ROWS: TaxWorkbookRow[] = [
  { row: 5, id: "sales", label: "Sales (Income)", section: "Income Statement Data", excelBehavior: "input" },
  { row: 6, id: "cogs", label: "Cost of Sales (COGS)", section: "Income Statement Data", excelBehavior: "input" },
  { row: 7, id: "gross_profit", label: "Gross Profit", section: "Income Statement Data", excelBehavior: "formula" },
  { row: 8, id: "depreciation", label: "Depreciation", section: "Income Statement Data", excelBehavior: "input" },
  { row: 9, id: "amortization", label: "Amortization", section: "Income Statement Data", excelBehavior: "input" },
  {
    row: 10,
    id: "depreciation_amortization",
    label: "Depreciation and Amortization",
    section: "Income Statement Data",
    excelBehavior: "formula",
  },
  { row: 11, id: "officer_compensation", label: "Officer compensation", section: "Income Statement Data", excelBehavior: "input" },
  { row: 12, id: "salaries_wages", label: "Salaries and wages", section: "Income Statement Data", excelBehavior: "input" },
  { row: 13, id: "advertising", label: "Advertising", section: "Income Statement Data", excelBehavior: "input" },
  { row: 14, id: "rent", label: "Rent", section: "Income Statement Data", excelBehavior: "input" },
  { row: 15, id: "taxes_licenses", label: "Taxes and Licenses", section: "Income Statement Data", excelBehavior: "input" },
  { row: 16, id: "bank_credit_card", label: "Bank and credit card", section: "Income Statement Data", excelBehavior: "input" },
  { row: 17, id: "professional_fees", label: "Professional fees", section: "Income Statement Data", excelBehavior: "input" },
  { row: 18, id: "utilities", label: "Utilities", section: "Income Statement Data", excelBehavior: "input" },
  {
    row: 19,
    id: "overhead_sga",
    label: "Overhead or S,G,&A Expense",
    section: "Income Statement Data",
    excelBehavior: "formula",
  },
  { row: 20, id: "other_operating_income", label: "Other Operating Income", section: "Income Statement Data", excelBehavior: "input" },
  { row: 21, id: "other_operating_expenses", label: "Other Operating Expenses", section: "Income Statement Data", excelBehavior: "input" },
  { row: 22, id: "operating_profit", label: "Operating Profit", section: "Income Statement Data", excelBehavior: "formula" },
  { row: 23, id: "interest_expense", label: "Interest Expense", section: "Income Statement Data", excelBehavior: "input" },
  { row: 24, id: "other_income", label: "Other Income", section: "Income Statement Data", excelBehavior: "input" },
  { row: 25, id: "other_expenses", label: "Other Expenses", section: "Income Statement Data", excelBehavior: "input" },
  { row: 26, id: "net_profit_before_taxes", label: "Net Profit Before Taxes", section: "Income Statement Data", excelBehavior: "formula" },
  {
    row: 27,
    id: "adjusted_owner_compensation",
    label: "Adjusted Owner's Compensation",
    section: "Income Statement Data",
    excelBehavior: "input",
  },
  {
    row: 28,
    id: "adjusted_net_profit_before_taxes",
    label: "Adjusted Net Profit before Taxes",
    section: "Income Statement Data",
    excelBehavior: "formula",
  },
  { row: 29, id: "taxes_paid", label: "Taxes Paid", section: "Income Statement Data", excelBehavior: "input" },
  { row: 30, id: "extraordinary_gain", label: "Extraordinary Gain", section: "Income Statement Data", excelBehavior: "input" },
  { row: 31, id: "extraordinary_loss", label: "Extraordinary Loss", section: "Income Statement Data", excelBehavior: "input" },
  { row: 32, id: "net_income", label: "Net Income", section: "Income Statement Data", excelBehavior: "formula" },
  { row: 36, id: "cash", label: "Cash (Bank Funds)", section: "Balance Sheet Data", excelBehavior: "input" },
  { row: 37, id: "accounts_receivable", label: "Accounts Receivable", section: "Balance Sheet Data", excelBehavior: "input" },
  { row: 38, id: "inventory", label: "Inventory", section: "Balance Sheet Data", excelBehavior: "input" },
  { row: 39, id: "other_current_assets", label: "Other Current Assets", section: "Balance Sheet Data", excelBehavior: "input" },
  { row: 40, id: "total_current_assets", label: "Total Current Assets", section: "Balance Sheet Data", excelBehavior: "formula" },
  { row: 41, id: "gross_fixed_assets", label: "Gross Fixed Assets", section: "Balance Sheet Data", excelBehavior: "input" },
  { row: 42, id: "accumulated_depreciation", label: "Accumulated Depreciation", section: "Balance Sheet Data", excelBehavior: "input" },
  { row: 43, id: "net_fixed_assets", label: "Net Fixed Assets", section: "Balance Sheet Data", excelBehavior: "formula" },
  { row: 44, id: "gross_intangible_assets", label: "Gross Intangible Assets", section: "Balance Sheet Data", excelBehavior: "input" },
  { row: 45, id: "accumulated_amortization", label: "Accumulated Amortization", section: "Balance Sheet Data", excelBehavior: "input" },
  { row: 46, id: "net_intangible_assets", label: "Net Intangible Assets", section: "Balance Sheet Data", excelBehavior: "formula" },
  { row: 47, id: "other_assets", label: "Other Assets", section: "Balance Sheet Data", excelBehavior: "input" },
  { row: 48, id: "total_assets", label: "Total Assets", section: "Balance Sheet Data", excelBehavior: "formula" },
  { row: 49, id: "accounts_payable", label: "Accounts Payable", section: "Balance Sheet Data", excelBehavior: "input" },
  { row: 50, id: "short_term_debt", label: "Short Term Debt", section: "Balance Sheet Data", excelBehavior: "input" },
  {
    row: 51,
    id: "current_portion_ltd",
    label: "Notes Payable/ Current portion of Long Term Debt",
    section: "Balance Sheet Data",
    excelBehavior: "input",
  },
  { row: 52, id: "other_current_liabilities", label: "Other Current Liabilities", section: "Balance Sheet Data", excelBehavior: "input" },
  { row: 53, id: "total_current_liabilities", label: "Total Current Liabilities", section: "Balance Sheet Data", excelBehavior: "formula" },
  { row: 54, id: "notes_minus_short_term", label: "Notes minus short-term", section: "Balance Sheet Data", excelBehavior: "input" },
  { row: 55, id: "subordinated", label: "subordinated", section: "Balance Sheet Data", excelBehavior: "input" },
  { row: 56, id: "other_long_term_liabilities", label: "Other Long Term Liabilities", section: "Balance Sheet Data", excelBehavior: "input" },
  { row: 57, id: "long_term_liabilities", label: "Long Term Liabilities", section: "Balance Sheet Data", excelBehavior: "formula" },
  { row: 58, id: "total_liabilities", label: "Total Liabilities", section: "Balance Sheet Data", excelBehavior: "formula" },
  { row: 59, id: "preferred_stock", label: "Preferred Stock", section: "Balance Sheet Data", excelBehavior: "input" },
  { row: 60, id: "common_stock", label: "Common Stock", section: "Balance Sheet Data", excelBehavior: "input" },
  { row: 61, id: "additional_paid_in_capital", label: "Additional Paid-in Capital", section: "Balance Sheet Data", excelBehavior: "input" },
  { row: 62, id: "other_stock_equity", label: "Other Stock/ Equity", section: "Balance Sheet Data", excelBehavior: "input" },
  { row: 63, id: "unclassified_equity", label: "unclassified equity", section: "Balance Sheet Data", excelBehavior: "input" },
  { row: 64, id: "total_equity", label: "Total Equity", section: "Balance Sheet Data", excelBehavior: "formula" },
  { row: 65, id: "total_liabilities_equity", label: "Total Liabilities + Equity", section: "Balance Sheet Data", excelBehavior: "formula" },
];

export function formatExcelNumber(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return Math.round(value).toFixed(2);
}

/** Table display — whole dollars with grouping. */
export function formatTableNumber(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return Math.round(value).toLocaleString();
}

export type WorkbookSection = "Income Statement Data" | "Balance Sheet Data";

export type PasteTsvOptions = {
  includeLabels?: boolean;
  /** First TSV row: blank label cell + year column headers (integrator paste). */
  includeYearHeaders?: boolean;
  confirmedOnly?: boolean;
  section?: WorkbookSection;
  /** When true, fill formula rows with computed values (instead of blank). */
  includeFormulas?: boolean;
  /** One Excel column per row (latest year). Default true in UI when only one year. */
  singleColumn?: boolean;
  /** Oldest → newest by default; true = newest first (integrator tab column order). */
  reverseYears?: boolean;
  /** Shared dynamic titles for the eight SG&A rows (multi-year align). */
  dynamicOpexLabels?: Record<string, string>;
  /** Fixed 2023 / 2024 / 2025 columns for full workbook alignment. */
  workbookLayout?: boolean;
  /** Insert blank TSV lines for gaps in Excel row numbers (e.g. rows 33–35 between I/S and B/S). */
  padExcelRows?: boolean;
};

const OPEX_SLOT_IDS_FOR_PASTE = [
  "officer_compensation",
  "salaries_wages",
  "advertising",
  "rent",
  "taxes_licenses",
  "bank_credit_card",
  "professional_fees",
  "utilities",
] as const;

function isUserVerifiedField(col: TaxYearValues, fieldId: string): boolean {
  return col.userVerifiedFields?.[fieldId] === true;
}

function pasteRowLabel(
  row: (typeof TAX_WORKBOOK_ROWS)[number],
  dynamicOpexLabels?: Record<string, string>,
): string {
  if (
    dynamicOpexLabels &&
    OPEX_SLOT_IDS_FOR_PASTE.includes(row.id as (typeof OPEX_SLOT_IDS_FOR_PASTE)[number])
  ) {
    return dynamicOpexLabels[row.id] ?? row.label;
  }
  return row.label;
}

function pasteYearColumns(columns: TaxYearValues[], options?: PasteTsvOptions): number[] {
  const present = [...columns].map((c) => c.year).sort((a, b) => a - b);
  if (!present.length) return [];
  if (options?.workbookLayout) {
    return [...TAX_YEARS];
  }
  if (options?.singleColumn !== false) {
    return [present[present.length - 1]!];
  }
  if (options?.reverseYears) return present.reverse();
  return present;
}

/** Paste buffer — missing input cells use 0.00 in full copy. */
export function formatExcelPasteNumber(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0.00";
  return Math.round(value).toFixed(2);
}

const PASTE_ZERO = "0.00";

export function buildPasteTsv(
  columns: TaxYearValues[],
  options?: PasteTsvOptions,
): string {
  const includeLabels = options?.includeLabels ?? false;
  const confirmedOnly = options?.confirmedOnly ?? false;
  const includeFormulas = options?.includeFormulas ?? true;
  const singleColumn = options?.singleColumn !== false;
  const padExcelRows = options?.padExcelRows ?? false;
  const byYear = new Map(columns.map((col) => [col.year, col]));
  const years = pasteYearColumns(columns, { ...options, singleColumn });
  const rows = options?.section
    ? TAX_WORKBOOK_ROWS.filter((row) => row.section === options.section)
    : TAX_WORKBOOK_ROWS;

  const lines: string[] = [];
  if (options?.includeYearHeaders && years.length > 1) {
    lines.push(["Line item", ...years.map(String)].join("\t"));
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (padExcelRows && i > 0) {
      const prev = rows[i - 1]!.row;
      for (let gap = prev + 1; gap < row.row; gap++) {
        lines.push("");
      }
    }
    const cells = years.map((year) => {
      const col = byYear.get(year);
      if (!col) return confirmedOnly ? "" : PASTE_ZERO;
      if (!includeFormulas && row.excelBehavior === "formula") return "";
      const layout = col.workbookValues ?? col.values;
      const computed = computeWorkbookFormulas(layout);
      const value = col.formulaOverrides?.[row.id] ?? computed[row.id];
      if (confirmedOnly) {
        if (row.excelBehavior === "input" && !isUserVerifiedField(col, row.id)) return "";
        return formatExcelPasteNumber(value);
      }
      return formatExcelPasteNumber(value);
    });
    const rowLabel = pasteRowLabel(row, options?.dynamicOpexLabels);
    lines.push(
      includeLabels || options?.includeYearHeaders ? [rowLabel, ...cells].join("\t") : cells.join("\t"),
    );
  }
  return lines.join("\n");
}

/** Full I/S + B/S paste with Excel row gaps — includes recalculated formula rows. */
export function buildFullWorkbookPasteTsv(
  columns: TaxYearValues[],
  options?: Omit<PasteTsvOptions, "section">,
): string {
  return buildPasteTsv(columns, {
    ...options,
    padExcelRows: true,
    singleColumn: options?.singleColumn ?? columns.length <= 1,
    includeFormulas: options?.includeFormulas ?? true,
  });
}
