import { parseFinancialTablesFromText, type YearSeries } from "@/lib/financial-text-parser";
import { parseTwoYearComparisonBlock } from "@/lib/two-year-comparison-parser";
import { TAX_WORKBOOK_ROWS, type TaxYearValues } from "@/lib/tax-workbook";
import { TAX_ATTACHMENT_FIELD_IDS } from "@/lib/workbook-comparison-fixtures";
import { extractFormAnchors, extractFormPage1Block, formAnchorSourceText, type FieldExtraction } from "./form-anchors";
import { detectTaxForm } from "./detect-tax-form";
import {
  lineMoneyTokens,
  lineTailAmount,
  scheduleLineAmount,
  substantialMoneyTokens,
  isForm1120Line,
  isFormReferenceNumber,
  isReasonableMoneyAmount,
  derailOcrLeadingOne,
  formLineAmount,
} from "./money";
import { clientIdentityFromText } from "./extract-business-name";
import { inferTaxYear } from "./infer-year";
import { findHitsLineScoped, resolveHits } from "./line-hits";
import {
  applyConfidenceGates,
  refillFromComparison,
  isWeakSource,
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
  scanBooksOtherIncomeForYear,
  statement1HasOtherIncomeDetailLine,
  statement1ReportsToWorkbookOtherIncome,
  statement1DetailAmountMatches,
  statement1TotalIsTaxRefund,
} from "./statement-extractors";
import { applyCoherenceGates } from "./coherence-gates";
import { isInterestInstructionCrumb } from "./interest-crumb";
import { reconcileOtherOperatingExpenses, applyLargeCorpBlockOpexOverride, emitOpexReconcileDebug, type OpexReconcileDebug } from "./other-operating-expenses";
import { applyOrdinaryIncomeReverseOpex, flagPnlIdentityMismatches, scanFormGrossProfit, scanFormOrdinaryBusinessIncome } from "./pnl-identity";
import { refillFromComparisonLabeledRows } from "./comparison-field-rows";
import { normalizeEquityBuckets } from "./equity-buckets";
import { reconcileDepreciationAmortization, scanComparisonIsExpense } from "./income-depreciation-amort";
import { buildOcrCoverageDiagnostics, type OcrCoverageDiagnostics } from "./ocr-coverage-diagnostics";
import { generateOpexCandidates } from "./opex-candidate-ranking";
import { applyWorkbookConfidenceLayer } from "@/lib/tax-confidence/field-confidence";
import { capConfidenceForFlags, mergeConfidenceFlags } from "@/lib/tax-confidence/confidence-flags";
import { STMT_ATTACHMENT_FIELD_IDS } from "./ocr-coverage-rescan";
import { reconcileCogsFromSources } from "./cogs-reconcile";
import {
  applyOperatingExpensesToSingleYear,
  extractRawExpenseLinePool,
} from "@/lib/tax/operating-expenses";
import { scanReturnOtherDeductionsTotal } from "@/lib/tax/opex-partition-closure";

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
    Math.round(stmtTotal) === Math.round(formOi);

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
        Math.abs(compOi) > 99 &&
        isReasonableMoneyAmount(compOi) &&
        !isFormReferenceNumber(Math.abs(compOi))
      ) {
        // Keepable comparison amount only — no bare <$2k size invent gate.
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
        Math.round(compOi) === Math.round(formOi) &&
        statement1TotalIsTaxRefund(allText, stmtTotal ?? compOi)
      ) {
        const booksOi = scanBooksOtherIncomeForYear(allText, year);
        if (booksOi === undefined || booksOi > 0) {
          resolved.values.other_operating_income = Math.round(booksOi ?? compOi);
          resolved.confidence.other_operating_income = 93;
          resolved.sources.other_operating_income =
            "Two-year comparison OTHER INCOME (Stmt 1 tax refund → other operating income)";
        }
      }
    }
    otherIncomeResolved = true;
  }
  if (!otherIncomeResolved && formAnalysis.kind === "1120" && formOi !== undefined) {
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
      Math.round(compOi) !== Math.round(stmtTotal!)
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
      statement1ReportsToWorkbookOtherIncome(allText) &&
      (compOiLater === undefined || Math.round(formOi) !== Math.round(compOiLater));
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
    const corroboratedLine14 = allText.split(/\n/).some(
      (row) =>
        /\b14\b/i.test(row) &&
        /other\s+ass/i.test(row) &&
        Math.round(scheduleLineAmount(row) ?? 0) === Math.round(oa),
    );
    if (looksLikeTotalAssets && !/\b14\b[^\n]{0,50}other\s+ass/i.test(allText)) {
      delete resolved.values.other_assets;
      delete resolved.confidence.other_assets;
      delete resolved.sources.other_assets;
    } else if (resolved.sources.other_assets === "OCR label match" && !corroboratedLine14) {
      // Uncorroborated OCR caption hits — structural, not $10k/$50k size clears.
      delete resolved.values.other_assets;
      delete resolved.confidence.other_assets;
      delete resolved.sources.other_assets;
    }
  }

  if (
    resolved.values.other_current_assets !== undefined &&
    resolved.sources.other_current_assets === "OCR label match"
  ) {
    const oca = resolved.values.other_current_assets;
    const corroborated =
      Math.abs(Math.round(oca)) > 99 &&
      allText.split(/\n/).some(
        (row) =>
          (/\b6\b/i.test(row) || /other\s+current\s+ass/i.test(row)) &&
          /other\s+current\s+ass|line\s*6/i.test(row) &&
          Math.round(scheduleLineAmount(row) ?? 0) === Math.round(oca),
      );
    if (!corroborated) {
      delete resolved.values.other_current_assets;
      delete resolved.confidence.other_current_assets;
      delete resolved.sources.other_current_assets;
    }
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
    Math.round(resolved.values.other_stock_equity) ===
      Math.round(resolved.values.unclassified_equity)
  ) {
    delete resolved.values.other_stock_equity;
    delete resolved.confidence.other_stock_equity;
    delete resolved.sources.other_stock_equity;
  } else if (
    resolved.values.unclassified_equity !== undefined &&
    resolved.values.other_stock_equity !== undefined &&
    /embedded schedule l \(paired-column\)/i.test(resolved.sources.other_stock_equity ?? "") &&
    isWeakSource(resolved.sources.unclassified_equity) &&
    !/schedule\s+l/i.test(resolved.sources.unclassified_equity ?? "")
  ) {
    delete resolved.values.unclassified_equity;
    delete resolved.confidence.unclassified_equity;
    delete resolved.sources.unclassified_equity;
  }

  if (
    resolved.values.gross_intangible_assets !== undefined &&
    Math.abs(resolved.values.gross_intangible_assets) <= 99 &&
    resolved.sources.gross_intangible_assets === "OCR label match"
  ) {
    // Line-number crumb on OCR captions — not a $20k size clear.
    delete resolved.values.gross_intangible_assets;
    delete resolved.confidence.gross_intangible_assets;
    delete resolved.sources.gross_intangible_assets;
  }

  if (
    resolved.values.unclassified_equity !== undefined &&
    (resolved.values.unclassified_equity < 0 ||
      (Math.abs(resolved.values.unclassified_equity) <= 99 &&
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
      if (/statement\s*2|federal\s+statements/i.test(resolved.sources[id] ?? "")) {
        const opexSlots = new Set([
          "rent",
          "bank_credit_card",
          "professional_fees",
          "utilities",
          "officer_compensation",
          "salaries_wages",
          "advertising",
          "taxes_licenses",
        ]);
        if (opexSlots.has(id)) continue;
      }
      if (
        weakSource(resolved.sources[id]) &&
        Math.round(got) !== Math.round(comp)
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
        got !== 0 &&
        weakSource(resolved.sources[id])
      ) {
        resolved.values[id] = 0;
        resolved.confidence[id] = comparison.confidence[id] ?? 88;
        resolved.sources[id] = "Two-year comparison (zero override)";
        continue;
      }
      if (
        ((id as string) === "cogs" || (id as string) === "sales") &&
        !/comparison/i.test(resolved.sources[id] ?? "") &&
        Math.round(got) !== Math.round(comp)
      ) {
        const formVal = formAnchors.values[id];
        const formConf = formAnchors.confidence[id] ?? 0;
        if (
          formVal !== undefined &&
          formConf >= 96 &&
          Math.round(got) === Math.round(formVal)
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
      Math.round(got) !== Math.round(formVal) &&
      (formAnchors.confidence[id] ?? 0) >= 96
    ) {
      resolved.values[id] = formVal;
      resolved.confidence[id] = formAnchors.confidence[id] ?? 97;
      resolved.sources[id] = formAnchors.sources[id] ?? `Form line (${id})`;
    }
  }

  const formDep = formAnchors.values.depreciation;
  if (
    resolved.values.depreciation !== undefined &&
    Math.abs(resolved.values.depreciation) <= 99 &&
    !/NET\s+DEPRECIATION|depreciation report/i.test(resolved.sources.depreciation ?? "")
  ) {
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
      return amt !== undefined && Math.round(amt) === Math.round(resolved.values.other_income!);
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
      return amt !== undefined && Math.round(amt) === Math.round(resolved.values.other_income!);
    });
    if (!page5Oi) {
      delete resolved.values.other_income;
      delete resolved.confidence.other_income;
      delete resolved.sources.other_income;
    }
  }

  if (
    resolved.values.interest_expense !== undefined &&
    resolved.values.interest_expense > 0 &&
    /comparison/i.test(resolved.sources.interest_expense ?? "") &&
    formAnchors.values.interest_expense === undefined
  ) {
    delete resolved.values.interest_expense;
    delete resolved.confidence.interest_expense;
    delete resolved.sources.interest_expense;
  }

  // Do not soft-% override depreciation: Form page-1 multi-column bleed often disagrees
  // with NET DEPRECIATION / Form 4562; reconcileDepreciationAmortization already ranked sources.

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
    // Tax-refund Stmt-1 total is authoritative for OOI — overwrite books/comparison guesses.
    resolved.values.other_operating_income = refundAmt;
    resolved.confidence.other_operating_income = 92;
    resolved.sources.other_operating_income = "Statement 1 tax refund → other operating income";
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
    resolved.values.other_income > 0
  ) {
    const stmtOiTotal = extractStatementOtherIncome(allText).value;
    if (
      stmtOiTotal !== undefined &&
      Math.round(resolved.values.other_income) === Math.round(stmtOiTotal)
    ) {
      resolved.values.other_income = 0;
      resolved.confidence.other_income = 90;
      resolved.sources.other_income = "Statement 1 (discount/cash items — not workbook other income)";
    }
  }

  // Same Stmt-1 discount/cash totals must not land in other_operating_income either.
  if (
    !statement1ReportsToWorkbookOtherIncome(allText) &&
    resolved.values.other_operating_income !== undefined &&
    resolved.values.other_operating_income > 0 &&
    /other\s+income|comparison/i.test(resolved.sources.other_operating_income ?? "")
  ) {
    const stmtOiTotal = extractStatementOtherIncome(allText).value;
    const matchesTotal =
      stmtOiTotal !== undefined &&
      Math.round(resolved.values.other_operating_income) === Math.round(stmtOiTotal);
    // Also catch a single Stmt-1 detail row (e.g. "other Income 1,319") misrouted to OOI.
    const matchesDetail =
      !matchesTotal &&
      statement1DetailAmountMatches(allText, resolved.values.other_operating_income);
    if (matchesTotal || matchesDetail) {
      delete resolved.values.other_operating_income;
      delete resolved.confidence.other_operating_income;
      delete resolved.sources.other_operating_income;
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
    applyThoroughScheduleLAgreement(
      resolved,
      embeddedScheduleL,
      ocrScheduleL,
      comparison
        ? { values: comparison.values, confidence: comparison.confidence, sources: {} }
        : undefined,
    );
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

  // Form 8990 / IRC §163(j) crumbs — source context only (no bare <$200 / <$5k floors).
  if (
    resolved.values.interest_expense !== undefined &&
    resolved.values.interest_expense > 0 &&
    isInterestInstructionCrumb(
      resolved.values.interest_expense,
      resolved.sources.interest_expense ?? "",
    )
  ) {
    delete resolved.values.interest_expense;
    delete resolved.confidence.interest_expense;
    delete resolved.sources.interest_expense;
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
    if (got === undefined || got === 0 || isWeakSource(resolved.sources.taxes_paid)) {
      resolved.values.taxes_paid = comp;
      resolved.confidence.taxes_paid = comparison.confidence.taxes_paid ?? 88;
      resolved.sources.taxes_paid = "Two-year comparison (taxes paid row)";
    }
  }

  if (resolved.values.common_stock === undefined) {
    const sl = extractScheduleLFields(allText);
    const cs = sl.values.common_stock;
    if (cs !== undefined && cs >= 1 && !isFormReferenceNumber(Math.abs(cs))) {
      resolved.values.common_stock = cs;
      resolved.confidence.common_stock = sl.confidence.common_stock ?? 94;
      resolved.sources.common_stock = sl.sources.common_stock ?? "Schedule L line 22 (refill)";
    }
  }

  const nominalPar = new Set([100, 500, 1000, 5000, 10_000]);
  if (
    resolved.values.common_stock !== undefined &&
    resolved.values.common_stock > 0 &&
    !nominalPar.has(Math.round(resolved.values.common_stock)) &&
    isWeakSource(resolved.sources.common_stock) &&
    (resolved.values.unclassified_equity !== undefined ||
      resolved.values.other_stock_equity !== undefined)
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
    Math.round(resolved.values.other_income) === Math.round(resolved.values.other_operating_income)
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

  // Re-apply after comparison refill — tax-refund Stmt-1 amounts belong on OOI, not other_income.
  {
    const stmtOi = extractStatementOtherIncome(allText).value;
    if (stmtOi !== undefined && stmtOi > 0 && statement1TotalIsTaxRefund(allText, stmtOi)) {
      resolved.values.other_operating_income = Math.round(stmtOi);
      resolved.confidence.other_operating_income = 92;
      resolved.sources.other_operating_income = "Statement 1 tax refund → other operating income";
      resolved.values.other_income = 0;
      resolved.confidence.other_income = 72;
      resolved.sources.other_income = "Statement 1 tax refund (not other income)";
    }
  }

  const stmtTaxSplit = extractStatementTaxesSplit(allText);
  if (stmtTaxSplit.values.taxes_licenses !== undefined && stmtTaxSplit.values.taxes_licenses >= 1) {
    const got = resolved.values.taxes_licenses;
    const src = resolved.sources.taxes_licenses ?? "";
    const weak = !src || /OCR label|fuzzy|label match|embedded detail|tail scan/i.test(src);
    // Stmt taxes split wins when missing/weak or dollars disagree — no ×0.5 undervalue band.
    if (
      got === undefined ||
      weak ||
      Math.round(Math.abs(got)) !== Math.round(Math.abs(stmtTaxSplit.values.taxes_licenses))
    ) {
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
    if (got === undefined || Math.round(got) !== Math.round(cogsPick.value)) {
      resolved.values.cogs = cogsPick.value;
      resolved.confidence.cogs = cogsPick.confidence;
      resolved.sources.cogs = cogsPick.source;
    }
  }

  if (comparison?.values.depreciation !== undefined) {
    const comp = comparison.values.depreciation;
    const got = resolved.values.depreciation;
    const formDep = formAnchors.values.depreciation;
    const depSrc = resolved.sources.depreciation ?? "";
    const keepReport = /NET\s+DEPRECIATION|depreciation report/i.test(depSrc);
    // NET DEPRECIATION / report beats blank or multi-column Form bleed and comparison.
    if (!keepReport) {
      if (
        formDep !== undefined &&
        formDep !== 0 &&
        (got === undefined || Math.round(got) !== Math.round(formDep)) &&
        !/comparison/i.test(depSrc)
      ) {
        resolved.values.depreciation = formDep;
        resolved.confidence.depreciation = formAnchors.confidence.depreciation ?? 97;
        resolved.sources.depreciation = formAnchors.sources.depreciation ?? "Form depreciation";
      } else if (got === undefined || isWeakSource(depSrc)) {
        resolved.values.depreciation = comp;
        resolved.confidence.depreciation = comparison.confidence.depreciation ?? 88;
        resolved.sources.depreciation = "Two-year comparison (depreciation row)";
      }
    }
  }

  if (
    resolved.values.interest_expense !== undefined &&
    resolved.values.interest_expense > 0 &&
    isInterestInstructionCrumb(
      resolved.values.interest_expense,
      resolved.sources.interest_expense ?? "",
    )
  ) {
    delete resolved.values.interest_expense;
    delete resolved.confidence.interest_expense;
    delete resolved.sources.interest_expense;
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
    embOse > 0 &&
    /embedded schedule l \(paired-column\)/i.test(embOseSrc) &&
    (resolved.values.other_stock_equity === undefined ||
      resolved.values.other_stock_equity === 0 ||
      /two-year comparison/i.test(resolved.sources.other_stock_equity ?? "") ||
      Math.round(resolved.values.other_stock_equity ?? 0) !== Math.round(embOse))
  ) {
    resolved.values.other_stock_equity = embOse;
    resolved.confidence.other_stock_equity = embeddedScheduleL.confidence.other_stock_equity ?? 95;
    resolved.sources.other_stock_equity =
      embOseSrc || "Embedded Schedule L (other stock equity refill)";
  }

  normalizeEquityBuckets(resolved);

  refillFromComparisonLabeledRows(allText, resolved, year);

  // Final tax-refund routing after late comparison refills.
  {
    const stmtOi = extractStatementOtherIncome(allText).value;
    if (stmtOi !== undefined && stmtOi > 0 && statement1TotalIsTaxRefund(allText, stmtOi)) {
      resolved.values.other_operating_income = Math.round(stmtOi);
      resolved.confidence.other_operating_income = 92;
      resolved.sources.other_operating_income = "Statement 1 tax refund → other operating income";
      resolved.values.other_income = 0;
      resolved.confidence.other_income = 72;
      resolved.sources.other_income = "Statement 1 tax refund (not other income)";
    }
  }

  normalizeEquityBuckets(resolved);

  if (
    resolved.values.other_operating_income !== undefined &&
    resolved.values.other_operating_income > 0 &&
    resolved.values.other_income !== undefined &&
    Math.round(resolved.values.other_income) === Math.round(resolved.values.other_operating_income)
  ) {
    resolved.values.other_income = 0;
    resolved.confidence.other_income = 90;
    resolved.sources.other_income = "Routed to other operating income (workbook split)";
  }

  if (comparison?.values.taxes_licenses !== undefined && comparison.values.taxes_licenses >= 1) {
    const paid =
      resolved.values.taxes_paid ??
      comparison.values.taxes_paid ??
      extractStatementTaxesSplit(allText).values.taxes_paid;
    // Identity split when paid is embedded in the comparison taxes row — no $50k/$10k gates.
    if (paid !== undefined && paid > 0 && paid < comparison.values.taxes_licenses) {
      const split = Math.round(comparison.values.taxes_licenses - paid);
      if (split >= 1) {
        resolved.values.taxes_licenses = split;
        resolved.confidence.taxes_licenses = 91;
        resolved.sources.taxes_licenses = "Two-year comparison (taxes minus taxes paid)";
      }
    }
  }

  if (comparison?.values.rent !== undefined && comparison.values.rent >= 1) {
    const got = resolved.values.rent;
    const src = resolved.sources.rent ?? "";
    const weak = !src || /OCR label|fuzzy|label match|embedded detail|tail scan/i.test(src);
    const stmt2Rent = stmtDeductions.values.rent;
    // Stmt/Form rent dollars win on disagree; comparison fills missing/weak only.
    if (
      stmt2Rent !== undefined &&
      stmt2Rent >= 1 &&
      (got === undefined || Math.round(Math.abs(got)) !== Math.round(Math.abs(stmt2Rent)))
    ) {
      resolved.values.rent = stmt2Rent;
      resolved.confidence.rent = stmtDeductions.confidence.rent ?? 93;
      resolved.sources.rent = stmtDeductions.sources.rent ?? "Statement 2 (rent detail)";
    } else if (
      (got === undefined || weak) &&
      !/statement\s*2|federal\s+statements|form\s+page/i.test(src)
    ) {
      resolved.values.rent = comparison.values.rent;
      resolved.confidence.rent = comparison.confidence.rent ?? 90;
      resolved.sources.rent = "Two-year comparison (rent row)";
    }
  }

  if (
    resolved.values.other_operating_income !== undefined &&
    resolved.values.other_operating_income > 0
  ) {
    if (
      resolved.values.other_income !== undefined &&
      Math.round(resolved.values.other_income) ===
        Math.round(resolved.values.other_operating_income)
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

  const crossReferenced: FieldExtraction = { values: {}, confidence: {}, sources: {} };
  for (const id of ["depreciation", "amortization"] as const) {
    const v = resolved.values[id];
    const src = resolved.sources[id];
    if (v === undefined || src === undefined) continue;
    if (/blank/i.test(src)) continue;
    crossReferenced.values[id] = v;
    crossReferenced.confidence[id] = resolved.confidence[id] ?? 90;
    crossReferenced.sources[id] = src;
  }

  const snapshots = buildVerificationSnapshots({
    formAnchors,
    comparison: comparisonExtraction,
    embeddedScheduleL,
    ocrScheduleL,
    statements: stmtDeductions,
    fuzzy,
    structured: structuredOcr,
    crossReferenced: Object.keys(crossReferenced.values).length ? crossReferenced : null,
  });

  const identity = clientIdentityFromText(`${embeddedText}\n${ocrText}`, filename);

  let comparisonPriorYear: number | undefined;
  let comparisonPriorValues: Record<string, number> | undefined;
  if (comparison?.linesMatched && comparison.linesMatched >= 4) {
    const priorY = comparison.headerYears
      ? (() => {
          const [yL, yR] = comparison.headerYears;
          return year === yL ? yR : year === yR ? yL : undefined;
        })()
      : year - 1;
    if (priorY !== undefined && priorY < year) {
      const priorBlock = parseTwoYearComparisonBlock(allText, priorY, {
        // OCR often drops "2023 & 2024" headers; two-year worksheets are prior | current.
        assumeHeaderYears: [priorY, year],
      });
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
    formAnchors: ReturnType<typeof extractFormAnchors>;
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

  {
    const stmtOi = extractStatementOtherIncome(ctx.allText).value;
    if (stmtOi !== undefined && stmtOi > 0 && statement1TotalIsTaxRefund(ctx.allText, stmtOi)) {
      values.other_operating_income = Math.round(stmtOi);
      confidence.other_operating_income = 92;
      fieldSources.other_operating_income = "Statement 1 tax refund → other operating income";
      values.other_income = 0;
      confidence.other_income = 72;
      fieldSources.other_income = "Statement 1 tax refund (not other income)";
    }
  }

  const stmt18Total = scanStatementLine18Total(ctx.allText);
  const compOcl = ctx.comparison?.values.other_current_liabilities;
  const schedLOcl = values.other_current_liabilities;
  const schedLSrc = fieldSources.other_current_liabilities ?? "";
  const fromScheduleL = /schedule\s+l/i.test(schedLSrc);
  const comparisonSaysZero = compOcl === 0;
  if (comparisonSaysZero && !fromScheduleL) {
    values.other_current_liabilities = 0;
    confidence.other_current_liabilities = Math.min(confidence.other_current_liabilities ?? 88, 88);
    fieldSources.other_current_liabilities = "Two-year comparison (no material other current liabilities)";
  } else if (stmt18Total !== undefined && stmt18Total >= 1) {
    const cur = values.other_current_liabilities;
    const src = fieldSources.other_current_liabilities ?? "";
    const schedLCorroborates =
      fromScheduleL &&
      schedLOcl !== undefined &&
      Math.round(schedLOcl) === Math.round(stmt18Total);
    const weak = !src || /comparison|tail scan|OCR label|fuzzy/i.test(src);
    if (
      schedLCorroborates &&
      (cur === undefined || (weak && Math.round(cur) !== Math.round(stmt18Total)))
    ) {
      values.other_current_liabilities = stmt18Total;
      confidence.other_current_liabilities = Math.min(confidence.other_current_liabilities ?? 82, 82);
      fieldSources.other_current_liabilities = "Statement (Line 18) total";
    } else if (cur === undefined && weak && stmt18Total >= 1) {
      values.other_current_liabilities = stmt18Total;
      confidence.other_current_liabilities = Math.min(confidence.other_current_liabilities ?? 82, 82);
      fieldSources.other_current_liabilities = "Statement (Line 18) total";
    }
  }

  const oclSrc = fieldSources.other_current_liabilities ?? "";
  if (
    values.other_current_liabilities !== undefined &&
    values.other_current_liabilities >= 5_000 &&
    /statement.*line\s*18|statement\s*5\s*total/i.test(oclSrc) &&
    !/schedule\s+l\s+line\s*18/i.test(oclSrc)
  ) {
    const slOcl = ctx.formAnchors.values.other_current_liabilities;
    if (slOcl === undefined || slOcl < 1_000) {
      values.other_current_liabilities = compOcl ?? 0;
      confidence.other_current_liabilities = Math.min(confidence.other_current_liabilities ?? 88, 88);
      fieldSources.other_current_liabilities =
        compOcl !== undefined
          ? "Two-year comparison (no material other current liabilities)"
          : "Cleared — Statement Line 18 without Schedule L corroboration";
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
    if (got === undefined || Math.round(got) !== Math.round(cogsPick.value)) {
      values.cogs = cogsPick.value;
      confidence.cogs = cogsPick.confidence;
      fieldSources.cogs = cogsPick.source;
    }
  }

  if (ctx.comparison?.values.depreciation !== undefined) {
    const comp = ctx.comparison.values.depreciation;
    const formDep = ctx.formAnchors.values.depreciation;
    const depSrc = fieldSources.depreciation ?? "";
    const keepReport = /NET\s+DEPRECIATION|depreciation report/i.test(depSrc);
    if (!keepReport) {
      if (
        formDep !== undefined &&
        formDep !== 0 &&
        (values.depreciation === undefined || Math.round(values.depreciation) !== Math.round(formDep)) &&
        !/comparison/i.test(depSrc)
      ) {
        values.depreciation = formDep;
        confidence.depreciation = ctx.formAnchors.confidence.depreciation ?? 97;
        fieldSources.depreciation = ctx.formAnchors.sources.depreciation ?? "Form depreciation";
      } else if (values.depreciation === undefined || isWeakSource(depSrc)) {
        values.depreciation = comp;
        confidence.depreciation = ctx.comparison.confidence.depreciation ?? 88;
        fieldSources.depreciation = "Two-year comparison (depreciation row)";
      }
    }
  }

  if (ctx.comparison?.values.taxes_licenses !== undefined && ctx.comparison.values.taxes_licenses >= 1) {
    const paid =
      values.taxes_paid ??
      ctx.comparison.values.taxes_paid ??
      extractStatementTaxesSplit(ctx.allText).values.taxes_paid;
    if (paid !== undefined && paid > 0 && paid < ctx.comparison.values.taxes_licenses) {
      const split = Math.round(ctx.comparison.values.taxes_licenses - paid);
      if (split >= 1) {
        values.taxes_licenses = split;
        confidence.taxes_licenses = 91;
        fieldSources.taxes_licenses = "Two-year comparison (taxes minus taxes paid)";
      }
    }
  }

  if (ctx.comparison?.values.rent !== undefined && ctx.comparison.values.rent >= 1) {
    const got = values.rent;
    const src = fieldSources.rent ?? "";
    const weak = !src || /OCR label|fuzzy|label match|embedded detail|tail scan/i.test(src);
    const stmtDeductionsPost = extractStatementDeductions(ctx.allText);
    const stmt2Rent = stmtDeductionsPost.values.rent;
    if (
      stmt2Rent !== undefined &&
      stmt2Rent >= 1 &&
      (got === undefined || Math.round(Math.abs(got)) !== Math.round(Math.abs(stmt2Rent)))
    ) {
      values.rent = stmt2Rent;
      confidence.rent = stmtDeductionsPost.confidence.rent ?? 93;
      fieldSources.rent = stmtDeductionsPost.sources.rent ?? "Statement 2 (rent detail)";
    } else if (
      (got === undefined || weak) &&
      !/statement\s*2|federal\s+statements|form\s+page/i.test(src)
    ) {
      values.rent = ctx.comparison.values.rent;
      confidence.rent = ctx.comparison.confidence.rent ?? 90;
      fieldSources.rent = "Two-year comparison (rent row)";
    }
  }

  const formRent = ctx.formAnchors.values.rent;
  // Prefer Form when current rent is a sales/COGS collision (column misread).
  if (
    values.rent !== undefined &&
    formRent !== undefined &&
    formRent >= 1 &&
    Math.round(formRent) !== Math.round(values.rent) &&
    (Math.round(values.rent) === Math.round(values.sales ?? NaN) ||
      (values.cogs !== undefined && Math.round(values.rent) === Math.round(values.cogs)))
  ) {
    values.rent = formRent;
    confidence.rent = ctx.formAnchors.confidence.rent ?? confidence.rent ?? 90;
    fieldSources.rent = ctx.formAnchors.sources.rent ?? "Form rent (replaced income misread)";
  }

  const stmtTaxFinal = extractStatementTaxesSplit(ctx.allText);
  if (stmtTaxFinal.values.taxes_licenses !== undefined && stmtTaxFinal.values.taxes_licenses >= 1) {
    const got = values.taxes_licenses;
    const src = fieldSources.taxes_licenses ?? "";
    const weak = !src || /OCR label|fuzzy|label match|embedded detail|tail scan/i.test(src);
    if (
      got === undefined ||
      weak ||
      Math.round(Math.abs(got)) !== Math.round(Math.abs(stmtTaxFinal.values.taxes_licenses))
    ) {
      values.taxes_licenses = stmtTaxFinal.values.taxes_licenses;
      confidence.taxes_licenses = stmtTaxFinal.confidence.taxes_licenses ?? 96;
      fieldSources.taxes_licenses =
        stmtTaxFinal.sources.taxes_licenses ?? "Statement taxes (payroll/licenses portion)";
    }
  }
  if (stmtTaxFinal.values.taxes_paid !== undefined && stmtTaxFinal.values.taxes_paid > 0) {
    if (values.taxes_paid === undefined || values.taxes_paid === 0) {
      values.taxes_paid = stmtTaxFinal.values.taxes_paid;
      confidence.taxes_paid = stmtTaxFinal.confidence.taxes_paid ?? 96;
      fieldSources.taxes_paid = stmtTaxFinal.sources.taxes_paid ?? "Statement taxes (income tax portion)";
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
    embOse > 0 &&
    /embedded schedule l \(paired-column\)/i.test(embOseSrc) &&
    (values.other_stock_equity === undefined ||
      values.other_stock_equity === 0 ||
      /two-year comparison/i.test(fieldSources.other_stock_equity ?? "") ||
      Math.round(values.other_stock_equity ?? 0) !== Math.round(embOse))
  ) {
    values.other_stock_equity = embOse;
    confidence.other_stock_equity = ctx.embeddedScheduleL.confidence.other_stock_equity ?? 95;
    fieldSources.other_stock_equity =
      embOseSrc || "Embedded Schedule L (other stock equity refill)";
  }

  if (values.interest_expense !== undefined && values.interest_expense > 0) {
    const trapped = values.interest_expense;
    const src = fieldSources.interest_expense ?? "";
    if (isInterestInstructionCrumb(trapped, src)) {
      delete values.interest_expense;
      delete confidence.interest_expense;
      delete fieldSources.interest_expense;
      warnings.push(`Cleared interest_expense=${trapped} (Form 8990 / §163(j) instruction crumb)`);
    } else if (trapped <= 999) {
      const lineRef = src.match(/\bline\s*(\d{1,3})\b/i);
      const isLineTrap =
        trapped <= 50 ||
        (lineRef !== null && trapped === Number(lineRef[1])) ||
        /^\s*\d{1,3}\s+interest/i.test(src);
      if (isLineTrap) {
        delete values.interest_expense;
        delete confidence.interest_expense;
        delete fieldSources.interest_expense;
        warnings.push(`Cleared interest_expense=${trapped} (Form line-number trap, post-verification)`);
      }
    }
  }

  if (
    values.depreciation !== undefined &&
    (values.depreciation === 1986 ||
      values.depreciation === 1987 ||
      /post[-\s]?1986/i.test(fieldSources.depreciation ?? ""))
  ) {
    delete values.depreciation;
    delete confidence.depreciation;
    delete fieldSources.depreciation;
    warnings.push("Cleared depreciation (Post-1986 adjustment OCR trap, post-verification)");
  } else {
    const compDep = scanComparisonIsExpense(ctx.allText, ctx.year, "depreciation");
    if (compDep?.value === 0 && values.depreciation !== undefined && values.depreciation > 0) {
      values.depreciation = 0;
      confidence.depreciation = compDep.confidence;
      fieldSources.depreciation = "Two-year comparison (DEPRECIATION row — zero current year)";
    }
  }

  const interestTrapLine = ctx.allText.split(/\n/).some((row) => {
    if (values.interest_expense === undefined || values.interest_expense < 100) return false;
    const ie = Math.round(values.interest_expense);
    const line = row.replace(/\s+/g, " ").trim();
    return new RegExp(`^\\W*${ie}\\s+interest`, "i").test(line) && !/expense/i.test(line);
  });
  if (interestTrapLine && values.interest_expense !== undefined) {
    const trapped = values.interest_expense;
    delete values.interest_expense;
    delete confidence.interest_expense;
    delete fieldSources.interest_expense;
    warnings.push(`Cleared interest_expense=${trapped} (form line-number OCR, post-verification)`);
  }

  if (
    values.other_operating_income !== undefined &&
    values.other_operating_income > 0 &&
    values.other_income !== undefined &&
    Math.round(values.other_income) === Math.round(values.other_operating_income)
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
    warnings,
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

  // Phase 2 raw pool — no label cleaning until extraction amount-coverage gate passes.
  const operatingExpenseLines = extractRawExpenseLinePool(ctx.allText, ctx.year);
  const opexApplied = applyOperatingExpensesToSingleYear({
    values,
    confidence,
    fieldSources,
    operatingExpenseLines,
  });
  Object.assign(values, opexApplied.values);
  Object.assign(confidence, opexApplied.confidence ?? {});
  Object.assign(fieldSources, opexApplied.fieldSources ?? {});

  // After top-8 slots are filled, reverse-solve other_opex from Form ordinary income.
  applyOrdinaryIncomeReverseOpex(post, ctx.allText, ctx.year);
  flagPnlIdentityMismatches(post, ctx.allText, ctx.year);

  applyConfidenceGates(post, { taxYear: ctx.year });

  const pnlReconciliation = reconcileTaxYear({
    values,
    confidence,
    fieldSources,
    sourceSnapshots: ctx.sourceSnapshots,
    taxYear: ctx.year,
    warnings,
  });

  const formOrdinaryBusinessIncome = scanFormOrdinaryBusinessIncome(ctx.allText, ctx.year);
  const formGrossProfit = scanFormGrossProfit(ctx.allText, ctx.year);

  return {
    ...verified,
    values,
    confidence,
    fieldSources,
    warnings,
    fieldFlags: { ...fieldFlagsOut, ...pnlReconciliation.fieldFlags },
    fieldStatus: { ...fieldStatus, ...pnlReconciliation.fieldStatus },
    displayConfidence: { ...displayConfidenceOut, ...pnlReconciliation.displayConfidence },
    sourceAgreement: pnlReconciliation.sourceAgreement,
    fieldTrustTier: { ...fieldTrustTier, ...pnlReconciliation.fieldTrustTier },
    fieldAlternates,
    fieldCandidateOptions,
    ocrCoverage,
    operatingExpenseLines: opexApplied.operatingExpenseLines ?? operatingExpenseLines,
    opexSlotLabels: opexApplied.opexSlotLabels,
    stmtOtherDeductionsTotal: scanReturnOtherDeductionsTotal(ctx.allText, ctx.year),
    formOrdinaryBusinessIncome,
    formGrossProfit,
  };
}
