/** Does live OCR + cached page 16+21 blocks parse to 100%? Confirms missing-page root cause. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { TAX_BENCHMARK_CLIENTS } from "./lib/tax-benchmark-clients";

function pageBlock(text: string, n: number): string {
  const re = new RegExp(`--- OCR PAGE ${n} [^\\n]*\\n[\\s\\S]*?(?=--- OCR PAGE \\d|$)`);
  return text.match(re)?.[0] ?? "";
}

async function main() {
  const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === "sssi")!;
  const pdfPath = await resolveTaxReturnPdf(path.resolve(process.cwd(), client.docsDir), 2023);
  const bytes = await readFile(pdfPath);
  const embedded = await getEmbeddedPdfText(bytes);
  const live = await readFile("scripts/benchmark-output/sssi-2023-liveocr.txt", "utf8");
  const cache = await readFile("scripts/ocr-cache/sssi-2023-balanced.txt", "utf8");

  for (const [name, ocr] of [
    ["live-as-is", live],
    ["live+p21", `${live}\n${pageBlock(cache, 21)}`],
    ["live+p16+p21", `${live}\n${pageBlock(cache, 16)}\n${pageBlock(cache, 21)}`],
  ] as const) {
    const parsed = parseTaxReturnFromText(path.basename(pdfPath), embedded, ocr, 2023, {
      ocrMode: "balanced",
    });
    const v = parsed.values;
    console.log(`=== ${name} ===`);
    console.log(
      "officer",
      v.officer_compensation,
      "| insurance-seat?",
      Object.entries(v).filter(([, x]) => x === 324036).map(([k]) => k),
      "| util",
      Object.entries(v).filter(([, x]) => x === 27159).map(([k]) => k),
      "| prof",
      Object.entries(v).filter(([, x]) => x === 53833).map(([k]) => k),
    );
    console.log(
      "other_opex",
      v.other_operating_expenses,
      "interest",
      v.interest_expense,
      "src:",
      parsed.fieldSources?.interest_expense,
    );
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
