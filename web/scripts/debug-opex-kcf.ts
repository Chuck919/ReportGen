import { readFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { parseTwoYearComparisonBlock, classifyComparisonLine } from "../src/lib/two-year-comparison-parser";
import { extractStatementDeductions } from "../src/lib/tax-return/statement-extractors";
import { parseTaxReturn } from "../src/lib/tax-return-parser";
import { runLocalOcr } from "../src/lib/tax-return/local-ocr";
import { TAX_BENCHMARK_CLIENTS } from "./lib/tax-benchmark-clients";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";

const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === "kcf")!;
const year = Number(process.argv[2] ?? 2023);

async function main() {
  const docsDir = path.resolve(process.cwd(), client.docsDir);
  const pdfPath = await resolveTaxReturnPdf(docsDir, year);
  const bytes = await readFile(pdfPath);
  const embedded = await getEmbeddedPdfText(bytes);
  const ocr = await runLocalOcr(bytes, { mode: "thorough" });
  const allText = `${embedded}\n${ocr.text}`;

  const comp = parseTwoYearComparisonBlock(allText, year);
  console.log("comparison lines:", comp?.linesMatched);
  console.log("comparison other_operating_expenses:", comp?.values.other_operating_expenses);

  const stmt = extractStatementDeductions(allText);
  console.log("stmt other_operating_expenses:", stmt.values.other_operating_expenses, stmt.sources.other_operating_expenses);
  console.log("stmt bank/pro/util:", stmt.values.bank_credit_card, stmt.values.professional_fees, stmt.values.utilities);

  const live = await parseTaxReturn(path.basename(pdfPath), bytes, embedded, year, "thorough");
  console.log("live other_operating_expenses:", live.values.other_operating_expenses, live.fieldSources?.other_operating_expenses);
  console.log("live amortization:", live.values.amortization, live.fieldSources?.amortization);

  const targets = [17425, 17891, 27110, 16670];
  console.log("\nLines with expected OPEX amounts:");
  for (const rawLine of allText.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (targets.some((t) => line.includes(t.toLocaleString()) || line.includes(String(t)))) {
      console.log(" ", line.slice(0, 140));
      console.log("   classify:", classifyComparisonLine(line));
    }
  }

  console.log("\nLines matching other deduct / operat exp:");
  for (const rawLine of allText.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (/other\s+operat|other\s+deduct|ober\s+desucon/i.test(line) && /\d/.test(line)) {
      console.log(" ", line.slice(0, 160));
      console.log("   classify:", classifyComparisonLine(line));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
