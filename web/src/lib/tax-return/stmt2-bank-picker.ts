import { isFormReferenceNumber, isReasonableMoneyAmount, substantialMoneyTokens } from "./money";
import { isOtherDeductionsBlockHeader, endsOtherDeductionsBlock } from "./statement-extractors";

export type Stmt2BankPick = {
  value: number;
  confidence: number;
  source: string;
  flag?: string;
};

const BANK_LABEL = /bank|credit\s+card|merchant\s+(?:fee|svc|service)|processing\s+fee/i;

function bankAmountsOnLine(line: string): number[] {
  const out: number[] = [];
  const labelAmt = line.match(
    /(?:bank|credit\s+card|merchant|processing)[^0-9]{0,30}(\d{1,3}(?:,\d{3})+(?:\.\d{2})?)/i,
  );
  if (labelAmt?.[1] !== undefined) {
    const n = Number(labelAmt[1].replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(Math.round(n));
  }
  for (const n of substantialMoneyTokens(line)) {
    out.push(Math.round(Math.abs(n)));
  }
  // Labeled OD bank lines: keepable dollars only — no bare $500 floor.
  return [...new Set(out)].filter((n) => {
    if (n < 1) return false;
    if (!isReasonableMoneyAmount(n)) return false;
    if (isFormReferenceNumber(n)) return false;
    if (n >= 1990 && n <= 2035) return false;
    return true;
  });
}

/** Evaluate a labeled bank candidate by partition identity, without a score cutoff. */
function evaluateBankCandidate(
  bank: number,
  prof: number,
  util: number,
  stmt2Total: number,
  misc: number[],
): { valid: boolean; exactMiscClosure: boolean } {
  // Structural: bank alone cannot be the whole Other-deductions total.
  if (bank >= stmt2Total) return { valid: false, exactMiscClosure: false };
  const attachment = prof + util + bank;
  if (attachment >= stmt2Total) return { valid: false, exactMiscClosure: false };
  const residual = Math.round(stmt2Total - attachment);
  if (residual < 1) return { valid: false, exactMiscClosure: false };

  const miscRest = misc.filter((m) => Math.round(m) !== Math.round(bank));
  const miscSum = miscRest.reduce((s, n) => s + n, 0);
  const exactMiscClosure =
    miscRest.some((m) => Math.round(m) === residual) ||
    (miscSum >= 1 && Math.round(miscSum) === residual);
  return { valid: true, exactMiscClosure };
}

/** Pick Stmt 2 bank/credit-card line using bank-label vocabulary + Stmt total remainder. */
export function pickStmt2BankCreditCard(
  text: string,
  ctx: {
    professional_fees?: number;
    utilities?: number;
    stmt2Total: number;
    misc: number[];
  },
): Stmt2BankPick | undefined {
  const stmt2Total = ctx.stmt2Total;
  if (!(stmt2Total >= 1)) return undefined;

  const prof = ctx.professional_fees ?? 0;
  const util = ctx.utilities ?? 0;
  const misc = ctx.misc;

  const candidates = new Set<number>();
  const expenseChargeBanks = new Set<number>();
  // Which IRS statement number holds "Other deductions" varies by client (Stmt 2 for some,
  // Stmt 3+ for others) — reuse the same block-boundary detector as the main other-deductions
  // extractor so this scan never drifts onto an unrelated same-numbered statement (e.g. a
  // "Taxes and licenses" attachment that also happens to be Statement 2) or bail out right as it
  // enters the real attachment (e.g. when "Other deductions" itself is Statement 3+).
  let inStmt2 = false;
  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;
    const lineIdx = text.indexOf(rawLine);
    const recentContext =
      lineIdx >= 0
        ? text.slice(Math.max(0, lineIdx - 600), lineIdx + rawLine.length).replace(/\s+/g, " ")
        : undefined;
    if (isOtherDeductionsBlockHeader(line, recentContext)) {
      inStmt2 = true;
      continue;
    }
    if (inStmt2 && endsOtherDeductionsBlock(line, recentContext)) inStmt2 = false;
    if (!inStmt2 || !BANK_LABEL.test(line) || /payable/i.test(line)) continue;
    const isExpenseCharge = /bank\s+&?\s*credit|bank\s+charg|credit\s+card\s+charg/i.test(line);
    for (const n of bankAmountsOnLine(line)) {
      // Skip amounts that are the whole stmt total (footer echo), not a detail line.
      if (n >= stmt2Total) continue;
      candidates.add(n);
      if (isExpenseCharge) expenseChargeBanks.add(n);
    }
  }

  // Only labeled bank/merchant lines — do not promote unlabeled misc via stmt% bands.
  if (!candidates.size) return undefined;

  let best:
    | { bank: number; exactMiscClosure: boolean; explicitExpenseCharge: boolean }
    | undefined;
  for (const bank of candidates) {
    const evidence = evaluateBankCandidate(bank, prof, util, stmt2Total, misc);
    if (!evidence.valid) continue;
    const pick = {
      bank,
      exactMiscClosure: evidence.exactMiscClosure,
      explicitExpenseCharge: expenseChargeBanks.has(bank),
    };
    if (
      !best ||
      (pick.exactMiscClosure && !best.exactMiscClosure) ||
      (pick.exactMiscClosure === best.exactMiscClosure &&
        pick.explicitExpenseCharge &&
        !best.explicitExpenseCharge)
    ) {
      best = pick;
    }
  }
  if (!best) return undefined;

  const high = best.exactMiscClosure || best.explicitExpenseCharge;
  return {
    value: best.bank,
    confidence: high ? 92 : 74,
    source: high
      ? "Statement 2 (bank/credit card — closes Stmt 2 total)"
      : "Statement 2 (bank/credit card — verify)",
    flag: high ? undefined : "Bank fee inferred from Stmt 2 — verify against attachment",
  };
}
