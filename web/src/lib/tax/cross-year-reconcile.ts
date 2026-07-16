import { TAX_WORKBOOK_ROWS, type TaxYearValues } from "@/lib/tax-workbook";
import type { FieldTrustTier } from "@/lib/tax/field-trust-tier";
import { valuesExactlyEqual } from "./source-agreement";

const INPUT_IDS = TAX_WORKBOOK_ROWS.filter((r) => r.excelBehavior === "input").map((r) => r.id);

/** Minimum absolute value before YoY ratio checks apply. */
const YOY_MIN_ABS = 1_000;
/** Flag when newer vs prior year differs by this ratio or more (e.g. 1,000 vs 1,000,000). */
const YOY_RATIO_FLAG = 5;

function addFlag(flags: Record<string, string[]>, id: string, msg: string): void {
  const list = flags[id] ?? [];
  if (!list.includes(msg)) list.push(msg);
  flags[id] = list;
}

function formatCompact(n: number): string {
  return Math.round(n).toLocaleString();
}

function yoyRatio(a: number, b: number): number {
  const absA = Math.abs(a);
  const absB = Math.abs(b);
  return Math.max(absA, absB) / Math.max(Math.min(absA, absB), 1);
}

function yoyFlagMessage(priorYear: number, year: number, prior: number, current: number): string {
  const ratio = yoyRatio(current, prior);
  const ratioLabel = ratio >= 10 ? `${Math.round(ratio)}×` : `${ratio.toFixed(1)}×`;
  return `YoY ${priorYear}→${year}: ${formatCompact(prior)} → ${formatCompact(current)} (${ratioLabel}) — verify`;
}

/**
 * Flag implausible year-over-year jumps across uploaded columns. Does not change values.
 */
export function applyCrossYearFlags(columns: TaxYearValues[]): TaxYearValues[] {
  if (columns.length < 2) return columns;

  const sorted = [...columns].sort((a, b) => b.year - a.year);
  const byYear = new Map(columns.map((col) => [col.year, { ...col, fieldFlags: { ...(col.fieldFlags ?? {}) } }]));

  for (let i = 0; i < sorted.length - 1; i++) {
    const newer = sorted[i]!;
    const older = sorted[i + 1]!;

    for (const id of INPUT_IDS) {
      const current = newer.values[id];
      const prior = older.values[id];
      if (current === undefined || prior === undefined) continue;
      if (valuesExactlyEqual(current, prior)) continue;

      const maxAbs = Math.max(Math.abs(current), Math.abs(prior));
      if (maxAbs < YOY_MIN_ABS) continue;
      // 0 → first real amount (or reverse) is common across years; ratio is infinite noise.
      if (current === 0 || prior === 0) continue;

      const ratio = yoyRatio(current, prior);
      const signFlip = (current < 0) !== (prior < 0) && current !== 0 && prior !== 0;
      if (ratio < YOY_RATIO_FLAG && !signFlip) continue;

      const msg = yoyFlagMessage(older.year, newer.year, prior, current);
      const newerCol = byYear.get(newer.year)!;
      const olderCol = byYear.get(older.year)!;
      addFlag(newerCol.fieldFlags!, id, msg);
      addFlag(olderCol.fieldFlags!, id, msg);

      const setYoYReview = (col: TaxYearValues) => {
        if (col.fieldStatus?.[id] !== "missing") {
          col.fieldStatus = { ...(col.fieldStatus ?? {}), [id]: "review" };
        }
        col.fieldTrustTier = { ...(col.fieldTrustTier ?? {}), [id]: "moderate" as FieldTrustTier };
      };
      setYoYReview(newerCol);
      setYoYReview(olderCol);
    }
  }

  return Array.from(byYear.values()).sort((a, b) => b.year - a.year);
}
