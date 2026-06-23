/**
 * Verify user-correction pipeline without browser (unit-style).
 */
import { applyUserFieldCorrection } from "../src/lib/tax/apply-user-correction";
import { loadTaxCorrections, saveTaxCorrections } from "../src/lib/tax/correction-storage";
import type { TaxYearValues } from "../src/lib/tax-workbook";

if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k) => store.get(k) ?? null,
    key: (i) => [...store.keys()][i] ?? null,
    removeItem: (k) => store.delete(k),
    setItem: (k, v) => store.set(k, v),
  };
}

const baseCol: TaxYearValues = {
  year: 2025,
  values: { other_operating_expenses: 8818, sales: 1_000_000 },
  parserBaseline: { other_operating_expenses: 8818, sales: 1_000_000 },
  fieldSources: { other_operating_expenses: "Statement 2 (summed detail lines)" },
  fieldCandidateOptions: {
    other_operating_expenses: [
      { value: 9118, source: "Fixture alternate", kind: "alternate" },
      { value: 8818, source: "Statement 2 (summed detail lines)", kind: "opex" },
    ],
  },
  clientKey: "test-client",
  source: "test",
};

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function main() {
  saveTaxCorrections([]);
  const before = loadTaxCorrections().length;

  const updated = applyUserFieldCorrection(baseCol, "other_operating_expenses", 9118, "User selected: Fixture alternate");

  assert(updated.values.other_operating_expenses === 9118, "value not updated");
  assert(updated.parserBaseline?.other_operating_expenses === 8818, "parserBaseline overwritten");
  assert(updated.userEditedFields?.other_operating_expenses === true, "userEditedFields missing");
  assert(updated.fieldTrustTier?.other_operating_expenses === "user-confirmed", "trust tier not user-confirmed");
  assert(updated.fieldSources?.other_operating_expenses?.includes("User selected"), "source not stamped");

  const after = loadTaxCorrections();
  assert(after.length === before + 1, "correction not saved");
  assert(after[after.length - 1]!.correctedValue === 9118, "wrong corrected value in storage");
  assert(after[after.length - 1]!.parserValue === 8818, "wrong parser value in storage");
  assert((after[after.length - 1]!.rejectedOptions?.length ?? 0) > 0, "rejected options missing");

  console.log("OK user-correction pipeline");
}

main();
