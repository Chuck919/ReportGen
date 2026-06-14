/** Quick eval of all ocr-cache/*.txt files */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { TAX_ATTACHMENT_FIELD_IDS, WORKBOOK_COMPARISON_FIXTURES } from "../src/lib/workbook-comparison-fixtures";
import { TAX_WORKBOOK_ROWS } from "../src/lib/tax-workbook";

const INPUT_IDS = TAX_WORKBOOK_ROWS.filter((r) => r.excelBehavior === "input").map((r) => r.id);
const CACHE_DIR = path.join(process.cwd(), "scripts", "ocr-cache");

function scoreField(expected: number, actual: number | undefined): boolean {
  if (actual === undefined) return false;
  if (expected === 0 && actual === 0) return true;
  if (expected === 0) return actual === 0;
  return Math.abs(actual - expected) / Math.abs(expected) <= 0.01;
}

async function main() {
  const files = (await readdir(CACHE_DIR)).filter((f) => f.endsWith(".txt")).sort();
  const docsDir = path.resolve(process.cwd(), "..", "Documents");

  for (const file of files) {
    const year = parseInt(file.split("-")[0]!, 10);
    if (![2023, 2024, 2025].includes(year)) continue;
    const pdfPath = await resolveTaxReturnPdf(docsDir, year);
    const bytes = await readFile(pdfPath);
    const p = new PDFParse({ data: Buffer.from(bytes) });
    const embedded = (await p.getText()).text ?? "";
    await p.destroy?.();
    const ocrText = await readFile(path.join(CACHE_DIR, file), "utf8");
    const result = parseTaxReturnFromText(path.basename(pdfPath), embedded, ocrText, year);
    const expected = WORKBOOK_COMPARISON_FIXTURES.tax[`KCF MAIN CURRENT EXCEL.xlsx / ${year}`]?.values;
    if (!expected) continue;

    let scored = 0;
    let correct = 0;
    const misses: string[] = [];
    for (const id of INPUT_IDS) {
      const exp = expected[id];
      if (exp === undefined) continue;
      if (TAX_ATTACHMENT_FIELD_IDS.has(id)) continue;
      if (exp === 0 && result.values[id] === undefined) continue;
      scored++;
      const ok = scoreField(exp, result.values[id]);
      if (!ok) misses.push(`${id}: exp ${exp}, got ${result.values[id] ?? "blank"}`);
      if (ok) correct++;
    }
    const pct = scored ? ((correct / scored) * 100).toFixed(1) : "100";
    console.log(`${file.replace(".txt", "")}: ${pct}%${misses.length ? " | " + misses.join("; ") : ""}`);
  }
}

main().catch(console.error);
