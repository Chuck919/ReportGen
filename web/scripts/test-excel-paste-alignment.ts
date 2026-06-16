/**
 * Verify TSV paste layout matches KCF Excel workbook (row order, year columns, input rows).
 * Run: npm run test:excel-paste
 */
import { buildPasteTsv, TAX_WORKBOOK_ROWS, TAX_YEARS } from "../src/lib/tax-workbook";
import { WORKBOOK_COMPARISON_FIXTURES } from "../src/lib/workbook-comparison-fixtures";
import type { TaxYearValues } from "../src/lib/tax-workbook";

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

function fixtureToColumn(year: number): TaxYearValues {
  const key = `KCF MAIN CURRENT EXCEL.xlsx / ${year}`;
  const f = WORKBOOK_COMPARISON_FIXTURES.tax[key];
  if (!f) throw new Error(`missing fixture ${key}`);
  return { year: f.year, values: f.values, source: "fixture" };
}

const columns = [2025, 2024, 2023].map(fixtureToColumn);
const tsv = buildPasteTsv(columns);
const lines = tsv.split("\n");

assert(lines.length === TAX_WORKBOOK_ROWS.length, `TSV line count ${lines.length} = workbook rows ${TAX_WORKBOOK_ROWS.length}`);

let lineIdx = 0;
for (const row of TAX_WORKBOOK_ROWS) {
  const cells = lines[lineIdx]!.split("\t");
  assert(cells.length === TAX_YEARS.length, `row ${row.row} (${row.id}) has ${TAX_YEARS.length} year columns`);
  if (row.excelBehavior === "formula") {
    assert(cells.every((c) => c === ""), `formula row ${row.id} leaves year cells empty for Excel formulas`);
  }
  lineIdx++;
}

// Year column order: 2025, 2024, 2023 — 2024 values in column index 1
const salesLine = lines[TAX_WORKBOOK_ROWS.findIndex((r) => r.id === "sales")];
const salesCells = salesLine!.split("\t");
assert(salesCells[0] === "1027658", "2025 sales in column 1");
assert(salesCells[1] === "1066455", "2024 sales in column 2");
assert(salesCells[2] === "1086475", "2023 sales in column 3");

const cogsLine = lines[TAX_WORKBOOK_ROWS.findIndex((r) => r.id === "cogs")];
assert(cogsLine!.split("\t")[1] === "313334", "2024 cogs in column 2");

// Partial year upload: only 2024 — other year columns blank
const partial = buildPasteTsv([fixtureToColumn(2024)]);
const partialSales = partial.split("\n")[TAX_WORKBOOK_ROWS.findIndex((r) => r.id === "sales")]!.split("\t");
assert(partialSales[0] === "", "missing 2025 is blank");
assert(partialSales[1] === "1066455", "2024 still in column 2");
assert(partialSales[2] === "", "missing 2023 is blank");

console.log(`\n=== excel paste alignment: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
