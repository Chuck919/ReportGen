import { computeWorkbookFormulas } from "@/lib/tax/workbook-formulas";
import type { TaxYearValues } from "@/lib/tax-workbook";
import type { ValuationInputDraft } from "@/lib/valuation/defaults";
import { buildBalanceSheetFootnotes, type BalanceSheetFootnotes } from "@/lib/valuation/balance-sheet-footnotes";
import type { CompanyProfile } from "@/lib/valuation/company-profile";
import { buildIncomeStatementNarrativeFields } from "@/lib/valuation/financial-narrative-merge";
import { deriveEntityAbbreviation } from "@/lib/valuation/integrator-workbook";
import type { ValuationReport } from "@/lib/valuation/types";

export type WordMergeEngagement = {
  city?: string;
  title?: string;
  company?: string;
  owner?: string;
  entityCity?: string;
  engagingPartyDate?: string;
  compDescription?: string;
  transactionLanguage?: string;
  transactionTypeLanguage?: string;
  companyProfile?: CompanyProfile;
  balanceSheetFootnotes?: BalanceSheetFootnotes;
};

export type WordMergeContext = {
  report: ValuationReport;
  columns: TaxYearValues[];
  valuationInputs?: Partial<ValuationInputDraft>;
  engagement?: WordMergeEngagement;
};

function money(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(
    value,
  );
}

function moneyOrZero(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return money(value);
}

function moneyPlain(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return Math.round(value).toLocaleString("en-US");
}

function pct(value: number | undefined, digits = 2): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return `${(value * 100).toFixed(digits)}%`;
}

function formatLongDate(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso.includes("T") ? iso : `${iso}T12:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function yearValues(column: TaxYearValues): Record<string, number> {
  return column.workbookValues ?? column.values;
}

function computed(column: TaxYearValues) {
  return computeWorkbookFormulas(yearValues(column));
}

function sortedYears(columns: TaxYearValues[]): TaxYearValues[] {
  return [...columns].sort((a, b) => a.year - b.year);
}

function yearSlot(columns: TaxYearValues[], offsetFromLatest: number): TaxYearValues | undefined {
  const sorted = sortedYears(columns);
  const index = sorted.length - 1 - offsetFromLatest;
  return index >= 0 ? sorted[index] : undefined;
}

function pickParagraph(report: ValuationReport, blockId: string): string {
  for (const section of report.sections) {
    for (const block of section.blocks) {
      if (block.kind === "paragraph" && block.id === blockId) return block.content;
    }
  }
  return "";
}

function pickListText(report: ValuationReport, blockId: string): string {
  for (const section of report.sections) {
    for (const block of section.blocks) {
      if (block.kind === "list" && block.id === blockId) {
        return block.items.filter(Boolean).join("\n\n");
      }
    }
  }
  return "";
}

function proseFromReport(report: ValuationReport): {
  companyDescription: string;
  economicImplications: string;
  financialObservations: string;
  assignmentSummary: string;
  conclusion: string;
} {
  return {
    companyDescription: pickParagraph(report, "company-description"),
    economicImplications: pickListText(report, "implications"),
    financialObservations: pickListText(report, "financial-observations"),
    assignmentSummary: pickParagraph(report, "assignment-summary"),
    conclusion: pickParagraph(report, "conclusion"),
  };
}

/** All «MERGEFIELD» / {placeholder} keys for Main Current + simple templates. */
export function buildWordMergeData(context: WordMergeContext): Record<string, string> {
  const { report, columns, valuationInputs, engagement } = context;
  const { valuation } = report;
  const latest = yearSlot(columns, 0);
  const latestComp = latest ? computed(latest) : {};

  const equityWeight = valuationInputs?.equityWeight ?? 0.45;
  const costOfDebt = valuationInputs?.costOfDebt ?? 0.095;
  const taxRate = valuationInputs?.taxRate ?? 0.26;
  const workingCapital = valuationInputs?.workingCapitalAdjustment ?? 15_000;
  const capex = valuationInputs?.capexAdjustment ?? 10_000;

  const wacc =
    equityWeight * valuation.capitalizationRate + (1 - equityWeight) * costOfDebt * (1 - taxRate);
  const benefitStream = valuation.normalizedEarnings - workingCapital - capex;

  const years = sortedYears(columns);
  const revBeg = years[0]?.year;
  const revEnd = years[years.length - 1]?.year;

  const currentAssets =
    (latestComp.cash ?? 0) +
    (latestComp.accounts_receivable ?? 0) +
    (latestComp.inventory ?? 0) +
    (latestComp.other_current_assets ?? 0);
  const currentLiabilities = latestComp.total_current_liabilities ?? 0;
  const totalAssets = latestComp.total_assets ?? 0;
  const totalEquity = latestComp.total_equity ?? 0;
  const totalLiabilities = latestComp.total_liabilities ?? 0;
  const currentRatio = currentLiabilities > 0 ? currentAssets / currentLiabilities : 0;
  const quickRatio =
    currentLiabilities > 0
      ? ((latestComp.cash ?? 0) + (latestComp.accounts_receivable ?? 0)) / currentLiabilities
      : 0;
  const roa = totalAssets > 0 ? (latestComp.net_profit_before_taxes ?? 0) / totalAssets : 0;
  const roe = totalEquity > 0 ? (latestComp.net_profit_before_taxes ?? 0) / totalEquity : 0;

  const prose = proseFromReport(report);
  const isNarrative = buildIncomeStatementNarrativeFields(columns, report.naics);
  const footnotes =
    engagement?.balanceSheetFootnotes ?? buildBalanceSheetFootnotes(columns, engagement?.companyProfile);
  const profile = engagement?.companyProfile;

  const compDescription =
    engagement?.compDescription?.trim() ||
    prose.companyDescription ||
    `${report.entityName} operates in ${report.naicsTitle ?? "its industry"} based on uploaded tax returns.`;

  const economicNarrative =
    prose.economicImplications ||
    `Economic context for ${report.msaLabel ?? "the subject market"} should be reviewed against national indicators cited in the report.`;

  const transactionLanguage =
    engagement?.transactionLanguage?.trim() ||
    "The subject interest is a 100% non-controlling equity interest in a closely held company.";

  const transactionTypeLanguage =
    engagement?.transactionTypeLanguage?.trim() || "The transaction has been presented as an asset sale.";

  const financialNarrative =
    prose.financialObservations ||
    `Historical performance is based on ${years.length} year(s) of parsed tax return data through ${revEnd ?? "the valuation date"}.`;

  const conclusionText =
    prose.conclusion ||
    `${report.entityName} has a draft reconciled value of ${money(valuation.reconciledValue)}.`;

  const incomeMethod = valuation.methods.find((row) => row.method === "income");
  const assetMethod = valuation.methods.find((row) => row.method === "asset");
  const marketMethod = valuation.methods.find((row) => row.method === "market");

  const data: Record<string, string> = {
    // Cover / engagement (premerge «field» names)
    entity: report.entityName,
    abbreviation: report.abbreviation ?? deriveEntityAbbreviation(report.entityName),
    valuation_date: formatLongDate(report.valuationDate),
    date_of_issuance: formatLongDate(report.dateOfIssuance),
    engaging_party: report.engagingParty ?? "",
    engaging_party_date: formatLongDate(engagement?.engagingPartyDate ?? report.dateOfIssuance),
    title: engagement?.title ?? "",
    company: engagement?.company ?? report.engagingParty ?? "",
    city: engagement?.city ?? "",
    entity_city: engagement?.entityCity ?? engagement?.city ?? "",
    purpose: report.purpose,
    owner: engagement?.owner ?? profile?.ownerName ?? "",
    metro: report.msaLabel ?? "",
    NAICS: report.naics ?? "",
    NAICS_Desc: report.naicsTitle ?? "",
    comp_description: compDescription,
    period_of_review_beg: revBeg ? `January 1, ${revBeg}` : "",
    rev_beg: revBeg ? String(revBeg) : "",
    rev_end: revEnd ? String(revEnd) : "",
    DS_years: years.map((y) => String(y.year)).join(", "),
    DS_trans: years.length ? `${years.length}-year` : "",

    // Valuation results
    reconciled_value: money(valuation.reconciledValue),
    income_value: money(incomeMethod?.adjustedValue ?? valuation.incomeValue),
    asset_method_value: money(assetMethod?.adjustedValue ?? valuation.assetValue),
    market_value: marketMethod ? money(marketMethod.adjustedValue) : money(valuation.marketValue),
    assets_: money(valuation.tangibleAssetValue),
    goodwill: money(valuation.intangibleValue),
    cap_rate: pct(valuation.capitalizationRate),
    benefit_stream: money(benefitStream),
    WACC: pct(wacc),
    WACC_Equity_: pct(valuation.capitalizationRate),
    WACC_Debt_: pct(costOfDebt),
    WACC_Cost_of_Debt: pct(costOfDebt),
    WACC_Tax_Rate: pct(taxRate),
    work_cap: money(workingCapital),
    capex: money(capex),
    cash_adjust: money(workingCapital),

    // Balance sheet (latest year)
    BS_Cash: moneyOrZero(latestComp.cash),
    BS_Receivables: moneyOrZero(latestComp.accounts_receivable),
    BS_Inventory: moneyOrZero(latestComp.inventory),
    BS_Current_Assets: moneyOrZero(latestComp.total_current_assets ?? currentAssets),
    BS_Fixed_Assets: moneyOrZero(latestComp.net_fixed_assets),
    BS_Current_Liabilities: moneyOrZero(latestComp.total_current_liabilities),
    BS_Longterm_Liabilities: moneyOrZero(latestComp.long_term_liabilities),
    BS_Total_Liabilities: money(totalLiabilities),
    BS_Total_Equity: money(totalEquity),
    BS_Normalization_Summary:
      `Normalized book equity of ${moneyOrZero(totalEquity)} reflects tax-return balance sheet data as of ${revEnd ?? "the valuation date"}. Analyst should confirm working-capital and debt adjustments per engagement workbook.`,
    Company_Equity: money(totalEquity),
    Company_Debt: money((latestComp.short_term_debt ?? 0) + (latestComp.long_term_liabilities ?? 0)),
    Bench_Equity: money(totalEquity),
    Bench_Debt: money((latestComp.short_term_debt ?? 0) + (latestComp.long_term_liabilities ?? 0)),

    // Ratios
    Current_Ratio: currentRatio > 0 ? currentRatio.toFixed(2) : "",
    Quick_Ratio: quickRatio > 0 ? quickRatio.toFixed(2) : "",
    Return_on_Assets: roa !== 0 ? pct(roa) : "",
    Return_on_Equity: roe !== 0 ? pct(roe) : "",

    // Income statement — benchmark-aware narrative bullets (rule-based, not Groq)
    ...isNarrative,
    avg_deprec: moneyPlain(
      years.length
        ? Math.round(
            years.reduce((sum, col) => sum + (yearValues(col).depreciation ?? 0), 0) / years.length,
          )
        : undefined,
    ),

    // Narrative — Groq/session prose mapped into template merge fields
    Transaction_Language: transactionLanguage,
    Transaction_Type_Language: transactionTypeLanguage,
    Ideal_Rate_Lang:
      pickParagraph(report, "ideal-rate-language") ||
      `The indicated capitalization rate is ${pct(valuation.capitalizationRate)} based on the build-up method applied to normalized earnings of ${money(valuation.normalizedEarnings)}.`,
    MVIC_Verbiage: conclusionText,
    Market_Difference:
      valuation.marketValue !== undefined
        ? money(valuation.marketValue - valuation.reconciledValue)
        : "",
    ahead_behind: [economicNarrative, financialNarrative].filter(Boolean).join("\n\n"),

    // Org — from user profile + optional Filed.dev lookup at generate time
    org_entity: report.entityName,
    org_name_of_file: report.entityName,
    org_state: profile?.entityState ?? "",
    org_status: "Active",
    org_date: profile?.entityFormationDate ? formatLongDate(profile.entityFormationDate) : "",
    org_file_number: profile?.entityFileNumber ?? "",

    // Balance sheet footnotes — rule-based from tax data
    ...footnotes,

    // Brace-style aliases (simple user template)
    entityName: report.entityName,
    valuationDate: report.valuationDate,
    dateOfIssuance: report.dateOfIssuance,
    engagingParty: report.engagingParty ?? "",
    naics: report.naics ?? "",
    naicsTitle: report.naicsTitle ?? "",
    msaLabel: report.msaLabel ?? "",
    taxYears: report.taxYears.join(", "),
    reconciledValue: money(valuation.reconciledValue),
    incomeValue: money(valuation.incomeValue),
    assetValue: money(valuation.assetValue),
    tangibleAssetValue: money(valuation.tangibleAssetValue),
    intangibleValue: money(valuation.intangibleValue),
    capitalizationRate: pct(valuation.capitalizationRate),
    normalizedEarnings: money(valuation.normalizedEarnings),
    conclusion: conclusionText,
    // Brace-style prose keys for user-uploaded custom templates
    company_description: compDescription,
    companyDescription: compDescription,
    economic_implications: economicNarrative,
    economicImplications: economicNarrative,
    financial_observations: financialNarrative,
    financialObservations: financialNarrative,
    assignment_summary: prose.assignmentSummary,
    assignmentSummary: prose.assignmentSummary,
  };

  return data;
}

/** Known Main Current merge fields — used for coverage checks in tests. */
export const PREMERGE_MERGE_FIELD_NAMES = [
  "entity",
  "valuation_date",
  "date_of_issuance",
  "engaging_party",
  "reconciled_value",
  "income_value",
  "asset_method_value",
  "market_value",
  "WACC",
  "cap_rate",
  "benefit_stream",
  "goodwill",
  "NAICS",
  "NAICS_Desc",
  "BS_Cash",
  "BS_Total_Equity",
  "IS_Rev",
  "IS_COGS",
  "IS_NIEBITDA_CY",
  "comp_description",
] as const;
