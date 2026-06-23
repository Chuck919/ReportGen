/** Debug opex candidates for one client-year (embedded + optional OCR cache). */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { TAX_BENCHMARK_CLIENTS, fixtureKey } from "./lib/tax-benchmark-clients";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { scoreAllFields } from "./lib/tax-benchmark-score";
import changwenFixtures from "./changwen-fixtures.json";
import { WORKBOOK_COMPARISON_FIXTURES } from "../src/lib/workbook-comparison-fixtures";

const clientId = process.argv[2] ?? "arizona-sun";
const year = Number(process.argv[3] ?? 2025);
const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === clientId)!;

const ALL_FIXTURES = {
  ...WORKBOOK_COMPARISON_FIXTURES.tax,
  ...(changwenFixtures as Record<string, { values: Record<string, number> }>),
};

async function main() {
  const pdfPath = await resolveTaxReturnPdf(client.docsDir, year);
  const embedded = await getEmbeddedPdfText(await readFile(pdfPath));
  const ocr = await readFile(`scripts/ocr-cache/${clientId}-${year}-thorough.txt`, "utf8").catch(() => "");

  let opexDebug: unknown;
  const r = parseTaxReturnFromText(path.basename(pdfPath), embedded, ocr, year, {
    ocrMode: "thorough",
    parseDebug: { onOpexReconcile: (d) => { opexDebug = d; } },
  });

  const fk = fixtureKey(client, year);
  const score = scoreAllFields(fk, r.values);
  const exp = ALL_FIXTURES[fk]?.values.other_operating_expenses;

  console.log(`=== ${clientId} ${year} opex=${r.values.other_operating_expenses} exp=${exp} ===`);
  console.log(`source: ${r.fieldSources?.other_operating_expenses}`);
  console.log(`displayConfidence: ${r.displayConfidence?.other_operating_expenses}`);
  console.log(`fieldFlags: ${(r.fieldFlags?.other_operating_expenses ?? []).join(" | ")}`);
  console.log(`ocrCoverage: ${(r.ocrCoverage?.flags ?? []).join(" | ")}`);
  console.log(`all-fields: ${score.pct.toFixed(1)}% misses: ${score.misses.join("; ")}`);
  console.log("\ncandidates:");
  const dbg = opexDebug as { candidates?: Array<{ value: number; source: string; totalScore: number; closureScore: number; valid: boolean; plausibilityFlags: string[] }>; chosenSource?: string; finalValue?: number };
  const debugOk =
    dbg?.finalValue === r.values.other_operating_expenses &&
    dbg?.chosenSource === r.fieldSources?.other_operating_expenses;
  console.log(`debug_truthful: ${debugOk ? "yes" : "NO"} (final=${dbg?.finalValue} src=${dbg?.chosenSource})`);
  for (const c of dbg?.candidates ?? []) {
    const mark = c.value === r.values.other_operating_expenses ? " *" : "";
    const expMark = exp !== undefined && Math.abs(c.value - exp) <= Math.max(500, exp * 0.01) ? " ✓fixture" : "";
    console.log(
      `  ${c.value} score=${c.totalScore.toFixed(1)} closure=${c.closureScore.toFixed(2)} valid=${c.valid} flags=${c.plausibilityFlags.join(",")}${mark}${expMark}`,
    );
    console.log(`    ${c.source}`);
  }
}

main().catch(console.error);
