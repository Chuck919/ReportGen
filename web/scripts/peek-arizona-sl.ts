import { readFile } from "node:fs/promises";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { TAX_BENCHMARK_CLIENTS, resolveClientDocsDir } from "./lib/tax-benchmark-clients";

async function main() {
  const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === "arizona-sun")!;
  const year = Number(process.argv[2] ?? 2023);
  const docsDir = resolveClientDocsDir(client);
  const pdfPath = await resolveTaxReturnPdf(docsDir, year);
  const embedded = await getEmbeddedPdfText(await readFile(pdfPath));
  const anchor = embedded.search(/schedule\s+l[\s\S]{0,200}?\d{1,3}(?:,\d{3})*\./i);
  console.log("anchor", anchor);
  console.log(embedded.slice(anchor, anchor + 1200));
}

main().catch(console.error);
