import { readFileSync } from "node:fs";
import { WORKBOOK_COMPARISON_FIXTURES } from "../src/lib/workbook-comparison-fixtures";
import { TAX_ATTACHMENT_FIELD_IDS } from "../src/lib/workbook-comparison-fixtures";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { TAX_WORKBOOK_ROWS } from "../src/lib/tax-workbook";

const year = Number(process.argv[2] ?? 2024);
const dumpPath = process.argv[3] ?? "scripts/last-ocr-dump.txt";
const text = readFileSync(dumpPath, "utf8");
const t0 = Date.now();
const r = parseTaxReturnFromText(`KC Fudge LLC_${year}.pdf`, "", text, year);
console.log(`parsed in ${Date.now() - t0}ms, fields=${Object.keys(r.values).length}`);

const exp = WORKBOOK_COMPARISON_FIXTURES.tax[`KCF MAIN CURRENT EXCEL.xlsx / ${year}`]?.values;
if (!exp) throw new Error(`no fixture ${year}`);

let primaryOk = 0;
let primaryN = 0;
for (const row of TAX_WORKBOOK_ROWS.filter((x) => x.excelBehavior === "input")) {
  const v = exp[row.id];
  if (v === undefined) continue;
  if (TAX_ATTACHMENT_FIELD_IDS.has(row.id)) continue;
  if (v === 0 && r.values[row.id] === undefined) continue;
  primaryN++;
  const a = r.values[row.id];
  const ok = a !== undefined && (v === 0 ? a === 0 : Math.abs(a - v) / Math.abs(v) <= 0.01);
  if (!ok) console.log(`MISS ${row.label}: exp ${v}, got ${a ?? "(blank)"} [${r.fieldSources?.[row.id] ?? "—"}]`);
  else primaryOk++;
}
console.log(`Primary ${year}: ${primaryOk}/${primaryN} (${((primaryOk / primaryN) * 100).toFixed(1)}%)`);
