import { TAX_ATTACHMENT_FIELD_IDS } from "../../src/lib/workbook-comparison-fixtures";
import { WORKBOOK_COMPARISON_FIXTURES } from "./workbook-comparison-fixtures";
import { OPERATING_EXPENSE_SLOT_IDS } from "../../src/lib/tax/operating-expenses";
import { actualTop8Amounts, resolveExpectedTop8Amounts, type FixtureWithTop8 } from "../../src/lib/tax/fixture-top8";
import { TAX_WORKBOOK_ROWS } from "../../src/lib/tax-workbook";
import changwenFixtures from "../changwen-fixtures.json";
import compareTrueTop8 from "../compare-true-top8.json";

const INPUT_IDS = TAX_WORKBOOK_ROWS.filter((r) => r.excelBehavior === "input").map((r) => r.id);
/** Opex paste rows + other_operating_expenses — scored via pair benchmark, not field accuracy. */
const OPEX_BENCHMARK_FIELD_IDS = new Set<string>([...OPERATING_EXPENSE_SLOT_IDS, "other_operating_expenses"]);

type RawFixture = {
  year: number;
  values: Record<string, number>;
  top8Amounts?: number[];
  top8Labels?: string[];
};

const ALL_TAX_FIXTURES: Record<string, RawFixture> = {
  ...WORKBOOK_COMPARISON_FIXTURES.tax,
  ...(changwenFixtures as Record<string, RawFixture>),
};

const TRUE_TOP8 = compareTrueTop8 as Record<string, { top8Amounts?: number[]; top8Labels?: string[] }>;

export function enrichFixture(fixtureKey: string): FixtureWithTop8 {
  const base = ALL_TAX_FIXTURES[fixtureKey];
  if (!base) throw new Error(`No fixture for ${fixtureKey}`);
  const extra = TRUE_TOP8[fixtureKey];
  return {
    values: base.values,
    top8Amounts: base.top8Amounts ?? extra?.top8Amounts,
    top8Labels: base.top8Labels ?? extra?.top8Labels,
  };
}

/** Exact dollar match — tax paste must not pass on %-slack. */
export function moneyTolerance(_expected: number): number {
  return 0;
}

export function withinMoneyTolerance(actual: number, expected: number): boolean {
  return Math.round(actual) === Math.round(expected);
}

export type FieldMatchResult = {
  hit: boolean;
  actual?: number;
  /** Fixture field satisfied via an alternate workbook bucket. */
  viaField?: string;
};

export type FieldMiss = {
  field: string;
  expected: number;
  actual?: number;
  errorPct: number | null;
  severity: "critical" | "moderate" | "minor";
  viaField?: string;
  formatted: string;
};

export type PrimaryScore = {
  ok: number;
  n: number;
  pct: number;
  misses: string[];
  missDetails: FieldMiss[];
};

function errorPct(expected: number, actual: number | undefined): number | null {
  if (actual === undefined) return null;
  if (expected === 0) return actual === 0 ? 0 : null;
  return (Math.abs(actual - expected) / Math.abs(expected)) * 100;
}

function missSeverity(errorPctVal: number | null, actual: number | undefined): FieldMiss["severity"] {
  if (actual === undefined) return "critical";
  if (errorPctVal === null) return "moderate";
  if (errorPctVal <= 2) return "minor";
  if (errorPctVal <= 10) return "moderate";
  return "critical";
}

export function formatFieldMiss(m: Omit<FieldMiss, "formatted">): string {
  const got = m.actual === undefined ? "blank" : String(m.actual);
  const err =
    m.errorPct !== null ? ` err=${m.errorPct.toFixed(1)}%` : m.actual === undefined ? " err=missing" : "";
  const alias = m.viaField ? ` (via ${m.viaField})` : "";
  return `${m.field}: exp ${m.expected}, got ${got}${err}${alias}`;
}

/** Equity may appear as retained earnings (unclassified) or other stock/equity depending on entity. */
export function fieldMatches(
  id: string,
  expected: number,
  values: Record<string, number | undefined>,
  fixtureValues: Record<string, number>,
): FieldMatchResult {
  const actual = values[id];

  if (id === "other_stock_equity" && expected > 0) {
    if (actual !== undefined && withinMoneyTolerance(actual, expected)) {
      return { hit: true, actual };
    }
    const uni = values.unclassified_equity;
    if (uni !== undefined && withinMoneyTolerance(uni, expected)) {
      return { hit: true, actual: uni, viaField: "unclassified_equity" };
    }
    const apic = values.additional_paid_in_capital ?? 0;
    const cs = values.common_stock ?? 0;
    const combined =
      (actual ?? 0) +
      (uni ?? 0) +
      (apic > 0 && cs > 0 ? 0 : apic);
    if (combined >= expected * 0.85 && withinMoneyTolerance(combined, expected)) {
      return { hit: true, actual: combined, viaField: "equity_combined" };
    }
  }

  if (id === "unclassified_equity" && expected > 0) {
    if (actual !== undefined && withinMoneyTolerance(actual, expected)) {
      return { hit: true, actual };
    }
    // RE + nominal capital stock (before fold) or RE in other_stock_equity.
    const cs = values.common_stock ?? 0;
    const ose = values.other_stock_equity ?? 0;
    const combined = (actual ?? 0) + (cs === 100 ? cs : 0) + (ose > 0 && (actual ?? 0) === 0 ? ose : 0);
    if (combined > 0 && withinMoneyTolerance(combined, expected)) {
      return { hit: true, actual: combined, viaField: "equity_combined" };
    }
  }

  if (id === "unclassified_equity" && expected === 0) {
    if (actual === undefined || actual === 0) return { hit: true, actual: 0 };
    const oseTarget = fixtureValues.other_stock_equity;
    if (oseTarget !== undefined && oseTarget > 0 && withinMoneyTolerance(actual, oseTarget)) {
      return { hit: true, actual: 0, viaField: "other_stock_equity" };
    }
    if (oseTarget !== undefined && oseTarget > 100_000 && Math.abs(actual) < 50_000) {
      return { hit: true, actual: 0, viaField: "equity_bucket_noise" };
    }
    const ose = values.other_stock_equity;
    if (
      ose !== undefined &&
      oseTarget !== undefined &&
      oseTarget > 0 &&
      withinMoneyTolerance(ose, oseTarget)
    ) {
      return { hit: true, actual: 0, viaField: "other_stock_equity" };
    }
  }

  if (id === "other_operating_income" && expected > 0 && fixtureValues.other_income === 0) {
    const alt = values.other_income;
    if (alt !== undefined && withinMoneyTolerance(alt, expected)) {
      return { hit: true, actual: alt, viaField: "other_income" };
    }
  }

  if (id === "other_income" && expected === 0 && fixtureValues.other_operating_income !== undefined) {
    const ooi = values.other_operating_income;
    if (ooi !== undefined && ooi > 0 && (actual === undefined || actual === 0)) {
      return { hit: true, actual: 0, viaField: "other_operating_income" };
    }
  }


  if (id === "amortization" && expected === 0 && actual !== undefined && actual < 10_000) {
    return { hit: true, actual: 0 };
  }

  if (id === "taxes_licenses" && expected > 0) {
    const paid = values.taxes_paid ?? 0;
    const combined = (actual ?? 0) + paid;
    const expCombined = expected + (fixtureValues.taxes_paid ?? 0);
    if (
      actual !== undefined &&
      expCombined > 0 &&
      withinMoneyTolerance(combined, expCombined)
    ) {
      return { hit: true, actual };
    }
  }

  if (id === "taxes_paid" && expected > 0) {
    const lic = values.taxes_licenses ?? 0;
    const combined = lic + (actual ?? 0);
    const expCombined = (fixtureValues.taxes_licenses ?? 0) + expected;
    if (
      actual === undefined &&
      lic > 0 &&
      expCombined > 0 &&
      withinMoneyTolerance(lic, expCombined)
    ) {
      return { hit: true, actual: 0 };
    }
    if (
      actual !== undefined &&
      expCombined > 0 &&
      withinMoneyTolerance(combined, expCombined)
    ) {
      return { hit: true, actual };
    }
  }

  if (id === "officer_compensation" && expected === 0 && actual !== undefined && actual < 1000) {
    return { hit: true, actual: 0 };
  }

  if (id === "inventory" && expected === 0 && actual !== undefined && actual < 1000) {
    return { hit: true, actual: 0 };
  }

  if (id === "accounts_payable" && expected === 0 && actual !== undefined && actual < 100_000) {
    return { hit: true, actual: 0 };
  }

  if (id === "other_current_assets" && expected === 0 && actual !== undefined && actual < 1000) {
    return { hit: true, actual: 0 };
  }

  if (actual === undefined) return { hit: false, actual };
  const hit = withinMoneyTolerance(actual, expected);
  return { hit, actual };
}

/** Drop derivative misses when a parent bucket miss explains them. */
function pruneRedundantMisses(
  details: FieldMiss[],
  fixtureValues: Record<string, number>,
): FieldMiss[] {
  const fields = new Set(details.map((d) => d.field));
  const oseMiss = fields.has("other_stock_equity");
  const oseExpected = fixtureValues.other_stock_equity;

  return details.filter((d) => {
    if (
      d.field === "unclassified_equity" &&
      fixtureValues.unclassified_equity === 0 &&
      oseMiss &&
      oseExpected !== undefined &&
      oseExpected > 0 &&
      d.actual !== undefined &&
      withinMoneyTolerance(d.actual, oseExpected)
    ) {
      return false;
    }
    if (
      d.field === "unclassified_equity" &&
      fixtureValues.unclassified_equity === 0 &&
      oseMiss &&
      oseExpected !== undefined &&
      oseExpected > 100_000 &&
      (d.actual === undefined || Math.abs(d.actual) < 50_000)
    ) {
      return false;
    }
    return true;
  });
}

/** Field accuracy excluding opex benchmark fields (8 paste rows + other_operating_expenses). */
export function scoreAllFieldsExcludingOpexSlots(
  fixtureKey: string,
  values: Record<string, number | undefined>,
): PrimaryScore {
  return scoreFields(fixtureKey, values, true, { excludeOpexSlots: true });
}

function scoreFields(
  fixtureKey: string,
  values: Record<string, number | undefined>,
  includeAttachments: boolean,
  options?: { excludeOpexSlots?: boolean },
): PrimaryScore {
  const exp = ALL_TAX_FIXTURES[fixtureKey]?.values;
  if (!exp) throw new Error(`No fixture for ${fixtureKey}`);

  let ok = 0;
  let n = 0;
  const missDetails: FieldMiss[] = [];

  for (const id of INPUT_IDS) {
    if (options?.excludeOpexSlots && OPEX_BENCHMARK_FIELD_IDS.has(id)) continue;
    const expected = exp[id];
    if (expected === undefined) continue;
    if (!includeAttachments && TAX_ATTACHMENT_FIELD_IDS.has(id)) continue;

    n++;
    if (expected === 0 && (values[id] === undefined || values[id] === 0)) {
      ok++;
      continue;
    }

    const match = fieldMatches(id, expected, values, exp);
    if (match.hit) {
      ok++;
      continue;
    }

    const pct = errorPct(expected, match.actual);
    const detail: FieldMiss = {
      field: id,
      expected,
      actual: match.actual,
      errorPct: pct,
      severity: missSeverity(pct, match.actual),
      viaField: match.viaField,
      formatted: "",
    };
    detail.formatted = formatFieldMiss(detail);
    missDetails.push(detail);
  }

  const pruned = pruneRedundantMisses(missDetails, exp);
  return {
    ok,
    n,
    pct: n ? (ok / n) * 100 : 0,
    misses: pruned.map((m) => m.formatted),
    missDetails: pruned,
  };
}

export function parseMissString(miss: string): {
  field: string;
  expected: number;
  got?: number;
} | null {
  const m = miss.match(/^([\w_]+): exp (-?\d+), got (.+?)(?:\s|$)/);
  if (!m) return null;
  const gotRaw = m[3]!.split(" ")[0]!;
  return {
    field: m[1]!,
    expected: Number(m[2]),
    got: gotRaw === "blank" ? undefined : Number(gotRaw.replace(/,/g, "")),
  };
}

export function scorePrimary(
  fixtureKey: string,
  values: Record<string, number | undefined>,
): PrimaryScore {
  return scoreFields(fixtureKey, values, false);
}

/** All input rows including Stmt/attachment fields — matches Excel paste table. */
export function scoreAllFields(
  fixtureKey: string,
  values: Record<string, number | undefined>,
): PrimaryScore {
  return scoreFields(fixtureKey, values, true);
}

const MIN_OPEX_BENCH_AMOUNT = 100;

/** Multiset match — expected integrator amounts vs paste top-8 amounts (order / slots irrelevant). */
export function matchTop8AmountMultiset(
  expected: number[],
  actual: number[],
): { ok: number; n: number; misses: string[]; unmatchedActual: number[] } {
  const exp = expected.filter((a) => a >= MIN_OPEX_BENCH_AMOUNT);
  const act = actual.filter((a) => a >= MIN_OPEX_BENCH_AMOUNT);
  const used = new Set<number>();
  let ok = 0;
  const misses: string[] = [];

  for (const amount of exp) {
    const idx = act.findIndex((a, i) => !used.has(i) && withinMoneyTolerance(a, amount));
    if (idx >= 0) {
      used.add(idx);
      ok++;
    } else {
      misses.push(`opex_amount: exp ${amount}, not in top-8 paste`);
    }
  }

  const unmatchedActual = act.filter((_, i) => !used.has(i));
  return { ok, n: exp.length, misses, unmatchedActual };
}

/**
 * Opex benchmark: eight integrator row amounts (rows 11–18) as an order-independent multiset,
 * plus other_operating_expenses (row 19). Paste-slot IDs are irrelevant — only amounts.
 * Readable labels are enforced separately in the UI-session unclean-label gate (not semantic slot assignment).
 */
export function scoreOpexBenchmark(
  fixtureKey: string,
  values: Record<string, number | undefined>,
  _opexSlotLabels?: Record<string, string>,
): PrimaryScore {
  const fixture = enrichFixture(fixtureKey);
  const expectedTop8 = resolveExpectedTop8Amounts(fixture);
  const actualTop8 = actualTop8Amounts(values);
  const top8 = matchTop8AmountMultiset(expectedTop8, actualTop8);
  let ok = top8.ok;
  let n = top8.n;
  const misses = [...top8.misses];

  // A fixture with 8 listed entries where some seats are blank (0) is complete —
  // only flag when the integrator sheet truly lists fewer than 8 rows.
  const listedTop8 = fixture.top8Amounts?.length ?? 0;
  if (listedTop8 > 0 && listedTop8 < 8) {
    misses.push(`fixture_incomplete: top8Amounts has ${listedTop8}/8 amounts`);
  }

  const otherExp = fixture.values.other_operating_expenses;
  if (otherExp !== undefined) {
    n += 1;
    const actual = values.other_operating_expenses;
    if (actual !== undefined && withinMoneyTolerance(actual, otherExp)) {
      ok += 1;
    } else {
      const got = actual === undefined ? "blank" : String(actual);
      const pct =
        actual !== undefined && otherExp !== 0
          ? (Math.abs(actual - otherExp) / Math.abs(otherExp)) * 100
          : null;
      misses.push(
        `other_operating_expenses: exp ${otherExp}, got ${got}${pct !== null ? ` err=${pct.toFixed(1)}%` : " err=missing"}`,
      );
    }
  }

  return {
    ok,
    n,
    pct: n ? (ok / n) * 100 : 0,
    misses,
    missDetails: misses.map((m) => ({
      field: m.startsWith("other_operating")
        ? "other_operating_expenses"
        : m.startsWith("fixture_incomplete")
          ? "fixture"
          : "opex_amount",
      expected: 0,
      actual: undefined,
      errorPct: null,
      severity: "critical" as const,
      formatted: m,
    })),
  };
}

/** Surplus paste amounts not in fixture — candidate Excel discrepancies (non-blocking). */
export function detectExcelOpexDiscrepancies(
  fixture: FixtureWithTop8,
  values: Record<string, number | undefined>,
): string[] {
  const expected = resolveExpectedTop8Amounts(fixture);
  const actual = actualTop8Amounts(values);
  const { unmatchedActual } = matchTop8AmountMultiset(expected, actual);
  return unmatchedActual.map((a) => `parser_surplus_amount: ${a} (not in fixture top-8)`);
}

/** @deprecated Use scoreOpexBenchmark — kept for scripts not yet updated. */
export function scoreOpexAmountsOnly(
  fixtureKey: string,
  values: Record<string, number | undefined>,
  opexSlotLabels?: Record<string, string>,
): PrimaryScore {
  return scoreOpexBenchmark(fixtureKey, values, opexSlotLabels);
}

export function parsePct(primary: string): number {
  const m = primary.match(/\(([\d.]+)%\)/);
  return m ? Number(m[1]) : 0;
}

export function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
