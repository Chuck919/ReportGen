import { readFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { TAX_BENCHMARK_CLIENTS } from "./lib/tax-benchmark-clients";
import {
  extractStatementDeductions,
  scanStmt2MiscLineAmounts,
  scanStatement2Total,
  extractOtherDeductionsBlockOpex,
} from "../src/lib/tax-return/statement-extractors";
import {
  scanComparisonOtherDeductionsTotal,
  computeComparisonOpexResidual,
} from "../src/lib/tax-return/comparison-opex";
import { knownStmt2AttachmentSum } from "../src/lib/tax-return/stmt2-total-inference";

async function main() {
const clientId = process.argv[2] ?? "carithers";
const year = Number(process.argv[3] ?? 2021);
const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === clientId)!;

const pdf = await resolveTaxReturnPdf(path.resolve(client.docsDir), year);
const emb = await getEmbeddedPdfText(await readFile(pdf));
const ded = extractStatementDeductions(emb);
console.log("stmt2 ded", ded.values);
console.log("misc", scanStmt2MiscLineAmounts(emb));
console.log("stmt2 total", scanStatement2Total(emb));
console.log("comp other ded", scanComparisonOtherDeductionsTotal(emb, year));
const resolved = {
  values: { ...ded.values, professional_fees: 24390, utilities: 14059 },
  confidence: {},
  sources: {},
  warnings: [],
};
const sum = knownStmt2AttachmentSum(resolved as never, emb);
console.log("attachmentSum", sum);
console.log("residual", computeComparisonOpexResidual(emb, year, sum));
console.log("blockOpex", extractOtherDeductionsBlockOpex(emb));
}

main();
