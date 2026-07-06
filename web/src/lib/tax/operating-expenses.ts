import { statementLineAmount } from "@/lib/tax-return/money";
import { repairOcrLabel } from "@/lib/tax-return/ocr-label-repair";
import {
  isPlausibleOtherOperatingExpense,
} from "@/lib/tax-return/opex-plausibility";
import { TAX_WORKBOOK_ROWS, type TaxYearValues } from "@/lib/tax-workbook";

export const OPERATING_EXPENSE_SLOT_IDS = [
  "officer_compensation",
  "salaries_wages",
  "advertising",
  "rent",
  "taxes_licenses",
  "bank_credit_card",
  "professional_fees",
  "utilities",
] as const;

export type OperatingExpenseSlotId = (typeof OPERATING_EXPENSE_SLOT_IDS)[number];

export type OperatingExpenseLine = {
  label: string;
  amount: number;
  source?: string;
};

const MIN_EXPENSE_AMOUNT = 100;

function moneyTolerance(expected: number): number {
  if (expected === 0) return 0;
  return Math.max(500, Math.abs(expected) * 0.01);
}

function withinMoneyTolerance(actual: number, expected: number): boolean {
  if (expected === 0) return actual === 0;
  return Math.abs(actual - expected) <= moneyTolerance(expected);
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Canonical category for cross-year matching — collapses OCR variants of the same line. */
const EXPENSE_CATEGORY_RULES: Array<{ key: string; display: string; re: RegExp }> = [
  { key: "officer_compensation", display: "Officer compensation", re: /officer|compensation of officer/i },
  { key: "salaries_wages", display: "Salaries and wages", re: /\bsalar|\bwage|payroll(?!\s*tax)/i },
  { key: "advertising", display: "Advertising", re: /advert|marketing|promotion/i },
  { key: "repairs", display: "Repairs and maintenance", re: /repair|maint/i },
  { key: "rent", display: "Rent", re: /\brent/i },
  { key: "taxes_licenses", display: "Taxes and Licenses", re: /tax(?:es)?\s*(?:and|&)?\s*licen|licen(?:se|ces)?\s*(?:and|&)?\s*tax|taxesandlicen/i },
  { key: "insurance", display: "Insurance", re: /insur/i },
  { key: "bank_credit_card", display: "Bank and credit card", re: /bank|credit\s*card|merchant|card\s*charg/i },
  { key: "professional_fees", display: "Professional fees", re: /profession|legal|account(?:ing|ant)|attorney|consult/i },
  { key: "utilities", display: "Utilities", re: /utilit|electric|gas\b|water\b|telephone|phone|internet/i },
  { key: "supplies", display: "Supplies", re: /suppl|office/i },
  { key: "travel", display: "Travel", re: /travel|mileage|auto\b|vehicle/i },
];

export function expenseCategoryKey(label: string): string | undefined {
  const t = normalizeWhitespace(label);
  const hits = EXPENSE_CATEGORY_RULES.filter((r) => r.re.test(t)).map((r) => r.key);
  if (!hits.length) return undefined;
  // Combined payroll lines ("officers and salaries") must not fill a single slot.
  if (hits.includes("officer_compensation") && hits.includes("salaries_wages")) return undefined;
  return hits[0];
}

function isProtectedOpexSource(source: string | undefined): boolean {
  const src = source ?? "";
  if (/top-8|shared top-8|not present this year|operating expenses \(/i.test(src)) return false;
  return /form\s*1120|form\s*line|comparison|schedule\s*l|statement\s*2|stmt\s*2|federal\s+statements|embedded detail|parser field/i.test(
    src,
  );
}

/** True when amount equals another slot or the sum of two other slots (double-count guard). */
function isAggregateOfOtherSlots(
  amount: number,
  values: Record<string, number | undefined>,
  slotId: string,
): boolean {
  const others = OPERATING_EXPENSE_SLOT_IDS.filter((id) => id !== slotId)
    .map((id) => values[id])
    .filter((n): n is number => typeof n === "number" && n >= MIN_EXPENSE_AMOUNT);
  for (let i = 0; i < others.length; i++) {
    if (withinMoneyTolerance(others[i]!, amount)) return true;
    for (let j = i + 1; j < others.length; j++) {
      if (withinMoneyTolerance(others[i]! + others[j]!, amount)) return true;
    }
  }
  return false;
}

export function expenseLabelKey(label: string): string {
  const category = expenseCategoryKey(label);
  if (category) return category;
  const t = normalizeWhitespace(label)
    .toLowerCase()
    .replace(/[^a-z0-9\s&/.-]/g, "")
    .replace(/\b(expense|expenses|deduction|deductions|other|statement|stmt)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t;
}

function displayLabelForKey(key: string, fallbackLabel: string): string {
  const rule = EXPENSE_CATEGORY_RULES.find((r) => r.key === key);
  if (rule) return rule.display;
  const cleaned = normalizeWhitespace(fallbackLabel)
    .replace(/[|[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length >= 3 && cleaned.length <= 40 && !/statement/i.test(cleaned)) return cleaned;
  return slotDefaultLabel(key) !== key ? slotDefaultLabel(key) : cleaned || key;
}

function isPlausibleExpenseLabel(label: string): boolean {
  const t = normalizeWhitespace(label);
  if (t.length < 3 || t.length > 80) return false;
  if (!/[a-z]/i.test(t)) return false;
  if (/^total\b/i.test(t)) return false;
  if (/\b(schedule|sch\.?|form)\b/i.test(t) && /\b\d{3,4}\b/.test(t)) return false;
  if (
    /\b(total assets|gross profit|total deductions|ordinary business income|taxable income|taxable business income|gross taxable|distributions?|tax year|business activity code|enter amount from line|did the corporation|attach form|credit for federal|biofuel producer|portion of dividends|compensation of officers see instructions|net rental real estate|ordinary income|page line|prone no|credited to estimated|salaries and wages less employment|enterprise zone|electronically filed|fein number|payment type|omb no|indiana corporate|state form|check the box for the tax return)\b/i.test(
      t,
    )
  ) {
    return false;
  }
  if (!/\b(fee|fees|rent|util|insur|suppl|office|bank|credit|merchant|profession|legal|account|advert|tax|license|payroll|repair|maint|travel|telephone|dues|charit|misc|other deduct)/i.test(t)) {
    return false;
  }
  return true;
}

function stripMoneyTokens(line: string): string {
  return normalizeWhitespace(line.replace(/[\d$,.()-]+/g, " ").replace(/\s+/g, " "));
}

/**
 * Extract operating expense detail lines from the "Other deductions / Statement 2" region.
 * This intentionally stays simple — it prefers fewer false positives over exhaustive capture.
 */
export function extractOperatingExpenseLinesFromText(allText: string): OperatingExpenseLine[] {
  const out: OperatingExpenseLine[] = [];
  let inStmt2 = false;
  let inFederalTable = false;

  for (const raw of allText.split(/\n/)) {
    const line = normalizeWhitespace(raw);
    if (!line) continue;

    const lineIdx = allText.indexOf(raw);
    const recentContext =
      lineIdx >= 0
        ? allText.slice(Math.max(0, lineIdx - 600), lineIdx + raw.length).replace(/\s+/g, " ")
        : "";

    if (/^description\s+amount\b/i.test(line) && /federal\s+statements/i.test(recentContext)) {
      inFederalTable = true;
      inStmt2 = true;
      continue;
    }
    if (
      /statement\s*2\s*-\s*form\s+1120/i.test(repairOcrLabel(line)) ||
      (/statement\s*2|stmt\s*2|tatement\s*2/i.test(repairOcrLabel(line)) &&
        (/other\s+deduct|other\s+ions|other\s+expense|line\s*(?:19|20|26)\b/i.test(line) ||
          /see\s+statement/i.test(line)) &&
        !/two\s*year\s*comparison|comparison\s+worksheet/i.test(recentContext))
    ) {
      inStmt2 = true;
      inFederalTable = /federal\s+statements/i.test(recentContext + line);
      continue;
    }
    if (/^description\s+amount\b/i.test(line) && /statement\s*2|stmt\s*2/i.test(recentContext)) {
      inFederalTable = true;
      inStmt2 = true;
      continue;
    }
    if (inStmt2 && /statement\s*[3-9]\b|stmt\s*[3-9]\b/i.test(line) && !/other\s+deduct/i.test(line)) {
      inStmt2 = false;
      inFederalTable = false;
    }
    if (inStmt2 && /two\s*year\s*comparison|comparison\s+worksheet/i.test(line)) {
      inStmt2 = false;
      inFederalTable = false;
    }
    if (!inStmt2) continue;

    if (/^total\b/i.test(line)) continue;
    if (/\bdepreciation\b/i.test(line) && !/accumulated/i.test(line)) continue;
    if (/\bamortization\b/i.test(line) && !/accumulated/i.test(line)) continue;

    const amount = statementLineAmount(line);
    if (amount === undefined) continue;
    const rounded = Math.round(Math.abs(amount));
    if (rounded < MIN_EXPENSE_AMOUNT) continue;

    const label = stripMoneyTokens(repairOcrLabel(line));
    if (!isPlausibleExpenseLabel(label)) continue;

    out.push({
      label,
      amount: rounded,
      source: "Statement 2",
    });
  }

  // Dedupe exact (labelKey, amount) pairs, keep first (source is stable here).
  const seen = new Set<string>();
  const deduped: OperatingExpenseLine[] = [];
  for (const line of out) {
    const key = `${expenseLabelKey(line.label)}:${line.amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(line);
  }
  return deduped.sort((a, b) => b.amount - a.amount);
}

/** Pull parser-resolved opex slot values into the expense-line pool before top-8 selection. */
export function supplementOperatingExpenseLines(
  lines: OperatingExpenseLine[],
  values: Record<string, number>,
  fieldSources?: Record<string, string>,
): OperatingExpenseLine[] {
  const out = [...lines];
  for (const slotId of OPERATING_EXPENSE_SLOT_IDS) {
    const amount = values[slotId];
    if (amount === undefined || Math.round(Math.abs(amount)) < MIN_EXPENSE_AMOUNT) continue;
    const row = TAX_WORKBOOK_ROWS.find((r) => r.id === slotId);
    out.push({
      label: row?.label ?? slotId,
      amount: Math.round(Math.abs(amount)),
      source: fieldSources?.[slotId] ?? "Parser field",
    });
  }
  const seen = new Set<string>();
  const deduped: OperatingExpenseLine[] = [];
  for (const line of out) {
    const key = `${expenseLabelKey(line.label)}:${line.amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(line);
  }
  return deduped.sort((a, b) => b.amount - a.amount);
}

function filterPlausibleExpenseLines(
  lines: OperatingExpenseLine[],
  sales?: number,
  resolvedValues?: Record<string, number>,
): OperatingExpenseLine[] {
  return lines.filter((line) => {
    const amount = Math.round(line.amount);
    if (amount < MIN_EXPENSE_AMOUNT) return false;
    if (sales !== undefined && sales > 0 && amount > sales * 0.4) return false;
    if (resolvedValues) {
      for (const id of ["sales", "cogs", "gross_fixed_assets", "inventory"] as const) {
        const v = resolvedValues[id];
        if (v !== undefined && Math.abs(v - amount) <= Math.max(500, Math.abs(v) * 0.01)) return false;
      }
    }
    return isPlausibleExpenseLabel(line.label);
  });
}

function shouldApplyTop8Policy(
  lines: OperatingExpenseLine[],
  sales?: number,
  priorValues?: Record<string, number>,
  priorSources?: Record<string, string>,
): boolean {
  if (lines.length < 5) return false;
  const amounts = lines.map((l) => Math.round(l.amount)).filter((a) => a >= MIN_EXPENSE_AMOUNT);
  if (amounts.length < 5) return false;
  const unique = new Set(amounts);
  if (unique.size < Math.min(5, amounts.length - 1)) return false;
  if (sales !== undefined && sales > 0 && sumAmounts(lines) > sales * 0.75) return false;

  if (priorValues && priorSources) {
    const authoritativeSlots = OPERATING_EXPENSE_SLOT_IDS.filter((id) => {
      const amt = priorValues[id];
      const src = priorSources[id] ?? "";
      return (
        typeof amt === "number" &&
        amt >= MIN_EXPENSE_AMOUNT &&
        /comparison|form\s*1120|form\s*line|OCR label|embedded detail|statement\s*2|stmt\s*2|federal\s+statements|parser field/i.test(
          src,
        ) &&
        !/top-8|shared top-8|not present this year/i.test(src)
      );
    });
    if (authoritativeSlots.length >= 4) return false;
  }

  if (priorValues) {
    const parserSlots = OPERATING_EXPENSE_SLOT_IDS.map((id) => priorValues[id]).filter(
      (n): n is number => typeof n === "number" && n >= MIN_EXPENSE_AMOUNT,
    );
    if (parserSlots.length >= 4) {
      const parserMultiset = [...parserSlots].sort((a, b) => a - b);
      const lineTop = [...amounts].sort((a, b) => b - a).slice(0, 8).sort((a, b) => a - b);
      let matches = 0;
      for (const p of parserMultiset) {
        if (lineTop.some((l) => withinMoneyTolerance(l, p))) matches++;
      }
      if (matches < Math.min(3, parserSlots.length)) return false;
    }
  }
  const top8 = selectTop8ForYear(lines);
  const top8Amounts = top8.maxAmounts.filter((a) => a >= MIN_EXPENSE_AMOUNT);
  const dupes = top8Amounts.length - new Set(top8Amounts).size;
  if (dupes >= 2) return false;
  return true;
}

function selectTop8ForYear(lines: OperatingExpenseLine[]): SharedTop8 {
  const ranked = [...lines]
    .filter((l) => l.amount >= MIN_EXPENSE_AMOUNT)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 8);
  return {
    labelKeys: ranked.map((l) => expenseLabelKey(l.label)),
    labels: ranked.map((l) => l.label),
    maxAmounts: ranked.map((l) => l.amount),
  };
}

function isAuthoritativeOpexSource(source?: string): boolean {
  return /summed detail|misc detail closes|total minus util|comparison.*OTHER DEDUCTIONS residual|office\/supplies|telephone\/travel/i.test(
    source ?? "",
  );
}

function resolveOtherOperatingExpenses(
  residual: number,
  priorValue: number | undefined,
  priorSource: string | undefined,
  sales?: number,
): number | undefined {
  const ctx = { sales };
  const priorOk = priorValue !== undefined && isPlausibleOtherOperatingExpense(priorValue, ctx);
  const residualOk = residual >= MIN_EXPENSE_AMOUNT && isPlausibleOtherOperatingExpense(residual, ctx);
  const priorAuth = isAuthoritativeOpexSource(priorSource);

  if (priorOk && priorAuth) {
    if (!residualOk || Math.abs(priorValue! - residual) / Math.max(priorValue!, 1) > 0.12) {
      return priorValue;
    }
  }
  if (residualOk) return residual;
  if (priorOk) return priorValue;
  return undefined;
}

function applySharedTop8ToColumn(
  col: TaxYearValues,
  shared: SharedTop8,
  lines: OperatingExpenseLine[],
): TaxYearValues {
  const next = { ...col.values };
  const nextConf = { ...(col.confidence ?? {}) };
  const nextSources = { ...(col.fieldSources ?? {}) };
  const priorOtherOpex = next.other_operating_expenses;
  const priorOtherOpexSource = nextSources.other_operating_expenses;

  const top8Amounts = shared.labelKeys.map((k) => amountForLabelKey(lines, k));
  const residual = Math.max(0, sumAmounts(lines) - sumTop8Amounts(top8Amounts));
  const otherOpex = resolveOtherOperatingExpenses(
    residual,
    priorOtherOpex,
    priorOtherOpexSource,
    next.sales,
  );

  const opexSlotLabels: Record<string, string> = {};
  for (let i = 0; i < OPERATING_EXPENSE_SLOT_IDS.length; i++) {
    const slotId = OPERATING_EXPENSE_SLOT_IDS[i]!;
    const amount = top8Amounts[i] ?? 0;
    if (amount >= MIN_EXPENSE_AMOUNT) {
      next[slotId] = amount;
      nextConf[slotId] = Math.min(nextConf[slotId] ?? 88, 88);
      nextSources[slotId] =
        shared.labelKeys.length > 0
          ? "Operating expenses (top-8 by amount)"
          : "Operating expenses (shared top-8 across uploaded years)";
    } else {
      next[slotId] = 0;
      nextConf[slotId] = Math.min(nextConf[slotId] ?? 75, 75);
      nextSources[slotId] = "Operating expenses (top-8 — not present this year)";
    }
    opexSlotLabels[slotId] = col.userOpexSlotLabels?.[slotId] ?? shared.labels[i] ?? slotDefaultLabel(slotId);
  }

  if (otherOpex !== undefined) {
    next.other_operating_expenses = otherOpex;
    nextConf.other_operating_expenses = Math.min(nextConf.other_operating_expenses ?? 88, 88);
    nextSources.other_operating_expenses =
      otherOpex === priorOtherOpex && priorOtherOpex !== undefined
        ? nextSources.other_operating_expenses ?? "Other operating expenses (reconciled)"
        : "Operating expenses residual (sum(all) − sum(top-8))";
  }

  return {
    ...col,
    values: next,
    confidence: nextConf,
    fieldSources: nextSources,
    opexSlotLabels,
    operatingExpenseLines: lines,
  };
}

/** Apply top-8 opex policy to a single parsed year (API / benchmark path). */
export function applyOperatingExpensesToSingleYear(col: {
  values: Record<string, number>;
  confidence?: Record<string, number>;
  fieldSources?: Record<string, string>;
  operatingExpenseLines?: OperatingExpenseLine[];
}): {
  values: Record<string, number>;
  confidence?: Record<string, number>;
  fieldSources?: Record<string, string>;
  opexSlotLabels?: Record<string, string>;
  operatingExpenseLines?: OperatingExpenseLine[];
} {
  const lines = filterPlausibleExpenseLines(
    col.operatingExpenseLines ?? [],
    col.values.sales,
    col.values,
  );
  if (!shouldApplyTop8Policy(lines, col.values.sales, col.values, col.fieldSources)) {
    return { ...col, operatingExpenseLines: lines };
  }

  const shared = selectTop8ForYear(lines);
  if (!shared.labelKeys.length) return { ...col, operatingExpenseLines: lines };

  const applied = applySharedTop8ToColumn(
    {
      year: 0,
      source: "parser",
      values: col.values,
      confidence: col.confidence,
      fieldSources: col.fieldSources,
      operatingExpenseLines: lines,
    },
    shared,
    lines,
  );
  return {
    values: applied.values,
    confidence: applied.confidence,
    fieldSources: applied.fieldSources,
    opexSlotLabels: applied.opexSlotLabels,
    operatingExpenseLines: lines,
  };
}

type SharedTop8 = {
  labelKeys: string[];
  labels: string[];
  maxAmounts: number[];
};

function selectSharedTop8AcrossYears(linesByYear: Map<number, OperatingExpenseLine[]>): SharedTop8 {
  const aggregates = new Map<string, { label: string; maxAmount: number }>();
  for (const lines of linesByYear.values()) {
    for (const line of lines) {
      if (line.amount < MIN_EXPENSE_AMOUNT) continue;
      const key = expenseLabelKey(line.label);
      if (!key) continue;
      const existing = aggregates.get(key);
      if (!existing) {
        aggregates.set(key, { label: line.label, maxAmount: line.amount });
        continue;
      }
      if (line.amount > existing.maxAmount) {
        existing.maxAmount = line.amount;
        existing.label = line.label;
      }
    }
  }

  const ranked = [...aggregates.entries()]
    .sort((a, b) => b[1].maxAmount - a[1].maxAmount)
    .slice(0, 8);

  return {
    labelKeys: ranked.map(([k]) => k),
    labels: ranked.map(([, v]) => v.label),
    maxAmounts: ranked.map(([, v]) => v.maxAmount),
  };
}

function amountForLabelKey(lines: OperatingExpenseLine[], labelKey: string): number {
  // Prefer exact category/key match; if multiple OCR fragments share a category, take the largest.
  let best = 0;
  for (const line of lines) {
    if (expenseLabelKey(line.label) !== labelKey) continue;
    best = Math.max(best, Math.round(line.amount));
  }
  return best;
}

function countStrongOpexSlots(col: TaxYearValues): number {
  return OPERATING_EXPENSE_SLOT_IDS.filter((id) => {
    const amt = col.values[id];
    const src = col.fieldSources?.[id] ?? "";
    return (
      typeof amt === "number" &&
      amt >= MIN_EXPENSE_AMOUNT &&
      !/top-8|shared top-8|not present this year/i.test(src)
    );
  }).length;
}

/**
 * Map categorized Stmt-2 lines into weak workbook slots (e.g. repairs → advertising row,
 * insurance → bank row) without disturbing strong form/statement amounts.
 */
function fillWeakSlotsFromCategorizedLines(col: TaxYearValues): TaxYearValues {
  const lines = filterPlausibleExpenseLines(
    col.operatingExpenseLines ?? [],
    col.values.sales,
    col.values,
  );
  if (!lines.length) return col;

  // Prefer these categories for slots that are often company-specific in the integrator.
  const categoryToSlot: Array<{ category: string; slotId: OperatingExpenseSlotId; label: string }> = [
    { category: "officer_compensation", slotId: "officer_compensation", label: "Officer compensation" },
    { category: "salaries_wages", slotId: "salaries_wages", label: "Salaries and wages" },
    { category: "repairs", slotId: "advertising", label: "Repairs and maintenance" },
    { category: "advertising", slotId: "advertising", label: "Advertising" },
    { category: "rent", slotId: "rent", label: "Rent" },
    { category: "taxes_licenses", slotId: "taxes_licenses", label: "Taxes and Licenses" },
    { category: "insurance", slotId: "bank_credit_card", label: "Insurance" },
    { category: "bank_credit_card", slotId: "bank_credit_card", label: "Bank and credit card" },
    { category: "professional_fees", slotId: "professional_fees", label: "Professional fees" },
    { category: "utilities", slotId: "utilities", label: "Utilities" },
  ];

  const byCategory = new Map<string, number>();
  for (const line of lines) {
    const cat = expenseCategoryKey(line.label);
    if (!cat) continue;
    byCategory.set(cat, Math.max(byCategory.get(cat) ?? 0, Math.round(line.amount)));
  }

  const values = { ...col.values };
  const fieldSources = { ...(col.fieldSources ?? {}) };
  const opexSlotLabels = { ...(col.opexSlotLabels ?? {}) };
  const usedSlots = new Set<string>();

  for (const { category, slotId, label } of categoryToSlot) {
    if (usedSlots.has(slotId)) continue;
    const lineAmt = byCategory.get(category);
    if (lineAmt === undefined || lineAmt < MIN_EXPENSE_AMOUNT) continue;
    const cur = values[slotId];
    const src = fieldSources[slotId] ?? "";

    // Never overwrite form / comparison / statement amounts (even when a larger OCR line exists).
    if (typeof cur === "number" && cur >= MIN_EXPENSE_AMOUNT && isProtectedOpexSource(src)) {
      if (withinMoneyTolerance(cur, lineAmt)) {
        opexSlotLabels[slotId] = col.userOpexSlotLabels?.[slotId] ?? label;
        usedSlots.add(slotId);
      }
      continue;
    }

    const strong =
      typeof cur === "number" &&
      cur >= MIN_EXPENSE_AMOUNT &&
      !/top-8|shared top-8|not present this year/i.test(src) &&
      cur >= Math.min(lineAmt * 0.5, lineAmt - 500);
    if (strong) {
      if (withinMoneyTolerance(cur, lineAmt)) {
        opexSlotLabels[slotId] = col.userOpexSlotLabels?.[slotId] ?? label;
        usedSlots.add(slotId);
      }
      continue;
    }

    // Don't steal an amount already placed in another slot, or a payroll total (officers+salaries).
    if (isAggregateOfOtherSlots(lineAmt, values, slotId)) continue;

    values[slotId] = lineAmt;
    fieldSources[slotId] = `Operating expenses (${label})`;
    opexSlotLabels[slotId] = col.userOpexSlotLabels?.[slotId] ?? label;
    usedSlots.add(slotId);
  }

  return { ...col, values, fieldSources, opexSlotLabels };
}

/** Keep per-year amounts; only share clean display labels across columns. */
function unifyOpexLabelsOnly(columns: TaxYearValues[]): TaxYearValues[] {
  const labels: Record<string, string> = {};
  for (const id of OPERATING_EXPENSE_SLOT_IDS) {
    for (const col of columns) {
      const user = col.userOpexSlotLabels?.[id];
      if (user) {
        labels[id] = user;
        break;
      }
      const existing = col.opexSlotLabels?.[id];
      if (existing && !/statement\s*\|/i.test(existing) && existing.length <= 40) {
        labels[id] = displayLabelForKey(expenseLabelKey(existing) || id, existing);
        break;
      }
    }
    if (!labels[id]) labels[id] = slotDefaultLabel(id);
  }
  return columns.map((col) => ({
    ...col,
    opexSlotLabels: { ...labels, ...(col.userOpexSlotLabels ?? {}) },
  }));
}

function sumAmounts(lines: OperatingExpenseLine[]): number {
  return Math.round(lines.reduce((s, l) => s + Math.round(l.amount), 0));
}

function sumTop8Amounts(amounts: number[]): number {
  return Math.round(amounts.reduce((s, n) => s + Math.round(n), 0));
}

function slotDefaultLabel(slotId: string): string {
  return TAX_WORKBOOK_ROWS.find((r) => r.id === slotId)?.label ?? slotId;
}

/**
 * Align operating expenses across uploaded years for integrator paste.
 *
 * Prefer per-year parser slot amounts (form / statement / comparison). Only remap via
 * shared OCR detail lines when most years lack strong slots — otherwise OCR label noise
 * double-counts categories (e.g. "rents" + "el rents") and destroys correct values.
 */
export function alignOperatingExpensesAcrossYears(columns: TaxYearValues[]): TaxYearValues[] {
  if (columns.length === 0) return columns;

  const perYear = columns.map((col) => {
    const applied = applyOperatingExpensesToSingleYear(col);
    const merged = {
      ...col,
      values: applied.values,
      confidence: applied.confidence ?? col.confidence,
      fieldSources: applied.fieldSources ?? col.fieldSources,
      opexSlotLabels: applied.opexSlotLabels ?? col.opexSlotLabels,
      operatingExpenseLines: applied.operatingExpenseLines ?? col.operatingExpenseLines,
    };
    return fillWeakSlotsFromCategorizedLines(merged);
  });

  if (perYear.length === 1) return unifyOpexLabelsOnly(perYear);

  const strongCount = perYear.filter((col) => countStrongOpexSlots(col) >= 4).length;
  // When the parser already filled most years, only share display labels — do not remap amounts.
  if (strongCount >= Math.ceil(perYear.length / 2)) {
    return unifyOpexLabelsOnly(perYear);
  }

  const byYearLines = new Map<number, OperatingExpenseLine[]>();
  for (const col of perYear) {
    const lines = filterPlausibleExpenseLines(
      supplementOperatingExpenseLines(
        col.operatingExpenseLines ?? [],
        col.values,
        col.fieldSources,
      ),
      col.values.sales,
      col.values,
    );
    if (lines.length) byYearLines.set(col.year, lines);
  }
  if (byYearLines.size < 2) return unifyOpexLabelsOnly(perYear);

  const shared = selectSharedTop8AcrossYears(byYearLines);
  if (!shared.labelKeys.length) return unifyOpexLabelsOnly(perYear);

  // Clean display labels (category names, not OCR fragments).
  const cleanShared: SharedTop8 = {
    labelKeys: shared.labelKeys,
    labels: shared.labelKeys.map((k, i) => displayLabelForKey(k, shared.labels[i] ?? k)),
    maxAmounts: shared.maxAmounts,
  };

  const remapped = perYear.map((col) => {
    // Preserve years that already have strong parser slots.
    if (countStrongOpexSlots(col) >= 4) return col;
    const lines = byYearLines.get(col.year);
    if (!lines?.length) return col;
    return applySharedTop8ToColumn(col, cleanShared, lines);
  });
  return unifyOpexLabelsOnly(remapped);
}

/** Shared display labels for the eight operating-expense workbook rows. */
export function sharedOpexSlotLabels(columns: TaxYearValues[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of OPERATING_EXPENSE_SLOT_IDS) {
    for (const col of columns) {
      const user = col.userOpexSlotLabels?.[id];
      if (user) {
        out[id] = user;
        break;
      }
    }
    if (!out[id]) {
      const col = columns.find((c) => c.opexSlotLabels?.[id]);
      out[id] = col?.opexSlotLabels?.[id] ?? slotDefaultLabel(id);
    }
  }
  return out;
}

export function resolveOpexSlotLabel(col: TaxYearValues | undefined, slotId: string): string | undefined {
  return col?.userOpexSlotLabels?.[slotId] ?? col?.opexSlotLabels?.[slotId];
}

/**
 * Amount-only multiset match for the eight opex slots (fixture truth from Excel).
 * Used by benchmarks after we decouple labels from slot IDs.
 */
export function matchTop8OpexAmounts(
  expected: Record<string, number>,
  actual: Record<string, number | undefined>,
): { ok: number; n: number; misses: string[] } {
  const detail = diagnoseTop8OpexMultiset(expected, actual);
  return { ok: detail.ok, n: detail.n, misses: detail.misses };
}

export type OpexSlotDiagnosticRow = {
  slotId: string;
  slotLabel: string;
  actual: number;
  expectedInFixture?: number;
  matched: boolean;
  matchedExpected?: number;
  tolerance?: number;
};

export type OpexMultisetDiagnostic = {
  ok: number;
  n: number;
  pct: number;
  misses: string[];
  slotRows: OpexSlotDiagnosticRow[];
  unmatchedExpected: Array<{ amount: number; tolerance: number; nearestActual?: number; nearestSlot?: string }>;
  surplusActual: Array<{ amount: number; slotId: string; slotLabel: string }>;
};

/** Detailed multiset pairing for benchmark debugging. */
export function diagnoseTop8OpexMultiset(
  expected: Record<string, number>,
  actual: Record<string, number | undefined>,
): OpexMultisetDiagnostic {
  const expAmounts = OPERATING_EXPENSE_SLOT_IDS.map((id) => ({
    slotId: id,
    amount: expected[id],
  })).filter((e): e is { slotId: OperatingExpenseSlotId; amount: number } => typeof e.amount === "number");

  const actRows = OPERATING_EXPENSE_SLOT_IDS.map((id) => ({
    slotId: id,
    slotLabel: slotDefaultLabel(id),
    actual: Math.round(actual[id] ?? 0),
    expectedInFixture: expected[id],
  }));

  const used = new Set<number>();
  const slotRows: OpexSlotDiagnosticRow[] = [];
  let ok = 0;

  for (const row of actRows) {
    const pairedIdx = expAmounts.findIndex(
      (e, i) => !used.has(i) && withinMoneyTolerance(row.actual, e.amount),
    );
    if (pairedIdx >= 0) {
      used.add(pairedIdx);
      ok++;
      const exp = expAmounts[pairedIdx]!;
      slotRows.push({
        slotId: row.slotId,
        slotLabel: row.slotLabel,
        actual: row.actual,
        expectedInFixture: row.expectedInFixture,
        matched: true,
        matchedExpected: exp.amount,
        tolerance: moneyTolerance(exp.amount),
      });
    } else {
      slotRows.push({
        slotId: row.slotId,
        slotLabel: row.slotLabel,
        actual: row.actual,
        expectedInFixture: row.expectedInFixture,
        matched: false,
      });
    }
  }

  const unmatchedExpected: OpexMultisetDiagnostic["unmatchedExpected"] = [];
  const misses: string[] = [];
  for (let i = 0; i < expAmounts.length; i++) {
    if (used.has(i)) continue;
    const exp = expAmounts[i]!.amount;
    const tol = moneyTolerance(exp);
    let nearestActual: number | undefined;
    let nearestSlot: string | undefined;
    let bestDiff = Infinity;
    for (const row of actRows) {
      const diff = Math.abs(row.actual - exp);
      if (diff < bestDiff) {
        bestDiff = diff;
        nearestActual = row.actual;
        nearestSlot = row.slotId;
      }
    }
    unmatchedExpected.push({ amount: exp, tolerance: tol, nearestActual, nearestSlot });
    misses.push(
      `opex_amount: exp ${exp} (±${tol}), nearest got ${nearestActual ?? "none"} in slot ${nearestSlot ?? "?"}`,
    );
  }

  const surplusActual = slotRows
    .filter((r) => !r.matched && r.actual >= MIN_EXPENSE_AMOUNT)
    .map((r) => ({ amount: r.actual, slotId: r.slotId, slotLabel: r.slotLabel }));

  const n = expAmounts.length;
  return {
    ok,
    n,
    pct: n ? (ok / n) * 100 : 0,
    misses,
    slotRows,
    unmatchedExpected,
    surplusActual,
  };
}

