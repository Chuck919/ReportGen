import { cacheGet, cacheSet, throttleHost } from "@/lib/valuation/cache";
import { escapeSvg, truncateLabel } from "@/lib/valuation/chart-svg-utils";
import type { MacroMetric, MacroSeries, MacroSeriesPoint, MacroSnapshot, SourceTag } from "@/lib/valuation/types";

const DAY_MS = 24 * 60 * 60 * 1000;

function hasKey(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function formatPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "";
  return `${value.toFixed(1)}%`;
}

function formatNumber(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "";
  return Math.round(value).toLocaleString();
}

function formatCurrency(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

async function fetchJson<T>(url: string, host: string, minSpacingMs: number, ttlMs: number, init?: RequestInit): Promise<T> {
  const cached = cacheGet<T>(url);
  if (cached) return cached;
  await throttleHost(host, minSpacingMs);
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`${host} request failed (${res.status})`);
  }
  const json = (await res.json()) as T;
  return cacheSet(url, json, ttlMs);
}

async function fetchText(url: string, host: string, minSpacingMs: number, ttlMs: number): Promise<string> {
  const cached = cacheGet<string>(url);
  if (cached) return cached;
  await throttleHost(host, minSpacingMs);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${host} request failed (${res.status})`);
  }
  const text = await res.text();
  return cacheSet(url, text, ttlMs);
}

function parseFredCsv(text: string, seriesId: string, label: string, source: SourceTag): MacroSeries {
  const points: MacroSeriesPoint[] = [];
  for (const rawLine of text.trim().split(/\r?\n/).slice(1)) {
    const [date, valueRaw] = rawLine.split(",");
    if (!date || !valueRaw || valueRaw === ".") continue;
    const value = Number(valueRaw);
    if (!Number.isFinite(value)) continue;
    points.push({ date, value });
  }
  return { label, seriesId, points, source };
}

export async function fredSeries(seriesId: string, label: string): Promise<MacroSeries> {
  const key = hasKey("FRED_API_KEY");
  const source: SourceTag = {
    label: `FRED ${seriesId}`,
    url: `https://fred.stlouisfed.org/series/${seriesId}`,
  };
  if (key) {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${key}&file_type=json&observation_start=${new Date(
      Date.now() - 16 * 365 * DAY_MS,
    )
      .toISOString()
      .slice(0, 10)}`;
    const json = await fetchJson<{ observations: Array<{ date: string; value: string }> }>(
      url,
      "api.stlouisfed.org",
      600,
      DAY_MS,
    );
    return {
      label,
      seriesId,
      points: json.observations
        .filter((row) => row.value !== ".")
        .map((row) => ({ date: row.date, value: Number(row.value) }))
        .filter((row) => Number.isFinite(row.value)),
      source,
    };
  }

  const csv = await fetchText(
    `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}&cosd=${new Date(Date.now() - 16 * 365 * DAY_MS)
      .toISOString()
      .slice(0, 10)}`,
    "fred.stlouisfed.org",
    600,
    DAY_MS,
  );
  return parseFredCsv(csv, seriesId, label, source);
}

async function censusUsMetrics(): Promise<{
  population?: number;
  households?: number;
  medianHouseholdIncome?: number;
}> {
  const key = hasKey("CENSUS_API_KEY");
  if (!key) return {};
  const url =
    "https://api.census.gov/data/2023/acs/acs1?get=B01003_001E,B11001_001E,B19013_001E&for=us:1&key=" +
    key;
  const json = await fetchJson<string[][]>(url, "api.census.gov", 250, 7 * DAY_MS);
  const row = json[1];
  if (!row) return {};
  return {
    population: Number(row[0]),
    households: Number(row[1]),
    medianHouseholdIncome: Number(row[2]),
  };
}

async function censusMetroMetrics(cbsaCode?: string): Promise<{
  population?: number;
  households?: number;
  medianHouseholdIncome?: number;
  medianAge?: number;
  medianHomeValue?: number;
}> {
  const key = hasKey("CENSUS_API_KEY");
  if (!key || !cbsaCode) return {};
  const geo = encodeURIComponent(`metropolitan statistical area/micropolitan statistical area:${cbsaCode}`);
  const url =
    `https://api.census.gov/data/2023/acs/acs1?get=B01003_001E,B11001_001E,B19013_001E,B01002_001E,B25077_001E&for=${geo}&key=${key}`;
  const json = await fetchJson<string[][]>(url, "api.census.gov", 250, 30 * DAY_MS);
  const row = json[1];
  if (!row) return {};
  return {
    population: Number(row[0]),
    households: Number(row[1]),
    medianHouseholdIncome: Number(row[2]),
    medianAge: Number(row[3]),
    medianHomeValue: Number(row[4]),
  };
}

async function beaMetroMetrics(cbsaCode?: string): Promise<{
  pcpi?: number;
}> {
  const key = hasKey("BEA_API_KEY");
  if (!key || !cbsaCode) return {};
  const url =
    // BEA Regional expects the 5-digit CBSA code for MSA geofips (no "MSA" prefix).
    `https://apps.bea.gov/api/data/?UserID=${key}&method=GetData&datasetname=Regional&TableName=CAINC1&LineCode=3&GeoFips=${cbsaCode}&Year=LAST5&ResultFormat=JSON`;
  const json = await fetchJson<{
    BEAAPI?: { Results?: { Data?: Array<{ DataValue: string }>; Error?: { APIErrorDescription?: string } } };
  }>(
    url,
    "apps.bea.gov",
    700,
    7 * DAY_MS,
  );
  // BEA sometimes returns HTTP 200 with an error payload.
  const err = json.BEAAPI?.Results?.Error?.APIErrorDescription;
  if (err) return {};
  const values =
    json.BEAAPI?.Results?.Data?.map((row) => Number(String(row.DataValue).replace(/,/g, ""))).filter((value) => Number.isFinite(value)) ?? [];
  const latest = values[values.length - 1];
  return { pcpi: latest };
}

function latest(series: MacroSeries): number | undefined {
  return series.points[series.points.length - 1]?.value;
}

function pctChangeOverWindow(series: MacroSeries, yearsBack = 5): number | undefined {
  if (series.points.length < 2) return undefined;
  const last = series.points[series.points.length - 1];
  if (!last) return undefined;
  const anchorDate = `${Number(last.date.slice(0, 4)) - yearsBack}${last.date.slice(4)}`;
  const first = [...series.points].reverse().find((point) => point.date <= anchorDate) ?? series.points[0];
  if (!first || !first.value) return undefined;
  return ((last.value - first.value) / first.value) * 100;
}

export function seriesToSvg(series: MacroSeries, color = "#44403c"): string {
  const width = 720;
  const height = 220;
  const pad = 28;
  if (!series.points.length) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#fafaf9"/><text x="24" y="40" fill="#57534e" font-size="16">No chart data available.</text></svg>`;
  }
  const min = Math.min(...series.points.map((point) => point.value));
  const max = Math.max(...series.points.map((point) => point.value));
  const range = Math.max(max - min, 1);
  const stepX = (width - pad * 2) / Math.max(series.points.length - 1, 1);
  const path = series.points
    .map((point, index) => {
      const x = pad + index * stepX;
      const y = height - pad - ((point.value - min) / range) * (height - pad * 2);
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" fill="#fafaf9" rx="14"/>`,
    `<line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="#d6d3d1" stroke-width="1"/>`,
    `<line x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}" stroke="#d6d3d1" stroke-width="1"/>`,
    `<path d="${path}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,
    `<text x="${pad}" y="18" fill="#44403c" font-size="14" font-family="Arial, sans-serif">${escapeSvg(truncateLabel(series.label, 48))}</text>`,
    `<text x="${pad}" y="${height - 8}" fill="#78716c" font-size="12" font-family="Arial, sans-serif">${series.points[0]?.date.slice(0, 4)} - ${series.points[series.points.length - 1]?.date.slice(0, 4)}</text>`,
    `<text x="${width - pad}" y="18" text-anchor="end" fill="#44403c" font-size="14" font-family="Arial, sans-serif">${latest(series)?.toLocaleString() ?? ""}</text>`,
    `</svg>`,
  ].join("");
}

export async function buildNationalMacroSnapshot(): Promise<MacroSnapshot> {
  const [unemployment, treasury20, cpi, gdp] = await Promise.all([
    fredSeries("UNRATE", "U.S. unemployment rate"),
    fredSeries("DGS20", "20-year Treasury yield"),
    fredSeries("CPIAUCSL", "Consumer Price Index"),
    fredSeries("GDPC1", "Real GDP (billions chained 2017$)"),
  ]);
  const census = await censusUsMetrics();

  const metrics: MacroMetric[] = [
    { label: "Population", value: formatNumber(census.population), source: { label: "Census ACS", url: "https://api.census.gov/" } },
    { label: "Households", value: formatNumber(census.households), source: { label: "Census ACS", url: "https://api.census.gov/" } },
    { label: "Median household income", value: formatCurrency(census.medianHouseholdIncome), source: { label: "Census ACS", url: "https://api.census.gov/" } },
    { label: "Unemployment", value: formatPercent(latest(unemployment)), source: unemployment.source },
    { label: "20-year Treasury", value: formatPercent(latest(treasury20)), source: treasury20.source },
    { label: "5-year CPI change", value: formatPercent(pctChangeOverWindow(cpi, 5)), source: cpi.source },
  ];

  return {
    areaLabel: "United States",
    metrics,
    observations: [
      `National unemployment is ${formatPercent(latest(unemployment)) || "not available"}, providing a broad labor-market anchor for the valuation date.`,
      `The 20-year Treasury yield is ${formatPercent(latest(treasury20)) || "not available"}, which can be used as the starting point for the risk-free rate.`,
      `Consumer prices changed approximately ${formatPercent(pctChangeOverWindow(cpi, 5)) || "n/a"} over the last five years in the retrieved series window.`,
    ],
    charts: [
      { id: "national-unemployment", title: "National unemployment (15y)", series: unemployment },
      { id: "national-treasury", title: "20-year Treasury yield (15y)", series: treasury20 },
      { id: "national-cpi", title: "Consumer Price Index (15y)", series: cpi },
      { id: "national-gdp", title: "Real GDP trend (15y)", series: gdp },
    ],
  };
}

export async function buildMsaMacroSnapshot(input: { msaLabel?: string; cbsaCode?: string }): Promise<MacroSnapshot> {
  const [metroUnemployment, metroCensus, metroBea] = await Promise.all([
    fredSeries("UNRATE", "Unemployment rate (proxy)"),
    censusMetroMetrics(input.cbsaCode),
    beaMetroMetrics(input.cbsaCode),
  ]);

  const areaLabel = input.msaLabel?.trim() || "Selected local market";
  const metrics: MacroMetric[] = [
    { label: "Population", value: formatNumber(metroCensus.population), source: { label: "Census ACS", url: "https://api.census.gov/" } },
    { label: "Households", value: formatNumber(metroCensus.households), source: { label: "Census ACS", url: "https://api.census.gov/" } },
    { label: "Median household income", value: formatCurrency(metroCensus.medianHouseholdIncome), source: { label: "Census ACS", url: "https://api.census.gov/" } },
    { label: "Median age", value: metroCensus.medianAge ? metroCensus.medianAge.toFixed(1) : "", source: { label: "Census ACS", url: "https://api.census.gov/" } },
    { label: "Median home value", value: formatCurrency(metroCensus.medianHomeValue), source: { label: "Census ACS", url: "https://api.census.gov/" } },
    { label: "Per-capita personal income", value: formatCurrency(metroBea.pcpi), source: { label: "BEA Regional", url: "https://apps.bea.gov/API/signup/index.html" } },
    { label: "Unemployment", value: formatPercent(latest(metroUnemployment)), source: metroUnemployment.source },
  ];

  const missingLocal = !input.cbsaCode;
  return {
    areaLabel,
    metrics,
    observations: missingLocal
      ? [
          "Local market metrics are running in proxy mode because no CBSA code was supplied. The user should confirm the metro before issuance.",
          `A local unemployment proxy of ${formatPercent(latest(metroUnemployment)) || "n/a"} is shown until a CBSA code is confirmed.`,
        ]
      : [
          `${areaLabel} shows a retrieved unemployment rate of ${formatPercent(latest(metroUnemployment)) || "n/a"} in the current series window.`,
          `Retrieved median household income is ${formatCurrency(metroCensus.medianHouseholdIncome) || "n/a"}, with per-capita personal income at ${formatCurrency(metroBea.pcpi) || "n/a"}.`,
        ],
    charts: [{ id: "msa-unemployment", title: `${areaLabel} unemployment chart`, series: metroUnemployment }],
  };
}
