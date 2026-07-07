import { readFile } from "node:fs/promises";
import { extractComparisonExpenseLines } from "../src/lib/tax-return/comparison-field-rows";
import {
  buildOperatingExpenseLedger,
  expenseCategoryKey,
  supplementOperatingExpenseLines,
  type OperatingExpenseLine,
} from "../src/lib/tax/operating-expenses";

const values = {
  sales: 1_670_033,
  officer_compensation: 60_374,
  salaries_wages: 80_363,
  rent: 18_000,
  taxes_licenses: 23_803,
  cash: 80_777,
  inventory: 163_463,
};

function diagnoseFilter(line: OperatingExpenseLine): string {
  const amount = Math.round(line.amount);
  if (amount < 100) return "min";
  const off = values.officer_compensation;
  const sal = values.salaries_wages;
  const sum = off + sal;
  if (Math.abs(amount - sum) <= Math.max(500, sum * 0.01)) return "payroll-sum";
  if (amount > values.sales * 0.4) return "sales-cap";
  const authoritative = /form 1120|comparison|parser field/i.test(line.source ?? "");
  if (!authoritative) {
    for (const [id, v] of Object.entries(values)) {
      if (["sales", "cogs", "gross_fixed_assets", "inventory", "cash"].includes(id)) {
        if (Math.abs(v - amount) <= Math.max(500, Math.abs(v) * 0.01)) return `collide-${id}`;
      }
    }
  }
  const t = line.label.replace(/\s+/g, " ").trim();
  if (t.length < 3 || t.length > 80) return "label-len";
  if (!/[a-z]/i.test(t)) return "label-no-alpha";
  if (
    /\b(total assets|gross profit|total deductions|ordinary business income|taxable income|taxable business income|gross taxable|distributions?|tax year|business activity code|enter amount from line|did the corporation|attach form|credit for federal|biofuel producer|portion of dividends|compensation of officers see instructions|net rental real estate|ordinary income|page line|prone no|credited to estimated|salaries and wages less employment|enterprise zone|electronically filed|fein number|payment type|omb no|indiana corporate|state form|check the box for the tax return)\b/i.test(
      t,
    )
  ) {
    return "label-boilerplate";
  }
  if (
    !/\b(fee|fees|rent|util|insur|suppl|office|bank|credit|merchant|profession|legal|account|advert|tax|license|payroll|repair|maint|travel|telephone|dues|charit|misc|other deduct|salaries?|wages?|officer|compensation)\b/i.test(
      t,
    )
  ) {
    return "label-no-keyword";
  }
  return "ok";
}

async function main() {
  const ocr = await readFile("scripts/ocr-cache/carithers-2025-balanced.txt", "utf8");
  const comp = extractComparisonExpenseLines(ocr, 2025);
  console.log("comparison lines:", comp);

  const parser = supplementOperatingExpenseLines([], values, {});
  console.log("parser lines:", parser.map((l) => `${l.amount} ${l.label} (${l.source})`));

  for (const line of [...comp, ...parser]) {
    console.log(
      "filter",
      line.amount,
      diagnoseFilter(line),
      line.label,
      line.source,
    );
  }

  const led = buildOperatingExpenseLedger(
    { year: 2025, values, fieldSources: {}, operatingExpenseLines: comp },
    undefined,
  );
  console.log(
    "ledger:",
    led.map((l) => `${l.amount} [${expenseCategoryKey(l.label)}] ${l.label}`),
  );
}

main();
