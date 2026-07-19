/**
 * Tax year reconciliation + verification tests.
 * Run: npx tsx scripts/test-reconcile-tax-year.ts
 */
import { buildPasteTsv } from "../src/lib/tax-workbook";
import { applyCrossYearFlags } from "../src/lib/tax/cross-year-reconcile";
import {
  applyTaxYearVerification,
  buildVerificationSnapshots,
  reconcileTaxYear,
} from "../src/lib/tax/reconcile-tax-year";
import {
  countAgreeingFamilies,
  hasSourceDisagreement,
  pickBestSnapshot,
  valuesExactlyEqual,
} from "../src/lib/tax/source-agreement";
import { resolveFieldTrustTier } from "../src/lib/tax/field-trust-tier";

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    console.log(`  ok: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

console.log("=== reconcile tax year ===");

assert(valuesExactlyEqual(183_331, 183_331), "exact match");
assert(!valuesExactlyEqual(1_000_000, 1_005_000), "relative closeness is not exact agreement");
assert(!valuesExactlyEqual(183_331, 183_431), "one-digit mismatch is not equal");

const cogsExceeds = reconcileTaxYear({
  values: { sales: 100_000, cogs: 150_000 },
  confidence: { sales: 99, cogs: 99 },
  fieldSources: { sales: "Form 1120-S line 1", cogs: "Form 1120-S line 2" },
});
assert((cogsExceeds.fieldFlags.cogs?.length ?? 0) > 0, "flags COGS > sales");
assert(cogsExceeds.fieldStatus.cogs === "review", "COGS review when math fails");

const singleSource = reconcileTaxYear({
  values: { rent: 48_000 },
  confidence: { rent: 99 },
  fieldSources: { rent: "Form 1120-S line 11 (page 1 block)" },
});
assert((singleSource.displayConfidence.rent ?? 0) <= 95, "caps display confidence for single authoritative source");
assert(
  singleSource.fieldTrustTier?.rent === "authoritative" || singleSource.fieldTrustTier?.rent === "single-good",
  "form line tier",
);

const junkAmort = reconcileTaxYear({
  values: { amortization: 12 },
  confidence: { amortization: 99 },
  fieldSources: { amortization: "Form 1120-S line 14 (page 1 block)" },
});
assert(
  junkAmort.fieldTrustTier?.amortization === "authoritative",
  "small authoritative amortization is not rejected by a dollar floor",
);

const equitySnaps = [
  { family: "schedule-l" as const, value: 183_331, confidence: 92 },
  { family: "comparison" as const, value: 183_431, confidence: 88 },
];
assert(hasSourceDisagreement(equitySnaps), "183331 vs 183431 is source disagreement");
assert(pickBestSnapshot(equitySnaps).value === 183_331, "picks higher-confidence read");

const equityDisagree = reconcileTaxYear({
  values: { unclassified_equity: 183_331 },
  confidence: { unclassified_equity: 99 },
  fieldSources: { unclassified_equity: "Schedule L line 24" },
  sourceSnapshots: { unclassified_equity: equitySnaps },
});
assert(equityDisagree.fieldStatus.unclassified_equity === "review", "equity digit mismatch → review");

const rentVerified = applyTaxYearVerification(
  {
    year: 2024,
    values: { rent: 48_000 },
    confidence: { rent: 99 },
    fieldSources: { rent: "Form 1120-S line 11" },
    source: "test",
  },
  buildVerificationSnapshots({
    formAnchors: { values: { rent: 48_000 }, confidence: { rent: 99 }, sources: {} },
    comparison: { values: { rent: 48_100 }, confidence: { rent: 88 }, sources: {} },
    statements: { values: {}, confidence: {}, sources: {} },
    fuzzy: { values: {}, confidence: {}, sources: {} },
    embeddedScheduleL: { values: {}, confidence: {}, sources: {} },
  }),
);
assert(rentVerified.values.rent === 48_000, "picks highest-confidence rent");
assert((rentVerified.sourceAgreement?.rent ?? 0) === 1, "only one family matches exactly");
assert(rentVerified.fieldStatus?.rent === "review", "rent mismatch → review");
assert((rentVerified.fieldAlternates?.rent?.length ?? 0) === 1, "stores alternate rent read");

const rentAgreed = applyTaxYearVerification(
  {
    year: 2024,
    values: { rent: 48_000 },
    confidence: { rent: 99 },
    fieldSources: { rent: "Form 1120-S line 11" },
    source: "test",
  },
  buildVerificationSnapshots({
    formAnchors: { values: { rent: 48_000 }, confidence: { rent: 99 }, sources: {} },
    comparison: { values: { rent: 48_000 }, confidence: { rent: 88 }, sources: {} },
    statements: { values: {}, confidence: {}, sources: {} },
    fuzzy: { values: {}, confidence: {}, sources: {} },
    embeddedScheduleL: { values: {}, confidence: {}, sources: {} },
  }),
);
assert((rentAgreed.sourceAgreement?.rent ?? 0) >= 2, "two families agree exactly on rent");
assert(rentAgreed.fieldTrustTier?.rent === "multi-source", "multi-source tier when agreed");
assert((rentAgreed.displayConfidence?.rent ?? 0) <= 99, "agreed trust capped at 99");

const ocrOnly = reconcileTaxYear({
  values: { rent: 48_000 },
  confidence: { rent: 72 },
  fieldSources: { rent: "OCR label match" },
});
assert(ocrOnly.fieldTrustTier?.rent === "ocr-only", "OCR-only tier");

const confirmedTsv = buildPasteTsv(
  [
    {
      year: 2024,
      values: { sales: 1_000_000, rent: 50_000 },
      fieldTrustTier: { sales: "multi-source", rent: "ocr-only" },
      userVerifiedFields: { sales: true },
      source: "test",
    },
  ],
  { confirmedOnly: true, includeLabels: true },
);
assert(confirmedTsv.includes("1000000.00"), "confirmed TSV includes verified sales with cents");
assert(
  confirmedTsv.split("\n").some((line) => line.startsWith("Rent\t") && line === "Rent\t"),
  "confirmed TSV skips unverified rent input",
);

const yoy = applyCrossYearFlags([
  { year: 2024, values: { sales: 1_000_000 }, source: "a" },
  { year: 2023, values: { sales: 1_000 }, source: "b" },
]);
assert(
  (yoy.find((c) => c.year === 2024)?.fieldFlags?.sales?.length ?? 0) > 0,
  "flags extreme YoY sales jump",
);
assert(yoy.find((c) => c.year === 2024)?.fieldStatus?.sales === "review", "YoY flag forces review");

assert(
  resolveFieldTrustTier({
    value: 48_000,
    source: "Form 1120-S line 11",
    parserConfidence: 99,
    displayConfidence: 95,
    agreement: 2,
  }) === "multi-source",
  "resolveFieldTrustTier multi-source",
);

console.log(`\n=== reconcile tax year: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
