import { OPERATING_EXPENSE_SLOT_IDS } from "@/lib/tax/opex-slot-ids";

/** Formula rows owned by this engine. Leaf constant keeps tax-workbook → formulas acyclic. */
export const WORKBOOK_FORMULA_IDS = [
  "gross_profit",
  "depreciation_amortization",
  "overhead_sga",
  "operating_profit",
  "net_profit_before_taxes",
  "adjusted_net_profit_before_taxes",
  "net_income",
  "total_current_assets",
  "net_fixed_assets",
  "net_intangible_assets",
  "total_assets",
  "total_current_liabilities",
  "long_term_liabilities",
  "total_liabilities",
  "total_equity",
  "total_liabilities_equity",
] as const;

function n(values: Record<string, number | undefined>, id: string): number {
  const v = values[id];
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0;
}

function sum(values: Record<string, number | undefined>, ids: readonly string[]): number {
  return Math.round(ids.reduce((s, id) => s + n(values, id), 0));
}

function anyPresent(values: Record<string, number | undefined>, ids: readonly string[], minCount: number): boolean {
  let present = 0;
  for (const id of ids) if (values[id] !== undefined) present++;
  return present >= minCount;
}

/**
 * Minimal, deterministic workbook formula engine.
 * This is intentionally conservative: if too many inputs are missing, some totals remain undefined.
 */
export function computeWorkbookFormulas(values: Record<string, number | undefined>): Record<string, number | undefined> {
  const out: Record<string, number | undefined> = { ...values };
  // Formula rows are derived output. Clear cached parser/display values before
  // recomputing so a source field that was later corrected or removed cannot
  // leave a stale net/total in the workbook.
  for (const id of WORKBOOK_FORMULA_IDS) out[id] = undefined;

  // Income statement
  if (out.sales !== undefined || out.cogs !== undefined) {
    out.gross_profit = Math.round(n(out, "sales") - n(out, "cogs"));
  }
  if (out.depreciation !== undefined || out.amortization !== undefined) {
    out.depreciation_amortization = Math.round(n(out, "depreciation") + n(out, "amortization"));
  }
  if (anyPresent(out, OPERATING_EXPENSE_SLOT_IDS, 1)) {
    out.overhead_sga = sum(out, OPERATING_EXPENSE_SLOT_IDS);
  }

  if (
    out.gross_profit !== undefined ||
    out.overhead_sga !== undefined ||
    out.other_operating_income !== undefined ||
    out.other_operating_expenses !== undefined ||
    out.depreciation_amortization !== undefined
  ) {
    out.operating_profit = Math.round(
      n(out, "gross_profit") -
        n(out, "depreciation_amortization") +
        n(out, "other_operating_income") -
        n(out, "overhead_sga") -
        n(out, "other_operating_expenses"),
    );
  }

  if (
    out.operating_profit !== undefined ||
    out.interest_expense !== undefined ||
    out.other_income !== undefined ||
    out.other_expenses !== undefined
  ) {
    out.net_profit_before_taxes = Math.round(
      n(out, "operating_profit") - n(out, "interest_expense") + n(out, "other_income") - n(out, "other_expenses"),
    );
  }

  if (out.net_profit_before_taxes !== undefined || out.adjusted_owner_compensation !== undefined) {
    out.adjusted_net_profit_before_taxes = Math.round(
      n(out, "net_profit_before_taxes") + n(out, "adjusted_owner_compensation"),
    );
  }

  if (
    out.adjusted_net_profit_before_taxes !== undefined ||
    out.taxes_paid !== undefined ||
    out.extraordinary_gain !== undefined ||
    out.extraordinary_loss !== undefined
  ) {
    out.net_income = Math.round(
      n(out, "adjusted_net_profit_before_taxes") -
        n(out, "taxes_paid") +
        n(out, "extraordinary_gain") -
        n(out, "extraordinary_loss"),
    );
  }

  // Balance sheet
  // A small business Schedule L commonly reports only "Cash" with the other current-asset rows
  // genuinely blank (no AR/inventory) — one present bucket is enough, matching the liability/equity
  // buckets below. Requiring 2+ silently dropped a real, single-line cash total from Total Assets.
  const currentAssetIds = ["cash", "accounts_receivable", "inventory", "other_current_assets"];
  if (anyPresent(out, currentAssetIds, 1)) {
    out.total_current_assets = sum(out, currentAssetIds);
  }
  if (out.gross_fixed_assets !== undefined || out.accumulated_depreciation !== undefined) {
    out.net_fixed_assets = Math.round(n(out, "gross_fixed_assets") - Math.abs(n(out, "accumulated_depreciation")));
  }
  if (out.gross_intangible_assets !== undefined || out.accumulated_amortization !== undefined) {
    out.net_intangible_assets = Math.round(
      n(out, "gross_intangible_assets") - Math.abs(n(out, "accumulated_amortization")),
    );
  }
  const assetParts = ["total_current_assets", "net_fixed_assets", "net_intangible_assets", "other_assets"];
  // Missing optional buckets (intangibles / other assets) count as 0 — do not blank Total Assets.
  if (out.total_current_assets !== undefined || out.net_fixed_assets !== undefined) {
    out.total_assets = sum(out, assetParts);
  }

  const currentLiabIds = ["accounts_payable", "short_term_debt", "current_portion_ltd", "other_current_liabilities"];
  // One present bucket is enough — missing siblings count as 0 when only other current liabilities are filled.
  if (anyPresent(out, currentLiabIds, 1)) {
    out.total_current_liabilities = sum(out, currentLiabIds);
  }
  const ltLiabIds = ["notes_minus_short_term", "subordinated", "other_long_term_liabilities"];
  if (anyPresent(out, ltLiabIds, 1)) {
    out.long_term_liabilities = sum(out, ltLiabIds);
  }
  const liabParts = ["total_current_liabilities", "long_term_liabilities"];
  if (anyPresent(out, liabParts, 1)) {
    out.total_liabilities = sum(out, liabParts);
  }

  const equityIds = [
    "preferred_stock",
    "common_stock",
    "additional_paid_in_capital",
    "other_stock_equity",
    "unclassified_equity",
  ];
  // Some returns only fill unclassified equity.
  if (anyPresent(out, equityIds, 1)) {
    out.total_equity = sum(out, equityIds);
  }
  const leParts = ["total_liabilities", "total_equity"];
  if (anyPresent(out, leParts, 1)) {
    out.total_liabilities_equity = sum(out, leParts);
  }

  // Ensure all formula IDs exist in output map for callers that iterate workbook rows.
  for (const id of WORKBOOK_FORMULA_IDS) {
    if (!(id in out)) out[id] = undefined;
  }

  return out;
}

