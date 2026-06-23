import { readFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";

async function main() {
  const pdf = await resolveTaxReturnPdf(
    path.resolve("../Documents/For Changwen/arizona-sun-supply"),
    2022,
  );
  const text = await getEmbeddedPdfText(await readFile(pdf));
  let inBlock = false;
  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (/statement\s*[23]\b/i.test(line) && /other\s+deduct/i.test(line)) {
      console.log("START", line.slice(0, 80));
      inBlock = true;
    }
    if (inBlock && /statement\s*[3-9]|stmt\s*[3-9]/i.test(line) && !/other\s+deduct/i.test(line)) {
      console.log("END", line.slice(0, 80));
      inBlock = false;
    }
    if (inBlock && /total\s+to\s+form/i.test(line)) {
      console.log("TOTAL LINE", line);
    }
  }
}

main();
