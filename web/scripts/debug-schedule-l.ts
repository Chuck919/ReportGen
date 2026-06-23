import { readFile } from "node:fs/promises";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { TAX_BENCHMARK_CLIENTS } from "./lib/tax-benchmark-clients";
import { extractScheduleLFields } from "../src/lib/tax-return/schedule-l";
import { extractEmbeddedScheduleL } from "../src/lib/tax-return/embedded-schedule-l";

const clientId = process.argv[2] ?? "carithers";
const year = Number(process.argv[3] ?? 2022);
const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === clientId)!;

async function main() {
  const pdfPath = await resolveTaxReturnPdf(client.docsDir, year);
  const embedded = await getEmbeddedPdfText(await readFile(pdfPath));
  const ocr = await readFile(`scripts/ocr-cache/${clientId}-${year}-thorough.txt`, "utf8").catch(() => "");

  const emb = extractEmbeddedScheduleL(embedded);
  const ocrSl = extractScheduleLFields(ocr);
  const allSl = extractScheduleLFields(`${embedded}\n${ocr}`);

  const cashLine = ocr.split(/\n/).find((l) => /1\s*cash/i.test(l));
  console.log("cash line:", cashLine?.slice(0, 80));

  console.log("embedded:", emb.values.cash, emb.sources.cash);
  console.log("ocr:", ocrSl.values.cash, ocrSl.sources.cash);
  console.log("all:", allSl.values.cash, allSl.sources.cash);
  console.log("cpltd ocr:", ocrSl.values.current_portion_ltd, ocrSl.sources.current_portion_ltd);
  console.log("cpltd all:", allSl.values.current_portion_ltd, allSl.sources.current_portion_ltd);
}

main().catch(console.error);
