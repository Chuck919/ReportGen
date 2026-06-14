import { parseFinancialTablesFromText, type YearSeries } from "@/lib/financial-text-parser";
import { parseTwoYearComparisonBlock } from "@/lib/two-year-comparison-parser";
import { TAX_WORKBOOK_ROWS, type TaxYearValues } from "@/lib/tax-workbook";
import { TAX_ATTACHMENT_FIELD_IDS } from "@/lib/workbook-comparison-fixtures";
import { extractForm1120Anchors, extractFormPage1Block } from "./form-anchors";
import { lineMoneyTokens, scheduleLineAmount, substantialMoneyTokens, isForm1120Line } from "./money";
import { inferTaxYear } from "./infer-year";
import { findHitsLineScoped, resolveHits } from "./line-hits";
import { pruneNoMatchWarnings, type ResolvedFields } from "./merge";
import { assembleExtractions } from "./parse-pipeline";
import {
  countStatement1DetailLines,
  extractStatementDeductions,
  extractStatementOtherIncome,
  statement1HasOtherIncomeDetailLine,
  statement1ReportsToWorkbookOtherIncome,
} from "./statement-extractors";

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

/** Parser-only path (no OCR) — used for fast regression with cached OCR text. */
export function parseTaxReturnFromText(
  filename: string,
  embeddedText: string,
  ocrText: string,
  yearOverride?: number,
): TaxYearValues & { fieldSources?: Record<string, string> } {
  const allText = `${embeddedText}\n${ocrText}`;
  const year =
    yearOverride && yearOverride >= 2000 && yearOverride <= 2100
      ? yearOverride
      : inferTaxYear(filename, allText);
  if (!year) throw new Error("Could not determine tax year from document text.");

  const structured = tryStructuredTable(allText);
  if (structured && Object.keys(structured.values).length >= 12) {
    return {
      year,
      values: structured.values,
      confidence: structured.confidence,
      fieldSources: structured.sources,
      warnings: [],
      source: "embedded-financial-table",
    };
  }

  const comparison = parseTwoYearComparisonBlock(allText, year);
  const formAnchors = extractForm1120Anchors(allText);
  const stmtDeductions = extractStatementDeductions(allText);
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
  if (comparison && comparison.linesMatched >= 5) {
    tiers.push({
      name: "comparison",
      extraction: { values: comparison.values, confidence: comparison.confidence, sources: compSources },
      minConfidence: 84,
    });
  }
  tiers.push({ name: "statements", extraction: stmtDeductions, minConfidence: 88, onlyIds: attachmentIds });
  tiers.push({ name: "form-anchors", extraction: formAnchors, minConfidence: 0 });

  const resolved: ResolvedFields = assembleExtractions(tiers);
  pruneNoMatchWarnings(resolved, new Set(Object.keys(resolved.values)));

  const stmtIncome = extractStatementOtherIncome(allText);
  const formOi = formAnchors.values.other_income;
  const formPage1 = extractFormPage1Block(allText);
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
  if (line5UsesStmt && compOi === undefined) {
    if (
      !stmtOiDetail &&
      stmtMatchesForm &&
      stmtTotal !== undefined &&
      stmt1Lines >= 2 &&
      statement1ReportsToWorkbookOtherIncome(allText)
    ) {
      resolved.values.other_income = Math.round(stmtTotal);
      resolved.confidence.other_income = 94;
      resolved.sources.other_income = "Statement 1 total (matches Form line 5)";
    } else {
      resolved.values.other_income = 0;
      resolved.confidence.other_income = 93;
      resolved.sources.other_income = "Form 1120-S line 5 (Stmt 1 multi-line; summary zero)";
    }
    otherIncomeResolved = true;
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
    resolved.values.other_income = formOi;
    resolved.confidence.other_income = formAnchors.confidence.other_income ?? 97;
    resolved.sources.other_income = formAnchors.sources.other_income ?? "Form 1120-S line 5";
    otherIncomeResolved = true;
  }
  if (!otherIncomeResolved && stmtTotal !== undefined) {
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
    ] as const) {
      if (resolved.values[id] === undefined && comparison.values[id] !== undefined) {
        resolved.values[id] = comparison.values[id];
        resolved.confidence[id] = comparison.confidence[id] ?? 86;
        resolved.sources[id] = "Two-year comparison";
      }
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

  return {
    year,
    values: resolved.values,
    confidence: resolved.confidence,
    fieldSources: resolved.sources,
    warnings: resolved.warnings,
    source: "free-local-ocr:tesseract.js",
  };
}
