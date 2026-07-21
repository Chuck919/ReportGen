import type { FieldExtraction } from "./form-anchors";
import {
  isForm1120Line,
  isReasonableMoneyAmount,
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
  return Math.round(a) === Math.round(b);
}

export function isFullyAmortizedIntangibles(resolved: ResolvedFields): boolean {
  const gross = resolved.values.gross_intangible_assets;
  const acc = resolved.values.accumulated_amortization;
  if (gross === undefined || acc === undefined || gross <= 0) return false;
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

  const yearMatches = [...text.matchAll(/\b(20\d{2})\s*[\&\-–]\s*(20\d{2})\b/g)];
  const docYears = yearMatches.length
    ? { yL: Number(yearMatches[yearMatches.length - 1]![1]), yR: Number(yearMatches[yearMatches.length - 1]![2]) }
    : undefined;
  let col: 0 | 1 = 1;
  if (docYears) {
    col = pickComparisonColumnIndex(docYears.yL, docYears.yR, targetYear);
  }

  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!labelRe.test(line) || /accumulated|adjustment|report|schedule\s*l|post-1986/i.test(line)) continue;
    const localWindow = text.slice(Math.max(0, text.indexOf(line) - 500), text.indexOf(line) + line.length);
    const inCompCtx = compCtx.test(localWindow);
    const inDeductionSummary =
      /TOTAL DEDUCTIONS|ORDINARY BUSINESS INCOME/i.test(localWindow) && labelRe.test(line);
    if (!inCompCtx && !inDeductionSummary) continue;

    const pair = shrinkToYearColumns(
      parseMoneyFromLine(line).filter((n) => (n < 2020 || n > 2035) && n !== 1986 && n !== 1987),
    );
    if (!pair) {
      if (field === "depreciation" && /depreciation/i.test(line) && !substantialMoneyTokens(line).length) {
        return { value: 0, confidence: 90 };
      }
      continue;
    }

    const picked = col === 0 ? pair[0]! : pair[1]!;
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
    if (/omb\s*no|paperwork\s+reduction/i.test(line)) continue;
    const amt = scheduleLineAmount(line);
    if (amt === undefined) continue;
    if (amt >= 2020 && amt <= 2035) continue;
    if (!isReasonableMoneyAmount(amt)) continue;
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

  const scanBlock = (block: string, conf: number, _source: string): { value: number; confidence: number } | undefined => {
    void _source;
    for (const rawLine of block.split(/\n/)) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (!/\bamortization\b/i.test(line) || /accumulated|less\s+acc|gross\s+intang|schedule\s*l/i.test(line)) {
        continue;
      }
      const amt = scheduleLineAmount(line);
      if (amt === undefined || (amt >= 2020 && amt <= 2035)) continue;
      if (!isReasonableMoneyAmount(amt)) continue;
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
    if (/omb\s*no|form\s*4562|paperwork\s+reduction/i.test(line)) continue;
    const amt = scheduleLineAmount(line);
    if (amt === undefined || (amt >= 2020 && amt <= 2035)) continue;
    const abs = Math.round(Math.abs(amt));
    if (!isReasonableMoneyAmount(abs)) continue;
    return { value: abs, confidence: 92 };
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

function isPlausibleComparisonCandidate(value: number): boolean {
  const abs = Math.abs(value);
  if (abs >= 2020 && abs <= 2035) return false;
  if (abs === 1986 || abs === 1987) return false;
  if (value !== 0 && !isReasonableMoneyAmount(value)) return false;
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
      (c.value === 0 || isReasonableMoneyAmount(c.value)) &&
      !matchesBalanceSheetTrap(c.value, resolved, balanceTraps) &&
      (c.family !== "comparison" || isPlausibleComparisonCandidate(c.value)),
  );
  if (!valid.length) return undefined;

  if (field === "amortization" && isFullyAmortizedIntangibles(resolved)) {
    // Book Schedule L can look fully amortized while Form/Stmt still has current-year P&L amort.
    const formOrStmt = valid.find(
      (c) =>
        (c.family === "form" || c.family === "form4562" || c.family === "statement") &&
        c.value > 0,
    );
    if (formOrStmt) return formOrStmt;
    const zero = valid.find((c) => c.value === 0);
    if (zero) return zero;
    return valid.sort((a, b) => b.confidence - a.confidence)[0];
  }

  if (field === "amortization" && hasNoIntangibleAssets(resolved)) {
    // When balance sheet shows no intangible assets at all (gross=0, accum=0),
    // amortization expense must be $0 — veto any non-zero candidates as OCR noise.
    const zero = valid.find((c) => c.value === 0);
    if (zero) return zero;
    // No zero candidate found — return undefined instead of the best non-zero guess
    return undefined;
  }

  // Prefer Form / statement / Form-4562 / NET DEPRECIATION over comparison worksheet.
  // Comparison often doubles or picks the wrong year column — not a soft-% veto.
  const formNet = valid.find(
    (c) => c.family === "form" && /NET\s+DEPRECIATION/i.test(c.source),
  );
  if (formNet) return formNet;
  const form = valid.find((c) => c.family === "form");
  if (form) return form;
  const form4562 = valid.find((c) => c.family === "form4562");
  if (form4562) return form4562;
  const statement = valid.find((c) => c.family === "statement");
  if (statement) return statement;

  const agreeing = valid.filter((c) =>
    valid.some((other) => other !== c && nearEqual(c.value, other.value)),
  );
  if (agreeing.length) {
    return agreeing.sort((a, b) => b.confidence - a.confidence)[0];
  }

  const comparison = valid.find((c) => c.family === "comparison");
  if (comparison) return comparison;

  return valid.sort((a, b) => b.confidence - a.confidence)[0];
}

/** Book / tax depreciation report footer — independent of Form page-1 OCR. */
function scanNetDepreciationReport(text: string): { value: number; confidence: number } | undefined {
  let best: { value: number; confidence: number } | undefined;
  for (const raw of text.split(/\n/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!/NET\s+DEPRECIATION\b/i.test(line)) continue;
    if (/accumulated|allowance/i.test(line)) continue;
    const amt = scheduleLineAmount(line);
    if (amt === undefined) continue;
    const abs = Math.round(Math.abs(amt));
    if (abs < 1 || (abs >= 1990 && abs <= 2035)) continue;
    // Prefer the smallest positive NET (report total); avoid rolling multi-entity sums.
    if (!best || abs < best.value) best = { value: abs, confidence: 96 };
  }
  return best;
}

/**
 * Cross-reference P&L depreciation & amortization.
 * Form / NET DEPRECIATION / statement beat comparison worksheets (no dollar-magnitude pick).
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
  const netDep = scanNetDepreciationReport(ctx.allText);
  if (netDep && !depCandidates.some((c) => nearEqual(c.value, netDep.value))) {
    depCandidates.push({
      value: netDep.value,
      source: "Depreciation report (NET DEPRECIATION)",
      confidence: netDep.confidence,
      family: "form",
    });
  }
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
