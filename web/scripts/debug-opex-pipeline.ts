import { readFile } from "node:fs/promises";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { TAX_BENCHMARK_CLIENTS } from "./lib/tax-benchmark-clients";
import { scanFormLine20OtherDeductionsTotal } from "../src/lib/tax-return/form-anchors";
import {
  scanStatement2Total,
  extractOtherDeductionsBlockOpex,
  extractStatementDeductions,
  extractStatement3OtherOperatingExpenses,
} from "../src/lib/tax-return/statement-extractors";
import { knownStmt2AttachmentSum } from "../src/lib/tax-return/stmt2-total-inference";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import {
  computeComparisonOpexResidual,
  scanComparisonOtherDeductionsTotal,
  pickComparisonOpex,
} from "../src/lib/tax-return/comparison-opex";

const clientId = process.argv[2] ?? "carithers";
const year = Number(process.argv[3] ?? 2023);
const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === clientId)!;

async function main() {
  const pdfPath = await resolveTaxReturnPdf(client.docsDir, year);
  const embedded = await getEmbeddedPdfText(await readFile(pdfPath));
  const ocr = await readFile(`scripts/ocr-cache/${clientId}-${year}-thorough.txt`, "utf8").catch(() => "");
  const allText = `${embedded}\n${ocr}`;
  const formKind = clientId === "sssi" ? "1120" : "1120-s";

  const r = parseTaxReturnFromText("x.pdf", embedded, ocr, year, { ocrMode: "thorough" });
  const resolved = { values: r.values, confidence: {} as Record<string, number>, sources: {} as Record<string, string> };
  const attach = knownStmt2AttachmentSum(resolved, allText);

  console.log("form20", scanFormLine20OtherDeductionsTotal(allText, formKind));
  console.log("stmt2scan", scanStatement2Total(allText));
  console.log("comp stmt2", scanComparisonOtherDeductionsTotal(allText, year));
  console.log("block", extractOtherDeductionsBlockOpex(allText));
  console.log("stmt ded", extractStatementDeductions(allText).values);
  console.log("stmt3", extractStatement3OtherOperatingExpenses(allText).values);
  console.log("attachSum", attach);
  console.log("opex", r.values.other_operating_expenses, r.fieldSources?.other_operating_expenses);
  console.log(
    "comp residual",
    computeComparisonOpexResidual(allText, year, attach, {}, resolved),
  );
  console.log("pickComparisonOpex", pickComparisonOpex(allText, year, null, { attachmentSum: attach }, resolved));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
