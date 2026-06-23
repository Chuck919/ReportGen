import { parseFinancialTablesFromText, type YearSeries } from "@/lib/financial-text-parser";
import { parseTwoYearComparisonBlock } from "@/lib/two-year-comparison-parser";
import { TAX_WORKBOOK_ROWS, type TaxYearValues } from "@/lib/tax-workbook";
import { TAX_ATTACHMENT_FIELD_IDS } from "@/lib/workbook-comparison-fixtures";
import { extractFormAnchors, extractFormPage1Block, formAnchorSourceText, type FieldExtraction } from "./form-anchors";
import { detectTaxForm } from "./detect-tax-form";
import { lineMoneyTokens, lineTailAmount, scheduleLineAmount, substantialMoneyTokens, isForm1120Line, isFormReferenceNumber, derailOcrLeadingOne, formLineAmount } from "./money";
import { clientIdentityFromText } from "./extract-business-name";
import { inferTaxYear } from "./infer-year";
import { findHitsLineScoped, resolveHits } from "./line-hits";
import {
  applyConfidenceGates,
  refillFromComparison,
  type ConfidenceGateOptions,
} from "./confidence-gates";
import type { OcrMode } from "./local-ocr";
import { pruneNoMatchWarnings, type ResolvedFields } from "./merge";
import { assembleExtractions } from "./parse-pipeline";
import { extractEmbeddedScheduleL } from "./embedded-schedule-l";
import { extractScheduleLFields, scanStatementLine18Total } from "./schedule-l";
import {
  applyTaxYearVerification,
  applyThoroughScheduleLAgreement,
  buildVerificationSnapshots,
  reconcileTaxYear,
} from "@/lib/tax/reconcile-tax-year";
import type { SourceSnapshot } from "@/lib/tax/source-agreement";
import {
  countStatement1DetailLines,
  extractStatementDeductions,
  extractStatementOtherIncome,
  extractStatementTaxesSplit,
  extractStatement3OtherOperatingExpenses,
  scanBooksOtherIncomeForYear,
  statement1HasOtherIncomeDetailLine,
  statement1ReportsToWorkbookOtherIncome,
  statement1TotalIsTaxRefund,
} from "./statement-extractors";
import { applyCoherenceGates } from "./coherence-gates";
import { reconcileOtherOperatingExpenses, applyLargeCorpBlockOpexOverride, emitOpexReconcileDebug, type OpexReconcileDebug } from "./other-operating-expenses";
import { refillFromComparisonLabeledRows } from "./comparison-field-rows";
import { normalizeEquityBuckets } from "./equity-buckets";
import { reconcileDepreciationAmortization } from "./income-depreciation-amort";
import { buildOcrCoverageDiagnostics, type OcrCoverageDiagnostics } from "./ocr-coverage-diagnostics";
import { generateOpexCandidates } from "./opex-candidate-ranking";
import { applyWorkbookConfidenceLayer } from "@/lib/tax-confidence/field-confidence";
import { capConfidenceForFlags, mergeConfidenceFlags } from "@/lib/tax-confidence/confidence-flags";
import { STMT_ATTACHMENT_FIELD_IDS } from "./ocr-coverage-rescan";
import { reconcileCogsFromSources } from "./cogs-reconcile";

/** P&L lines that should surface OCR-gap warnings when still missing after parse. */
const MISSING_MATERIAL_FIELD_IDS = new Set([
  "sales",
  "cogs",
  "advertising",
  "taxes_licenses",
  "rent",
  "officer_compensation",
  "salaries_wages",
  ...STMT_ATTACHMENT_FIELD_IDS,
]);

const INPUT_ROW_IDS = new Set(
  TAX_WORKBOOK_ROWS.filter((row) => row.excelBehavior === "input").map((row) => row.id),
);

const FACT_TO_TAX_ID: Record<string, string> = {
  sales: "sales",
  cogs: "cogs",
  depreciation_is: "depreciation",
  amortization_is: "amortization",
  officer_comp: "officer_compensation",
  ga_payroll: "salaries_wages",
  rent: "rent",
  advertising: "advertising",
  taxes_licenses: "taxes_licenses",
  bank_cc_fees: "bank_credit_card",
  professional_fees: "professional_fees",
  utilities: "utilities",
  other_operating_expenses: "other_operating_expenses",
  interest_expense: "interest_expense",
  other_income: "other_income",
  cash: "cash",
  ar: "accounts_receivable",
  inventory: "inventory",
  other_ca: "other_current_assets",
  gross_fixed: "gross_fixed_assets",
  acc_dep: "accumulated_depreciation",
  gross_intangible: "gross_intangible_assets",
  acc_amortization: "accumulated_amortization",
  other_assets: "other_assets",
  ap: "accounts_payable",
  other_cl: "other_current_liabilities",
  senior_debt: "notes_minus_short_term",
  unclassified_equity: "unclassified_equity",
};

function mapFinancialFacts(facts: Record<string, YearSeries>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [factKey, taxId] of Object.entries(FACT_TO_TAX_ID)) {
    if (!INPUT_ROW_IDS.has(taxId)) continue;
    const series = facts[factKey];
    if (!series || typeof series[2] !== "number") continue;
    out[taxId] = Math.round(series[2]);
  }
  return out;
}

function tryStructuredTable(text: string) {
  if (text.length < 80) return null;
  const parsed = parseFinancialTablesFromText(text);
  if (Object.keys(parsed.facts).length < 5) return null;
  const values = mapFinancialFacts(parsed.facts);
  if (Object.keys(values).length < 5) return null;
  const confidence: Record<string, number> = {};
  const sources: Record<string, string> = {};
  for (const id of Object.keys(values)) {
    confidence[id] = 99;
    sources[id] = "Structured financial table";
  }
  return { values, confidence, sources };
}

function pickComparisonRowColumn(line: string, nums: number[]): number | undefined {
  if (!nums.length) return undefined;
  if (nums.length >= 3) return nums[nums.length - 2]!;
  if (nums.length === 1) return nums[0]!;
  const a = Math.abs(nums[0]!);
  const b = Math.abs(nums[1]!);
  if (/\|\s*[-–—]/.test(line) || /[-–—]\s*\d[\d,]*(?:\.\d+)?\s*$/.test(line)) {
    return Math.max(a, b);
  }
  if (Math.abs(a - b) / Math.max(a, 1) < 0.2) return nums[1]!;
  return Math.max(a, b);
}

function formLine5AttachmentAmount(formPage1: string): number | undefined {
  for (const rawLine of formPage1.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!/other\s+income/i.test(line)) continue;
    if (!isForm1120Line(line, 5) && !/\b5\b.*attach|\[5\]/i.test(line)) continue;
    if (!/stmt|statement|attach/i.test(line)) continue;
    const amt = formLineAmount(line, "5") ?? scheduleLineAmount(line);
    if (amt !== undefined && amt > 0 && amt < 1_000_000 && Math.abs(amt) !== 5) return amt;
  }
  return undefined;
}

/** Parser-only path (no OCR) — used for fast regression with cached OCR text. */
export function parseTaxReturnFromText(
  filename: string,
  embeddedText: string,
  ocrText: string,
  yearOverride?: number,
  options?: ConfidenceGateOptions & {
    ocrMode?: OcrMode;
    parseDebug?: {
      onOpexReconcile?: (debug: OpexReconcileDebug) => void;
      priorYearValues?: Record<number, Record<string, number>>;
    };
  },
): TaxYearValues & { fieldSources?: Record<string, string>; ocrCoverage?: OcrCoverageDiagnostics } {
  const allText = `${embeddedText}\n${ocrText}`;
  const year =
    yearOverride && yearOverride >= 2000 && yearOverride <= 2100
      ? yearOverride
      : inferTaxYear(filename, allText);
  if (!year) throw new Error("Could not determine tax year from document text.");

  const structured = tryStructuredTable(allText);
  if (structured && Object.keys(structured.values).length >= 12) {
    return applyTaxYearVerification(
      {
        year,
        values: structured.values,
        confidence: structured.confidence,
        fieldSources: structured.sources,
        warnings: [],
        source: "embedded-financial-table",
      },
      buildVerificationSnapshots({
        formAnchors: { values: {}, confidence: {}, sources: {} },
        statements: { values: {}, confidence: {}, sources: {} },
        fuzzy: { values: {}, confidence: {}, sources: {} },
        embeddedScheduleL: { values: {}, confidence: {}, sources: {} },
        structured,
      }),
    );
  }

  const embeddedScheduleL = extractEmbeddedScheduleL(embeddedText);
  const formAnalysis = detectTaxForm(allText);
  const comparisonCandidates = [
    parseTwoYearComparisonBlock(ocrText, year),
    parseTwoYearComparisonBlock(embeddedText, year),
    parseTwoYearComparisonBlock(allText, year),
  ].filter((c): c is NonNullable<typeof c> => c !== null);
  const comparison =
    comparisonCandidates.sort(
      (a, b) =>
        b.linesMatched - a.linesMatched ||
        (b.values.other_operating_expenses !== undefined ? 1 : 0) -
          (a.values.other_operating_expenses !== undefined ? 1 : 0),
    )[0] ?? null;
  const anchorText = formAnchorSourceText(embeddedText, ocrText, formAnalysis.kind);
  const formAnchors = extractFormAnchors(anchorText, formAnalysis.kind);
  const stmtDeductions = extractStatementDeductions(allText);
  const stmtTaxes = extractStatementTaxesSplit(allText);
  for (const [id, value] of Object.entries(stmtTaxes.values)) {
    const conf = stmtTaxes.confidence[id] ?? 0;
    if (conf >= (stmtDeductions.confidence[id] ?? 0)) {
      stmtDeductions.values[id] = value;
      stmtDeductions.confidence[id] = conf;
      if (stmtTaxes.sources[id]) stmtDeductions.sources[id] = stmtTaxes.sources[id];
    }
  }
  const structuredOcr = tryStructuredTable(allText);
  const combinedHits = [
    ...findHitsLineScoped(embeddedText, 78, year),
    ...findHitsLineScoped(allText, 65, year),
  ];

  let fuzzy = resolveHits(combinedHits, 60);
  if (!Object.keys(fuzzy.values).length && combinedHits.length >= 12) {
    fuzzy = resolveHits(combinedHits, 60, true);
  }

  const attachmentIds = new Set(TAX_ATTACHMENT_FIELD_IDS);
  const compSources: Record<string, string> = {};
  if (comparison) for (const id of Object.keys(comparison.values)) compSources[id] = "Two-year comparison";

  const tiers: Array<{
    name: string;
    extraction: { values: Record<string, number>; confidence: Record<string, number>; sources?: Record<string, string> };
    minConfidence?: number;
    onlyIds?: Set<string>;
  }> = [{ name: "fuzzy-ocr", extraction: fuzzy, minConfidence: 50 }];

  if (structuredOcr) tiers.push({ name: "structured-table", extraction: structuredOcr, minConfidence: 95 });
  if (comparison && comparison.linesMatched >= 4) {
    tiers.push({
      name: "comparison",
      extraction: { values: comparison.values, confidence: comparison.confidence, sources: compSources },
      minConfidence: 84,
    });
  }
  tiers.push({ name: "statements", extraction: stmtDeductions, minConfidence: 88, onlyIds: attachmentIds });
  tiers.push({ name: "form-anchors", extraction: formAnchors, minConfidence: 0 });
  if (Object.keys(embeddedScheduleL.values).length >= 4) {
    tiers.push({ name: "embedded-schedule-l", extraction: embeddedScheduleL, minConfidence: 95 });
  }

  const resolved: ResolvedFields = assembleExtractions(tiers);
  pruneNoMatchWarnings(resolved, new Set(Object.keys(resolved.values)));

  for (const [id, value] of Object.entries(stmtTaxes.values)) {
    if (value === undefined) continue;
    resolved.values[id] = value;
    resolved.confidence[id] = stmtTaxes.confidence[id] ?? 96;
    resolved.sources[id] = stmtTaxes.sources[id] ?? "Statement 2 taxes split";
  }

  const stmtIncome = extractStatementOtherIncome(allText);
  const formOi = formAnchors.values.other_income;
  const formPage1 = extractFormPage1Block(anchorText, formAnalysis.kind);
  const line5UsesStmt = formPage1.split(/\n/).some((row) => {
    const line = row.replace(/\s+/g, " ").trim();
    return (
      isForm1120Line(line, 5) &&
      /other\s+income/i.test(line) &&
      /attach|see\s+stmt|federal\s+statem/i.test(line)
    );
  });
  const stmt1Lines = countStatement1DetailLines(allText);
  const compOi = comparison?.values.other_income;
  const stmtTotal = stmtIncome.value;
  const stmtMatchesForm =
    stmtTotal !== undefined &&
    formOi !== undefined &&
    Math.abs(stmtTotal - formOi) <= Math.max(2, Math.abs(formOi) * 0.02);

  const stmtOiDetail = statement1HasOtherIncomeDetailLine(allText);
  let otherIncomeResolved = false;
  if (line5UsesStmt) {
    if (
      !stmtOiDetail &&
      stmtMatchesForm &&
      stmtTotal !== undefined &&
      stmt1Lines >= 2 &&
      statement1ReportsToWorkbookOtherIncome(allText) &&
      !statement1TotalIsTaxRefund(allText, stmtTotal)
    ) {
      resolved.values.other_income = Math.round(stmtTotal);
      resolved.confidence.other_income = 94;
      resolved.sources.other_income = "Statement 1 total (matches Form line 5)";
    } else {
      const attachmentOi = formLine5AttachmentAmount(formPage1);
      if (
        attachmentOi !== undefined &&
        statement1ReportsToWorkbookOtherIncome(allText)
      ) {
        resolved.values.other_income = Math.round(attachmentOi);
        resolved.confidence.other_income = 92;
        resolved.sources.other_income = "Form line 5 statement attachment";
      } else if (
        compOi !== undefined &&
        Math.abs(compOi) > 0 &&
        Math.abs(compOi) < 2_000
      ) {
        resolved.values.other_income = Math.round(compOi);
        resolved.confidence.other_income = comparison?.confidence.other_income ?? 88;
        resolved.sources.other_income = "Two-year comparison (overrides Stmt 1 zero summary)";
      } else if (
        stmtTotal !== undefined &&
        stmtTotal > 0 &&
        statement1ReportsToWorkbookOtherIncome(allText)
      ) {
        resolved.values.other_income = Math.round(stmtTotal);
        resolved.confidence.other_income = 94;
        resolved.sources.other_income = stmtIncome.source ?? "Statement 1";
      } else {
        resolved.values.other_income = 0;
        resolved.confidence.other_income = 68;
        resolved.sources.other_income = "Form 1120-S line 5 (Stmt 1 multi-line; summary zero)";
      }
      if (
        !statement1ReportsToWorkbookOtherIncome(allText) &&
        compOi !== undefined &&
        compOi > 0 &&
        formOi !== undefined &&
        formOi > 0 &&
        Math.abs(compOi - formOi) <= Math.max(2, Math.abs(formOi) * 0.02)
      ) {
        const booksOi = scanBooksOtherIncomeForYear(allText, year);
        if (booksOi === undefined || booksOi > 0) {
          resolved.values.other_operating_income = Math.round(booksOi ?? compOi);
          resolved.confidence.other_operating_income = 93;
          resolved.sources.other_operating_income =
            "Two-year comparison OTHER INCOME (Stmt 1 → other operating income)";
        }
      }
    }
    otherIncomeResolved = true;
  }
  if (!otherIncomeResolved && formAnalysis.kind === "1120" && formOi !== undefined && formOi < 10_000) {
    if (statement1ReportsToWorkbookOtherIncome(allText)) {
      resolved.values.other_income = formOi;
      resolved.confidence.other_income = formAnchors.confidence.other_income ?? 97;
      resolved.sources.other_income = formAnchors.sources.other_income ?? "Form 1120 line 5";
      otherIncomeResolved = true;
    }
  }
  if (!otherIncomeResolved && compOi !== undefined && comparison && comparison.linesMatched >= 5) {
    if (
      line5UsesStmt &&
      stmtMatchesForm &&
      Math.abs(compOi - stmtTotal!) > Math.max(2, Math.abs(stmtTotal!) * 0.02)
    ) {
      resolved.values.other_income = 0;
      resolved.confidence.other_income = 92;
      resolved.sources.other_income = "Form 1120-S line 5 (comparison disagrees with Stmt 1)";
    } else {
      resolved.values.other_income = compOi;
      resolved.confidence.other_income = comparison.confidence.other_income ?? 88;
      resolved.sources.other_income = "Two-year comparison";
    }
    otherIncomeResolved = true;
  }
  if (!otherIncomeResolved && formOi !== undefined) {
    const formKind = formAnalysis.kind;
    const compOiLater = comparison?.values.other_income;
    const preferForm =
      formKind === "1120" &&
      formOi < 10_000 &&
      statement1ReportsToWorkbookOtherIncome(allText) &&
      (compOiLater === undefined || Math.abs(formOi - compOiLater) > 5);
    if (preferForm || (compOiLater === undefined && statement1ReportsToWorkbookOtherIncome(allText))) {
      resolved.values.other_income = formOi;
      resolved.confidence.other_income = formAnchors.confidence.other_income ?? 97;
      resolved.sources.other_income = formAnchors.sources.other_income ?? "Form 1120 line 5";
      otherIncomeResolved = true;
    }
  }
  if (
    !otherIncomeResolved &&
    stmtTotal !== undefined &&
    statement1ReportsToWorkbookOtherIncome(allText) &&
    !statement1TotalIsTaxRefund(allText, stmtTotal)
  ) {
    resolved.values.other_income = Math.round(stmtTotal);
    resolved.confidence.other_income = 94;
    resolved.sources.other_income = stmtIncome.source ?? "Statement 1";
  }

  if (!resolved.values.sales && comparison?.values.sales) {
    resolved.values.sales = comparison.values.sales;
    resolved.confidence.sales = comparison.confidence.sales ?? 86;
    resolved.sources.sales = "Two-year comparison";
  }
  if (!resolved.values.cogs && comparison?.values.cogs) {
    const compCogs = comparison.values.cogs;
    if (Math.abs(compCogs) > 99) {
      resolved.values.cogs = compCogs;
      resolved.confidence.cogs = comparison.confidence.cogs ?? 86;
      resolved.sources.cogs = "Two-year comparison";
    }
  }

  const stmt4Oca = allText.match(
    /(?:statement|stmt|tatement)\s*4\b[\s\S]{0,900}?line\s*6[\s\S]{0,500}?^total\b[^\n]*/im,
  )?.[0];
  if (stmt4Oca && resolved.values.other_current_assets === undefined) {
    const totalLine = stmt4Oca.split(/\n/).find((row) => /^total\b/i.test(row.replace(/\s+/g, " ").trim()));
    const endTotal = totalLine ? scheduleLineAmount(totalLine) : undefined;
    if (endTotal !== undefined) {
      resolved.values.other_current_assets = Math.round(endTotal);
      resolved.confidence.other_current_assets = 99;
      resolved.sources.other_current_assets = "Statement 4 total (Line 6)";
    }
  }

  if (resolved.values.other_assets !== undefined) {
    const oa = resolved.values.other_assets;
    const looksLikeTotalAssets = allText.split(/\n/).some((row) => {
      if (!/\b1[57]\b/i.test(row) || !/total\s+ass|totlassets|towlasses|liabilit.*equit/i.test(row)) return false;
      return lineMoneyTokens(row).some((n) => Math.abs(n - oa) <= 2);
    });
    if (looksLikeTotalAssets && !/\b14\b[^\n]{0,50}other\s+ass/i.test(allText)) {
      delete resolved.values.other_assets;
      delete resolved.confidence.other_assets;
      delete resolved.sources.other_assets;
    } else if (oa >= 50000 && resolved.sources.other_assets === "OCR label match") {
      delete resolved.values.other_assets;
      delete resolved.confidence.other_assets;
      delete resolved.sources.other_assets;
    } else if (
      oa > 0 &&
      oa < 10000 &&
      resolved.sources.other_assets === "OCR label match" &&
      !allText.split(/\n/).some((row) => /\b14\b/i.test(row) && /other\s+ass/i.test(row) && (scheduleLineAmount(row) ?? 0) >= oa * 0.9)
    ) {
      delete resolved.values.other_assets;
      delete resolved.confidence.other_assets;
      delete resolved.sources.other_assets;
    }
  }

  if (
    resolved.values.other_current_assets !== undefined &&
    Math.abs(resolved.values.other_current_assets) < 1000 &&
    resolved.sources.other_current_assets === "OCR label match"
  ) {
    delete resolved.values.other_current_assets;
    delete resolved.confidence.other_current_assets;
    delete resolved.sources.other_current_assets;
  }

  if (
    resolved.values.other_income !== undefined &&
    isFormReferenceNumber(Math.abs(resolved.values.other_income))
  ) {
    delete resolved.values.other_income;
    delete resolved.confidence.other_income;
    delete resolved.sources.other_income;
  }

  if (
    resolved.values.other_current_liabilities !== undefined &&
    resolved.values.short_term_debt !== undefined &&
    resolved.values.other_current_liabilities === resolved.values.short_term_debt
  ) {
    delete resolved.values.other_current_liabilities;
    delete resolved.confidence.other_current_liabilities;
    delete resolved.sources.other_current_liabilities;
  }

  if (
    resolved.values.unclassified_equity !== undefined &&
    resolved.values.other_stock_equity !== undefined &&
    /schedule\s+l/i.test(resolved.sources.unclassified_equity ?? "") &&
    /line\s*24|23\+25|retained|unappropriated|apic \+ retained/i.test(
      resolved.sources.unclassified_equity ?? "",
    ) &&
    Math.abs(resolved.values.other_stock_equity - resolved.values.unclassified_equity) <=
      Math.max(500, resolved.values.unclassified_equity * 0.02)
  ) {
    delete resolved.values.other_stock_equity;
    delete resolved.confidence.other_stock_equity;
    delete resolved.sources.other_stock_equity;
  } else if (
    resolved.values.unclassified_equity !== undefined &&
    resolved.values.other_stock_equity !== undefined &&
    resolved.values.other_stock_equity > 100_000 &&
    !/schedule\s+l/i.test(resolved.sources.unclassified_equity ?? "")
  ) {
    delete resolved.values.unclassified_equity;
    delete resolved.confidence.unclassified_equity;
    delete resolved.sources.unclassified_equity;
  }

  if (
    resolved.values.gross_intangible_assets !== undefined &&
    resolved.values.gross_intangible_assets < 20_000
  ) {
    delete resolved.values.gross_intangible_assets;
    delete resolved.confidence.gross_intangible_assets;
    delete resolved.sources.gross_intangible_assets;
  }

  if (
    resolved.values.unclassified_equity !== undefined &&
    (resolved.values.unclassified_equity < 0 ||
      (Math.abs(resolved.values.unclassified_equity) < 1000 &&
        resolved.sources.unclassified_equity === "OCR label match"))
  ) {
    delete resolved.values.unclassified_equity;
    delete resolved.confidence.unclassified_equity;
    delete resolved.sources.unclassified_equity;
  }

  if (comparison && comparison.linesMatched >= 5) {
    const weakSource = (src?: string) =>
      !src || /tail scan|OCR label match|fuzzy|page 1 block/i.test(src);
    for (const id of [
      "rent",
      "officer_compensation",
      "salaries_wages",
      "advertising",
      "taxes_licenses",
      "interest_expense",
      "depreciation",
      "amortization",
      "gross_intangible_assets",
      "accumulated_amortization",
      "gross_fixed_assets",
      "accumulated_depreciation",
      "cash",
      "inventory",
      "other_current_liabilities",
      "notes_minus_short_term",
      "unclassified_equity",
      "other_assets",
      "cogs",
      "other_operating_expenses",
      "bank_credit_card",
      "professional_fees",
      "utilities",
    ] as const) {
      const comp = comparison.values[id];
      if (comp === undefined) continue;
      if (
        id === "other_current_liabilities" &&
        comp < 40_000 &&
        /schedule\s+l|statement/i.test(allText)
      ) {
        continue;
      }
      if (
        id === "other_current_liabilities" &&
        /schedule\s+l|statement.*line\s*18|statement\s*5/i.test(resolved.sources[id] ?? "") &&
        (resolved.confidence[id] ?? 0) >= 97
      ) {
        continue;
      }
      const got = resolved.values[id];
      if (got === undefined) {
        resolved.values[id] = comp;
        resolved.confidence[id] = comparison.confidence[id] ?? 86;
        resolved.sources[id] = "Two-year comparison";
        continue;
      }
      if (
        weakSource(resolved.sources[id]) &&
        Math.abs(comp) >= 1000 &&
        Math.abs(got - comp) / Math.max(Math.abs(comp), 1) > 0.25
      ) {
        resolved.values[id] = comp;
        resolved.confidence[id] = comparison.confidence[id] ?? 88;
        resolved.sources[id] = "Two-year comparison (override)";
        continue;
      }
      if (
        (id === "depreciation" || id === "amortization") &&
        comp === 0 &&
        got !== undefined &&
        Math.abs(got) >= 500 &&
        weakSource(resolved.sources[id])
      ) {
        resolved.values[id] = 0;
        resolved.confidence[id] = comparison.confidence[id] ?? 88;
        resolved.sources[id] = "Two-year comparison (zero override)";
        continue;
      }
      if (
        (id === "cogs" || id === "sales") &&
        !/comparison/i.test(resolved.sources[id] ?? "") &&
        Math.abs(comp) >= 50_000 &&
        Math.abs(got - comp) > 1000
      ) {
        const formVal = formAnchors.values[id];
        const formConf = formAnchors.confidence[id] ?? 0;
        if (
          formVal !== undefined &&
          formConf >= 96 &&
          Math.abs(got - formVal) <= Math.max(2, Math.abs(formVal) * 0.02)
        ) {
          continue;
        }
        resolved.values[id] = comp;
        resolved.confidence[id] = comparison.confidence[id] ?? 90;
        resolved.sources[id] = "Two-year comparison (override)";
      }
    }
  }

  for (const id of ["rent", "taxes_licenses", "officer_compensation"] as const) {
    const formVal = formAnchors.values[id];
    const got = resolved.values[id];
    if (formVal === undefined || got === undefined) continue;
    if (
      /comparison/i.test(resolved.sources[id] ?? "") &&
      (got < 0 ||
        Math.abs(got - formVal) / Math.max(Math.abs(formVal), 1) > 0.35) &&
      Math.abs(formVal) >= Math.abs(got) &&
      (formAnchors.confidence[id] ?? 0) >= 96
    ) {
      resolved.values[id] = formVal;
      resolved.confidence[id] = formAnchors.confidence[id] ?? 97;
      resolved.sources[id] = formAnchors.sources[id] ?? `Form line (${id})`;
    }
  }

  const formDep = formAnchors.values.depreciation;
  if (resolved.values.depreciation !== undefined && Math.abs(resolved.values.depreciation) <= 99) {
    const depLine = formPage1.split(/\n/).find((row) => {
      const line = row.replace(/\s+/g, " ").trim();
      return isForm1120Line(line, 14) && /depreciation/i.test(line);
    });
    if (formDep !== undefined) {
      resolved.values.depreciation = formDep;
      resolved.confidence.depreciation = formAnchors.confidence.depreciation ?? 97;
      resolved.sources.depreciation = formAnchors.sources.depreciation ?? "Form 1120-S line 14";
    } else if (depLine && !substantialMoneyTokens(depLine).length) {
      resolved.values.depreciation = 0;
      resolved.confidence.depreciation = 96;
      resolved.sources.depreciation = "Form 1120-S line 14 (blank)";
    }
  }

  const sales = resolved.values.sales;
  const cogs = resolved.values.cogs;
  if (sales && cogs && cogs > 0 && cogs < sales) {
    const gpLine = formPage1.split(/\n/).find((row) => {
      const line = row.replace(/\s+/g, " ").trim();
      return /gross profit/i.test(line) && scheduleLineAmount(line) === cogs;
    });
    if (gpLine) {
      resolved.values.cogs = sales - cogs;
      resolved.confidence.cogs = 97;
      resolved.sources.cogs = "Form 1120-S line 2 (from gross profit)";
    }
  }

  if (
    resolved.values.other_operating_income !== undefined &&
    resolved.values.other_income !== undefined &&
    resolved.values.other_operating_income === resolved.values.other_income &&
    !/other\s+operat.{0,8}inc/i.test(allText)
  ) {
    delete resolved.values.other_operating_income;
    delete resolved.confidence.other_operating_income;
    delete resolved.sources.other_operating_income;
  }

  if (
    resolved.values.unclassified_equity !== undefined &&
    resolved.values.unclassified_equity < 100_000 &&
    resolved.sources.unclassified_equity === "OCR label match"
  ) {
    delete resolved.values.unclassified_equity;
    delete resolved.confidence.unclassified_equity;
    delete resolved.sources.unclassified_equity;
  }

  if (
    resolved.values.other_income !== undefined &&
    resolved.values.other_income > 0 &&
    /subtraction|subtract|sch\.?\s*k|schedule\s*k/i.test(resolved.sources.other_income ?? "")
  ) {
    delete resolved.values.other_income;
    delete resolved.confidence.other_income;
    delete resolved.sources.other_income;
  }

  if (
    resolved.values.other_income !== undefined &&
    resolved.values.other_income < 0
  ) {
    delete resolved.values.other_income;
    delete resolved.confidence.other_income;
    delete resolved.sources.other_income;
  }

  if (
    formAnalysis.kind === "1120" &&
    resolved.values.other_income !== undefined &&
    resolved.values.other_income > 0 &&
    /line 5 interest/i.test(resolved.sources.other_income ?? "")
  ) {
    const page5Interest = formPage1.split(/\n/).some((row) => {
      const line = row.replace(/\s+/g, " ").trim();
      if (!isForm1120Line(line, 5) || !/interest/i.test(line) || /expense/i.test(line)) return false;
      const amt = scheduleLineAmount(line) ?? lineTailAmount(line);
      return amt !== undefined && Math.abs(amt - resolved.values.other_income!) <= Math.max(2, amt * 0.02);
    });
    if (!page5Interest) {
      delete resolved.values.other_income;
      delete resolved.confidence.other_income;
      delete resolved.sources.other_income;
    }
  }

  if (
    resolved.values.other_income !== undefined &&
    resolved.values.other_income > 300 &&
    /comparison/i.test(resolved.sources.other_income ?? "") &&
    /subtraction.*federal|other subtractions from federal/i.test(allText)
  ) {
    const page5Oi = formPage1.split(/\n/).some((row) => {
      const line = row.replace(/\s+/g, " ").trim();
      if (!isForm1120Line(line, 5) || !/other\s+income/i.test(line)) return false;
      const amt = scheduleLineAmount(line);
      return amt !== undefined && Math.abs(amt - resolved.values.other_income!) <= Math.max(2, amt * 0.02);
    });
    if (!page5Oi) {
      delete resolved.values.other_income;
      delete resolved.confidence.other_income;
      delete resolved.sources.other_income;
    }
  }

  if (
    resolved.values.interest_expense !== undefined &&
    resolved.values.interest_expense > 500 &&
    /comparison/i.test(resolved.sources.interest_expense ?? "") &&
    formAnchors.values.interest_expense === undefined
  ) {
    delete resolved.values.interest_expense;
    delete resolved.confidence.interest_expense;
    delete resolved.sources.interest_expense;
  }

  if (
    resolved.values.depreciation !== undefined &&
    formAnchors.values.depreciation !== undefined &&
    Math.abs(resolved.values.depreciation - formAnchors.values.depreciation) > 100 &&
    formAnchors.confidence.depreciation !== undefined &&
    (formAnchors.confidence.depreciation ?? 0) >= 96 &&
    !/comparison/i.test(resolved.sources.depreciation ?? "")
  ) {
    resolved.values.depreciation = formAnchors.values.depreciation;
    resolved.confidence.depreciation = formAnchors.confidence.depreciation;
    resolved.sources.depreciation = formAnchors.sources.depreciation ?? "Form line 14";
  }

  if (resolved.values.other_income === undefined && !otherIncomeResolved && comparison?.values.other_income !== undefined) {
    resolved.values.other_income = comparison.values.other_income;
    resolved.confidence.other_income = comparison.confidence.other_income ?? 86;
    resolved.sources.other_income = "Two-year comparison";
  }

  if (resolved.values.other_income === undefined && !otherIncomeResolved) {
    const compCtx = /(?:\bg\s*)?ross\s+receipts?\s+or\s+sales|two\s*year\s*comparison|t\w{0,3}\s*y\s*ear\s*\w{0,6}\s*omparison/i;
    for (const rawLine of allText.split(/\n/)) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (!/^OTHER\s+INCOME\b/i.test(line)) continue;
      if (!compCtx.test(line) && !compCtx.test(allText.slice(Math.max(0, allText.indexOf(line) - 400), allText.indexOf(line)))) {
        continue;
      }
      const nums = lineMoneyTokens(line).filter((n) => Math.abs(n) >= 100);
      if (nums.length >= 2) {
        const picked = nums.length >= 3 ? nums[nums.length - 2]! : nums[1]!;
        resolved.values.other_income = Math.round(picked);
        resolved.confidence.other_income = 88;
        resolved.sources.other_income = "Two-year comparison (OTHER INCOME row)";
        break;
      }
    }
  }

  if (!resolved.values.cogs) {
    const compCtx = /(?:\bg\s*)?ross\s+receipts?\s+or\s+sales|two\s*year\s*comparison|t\w{0,3}\s*y\s*ear\s*\w{0,6}\s*omparison/i;
    for (const rawLine of allText.split(/\n/)) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (!/(?:\bc\s*)?ost\s+of\s+goods\s+sold/i.test(line)) continue;
      if (!compCtx.test(allText.slice(Math.max(0, allText.indexOf(line) - 400), allText.indexOf(line) + line.length))) {
        continue;
      }
      const nums = lineMoneyTokens(line).filter((n) => Math.abs(n) >= 100_000);
      if (nums.length >= 2) {
        const picked = nums.length >= 3 ? nums[nums.length - 2]! : nums[1]!;
        resolved.values.cogs = Math.round(derailOcrLeadingOne(picked));
        resolved.confidence.cogs = 88;
        resolved.sources.cogs = "Two-year comparison (COGS row)";
        break;
      }
    }
  }

  if (
    resolved.values.interest_expense !== undefined &&
    resolved.values.interest_expense > 0 &&
    /form 1120/i.test(resolved.sources.interest_expense ?? "") &&
    formAnchors.values.interest_expense === undefined
  ) {
    const ie = resolved.values.interest_expense;
    const fromIncomeVar = allText.split(/\n/).some((row) => {
      const line = row.replace(/\s+/g, " ").trim();
      if (!/interest\s+income/i.test(line)) return false;
      const nums = lineMoneyTokens(line);
      return nums.length >= 3 && Math.abs(nums[nums.length - 1]! - ie) <= 2;
    });
    if (fromIncomeVar) {
      delete resolved.values.interest_expense;
      delete resolved.confidence.interest_expense;
      delete resolved.sources.interest_expense;
    }
  }

  if (resolved.values.depreciation === undefined && comparison?.values.depreciation !== undefined) {
    resolved.values.depreciation = comparison.values.depreciation;
    resolved.confidence.depreciation = comparison.confidence.depreciation ?? 88;
    resolved.sources.depreciation = "Two-year comparison (DEPRECIATION row)";
  }

  if (resolved.values.amortization === undefined && comparison?.values.amortization !== undefined) {
    resolved.values.amortization = comparison.values.amortization;
    resolved.confidence.amortization = comparison.confidence.amortization ?? 88;
    resolved.sources.amortization = "Two-year comparison (AMORTIZATION row)";
  }

  if (
    resolved.values.other_income !== undefined &&
    resolved.values.other_income > 0 &&
    (formOi === undefined || formOi === 0) &&
    /OTHER INCOME row/i.test(resolved.sources.other_income ?? "")
  ) {
    delete resolved.values.other_income;
    delete resolved.confidence.other_income;
    delete resolved.sources.other_income;
  }

  if (
    formAnalysis.kind === "1120" &&
    resolved.values.other_income !== undefined &&
    resolved.values.other_income > 0 &&
    resolved.values.other_income <= 20 &&
    /line 5 interest/i.test(resolved.sources.other_income ?? "")
  ) {
    const line10HasAmount = formPage1.split(/\n/).some((row) => {
      const line = row.replace(/\s+/g, " ").trim();
      return (
        isForm1120Line(line, 10) &&
        /other\s+income/i.test(line) &&
        substantialMoneyTokens(line).some((n) => Math.abs(n) >= 100 && Math.abs(n) !== 10)
      );
    });
    if (!line10HasAmount) {
      delete resolved.values.other_income;
      delete resolved.confidence.other_income;
      delete resolved.sources.other_income;
    }
  }

  if (
    resolved.values.other_income !== undefined &&
    resolved.values.other_income > 0 &&
    statement1TotalIsTaxRefund(allText, resolved.values.other_income)
  ) {
    const refundAmt = resolved.values.other_income;
    if (resolved.values.other_operating_income === undefined) {
      resolved.values.other_operating_income = refundAmt;
      resolved.confidence.other_operating_income = 88;
      resolved.sources.other_operating_income = "Statement 1 tax refund → other operating income";
    }
    resolved.values.other_income = 0;
    resolved.confidence.other_income = 72;
    resolved.sources.other_income = "Statement 1 tax refund (not other income)";
  }

  if (resolved.values.sales !== undefined) {
    resolved.values.sales = Math.round(derailOcrLeadingOne(resolved.values.sales));
  }

  if (comparison && comparison.linesMatched >= 4) {
    refillFromComparison(resolved, comparison, year);
  }

  if (
    !statement1ReportsToWorkbookOtherIncome(allText) &&
    resolved.values.other_income !== undefined &&
    resolved.values.other_income > 0 &&
    resolved.values.other_income < 15_000
  ) {
    const stmtOiTotal = extractStatementOtherIncome(allText).value;
    if (
      stmtOiTotal !== undefined &&
      Math.abs(resolved.values.other_income - stmtOiTotal) <= Math.max(2, stmtOiTotal * 0.02)
    ) {
      resolved.values.other_income = 0;
      resolved.confidence.other_income = 90;
      resolved.sources.other_income = "Statement 1 (discount/cash items — not workbook other income)";
    }
  }

  reconcileDepreciationAmortization(resolved, {
    formAnchors,
    formPage1,
    allText,
    targetYear: year,
    comparison,
  });

  const ocrScheduleL = options?.ocrMode === "thorough" ? extractScheduleLFields(ocrText) : undefined;
  if (options?.ocrMode === "thorough" && ocrScheduleL) {
    applyThoroughScheduleLAgreement(resolved, embeddedScheduleL, ocrScheduleL, comparison ?? undefined);
  }

  applyConfidenceGates(resolved, { ocrMode: options?.ocrMode, taxYear: year });

  applyCoherenceGates(resolved, {
    allText,
    targetYear: year,
    formKind: formAnalysis.kind,
    formAnchors,
    formPage1,
    comparison,
  });

  refillFromComparisonLabeledRows(allText, resolved, year);

  reconcileOtherOperatingExpenses(resolved, {
    allText,
    formKind: formAnalysis.kind,
    targetYear: year,
    comparison,
    priorYearValues: options?.parseDebug?.priorYearValues,
  });

  if (comparison && comparison.linesMatched >= 4) {
    refillFromComparison(resolved, comparison, year);
  }

  if (comparison?.values.taxes_licenses !== undefined) {
    const comp = comparison.values.taxes_licenses;
    const got = resolved.values.taxes_licenses;
    if (
      comp >= 10_000 &&
      (got === undefined || Math.abs(got - comp) / Math.max(Math.abs(comp), 1) > 0.25)
    ) {
      resolved.values.taxes_licenses = comp;
      resolved.confidence.taxes_licenses = comparison.confidence.taxes_licenses ?? 90;
      resolved.sources.taxes_licenses = "Two-year comparison (taxes and licenses row)";
    }
  }

  const stmtTaxesPaid = extractStatementTaxesSplit(allText).values.taxes_paid;
  if (stmtTaxesPaid !== undefined && stmtTaxesPaid > 0) {
    const got = resolved.values.taxes_paid;
    if (got === undefined || got === 0) {
      resolved.values.taxes_paid = stmtTaxesPaid;
      resolved.confidence.taxes_paid = 92;
      resolved.sources.taxes_paid = "Statement 2 taxes (state income tax portion)";
    }
  }
  if (comparison?.values.taxes_paid !== undefined && comparison.values.taxes_paid > 0) {
    const comp = comparison.values.taxes_paid;
    const got = resolved.values.taxes_paid;
    if (got === undefined || Math.abs(got - comp) / comp > 0.25) {
      resolved.values.taxes_paid = comp;
      resolved.confidence.taxes_paid = comparison.confidence.taxes_paid ?? 88;
      resolved.sources.taxes_paid = "Two-year comparison (taxes paid row)";
    }
  }

  if (resolved.values.common_stock === undefined) {
    const sl = extractScheduleLFields(allText);
    const cs = sl.values.common_stock;
    if (cs !== undefined && cs >= 100 && cs < 1_000_000) {
      resolved.values.common_stock = cs;
      resolved.confidence.common_stock = sl.confidence.common_stock ?? 94;
      resolved.sources.common_stock = sl.sources.common_stock ?? "Schedule L line 22 (refill)";
    }
  }

  const nominalPar = new Set([100, 500, 1000, 5000, 10_000]);
  if (
    resolved.values.common_stock !== undefined &&
    resolved.values.common_stock > 0 &&
    resolved.values.common_stock < 10_000 &&
    !nominalPar.has(Math.round(resolved.values.common_stock)) &&
    resolved.values.unclassified_equity !== undefined &&
    resolved.values.unclassified_equity > 50_000 &&
    (resolved.values.other_stock_equity ?? 0) < 50_000
  ) {
    delete resolved.values.common_stock;
    delete resolved.confidence.common_stock;
    delete resolved.sources.common_stock;
  }

  normalizeEquityBuckets(resolved);

  if (
    resolved.values.other_operating_income !== undefined &&
    resolved.values.other_operating_income > 0 &&
    resolved.values.other_income !== undefined &&
    Math.abs(resolved.values.other_income - resolved.values.other_operating_income) <=
      Math.max(2, resolved.values.other_operating_income * 0.02)
  ) {
    resolved.values.other_income = 0;
    resolved.confidence.other_income = 90;
    resolved.sources.other_income = "Routed to other operating income (workbook split)";
  }

  if (comparison?.values.other_operating_income !== undefined && comparison.values.other_operating_income > 0) {
    resolved.values.other_operating_income = comparison.values.other_operating_income;
    resolved.confidence.other_operating_income = comparison.confidence.other_operating_income ?? 88;
    resolved.sources.other_operating_income = "Two-year comparison (other operating income row)";
    if (resolved.values.other_income !== undefined && resolved.values.other_income > 0) {
      resolved.values.other_income = 0;
      resolved.confidence.other_income = 88;
      resolved.sources.other_income = "Two-year comparison (other income → other operating income)";
    }
  }

  const stmtTaxSplit = extractStatementTaxesSplit(allText);
  if (stmtTaxSplit.values.taxes_licenses !== undefined && stmtTaxSplit.values.taxes_licenses >= 10_000) {
    const got = resolved.values.taxes_licenses;
    if (got === undefined || got < stmtTaxSplit.values.taxes_licenses * 0.5) {
      resolved.values.taxes_licenses = stmtTaxSplit.values.taxes_licenses;
      resolved.confidence.taxes_licenses = stmtTaxSplit.confidence.taxes_licenses ?? 96;
      resolved.sources.taxes_licenses = stmtTaxSplit.sources.taxes_licenses ?? "Statement 2 taxes split";
    }
  }

  const cogsPick = reconcileCogsFromSources({
    formCogs: formAnchors.values.cogs ?? resolved.values.cogs,
    formConfidence: formAnchors.confidence.cogs,
    formSource: formAnchors.sources.cogs,
    comparisonCogs: comparison?.values.cogs,
    comparisonConfidence: comparison?.confidence.cogs,
    sales: resolved.values.sales ?? formAnchors.values.sales,
  });
  if (cogsPick) {
    const got = resolved.values.cogs;
    if (got === undefined || Math.abs(got - cogsPick.value) / Math.max(cogsPick.value, 1) > 0.02) {
      resolved.values.cogs = cogsPick.value;
      resolved.confidence.cogs = cogsPick.confidence;
      resolved.sources.cogs = cogsPick.source;
    }
  }

  if (comparison?.values.depreciation !== undefined) {
    const comp = comparison.values.depreciation;
    const got = resolved.values.depreciation;
    const formDep = formAnchors.values.depreciation ?? resolved.values.depreciation;
    const formStrong =
      formDep !== undefined &&
      (formAnchors.confidence.depreciation ?? 0) >= 96 &&
      /form 1120/i.test(formAnchors.sources.depreciation ?? resolved.sources.depreciation ?? "");
    if (
      formDep !== undefined &&
      Math.abs(formDep - comp) / Math.max(Math.abs(comp), 1) > 0.25 &&
      Math.abs(comp) < 500_000
    ) {
      resolved.values.depreciation = comp;
      resolved.confidence.depreciation = comparison.confidence.depreciation ?? 88;
      resolved.sources.depreciation = "Two-year comparison (depreciation row — form mismatch)";
    } else if (
      !formStrong &&
      (got === undefined ||
        (Math.abs(got - comp) > Math.max(500, Math.abs(comp) * 0.25) &&
          Math.abs(comp) < 500_000 &&
          !/form 1120/i.test(resolved.sources.depreciation ?? "")))
    ) {
      resolved.values.depreciation = comp;
      resolved.confidence.depreciation = comparison.confidence.depreciation ?? 88;
      resolved.sources.depreciation = "Two-year comparison (depreciation row)";
    } else if (formStrong && formDep !== undefined) {
      resolved.values.depreciation = formDep;
      resolved.confidence.depreciation = formAnchors.confidence.depreciation ?? 97;
      resolved.sources.depreciation = formAnchors.sources.depreciation ?? "Form depreciation";
    }
  }

  if (
    resolved.values.interest_expense !== undefined &&
    resolved.values.interest_expense > 0 &&
    resolved.values.interest_expense < 5_000 &&
    !/form 1120/i.test(resolved.sources.interest_expense ?? "")
  ) {
    resolved.values.interest_expense = 0;
    resolved.confidence.interest_expense = 88;
    resolved.sources.interest_expense = "Coherence: small non-form interest cleared to zero";
  }

  if (
    embeddedScheduleL.values.inventory !== undefined &&
    embeddedScheduleL.values.inventory > 0 &&
    (resolved.values.inventory === undefined ||
      resolved.values.inventory === 0 ||
      /two-year comparison/i.test(resolved.sources.inventory ?? ""))
  ) {
    resolved.values.inventory = embeddedScheduleL.values.inventory;
    resolved.confidence.inventory = embeddedScheduleL.confidence.inventory ?? 95;
    resolved.sources.inventory =
      embeddedScheduleL.sources?.inventory ?? "Embedded Schedule L (inventory refill)";
  }

  const embOse = embeddedScheduleL.values.other_stock_equity;
  const embOseSrc = embeddedScheduleL.sources?.other_stock_equity ?? "";
  if (
    embOse !== undefined &&
    embOse > 100_000 &&
    /embedded schedule l \(arizona\)/i.test(embOseSrc) &&
    (resolved.values.other_stock_equity === undefined ||
      resolved.values.other_stock_equity === 0 ||
      /two-year comparison/i.test(resolved.sources.other_stock_equity ?? "") ||
      Math.abs((resolved.values.other_stock_equity ?? 0) - embOse) >
        Math.max(500, embOse * 0.02))
  ) {
    resolved.values.other_stock_equity = embOse;
    resolved.confidence.other_stock_equity = embeddedScheduleL.confidence.other_stock_equity ?? 95;
    resolved.sources.other_stock_equity =
      embOseSrc || "Embedded Schedule L (other stock equity refill)";
  }

  normalizeEquityBuckets(resolved);

  refillFromComparisonLabeledRows(allText, resolved, year);

  normalizeEquityBuckets(resolved);

  if (
    resolved.values.other_operating_income !== undefined &&
    resolved.values.other_operating_income > 0 &&
    resolved.values.other_income !== undefined &&
    Math.abs(resolved.values.other_income - resolved.values.other_operating_income) <=
      Math.max(2, resolved.values.other_operating_income * 0.02)
  ) {
    resolved.values.other_income = 0;
    resolved.confidence.other_income = 90;
    resolved.sources.other_income = "Routed to other operating income (workbook split)";
  }

  if (
    comparison?.values.taxes_licenses !== undefined &&
    comparison.values.taxes_licenses >= 50_000 &&
    resolved.values.taxes_paid !== undefined &&
    resolved.values.taxes_paid > 0
  ) {
    const split = Math.round(comparison.values.taxes_licenses - resolved.values.taxes_paid);
    if (split >= 10_000) {
      resolved.values.taxes_licenses = split;
      resolved.confidence.taxes_licenses = 91;
      resolved.sources.taxes_licenses = "Two-year comparison (taxes minus taxes paid)";
    }
  }

  if (
    resolved.values.other_operating_income !== undefined &&
    resolved.values.other_operating_income > 0
  ) {
    if (
      resolved.values.other_income !== undefined &&
      Math.abs(resolved.values.other_income - resolved.values.other_operating_income) <=
        Math.max(2, resolved.values.other_operating_income * 0.02)
    ) {
      resolved.values.other_income = 0;
      resolved.confidence.other_income = 90;
      resolved.sources.other_income = "Routed to other operating income (final)";
    }
  }

  const comparisonExtraction =
    comparison && comparison.linesMatched >= 4
      ? { values: comparison.values, confidence: comparison.confidence, sources: compSources }
      : null;

  const snapshots = buildVerificationSnapshots({
    formAnchors,
    comparison: comparisonExtraction,
    embeddedScheduleL,
    ocrScheduleL,
    statements: stmtDeductions,
    fuzzy,
    structured: structuredOcr,
  });

  const identity = clientIdentityFromText(`${embeddedText}\n${ocrText}`, filename);

  let comparisonPriorYear: number | undefined;
  let comparisonPriorValues: Record<string, number> | undefined;
  if (comparison?.headerYears && comparison.linesMatched >= 4) {
    const [yL, yR] = comparison.headerYears;
    const priorY = year === yL ? yR : year === yR ? yL : undefined;
    if (priorY !== undefined && priorY < year) {
      const priorBlock = parseTwoYearComparisonBlock(allText, priorY);
      if (priorBlock && priorBlock.linesMatched >= 4) {
        comparisonPriorYear = priorY;
        comparisonPriorValues = priorBlock.values;
      }
    }
  }

  const verified = applyTaxYearVerification(
    {
      year,
      values: resolved.values,
      confidence: resolved.confidence,
      fieldSources: resolved.sources,
      warnings: resolved.warnings,
      source: "free-local-ocr:tesseract.js",
      comparisonPriorYear,
      comparisonPriorValues,
      ...identity,
    },
    snapshots,
  );

  return applyPostVerificationWorkbookFixes(verified, {
    allText,
    year,
    formKind: formAnalysis.kind,
    comparison,
    formAnchors,
    embeddedScheduleL,
    sourceSnapshots: snapshots,
    parseDebug: options?.parseDebug,
  });
}

function applyPostVerificationWorkbookFixes(
  verified: ReturnType<typeof applyTaxYearVerification>,
  ctx: {
    allText: string;
    year: number;
    formKind: ReturnType<typeof detectTaxForm>["kind"];
    comparison: ReturnType<typeof parseTwoYearComparisonBlock> | null | undefined;
    formAnchors: ReturnType<typeof extractForm1120Anchors>;
    embeddedScheduleL: FieldExtraction;
    sourceSnapshots: Record<string, SourceSnapshot[]>;
    parseDebug?: {
      onOpexReconcile?: (debug: OpexReconcileDebug) => void;
      priorYearValues?: Record<number, Record<string, number>>;
    };
  },
): ReturnType<typeof applyTaxYearVerification> {
  const values = { ...verified.values };
  const confidence = { ...(verified.confidence ?? {}) };
  const fieldSources = { ...(verified.fieldSources ?? {}) };
  const warnings = [...(verified.warnings ?? [])];
  const post: ResolvedFields = { values, confidence, sources: fieldSources, warnings };

  refillFromComparisonLabeledRows(ctx.allText, post, ctx.year);

  const stmt18Total = scanStatementLine18Total(ctx.allText);
  if (stmt18Total !== undefined && stmt18Total >= 10_000) {
    const cur = values.other_current_liabilities;
    const src = fieldSources.other_current_liabilities ?? "";
    const weak =
      !src || /comparison|tail scan|OCR label|fuzzy/i.test(src) || (cur !== undefined && cur < 35_000);
    if (
      cur === undefined ||
      (weak && Math.abs(cur - stmt18Total) / Math.max(stmt18Total, 1) > 0.08)
    ) {
      values.other_current_liabilities = stmt18Total;
      confidence.other_current_liabilities = Math.min(confidence.other_current_liabilities ?? 82, 82);
      fieldSources.other_current_liabilities = "Statement (Line 18) total";
    }
  }

  reconcileOtherOperatingExpenses(post, {
    allText: ctx.allText,
    formKind: ctx.formKind,
    targetYear: ctx.year,
    comparison: ctx.comparison ?? undefined,
    priorYearValues: ctx.parseDebug?.priorYearValues,
  });

  applyLargeCorpBlockOpexOverride(post, {
    allText: ctx.allText,
    targetYear: ctx.year,
    sales: values.sales,
  });

  if (ctx.parseDebug?.onOpexReconcile) {
    ctx.parseDebug.onOpexReconcile(
      emitOpexReconcileDebug(post, {
        allText: ctx.allText,
        formKind: ctx.formKind,
        targetYear: ctx.year,
        comparison: ctx.comparison ?? undefined,
        priorYearValues: ctx.parseDebug.priorYearValues,
      }),
    );
  }

  normalizeEquityBuckets(post);

  const cogsPick = reconcileCogsFromSources({
    formCogs: ctx.formAnchors.values.cogs ?? values.cogs,
    formConfidence: ctx.formAnchors.confidence.cogs,
    formSource: ctx.formAnchors.sources.cogs,
    comparisonCogs: ctx.comparison?.values.cogs,
    comparisonConfidence: ctx.comparison?.confidence.cogs,
    sales: values.sales ?? ctx.formAnchors.values.sales,
  });
  if (cogsPick) {
    const got = values.cogs;
    if (got === undefined || Math.abs(got - cogsPick.value) / Math.max(cogsPick.value, 1) > 0.02) {
      values.cogs = cogsPick.value;
      confidence.cogs = cogsPick.confidence;
      fieldSources.cogs = cogsPick.source;
    }
  }

  if (ctx.comparison?.values.depreciation !== undefined) {
    const comp = ctx.comparison.values.depreciation;
    const formDep = ctx.formAnchors.values.depreciation ?? values.depreciation;
    if (
      formDep !== undefined &&
      Math.abs(formDep - comp) / Math.max(Math.abs(comp), 1) > 0.25 &&
      Math.abs(comp) < 500_000
    ) {
      values.depreciation = comp;
      confidence.depreciation = ctx.comparison.confidence.depreciation ?? 88;
      fieldSources.depreciation = "Two-year comparison (depreciation row — form mismatch)";
    }
  }

  if (
    ctx.comparison?.values.taxes_licenses !== undefined &&
    ctx.comparison.values.taxes_licenses >= 50_000 &&
    values.taxes_paid !== undefined &&
    values.taxes_paid > 0
  ) {
    const split = Math.round(ctx.comparison.values.taxes_licenses - values.taxes_paid);
    if (split >= 10_000) {
      values.taxes_licenses = split;
      confidence.taxes_licenses = 91;
      fieldSources.taxes_licenses = "Two-year comparison (taxes minus taxes paid)";
    }
  }

  if (
    ctx.embeddedScheduleL.values.inventory !== undefined &&
    ctx.embeddedScheduleL.values.inventory > 0 &&
    (values.inventory === undefined ||
      values.inventory === 0 ||
      /two-year comparison/i.test(fieldSources.inventory ?? ""))
  ) {
    values.inventory = ctx.embeddedScheduleL.values.inventory;
    confidence.inventory = ctx.embeddedScheduleL.confidence.inventory ?? 95;
    fieldSources.inventory =
      ctx.embeddedScheduleL.sources?.inventory ?? "Embedded Schedule L (inventory refill)";
  }

  const embOse = ctx.embeddedScheduleL.values.other_stock_equity;
  const embOseSrc = ctx.embeddedScheduleL.sources?.other_stock_equity ?? "";
  if (
    embOse !== undefined &&
    embOse > 100_000 &&
    /embedded schedule l \(arizona\)/i.test(embOseSrc) &&
    (values.other_stock_equity === undefined ||
      values.other_stock_equity === 0 ||
      /two-year comparison/i.test(fieldSources.other_stock_equity ?? "") ||
      Math.abs((values.other_stock_equity ?? 0) - embOse) > Math.max(500, embOse * 0.02))
  ) {
    values.other_stock_equity = embOse;
    confidence.other_stock_equity = ctx.embeddedScheduleL.confidence.other_stock_equity ?? 95;
    fieldSources.other_stock_equity =
      embOseSrc || "Embedded Schedule L (other stock equity refill)";
  }

  if (
    values.interest_expense !== undefined &&
    values.interest_expense > 0 &&
    values.interest_expense < 5_000 &&
    !/form 1120/i.test(fieldSources.interest_expense ?? "")
  ) {
    values.interest_expense = 0;
    confidence.interest_expense = 88;
    fieldSources.interest_expense = "Coherence: small non-form interest cleared to zero";
  }

  if (
    values.other_operating_income !== undefined &&
    values.other_operating_income > 0 &&
    values.other_income !== undefined &&
    Math.abs(values.other_income - values.other_operating_income) <=
      Math.max(2, values.other_operating_income * 0.02)
  ) {
    values.other_income = 0;
    confidence.other_income = 90;
    fieldSources.other_income = "Routed to other operating income (post-verification)";
  }

  normalizeEquityBuckets(post);

  // Schedule L line-24 can land after bucket normalization during verification.
  normalizeEquityBuckets(post);

  // Down-rank derived / single-source attachment fields so they show as "verify" in the UI
  for (const id of Object.keys(values)) {
    const src = fieldSources[id] ?? "";
    const conf = confidence[id] ?? 70;
    if (/verify|residual|post-verification|inferred/i.test(src) && conf > 78) {
      confidence[id] = 78;
    }
    if (/Statement 2 \(bank\/credit card — verify\)/i.test(src)) {
      confidence[id] = Math.min(confidence[id] ?? 74, 74);
    }
  }

  const reconciliation = reconcileTaxYear({
    values,
    confidence,
    fieldSources,
    sourceSnapshots: ctx.sourceSnapshots,
    taxYear: ctx.year,
  });

  const ocrCoverage = buildOcrCoverageDiagnostics(ctx.allText, ctx.formKind, post, {
    targetYear: ctx.year,
    opex: values.other_operating_expenses,
    ocrPageCount: (ctx.allText.match(/---\s*OCR\s*PAGE/gi) ?? []).length || undefined,
  });

  const opexCandidates = generateOpexCandidates(post, {
    allText: ctx.allText,
    formKind: ctx.formKind,
    targetYear: ctx.year,
    comparison: ctx.comparison ?? undefined,
    priorYearValues: ctx.parseDebug?.priorYearValues,
  });

  const confidenceLayer = applyWorkbookConfidenceLayer({
    values,
    confidence,
    displayConfidence: reconciliation.displayConfidence,
    fieldFlags: reconciliation.fieldFlags,
    fieldSources,
    sourceSnapshots: ctx.sourceSnapshots,
    opexCandidates,
    ocrCoverage,
    taxYear: ctx.year,
    fieldIds: Object.keys(values).filter((id) => values[id] !== undefined),
  });

  const fieldTrustTier = { ...reconciliation.fieldTrustTier };
  const fieldStatus = { ...reconciliation.fieldStatus };
  const fieldFlagsOut = { ...confidenceLayer.fieldFlags };
  const displayConfidenceOut = { ...confidenceLayer.displayConfidence };

  if (ocrCoverage?.flags.length) {
    for (const id of INPUT_ROW_IDS) {
      if (values[id] !== undefined) continue;
      fieldStatus[id] = "missing";
      displayConfidenceOut[id] = displayConfidenceOut[id] ?? 70;
      if (MISSING_MATERIAL_FIELD_IDS.has(id)) {
        fieldFlagsOut[id] = mergeConfidenceFlags(fieldFlagsOut[id], ["ocr_incomplete"]);
        displayConfidenceOut[id] = capConfidenceForFlags(displayConfidenceOut[id] ?? 70, ["ocr_incomplete"]);
      }
      if (STMT_ATTACHMENT_FIELD_IDS.has(id) || id === "cash" || id === "accumulated_depreciation") {
        fieldTrustTier[id] = "moderate";
      }
    }
  }

  for (const [id, flags] of Object.entries(fieldFlagsOut)) {
    const hasWarning = flags.some((f) =>
      /candidate_conflict|source_disagreement|formula_inconsistency|verify manually|Other reads/i.test(f),
    );
    if (hasWarning && fieldStatus[id] !== "missing") {
      fieldStatus[id] = "review";
    }
    if (id === "other_operating_expenses" && hasWarning) {
      fieldTrustTier[id] = "moderate";
    }
  }

  const fieldAlternatesFromConfidence = confidenceLayer.fieldAlternatives.other_operating_expenses;
  const fieldAlternates = fieldAlternatesFromConfidence?.length
    ? {
        ...(verified.fieldAlternates ?? {}),
        other_operating_expenses: fieldAlternatesFromConfidence.map((a) => ({
          family: "candidate" as const,
          value: a.value,
          confidence: Math.round(a.score),
          sourceLabel: a.source,
        })),
      }
    : verified.fieldAlternates;

  const fieldCandidateOptions = opexCandidates.length
    ? {
        other_operating_expenses: opexCandidates.map((c) => ({
          value: c.value,
          source: c.source,
          kind: "opex" as const,
          closureScore: c.closureScore,
          totalScore: c.totalScore,
          valid: c.valid,
          confidence: Math.round(c.totalScore),
        })),
      }
    : undefined;

  return {
    ...verified,
    values,
    confidence,
    fieldSources,
    warnings,
    fieldFlags: fieldFlagsOut,
    fieldStatus,
    displayConfidence: displayConfidenceOut,
    sourceAgreement: reconciliation.sourceAgreement,
    fieldTrustTier,
    fieldAlternates,
    fieldCandidateOptions,
    ocrCoverage,
  };
}
