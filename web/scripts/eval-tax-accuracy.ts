/**
 * Compare parseTaxReturn output against integ-sheet ground truth from KCF MAIN CURRENT EXCEL.xlsx.
 * Usage: npx tsx scripts/eval-tax-accuracy.ts [pdf-path] [--year 2023]
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import { parseTaxReturn } from "../src/lib/tax-return-parser";
import { TAX_WORKBOOK_ROWS } from "../src/lib/tax-workbook";
import {
  TAX_ATTACHMENT_FIELD_IDS,
  WORKBOOK_COMPARISON_FIXTURES,
} from "../src/lib/workbook-comparison-fixtures";

const INPUT_IDS = TAX_WORKBOOK_ROWS.filter((r) => r.excelBehavior === "input").map((r) => r.id);

function parseArgs(argv: string[]) {
  let pdfPath = "";
  let yearOverride: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--year" && argv[i + 1]) {
      yearOverride = Number(argv[++i]);
    } else if (!argv[i].startsWith("-")) {
      pdfPath = argv[i];
    }
  }
  return { pdfPath, yearOverride };
}

function fixtureForYear(year: number): Record<string, number> | undefined {
  const key = `KCF MAIN CURRENT EXCEL.xlsx / ${year}`;
  return WORKBOOK_COMPARISON_FIXTURES.tax[key]?.values;
}

function scoreField(expected: number, actual: number | undefined): { ok: boolean; pct: number } {
  if (actual === undefined) return { ok: false, pct: 0 };
  if (expected === 0 && actual === 0) return { ok: true, pct: 100 };
  if (expected === 0) return { ok: actual === 0, pct: actual === 0 ? 100 : 0 };
  const rel = Math.abs(actual - expected) / Math.abs(expected);
  if (rel <= 0.01) return { ok: true, pct: 100 };
  if (rel <= 0.05) return { ok: true, pct: 95 };
  return { ok: false, pct: Math.max(0, 100 - rel * 100) };
}

async function embeddedTextFromPdf(bytes: Uint8Array): Promise<string> {
  const p = new PDFParse({ data: Buffer.from(bytes) });
  const text = await p.getText();
  await p.destroy?.();
  return text.text ?? "";
}

async function main() {
  const docs = path.resolve(process.cwd(), "..", "Documents");
  const defaultPdf = path.join(docs, "KC Fudge LLC_2023 Business Tax Return_2023-12-31.pdf");
  const { pdfPath: argPath, yearOverride } = parseArgs(process.argv.slice(2));
  const pdfPath = argPath || defaultPdf;
  const bytes = await readFile(pdfPath);
  const filename = path.basename(pdfPath);
  const embedded = await embeddedTextFromPdf(bytes);

  const t0 = Date.now();
  const result = await parseTaxReturn(filename, bytes, embedded, yearOverride);
  const elapsed = Date.now() - t0;

  const expected = fixtureForYear(result.year);
  if (!expected) {
    console.error(`No fixture for year ${result.year}. Add to workbook-comparison-fixtures.ts`);
    process.exit(2);
  }

  const rows: Array<{
    id: string;
    label: string;
    expected: number;
    actual?: number;
    ok: boolean;
    pct: number;
  }> = [];

  for (const id of INPUT_IDS) {
    const exp = expected[id];
    if (exp === undefined) continue;
    const actual = result.values[id];
    const { ok, pct } = scoreField(exp, actual);
    const label = TAX_WORKBOOK_ROWS.find((r) => r.id === id)?.label ?? id;
    rows.push({ id, label, expected: exp, actual, ok, pct });
  }

  const scored = rows.filter((r) => r.expected !== 0 || r.actual !== undefined);
  const primary = scored.filter((r) => !TAX_ATTACHMENT_FIELD_IDS.has(r.id));
  const attachment = scored.filter((r) => TAX_ATTACHMENT_FIELD_IDS.has(r.id));
  const correct = scored.filter((r) => r.ok).length;
  const primaryCorrect = primary.filter((r) => r.ok).length;
  const attachmentCorrect = attachment.filter((r) => r.ok).length;
  const accuracy = scored.length ? (correct / scored.length) * 100 : 0;
  const primaryAccuracy = primary.length ? (primaryCorrect / primary.length) * 100 : 0;
  const meanPct = scored.length ? scored.reduce((s, r) => s + r.pct, 0) / scored.length : 0;

  console.log(`\nFile: ${filename}`);
  console.log(`Year: ${result.year} | Source: ${result.source} | ${elapsed}ms`);
  console.log(
    `All fields: ${correct}/${scored.length} (${accuracy.toFixed(1)}%) | Primary forms: ${primaryCorrect}/${primary.length} (${primaryAccuracy.toFixed(1)}%) | Attachments: ${attachmentCorrect}/${attachment.length}`,
  );
  console.log(`Mean field score: ${meanPct.toFixed(1)}%`);
  console.log("\nMisses:");
  for (const r of rows.filter((x) => !x.ok && (x.expected !== 0 || x.actual !== undefined))) {
    console.log(`  ${r.label}: expected ${r.expected}, got ${r.actual ?? "(blank)"} (${r.pct.toFixed(0)}%)`);
  }
  console.log("\nOK sample:");
  for (const r of rows.filter((x) => x.ok).slice(0, 12)) {
    console.log(`  ${r.label}: ${r.actual}`);
  }

  if (result.warnings?.length) {
    console.log(`\nWarnings (${result.warnings.length}):`);
    for (const w of result.warnings.slice(0, 15)) console.log(`  - ${w}`);
  }

  process.exit(primaryAccuracy >= 95 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
