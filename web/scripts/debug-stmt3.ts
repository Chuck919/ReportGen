/** Debug Stmt 3 / comparison other-deductions for a client year. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import {
  extractOtherDeductionsBlockOpex,
  extractStatement3OtherOperatingExpenses,
} from "../src/lib/tax-return/statement-extractors";
import { scanComparisonOtherDeductionsTotal } from "../src/lib/tax-return/comparison-opex";
import { TAX_BENCHMARK_CLIENTS } from "./lib/tax-benchmark-clients";

const clientId = process.argv[2] ?? "arizona-sun";
const year = Number(process.argv[3] ?? 2022);
const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === clientId)!;

async function main() {
  console.log(`[${clientId} ${year}] resolving PDF…`);
  const pdf = await resolveTaxReturnPdf(path.resolve(process.cwd(), client.docsDir), year);
  console.log(`reading ${path.basename(pdf)}…`);
  const t = await getEmbeddedPdfText(await readFile(pdf));
  console.log(`embedded ${t.length.toLocaleString()} chars\n`);

  console.log("compOtherDed", scanComparisonOtherDeductionsTotal(t, year));
  console.log("blockOpex", extractOtherDeductionsBlockOpex(t));
  console.log("stmt3", extractStatement3OtherOperatingExpenses(t));

  const starts = [...t.matchAll(/statement\s*3\b[^\n]{0,160}(?:other\s+deduct|form\s+1120)/gi)];
  console.log("\nstmt3 block headers:", starts.length);
  for (const m of starts.slice(0, 5)) {
    console.log(" ", m.index, m[0].replace(/\s+/g, " ").slice(0, 120));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
