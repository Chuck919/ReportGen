import { readFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { TAX_BENCHMARK_CLIENTS } from "./lib/tax-benchmark-clients";
import {
  extractOtherDeductionsBlockOpex,
  extractStatement3OtherOperatingExpenses,
  extractStatementDeductions,
} from "../src/lib/tax-return/statement-extractors";
import { scanComparisonOtherDeductionsTotal, computeComparisonOpexResidual } from "../src/lib/tax-return/comparison-opex";

const clientId = process.argv[2] ?? "sssi";
const year = Number(process.argv[3] ?? 2023);

async function main() {
  const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === clientId)!;
  const pdf = await resolveTaxReturnPdf(path.resolve(process.cwd(), client.docsDir), year);
  const embedded = await getEmbeddedPdfText(await readFile(pdf));
  const ocr = await readFile(
    path.join(process.cwd(), "scripts", "ocr-cache", `${clientId}-${year}-thorough.txt`),
    "utf8",
  ).catch(() => "");
  const all = `${embedded}\n${ocr}`;

  const block = extractOtherDeductionsBlockOpex(all);
  const stmt3 = extractStatement3OtherOperatingExpenses(all);
  const stmt = extractStatementDeductions(all);
  const compTot = scanComparisonOtherDeductionsTotal(all, year);
  const prof = stmt.values.professional_fees ?? 0;
  const util = stmt.values.utilities ?? 0;
  const bank = stmt.values.bank_credit_card ?? 0;
  const att = prof + util + bank + (stmt.values.amortization ?? 0);
  const residual = computeComparisonOpexResidual(all, year, att, { attachmentSum: att, stmt2Total: compTot });

  console.log(`${clientId} ${year}`);
  console.log("block:", JSON.stringify(block));
  console.log("stmt3:", stmt3.values.other_operating_expenses, stmt3.sources.other_operating_expenses);
  console.log("stmt ded:", stmt.values);
  console.log("compTot:", compTot, "att:", att, "residual:", residual?.value);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
