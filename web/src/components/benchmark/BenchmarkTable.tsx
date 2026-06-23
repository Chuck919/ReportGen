"use client";

import { CopyButton } from "@/components/CopyButton";
import type { BenchmarkEntryRow } from "@/lib/benchmark-entry";
import { buildBenchmarkValuesColumn } from "@/lib/benchmark-excel";

function groupByExcelLayout(rows: BenchmarkEntryRow[]): BenchmarkEntryRow[][] {
  const groups: BenchmarkEntryRow[][] = [];
  let current: BenchmarkEntryRow[] = [];
  for (const row of rows) {
    if (row.excelGroupStart && current.length) {
      groups.push(current);
      current = [];
    }
    current.push(row);
  }
  if (current.length) groups.push(current);
  return groups;
}

function groupTitle(rows: BenchmarkEntryRow[]): string {
  const first = rows[0]?.label;
  if (first === "COGS") return "Income Statement";
  if (first === "Cash") return "Balance Sheet";
  if (first === "Gross") return "Fixed Assets";
  if (rows[0]?.section === "Metrics") return "Metrics";
  if (first === "Depreciation") return "Operating expenses";
  if (first === "Gross intangible") return "Balance Sheet (detail)";
  return rows[0]?.section ?? "Benchmark";
}

export function BenchmarkTable({ rows }: { rows: BenchmarkEntryRow[] }) {
  const groups = groupByExcelLayout(rows);

  return (
    <div className="space-y-8">
      {groups.map((groupRows, groupIdx) => {
        const title = groupTitle(groupRows);
        const pasteTsv = buildBenchmarkValuesColumn(groupRows);
        return (
          <div key={`${title}-${groupIdx}`} className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-stone-900">{title}</h2>
              <CopyButton label="Copy section" text={pasteTsv} />
            </div>
            <div className="overflow-x-auto rounded-2xl border border-stone-200 bg-white shadow-sm">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-stone-200 bg-stone-50 text-stone-600">
                    <th className="px-4 py-3 font-medium">Label</th>
                    <th className="px-4 py-3 font-medium">Benchmark 1</th>
                    <th className="px-4 py-3 font-medium">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {groupRows.map((row, idx) => (
                    <tr key={`${row.label}-${idx}`} className="border-t border-stone-100">
                      <td className="px-4 py-2 font-medium text-stone-900">{row.label}</td>
                      <td className="px-4 py-2 font-mono text-stone-800">{row.value || "—"}</td>
                      <td className="px-4 py-2 text-xs text-stone-500">{row.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}
