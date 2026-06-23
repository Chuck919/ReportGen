/** Dump Stmt 2 / opex signals after thorough local OCR. */
import { readFile } from "node:fs/promises";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { TAX_BENCHMARK_CLIENTS } from "./lib/tax-benchmark-clients";
import { runProgressiveOcrLocal } from "../src/lib/tax/progressive-ocr-core";
import {
  scanDocumentWideStmt2Exclusions,
  scanStatement2Total,
  extractOtherDeductionsBlockOpex,
} from "../src/lib/tax-return/statement-extractors";
import { computeComparisonOpexResidual } from "../src/lib/tax-return/comparison-opex";

const clientId = process.argv[2] ?? "sssi";
const year = Number(process.argv[3] ?? 2023);
const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === clientId)!;

async function main() {
  const pdfPath = await resolveTaxReturnPdf(client.docsDir, year);
  const bytes = new Uint8Array(await readFile(pdfPath));
  const embedded = await getEmbeddedPdfText(bytes);
  console.log("embedded chars:", embedded.length);

  const prog = await runProgressiveOcrLocal(bytes, pdfPath, embedded, "thorough", year);
  const allText = `${embedded}\n${prog.ocrText}`;
  console.log("ocr pages:", prog.ocrPages.length, "tiers:", prog.tiersRun.join(","));
  console.log("ocr chars:", prog.ocrText.length);
  console.log("opex parsed:", prog.parsed.values.other_operating_expenses);
  console.log("stmt2 total:", scanStatement2Total(allText));
  console.log("wide excl:", scanDocumentWideStmt2Exclusions(allText));
  console.log("block opex:", extractOtherDeductionsBlockOpex(allText));
  console.log(
    "comp residual:",
    computeComparisonOpexResidual(allText, year, 84813, { stmt2Total: 495681 }),
  );

  const hits: string[] = [];
  for (const line of allText.split(/\n/)) {
    const t = line.trim();
    if (/insurance|contract\s+labor|other\s+deduct|statement\s*2|178,?480|495,?681/i.test(t) && /\d/.test(t)) {
      hits.push(t.slice(0, 140));
    }
  }
  console.log("\n--- keyword lines (" + hits.length + ") ---");
  for (const h of hits.slice(0, 40)) console.log(h);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
