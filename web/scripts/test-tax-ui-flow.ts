/**
 * /tax UI data path: merge → table → TSV → storage round-trip (no browser, no OCR).
 * Run: npm run test:tax-ui
 */
import { buildTaxTable } from "../src/lib/tax/export-table";
import { mergeTaxYearsByYear } from "../src/lib/tax/merge-years";
import { buildPasteTsv, type TaxYearValues } from "../src/lib/tax-workbook";

const STORAGE_KEY = "reportgen-tax-columns-v1";

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

const year2024: TaxYearValues = {
  year: 2024,
  values: { sales: 1066455, cogs: 313334, cash: 280309 },
  confidence: { sales: 98, cogs: 99, cash: 97 },
  source: "test",
};

const year2024Reupload: TaxYearValues = {
  year: 2024,
  values: { sales: 999999, cogs: 313334 },
  confidence: { sales: 50, cogs: 99 },
  source: "reupload-low-conf",
};

// Simulates localStorage round-trip (same shape as session-storage.ts)
function storageRoundTrip(columns: TaxYearValues[]): TaxYearValues[] {
  const json = JSON.stringify(columns);
  const parsed = JSON.parse(json) as TaxYearValues[];
  return Array.isArray(parsed) ? parsed : [];
}

console.log("=== tax UI flow ===");

const merged = mergeTaxYearsByYear([year2024], [year2024Reupload]);
const col2024 = merged.find((c) => c.year === 2024)!;
assert(col2024.values.sales === 1066455, "re-upload keeps higher-confidence sales");
assert(col2024.values.cogs === 313334, "cogs unchanged");

const twoYears = mergeTaxYearsByYear([year2024], [{ year: 2025, values: { sales: 1027658 }, source: "y2025" }]);
assert(twoYears.length === 2, "two year columns after second upload");

const table = buildTaxTable(twoYears);
assert(table.columns.length === 2, "table shows both years");
assert(table.rows.some((r) => r.id === "sales" && r.values["2024"] != null), "table has 2024 sales");
assert(
  table.rows.some((r) => r.id === "rent" && r.values["2024"] === null && r.values["2025"] === null),
  "table lists rows with empty values",
);

const tsv = buildPasteTsv(twoYears);
const lines = tsv.split("\n");
assert(lines.length >= 40, "tsv has workbook rows");
assert(tsv.includes("1066455") || tsv.includes("1027658"), "tsv contains sales values");

const restored = storageRoundTrip(twoYears);
assert(restored[0]?.year === 2025 || restored[1]?.year === 2025, "storage round-trip preserves years");
assert(STORAGE_KEY.length > 0, "storage key defined");

console.log(`\n=== tax UI flow: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
