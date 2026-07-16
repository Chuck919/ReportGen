/**
 * Other-deductions total anchors used by parse + residual math.
 * (Partition-audit helpers lived here historically; production only needs the scan.)
 */
import { scanComparisonOtherDeductionsTotal } from "@/lib/tax-return/comparison-opex";
import { isFormReferenceNumber, isReasonableMoneyAmount } from "@/lib/tax-return/money";
import {
  scanStatement2Total,
  sumStmt2BlockLineItems,
} from "@/lib/tax-return/statement-extractors";

function isKeepableOdTotal(n: number): boolean {
  const abs = Math.round(Math.abs(n));
  if (abs < 1) return false;
  if (!isReasonableMoneyAmount(abs)) return false;
  if (isFormReferenceNumber(abs)) return false;
  if (abs >= 1990 && abs <= 2035) return false;
  return true;
}

/** Other-deductions total anchor from comparison Stmt-2 row or itemized Stmt block. */
export function scanReturnOtherDeductionsTotal(allText: string, year: number): number | undefined {
  const comp = scanComparisonOtherDeductionsTotal(allText, year);
  if (comp !== undefined && isKeepableOdTotal(comp)) return Math.round(comp);

  const stmt2 = scanStatement2Total(allText);
  if (stmt2 !== undefined && isKeepableOdTotal(stmt2)) return Math.round(stmt2);

  const itemized = sumStmt2BlockLineItems(allText);
  if (itemized !== undefined && isKeepableOdTotal(itemized)) {
    return Math.round(itemized);
  }
  return undefined;
}
