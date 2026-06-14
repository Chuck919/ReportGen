import type { ParsedFinancialPdf } from "./financial-text-parser";
import { formatPercentDisplay, r2 } from "./benchmark-format";

export type BenchmarkEntryRow = {
  section: "Income Statement" | "Balance Sheet" | "Metrics";
  label: string;
  /** Display: percents like `41%`, ratios like `4.55`. */
  value: string;
  source: "computed" | "scorecard" | "industry-common-size" | "na";
  formula?: string;
};

function pctRatio(num: number, den: number): string {
  if (!den) return "";
  return formatPercentDisplay(num / den);
}

function latest<T extends readonly [number, number, number]>(t: T | undefined): number {
  return t?.[2] ?? 0;
}

/** Map `industryCommonSize` fact keys → Benchmark Entry row (exact label). */
const INDUSTRY_CS_FACT_TO_LABEL: Record<string, { section: BenchmarkEntryRow["section"]; label: string }> = {
  cogs: { section: "Income Statement", label: "COGS" },
  cogs_detail_total: { section: "Income Statement", label: "COGS" },
  ga_payroll: { section: "Income Statement", label: "G&A Wages" },
  rent: { section: "Income Statement", label: "Rent Expenses" },
  ebitda: { section: "Income Statement", label: "EBITDA" },
  net_income: { section: "Income Statement", label: "Net Income" },
  cash: { section: "Balance Sheet", label: "Cash" },
  ar: { section: "Balance Sheet", label: "Receivables" },
  inventory: { section: "Balance Sheet", label: "Inventory" },
  tca: { section: "Balance Sheet", label: "Current Assets" },
  net_fixed: { section: "Balance Sheet", label: "Fixed Assets" },
  gross_fixed: { section: "Balance Sheet", label: "Gross" },
  acc_dep: { section: "Balance Sheet", label: "Accumulated Depreciation" },
  depreciation_is: { section: "Income Statement", label: "Depreciation" },
  amortization_is: { section: "Income Statement", label: "Amortization" },
  overhead_sga: { section: "Income Statement", label: "Overhead or SG&A" },
  advertising: { section: "Income Statement", label: "Advertising" },
  other_operating_expenses: { section: "Income Statement", label: "Other Operating Expenses" },
  operating_profit: { section: "Income Statement", label: "Operating Profit" },
  interest_expense: { section: "Income Statement", label: "Interest" },
  gross_intangible: { section: "Balance Sheet", label: "Gross intangible" },
  acc_amortization: { section: "Balance Sheet", label: "Less amortization" },
  ap: { section: "Balance Sheet", label: "Accounts Payable" },
  std: { section: "Balance Sheet", label: "Short Term Debt" },
  cpltd: { section: "Balance Sheet", label: "Current Portion" },
  other_cl: { section: "Balance Sheet", label: "Other Current" },
  total_equity: { section: "Balance Sheet", label: "Equity" },
};

function applyIndustryCommonSize(rows: BenchmarkEntryRow[], ics: Record<string, number> | undefined): void {
  if (!ics || !Object.keys(ics).length) return;

  const paint = (section: BenchmarkEntryRow["section"], labels: string[], ratio: number) => {
    for (const row of rows) {
      if (row.section === section && labels.includes(row.label)) {
        row.value = formatPercentDisplay(ratio);
        row.source = "industry-common-size";
        row.formula = "Industry column (common-size % from PDF)";
      }
    }
  };

  for (const [rawKey, ratio] of Object.entries(ics)) {
    const baseKey = rawKey.replace(/_pctdup$/, "").replace(/_il$/, "");
    if (baseKey === "tltl") {
      paint("Balance Sheet", ["Long-term Liabilities", "Long Term Liabilities"], ratio);
      continue;
    }
    if (baseKey === "tcl") {
      paint("Balance Sheet", ["Current Liabilities", "Total Current"], ratio);
      continue;
    }
    const hit = INDUSTRY_CS_FACT_TO_LABEL[baseKey];
    if (!hit) continue;
    paint(hit.section, [hit.label], ratio);
  }
}

/**
 * Benchmark Entry rows: dollar-based common-size as %, metrics as ratios / %,
 * overridden by **industry** column from common-size % tables when present.
 */
export function buildBenchmarkEntryRows(p: ParsedFinancialPdf): BenchmarkEntryRow[] {
  const f = p.facts;
  const sales = latest(f.sales) || 0;
  const ta = latest(f.total_assets) || 0;
  const tca = latest(f.tca) || 0;
  const tcl = latest(f.tcl) || 0;
  const cash = latest(f.cash) || 0;
  const ar = latest(f.ar) || 0;
  const inv = latest(f.inventory) || 0;
  const ni = latest(f.net_income) || latest(f.net_profit_before_tax) || 0;
  const eq =
    latest(f.total_equity) || latest(f.unclassified_equity) || latest(f.equity_other) || 0;
  const ebitda = latest(f.ebitda) || 0;
  const ga = latest(f.ga_payroll) || 0;
  const rent = latest(f.rent) || 0;
  const cogs = latest(f.cogs) || 0;
  const depIs = latest(f.depreciation_is) || 0;
  const amort = latest(f.amortization_is) || 0;
  const oh = latest(f.overhead_sga) || 0;
  const adv = latest(f.advertising) || 0;
  const ooe = latest(f.other_operating_expenses) || 0;
  const op = latest(f.operating_profit) || 0;
  const interest = latest(f.interest_expense) || 0;
  const ap = latest(f.ap) || 0;
  const std = latest(f.std) || 0;
  const cpltd = latest(f.cpltd) || 0;
  const ocl = latest(f.other_cl) || 0;
  const tclTotal = latest(f.tcl) || tcl;
  const tltl = latest(f.tltl) || 0;
  const grossFixed = latest(f.gross_fixed) || 0;
  const accDep = latest(f.acc_dep) || 0;
  const grossInt = latest(f.gross_intangible) || 0;
  const accAmort = latest(f.acc_amortization) || 0;

  const rows: BenchmarkEntryRow[] = [];

  rows.push(
    { section: "Income Statement", label: "COGS", value: pctRatio(cogs, sales), source: "computed", formula: "Cost of Sales / Sales" },
    { section: "Income Statement", label: "G&A Wages", value: pctRatio(ga, sales), source: "computed", formula: "G&A Payroll / Sales" },
    { section: "Income Statement", label: "Rent Expenses", value: pctRatio(rent, sales), source: "computed", formula: "Rent / Sales" },
    { section: "Income Statement", label: "EBITDA", value: pctRatio(ebitda, sales), source: "computed", formula: "EBITDA / Sales" },
    { section: "Income Statement", label: "Net Income", value: pctRatio(ni, sales), source: "computed", formula: "Net Income / Sales" },
  );

  rows.push(
    { section: "Balance Sheet", label: "Cash", value: pctRatio(cash, ta), source: "computed", formula: "Cash / Total Assets" },
    { section: "Balance Sheet", label: "Receivables", value: pctRatio(ar, ta), source: "computed", formula: "A/R / Total Assets" },
    { section: "Balance Sheet", label: "Inventory", value: pctRatio(inv, ta), source: "computed", formula: "Inventory / Total Assets" },
    { section: "Balance Sheet", label: "Current Assets", value: pctRatio(tca, ta), source: "computed", formula: "Total Current Assets / Total Assets" },
    { section: "Balance Sheet", label: "Fixed Assets", value: pctRatio(latest(f.net_fixed), ta), source: "computed", formula: "Net Fixed Assets / Total Assets" },
    { section: "Balance Sheet", label: "Gross", value: pctRatio(grossFixed, ta), source: "computed", formula: "Gross Fixed Assets / Total Assets" },
    { section: "Balance Sheet", label: "Accumulated Depreciation", value: pctRatio(accDep, ta), source: "computed", formula: "Accumulated Depreciation / Total Assets" },
    { section: "Balance Sheet", label: "Current Liabilities", value: pctRatio(latest(f.tcl), ta), source: "computed", formula: "Total Current Liabilities / Total Assets" },
    { section: "Balance Sheet", label: "Long-term Liabilities", value: pctRatio(tltl, ta), source: "computed", formula: "Total LT Liabilities / Total Assets" },
  );

  const sc = p.scorecard;

  const crIndustry = sc.currentRatioIndustryMid;
  const crCompany = tclTotal && tca ? tca / tclTotal : undefined;
  const crScorecardCompany = sc.currentRatio;
  const crDisplay =
    crIndustry !== undefined ? crIndustry : crCompany !== undefined ? crCompany : crScorecardCompany;
  const crSource: BenchmarkEntryRow["source"] =
    crIndustry !== undefined ? "scorecard" : crCompany !== undefined ? "computed" : "scorecard";
  const crFormula =
    crIndustry !== undefined
      ? "Industry Scorecard — benchmark ratio (second figure) or midpoint of low–high range"
      : "Total Current Assets / Total Current Liabilities";

  const qrIndustry = sc.quickRatioIndustryMid;
  const qrCompany = tclTotal && cash + ar ? (cash + ar) / tclTotal : undefined;
  const qrScorecardCompany = sc.quickRatio;
  const qrDisplay =
    qrIndustry !== undefined ? qrIndustry : qrCompany !== undefined ? qrCompany : qrScorecardCompany;
  const qrSource: BenchmarkEntryRow["source"] =
    qrIndustry !== undefined ? "scorecard" : qrCompany !== undefined ? "computed" : "scorecard";
  const qrFormula =
    qrIndustry !== undefined
      ? "Industry Scorecard — benchmark ratio (second figure) or midpoint of low–high range"
      : "(Cash + A/R) / Total Current Liabilities";

  const roeIndustryPct = sc.returnOnEquityIndustryPct;
  const roeRatio = eq && ni ? ni / eq : undefined;
  const roeScorecardOne = sc.returnOnEquityPct;
  const roeDisplay =
    roeIndustryPct !== undefined
      ? `${roeIndustryPct}%`
      : roeRatio !== undefined
        ? formatPercentDisplay(roeRatio)
        : roeScorecardOne !== undefined
          ? `${roeScorecardOne}%`
          : "";
  const roeSource: BenchmarkEntryRow["source"] =
    roeIndustryPct !== undefined ? "scorecard" : roeRatio !== undefined ? "computed" : "scorecard";
  const roeFormula =
    roeIndustryPct !== undefined
      ? "Industry Scorecard — second % (industry) when two values appear"
      : "Net Income / Total Equity";

  const roaIndustryPct = sc.returnOnAssetsIndustryPct;
  const roaRatio = ta && ni ? ni / ta : undefined;
  const roaScorecardOne = sc.returnOnAssetsPct;
  const roaDisplay =
    roaIndustryPct !== undefined
      ? `${roaIndustryPct}%`
      : roaRatio !== undefined
        ? formatPercentDisplay(roaRatio)
        : roaScorecardOne !== undefined
          ? `${roaScorecardOne}%`
          : "";
  const roaSource: BenchmarkEntryRow["source"] =
    roaIndustryPct !== undefined ? "scorecard" : roaRatio !== undefined ? "computed" : "scorecard";
  const roaFormula =
    roaIndustryPct !== undefined
      ? "Industry Scorecard — second % (industry) when two values appear"
      : "Net Income / Total Assets";

  rows.push(
    {
      section: "Metrics",
      label: "Current Ratio",
      value: crDisplay !== undefined ? r2(crDisplay) : "",
      source: crSource,
      formula: crFormula,
    },
    {
      section: "Metrics",
      label: "Quick Ratio",
      value: qrDisplay !== undefined ? r2(qrDisplay) : "",
      source: qrSource,
      formula: qrFormula,
    },
    {
      section: "Metrics",
      label: "Return on Equity",
      value: roeDisplay,
      source: roeSource,
      formula: roeFormula,
    },
    {
      section: "Metrics",
      label: "Return on Assets",
      value: roaDisplay,
      source: roaSource,
      formula: roaFormula,
    },
  );

  rows.push(
    { section: "Income Statement", label: "Depreciation", value: pctRatio(depIs, sales), source: "computed", formula: "Depreciation (I/S) / Sales" },
    { section: "Income Statement", label: "Amortization", value: pctRatio(amort, sales), source: "computed", formula: "Amortization / Sales" },
    { section: "Income Statement", label: "Overhead or SG&A", value: pctRatio(oh, sales), source: "computed", formula: "Overhead / Sales" },
    { section: "Income Statement", label: "Advertising", value: pctRatio(adv, sales), source: "computed", formula: "Advertising / Sales" },
    { section: "Income Statement", label: "Other Operating Expenses", value: pctRatio(ooe, sales), source: "computed", formula: "Other OpEx / Sales" },
    { section: "Income Statement", label: "Operating Profit", value: pctRatio(op, sales), source: "computed", formula: "Operating Profit / Sales" },
    { section: "Income Statement", label: "Interest", value: pctRatio(interest, sales), source: "computed", formula: "Interest / Sales" },
  );

  rows.push(
    { section: "Balance Sheet", label: "Gross intangible", value: pctRatio(grossInt, ta), source: "computed", formula: "Gross Intangibles / Total Assets" },
    { section: "Balance Sheet", label: "Less amortization", value: pctRatio(accAmort, ta), source: "computed", formula: "Accumulated Amortization / Total Assets" },
    { section: "Balance Sheet", label: "Accounts Payable", value: pctRatio(ap, ta), source: "computed", formula: "A/P / Total Assets" },
    { section: "Balance Sheet", label: "Short Term Debt", value: pctRatio(std, ta), source: "computed", formula: "STD / Total Assets" },
    { section: "Balance Sheet", label: "Current Portion", value: pctRatio(cpltd, ta), source: "computed", formula: "CPLTD / Total Assets" },
    { section: "Balance Sheet", label: "Other Current", value: pctRatio(ocl, ta), source: "computed", formula: "Other Current Liabilities / Total Assets" },
    {
      section: "Balance Sheet",
      label: "Total Current",
      value: pctRatio(tclTotal, ta),
      source: "computed",
      formula: "Total Current Liabilities / Total Assets",
    },
    {
      section: "Balance Sheet",
      label: "Long Term Liabilities",
      value: pctRatio(tltl, ta),
      source: "computed",
      formula: "Total LT Liabilities / Total Assets (duplicate row label in template)",
    },
    { section: "Balance Sheet", label: "Equity", value: pctRatio(eq, ta), source: "computed", formula: "Equity / Total Assets" },
  );

  applyIndustryCommonSize(rows, p.industryCommonSize);

  return rows;
}
