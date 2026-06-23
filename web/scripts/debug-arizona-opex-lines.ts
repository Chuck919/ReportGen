import { readFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { TAX_BENCHMARK_CLIENTS, fixtureKey } from "./lib/tax-benchmark-clients";
import changwenFixtures from "./changwen-fixtures.json";

const EXCLUDE =
  /accounting\s*&|legal|auto\s+and\s+truck|contract\s+labor|forklift|insurance\b|production\s+support/i;

async function main() {
  const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === "arizona-sun")!;
  for (const year of [2022, 2023, 2024, 2025]) {
    const fk = fixtureKey(client, year);
    const expected = (changwenFixtures as Record<string, { values: Record<string, number> }>)[fk]?.values
      .other_operating_expenses;
    const pdf = await resolveTaxReturnPdf(path.resolve(process.cwd(), client.docsDir), year);
    const emb = await getEmbeddedPdfText(await readFile(pdf));
    let inBlock = false;
    let total = 0;
    let excluded = 0;
    let stmtTotal = 0;
    for (const raw of emb.split(/\n/)) {
      const line = raw.replace(/\s+/g, " ").trim();
      if (/STATEMENT 3 FORM 1120S OTHER DEDUCTIONS/i.test(line)) {
        inBlock = true;
        continue;
      }
      if (inBlock && /statement\s*[4-9]|stmt\s*[4-9]/i.test(line) && !/other\s+deduct/i.test(line)) break;
      if (!inBlock) continue;
      if (/^total\s+to\s+form/i.test(line)) {
        const m = line.match(/([\d,]+)\.?\s*$/);
        if (m) stmtTotal = Number(m[1].replace(/,/g, ""));
        continue;
      }
      const m = line.match(/^([A-Z].*?)\s+([\d,]+)\.?$/);
      if (!m) continue;
      const label = m[1];
      const amt = Number(m[2].replace(/,/g, ""));
      total += amt;
      if (EXCLUDE.test(label)) excluded += amt;
    }
    const opex = total - excluded;
    const pct = expected ? (Math.abs(opex - expected) / expected) * 100 : 0;
    console.log(
      `${year}: stmtTotal=${stmtTotal} sum=${total} excluded=${excluded} opex=${opex} exp=${expected} diff=${pct.toFixed(2)}%`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
