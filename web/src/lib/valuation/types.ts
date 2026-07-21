import type { AssumptionFieldSource } from "@/lib/valuation/assumption-sources";
import type { BenchmarkEntryRow } from "@/lib/benchmark-entry";
import type { TaxYearValues } from "@/lib/tax-workbook";
import type { CompanyProfile } from "@/lib/valuation/company-profile";
import type { BalanceSheetFootnotes } from "@/lib/valuation/balance-sheet-footnotes";

export type SourceTag = {
  label: string;
  url?: string;
  detail?: string;
};

export type ValuationFormulaStep = {
  id: string;
  label: string;
  expression: string;
  substitution: string;
  result: string;
  resultNumeric?: number;
  source?: AssumptionFieldSource;
};

export type ReportBlock =
  | {
      kind: "cover";
      id: string;
      title: string;
      svg: string;
      subtitle?: string;
    }
  | {
      kind: "paragraph";
      id: string;
      title?: string;
      content: string;
      sources?: SourceTag[];
      review?: boolean;
    }
  | {
      kind: "table";
      id: string;
      title: string;
      columns: string[];
      rows: string[][];
      sources?: SourceTag[];
    }
  | {
      kind: "chart";
      id: string;
      title: string;
      svg: string;
      sources?: SourceTag[];
    }
  | {
      kind: "formula";
      id: string;
      title: string;
      steps: ValuationFormulaStep[];
    }
  | {
      kind: "list";
      id: string;
      title?: string;
      items: string[];
      sources?: SourceTag[];
      review?: boolean;
    };

export type ReportSection = {
  id: string;
  title: string;
  blocks: ReportBlock[];
};

export type MacroSeriesPoint = {
  date: string;
  value: number;
};

export type MacroSeries = {
  label: string;
  seriesId: string;
  points: MacroSeriesPoint[];
  unit?: string;
  source: SourceTag;
};

export type MacroMetric = {
  label: string;
  value: string;
  source: SourceTag;
};

export type MacroSnapshot = {
  areaLabel: string;
  metrics: MacroMetric[];
  observations: string[];
  charts: Array<{
    id: string;
    title: string;
    series: MacroSeries;
  }>;
};

export type NaicsBenchmarkProfile = {
  naics: string;
  title: string;
  benchmarkRows: BenchmarkEntryRow[];
  narrative: string[];
  sources: SourceTag[];
};

export type MarketMultipleMetric = {
  name: "ev_revenue" | "ev_ebitda" | "sde";
  multiple: number;
  impliedValue: number;
  sampleSize?: number;
};

export type MarketMultiplesProfile = {
  vertical: string;
  bracket: string;
  metrics: MarketMultipleMetric[];
  source: SourceTag;
};

export type ValuationAssumptions = {
  riskFreeRate: number;
  equityRiskPremium: number;
  sizePremium: number;
  companySpecificRisk: number;
  longTermGrowthRate: number;
  dlomRate: number;
  incomeWeight: number;
  assetWeight: number;
  marketWeight: number;
};

export type ValuationInputDraft = ValuationAssumptions & {
  normalizedEarnings: number;
  preTaxNetIncomeCapRate?: number;
  assetIndicatedValue?: number;
  workingCapitalAdjustment?: number;
  capexAdjustment?: number;
  equityWeight?: number;
  costOfDebt?: number;
  taxRate?: number;
  companyContext: string;
  fieldSources: Record<string, AssumptionFieldSource>;
};

export type ValuationMethodRow = {
  method: "asset" | "income" | "market";
  label: string;
  indicatedValue: number;
  dlomRate: number;
  adjustedValue: number;
  weight: number;
};

export type ValuationMath = {
  latestYear: number;
  normalizedEarnings: number;
  capitalizationRate: number;
  assetValue: number;
  incomeValue: number;
  marketValue?: number;
  reconciledValue: number;
  tangibleAssetValue: number;
  intangibleValue: number;
  methods: ValuationMethodRow[];
  assumptions: ValuationAssumptions;
  sources: SourceTag[];
  /** Full formula audit trail — every step shown to the user. */
  formulas: ValuationFormulaStep[];
};

export type ValuationChecklistItem = {
  id: string;
  label: string;
  pass: boolean;
  detail?: string;
};

export type ValuationReport = {
  entityName: string;
  abbreviation?: string;
  valuationDate: string;
  dateOfIssuance: string;
  purpose: string;
  engagingParty?: string;
  naics?: string;
  naicsTitle?: string;
  msaLabel?: string;
  taxYears: number[];
  sections: ReportSection[];
  sources: SourceTag[];
  checklist: ValuationChecklistItem[];
  valuation: ValuationMath;
};

export type GenerateValuationRequest = {
  columns: TaxYearValues[];
  entityName?: string;
  engagingParty?: string;
  purpose?: string;
  naics?: string;
  msaLabel?: string;
  cbsaCode?: string;
  zipCode?: string;
  useGroq?: boolean;
  /** Analyst notes — merged with company profile for AI narrative. */
  companyContext?: string;
  companyProfile?: CompanyProfile;
  balanceSheetFootnotes?: BalanceSheetFootnotes;
  sbaMarketBullets?: string[];
  /** Report issuance date (ISO or long-form). Defaults to today. */
  dateOfIssuance?: string;
  /** Valuation assumptions from tax inference + user edits. */
  valuationAssumptions?: Partial<ValuationAssumptions> & {
    /** Prefer using the pre-tax net income capitalization rate when provided. */
    preTaxNetIncomeCapRate?: number;
    /** Adjusted/normalized earnings figure. */
    normalizedEarnings?: number;
    /** Raw adjusted net assets before DLOM. */
    assetIndicatedValue?: number;
    workingCapitalAdjustment?: number;
    capexAdjustment?: number;
    equityWeight?: number;
    costOfDebt?: number;
    taxRate?: number;
    fieldSources?: Record<string, import("@/lib/valuation/assumption-sources").AssumptionFieldSource>;
  };
  /** @deprecated Use valuationAssumptions */
  excelAssumptions?: GenerateValuationRequest["valuationAssumptions"];
  customAssumptions?: Partial<ValuationAssumptions>;
};

export type GenerateValuationResponse = {
  report: ValuationReport;
  benchmark: NaicsBenchmarkProfile;
  market: MarketMultiplesProfile;
  macro: {
    national: MacroSnapshot;
    msa: MacroSnapshot;
  };
  logs?: string[];
};
