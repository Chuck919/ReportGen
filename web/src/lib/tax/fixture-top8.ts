import { OPERATING_EXPENSE_SLOT_IDS } from "@/lib/tax/operating-expenses";

const MIN_OPEX_AMOUNT = 100;

export type FixtureWithTop8 = {
  values: Record<string, number>;
  /** Eight integrator row amounts (rows 11–18) — order irrelevant for multiset scoring. */
  top8Amounts?: number[];
};

/** Expected top-8 dollar amounts for benchmark multiset (not tied to slot IDs). */
export function resolveExpectedTop8Amounts(fixture: FixtureWithTop8): number[] {
  if (fixture.top8Amounts?.length) {
    return fixture.top8Amounts.filter((a) => a >= MIN_OPEX_AMOUNT);
  }
  return OPERATING_EXPENSE_SLOT_IDS.map((id) => fixture.values[id]).filter(
    (a): a is number => typeof a === "number" && a >= MIN_OPEX_AMOUNT,
  );
}

/** Parser/display top-8 amounts from the eight workbook paste positions. */
export function actualTop8Amounts(values: Record<string, number | undefined>): number[] {
  return OPERATING_EXPENSE_SLOT_IDS.map((id) => Math.round(values[id] ?? 0)).filter(
    (a) => a >= MIN_OPEX_AMOUNT,
  );
}
