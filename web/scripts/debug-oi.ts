import { readFileSync } from "node:fs";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { parseTwoYearComparisonBlock } from "../src/lib/two-year-comparison-parser";
const t = readFileSync("scripts/ocr-cache/2025-balanced.txt", "utf8");
const c = parseTwoYearComparisonBlock(t, 2025);
console.log("comparison oi", c?.values.other_income);
const r = parseTaxReturnFromText("x.pdf", "", t, 2025);
console.log("parsed oi", r.values.other_income, r.fieldSources?.other_income);