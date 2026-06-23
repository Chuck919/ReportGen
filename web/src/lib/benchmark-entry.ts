import type { ParsedFinancialPdf } from "./financial-text-parser";
import { formatPercentDisplay, r2 } from "./benchmark-format";

export type BenchmarkEntryRow = {
  section: "Income Statement" | "Balance Sheet" | "Metrics";
  label: string;
  /** Display: percents like `41%`, ratios like `4.55`. */
  value: string;
  source: "computed" | "scorecard" | "industry-common-size" | "na";
  formula?: string;
  /** Blank separator row before this group in Excel paste. */
  excelGroupStart?: boolean;
};

/**
 * Benchmark Entry workbook row order (values column only when pasted).
 * Matches the Excel template: section headers + blank rows between blocks.
 */
export const BENCHMARK_EXCEL_GROUPS: Array<{
  section: BenchmarkEntryRow["section"];
  labels: string[];
}> = [
  {
    section: "Income Statement",
    labels: ["COGS", "G&A Wages", "Rent Expenses", "EBITDA", "Net Income"],
  },
  {
    section: "Balance Sheet",
    labels: ["Cash", "Receivables", "Inventory", "Current Assets"],
  },
  {
    section: "Balance Sheet",
    labels: ["Gross", "Accumulated Depreciation", "Current Liabilities", "Long-term Liabilities"],
  },
  {
    section: "Metrics",
    labels: ["Current Ratio", "Quick Ratio", "Return on Equity", "Return on Assets"],
  },
  {
    section: "Income Statement",
    labels: [
      "Depreciation",
      "Amortization",
      "Overhead or SG&A",
      "Advertising",
      "Other Operating Expenses",
      "Operating Profit",
      "Interest",
    ],
  },
  {
    section: "Balance Sheet",
    labels: [
      "Gross intangible",
      "Less amortization",
      "Accounts Payable",
      "Short Term Debt",
      "Current Portion",
      "Other Current",
      "Total Current",
      "Long Term Liabilities",
      "Equity",
    ],
  },
];

function pctRatio(num: number, den: number): string {
  if (!den) return "";
  return formatPercentDisplay(num / den);
}

function latest<T extends readonly [number, number, number]>(t: T | undefined): number {
  return t?.[2] ?? 0;
}

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
  gross_fixed: { section: "Balance Sheet", label: "Gross" },
  acc_dep: { section: "Balance Sheet", label: "Accumulated Depreciation" },
  tcl: { section: "Balance Sheet", label: "Current Liabilities" },
  tltl: { section: "Balance Sheet", label: "Long-term Liabilities" },
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

function applyIndustryCommonSize(rowMap: Map<string, BenchmarkEntryRow>, ics: Record<string, number> | undefined): void {
  if (!ics || !Object.keys(ics).length) return;

  for (const [rawKey, ratio] of Object.entries(ics)) {
    const baseKey = rawKey.replace(/_pctdup$/, "").replace(/_il$/, "");
    if (baseKey === "tcl") {
      for (const label of ["Current Liabilities", "Total Current"]) {
        const row = rowMap.get(`Balance Sheet|${label}`);
        if (row) {
          row.value = formatPercentDisplay(ratio);
          row.source = "industry-common-size";
          row.formula = "Industry column (common-size % from PDF)";
        }
      }
      continue;
    }
    if (baseKey === "tltl") {
      for (const label of ["Long-term Liabilities", "Long Term Liabilities"]) {
        const row = rowMap.get(`Balance Sheet|${label}`);
        if (row) {
          row.value = formatPercentDisplay(ratio);
          row.source = "industry-common-size";
          row.formula = "Industry column (common-size % from PDF)";
        }
      }
      continue;
    }
    const hit = INDUSTRY_CS_FACT_TO_LABEL[baseKey];
    if (!hit) continue;
    const row = rowMap.get(`${hit.section}|${hit.label}`);
    if (row) {
      row.value = formatPercentDisplay(ratio);
      row.source = "industry-common-size";
      row.formula = "Industry column (common-size % from PDF)";
    }
  }
}

function rowKey(section: string, label: string): string {
  return `${section}|${label}`;
}

/** All Benchmark Entry rows in Excel workbook order. */
export function buildBenchmarkEntryRows(p: ParsedFinancialPdf): BenchmarkEntryRow[] {
  const f = p.facts;
  const sales = latest(f.sales) || 0;
  const ta = latest(f.total_assets) || 0;
  const tca = latest(f.tca) || 0;
  const tcl = latest(f.tcl) || 0;
  const cash = latest(f.cash) || 0;
  const ar = latest(f.ar) || 0;
  const inv = latest(f.inventory) || 0;
  const cogs = latest(f.cogs) || 0;
  const ga = latest(f.ga_payroll) || 0;
  const rent = latest(f.rent) || 0;
  const ebitda = latest(f.ebitda) || 0;
  const ni = latest(f.net_income) || latest(f.net_profit_before_tax) || 0;
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
  const eq =
    latest(f.total_equity) || latest(f.unclassified_equity) || latest(f.equity_other) || 0;

  const sc = p.scorecard;

  const crCompany = tclTotal && tca ? tca / tclTotal : undefined;
  const crScorecard = sc.currentRatio;
  const crDisplay = crScorecard ?? crCompany;
  const crSource: BenchmarkEntryRow["source"] =
    crScorecard !== undefined ? "scorecard" : crCompany !== undefined ? "computed" : "na";

  const qrCompany = tclTotal && cash + ar ? (cash + ar) / tclTotal : undefined;
  const qrScorecard = sc.quickRatio;
  const qrDisplay = qrScorecard ?? qrCompany;
  const qrSource: BenchmarkEntryRow["source"] =
    qrScorecard !== undefined ? "scorecard" : qrCompany !== undefined ? "computed" : "na";

  const roeRatio = eq && ni ? ni / eq : undefined;
  const roeScorecard = sc.returnOnEquityPct;
  const roeDisplay =
    roeScorecard !== undefined
      ? `${roeScorecard}%`
      : roeRatio !== undefined
        ? formatPercentDisplay(roeRatio)
        : "";
  const roeSource: BenchmarkEntryRow["source"] =
    roeScorecard !== undefined ? "scorecard" : roeRatio !== undefined ? "computed" : "na";

  const roaRatio = ta && ni ? ni / ta : undefined;
  const roaScorecard = sc.returnOnAssetsPct;
  const roaDisplay =
    roaScorecard !== undefined
      ? `${roaScorecard}%`
      : roaRatio !== undefined
        ? formatPercentDisplay(roaRatio)
        : "";
  const roaSource: BenchmarkEntryRow["source"] =
    roaScorecard !== undefined ? "scorecard" : roaRatio !== undefined ? "computed" : "na";

  const computed: Record<string, Omit<BenchmarkEntryRow, "section" | "label">> = {
    [rowKey("Income Statement", "COGS")]: {
      value: pctRatio(cogs, sales),
      source: "computed",
      formula: "Cost of Sales / Sales",
    },
    [rowKey("Income Statement", "G&A Wages")]: {
      value: pctRatio(ga, sales),
      source: "computed",
      formula: "G&A Payroll / Sales",
    },
    [rowKey("Income Statement", "Rent Expenses")]: {
      value: pctRatio(rent, sales),
      source: "computed",
      formula: "Rent / Sales",
    },
    [rowKey("Income Statement", "EBITDA")]: {
      value: pctRatio(ebitda, sales),
      source: "computed",
      formula: "EBITDA / Sales",
    },
    [rowKey("Income Statement", "Net Income")]: {
      value: pctRatio(ni, sales),
      source: "computed",
      formula: "Net Income / Sales",
    },
    [rowKey("Balance Sheet", "Cash")]: {
      value: pctRatio(cash, ta),
      source: "computed",
      formula: "Cash / Total Assets",
    },
    [rowKey("Balance Sheet", "Receivables")]: {
      value: pctRatio(ar, ta),
      source: "computed",
      formula: "A/R / Total Assets",
    },
    [rowKey("Balance Sheet", "Inventory")]: {
      value: pctRatio(inv, ta),
      source: "computed",
      formula: "Inventory / Total Assets",
    },
    [rowKey("Balance Sheet", "Current Assets")]: {
      value: pctRatio(tca, ta),
      source: "computed",
      formula: "Total Current Assets / Total Assets",
    },
    [rowKey("Balance Sheet", "Gross")]: {
      value: pctRatio(grossFixed, ta),
      source: "computed",
      formula: "Gross Fixed Assets / Total Assets",
    },
    [rowKey("Balance Sheet", "Accumulated Depreciation")]: {
      value: pctRatio(accDep, ta),
      source: "computed",
      formula: "Accumulated Depreciation / Total Assets",
    },
    [rowKey("Balance Sheet", "Current Liabilities")]: {
      value: pctRatio(tcl, ta),
      source: "computed",
      formula: "Total Current Liabilities / Total Assets",
    },
    [rowKey("Balance Sheet", "Long-term Liabilities")]: {
      value: pctRatio(tltl, ta),
      source: "computed",
      formula: "Total LT Liabilities / Total Assets",
    },
    [rowKey("Metrics", "Current Ratio")]: {
      value: crDisplay !== undefined ? r2(crDisplay) : "",
      source: crSource,
      formula: "Industry Scorecard (company ratio from report)",
    },
    [rowKey("Metrics", "Quick Ratio")]: {
      value: qrDisplay !== undefined ? r2(qrDisplay) : "",
      source: qrSource,
      formula: "Industry Scorecard (company ratio from report)",
    },
    [rowKey("Metrics", "Return on Equity")]: {
      value: roeDisplay,
      source: roeSource,
      formula: "Industry Scorecard (company % from report)",
    },
    [rowKey("Metrics", "Return on Assets")]: {
      value: roaDisplay,
      source: roaSource,
      formula: "Industry Scorecard (company % from report)",
    },
    [rowKey("Income Statement", "Depreciation")]: {
      value: pctRatio(depIs, sales),
      source: "computed",
      formula: "Depreciation (I/S) / Sales",
    },
    [rowKey("Income Statement", "Amortization")]: {
      value: pctRatio(amort, sales),
      source: "computed",
      formula: "Amortization / Sales",
    },
    [rowKey("Income Statement", "Overhead or SG&A")]: {
      value: pctRatio(oh, sales),
      source: "computed",
      formula: "Overhead / Sales",
    },
    [rowKey("Income Statement", "Advertising")]: {
      value: pctRatio(adv, sales),
      source: "computed",
      formula: "Advertising / Sales",
    },
    [rowKey("Income Statement", "Other Operating Expenses")]: {
      value: pctRatio(ooe, sales),
      source: "computed",
      formula: "Other OpEx / Sales",
    },
    [rowKey("Income Statement", "Operating Profit")]: {
      value: pctRatio(op, sales),
      source: "computed",
      formula: "Operating Profit / Sales",
    },
    [rowKey("Income Statement", "Interest")]: {
      value: pctRatio(interest, sales),
      source: "computed",
      formula: "Interest / Sales",
    },
    [rowKey("Balance Sheet", "Gross intangible")]: {
      value: pctRatio(grossInt, ta),
      source: "computed",
      formula: "Gross Intangibles / Total Assets",
    },
    [rowKey("Balance Sheet", "Less amortization")]: {
      value: pctRatio(accAmort, ta),
      source: "computed",
      formula: "Accumulated Amortization / Total Assets",
    },
    [rowKey("Balance Sheet", "Accounts Payable")]: {
      value: pctRatio(ap, ta),
      source: "computed",
      formula: "A/P / Total Assets",
    },
    [rowKey("Balance Sheet", "Short Term Debt")]: {
      value: pctRatio(std, ta),
      source: "computed",
      formula: "STD / Total Assets",
    },
    [rowKey("Balance Sheet", "Current Portion")]: {
      value: pctRatio(cpltd, ta),
      source: "computed",
      formula: "CPLTD / Total Assets",
    },
    [rowKey("Balance Sheet", "Other Current")]: {
      value: pctRatio(ocl, ta),
      source: "computed",
      formula: "Other Current Liabilities / Total Assets",
    },
    [rowKey("Balance Sheet", "Total Current")]: {
      value: pctRatio(tclTotal, ta),
      source: "computed",
      formula: "Total Current Liabilities / Total Assets",
    },
    [rowKey("Balance Sheet", "Long Term Liabilities")]: {
      value: pctRatio(tltl, ta),
      source: "computed",
      formula: "Total LT Liabilities / Total Assets",
    },
    [rowKey("Balance Sheet", "Equity")]: {
      value: pctRatio(eq, ta),
      source: "computed",
      formula: "Equity / Total Assets",
    },
  };

  const rowMap = new Map<string, BenchmarkEntryRow>();
  for (const [key, data] of Object.entries(computed)) {
    const [section, label] = key.split("|") as [BenchmarkEntryRow["section"], string];
    rowMap.set(key, { section, label, ...data });
  }

  applyIndustryCommonSize(rowMap, p.industryCommonSize);

  const rows: BenchmarkEntryRow[] = [];
  for (const group of BENCHMARK_EXCEL_GROUPS) {
    group.labels.forEach((label, labelIdx) => {
      const key = rowKey(group.section, label);
      const row = rowMap.get(key) ?? {
        section: group.section,
        label,
        value: "",
        source: "na" as const,
      };
      rows.push({
        ...row,
        excelGroupStart: labelIdx === 0 && rows.length > 0,
      });
    });
  }

  return rows;
}
