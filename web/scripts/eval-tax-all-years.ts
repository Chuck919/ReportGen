/**
 * Run full OCR + parseTaxReturn for 2023–2025 KC Fudge returns vs Excel fixtures.
 * Prints per-field confidence for website/debug use.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import { TAX_ATTACHMENT_FIELD_IDS } from "../src/lib/workbook-comparison-fixtures";
import { WORKBOOK_COMPARISON_FIXTURES } from "./lib/workbook-comparison-fixtures";
import { parseTaxReturn } from "../src/lib/tax-return-parser";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { TAX_WORKBOOK_ROWS } from "../src/lib/tax-workbook";

const INPUT_IDS = TAX_WORKBOOK_ROWS.filter((r) => r.excelBehavior === "input").map((r) => r.id);
const YEARS = [2023, 2024, 2025] as const;

function scoreField(expected: number, actual: number | undefined): boolean {
  if (actual === undefined) return false;
  if (expected === 0 && actual === 0) return true;
  if (expected === 0) return actual === 0;
  const rel = Math.abs(actual - expected) / Math.abs(expected);
  return rel <= 0.01;
}

async function embeddedTextFromPdf(bytes: Uint8Array): Promise<string> {
  const p = new PDFParse({ data: Buffer.from(bytes) });
  const text = await p.getText();
  await p.destroy?.();
  return text.text ?? "";
}

async function evalYear(year: number, docsDir: string) {
  const pdfPath = await resolveTaxReturnPdf(docsDir, year);
  const bytes = await readFile(pdfPath);
  const embedded = await embeddedTextFromPdf(bytes);
  const t0 = Date.now();
  const result = await parseTaxReturn(path.basename(pdfPath), bytes, embedded, year);
  const elapsed = Date.now() - t0;

  const expected = WORKBOOK_COMPARISON_FIXTURES.tax[`KCF MAIN CURRENT EXCEL.xlsx / ${year}`]?.values;
  if (!expected) throw new Error(`No fixture for ${year}`);

  let scored = 0;
  let correct = 0;
  let primaryScored = 0;
  let primaryCorrect = 0;
  let attachScored = 0;
  let attachCorrect = 0;
  const misses: string[] = [];
  const fieldRows: Array<{
    id: string;
    label: string;
    expected?: number;
    actual?: number;
    confidence?: number;
    source?: string;
    ok: boolean;
    tier: "primary" | "attachment" | "skipped";
  }> = [];

  for (const id of INPUT_IDS) {
    const exp = expected[id];
    if (exp === undefined) continue;
    const label = TAX_WORKBOOK_ROWS.find((r) => r.id === id)?.label ?? id;
    const actual = result.values[id];
    const conf = result.confidence?.[id];
    const source = result.fieldSources?.[id];
    const tier = TAX_ATTACHMENT_FIELD_IDS.has(id) ? "attachment" : "primary";

    if (exp === 0 && actual === undefined) {
      fieldRows.push({ id, label, expected: exp, actual, confidence: conf, source, ok: true, tier: "skipped" });
      continue;
    }

    scored++;
    const ok = scoreField(exp, actual);
    if (ok) correct++;
    else misses.push(`${label}: exp ${exp}, got ${actual ?? "(blank)"} (conf ${conf ?? "—"}%, src ${source ?? "—"})`);

    fieldRows.push({ id, label, expected: exp, actual, confidence: conf, source, ok, tier });
    if (tier === "attachment") {
      attachScored++;
      if (ok) attachCorrect++;
    } else {
      primaryScored++;
      if (ok) primaryCorrect++;
    }
  }

  const primaryPct = primaryScored ? (primaryCorrect / primaryScored) * 100 : 100;
  const allPct = scored ? (correct / scored) * 100 : 100;
  const attachPct = attachScored ? (attachCorrect / attachScored) * 100 : 100;

  console.log(`\n=== ${year} (${Math.round(elapsed / 1000)}s) ===`);
  console.log(
    `Primary: ${primaryCorrect}/${primaryScored} (${primaryPct.toFixed(1)}%) | Attachments: ${attachCorrect}/${attachScored} (${attachPct.toFixed(1)}%) | All: ${correct}/${scored} (${allPct.toFixed(1)}%)`,
  );

  const missingPrimary = fieldRows.filter((r) => r.tier === "primary" && !r.ok && (r.expected !== 0 || r.actual !== undefined));
  if (missingPrimary.length) {
    console.log("\nMissing / wrong (primary):");
    for (const r of missingPrimary) {
      console.log(
        `  ${r.label}: expected ${r.expected}, got ${r.actual ?? "(blank)"}, confidence ${r.confidence ?? "—"}%, source ${r.source ?? "—"}`,
      );
    }
  }

  const missingAttach = fieldRows.filter((r) => r.tier === "attachment" && !r.ok);
  if (missingAttach.length) {
    console.log("\nMissing / wrong (attachments):");
    for (const r of missingAttach) {
      console.log(
        `  ${r.label}: expected ${r.expected}, got ${r.actual ?? "(blank)"}, confidence ${r.confidence ?? "—"}%, source ${r.source ?? "—"}`,
      );
    }
  }

  const lowConf = fieldRows.filter(
    (r) => r.tier !== "skipped" && r.actual !== undefined && (r.confidence ?? 0) < 85 && r.ok,
  );
  if (lowConf.length) {
    console.log("\nCorrect but low confidence (<85%):");
    for (const r of lowConf.slice(0, 8)) {
      console.log(`  ${r.label}: ${r.actual} (${r.confidence}%)`);
    }
  }

  return { year, primaryPct, allPct, attachPct, primaryPass: primaryPct >= 95 };
}

async function main() {
  const docsDir = path.resolve(process.cwd(), "..", "Documents");
  const results = [];
  for (const year of YEARS) {
    results.push(await evalYear(year, docsDir));
  }

  console.log("\n=== Summary ===");
  for (const r of results) {
    console.log(
      `${r.year}: primary ${r.primaryPct.toFixed(1)}% | attachments ${r.attachPct.toFixed(1)}% | all ${r.allPct.toFixed(1)}% ${r.primaryPass ? "PASS" : "FAIL"}`,
    );
  }

  const allPrimaryPass = results.every((r) => r.primaryPass);
  process.exit(allPrimaryPass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
