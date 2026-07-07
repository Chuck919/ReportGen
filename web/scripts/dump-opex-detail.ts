/**
 * Dump per-year opex slot values + multiset diagnostics (UI-session merge path).
 * Usage: npx tsx scripts/dump-opex-detail.ts [balanced|thorough] [clientId?]
 */
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { parseTaxReturnFromText } from "../src/lib/tax-return/parse-from-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import { mergeParsedTaxYears } from "../src/lib/tax/client-merge";
import { TAX_BENCHMARK_CLIENTS, fixtureKey } from "./lib/tax-benchmark-clients";
import {
  OPERATING_EXPENSE_SLOT_IDS,
  diagnoseTop8OpexMultiset,
  sharedOpexSlotLabels,
} from "../src/lib/tax/operating-expenses";
import { resolveExpectedTop8Amounts } from "../src/lib/tax/fixture-top8";
import { computeWorkbookFormulas } from "../src/lib/tax/workbook-formulas";
import { scoreOpexAmountsOnly, scoreAllFieldsExcludingOpexSlots } from "./lib/tax-benchmark-score";
import { WORKBOOK_COMPARISON_FIXTURES } from "../src/lib/workbook-comparison-fixtures";
import changwenFixtures from "./changwen-fixtures.json";
import { forceExit } from "./lib/force-exit";

const mode = (process.argv[2] ?? "balanced") as "fast" | "balanced" | "thorough";
const onlyClient = process.argv[3];
const label = process.env.PIPELINE_LABEL ?? "current";
const CACHE_DIR = path.join(process.cwd(), "scripts", "ocr-cache");

const ALL_FIXTURES: Record<string, { year: number; values: Record<string, number>; top8Amounts?: number[] }> = {
  ...WORKBOOK_COMPARISON_FIXTURES.tax,
  ...(changwenFixtures as Record<string, { year: number; values: Record<string, number>; top8Amounts?: number[] }>),
};

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
  const clients = TAX_BENCHMARK_CLIENTS.filter((c) => !onlyClient || c.id === onlyClient);
  const out: Record<string, unknown> = { label, mode, clients: {} as Record<string, unknown> };

  for (const client of clients) {
    const parsedYears = [];
    for (const year of client.years) {
      const pdfPath = await resolveTaxReturnPdf(path.resolve(process.cwd(), client.docsDir), year);
      const bytes = await readFile(pdfPath);
      const embedded = await getEmbeddedPdfText(bytes);
      const cp = await resolveCache(client.id, year);
      if (!cp) {
        console.error(`skip ${client.id} ${year}: no cache`);
        continue;
      }
      const ocr = await readFile(cp, "utf8");
      const parsed = parseTaxReturnFromText(path.basename(pdfPath), embedded, ocr, year, {
        ocrMode: mode,
      });
      parsedYears.push({ ...parsed, filename: path.basename(pdfPath), parseStatus: parsed.parseStatus ?? "ok" });
    }
    if (!parsedYears.length) continue;

    const { columns: finalized } = mergeParsedTaxYears([], parsedYears);
    const opexLabels = sharedOpexSlotLabels(finalized);
    const years: Record<string, unknown> = {};

    for (const col of finalized) {
      const fk = fixtureKey(client, col.year);
      const fixture = ALL_FIXTURES[fk];
      if (!fixture) continue;

      const values = col.workbookValues ?? col.values;
      const formulas = computeWorkbookFormulas(values);
      const multiset = diagnoseTop8OpexMultiset(fixture, values);
      const opexScore = scoreOpexAmountsOnly(fk, values);
      const fieldScore = scoreAllFieldsExcludingOpexSlots(fk, values);

      const slots = OPERATING_EXPENSE_SLOT_IDS.map((id) => ({
        id,
        label: opexLabels[id] ?? id,
        actual: values[id] ?? null,
        source: col.fieldSources?.[id] ?? null,
      }));

      years[String(col.year)] = {
        opexPct: opexScore.pct,
        opexOk: opexScore.ok,
        opexN: opexScore.n,
        fieldPctExclOpex: fieldScore.pct,
        expectedTop8: resolveExpectedTop8Amounts(fixture),
        expectedTop8Count: resolveExpectedTop8Amounts(fixture).length,
        hasTop8AmountsFixture: Boolean(fixture.top8Amounts?.length),
        actualTop8: OPERATING_EXPENSE_SLOT_IDS.map((id) => Math.round(values[id] ?? 0)).filter(
          (a) => a >= 100,
        ),
        slots,
        multiset: {
          ok: multiset.ok,
          n: multiset.n,
          pct: multiset.pct,
          misses: multiset.misses,
          unmatchedExpected: multiset.unmatchedExpected,
          surplusActual: multiset.surplusActual,
          slotRows: multiset.slotRows,
        },
        other_operating_expenses: values.other_operating_expenses ?? null,
        other_opex_expected: fixture.values.other_operating_expenses ?? null,
        net_income: formulas.net_income ?? null,
        operating_profit: formulas.operating_profit ?? null,
        opexMisses: opexScore.misses,
        fieldMisses: fieldScore.misses,
      };
    }

    (out.clients as Record<string, unknown>)[client.id] = { years };
  }

  console.log(JSON.stringify(out, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(forceExit);
