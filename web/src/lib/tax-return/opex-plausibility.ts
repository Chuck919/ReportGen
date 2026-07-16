import type { ResolvedFields } from "./merge";
import { exactClosureTolerance } from "./structural-tolerance";

export type OpexContext = {
  sales?: number;
  stmt2Total?: number;
  knownStmt2Lines?: number;
  /** Prior-year parsed values for consistency scoring (session or dev benchmark). */
  priorYearValues?: Record<number, Record<string, number>>;
};

const PNL_COLLISION_IDS = [
  "sales",
  "cogs",
  "rent",
  "officer_compensation",
  "salaries_wages",
  "advertising",
  "taxes_licenses",
  "interest_expense",
  "depreciation",
  "amortization",
  "bank_credit_card",
  "professional_fees",
  "utilities",
] as const;

function dollarsEqual(a: number, b: number): boolean {
  return Math.round(a) === Math.round(b);
}

export function collidesWithResolvedPnl(value: number, resolved: ResolvedFields): boolean {
  for (const id of PNL_COLLISION_IDS) {
    const v = resolved.values[id];
    if (v !== undefined && dollarsEqual(value, v)) return true;
  }
  return false;
}

function closesStmt2Total(value: number, ctx: OpexContext): boolean {
  if (ctx.stmt2Total === undefined || ctx.stmt2Total <= 0) return false;
  const known = ctx.knownStmt2Lines ?? 0;
  return Math.abs(known + value - ctx.stmt2Total) <= exactClosureTolerance(ctx.stmt2Total);
}

/** Structural plausibility — prefer Form/Stmt exact closure over sales-size heuristics. */
export function isPlausibleOtherOperatingExpense(value: number, ctx: OpexContext): boolean {
  const abs = Math.abs(Math.round(value));
  if (abs < 0) return false;
  // Zero other-opex is valid for some returns.
  if (abs === 0) return true;
  // Reject when the candidate is the Stmt footer itself (not a residual), unless known
  // lines + value actually close the total.
  if (ctx.stmt2Total !== undefined && ctx.stmt2Total > 0) {
    const isFooter = dollarsEqual(abs, ctx.stmt2Total);
    if (isFooter && !closesStmt2Total(abs, ctx)) return false;
  }
  return true;
}
