import { readFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { TAX_BENCHMARK_CLIENTS } from "./lib/tax-benchmark-clients";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";

async function main() {
  const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === "sssi")!;
  const year = Number(process.argv[2] ?? 2023);
  const pdfPath = await resolveTaxReturnPdf(path.resolve(process.cwd(), client.docsDir), year);
  const bytes = await readFile(pdfPath);
  const embedded = await getEmbeddedPdfText(bytes);
  const ocr = await readFile(`scripts/ocr-cache/sssi-${year}-balanced.txt`, "utf8");

  let debugInfo: unknown;
  const parsed = parseTaxReturnFromText(path.basename(pdfPath), embedded, ocr, year, {
    ocrMode: "balanced",
    parseDebug: {
      onOpexReconcile: (d: unknown) => {
        debugInfo = d;
      },
    },
  });

  console.log(
    "other_operating_expenses:",
    parsed.values.other_operating_expenses,
    parsed.fieldSources?.other_operating_expenses,
  );
  console.log("sales:", parsed.values.sales);
  console.log("DEBUG:", JSON.stringify(debugInfo, null, 2));
  process.exit(0);
}
main();
