import type { BenchmarkEntryRow } from "@/lib/benchmark-entry";

/** TSV for Excel paste: 3 columns + header row (rows go down). */
export function buildBenchmarkTableTsv(rows: BenchmarkEntryRow[]): string {
  const header = ["Section", "Label", "Benchmark 1"].join("\t");
  const body = rows.map((r) => [r.section, r.label, r.value].join("\t"));
  return [header, ...body].join("\n");
}

/** One value per row — paste down a single column in Excel. */
export function buildBenchmarkValuesColumn(rows: BenchmarkEntryRow[]): string {
  return rows.map((r) => r.value).join("\n");
}

/** Header row only + values column (paste A:B or place headers manually). */
export function buildBenchmarkHeaderAndValuesTsv(rows: BenchmarkEntryRow[]): string {
  const lines = ["Benchmark 1", ...rows.map((r) => r.value)];
  return lines.join("\n");
}
