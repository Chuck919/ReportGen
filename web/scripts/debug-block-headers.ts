import { readFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";

function isOtherDeductionsBlockHeader(line: string): boolean {
  if (/statement\s*[23]\b|stmt\s*[23]\b/i.test(line) && /other\s+deduct/i.test(line)) return true;
  return /statement\s*2|stmt\s*2|line\s*(?:19|20)\b.*other\s+deductions/i.test(line);
}

async function main() {
  const pdf = await resolveTaxReturnPdf(
    path.resolve("../Documents/For Changwen/arizona-sun-supply"),
    2022,
  );
  const text = await getEmbeddedPdfText(await readFile(pdf));
  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (isOtherDeductionsBlockHeader(line)) console.log("HEADER", line.slice(0, 100));
  }
}

main();
