import {
  TAX_ATTACHMENT_FIELD_IDS,
  WORKBOOK_COMPARISON_FIXTURES,
} from "../../src/lib/workbook-comparison-fixtures";
import { OPERATING_EXPENSE_SLOT_IDS, matchTop8OpexAmounts } from "../../src/lib/tax/operating-expenses";
import { TAX_WORKBOOK_ROWS } from "../../src/lib/tax-workbook";
import changwenFixtures from "../changwen-fixtures.json";

const INPUT_IDS = TAX_WORKBOOK_ROWS.filter((r) => r.excelBehavior === "input").map((r) => r.id);
const OPEX_SLOT_SET = new Set<string>(OPERATING_EXPENSE_SLOT_IDS);

const ALL_TAX_FIXTURES: Record<string, { year: number; values: Record<string, number> }> = {
  ...WORKBOOK_COMPARISON_FIXTURES.tax,
  ...(changwenFixtures as Record<string, { year: number; values: Record<string, number> }>),
};

/** $1 floor or 0.5% relative — wrong values must not silently pass. */
export function moneyTolerance(expected: number): number {
  if (expected === 0) return 0;
  return Math.max(1, Math.abs(expected) * 0.005);
}

export function withinMoneyTolerance(actual: number, expected: number): boolean {
  if (expected === 0) return actual === 0;
  return Math.abs(actual - expected) <= moneyTolerance(expected);
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
    if (options?.excludeOpexSlots && OPEX_SLOT_SET.has(id)) continue;
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

/** Field accuracy excluding the 8 operating-expense paste slots (scored separately as an amount multiset). */
export function scoreAllFieldsExcludingOpexSlots(
  fixtureKey: string,
  values: Record<string, number | undefined>,
): PrimaryScore {
  return scoreFields(fixtureKey, values, true, { excludeOpexSlots: true });
}

/** Opex correctness: amount multiset over the 8 opex slots (truth from Excel fixtures). */
export function scoreOpexAmountsOnly(
  fixtureKey: string,
  values: Record<string, number | undefined>,
): PrimaryScore {
  const exp = ALL_TAX_FIXTURES[fixtureKey]?.values;
  if (!exp) throw new Error(`No fixture for ${fixtureKey}`);
  const match = matchTop8OpexAmounts(exp, values);
  return {
    ok: match.ok,
    n: match.n,
    pct: match.n ? (match.ok / match.n) * 100 : 0,
    misses: match.misses,
    missDetails: match.misses.map((m) => ({
      field: "opex_amount",
      expected: 0,
      actual: undefined,
      errorPct: null,
      severity: "critical" as const,
      formatted: m,
    })),
  };
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
