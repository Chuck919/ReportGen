/**
 * Workbook math audit on cached OCR parses.
 *   npx tsx scripts/audit-workbook-math.ts [mode]
 */
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { TAX_BENCHMARK_CLIENTS } from "./lib/tax-benchmark-clients";
import { computeWorkbookFormulas } from "../src/lib/tax/workbook-formulas";
import { OPERATING_EXPENSE_SLOT_IDS } from "../src/lib/tax/operating-expenses";
import { auditWorkbookMath } from "./lib/workbook-math-audit";

const mode = process.argv[2] ?? "balanced";
const CACHE_DIR = path.join(process.cwd(), "scripts", "ocr-cache");

async function hasCache(p: string) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveCache(clientId: string, year: number): Promise<string | null> {
  const named = path.join(CACHE_DIR, `${clientId}-${year}-${mode}.txt`);
  if (await hasCache(named)) return named;
  if (clientId === "kcf") {
    const legacy = path.join(CACHE_DIR, `${year}-${mode}.txt`);
    if (await hasCache(legacy)) return legacy;
  }
  return null;
}

async function main() {
  let formulaFails = 0;
  let checked = 0;

  console.log(`=== WORKBOOK MATH AUDIT mode=${mode} ===\n`);

  for (const client of TAX_BENCHMARK_CLIENTS) {
    for (const year of client.years) {
      const cp = await resolveCache(client.id, year);
      if (!cp) {
        console.log(`[${client.id} ${year}] SKIP (no ${mode} cache)`);
        continue;
      }
      checked++;
      const pdfPath = await resolveTaxReturnPdf(path.resolve(process.cwd(), client.docsDir), year);
      const bytes = await readFile(pdfPath);
      const embedded = await getEmbeddedPdfText(bytes);
      const ocr = await readFile(cp, "utf8");
      const parsed = parseTaxReturnFromText(path.basename(pdfPath), embedded, ocr, year, {
        ocrMode: mode as "balanced",
      });
      const values = parsed.values;
      const issues = auditWorkbookMath(values);
      const top8 = OPERATING_EXPENSE_SLOT_IDS.reduce((s, id) => s + Math.round(values[id] ?? 0), 0);
      const other = Math.round(values.other_operating_expenses ?? 0);
      const overhead = computeWorkbookFormulas(values).overhead_sga ?? 0;
      const op = computeWorkbookFormulas(values).operating_profit;
      const ni = computeWorkbookFormulas(values).net_income;

      const tag = issues.length ? "FORMULA MISMATCH" : "ok";
      if (issues.length) formulaFails++;
      console.log(
        `[${client.id} ${year}] ${tag} | overhead_sga=${overhead} (=top8 ${top8}) other_opex=${other} operating_profit=${op ?? "—"} net_income=${ni ?? "—"}`,
      );
      for (const i of issues) console.log(`  ${i.kind}: ${i.detail}`);
    }
  }
  console.log(`\nChecked ${checked} client-years — formula mismatches: ${formulaFails}`);
  console.log(
    "Note: Stmt-2 detail line totals are NOT expected to equal top8+other_opex; top8 is the largest buckets, other_opex is the residual.",
  );
  process.exit(formulaFails > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
