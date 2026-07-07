/**
 * Deep-dive: what OCR contains for Stmt-2 opex vs what we extract vs fixture top8.
 * Usage: npx tsx scripts/debug-opex-ocr.ts [clientId] [year] [mode]
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { finalizeTaxColumns } from "../src/lib/tax/merge-years";
import { enrichParsedTaxYear } from "../src/lib/tax/apply-user-correction";
import { TAX_BENCHMARK_CLIENTS, fixtureKey } from "./lib/tax-benchmark-clients";
import {
  OPERATING_EXPENSE_SLOT_IDS,
  buildOperatingExpenseLedger,
  expenseCategoryKey,
  extractOperatingExpenseLinesFromText,
} from "../src/lib/tax/operating-expenses";
import { actualTop8Amounts, resolveExpectedTop8Amounts } from "../src/lib/tax/fixture-top8";
import {
  extractDocumentWideDeductionLines,
  extractStatementExpenseLines,
  scanStatement2Total,
} from "../src/lib/tax-return/statement-extractors";
import { WORKBOOK_COMPARISON_FIXTURES } from "../src/lib/workbook-comparison-fixtures";
import changwenFixtures from "./changwen-fixtures.json";

const clientId = process.argv[2] ?? "carithers";
const yearArg = process.argv[3] ? Number(process.argv[3]) : undefined;
const mode = (process.argv[4] ?? "balanced") as "balanced" | "thorough";

const CACHE_DIR = path.join(process.cwd(), "scripts", "ocr-cache");

const ALL_FIXTURES: Record<string, { values: Record<string, number>; top8Amounts?: number[] }> = {
  ...WORKBOOK_COMPARISON_FIXTURES.tax,
  ...(changwenFixtures as Record<string, { values: Record<string, number>; top8Amounts?: number[] }>),
};

async function loadOcr(clientId: string, year: number): Promise<string> {
  const named = path.join(CACHE_DIR, `${clientId}-${year}-${mode}.txt`);
  try {
    return await readFile(named, "utf8");
  } catch {
    if (clientId === "kcf") return readFile(path.join(CACHE_DIR, `${year}-${mode}.txt`), "utf8");
    throw new Error(`No cache: ${named}`);
  }
}

function textHasAmount(text: string, amount: number): boolean {
  const patterns = [
    amount.toLocaleString("en-US"),
    amount.toString(),
    String(amount).replace(/(\d)(?=(\d{3})+(?!\d))/g, "$1,"),
    amount.toFixed(2),
  ];
  return patterns.some((p) => text.includes(p));
}

function findAmountInText(text: string, amount: number): string[] {
  const hits: string[] = [];
  const patterns = [
    amount.toLocaleString("en-US"),
    amount.toString(),
    String(amount).replace(/(\d)(?=(\d{3})+(?!\d))/g, "$1,"),
  ];
  for (const raw of text.split(/\n/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    for (const p of patterns) {
      if (line.includes(p)) {
        hits.push(line.slice(0, 120));
        break;
      }
    }
  }
  return hits;
}

function stmt2Snippet(text: string, maxLines = 80): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of text.split(/\n/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (/statement\s*2|stmt\s*2|other\s+deduct/i.test(line) && !/comparison/i.test(line)) {
      inBlock = true;
      out.push(`>> ${line}`);
      continue;
    }
    if (inBlock && /statement\s*[3-9]|two\s*year\s*comparison/i.test(line)) break;
    if (inBlock && line) out.push(line);
    if (out.length >= maxLines) break;
  }
  return out;
}

function stmt2HintPagesFromEmbedded(embeddedText: string): number[] {
  const pages = new Set<number>();
  const pageRe = /---\s*EMBEDDED\s+PAGE\s+(\d+)/gi;
  const markers: Array<{ page: number; idx: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = pageRe.exec(embeddedText)) !== null) {
    markers.push({ page: Number(m[1]), idx: m.index });
  }
  if (!markers.length) return [];
  const findPage = (idx: number) => {
    let p = markers[0]!.page;
    for (const mk of markers) {
      if (mk.idx <= idx) p = mk.page;
      else break;
    }
    return p;
  };
  const hints = [
    /federal\s+statements/i,
    /statement\s*2\s*[-–].*form\s+1120/i,
    /see\s+stmt\s*2/i,
    /description\s+amount[\s\S]{0,200}other\s+deduct/i,
  ];
  for (const re of hints) {
    let hit: RegExpExecArray | null;
    const r = new RegExp(re.source, re.flags.includes("i") ? re.flags : `${re.flags}i`);
    while ((hit = r.exec(embeddedText)) !== null) {
      const pg = findPage(hit.index);
      if (pg > 0) {
        pages.add(pg);
        if (pg > 1) pages.add(pg - 1);
        pages.add(pg + 1);
      }
    }
  }
  return [...pages].sort((a, b) => a - b);
}

type GapVerdict = "OK" | "ABSENT_FROM_TEXT" | "IN_TEXT_NOT_EXTRACTED" | "EXTRACTED_NOT_IN_TOP8";

function diagnoseAmountGap(
  amount: number,
  embedded: string,
  ocr: string,
  allText: string,
  pools: {
    naive: boolean;
    stmt: boolean;
    targeted: boolean;
    ledger: boolean;
    finalTop8: boolean;
  },
): { verdict: GapVerdict; detail: string } {
  if (pools.finalTop8) return { verdict: "OK", detail: "in final top8" };

  const inEmb = textHasAmount(embedded, amount);
  const inOcr = textHasAmount(ocr, amount);
  const inAll = inEmb || inOcr;

  if (!inAll) {
    return {
      verdict: "ABSENT_FROM_TEXT",
      detail: "not in embedded or OCR — Stmt-2 attachment page likely missing from OCR cache",
    };
  }
  if (pools.ledger) {
    return { verdict: "EXTRACTED_NOT_IN_TOP8", detail: "in ledger but dropped by top-8 / slot assignment" };
  }
  if (pools.stmt || pools.targeted || pools.naive) {
    return { verdict: "IN_TEXT_NOT_EXTRACTED", detail: "partial pool hit but not in merged ledger" };
  }
  const where = inEmb && inOcr ? "embedded+OCR" : inEmb ? "embedded only" : "OCR only";
  return {
    verdict: "IN_TEXT_NOT_EXTRACTED",
    detail: `amount present (${where}) but no extractor captured labeled line`,
  };
}

async function diagnoseYear(clientId: string, year: number) {
  const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === clientId);
  if (!client) throw new Error(`Unknown client ${clientId}`);

  const pdfPath = await resolveTaxReturnPdf(path.resolve(process.cwd(), client.docsDir), year);
  const bytes = await readFile(pdfPath);
  const embedded = await getEmbeddedPdfText(bytes);
  const ocr = await loadOcr(clientId, year);
  const allText = `${embedded}\n${ocr}`;

  const parsed = parseTaxReturnFromText(path.basename(pdfPath), embedded, ocr, year, { ocrMode: mode });
  const merged = finalizeTaxColumns([enrichParsedTaxYear(parsed)])[0]!;

  const fk = fixtureKey(client, year);
  const fixture = ALL_FIXTURES[fk];
  if (!fixture) throw new Error(`No fixture for ${fk}`);
  const expected = resolveExpectedTop8Amounts(fixture);

  const naive = extractOperatingExpenseLinesFromText(allText);
  const stmt = extractStatementExpenseLines(allText);
  const targeted = extractDocumentWideDeductionLines(allText);
  const ledger = buildOperatingExpenseLedger(
    {
      values: parsed.values,
      fieldSources: parsed.fieldSources,
      operatingExpenseLines: parsed.operatingExpenseLines,
      year: parsed.year,
    },
    allText,
  );

  const actual = actualTop8Amounts(merged.workbookValues ?? merged.values);
  const stmt2Total = scanStatement2Total(allText);
  const hintPages = stmt2HintPagesFromEmbedded(embedded);

  console.log(`\n${"=".repeat(72)}`);
  console.log(`${clientId} ${year} mode=${mode}`);
  console.log(`Fixture: ${fk}`);
  console.log(`Expected top8: ${expected.join(", ")}`);
  console.log(`Actual top8:   ${actual.join(", ")}`);
  console.log(`Stmt-2 total (scan): ${stmt2Total ?? "—"}`);
  console.log(`Embedded Stmt-2 hint pages: ${hintPages.length ? hintPages.join(", ") : "none"}`);

  console.log("\n--- Slot mapping after merge ---");
  for (const id of OPERATING_EXPENSE_SLOT_IDS) {
    const v = merged.workbookValues?.[id] ?? merged.values[id];
    const src = merged.fieldSources?.[id] ?? "";
    const label = merged.opexSlotLabels?.[id] ?? "";
    console.log(`  ${id}: ${v ?? "—"} | ${label} | ${src}`);
  }

  console.log("\n--- Per-amount gap diagnosis ---");
  for (const exp of expected) {
    const got = actual.some((a) => Math.abs(a - exp) <= Math.max(500, exp * 0.01));
    if (got) continue;
    const pools = {
      naive: naive.some((l) => l.amount === exp),
      stmt: stmt.some((l) => l.amount === exp),
      targeted: targeted.some((l) => l.amount === exp),
      ledger: ledger.some((l) => l.amount === exp),
      finalTop8: false,
    };
    const { verdict, detail } = diagnoseAmountGap(exp, embedded, ocr, allText, pools);
    const ocrHits = findAmountInText(ocr, exp);
    const embHits = findAmountInText(embedded, exp);
    console.log(`  MISS ${exp} → ${verdict}`);
    console.log(`    ${detail}`);
    console.log(`    OCR (${ocrHits.length}): ${ocrHits.slice(0, 2).join(" | ") || "none"}`);
    console.log(`    Embedded (${embHits.length}): ${embHits.slice(0, 2).join(" | ") || "none"}`);
    console.log(
      `    Pools: naive=${pools.naive} stmt=${pools.stmt} targeted=${pools.targeted} ledger=${pools.ledger}`,
    );
  }

  console.log("\n--- Stmt-2 OCR snippet ---");
  stmt2Snippet(ocr, 40).forEach((l) => console.log(`  ${l}`));

  console.log("\n--- extractDocumentWideDeductionLines ---");
  targeted.forEach((l) =>
    console.log(`  ${l.amount}\t[${expenseCategoryKey(l.label) ?? "?"}]\t${l.label.slice(0, 50)}`),
  );

  console.log("\n--- extractStatementExpenseLines (top 15) ---");
  stmt.slice(0, 15).forEach((l) =>
    console.log(`  ${l.amount}\t[${expenseCategoryKey(l.label) ?? "?"}]\t${l.label.slice(0, 50)} (${l.source})`),
  );

  console.log("\n--- buildOperatingExpenseLedger (top 15) ---");
  ledger.slice(0, 15).forEach((l) =>
    console.log(`  ${l.amount}\t[${expenseCategoryKey(l.label) ?? "?"}]\t${l.label.slice(0, 50)} (${l.source})`),
  );
}

async function main() {
  const client = TAX_BENCHMARK_CLIENTS.find((c) => c.id === clientId);
  if (!client) throw new Error(`Unknown client ${clientId}`);
  const years = yearArg ? [yearArg] : client.years;
  for (const y of years) {
    await diagnoseYear(clientId, y);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
