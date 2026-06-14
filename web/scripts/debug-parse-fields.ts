import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { runLocalOcr } from "../src/lib/tax-return/local-ocr";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { extractFormPage1Block } from "../src/lib/tax-return/form-anchors";
import { extractStatementOtherIncome } from "../src/lib/tax-return/statement-extractors";
import { parseTwoYearComparisonBlock } from "../src/lib/two-year-comparison-parser";

const year = Number(process.argv[2] ?? 2024);
const mode = (process.argv[3] ?? "fast") as "fast" | "balanced" | "thorough";
const docsDir = path.resolve(process.cwd(), "../Documents");
const cacheDir = path.join(process.cwd(), "scripts", "ocr-cache");
await mkdir(cacheDir, { recursive: true });
const pdfPath = await resolveTaxReturnPdf(docsDir, year);
const bytes = await readFile(pdfPath);
const p = new PDFParse({ data: Buffer.from(bytes) });
const embedded = (await p.getText()).text ?? "";
await p.destroy?.();
const cachePath = path.join(cacheDir, `${year}-${mode}.txt`);
let ocrText: string;
try {
  ocrText = await readFile(cachePath, "utf8");
  console.log(`Using cached OCR: ${cachePath}`);
} catch {
  console.log(`Running OCR ${mode}...`);
  const ocr = await runLocalOcr(bytes, { profile: "tax", mode });
  ocrText = ocr.text;
  await writeFile(cachePath, ocrText, "utf8");
}
const allText = `${embedded}\n${ocrText}`;
const formPage1 = extractFormPage1Block(allText);
const comparison = parseTwoYearComparisonBlock(allText, year);
const stmt = extractStatementOtherIncome(allText);
console.log("comparison lines", comparison?.linesMatched, "rent", comparison?.values.rent, "other_income", comparison?.values.other_income);
console.log("stmt other income", stmt.value);
console.log("form page1 line5 snippet:");
for (const row of formPage1.split(/\n/)) {
  if (/other\s+income/i.test(row)) console.log(" ", row.trim().slice(0, 120));
}
const parsed = parseTaxReturnFromText(path.basename(pdfPath), embedded, ocrText, year);
console.log("parsed depreciation", parsed.values.depreciation, parsed.fieldSources?.depreciation);
console.log("parsed rent", parsed.values.rent, parsed.fieldSources?.rent);
console.log("parsed other_income", parsed.values.other_income, parsed.fieldSources?.other_income);