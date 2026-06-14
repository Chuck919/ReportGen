import { readFileSync } from "node:fs";
import { classifyComparisonLine } from "../src/lib/two-year-comparison-parser";
const t = readFileSync("scripts/ocr-cache/2023-balanced.txt", "utf8");
const start = t.search(/two\s*year\s*comparison|1120[-\s]?s.{0,40}worksheet|worksheet\s+page.{0,20}20\d{2}/i);
console.log("start", start);
const block = t.slice(start, start + 22000);
let n = 0;
for (const rawLine of block.split(/\n/).slice(0, 80)) {
  const line = rawLine.replace(/\s+/g, " ").trim();
  const id = classifyComparisonLine(line);
  if (id) { n++; console.log(id, line.slice(0, 90)); }
}
console.log("matched", n);