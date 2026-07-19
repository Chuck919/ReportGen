/** Total page count + phase-1 scan bands for the sssi 2023 PDF. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { TAX_BENCHMARK_CLIENTS } from "./lib/tax-benchmark-clients";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readPdfPageTotal, heuristicPages, stmt2HintPagesFromEmbedded } = require("./ocr-targets.cjs");

async function main() {
  const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === "sssi")!;
  const pdfPath = await resolveTaxReturnPdf(path.resolve(process.cwd(), client.docsDir), 2023);
  const bytes = await readFile(pdfPath);
  const total = await readPdfPageTotal(Buffer.from(bytes));
  console.log("total pages:", total);
  const heur = heuristicPages(total, "tax");
  console.log("heuristicPages(tax):", heur.join(","));
  // phase1ScanPages = head 1..14 + heuristic
  const head = Array.from({ length: Math.min(14, total) }, (_, i) => i + 1);
  const scan = [...new Set([...head, ...heur])].sort((a, b) => a - b);
  console.log("phase1 scan pages:", scan.join(","));
  const missing = [];
  for (let p = 1; p <= total; p++) if (!scan.includes(p)) missing.push(p);
  console.log("phase1 blind pages:", missing.join(","));
  const embedded = await getEmbeddedPdfText(bytes);
  console.log("embedded text length:", embedded.length);
  console.log("stmt2 hint pages from embedded:", stmt2HintPagesFromEmbedded(embedded).join(",") || "(none)");
}
main().catch((e) => { console.error(e); process.exit(1); });
