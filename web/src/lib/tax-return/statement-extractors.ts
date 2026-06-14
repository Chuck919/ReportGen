import {
  isFormReferenceNumber,
  isReasonableMoneyAmount,
  parseMoney,
  statementLineAmount,
  substantialMoneyTokens,
} from "./money";
import type { FieldExtraction } from "./form-anchors";

function tailFromLine(line: string, mode: "last" | "max"): number | undefined {
  const nums = substantialMoneyTokens(line);
  if (!nums.length) return undefined;
  const raw = mode === "max" ? Math.max(...nums.map(Math.abs)) * (nums.find((n) => Math.abs(n) === Math.max(...nums.map(Math.abs)))! < 0 ? -1 : 1) : nums[nums.length - 1];
  if (raw === undefined || isFormReferenceNumber(Math.abs(raw)) || !isReasonableMoneyAmount(raw)) return undefined;
  return raw;
}

const PRIMARY_STMT2_LABEL =
  /bank|credit\s+card|professional|utilities?\b|utility\s+expense|description|statement\s*\d|amount\b/i;

/** Stmt 2 deduction lines — bank, professional, utilities, other (detail sum). */
export function extractStatementDeductions(text: string): FieldExtraction {
  const out: FieldExtraction = { values: {}, confidence: {}, sources: {} };

  const labelRules: Array<{ id: string; test: RegExp; amount: "last" | "max" }> = [
    { id: "bank_credit_card", test: /bank|credit\s+card|merchant\s+(?:fee|service)/i, amount: "max" },
    { id: "professional_fees", test: /professional|legal\s+and\s+account|accounting\s+fee/i, amount: "max" },
    { id: "utilities", test: /utilities|utility\s+expense|telephone|internet\s+expense/i, amount: "last" },
  ];

  let inStmt2 = false;
  let otherDeductionSum = 0;
  let stmt2Total: number | undefined;

  const applyLine = (line: string, source: string) => {
    for (const rule of labelRules) {
      if (!rule.test.test(line)) continue;
      const amount = tailFromLine(line, rule.amount);
      if (amount === undefined || out.values[rule.id] !== undefined) continue;
      out.values[rule.id] = Math.round(amount);
      out.confidence[rule.id] = 92;
      out.sources[rule.id] = source;
    }
  };

  const accumulateOther = (line: string) => {
    if (!inStmt2) return;
    if (PRIMARY_STMT2_LABEL.test(line)) return;
    if (/^total\b/i.test(line)) return;
    if (!/[a-z]{3,}/i.test(line)) return;
    const amount = statementLineAmount(line);
    if (amount === undefined || !isReasonableMoneyAmount(amount)) return;
    otherDeductionSum += amount;
  };

  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;

    if (/statement\s*2|stmt\s*2|line\s*20\b.*other\s+deductions/i.test(line)) {
      inStmt2 = true;
      otherDeductionSum = 0;
      stmt2Total = undefined;
    }
    if (/statement\s*[3-9]|stmt\s*[3-9]/i.test(line)) inStmt2 = false;

    if (!inStmt2) continue;

    if (/^total\b/i.test(line)) {
      const total = statementLineAmount(line);
      if (total !== undefined && isReasonableMoneyAmount(total)) stmt2Total = total;
      continue;
    }

    accumulateOther(line);
    applyLine(line, "Statement 2");
  }


  if (otherDeductionSum > 0 && out.values.other_operating_expenses === undefined) {
    let opex = otherDeductionSum;
    if (stmt2Total !== undefined) {
      const primary =
        (out.values.bank_credit_card ?? 0) +
        (out.values.professional_fees ?? 0) +
        (out.values.utilities ?? 0);
      const cap = stmt2Total - primary;
      if (cap > 0 && opex > cap * 1.05) opex = cap;
    }
    if (isReasonableMoneyAmount(opex)) {
      out.values.other_operating_expenses = Math.round(opex);
      out.confidence.other_operating_expenses = 90;
      out.sources.other_operating_expenses = "Statement 2 (summed detail lines)";
    }
  }

  return out;
}

export function extractStatementOtherIncome(text: string): { value?: number; source?: string } {
  for (const block of iterStatement1Blocks(text)) {
    for (const rawLine of block.split(/\n/)) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (!/^total\b/i.test(line)) continue;
      const nums: number[] = [];
      for (const m of Array.from(line.matchAll(/\d[\d,]{1,}/g))) {
        const n = parseMoney(m[0]);
        if (n !== null && !isFormReferenceNumber(Math.abs(n))) nums.push(n);
      }
      if (nums.length) return { value: nums[nums.length - 1], source: "Statement 1 total" };
    }
  }
  return {};
}

function iterStatement1Blocks(text: string): string[] {
  const blocks: string[] = [];
  const seen = new Set<string>();
  const push = (block: string) => {
    const key = block.replace(/\s+/g, " ").trim().slice(0, 160);
    if (!seen.has(key)) {
      seen.add(key);
      blocks.push(block);
    }
  };

  const re =
    /(?:(?:statement|stmt|tatement)\s*1\b|ment1\b|st\w*\s*nt\s*1|sf\w*\s*nt\s*1)[^\n]{0,160}[\s\S]{0,1400}?(?=(?:(?:statement|stmt|tatement)\s*[2-9]\b|nt\s*2\s*-)|\n1-5\b)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const header = m[0].slice(0, 280);
    if (!/line\s*5|other\s+income|discount\s+income/i.test(header)) continue;
    push(m[0]);
  }

  const federalRe =
    /federal\s+statements[\s\S]{0,320}?description[\s\S]{0,60}amount[\s\S]{0,500}?^total\b[^\n]*/gim;
  while ((m = federalRe.exec(text)) !== null) {
    const block = m[0];
    if (!/discount\s+income|other\s+income|line\s*5/i.test(block)) continue;
    push(block);
  }

  return blocks;
}

function statement1DetailStats(text: string): { count: number; hasMiscellaneous: boolean } {
  let bestCount = 0;
  let hasMiscellaneous = false;
  for (const block of iterStatement1Blocks(text)) {
    let count = 0;
    let pastHeader = false;
    for (const rawLine of block.split(/\n/)) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (/statement\s*[2-9]|line\s*20|other\s+deduct/i.test(line)) break;
      if (/^description\b|description\s+amount/i.test(line)) {
        pastHeader = true;
        continue;
      }
      if (!pastHeader || !line || /^total\b/i.test(line)) continue;
      if (!/[a-z]{3,}/i.test(line)) continue;
      if (/miscellaneous/i.test(line)) hasMiscellaneous = true;
      if (statementLineAmount(line) === undefined) continue;
      count += 1;
    }
    if (count > bestCount) bestCount = count;
  }
  return { count: bestCount, hasMiscellaneous };
}

/** Workbook copies Stmt 1 total to other_income when stmt has 3+ lines or includes Miscellaneous. */
export function statement1ReportsToWorkbookOtherIncome(text: string): boolean {
  const { count, hasMiscellaneous } = statement1DetailStats(text);
  return hasMiscellaneous || count >= 3;
}

/** Stmt 1 rows labeled "Other Income" (workbook often nets these to zero on the summary line). */
export function statement1HasOtherIncomeDetailLine(text: string): boolean {
  for (const block of iterStatement1Blocks(text)) {
    for (const rawLine of block.split(/\n/)) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (/^total\b|^description\b/i.test(line)) continue;
      if (/line\s*5|statement\s*1|form\s*1120|page\s*1|federal\s+statements/i.test(line)) continue;
      if (/other\s+income/i.test(line) && !/discount/i.test(line)) return true;
    }
  }
  return false;
}

/** Count Stmt 1 detail rows (multi-item stmt often nets to zero on Form 1120-S line 5). */
export function countStatement1DetailLines(text: string): number {
  return statement1DetailStats(text).count;
}
