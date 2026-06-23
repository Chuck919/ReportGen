/**
 * Benchmark Excel paste layout tests.
 * Run: npx tsx scripts/test-benchmark-excel-paste.ts
 */
import { buildBenchmarkExcelPaste } from "../src/lib/benchmark-excel";
import type { BenchmarkEntryRow } from "../src/lib/benchmark-entry";

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    console.log(`  ok: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

const sampleRows: BenchmarkEntryRow[] = [
  { section: "Income Statement", label: "COGS", value: "41%", source: "industry-common-size" },
  { section: "Income Statement", label: "G&A Wages", value: "19%", source: "industry-common-size" },
  { section: "Income Statement", label: "Rent Expenses", value: "6%", source: "industry-common-size" },
  { section: "Income Statement", label: "EBITDA", value: "9%", source: "industry-common-size" },
  { section: "Income Statement", label: "Net Income", value: "5%", source: "industry-common-size" },
  { section: "Balance Sheet", label: "Cash", value: "28%", source: "industry-common-size" },
  { section: "Balance Sheet", label: "Receivables", value: "2%", source: "industry-common-size" },
  { section: "Balance Sheet", label: "Inventory", value: "18%", source: "industry-common-size" },
  { section: "Balance Sheet", label: "Current Assets", value: "58%", source: "industry-common-size" },
  { section: "Balance Sheet", label: "Gross", value: "85%", source: "industry-common-size" },
  { section: "Balance Sheet", label: "Accumulated Depreciation", value: "54%", source: "industry-common-size" },
  { section: "Balance Sheet", label: "Current Liabilities", value: "26%", source: "industry-common-size" },
  { section: "Balance Sheet", label: "Long-term Liabilities", value: "42%", source: "industry-common-size" },
  { section: "Metrics", label: "Current Ratio", value: "4.55", source: "scorecard" },
  { section: "Metrics", label: "Quick Ratio", value: "3.11", source: "scorecard" },
  { section: "Metrics", label: "Return on Equity", value: "44.25%", source: "scorecard" },
  { section: "Metrics", label: "Return on Assets", value: "22.08%", source: "scorecard" },
  { section: "Income Statement", label: "Depreciation", value: "2%", source: "industry-common-size" },
  { section: "Balance Sheet", label: "Equity", value: "32%", source: "industry-common-size" },
];

const tsv = buildBenchmarkExcelPaste(sampleRows);
const lines = tsv.split("\n");

console.log("=== benchmark excel paste ===");

assert(lines[0] === "Income Statement\tBenchmark 1", "row 1: Income Statement header");
assert(lines[1] === "COGS\t41%", "COGS row");
assert(lines[6] === "", "blank after income statement");
assert(lines[7] === "Balance Sheet\tBenchmark 1", "Balance Sheet header");
assert(lines[12] === "Fixed Assets\t", "Fixed Assets subheader empty value");
assert(lines[13] === "    Gross\t85%", "indented Gross");
assert(lines[14] === "    Accumulated Depreciation\t54%", "indented Accum Dep");
assert(lines[17] === "", "blank before metrics");
assert(lines[18] === "Metrics\tBenchmark 1", "Metrics header");
assert(lines[23] === "", "first blank after metrics");
assert(lines[24] === "", "second blank after metrics");
assert(lines[25] === "Depreciation\t2%", "operating section no header");

console.log(`\n=== benchmark excel paste: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
