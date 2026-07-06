import { isReasonableMoneyAmount, substantialMoneyTokens } from "./money";

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
  return [...new Set(out)].filter((n) => n >= 500 && isReasonableMoneyAmount(n));
}

/** Score bank-fee candidates by how well Stmt 2 attachment + misc residual closes the block total. */
function scoreBankCandidate(
  bank: number,
  prof: number,
  util: number,
  stmt2Total: number,
  misc: number[],
): number {
  if (bank >= stmt2Total * 0.85) return 0;
  const attachment = prof + util + bank;
  const residual = stmt2Total - attachment;
  if (residual < 500 || residual > stmt2Total * 0.45) return 0;

  const miscRest = misc.filter((m) => Math.abs(m - bank) > Math.max(2, bank * 0.01));
  const miscSum = miscRest.reduce((s, n) => s + n, 0);
  const miscNear =
    miscRest.some((m) => Math.abs(m - residual) <= Math.max(500, residual * 0.04)) ||
    (miscSum >= 500 && Math.abs(miscSum - residual) <= Math.max(800, residual * 0.06));

  let score = 40;
  if (bank <= stmt2Total * 0.25) score += 25;
  else if (bank <= stmt2Total * 0.5) score += 10;

  if (miscNear) score += 45;
  else if (residual >= 1_000 && residual <= stmt2Total * 0.25) score += 15;

  return Math.min(100, score);
}

/** Pick Stmt 2 bank/credit-card line using structural closure (percentage-based, no fixed dollar caps). */
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
  if (stmt2Total < 5_000) return undefined;

  const prof = ctx.professional_fees ?? 0;
  const util = ctx.utilities ?? 0;
  const misc = ctx.misc;

  const candidates = new Set<number>();
  const expenseChargeBanks = new Set<number>();
  let inStmt2 = false;
  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;
    if (/statement\s*2|stmt\s*2|line\s*(?:19|20)\b.*other\s+deductions/i.test(line)) {
      inStmt2 = true;
      continue;
    }
    if (/federal\s+statements/i.test(line) && /statement\s*2|stmt\s*2/i.test(line)) {
      inStmt2 = true;
      continue;
    }
    if (/statement\s*[3-9]|stmt\s*[3-9]/i.test(line)) inStmt2 = false;
    if (!inStmt2 || !BANK_LABEL.test(line) || /payable/i.test(line)) continue;
    const isExpenseCharge = /bank\s+&?\s*credit|bank\s+charg|credit\s+card\s+charg/i.test(line);
    for (const n of bankAmountsOnLine(line)) {
      if (n >= stmt2Total * 0.85) continue;
      candidates.add(n);
      if (isExpenseCharge) expenseChargeBanks.add(n);
    }
  }

  if (!expenseChargeBanks.size) {
    for (const m of misc) {
      if (m >= 500 && m <= stmt2Total * 0.25) candidates.add(m);
    }
  }

  if (!candidates.size) return undefined;

  let best: { bank: number; score: number } | undefined;
  for (const bank of candidates) {
    let score = scoreBankCandidate(bank, prof, util, stmt2Total, misc);
    if (expenseChargeBanks.has(bank)) score += 30;
    if (bank >= stmt2Total * 0.4 && bank <= stmt2Total * 0.55) score += 15;
    if (!best || score > best.score) best = { bank, score };
  }
  if (!best || best.score < 35) return undefined;

  const high = best.score >= 70;
  return {
    value: best.bank,
    confidence: high ? 92 : 74,
    source: high
      ? "Statement 2 (bank/credit card — closes Stmt 2 total)"
      : "Statement 2 (bank/credit card — verify)",
    flag: high ? undefined : "Bank fee inferred from Stmt 2 — verify against attachment",
  };
}
