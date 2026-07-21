import { computeWorkbookFormulas } from "@/lib/tax/workbook-formulas";
import type { TaxYearValues } from "@/lib/tax-workbook";
import type { BenchmarkEntryRow } from "@/lib/benchmark-entry";
import { BENCHMARK_EXCEL_GROUPS } from "@/lib/benchmark-entry";
import type { NaicsBenchmarkProfile, ValuationMath } from "@/lib/valuation/types";
import { escapeSvg, truncateLabel, wrapLabel } from "@/lib/valuation/chart-svg-utils";

export type VisualChart = { id: string; title: string; svg: string };

function parsePct(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/([\d.]+)\s*%/);
  return match ? Number(match[1]) : undefined;
}

function parseRatio(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function latestSubjectColumn(columns: TaxYearValues[]): TaxYearValues | undefined {
  return [...columns].sort((a, b) => a.year - b.year).at(-1);
}

function subjectCommonSize(columns: TaxYearValues[]): Record<string, number | undefined> {
  const latest = latestSubjectColumn(columns);
  if (!latest) return {};
  const raw = latest.workbookValues ?? latest.values;
  const comp = computeWorkbookFormulas(raw);
  const sales = raw.sales ?? comp.sales ?? 0;
  const ta = comp.total_assets ?? raw.total_assets ?? 0;
  const tcl = comp.total_current_liabilities ?? 0;
  const eq = comp.total_equity ?? raw.total_equity ?? 0;
  const pctSales = (n: number | undefined) => (sales > 0 && n !== undefined ? (n / sales) * 100 : undefined);
  const pctAssets = (n: number | undefined) => (ta > 0 && n !== undefined ? (n / ta) * 100 : undefined);
  const npbt = raw.adjusted_net_profit_before_taxes ?? raw.net_profit_before_taxes ?? comp.net_profit_before_taxes;
  const ebitda = (npbt ?? 0) + (raw.depreciation ?? 0) + (raw.amortization ?? 0) + (raw.interest_expense ?? 0);
  return {
    cogs: pctSales(raw.cogs ?? comp.cogs),
    gaWages: pctSales(raw.salaries_wages),
    rent: pctSales(raw.rent),
    ebitda: pctSales(ebitda),
    netIncome: pctSales(npbt),
    cash: pctAssets(raw.cash ?? comp.cash),
    receivables: pctAssets(raw.accounts_receivable ?? comp.accounts_receivable),
    inventory: pctAssets(raw.inventory ?? comp.inventory),
    currentAssets: pctAssets(comp.total_current_assets),
    currentLiabilities: pctAssets(comp.total_current_liabilities),
    equity: pctAssets(eq),
    currentRatio: tcl > 0 ? (comp.total_current_assets ?? 0) / tcl : undefined,
    quickRatio:
      tcl > 0 ? ((raw.cash ?? 0) + (raw.accounts_receivable ?? 0)) / tcl : undefined,
    returnOnEquity: eq > 0 && npbt !== undefined ? (npbt / eq) * 100 : undefined,
    returnOnAssets: ta > 0 && npbt !== undefined ? (npbt / ta) * 100 : undefined,
  };
}

function benchmarkValueForLabel(rows: BenchmarkEntryRow[], label: string): string {
  return rows.find((r) => r.label === label)?.value ?? "";
}

function compareBarChart(input: {
  id: string;
  title: string;
  rows: Array<{ label: string; subject?: number; benchmark?: number; format: "pct" | "ratio" }>;
}): VisualChart {
  const width = 720;
  const rowH = 34;
  const pad = { top: 42, left: 150, right: 24, bottom: 24 };
  const height = pad.top + pad.bottom + input.rows.length * rowH;
  const maxVal = Math.max(
    1,
    ...input.rows.flatMap((r) => [r.subject ?? 0, r.benchmark ?? 0]),
  );
  const barMaxW = width - pad.left - pad.right - 180;

  const body = input.rows
    .map((row, index) => {
      const y = pad.top + index * rowH;
      const subW = ((row.subject ?? 0) / maxVal) * barMaxW;
      const benchW = ((row.benchmark ?? 0) / maxVal) * barMaxW;
      const fmt = (v: number | undefined) =>
        row.format === "pct" ? `${(v ?? 0).toFixed(1)}%` : (v ?? 0).toFixed(2);
      const labelLines = wrapLabel(row.label, 18, 2);
      const labelSvg = labelLines
        .map((line, li) => `<text x="${pad.left - 8}" y="${y + 14 + li * 12}" text-anchor="end" fill="#44403c" font-size="11" font-family="Arial,sans-serif">${escapeSvg(line)}</text>`)
        .join("");
      return [
        labelSvg,
        `<rect x="${pad.left}" y="${y}" width="${subW.toFixed(1)}" height="12" fill="#1d4ed8" rx="2"/>`,
        `<text x="${(pad.left + subW + 4).toFixed(1)}" y="${y + 10}" fill="#1d4ed8" font-size="10">${fmt(row.subject)}</text>`,
        `<rect x="${pad.left}" y="${y + 16}" width="${benchW.toFixed(1)}" height="12" fill="#b45309" rx="2"/>`,
        `<text x="${(pad.left + benchW + 4).toFixed(1)}" y="${y + 26}" fill="#b45309" font-size="10">${fmt(row.benchmark)}</text>`,
      ].join("");
    })
    .join("");

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" fill="#fafaf9" rx="12"/>`,
    `<text x="${pad.left}" y="24" fill="#1c1917" font-size="15" font-weight="600" font-family="Arial,sans-serif">${escapeSvg(truncateLabel(input.title, 70))}</text>`,
    `<text x="${width - pad.right}" y="24" text-anchor="end" fill="#78716c" font-size="10">■ Subject  ■ Benchmark</text>`,
    body,
    `</svg>`,
  ].join("");
  return { id: input.id, title: input.title, svg };
}

function benchmarkEntryTableSvg(rows: BenchmarkEntryRow[], title: string): VisualChart {
  const width = 520;
  const rowH = 22;
  const groups = BENCHMARK_EXCEL_GROUPS;
  let rowCount = 0;
  for (const group of groups) rowCount += group.labels.length + 1;
  const height = Math.min(680, 48 + rowCount * rowH + groups.length * 8);
  let y = 36;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<text x="16" y="24" font-size="14" font-weight="600" font-family="Arial,sans-serif">${escapeSvg(title)}</text>`,
  ];

  for (const group of groups) {
    parts.push(`<rect x="12" y="${y - 14}" width="${width - 24}" height="18" fill="#fef08a"/>`);
    parts.push(`<text x="16" y="${y}" font-size="11" font-weight="600">${escapeSvg(group.section)}</text>`);
    y += 20;
    for (const label of group.labels) {
      const row = rows.find((r) => r.section === group.section && r.label === label);
      const val = row?.value ?? "";
      const highlight = group.section === "Metrics" ? "#dcfce7" : "#fef9c3";
      parts.push(`<rect x="12" y="${y - 12}" width="${width - 24}" height="${rowH}" fill="${highlight}" stroke="#e7e5e4"/>`);
      parts.push(`<text x="20" y="${y + 2}" font-size="10">${escapeSvg(truncateLabel(label, 28))}</text>`);
      parts.push(`<text x="${width - 20}" y="${y + 2}" text-anchor="end" font-size="10" font-family="Consolas,monospace">${escapeSvg(val)}</text>`);
      y += rowH;
    }
    y += 8;
  }
  parts.push(`</svg>`);
  return { id: "benchmark-entry-table", title, svg: parts.join("") };
}

function buildupWaterfallSvg(valuation: ValuationMath): VisualChart {
  const steps = [
    { label: "Risk-free", value: valuation.assumptions.riskFreeRate * 100 },
    { label: "ERP", value: valuation.assumptions.equityRiskPremium * 100 },
    { label: "Size prem.", value: valuation.assumptions.sizePremium * 100 },
    { label: "Co. risk", value: valuation.assumptions.companySpecificRisk * 100 },
    { label: "− Growth", value: -valuation.assumptions.longTermGrowthRate * 100 },
    { label: "Cap rate", value: valuation.capitalizationRate * 100, emphasis: true },
  ];
  const width = 620;
  const rowH = 34;
  const pad = { top: 42, left: 120, right: 80, bottom: 20 };
  const height = pad.top + pad.bottom + steps.length * rowH;
  const maxVal = Math.max(...steps.map((s) => Math.abs(s.value)), 1);
  const barMaxW = width - pad.left - pad.right;

  const body = steps
    .map((step, index) => {
      const y = pad.top + index * rowH;
      const w = (Math.abs(step.value) / maxVal) * barMaxW;
      const x = pad.left;
      const color = step.emphasis ? "#1c1917" : step.value < 0 ? "#b91c1c" : "#1d4ed8";
      return [
        `<text x="${pad.left - 8}" y="${y + 18}" text-anchor="end" fill="#44403c" font-size="11">${escapeSvg(step.label)}</text>`,
        `<rect x="${x}" y="${y + 4}" width="${w.toFixed(1)}" height="14" fill="${color}" rx="2"/>`,
        `<text x="${(x + w + 6).toFixed(1)}" y="${y + 16}" fill="${color}" font-size="11" font-weight="${step.emphasis ? "600" : "400"}">${step.value.toFixed(1)}%</text>`,
      ].join("");
    })
    .join("");

  return {
    id: "buildup-waterfall",
    title: "Build-up capitalization rate",
    svg: [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
      `<rect width="100%" height="100%" fill="#fafaf9" rx="12"/>`,
      `<text x="${pad.left}" y="26" font-size="15" font-weight="600">${escapeSvg("Build-up capitalization rate")}</text>`,
      body,
      `</svg>`,
    ].join(""),
  };
}

function reconciliationTableSvg(valuation: ValuationMath): VisualChart {
  const width = 640;
  const rows = [
    ...valuation.methods.map((m) => [m.label, `$${m.adjustedValue.toLocaleString()}`, `${(m.weight * 100).toFixed(0)}%`]),
    ["Reconciled value", `$${valuation.reconciledValue.toLocaleString()}`, "100%"],
  ];
  let y = 40;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${60 + rows.length * 28}" viewBox="0 0 ${width} ${60 + rows.length * 28}">`,
    `<rect width="100%" height="100%" fill="#fafaf9"/>`,
    `<text x="16" y="24" font-size="14" font-weight="600">Reconciliation of values</text>`,
    `<text x="16" y="${y}" font-size="10" font-weight="600">Method</text>`,
    `<text x="360" y="${y}" font-size="10" font-weight="600">Adjusted</text>`,
    `<text x="520" y="${y}" font-size="10" font-weight="600">Weight</text>`,
  ];
  y += 18;
  for (const [method, value, weight] of rows) {
    parts.push(`<text x="16" y="${y}" font-size="11">${escapeSvg(String(method))}</text>`);
    parts.push(`<text x="360" y="${y}" font-size="11" font-family="Consolas,monospace">${escapeSvg(String(value))}</text>`);
    parts.push(`<text x="520" y="${y}" font-size="11">${escapeSvg(String(weight))}</text>`);
    y += 24;
  }
  parts.push(`</svg>`);
  return { id: "reconciliation-summary", title: "Reconciliation of values", svg: parts.join("") };
}

function marketMultiplesTableSvg(
  metrics: Array<{ name: string; multiple: number; impliedValue: number }>,
): VisualChart | null {
  if (!metrics.length) return null;
  const width = 560;
  const rowH = 28;
  const height = Math.max(140, 56 + metrics.length * rowH);
  let y = 40;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
    `<rect width="100%" height="100%" fill="#fafaf9"/>`,
    `<text x="16" y="24" font-size="14" font-weight="600">Market method — ExitValue multiples</text>`,
  ];
  for (const m of metrics) {
    parts.push(`<text x="16" y="${y}" font-size="11">${escapeSvg(m.name)}: ${m.multiple.toFixed(2)}× → $${m.impliedValue.toLocaleString()}</text>`);
    y += 24;
  }
  parts.push(`</svg>`);
  return { id: "market-multiples-table", title: "Market method indicated value", svg: parts.join("") };
}

function placeholderSvg(id: string, title: string, message: string): VisualChart {
  return {
    id,
    title,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="140"><rect width="100%" height="100%" fill="#fafaf9" stroke="#d6d3d1"/><text x="24" y="48" fill="#78716c" font-size="14" font-family="Arial,sans-serif">${escapeSvg(title)}</text><text x="24" y="78" fill="#a8a29e" font-size="12">${escapeSvg(message)}</text></svg>`,
  };
}

/** Benchmark Entry visuals + subject-vs-benchmark charts for Word template slots (option B: table-as-image). */
export function buildBenchmarkVisualCharts(input: {
  columns: TaxYearValues[];
  benchmark: NaicsBenchmarkProfile;
  valuation: ValuationMath;
  marketMetrics?: Array<{ name: string; multiple: number; impliedValue: number }>;
}): VisualChart[] {
  const { columns, benchmark, valuation, marketMetrics } = input;
  const subject = subjectCommonSize(columns);
  const rows = benchmark.benchmarkRows;

  const isCompare = compareBarChart({
    id: "benchmark-is-compare",
    title: "Income statement — subject vs benchmark (% of sales)",
    rows: [
      { label: "COGS", subject: subject.cogs, benchmark: parsePct(benchmarkValueForLabel(rows, "COGS")), format: "pct" },
      { label: "G&A Wages", subject: subject.gaWages, benchmark: parsePct(benchmarkValueForLabel(rows, "G&A Wages")), format: "pct" },
      { label: "Rent", subject: subject.rent, benchmark: parsePct(benchmarkValueForLabel(rows, "Rent Expenses")), format: "pct" },
      { label: "EBITDA", subject: subject.ebitda, benchmark: parsePct(benchmarkValueForLabel(rows, "EBITDA")), format: "pct" },
      { label: "Net Income", subject: subject.netIncome, benchmark: parsePct(benchmarkValueForLabel(rows, "Net Income")), format: "pct" },
    ],
  });

  const bsCompare = compareBarChart({
    id: "benchmark-bs-compare",
    title: "Balance sheet — subject vs benchmark (% of assets)",
    rows: [
      { label: "Cash", subject: subject.cash, benchmark: parsePct(benchmarkValueForLabel(rows, "Cash")), format: "pct" },
      { label: "Receivables", subject: subject.receivables, benchmark: parsePct(benchmarkValueForLabel(rows, "Receivables")), format: "pct" },
      { label: "Inventory", subject: subject.inventory, benchmark: parsePct(benchmarkValueForLabel(rows, "Inventory")), format: "pct" },
      { label: "Current assets", subject: subject.currentAssets, benchmark: parsePct(benchmarkValueForLabel(rows, "Current Assets")), format: "pct" },
      { label: "Equity", subject: subject.equity, benchmark: parsePct(benchmarkValueForLabel(rows, "Equity")), format: "pct" },
    ],
  });

  const metricsCompare = compareBarChart({
    id: "benchmark-metrics-compare",
    title: "Financial metrics — subject vs benchmark",
    rows: [
      { label: "Current ratio", subject: subject.currentRatio, benchmark: parseRatio(benchmarkValueForLabel(rows, "Current Ratio")), format: "ratio" },
      { label: "Quick ratio", subject: subject.quickRatio, benchmark: parseRatio(benchmarkValueForLabel(rows, "Quick Ratio")), format: "ratio" },
      { label: "ROE", subject: subject.returnOnEquity, benchmark: parsePct(benchmarkValueForLabel(rows, "Return on Equity")), format: "pct" },
      { label: "ROA", subject: subject.returnOnAssets, benchmark: parsePct(benchmarkValueForLabel(rows, "Return on Assets")), format: "pct" },
    ],
  });

  const charts: VisualChart[] = [
    benchmarkEntryTableSvg(rows, `Benchmark Entry — ${benchmark.title}`),
    isCompare,
    bsCompare,
    metricsCompare,
    buildupWaterfallSvg(valuation),
    reconciliationTableSvg(valuation),
  ];

  const marketTable = marketMultiplesTableSvg(marketMetrics ?? []);
  if (marketTable) charts.push(marketTable);
  else {
    charts.push(
      placeholderSvg(
        "market-multiples-table",
        "Market method — DealStats / transaction comps",
        "No market multiples loaded. Analyst may paste DealStats workpapers or enable ExitValue feed.",
      ),
    );
    charts.push(
      placeholderSvg(
        "market-comps-scatter",
        "Market comps — percentile interpolation",
        "Requires paid DealStats/BVR dataset or manual analyst upload.",
      ),
    );
  }

  charts.push(
    placeholderSvg(
      "dealstats-detail",
      "DealStats transaction detail",
      "User/analyst filled — no free API for private transaction detail tables.",
    ),
  );

  charts.push(
    placeholderSvg(
      "firm-logo",
      "Firm logo",
      "Replace with user firm branding in company profile (future upload).",
    ),
  );

  return charts;
}
