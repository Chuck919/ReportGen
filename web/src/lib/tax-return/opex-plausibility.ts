import type { ResolvedFields } from "./merge";
import { closureTolerance } from "./structural-tolerance";

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

function nearEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(2, Math.abs(b) * 0.01);
}

export function collidesWithResolvedPnl(value: number, resolved: ResolvedFields): boolean {
  for (const id of PNL_COLLISION_IDS) {
    const v = resolved.values[id];
    if (v !== undefined && nearEqual(value, v)) return true;
  }
  return false;
}

function closesStmt2Total(value: number, ctx: OpexContext): boolean {
  if (ctx.stmt2Total === undefined || ctx.stmt2Total <= 0) return false;
  const known = ctx.knownStmt2Lines ?? 0;
  return Math.abs(known + value - ctx.stmt2Total) <= closureTolerance(ctx.stmt2Total);
}

/** Structural plausibility — no company-specific dollar targets. */
export function isPlausibleOtherOperatingExpense(value: number, ctx: OpexContext): boolean {
  const abs = Math.abs(Math.round(value));
  if (abs < 1_000) return false;
  if (ctx.sales !== undefined && ctx.sales > 0 && abs > ctx.sales * 0.45) return false;
  if (ctx.stmt2Total !== undefined && ctx.stmt2Total > 0 && abs >= ctx.stmt2Total * 0.92) {
    return false;
  }
  // Large opex is valid when it closes Stmt 2 (Arizona-style attachments).
  if (
    ctx.stmt2Total !== undefined &&
    ctx.stmt2Total >= 100_000 &&
    abs >= ctx.stmt2Total * 0.4 &&
    !closesStmt2Total(abs, ctx)
  ) {
    return false;
  }
  if (
    ctx.knownStmt2Lines !== undefined &&
    ctx.stmt2Total !== undefined &&
    abs > ctx.stmt2Total - ctx.knownStmt2Lines * 0.5
  ) {
    if (abs >= ctx.stmt2Total * 0.85 && !closesStmt2Total(abs, ctx)) return false;
  }
  return true;
}
