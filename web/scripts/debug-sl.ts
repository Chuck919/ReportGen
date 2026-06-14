import { readFileSync } from "node:fs";
import { extractScheduleLFields } from "../src/lib/tax-return/schedule-l";
for (const y of ["2023","2025"] as const) {
  const t = readFileSync(`scripts/ocr-cache/${y}-balanced.txt`, "utf8");
  const sl = extractScheduleLFields(t);
  console.log(y, "ocl", sl.values.other_current_liabilities, sl.sources.other_current_liabilities);
  const line18 = t.split(/\n/).find((r) => /\b18\b/.test(r) && /curren|lad/i.test(r));
  console.log(" line18", line18?.trim().slice(0,100));
}