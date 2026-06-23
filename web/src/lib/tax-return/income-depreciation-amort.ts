import type { FieldExtraction } from "./form-anchors";
import {
  isForm1120Line,
  scheduleLineAmount,
  substantialMoneyTokens,
} from "./money";
import type { ResolvedFields } from "./merge";
import {
  pickComparisonColumnIndex,
  shrinkToYearColumns,
} from "@/lib/two-year-comparison-parser";
import { isWeakSource } from "./confidence-gates";

function nearEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(2, Math.abs(b) * 0.01);
}

export function isFullyAmortizedIntangibles(resolved: ResolvedFields): boolean {
  const gross = resolved.values.gross_intangible_assets;
  const acc = resolved.values.accumulated_amortization;
  if (gross === undefined || acc === undefined || gross < 10_000) return false;
  return nearEqual(acc, gross);
}

export function hasNoIntangibleAssets(resolved: ResolvedFields): boolean {
  const gross = resolved.values.gross_intangible_assets ?? 0;
  const acc = resolved.values.accumulated_amortization ?? 0;
  return gross === 0 && acc === 0;
}

/** Value equals a balance-sheet accumulated line — wrong field family for P&L dep/amort. */
function matchesBalanceSheetTrap(
  value: number,
  resolved: ResolvedFields,
  trapIds: readonly string[],
): boolean {
  for (const trapId of trapIds) {
    const trap = resolved.values[trapId];
    if (trap !== undefined && nearEqual(value, trap)) return true;
  }
  return false;
}

function parseMoneyFromLine(line: string): number[] {
  const nums: number[] = [];
  for (const m of Array.from(line.matchAll(/\(?\$?\s*-?\d[\d,]*(?:\.\d{2})?\s*\)?/g))) {
    const raw = m[0].replace(/[$,]/g, "");
    let s = raw.trim();
    let sign = 1;
    if (s.startsWith("(") && s.endsWith(")")) {
      sign = -1;
      s = s.slice(1, -1);
    }
    const n = Number(s);
    if (Number.isFinite(n)) nums.push(Math.round(sign * n));
  }
  return nums;
}

/** Scan two-year comparison worksheet for a P&L depreciation / amortization row. */
export function scanComparisonIsExpense(
  text: string,
  targetYear: number,
  field: "depreciation" | "amortization",
): { value: number; confidence: number } | undefined {
  const labelRe = field === "depreciation" ? /^DEPRECIATION\b/i : /^AMORTIZATION\b/i;
  const compCtx =
    /(?:\bg\s*)?ross\s+receipts?\s+or\s+sales|two\s*year\s*comparison|t\w{0,3}\s*y\s*ear\s*\w{0,6}\s*omparison/i;

  let col: 0 | 1 = 1;
  const headerM = text.match(/\b(20\d{2})\s*[\&\-–]\s*(20\d{2})\b/);
  if (headerM) {
    col = pickComparisonColumnIndex(Number(headerM[1]), Number(headerM[2]), targetYear);
  }

  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!labelRe.test(line) || /accumulated|adjustment|report|schedule\s*l/i.test(line)) continue;
    if (!compCtx.test(text.slice(Math.max(0, text.indexOf(line) - 500), text.indexOf(line) + line.length))) {
      continue;
    }

    const pair = shrinkToYearColumns(parseMoneyFromLine(line).filter((n) => n < 2020 || n > 2035));
    if (!pair) {
      if (field === "depreciation" && /depreciation/i.test(line) && !substantialMoneyTokens(line).length) {
        return { value: 0, confidence: 90 };
      }
      continue;
    }

    const picked = col === 0 ? pair[0] : pair[1];
    return { value: Math.round(picked), confidence: 90 };
  }

  return undefined;
}

/** Form 4562 current-year amortization (Part VI). */
export function scanForm4562Amortization(text: string): { value: number; confidence: number } | undefined {
  const block = text.match(/form\s*4562[\s\S]{0,12000}/i)?.[0];
  if (!block) return undefined;

  for (const rawLine of block.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!/amortization/i.test(line) || /accumulated|less\s+acc|gross\s+intangible|beginning|ending/i.test(line)) {
      continue;
    }
    const amt = scheduleLineAmount(line);
    if (amt === undefined) continue;
    if (amt >= 2020 && amt <= 2035) continue;
    return { value: Math.round(amt), confidence: 94 };
  }

  return undefined;
}

/** Stmt detail row labeled amortization (Statement 2 other deductions). */
export function scanStatementAmortization(text: string): { value: number; confidence: number } | undefined {
  const stmt2Blocks: string[] = [];
  const re =
    /(?:statement|stmt|tatement)\s*2\b[\s\S]{0,2200}?(?=(?:statement|stmt|tatement)\s*[3-9]\b|1-5\b)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) stmt2Blocks.push(m[0]);

  const scanBlock = (block: string, conf: number, source: string): { value: number; confidence: number } | undefined => {
    for (const rawLine of block.split(/\n/)) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (!/\bamortization\b/i.test(line) || /accumulated|less\s+acc|gross\s+intang|schedule\s*l/i.test(line)) {
        continue;
      }
      const amt = scheduleLineAmount(line);
      if (amt === undefined || (amt >= 2020 && amt <= 2035)) continue;
      if (amt >= 50_000_000 || amt > 100_000) continue;
      return { value: Math.round(amt), confidence: conf };
    }
    return undefined;
  };

  for (const block of stmt2Blocks) {
    const hit = scanBlock(block, 94, "Statement 2 amortization");
    if (hit) return hit;
  }

  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!/\bamortization\b/i.test(line) || /accumulated|less\s+acc|gross\s+intang|schedule\s*l/i.test(line)) {
      continue;
    }
    if (
      !/statement|stmt|deduction|line\s*20|federal\s+statements/i.test(line) &&
      !/statement|stmt|federal\s+statements/i.test(text.slice(Math.max(0, text.indexOf(line) - 300), text.indexOf(line)))
    ) {
      continue;
    }
    const amt = scheduleLineAmount(line);
    if (amt === undefined || (amt >= 2020 && amt <= 2035)) continue;
    return { value: Math.round(amt), confidence: 92 };
  }
  return undefined;
}

function setField(
  resolved: ResolvedFields,
  id: "depreciation" | "amortization",
  value: number,
  source: string,
  confidence: number,
): void {
  resolved.values[id] = value;
  resolved.confidence[id] = confidence;
  resolved.sources[id] = source;
}

type CrossRefCandidate = {
  value: number;
  source: string;
  confidence: number;
  family: "comparison" | "form" | "statement" | "form4562";
};

function isPlausibleComparisonCandidate(
  field: "depreciation" | "amortization",
  value: number,
): boolean {
  const abs = Math.abs(value);
  if (abs >= 2020 && abs <= 2035) return false;
  if (abs <= 99 && value !== 0) return false;
  if (field === "amortization" && abs > 0 && abs < 500) return false;
  if (field === "amortization" && abs > 100_000) return false;
  if (field === "depreciation" && abs > 500_000) return false;
  return true;
}

function pickCrossReferenced(
  field: "depreciation" | "amortization",
  candidates: CrossRefCandidate[],
  balanceTraps: readonly string[],
  resolved: ResolvedFields,
): CrossRefCandidate | undefined {
  const valid = candidates.filter(
    (c) =>
      !matchesBalanceSheetTrap(c.value, resolved, balanceTraps) &&
      (c.family !== "comparison" || isPlausibleComparisonCandidate(field, c.value)),
  );
  if (!valid.length) return undefined;

  if (field === "amortization" && isFullyAmortizedIntangibles(resolved)) {
    const zero = valid.find((c) => c.value === 0);
    if (zero) return zero;
    const nonNoise = valid.filter((c) => c.family !== "statement" || c.value >= 500);
    if (nonNoise.length) {
      const comparison = nonNoise.find((c) => c.family === "comparison");
      if (comparison) return comparison;
      return nonNoise.sort((a, b) => b.confidence - a.confidence)[0];
    }
    return undefined;
  }

  if (field === "amortization" && hasNoIntangibleAssets(resolved)) {
    const zero = valid.find((c) => c.value === 0);
    if (zero) return zero;
    const small = valid.filter((c) => Math.abs(c.value) < 100_000);
    if (small.length) return small.sort((a, b) => b.confidence - a.confidence)[0];
    return undefined;
  }

  const comparison = valid.find((c) => c.family === "comparison");
  const statement = valid.find((c) => c.family === "statement");

  if (field === "amortization" && statement && statement.value > 500) {
    if (!comparison || comparison.value === 0 || comparison.value < 500) {
      return statement;
    }
  }

  if (comparison) return comparison;

  const agreeing = valid.filter((c) =>
    valid.some((other) => other !== c && nearEqual(c.value, other.value)),
  );
  if (agreeing.length) {
    return agreeing.sort((a, b) => b.confidence - a.confidence)[0];
  }

  const form = valid.find((c) => c.family === "form");
  if (form) return form;

  return valid.sort((a, b) => b.confidence - a.confidence)[0];
}

/**
 * Cross-reference P&L depreciation & amortization.
 * Two-year comparison worksheet wins when present; never pick by dollar magnitude.
 */
export function reconcileDepreciationAmortization(
  resolved: ResolvedFields,
  ctx: {
    formAnchors: FieldExtraction;
    formPage1: string;
    allText: string;
    targetYear: number;
    comparison?: { values: Record<string, number>; confidence: Record<string, number>; linesMatched: number } | null;
  },
): void {
  const compOk = (ctx.comparison?.linesMatched ?? 0) >= 3;
  const depTraps = ["accumulated_depreciation", "gross_fixed_assets"] as const;
  const amortTraps = ["accumulated_amortization", "gross_intangible_assets"] as const;

  const depCandidates: CrossRefCandidate[] = [];
  if (compOk && ctx.comparison?.values.depreciation !== undefined) {
    depCandidates.push({
      value: ctx.comparison.values.depreciation,
      source: "Two-year comparison (DEPRECIATION)",
      confidence: ctx.comparison.confidence.depreciation ?? 90,
      family: "comparison",
    });
  }
  const scannedDep = scanComparisonIsExpense(ctx.allText, ctx.targetYear, "depreciation");
  if (scannedDep && !depCandidates.some((c) => nearEqual(c.value, scannedDep.value))) {
    depCandidates.push({
      value: scannedDep.value,
      source: "Two-year comparison (DEPRECIATION row)",
      confidence: scannedDep.confidence,
      family: "comparison",
    });
  }
  if (ctx.formAnchors.values.depreciation !== undefined) {
    depCandidates.push({
      value: ctx.formAnchors.values.depreciation,
      source: ctx.formAnchors.sources?.depreciation ?? "Form 1120-S line 14",
      confidence: ctx.formAnchors.confidence.depreciation ?? 97,
      family: "form",
    });
  } else {
    const depLine = ctx.formPage1.split(/\n/).find((row) => {
      const line = row.replace(/\s+/g, " ").trim();
      return isForm1120Line(line, 14) && /depreciation/i.test(line) && !/accum/i.test(line);
    });
    if (depLine && !substantialMoneyTokens(depLine).length) {
      depCandidates.push({
        value: 0,
        source: "Form 1120-S line 14 (blank)",
        confidence: 96,
        family: "form",
      });
    }
  }

  const depPick = pickCrossReferenced("depreciation", depCandidates, depTraps, resolved);
  if (depPick) {
    setField(resolved, "depreciation", depPick.value, depPick.source, depPick.confidence);
  } else if (
    resolved.values.depreciation !== undefined &&
    matchesBalanceSheetTrap(resolved.values.depreciation, resolved, depTraps)
  ) {
    delete resolved.values.depreciation;
    delete resolved.confidence.depreciation;
    delete resolved.sources.depreciation;
    resolved.warnings.push("Cleared depreciation (matched balance-sheet accumulated amount; no cross-reference)");
  }

  const amortCandidates: CrossRefCandidate[] = [];
  if (compOk && ctx.comparison?.values.amortization !== undefined) {
    amortCandidates.push({
      value: ctx.comparison.values.amortization,
      source: "Two-year comparison (AMORTIZATION)",
      confidence: ctx.comparison.confidence.amortization ?? 90,
      family: "comparison",
    });
  }
  const scannedAmort = scanComparisonIsExpense(ctx.allText, ctx.targetYear, "amortization");
  if (scannedAmort && !amortCandidates.some((c) => nearEqual(c.value, scannedAmort.value))) {
    amortCandidates.push({
      value: scannedAmort.value,
      source: "Two-year comparison (AMORTIZATION row)",
      confidence: scannedAmort.confidence,
      family: "comparison",
    });
  }
  const f4562 = scanForm4562Amortization(ctx.allText);
  if (f4562) {
    amortCandidates.push({
      value: f4562.value,
      source: "Form 4562 amortization",
      confidence: f4562.confidence,
      family: "form4562",
    });
  }
  const stmtAmort = scanStatementAmortization(ctx.allText);
  if (stmtAmort) {
    amortCandidates.push({
      value: stmtAmort.value,
      source: "Statement amortization detail",
      confidence: stmtAmort.confidence,
      family: "statement",
    });
  }

  const amortPick = pickCrossReferenced("amortization", amortCandidates, amortTraps, resolved);
  if (amortPick) {
    setField(resolved, "amortization", amortPick.value, amortPick.source, amortPick.confidence);
  } else if (
    resolved.values.amortization !== undefined &&
    matchesBalanceSheetTrap(resolved.values.amortization, resolved, amortTraps)
  ) {
    delete resolved.values.amortization;
    delete resolved.confidence.amortization;
    delete resolved.sources.amortization;
    resolved.warnings.push("Cleared amortization (matched balance-sheet accumulated amount; no cross-reference)");
  } else if (
    resolved.values.amortization !== undefined &&
    isWeakSource(resolved.sources.amortization) &&
    matchesBalanceSheetTrap(resolved.values.amortization, resolved, amortTraps)
  ) {
    delete resolved.values.amortization;
    delete resolved.confidence.amortization;
    delete resolved.sources.amortization;
  }

  if (resolved.values.amortization === undefined && compOk && ctx.comparison?.values.amortization === 0) {
    setField(resolved, "amortization", 0, "Two-year comparison (AMORTIZATION zero)", 88);
  }
}
