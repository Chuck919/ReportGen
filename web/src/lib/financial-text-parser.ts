/**
 * Deterministic parsing for IBIS / narrative-style PDFs that embed
 * "Income Statement Data" / "Balance Sheet Data" tables as label + 3 numeric lines.
 */

export type YearSeries = readonly [number, number, number];

export type ParsedFinancialPdf = {
  industry?: string;
  naics?: string;
  facts: Record<string, YearSeries>;
  /** Index 0..2 corresponding to the three fiscal columns (typically 2023–2025). */
  yearLabels: string[];
  scorecard: {
    /** Company / subject (first figure in Industry Scorecard row). */
    currentRatio?: number;
    quickRatio?: number;
    returnOnEquityPct?: number;
    returnOnAssetsPct?: number;
    /** Midpoint of `low to high` in Industry Range column. */
    currentRatioIndustryMid?: number;
    quickRatioIndustryMid?: number;
    /** When two % figures appear (subject vs industry). */
    returnOnEquityIndustryPct?: number;
    returnOnAssetsIndustryPct?: number;
  };
  /**
   * Industry column from common-size (all %) tables: ratio 0–1 per fact key
   * (same keys as `facts` / `toFactKey`).
   */
  industryCommonSize?: Record<string, number>;
  /** Column index (0-based among `%` tokens) used as Industry, when detected. */
  industryCommonSizeColumn?: number;
  rawTextSample: string;
};

function parseMoneyLine(line: string): number | null {
  const t = line.trim();
  if (!t || t.endsWith("%")) return null;
  let neg = false;
  let s = t.replace(/^\$/, "").replace(/,/g, "");
  if (s.startsWith("(") && s.endsWith(")")) {
    neg = true;
    s = s.slice(1, -1);
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

function normalizeKey(label: string): string {
  return label.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Exported for benchmark mapping — converts a table label to `facts` / industryCommonSize keys. */
export function factKeyFromFinancialLabel(label: string): string {
  return toFactKey(label);
}

function parsePercentRatioLine(line: string): number | null {
  const t = line.trim().replace(/^\$/, "");
  if (!t) return null;
  if (/\d\s*%/.test(t)) {
    const m = t.match(/(-?\d[\d,]*(?:\.\d+)?)\s*%/);
    if (!m) return null;
    const n = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(n)) return null;
    return n / 100;
  }
  if (/^\(?-?\d[\d,]*(?:\.\d+)?\)?$/.test(t.replace(/\s/g, ""))) {
    const n = Number(t.replace(/[(),\s]/g, "").replace(/,/g, ""));
    if (!Number.isFinite(n)) return null;
    if (n >= 0 && n <= 100) return n / 100;
  }
  return null;
}

function detectIndustryPercentColumn(lines: string[]): 0 | 1 | 2 {
  const scan = lines.slice(0, Math.min(140, lines.length));
  for (const raw of scan) {
    const t = raw.toLowerCase();
    if (!/industry|benchmark|sector\s+av/i.test(t)) continue;
    const tabParts = raw.split(/\t/).filter((p) => p.trim().length);
    if (tabParts.length >= 3) {
      const idx = tabParts.findIndex((p) => /industry|benchmark|sector/i.test(p));
      if (idx >= 1) return Math.min(2, idx - 1) as 0 | 1 | 2;
    }
    const yearTokens = (t.match(/\b20\d{2}\b/g) ?? []).length;
    if (yearTokens >= 2) return 2;
    return 2;
  }
  return 2;
}

function toFactKey(label: string): string {
  const k = normalizeKey(label);
  const aliases: Record<string, string> = {
    "sales (income)": "sales",
    "cost of sales (cogs)": "cogs",
    "cost of sales": "cogs_detail_total",
    "gross profit": "gross_profit",
    "gross profit margin": "gross_profit_margin_pct",
    depreciation: "depreciation_is",
    amortization: "amortization_is",
    "overhead or s,g,& a expenses": "overhead_sga",
    "overhead or s,g&a expenses": "overhead_sga",
    "g & a payroll expense": "ga_payroll",
    "g&a payroll expense": "ga_payroll",
    rent: "rent",
    advertising: "advertising",
    "officer compensation": "officer_comp",
    "taxes and licenses": "taxes_licenses",
    "bank and credit card": "bank_cc_fees",
    "professional fees": "professional_fees",
    utilities: "utilities",
    "other operating income": "other_operating_income",
    "other operating expenses": "other_operating_expenses",
    "operating profit": "operating_profit",
    "interest expense": "interest_expense",
    "other income": "other_income",
    "other expenses": "other_expenses",
    "net profit before taxes": "net_profit_before_tax",
    "adjusted owner's compensation": "adj_owner_comp",
    "adjusted net profit before taxes": "adj_net_profit_before_tax",
    "net profit margin": "net_profit_margin_pct",
    ebitda: "ebitda",
    "taxes paid": "taxes_paid",
    "extraordinary gain": "extraordinary_gain",
    "extraordinary loss": "extraordinary_loss",
    "net income": "net_income",
    "cash (bank funds)": "cash",
    "accounts receivable": "ar",
    inventory: "inventory",
    "other current assets": "other_ca",
    "total current assets": "tca",
    "gross fixed assets": "gross_fixed",
    "accumulated depreciation": "acc_dep",
    "net fixed assets": "net_fixed",
    "gross intangible assets": "gross_intangible",
    "accumulated amortization": "acc_amortization",
    "net intangible assets": "net_intangible",
    "other assets": "other_assets",
    "total assets": "total_assets",
    "accounts payable": "ap",
    "short term debt": "std",
    "notes payable / current portion of long term debt": "cpltd",
    "other current liabilities": "other_cl",
    "total current liabilities": "tcl",
    "notes payable / senior debt": "senior_debt",
    "notes payable / subordinated debt": "sub_debt",
    "other long term liabilities": "other_ltl",
    "total long term liabilities": "tltl",
    "total liabilities": "total_liabilities",
    "preferred stock": "preferred_stock",
    "common stock": "common_stock",
    "additional paid-in capital": "apic",
    "other stock / equity": "equity_other",
    "total equity": "total_equity",
    "unclassified equity": "unclassified_equity",
  };
  return aliases[k] ?? k.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

export function extractMeta(text: string): { industry?: string; naics?: string } {
  const m = text.match(/Industry:\s*([0-9]{5,6})\s*-\s*([^\n]+)/i);
  if (m) return { naics: m[1].trim(), industry: `${m[1].trim()} – ${m[2].trim()}` };
  const loose = text.match(/Industry:\s*([^\n]+)/i);
  if (loose) return { industry: loose[1].trim() };
  return {};
}

export function extractScorecard(text: string): ParsedFinancialPdf["scorecard"] {
  const pageBlock = (pageNumber: number): string => {
    const re = new RegExp(
      String.raw`(?:^|\n)---\s*OCR\s*PAGE\s*${pageNumber}\s*\(full\)\s*---\n([\s\S]*?)(?=\n---\s*OCR\s*PAGE\s*\d+\s*\(full\)\s*---|$)`,
      "i",
    );
    const m = text.match(re);
    return m?.[1] ?? text;
  };

  const page2 = pageBlock(2);
  const page8 = pageBlock(8);

  const pickLabeled = (label: string, source: string = text): number | undefined => {
    const re = new RegExp(`${label}\\s*([\\d.]+)`, "im");
    const m = source.match(re);
    if (!m) return undefined;
    const n = Number(m[1].replace(/,/g, ""));
    return Number.isFinite(n) ? n : undefined;
  };
  const pickPct = (label: string, source: string = text): number | undefined => {
    const re = new RegExp(`${label}\\s+([\\d.]+)\\s*%`, "im");
    const m = source.match(re);
    if (!m) return undefined;
    const n = Number(m[1].replace(/,/g, ""));
    return Number.isFinite(n) ? n : undefined;
  };

  const ratioWithRange = (
    label: string,
    source: string = text,
  ): { company?: number; industryMid?: number } => {
    const re = new RegExp(
      `${label}\\s+([\\d.]+)\\s+([\\d.]+)\\s+to\\s+([\\d.]+)`,
      "im",
    );
    const m = source.match(re);
    if (!m) return {};
    const a = Number(m[1]);
    const lo = Number(m[2]);
    const hi = Number(m[3]);
    if (![a, lo, hi].every((x) => Number.isFinite(x))) return {};
    return { company: a, industryMid: (lo + hi) / 2 };
  };

  /** Subject ratio + literal industry/benchmark ratio (not `low to high`). OCR: `Current Ratio 5.37 4.55`. */
  const ratioPairLiteral = (label: string, source: string = text): { company?: number; industry?: number } => {
    const re = new RegExp(
      `${label}\\s+([\\d.]+)\\s+([\\d.]+)(?!\\s*%)(?!\\s+to\\s)`,
      "im",
    );
    const m = source.match(re);
    if (!m) return {};
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (![a, b].every((x) => Number.isFinite(x) && x > 0)) return {};
    if (a > 80 || b > 80) return {};
    return { company: a, industry: b };
  };

  const twoPct = (label: string, source: string = text): { first?: number; second?: number } => {
    const two = new RegExp(`${label}\\s+([\\d.]+)\\s*%\\s+([\\d.]+)\\s*%`, "im");
    const m2 = source.match(two);
    if (m2) return { first: Number(m2[1]), second: Number(m2[2]) };
    const one = source.match(new RegExp(`${label}\\s+([\\d.]+)\\s*%`, "im"));
    if (one) return { first: Number(one[1]) };
    return {};
  };

  const crPage = ratioWithRange("Current Ratio", page2);
  const cr = crPage.company !== undefined || crPage.industryMid !== undefined ? crPage : ratioWithRange("Current Ratio");
  const crPairPage = ratioPairLiteral("Current Ratio", page2);
  const crPair = crPairPage.company !== undefined || crPairPage.industry !== undefined ? crPairPage : ratioPairLiteral("Current Ratio");
  const qrPage = ratioWithRange("Quick Ratio", page2);
  const qr = qrPage.company !== undefined || qrPage.industryMid !== undefined ? qrPage : ratioWithRange("Quick Ratio");
  const qrPairPage = ratioPairLiteral("Quick Ratio", page2);
  const qrPair = qrPairPage.company !== undefined || qrPairPage.industry !== undefined ? qrPairPage : ratioPairLiteral("Quick Ratio");
  const roePage = twoPct("Return on Equity", page8);
  const roe = roePage.first !== undefined || roePage.second !== undefined ? roePage : twoPct("Return on Equity");
  const roaPage = twoPct("Return on Assets", page8);
  const roa = roaPage.first !== undefined || roaPage.second !== undefined ? roaPage : twoPct("Return on Assets");

  return {
    currentRatio: cr.company ?? crPair.company ?? pickLabeled("Current Ratio", page2) ?? pickLabeled("Current Ratio"),
    quickRatio: qr.company ?? qrPair.company ?? pickLabeled("Quick Ratio", page2) ?? pickLabeled("Quick Ratio"),
    returnOnEquityPct: roe.first ?? pickPct("Return on Equity", page8) ?? pickPct("Return on Equity"),
    returnOnAssetsPct: roa.first ?? pickPct("Return on Assets", page8) ?? pickPct("Return on Assets"),
    currentRatioIndustryMid: cr.industryMid ?? crPair.industry,
    quickRatioIndustryMid: qr.industryMid ?? qrPair.industry,
    returnOnEquityIndustryPct: roe.second,
    returnOnAssetsIndustryPct: roa.second,
  };
}

/** Extract IBIS-style header row; dates may wrap to next line after OCR. */
function mergeCommonSizeHeader(lines: string[], idx: number): { header: string; firstDataLine: number } {
  let header = lines[idx] ?? "";
  let firstDataLine = idx + 1;
  for (let k = 1; k <= 3; k++) {
    if (/12\s*\/\s*31\s*\/\s*20\d{2}/i.test(header) && /industry/i.test(header)) break;
    const next = lines[idx + k] ?? "";
    if (!next) break;
    if (/^\d+%|\(\d+\)/.test(next.trim()) === false && next.length < 120) {
      header = `${header} ${next}`.replace(/\s+/g, " ").trim();
      firstDataLine = idx + k + 1;
    }
    if (/12\s*\/\s*31/i.test(header) && /industry/i.test(header)) break;
  }
  return { header, firstDataLine };
}

function industryColumnIndexFromHeader(header: string): number {
  const dates = Array.from(header.matchAll(/12\s*\/\s*31\s*\/\s*20\d{2}/gi));
  if (dates.length > 0) return dates.length;
  return 3;
}

/**
 * One physical row: `Cost of Sales (COGS) 34% 29% 32% 41%`
 */
function parseInlinePercentTokens(line: string): { label: string; parts: (number | null)[] } | null {
  const raw = line.replace(/\s+/g, " ").trim();
  if (!raw || raw.length > 240) return null;
  if (/^explanation[:]?|^=+ /.test(raw)) return null;

  const tokenRe = /(\d+(?:\.\d+)?)\s*%|(--|–|—|−−|\u2013\u2013)/g;
  const matches = Array.from(raw.matchAll(tokenRe));
  if (matches.length < 2) return null;

  const parts: (number | null)[] = [];
  for (const m of matches) {
    if (m[1] !== undefined) {
      const n = Number(m[1]);
      parts.push(Number.isFinite(n) ? n / 100 : null);
    } else parts.push(null);
  }

  const firstIdx = matches[0].index ?? 0;
  let label = raw.slice(0, firstIdx).trim();
  label = label.replace(/^\(\d+\)\s*/, "").replace(/\s*\(\d+\)\s*$/, "").trim();
  if (!label || label.length > 100) return null;

  return { label, parts };
}

function parseInlineCommonSizeSection(
  lines: string[],
  headerIdx: number,
  section: "is" | "bs",
): { values: Record<string, number>; industryIdx: number; endAt: number } {
  const { header, firstDataLine } = mergeCommonSizeHeader(lines, headerIdx);
  const industryIdx = industryColumnIndexFromHeader(header);
  const values: Record<string, number> = {};
  const used = new Set<string>();

  let i = firstDataLine;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();

    if (section === "is" && /^balance sheet data\b/i.test(t) && /12\s*\/\s*31/i.test(t) && /industry/i.test(t)) {
      break;
    }
    if (section === "bs" && /^income statement data\b/i.test(t) && /industry/i.test(t)) {
      break;
    }
    if (/^industry scorecard\b|^financial indicator\b|^notes to\b|^supplemental\b/i.test(t)) {
      break;
    }

    const parsed = parseInlinePercentTokens(line);
    if (!parsed) continue;
    if (industryIdx < 0 || industryIdx >= parsed.parts.length) continue;
    const ratio = parsed.parts[industryIdx];
    if (ratio === null || !Number.isFinite(ratio)) continue;

    let key = toFactKey(parsed.label);
    if (used.has(key)) key = `${key}_il`;
    used.add(key);
    values[key] = ratio;
  }

  return { values, industryIdx, endAt: i };
}

function findInlineCommonSizeHeaders(lines: string[]): { is?: number; bs?: number } {
  const out: { is?: number; bs?: number } = {};
  for (let i = 0; i < lines.length; i++) {
    const window = [lines[i], lines[i + 1] ?? "", lines[i + 2] ?? ""].join(" ");
    if (
      /income statement data\b/i.test(window) &&
      /industry\*?/i.test(window) &&
      /12\s*\/\s*31\s*\/\s*20\d{2}/i.test(window)
    ) {
      out.is = i;
    }
    if (
      /balance sheet data\b/i.test(window) &&
      /industry\*?/i.test(window) &&
      /12\s*\/\s*31\s*\/\s*20\d{2}/i.test(window)
    ) {
      out.bs = i;
    }
  }
  return out;
}

function mergeIndustryMaps(base: Record<string, number>, add: Record<string, number>): Record<string, number> {
  const out = { ...base };
  for (const [k, v] of Object.entries(add)) {
    out[k] = v;
  }
  return out;
}

/** Pull 12/31/20xx headers in order of appearance. */
export function extractYearHeaders(text: string): string[] {
  const re = /12\s*\/\s*31\s*\/\s*20\d{2}/g;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const norm = m[0].replace(/\s/g, "");
    if (!seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out.slice(0, 3);
}

export function parseFinancialTablesFromText(fullText: string): ParsedFinancialPdf {
  const lines = fullText
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const facts: Record<string, YearSeries> = {};
  const usedKeys = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const label = lines[i];
    if (/^page\s+\d+/i.test(label)) continue;
    if (!label || label.length > 120) continue;

    const a = parseMoneyLine(lines[i + 1] ?? "");
    const b = parseMoneyLine(lines[i + 2] ?? "");
    const c = parseMoneyLine(lines[i + 3] ?? "");
    if (a === null || b === null || c === null) continue;

    let key = toFactKey(label);
    if (usedKeys.has(key)) {
      key = `${key}_dup`;
    }
    usedKeys.add(key);
    facts[key] = [a, b, c];
    i += 3;
  }

  const industryCol = detectIndustryPercentColumn(lines);
  const industryCommonSize: Record<string, number> = {};
  const pctUsed = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const label = lines[i];
    if (/^page\s+\d+/i.test(label)) continue;
    if (!label || label.length > 120) continue;

    const pa = parsePercentRatioLine(lines[i + 1] ?? "");
    const pb = parsePercentRatioLine(lines[i + 2] ?? "");
    const pc = parsePercentRatioLine(lines[i + 3] ?? "");
    if (pa === null || pb === null || pc === null) continue;

    let key = toFactKey(label);
    if (pctUsed.has(key)) {
      key = `${key}_pctdup`;
    }
    pctUsed.add(key);
    const triplet = [pa, pb, pc] as const;
    industryCommonSize[key] = triplet[Math.min(industryCol, 2) as 0 | 1 | 2];
    i += 3;
  }

  const inlineHdr = findInlineCommonSizeHeaders(lines);
  let mergedIndustry = { ...industryCommonSize };
  let inlineIndustryIdx: number = industryCol;

  if (inlineHdr.is !== undefined) {
    const r = parseInlineCommonSizeSection(lines, inlineHdr.is, "is");
    mergedIndustry = mergeIndustryMaps(mergedIndustry, r.values);
    inlineIndustryIdx = r.industryIdx;
  }
  if (inlineHdr.bs !== undefined) {
    const r = parseInlineCommonSizeSection(lines, inlineHdr.bs, "bs");
    mergedIndustry = mergeIndustryMaps(mergedIndustry, r.values);
    inlineIndustryIdx = r.industryIdx;
  }

  const { industry, naics } = extractMeta(fullText);
  const scorecard = extractScorecard(fullText);
  const yearLabels = extractYearHeaders(fullText);

  return {
    industry,
    naics,
    facts,
    yearLabels,
    scorecard,
    industryCommonSize: Object.keys(mergedIndustry).length ? mergedIndustry : undefined,
    industryCommonSizeColumn: Object.keys(mergedIndustry).length ? inlineIndustryIdx : undefined,
    rawTextSample: fullText.slice(0, 1200),
  };
}
