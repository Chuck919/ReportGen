import {
  OPERATING_EXPENSE_SLOT_IDS,
  diagnoseTop8OpexMultiset,
  type OpexMultisetDiagnostic,
} from "../../src/lib/tax/operating-expenses";
import { TAX_WORKBOOK_ROWS, type TaxYearValues } from "../../src/lib/tax-workbook";
import { WORKBOOK_COMPARISON_FIXTURES } from "../../src/lib/workbook-comparison-fixtures";
import changwenFixtures from "../changwen-fixtures.json";
import {
  buildFieldMissDiagnostics,
  type FieldMissDiagnostic,
  type ParsedBenchmarkContext,
} from "./tax-benchmark-confidence";
import {
  formatFieldMiss,
  moneyTolerance,
  scoreAllFieldsExcludingOpexSlots,
  type FieldMiss,
  type PrimaryScore,
} from "./tax-benchmark-score";

const ALL_FIXTURES: Record<string, { values: Record<string, number> }> = {
  ...WORKBOOK_COMPARISON_FIXTURES.tax,
  ...(changwenFixtures as Record<string, { values: Record<string, number> }>),
};

const ROW_LABEL = new Map(TAX_WORKBOOK_ROWS.map((r) => [r.id, r.label]));

export type ClientYearDebugReport = {
  client: string;
  year: number;
  fixtureKey: string;
  fieldPct: number;
  opexAmountPct: number;
  fieldMisses: FieldMiss[];
  fieldDiagnostics: FieldMissDiagnostic[];
  opexDiagnostic: OpexMultisetDiagnostic;
  opexSlotSources: Array<{
    slotId: string;
    label: string;
    amount: number;
    expectedInFixture?: number;
    source?: string;
    pdfLabel?: string;
  }>;
  operatingExpenseLineCount: number;
  topOperatingExpenseLines: Array<{ label: string; amount: number; source?: string }>;
  opexCandidates?: Array<{ value: number; source: string; score?: number; valid?: boolean; flags?: string[] }>;
  ocrFlags?: string[];
  fixSuggestions: string[];
};

function fixtureValues(fixtureKey: string): Record<string, number> {
  const exp = ALL_FIXTURES[fixtureKey]?.values;
  if (!exp) throw new Error(`No fixture for ${fixtureKey}`);
  return exp;
}

function suggestFixes(
  fieldDiag: FieldMissDiagnostic,
  opexDiag: OpexMultisetDiagnostic,
): string[] {
  const out: string[] = [];
  const { field, expected, actual, diagnosis, source, alternatives } = fieldDiag;

  if (field === "other_operating_expenses") {
    if (actual === undefined) {
      out.push("other_opex is blank — check coherence gate clearing, reconcile winner plausibility, and post-verify reconcile");
      if (alternatives?.length) {
        const near = alternatives.find(
          (a) => Math.abs(a.value - expected) <= moneyTolerance(expected),
        );
        if (near) out.push(`Expected ${expected} exists in candidates (${near.source}) but was not chosen`);
      }
    } else if (diagnosis === "ocr_coverage") {
      out.push("Stmt-2 / comparison OCR incomplete — improve attachment scan or comparison OTHER DEDUCTIONS residual");
    } else if (diagnosis === "formula_inconsistency") {
      out.push("Opex does not close Stmt-2 total — prefer subtractive residual or detail that structurally closes");
    } else if (diagnosis === "candidate_selection") {
      out.push("Review opex candidate ranking — a closer candidate may exist in alternatives list");
    }
    if (alternatives?.length) {
      const closest = [...alternatives].sort(
        (a, b) => Math.abs(a.value - expected) - Math.abs(b.value - expected),
      )[0];
      if (closest && Math.abs(closest.value - expected) < Math.abs((actual ?? 0) - expected)) {
        out.push(
          `Closer candidate: ${closest.value} from "${closest.source}" (score ${closest.score?.toFixed(1) ?? "?"})`,
        );
      }
    }
  }

  if (field === "other_current_liabilities" && expected === 0 && (actual ?? 0) > 0) {
    out.push("Statement Line 18 bleed — require Schedule L corroboration or clear when comparison shows zero");
  }

  if (field === "cogs") {
    out.push("COGS source disagreement — check form line 2 vs comparison row vs gross-profit misread");
    if (alternatives?.length) {
      const comp = alternatives.find((a) => Math.abs(a.value - expected) <= moneyTolerance(expected));
      if (comp) out.push(`Fixture-matching comparison value available: ${comp.value} (${comp.source})`);
    }
  }

  if (diagnosis === "ocr_coverage" && field !== "other_operating_expenses") {
    out.push(`Field ${field} missing or wrong — OCR may not capture the source region; check fieldSources and flags`);
  }

  if (diagnosis === "source_disagreement") {
    out.push(`Multiple sources disagree on ${field} — verify which family (form/comparison/statement) should win`);
  }

  for (const u of opexDiag.unmatchedExpected) {
    if (u.nearestActual !== undefined && u.nearestSlot) {
      const diff = Math.abs(u.nearestActual - u.amount);
      if (diff <= u.tolerance * 3) {
        out.push(
          `Opex multiset: expected ${u.amount} almost matches slot ${u.nearestSlot} (${u.nearestActual}, off by ${diff} > tol ${u.tolerance})`,
        );
      } else {
        out.push(
          `Opex multiset: expected amount ${u.amount} not in any slot — nearest ${u.nearestActual} in ${u.nearestSlot}`,
        );
      }
    }
  }

  for (const s of opexDiag.surplusActual) {
    if (s.amount >= 1000) {
      out.push(`Surplus opex amount ${s.amount} in slot ${s.slotId} (${s.slotLabel}) — not in fixture multiset`);
    }
  }

  return [...new Set(out)];
}

export function buildClientYearDebugReport(
  client: string,
  year: number,
  fixtureKey: string,
  parsed: ParsedBenchmarkContext,
): ClientYearDebugReport {
  const exp = fixtureValues(fixtureKey);
  const fields = scoreAllFieldsExcludingOpexSlots(fixtureKey, parsed.values);
  const opexDiagnostic = diagnoseTop8OpexMultiset(exp, parsed.values);
  const fieldDiagnostics = buildFieldMissDiagnostics(parsed, fields);

  const opexSlotSources = OPERATING_EXPENSE_SLOT_IDS.map((id) => ({
    slotId: id,
    label: ROW_LABEL.get(id) ?? id,
    amount: Math.round(parsed.values[id] ?? 0),
    expectedInFixture: exp[id],
    source: parsed.fieldSources?.[id],
    pdfLabel: parsed.opexSlotLabels?.[id],
  }));

  const lines = parsed.operatingExpenseLines ?? [];
  const topOperatingExpenseLines = [...lines]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 12)
    .map((l) => ({ label: l.label, amount: l.amount, source: l.source }));

  const opexCandidates = (
    parsed.fieldCandidateOptions?.other_operating_expenses ??
    parsed.debug?.opexCandidates?.map((c) => ({
      value: c.value,
      source: c.source,
      score: c.totalScore,
      valid: c.valid,
      flags: c.plausibilityFlags,
    })) ??
    []
  )
    .slice()
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 8);

  const fixSuggestions: string[] = [];
  for (const fd of fieldDiagnostics) {
    fixSuggestions.push(...suggestFixes(fd, opexDiagnostic));
  }
  if (opexDiagnostic.pct < 100 && !fieldDiagnostics.length) {
    fixSuggestions.push(
      "Field accuracy OK but opex slot multiset failed — slot IDs are positional; amounts must match fixture set regardless of label",
    );
    for (const u of opexDiagnostic.unmatchedExpected) {
      fixSuggestions.push(
        `Missing fixture opex amount ${u.amount} (±${u.tolerance}) — check Stmt-2 line extraction or parser slot assignment`,
      );
    }
  }

  return {
    client,
    year,
    fixtureKey,
    fieldPct: fields.pct,
    opexAmountPct: opexDiagnostic.pct,
    fieldMisses: fields.missDetails,
    fieldDiagnostics,
    opexDiagnostic,
    opexSlotSources,
    operatingExpenseLineCount: lines.length,
    topOperatingExpenseLines,
    opexCandidates: opexCandidates.length ? opexCandidates : undefined,
    ocrFlags: parsed.ocrCoverage?.flags ?? parsed.debug?.coverage?.flags,
    fixSuggestions: [...new Set(fixSuggestions)],
  };
}

export function formatClientYearDebugReport(r: ClientYearDebugReport): string {
  const lines: string[] = [];
  lines.push(`\n${"=".repeat(72)}`);
  lines.push(`DEBUG ${r.client} ${r.year}  fields=${r.fieldPct.toFixed(1)}%  opexAmt=${r.opexAmountPct.toFixed(1)}%`);
  lines.push("=".repeat(72));

  if (r.fieldMisses.length) {
    lines.push("\n── FIELD MISSES (excl. opex slots) ──");
    for (const m of r.fieldMisses) {
      lines.push(`  ${formatFieldMiss(m)}`);
    }
    for (const d of r.fieldDiagnostics) {
      lines.push(`    diagnosis: ${d.diagnosis} | source: ${d.source ?? "?"}`);
      lines.push(`    conf: display=${d.confidence}% parser=${d.parserConfidence ?? "?"}% flagged=${d.flagged}`);
      if (d.flags.length) lines.push(`    flags: ${d.flags.join(", ")}`);
      if (d.whyLowConfidence) lines.push(`    why_low: ${d.whyLowConfidence}`);
      if (d.alternatives?.length) {
        lines.push("    alternatives:");
        for (const a of d.alternatives.slice(0, 5)) {
          const tol = moneyTolerance(d.expected);
          const hit = Math.abs(a.value - d.expected) <= tol ? " ✓IN_TOL" : "";
          lines.push(`      ${a.value}  score=${a.score?.toFixed(1) ?? "?"}  ${a.source}${hit}`);
        }
      }
    }
  }

  if (r.opexAmountPct < 100) {
    lines.push("\n── OPEX SLOT MULTISET (8 amounts, order-independent) ──");
    lines.push(`  matched ${r.opexDiagnostic.ok}/${r.opexDiagnostic.n}`);
    for (const row of r.opexDiagnostic.slotRows) {
      const tag = row.matched
        ? `✓ paired fixture amount ${row.matchedExpected}`
        : row.actual >= 100
          ? "✗ surplus / wrong amount"
          : "· zero / empty";
      lines.push(
        `  ${row.slotId.padEnd(22)} actual=${String(row.actual).padStart(10)}  fixture_slot=${row.expectedInFixture ?? "—"}  ${tag}`,
      );
    }
    if (r.opexDiagnostic.unmatchedExpected.length) {
      lines.push("  unmatched fixture amounts:");
      for (const u of r.opexDiagnostic.unmatchedExpected) {
        lines.push(
          `    need ${u.amount} (±${u.tolerance}) — nearest: ${u.nearestActual ?? "none"} in ${u.nearestSlot ?? "?"}`,
        );
      }
    }
    lines.push("\n── OPEX SLOT SOURCES (positional paste rows) ──");
    for (const s of r.opexSlotSources) {
      if (s.amount < 100 && (s.expectedInFixture === undefined || s.expectedInFixture === 0)) continue;
      const pdf = s.pdfLabel ? ` pdf_label="${s.pdfLabel}"` : "";
      lines.push(
        `  ${s.slotId.padEnd(22)} ${String(s.amount).padStart(10)}  src=${s.source ?? "?"}${pdf}`,
      );
    }
  }

  if (r.operatingExpenseLineCount > 0) {
    lines.push(`\n── OPERATING EXPENSE LINES (${r.operatingExpenseLineCount} from Stmt-2 scan) ──`);
    for (const l of r.topOperatingExpenseLines) {
      lines.push(`  ${l.amount.toString().padStart(10)}  ${l.label.slice(0, 50)}  [${l.source ?? "?"}]`);
    }
  }

  if (r.opexCandidates?.length) {
    lines.push("\n── OTHER_OPERATING_EXPENSES CANDIDATES ──");
    for (const c of r.opexCandidates) {
      const flags = c.flags?.length ? ` flags=[${c.flags.join(",")}]` : "";
      lines.push(`  ${String(c.value).padStart(12)}  score=${c.score?.toFixed(1) ?? "?"}  ${c.source}${flags}`);
    }
  }

  if (r.ocrFlags?.length) {
    lines.push(`\n── OCR FLAGS ── ${r.ocrFlags.join(", ")}`);
  }

  if (r.fixSuggestions.length) {
    lines.push("\n── SUGGESTED FIXES (generalized) ──");
    for (const s of r.fixSuggestions) {
      lines.push(`  • ${s}`);
    }
  }

  return lines.join("\n");
}

export type FailureAggregate = {
  field: string;
  count: number;
  clients: string[];
  sampleSuggestion?: string;
};

export function aggregateFailures(reports: ClientYearDebugReport[]): FailureAggregate[] {
  const byField = new Map<string, { count: number; clients: string[]; suggestion?: string }>();
  for (const r of reports) {
    const hasIssue = r.fieldMisses.length > 0 || r.opexAmountPct < 100;
    if (!hasIssue) continue;
    for (const m of r.fieldMisses) {
      const cur = byField.get(m.field) ?? { count: 0, clients: [], suggestion: undefined };
      cur.count++;
      cur.clients.push(`${r.client}:${r.year}`);
      if (!cur.suggestion && r.fixSuggestions[0]) cur.suggestion = r.fixSuggestions[0];
      byField.set(m.field, cur);
    }
    if (r.opexAmountPct < 100 && !r.fieldMisses.length) {
      const key = "opex_slot_multiset";
      const cur = byField.get(key) ?? { count: 0, clients: [], suggestion: undefined };
      cur.count++;
      cur.clients.push(`${r.client}:${r.year}`);
      if (!cur.suggestion) cur.suggestion = r.fixSuggestions[0];
      byField.set(key, cur);
    }
  }
  return [...byField.entries()]
    .map(([field, v]) => ({
      field,
      count: v.count,
      clients: v.clients,
      sampleSuggestion: v.suggestion,
    }))
    .sort((a, b) => b.count - a.count);
}

export function formatFailureAggregate(agg: FailureAggregate[]): string {
  if (!agg.length) return "\n── No failures to aggregate ──";
  const lines = ["\n── FAILURE PATTERNS (aggregate) ──"];
  for (const a of agg) {
    lines.push(`  ${a.field}: ${a.count}x  [${a.clients.join(", ")}]`);
    if (a.sampleSuggestion) lines.push(`    → ${a.sampleSuggestion}`);
  }
  return lines.join("\n");
}

export function printDebugReports(reports: ClientYearDebugReport[]): void {
  const failed = reports.filter((r) => r.fieldMisses.length > 0 || r.opexAmountPct < 100);
  for (const r of failed) {
    console.log(formatClientYearDebugReport(r));
  }
  console.log(formatFailureAggregate(aggregateFailures(reports)));
}
