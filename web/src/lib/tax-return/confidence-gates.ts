import { TAX_WORKBOOK_ROWS } from "@/lib/tax-workbook";
import type { OcrMode } from "./local-ocr";
import { isFormReferenceNumber } from "./money";
import type { ResolvedFields } from "./merge";

const INPUT_ROW_IDS = new Set(
  TAX_WORKBOOK_ROWS.filter((row) => row.excelBehavior === "input").map((row) => row.id),
);

/** P&L / balance-sheet lines that should not be OCR noise (0, 1, line numbers). */
const MATERIAL_AMOUNT_FIELDS = new Set([
  "sales",
  "cogs",
  "rent",
  "depreciation",
  "amortization",
  "officer_compensation",
  "salaries_wages",
  "advertising",
  "taxes_licenses",
  "gross_fixed_assets",
  "accumulated_depreciation",
  "accounts_receivable",
  "cash",
  "inventory",
  "notes_minus_short_term",
  "other_stock_equity",
]);

const WEAK_SOURCE =
  /OCR label match|fuzzy|label match/i;

const AUTHORITATIVE_SOURCE =
  /form 1120|schedule l|statement \d|stmt \d|two-year comparison|embedded schedule|page 1 block|P&L reverse math|ordinary income/i;

/** Derived / residual opex — must not paint as green "authoritative" form lines. */
export function isResidualOpexSource(source?: string): boolean {
  if (/P&L reverse math|ordinary income/i.test(source ?? "")) return false;
  // Exact OD partition identity (stmtTOTAL − stmtInTop8) is not a soft residual guess.
  if (/stmt total\s*[−\-]\s*stmt lines in top-8/i.test(source ?? "")) return false;
  return /minus\s+slot|federal\s+table\s+minus|residual|summed detail|itemized closure|misc detail closes|stmt total|operating expenses \(stmt|sum\(all\)\s*[−\-]|top-8\)|includes form lines outside top-8/i.test(
    source ?? "",
  );
}

export type ConfidenceGateOptions = {
  ocrMode?: OcrMode;
  taxYear?: number;
};

export function isWeakSource(source?: string): boolean {
  return WEAK_SOURCE.test(source ?? "");
}

export function isAuthoritativeSource(source?: string): boolean {
  if (isResidualOpexSource(source)) return false;
  return AUTHORITATIVE_SOURCE.test(source ?? "");
}

function sourceLineNumberEqualsValue(value: number, source?: string): boolean {
  const lineRef = source?.match(/\bline\s*(\d{1,3})\b/i);
  return lineRef != null && Math.abs(Math.round(value)) === Number(lineRef[1]);
}

function isInterestReferenceBleed(value: number, source?: string): boolean {
  if (sourceLineNumberEqualsValue(value, source)) return true;
  if (/^\s*\d{1,3}\s+interest/i.test(source ?? "")) return true;
  // §163(j) / Form 8990 instruction captions are references, not interest-expense rows.
  return /million|form\s*8990|163\s*\(\s*j\s*\)|section\s*163|business\s+interest\s+limitation/i.test(
    source ?? "",
  );
}

/**
 * OCR junk: form refs, tax years, line-number crumbs (abs ≤ 99 on trap fields).
 * ≤99 is IRS form-line vocabulary — not a company-size floor.
 */
export function isSuspiciousTaxValue(
  id: string,
  value: number,
  source?: string,
  taxYear?: number,
): boolean {
  const abs = Math.abs(Math.round(value));
  if (isFormReferenceNumber(abs)) return true;
  if (taxYear && abs === taxYear) return true;
  if (taxYear && abs === taxYear % 100) return true;
  if (taxYear && abs >= 2020 && abs <= 2035) return true;
  if (sourceLineNumberEqualsValue(value, source)) return true;

  // Tiny non-authoritative COGS/rent/sales still look like column crumbs when source is weak.
  if (id === "cogs" && abs > 0 && abs <= 99 && !isAuthoritativeSource(source)) return true;
  if (id === "rent" && abs > 0 && abs <= 99 && !isAuthoritativeSource(source)) return true;
  if (id === "sales" && abs > 0 && abs <= 99 && !isAuthoritativeSource(source)) return true;
  if (id === "depreciation" && abs > 0 && abs < 100 && !isAuthoritativeSource(source)) return true;

  // Form 1120 line 31 tiny positives are often OCR crumbs from neighboring line labels.
  if (id === "taxes_paid" && abs > 0 && abs <= 99 && /form\s*1120\s*line\s*31/i.test(source ?? "")) {
    return true;
  }

  if (id === "interest_expense" && abs > 0 && abs <= 999) {
    if (abs <= 50) return true;
    if (isInterestReferenceBleed(value, source)) return true;
    if (abs === 163 && /(?:^|[^\d])163(?:[^\d]|$)|8990|limitation/i.test(source ?? "")) return true;
  }

  /** "Post-1986 depreciation adjustment" OCR — year 1986 read as dollars. */
  if (
    (id === "depreciation" || id === "amortization") &&
    (abs === 1986 || abs === 1987 || /post[-\s]?1986|1986\s+depreciation\s+adjustment/i.test(source ?? ""))
  ) {
    return true;
  }
  if (id === "depreciation" && isFormReferenceNumber(abs)) return true;

  // Exact zero is a valid cleared amount (e.g. no intangibles → amort=0); $1 crumbs stay suspicious.
  if (MATERIAL_AMOUNT_FIELDS.has(id) && abs > 0 && abs <= 1) return true;

  /** Form line numbers (e.g. 12, 16, 20) misread as dollar amounts on expense/BS lines. */
  const LINE_NUMBER_TRAP_FIELDS = new Set([
    "amortization",
    "other_operating_expenses",
    "accounts_payable",
    "advertising",
    "bank_credit_card",
    "professional_fees",
    "utilities",
    "other_current_liabilities",
    "short_term_debt",
    "current_portion_ltd",
    "other_current_assets",
    "notes_minus_short_term",
    "other_stock_equity",
    "unclassified_equity",
  ]);
  if (LINE_NUMBER_TRAP_FIELDS.has(id) && abs > 0 && abs <= 99) return true;

  // S-corp Schedule L often has nominal-par common stock — not OCR line noise.
  if (
    (id === "common_stock" || id === "preferred_stock") &&
    abs > 0 &&
    abs <= 99 &&
    !/schedule\s*l/i.test(source ?? "")
  ) {
    return true;
  }

  if (
    id === "other_income" &&
    value === 0 &&
    /summary zero|multi-line/i.test(source ?? "") &&
    !/form 1120 line 10|comparison/i.test(source ?? "")
  ) {
    return true;
  }

  if (isWeakSource(source) && abs <= 99) return true;

  return false;
}

const SUSPICIOUS_CONF_CAP = 42;
const ASSUMED_ZERO_CONF = 68;

/**
 * Downgrade or drop untrusted values. Thorough mode clears suspicious weak hits
 * so higher tiers / comparison refill can win on a re-merge pass.
 */
export function applyConfidenceGates(resolved: ResolvedFields, options: ConfidenceGateOptions = {}): void {
  const strict = options.ocrMode === "thorough";

  for (const id of INPUT_ROW_IDS) {
    const value = resolved.values[id];
    if (value === undefined) continue;

    const source = resolved.sources[id];
    const conf = resolved.confidence[id] ?? 0;
    const suspicious = isSuspiciousTaxValue(id, value, source, options.taxYear);
    const weak = isWeakSource(source);

    if (id === "other_income" && value === 0 && /summary zero/i.test(source ?? "")) {
      resolved.confidence[id] = Math.min(conf, ASSUMED_ZERO_CONF);
      continue;
    }

    if (!suspicious && !(weak && Math.abs(value) <= 1)) continue;

    // Year crumbs / line-number traps on Schedule L must clear even when the source is authoritative.
    if (suspicious && isAuthoritativeSource(source) && Math.abs(Math.round(value)) <= 99) {
      delete resolved.values[id];
      delete resolved.confidence[id];
      delete resolved.sources[id];
      resolved.warnings.push(`Cleared ${id}=${value} (likely form line number, not dollars)`);
      continue;
    }

    if (
      (id === "depreciation" || id === "amortization") &&
      suspicious &&
      (Math.abs(Math.round(value)) === 1986 ||
        Math.abs(Math.round(value)) === 1987 ||
        /post[-\s]?1986/i.test(source ?? ""))
    ) {
      delete resolved.values[id];
      delete resolved.confidence[id];
      delete resolved.sources[id];
      resolved.warnings.push(`Cleared ${id}=${value} (Post-1986 adjustment OCR trap)`);
      continue;
    }

    if (id === "interest_expense" && suspicious && Math.abs(Math.round(value)) <= 999) {
      delete resolved.values[id];
      delete resolved.confidence[id];
      delete resolved.sources[id];
      resolved.warnings.push(`Cleared ${id}=${value} (likely Form line number, not dollars)`);
      continue;
    }

    if (
      id === "accounts_payable" &&
      suspicious &&
      Math.abs(Math.round(value)) <= 99 &&
      !isAuthoritativeSource(source)
    ) {
      delete resolved.values[id];
      delete resolved.confidence[id];
      delete resolved.sources[id];
      resolved.warnings.push(`Cleared ${id}=${value} (likely form line number, not dollars)`);
      continue;
    }

    if (strict && (suspicious || weak) && !isAuthoritativeSource(source)) {
      // Thorough mode: clear suspicious non-authoritative values so comparison refill can replace them.
      delete resolved.values[id];
      delete resolved.confidence[id];
      delete resolved.sources[id];
      resolved.warnings.push(`Thorough: cleared ${id}=${value} (low-trust OCR)`);
      continue;
    }

    const capped = Math.min(conf, SUSPICIOUS_CONF_CAP);
    if (capped < conf) {
      resolved.confidence[id] = capped;
      resolved.warnings.push(`Suspicious ${id}=${value} (confidence ${conf}→${capped})`);
    }
  }
}

// Thorough mode clears suspicious values above; refill should be able to replace them from comparison.

/**
 * True when comparison data should NOT fill other_current_liabilities.
 * OCL is structurally sourced from Schedule L line 18 / Statement totals;
 * a positive comparison value is a prior-year echo or column misread.
 */
export function shouldSkipComparisonOcl(comp: number | undefined, resolved: ResolvedFields): boolean {
  if (comp === undefined || comp <= 0) return false;
  // Already have a structural source — never overwrite with comparison.
  if (resolved.values.other_current_liabilities !== undefined) return true;
  // Do not invent OCL from comparison alone; this row requires Schedule L or Statement support.
  return true;
}

export function refillFromComparison(
  resolved: ResolvedFields,
  comparison: {
    values: Record<string, number>;
    confidence: Record<string, number>;
  },
  taxYear?: number,
): void {
  for (const id of INPUT_ROW_IDS) {
    const comp = comparison.values[id];
    if (comp === undefined) continue;
    if (id === "other_current_liabilities" && shouldSkipComparisonOcl(comp, resolved)) continue;
    if (isSuspiciousTaxValue(id, comp, "Two-year comparison", taxYear)) continue;

    const cur = resolved.values[id];
    const source = resolved.sources[id];

    const needs =
      cur === undefined ||
      isSuspiciousTaxValue(id, cur, source, taxYear) ||
      isWeakSource(source);

    if (!needs) continue;

    resolved.values[id] = Math.round(comp);
    resolved.confidence[id] = comparison.confidence[id] ?? 88;
    resolved.sources[id] = "Two-year comparison (cross-reference refill)";
  }
}
