import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { runLocalOcr } from "../src/lib/tax-return/local-ocr";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import {
  buildOperatingExpenseLinePool,
  gatherExpenseExtractionInventory,
  OPERATING_EXPENSE_SLOT_IDS,
} from "../src/lib/tax/operating-expenses";

async function main() {
  const docs = path.resolve(process.cwd(), "..", "Documents", "For Changwen", "KC Fudge");
  // resolve via client path
  const { TAX_BENCHMARK_CLIENTS } = await import("./lib/tax-benchmark-clients");
  const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === "kcf")!;
  const year = 2023;
  const pdfPath = await resolveTaxReturnPdf(path.resolve(process.cwd(), client.docsDir), year);
  const bytes = await readFile(pdfPath);
  const embedded = await getEmbeddedPdfText(bytes);
  const ocr = await runLocalOcr(bytes, { profile: "tax", mode: "balanced" });
  await writeFile("scripts/benchmark-output/tmp-kcf23-ocr.txt", ocr.text);
  const parsed = parseTaxReturnFromText(path.basename(pdfPath), embedded, ocr.text, year, {
    ocrMode: "balanced",
  });
  console.log("slot values", Object.fromEntries(OPERATING_EXPENSE_SLOT_IDS.map((id) => [id, parsed.values[id]])));
  console.log("other", parsed.values.other_operating_expenses);
  // Find utilities / 7787 / 596314 context in OCR
  for (const raw of ocr.text.split(/\n/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (/utilit|7,?787|596,?314|19,?882|advertis/i.test(line) && /\d/.test(line)) {
      console.log("LINE:", line.slice(0, 140));
    }
  }
  process.exit(0);
}

void main();
