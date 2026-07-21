import type { TaxYearValues } from "@/lib/tax-workbook";
import { computeWorkbookFormulas } from "@/lib/tax/workbook-formulas";
import { escapeSvg, truncateLabel } from "@/lib/valuation/chart-svg-utils";

type Point = { label: string; value: number };

function lineChartSvg(input: {
  title: string;
  points: Point[];
  color?: string;
  valueFormat?: "money" | "percent";
  width?: number;
  height?: number;
}): string {
  const width = input.width ?? 720;
  const height = input.height ?? 260;
  const pad = { top: 36, right: 24, bottom: 44, left: 72 };
  const color = input.color ?? "#1c1917";
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  if (!input.points.length) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#fafaf9"/><text x="24" y="40" fill="#57534e" font-size="16">No data</text></svg>`;
  }

  const values = input.points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);
  const stepX = innerW / Math.max(input.points.length - 1, 1);

  const format = (v: number) =>
    input.valueFormat === "percent"
      ? `${v.toFixed(1)}%`
      : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(v);

  const path = input.points
    .map((point, index) => {
      const x = pad.left + index * stepX;
      const y = pad.top + innerH - ((point.value - min) / range) * innerH;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const dots = input.points
    .map((point, index) => {
      const x = pad.left + index * stepX;
      const y = pad.top + innerH - ((point.value - min) / range) * innerH;
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="${color}" /><text x="${x.toFixed(1)}" y="${height - 12}" text-anchor="middle" fill="#78716c" font-size="11" font-family="Arial,sans-serif">${escapeSvg(truncateLabel(point.label, 8))}</text>`;
    })
    .join("");

  const yTicks = [min, min + range / 2, max]
    .map((v) => {
      const y = pad.top + innerH - ((v - min) / range) * innerH;
      return `<text x="${pad.left - 8}" y="${y + 4}" text-anchor="end" fill="#78716c" font-size="10" font-family="Arial,sans-serif">${format(v)}</text><line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" stroke="#e7e5e4" stroke-width="1" stroke-dasharray="4 4"/>`;
    })
    .join("");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" fill="#fafaf9" rx="12"/>`,
    `<text x="${pad.left}" y="22" fill="#1c1917" font-size="15" font-weight="600" font-family="Arial,sans-serif">${escapeSvg(truncateLabel(input.title, 56))}</text>`,
    `<line x1="${pad.left}" y1="${pad.top + innerH}" x2="${width - pad.right}" y2="${pad.top + innerH}" stroke="#d6d3d1"/>`,
    `<line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + innerH}" stroke="#d6d3d1"/>`,
    yTicks,
    `<path d="${path}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>`,
    dots,
    `</svg>`,
  ].join("");
}

function barChartSvg(input: { title: string; points: Point[]; color?: string }): string {
  const width = 720;
  const height = 260;
  const pad = { top: 36, right: 24, bottom: 44, left: 72 };
  const color = input.color ?? "#44403c";
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(...input.points.map((p) => p.value), 1);
  const barW = innerW / Math.max(input.points.length, 1) - 12;

  const bars = input.points
    .map((point, index) => {
      const h = (point.value / max) * innerH;
      const x = pad.left + index * (innerW / input.points.length) + 6;
      const y = pad.top + innerH - h;
      return `<rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="${color}" rx="4" opacity="0.85"/><text x="${x + barW / 2}" y="${height - 12}" text-anchor="middle" fill="#78716c" font-size="11">${escapeSvg(truncateLabel(point.label, 14))}</text>`;
    })
    .join("");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" fill="#fafaf9" rx="12"/>`,
    `<text x="${pad.left}" y="22" fill="#1c1917" font-size="15" font-weight="600" font-family="Arial,sans-serif">${escapeSvg(truncateLabel(input.title, 56))}</text>`,
    bars,
    `</svg>`,
  ].join("");
}

export function buildFinancialTrendCharts(columns: TaxYearValues[]): Array<{ id: string; title: string; svg: string }> {
  const sorted = [...columns].sort((a, b) => a.year - b.year);
  const sales: Point[] = [];
  const npbt: Point[] = [];
  const margin: Point[] = [];

  for (const column of sorted) {
    const raw = column.workbookValues ?? column.values;
    const computed = computeWorkbookFormulas(raw);
    const year = String(column.year);
    const s = computed.sales ?? raw.sales;
    const n = computed.net_profit_before_taxes ?? raw.net_profit_before_taxes;
    if (s !== undefined) sales.push({ label: year, value: s });
    if (n !== undefined) npbt.push({ label: year, value: n });
    if (s && n !== undefined && s > 0) margin.push({ label: year, value: (n / s) * 100 });
  }

  const charts: Array<{ id: string; title: string; svg: string }> = [];
  if (sales.length >= 2) {
    charts.push({
      id: "sales-trend",
      title: "Historical sales trend",
      svg: lineChartSvg({ title: "Sales by year", points: sales, color: "#1d4ed8" }),
    });
  }
  if (npbt.length >= 2) {
    charts.push({
      id: "npbt-trend",
      title: "Net profit before taxes trend",
      svg: lineChartSvg({ title: "NPBT by year", points: npbt, color: "#15803d" }),
    });
  }
  if (margin.length >= 2) {
    charts.push({
      id: "margin-trend",
      title: "Net margin trend",
      svg: lineChartSvg({ title: "NPBT ÷ Sales (%)", points: margin, color: "#b45309", valueFormat: "percent" }),
    });
  }
  if (sales.length >= 2 && npbt.length >= 2) {
    charts.push({
      id: "sales-npbt-bars",
      title: "Sales vs. NPBT comparison",
      svg: barChartSvg({
        title: "Latest year: Sales and NPBT",
        points: [
          { label: `Sales ${sales.at(-1)!.label}`, value: sales.at(-1)!.value },
          { label: `NPBT ${npbt.at(-1)!.label}`, value: npbt.at(-1)!.value },
        ],
        color: "#44403c",
      }),
    });
  }
  return charts;
}

function metricSnapshotSvg(title: string, rows: Array<{ label: string; value: string }>): string {
  const width = 520;
  const rowH = 28;
  const height = Math.max(140, 48 + rows.length * rowH);
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" fill="#fafaf9" rx="10"/>`,
    `<text x="16" y="26" font-size="14" font-weight="600" font-family="Arial,sans-serif">${escapeSvg(truncateLabel(title, 50))}</text>`,
  ];
  let y = 44;
  for (const row of rows) {
    parts.push(`<text x="20" y="${y}" font-size="11" fill="#44403c">${escapeSvg(truncateLabel(row.label, 30))}</text>`);
    parts.push(`<text x="${width - 20}" y="${y}" text-anchor="end" font-size="11" font-weight="600">${escapeSvg(row.value || "—")}</text>`);
    y += rowH;
  }
  parts.push(`</svg>`);
  return parts.join("");
}

/** Census snapshot cards for national / MSA template slots (single-value metrics). */
export function buildMacroMetricCharts(input: {
  nationalMetrics: Array<{ label: string; value: string }>;
  msaMetrics: Array<{ label: string; value: string }>;
  msaLabel: string;
}): Array<{ id: string; title: string; svg: string }> {
  const pick = (metrics: Array<{ label: string; value: string }>, labels: string[]) =>
    labels.map((label) => ({ label, value: metrics.find((m) => m.label === label)?.value ?? "" }));

  const charts: Array<{ id: string; title: string; svg: string }> = [];
  const households = pick(input.nationalMetrics, ["Households", "Population"]);
  if (households.some((r) => r.value)) {
    charts.push({
      id: "national-households",
      title: "U.S. households & population",
      svg: metricSnapshotSvg("U.S. Census snapshot", households),
    });
  }
  const income = pick(input.nationalMetrics, ["Median household income", "Unemployment"]);
  if (income.some((r) => r.value)) {
    charts.push({
      id: "national-income",
      title: "U.S. income & unemployment",
      svg: metricSnapshotSvg("U.S. economic snapshot", income),
    });
  }
  const msaPop = pick(input.msaMetrics, ["Population", "Households", "Median age"]);
  if (msaPop.some((r) => r.value)) {
    charts.push({
      id: "msa-population",
      title: `${truncateLabel(input.msaLabel, 40)} demographics`,
      svg: metricSnapshotSvg(`${input.msaLabel} — Census ACS`, msaPop),
    });
  }
  return charts;
}

export function buildCoverPageSvg(entityName: string, reconciledValue: number): string {
  const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(
    reconciledValue,
  );
  const safeName = entityName.replace(/[<>&"]/g, "");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="520" viewBox="0 0 800 520">`,
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#1c1917"/><stop offset="100%" stop-color="#44403c"/></linearGradient></defs>`,
    `<rect width="800" height="520" fill="url(#bg)" rx="16"/>`,
    `<circle cx="680" cy="100" r="120" fill="#ffffff" opacity="0.06"/>`,
    `<circle cx="120" cy="420" r="80" fill="#ffffff" opacity="0.04"/>`,
    `<text x="48" y="64" fill="#a8a29e" font-size="13" letter-spacing="3" font-family="Arial,sans-serif">BLUE OWL VALUATION</text>`,
    `<text x="48" y="200" fill="#ffffff" font-size="36" font-weight="700" font-family="Georgia,serif">${safeName}</text>`,
    `<text x="48" y="240" fill="#d6d3d1" font-size="16" font-family="Arial,sans-serif">Business Valuation Report — Draft for Review</text>`,
    `<rect x="48" y="280" width="320" height="2" fill="#78716c"/>`,
    `<text x="48" y="330" fill="#a8a29e" font-size="12" font-family="Arial,sans-serif">INDICATED RECONCILED VALUE</text>`,
    `<text x="48" y="375" fill="#fafaf9" font-size="42" font-weight="600" font-family="Arial,sans-serif">${money}</text>`,
    `<text x="48" y="460" fill="#a8a29e" font-size="11" font-family="Arial,sans-serif">Confidential — Prepared from uploaded tax returns</text>`,
    `</svg>`,
  ].join("");
}

export function sectionIconSvg(sectionId: string): string {
  const paths: Record<string, string> = {
    assignment: "M4 6h16v12H4z M8 10h8",
    company: "M12 3L3 9v12h18V9z",
    economy: "M3 17h18 M7 13l3-4 3 3 4-6",
    financials: "M4 18V8 M10 18V5 M16 18v-7 M22 18H2",
    normalization: "M12 3v18 M3 12h18",
    methods: "M12 2l8 4v6c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6z",
    formulas: "M4 7h16M4 12h10M4 17h14",
    cover: "M4 4h16v16H4z",
  };
  const d = paths[sectionId] ?? paths.assignment;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="${d}"/></svg>`;
}
