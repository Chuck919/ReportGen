import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import { parseTwoYearComparisonBlock } from "../src/lib/two-year-comparison-parser";
import { runLocalOcr } from "../src/lib/tax-return-parser";

async function main() {
  const pdfPath =
    process.argv[2] ||
    path.resolve(process.cwd(), "..", "Documents", "KC Fudge LLC_2023 Business Tax Return_2023-12-31.pdf");
  const year = Number(process.argv[3] || 2023);
  const bytes = await readFile(pdfPath);
  const p = new PDFParse({ data: Buffer.from(bytes) });
  const embedded = (await p.getText()).text ?? "";
  await p.destroy?.();

  console.log("embedded len", embedded.length);
  const ocr = await runLocalOcr(bytes, { profile: "tax" });
  const all = `${embedded}\n${ocr.text}`;
  await writeFile(path.join(process.cwd(), "scripts", "last-ocr-dump.txt"), all, "utf8");
  console.log("ocr pages", ocr.pages, "confidence", ocr.confidence);
  console.log("has two year", /two\s*year\s*comparison/i.test(all));
  const comp = parseTwoYearComparisonBlock(all, year);
  console.log("comparison", comp ? { lines: comp.linesMatched, cols: comp.headerYears, used: comp.columnUsed, keys: Object.keys(comp.values).length } : null);
  if (comp) {
    for (const [k, v] of Object.entries(comp.values).sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(`  ${k}: ${v}`);
    }
  }
  const salesLines = all.split(/\n/).filter((l) => /gross\s*rece|net\s*sale|sales\s*\(income\)|ordinary\s*business/i.test(l)).slice(0, 15);
  console.log("\nsales-ish lines:");
  for (const l of salesLines) console.log(" ", l.slice(0, 140));
}

main().catch(console.error);
