import type { BenchmarkEntryRow } from "@/lib/benchmark-entry";

const BENCHMARK_COL = "Benchmark 1";

type ExcelPasteLine =
  | { kind: "section"; title: string }
  | { kind: "subheader"; label: string }
  | { kind: "data"; label: string; section: BenchmarkEntryRow["section"]; indent?: number }
  | { kind: "blank"; count: number };

/** Exact Benchmark Entry workbook layout (column A label, column B value). */
const BENCHMARK_EXCEL_LAYOUT: ExcelPasteLine[] = [
  { kind: "section", title: "Income Statement" },
  { kind: "data", section: "Income Statement", label: "COGS" },
  { kind: "data", section: "Income Statement", label: "G&A Wages" },
  { kind: "data", section: "Income Statement", label: "Rent Expenses" },
  { kind: "data", section: "Income Statement", label: "EBITDA" },
  { kind: "data", section: "Income Statement", label: "Net Income" },
  { kind: "blank", count: 1 },
  { kind: "section", title: "Balance Sheet" },
  { kind: "data", section: "Balance Sheet", label: "Cash" },
  { kind: "data", section: "Balance Sheet", label: "Receivables" },
  { kind: "data", section: "Balance Sheet", label: "Inventory" },
  { kind: "data", section: "Balance Sheet", label: "Current Assets" },
  { kind: "subheader", label: "Fixed Assets" },
  { kind: "data", section: "Balance Sheet", label: "Gross", indent: 4 },
  { kind: "data", section: "Balance Sheet", label: "Accumulated Depreciation", indent: 4 },
  { kind: "data", section: "Balance Sheet", label: "Current Liabilities" },
  { kind: "data", section: "Balance Sheet", label: "Long-term Liabilities" },
  { kind: "blank", count: 1 },
  { kind: "section", title: "Metrics" },
  { kind: "data", section: "Metrics", label: "Current Ratio" },
  { kind: "data", section: "Metrics", label: "Quick Ratio" },
  { kind: "data", section: "Metrics", label: "Return on Equity" },
  { kind: "data", section: "Metrics", label: "Return on Assets" },
  { kind: "blank", count: 2 },
  { kind: "data", section: "Income Statement", label: "Depreciation" },
  { kind: "data", section: "Income Statement", label: "Amortization" },
  { kind: "data", section: "Income Statement", label: "Overhead or SG&A" },
  { kind: "data", section: "Income Statement", label: "Advertising" },
  { kind: "data", section: "Income Statement", label: "Other Operating Expenses" },
  { kind: "data", section: "Income Statement", label: "Operating Profit" },
  { kind: "data", section: "Income Statement", label: "Interest" },
  { kind: "blank", count: 1 },
  { kind: "data", section: "Balance Sheet", label: "Gross intangible" },
  { kind: "data", section: "Balance Sheet", label: "Less amortization" },
  { kind: "data", section: "Balance Sheet", label: "Accounts Payable" },
  { kind: "data", section: "Balance Sheet", label: "Short Term Debt" },
  { kind: "data", section: "Balance Sheet", label: "Current Portion" },
  { kind: "data", section: "Balance Sheet", label: "Other Current" },
  { kind: "data", section: "Balance Sheet", label: "Total Current" },
  { kind: "data", section: "Balance Sheet", label: "Long Term Liabilities" },
  { kind: "data", section: "Balance Sheet", label: "Equity" },
];

function rowValue(rows: BenchmarkEntryRow[], section: string, label: string): string {
  const hit = rows.find((r) => r.section === section && r.label === label);
  return hit?.value ?? "";
}

function excelLabel(label: string, indent = 0): string {
  return indent > 0 ? `${" ".repeat(indent)}${label}` : label;
}

/** Two-column paste matching the Benchmark Entry Excel template exactly. */
export function buildBenchmarkExcelPaste(rows: BenchmarkEntryRow[]): string {
  const lines: string[] = [];

  for (const line of BENCHMARK_EXCEL_LAYOUT) {
    if (line.kind === "blank") {
      for (let i = 0; i < line.count; i++) lines.push("");
      continue;
    }
    if (line.kind === "section") {
      lines.push([line.title, BENCHMARK_COL].join("\t"));
      continue;
    }
    if (line.kind === "subheader") {
      lines.push([line.label, ""].join("\t"));
      continue;
    }
    lines.push(
      [excelLabel(line.label, line.indent), rowValue(rows, line.section, line.label)].join("\t"),
    );
  }

  return lines.join("\n");
}

/** Values only — one column for quick paste (blank rows preserved). */
export function buildBenchmarkValuesColumn(rows: BenchmarkEntryRow[]): string {
  const full = buildBenchmarkExcelPaste(rows);
  return full
    .split("\n")
    .map((line) => {
      if (!line.trim()) return "";
      const parts = line.split("\t");
      return parts.length > 1 ? parts[1]! : "";
    })
    .join("\n");
}

/** @deprecated Use buildBenchmarkExcelPaste */
export function buildBenchmarkHeaderAndValuesTsv(rows: BenchmarkEntryRow[]): string {
  return buildBenchmarkExcelPaste(rows);
}

/** @deprecated Debug table */
export function buildBenchmarkTableTsv(rows: BenchmarkEntryRow[]): string {
  const header = ["Section", "Label", BENCHMARK_COL].join("\t");
  const body = rows.map((r) => [r.section, r.label, r.value].join("\t"));
  return [header, ...body].join("\n");
}
