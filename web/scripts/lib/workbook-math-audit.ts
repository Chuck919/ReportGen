import { computeWorkbookFormulas } from "../../src/lib/tax/workbook-formulas";
import { OPERATING_EXPENSE_SLOT_IDS } from "../../src/lib/tax/operating-expenses";

export type MathIssue = { kind: string; detail: string };

function sumTop8(values: Record<string, number | undefined>): number {
  return Math.round(
    OPERATING_EXPENSE_SLOT_IDS.reduce((s, id) => s + Math.round(values[id] ?? 0), 0),
  );
}

/** Verify integrator workbook formulas (overhead_sga, operating_profit, net_income chain). */
export function auditWorkbookMath(values: Record<string, number | undefined>): MathIssue[] {
  const issues: MathIssue[] = [];
  const computed = computeWorkbookFormulas(values);
  const top8 = sumTop8(values);

  if (computed.overhead_sga !== undefined && Math.abs(computed.overhead_sga - top8) > 1) {
    issues.push({
      kind: "overhead_sga",
      detail: `overhead_sga=${computed.overhead_sga} but sum(top8)=${top8}`,
    });
  }

  const gp = computed.gross_profit;
  if (gp !== undefined && values.sales !== undefined && values.cogs !== undefined) {
    const expected = Math.round((values.sales ?? 0) - (values.cogs ?? 0));
    if (Math.abs(gp - expected) > 1) {
      issues.push({ kind: "gross_profit", detail: `gross_profit=${gp} expected ${expected}` });
    }
  }

  if (computed.operating_profit !== undefined) {
    const expected = Math.round(
      (computed.gross_profit ?? 0) -
        (computed.depreciation_amortization ?? 0) +
        (values.other_operating_income ?? 0) -
        (computed.overhead_sga ?? 0) -
        (values.other_operating_expenses ?? 0),
    );
    if (Math.abs(computed.operating_profit - expected) > 1) {
      issues.push({
        kind: "operating_profit",
        detail: `operating_profit=${computed.operating_profit} expected ${expected}`,
      });
    }
  }

  if (computed.net_income !== undefined && computed.adjusted_net_profit_before_taxes !== undefined) {
    const expected = Math.round(
      (computed.adjusted_net_profit_before_taxes ?? 0) -
        (values.taxes_paid ?? 0) +
        (values.extraordinary_gain ?? 0) -
        (values.extraordinary_loss ?? 0),
    );
    if (Math.abs(computed.net_income - expected) > 1) {
      issues.push({ kind: "net_income", detail: `net_income=${computed.net_income} expected ${expected}` });
    }
  }

  // Balance sheet identity: Total Assets must equal Total Liabilities + Equity within $1.
  if (computed.total_assets !== undefined && computed.total_liabilities_equity !== undefined) {
    const gap = computed.total_assets - computed.total_liabilities_equity;
    if (Math.abs(gap) > 1) {
      issues.push({
        kind: "balance_sheet",
        detail: `assets=${computed.total_assets} L+E=${computed.total_liabilities_equity} gap=${gap}`,
      });
    }
  }

  return issues;
}
