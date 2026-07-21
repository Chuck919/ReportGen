import { computeWorkbookFormulas } from "@/lib/tax/workbook-formulas";
import type { TaxYearValues } from "@/lib/tax-workbook";
import { buildNaicsBenchmarkProfile } from "@/lib/valuation/benchmark-naics";
import type { NaicsBenchmarkProfile } from "@/lib/valuation/types";

function parsePctString(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/([\d.]+)\s*%/);
  return match ? parseFloat(match[1]) / 100 : undefined;
}

function benchmarkPct(profile: NaicsBenchmarkProfile, label: string): number | undefined {
  const row = profile.benchmarkRows.find((entry) => entry.label === label);
  return parsePctString(row?.value);
}

function money(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(
    value,
  );
}

function formatPct(value: number | undefined, digits = 0): string {
  if (value === undefined || !Number.isFinite(value)) return "";
  return `${(value * 100).toFixed(digits)}%`;
}

function compareToBenchmark(subjectPct: number | undefined, benchPct: number | undefined): string {
  if (subjectPct === undefined || benchPct === undefined) return "in line with benchmarks";
  const diffPts = Math.round(Math.abs(subjectPct - benchPct) * 100);
  if (diffPts < 1) return "in line with benchmarks";
  const direction = subjectPct > benchPct ? "above" : "below";
  return `${diffPts}% ${direction} benchmark`;
}

type YearSnapshot = {
  year: number;
  sales: number;
  cogs: number;
  gaWages: number;
  officerComp: number;
  rent: number;
  otherOverhead: number;
  npbt: number;
  ebitda: number;
  cogsPct: number | undefined;
  gaWagesPct: number | undefined;
  officerPct: number | undefined;
  cogsGaPct: number | undefined;
  rentPct: number | undefined;
  otherOverheadPct: number | undefined;
  niPct: number | undefined;
  ebitdaPct: number | undefined;
};

function buildYearSnapshots(columns: TaxYearValues[]): YearSnapshot[] {
  return [...columns]
    .sort((a, b) => a.year - b.year)
    .map((column) => {
      const raw = column.workbookValues ?? column.values;
      const comp = computeWorkbookFormulas(raw);
      const sales = raw.sales ?? comp.sales ?? 0;
      const cogs = raw.cogs ?? comp.cogs ?? 0;
      const gaWages = raw.salaries_wages ?? 0;
      const officerComp = raw.officer_compensation ?? 0;
      const rent = raw.rent ?? 0;
      const otherOverhead =
        raw.other_operating_expenses ?? comp.overhead_sga ?? comp.other_operating_expenses ?? 0;
      const npbt =
        raw.adjusted_net_profit_before_taxes ??
        raw.net_profit_before_taxes ??
        comp.adjusted_net_profit_before_taxes ??
        comp.net_profit_before_taxes ??
        0;
      const ebitda = Math.round(
        npbt + (raw.depreciation ?? 0) + (raw.amortization ?? 0) + (raw.interest_expense ?? 0),
      );
      const pctOfSales = (amount: number) => (sales > 0 ? amount / sales : undefined);

      return {
        year: column.year,
        sales,
        cogs,
        gaWages,
        officerComp,
        rent,
        otherOverhead,
        npbt,
        ebitda,
        cogsPct: pctOfSales(cogs),
        gaWagesPct: pctOfSales(gaWages),
        officerPct: pctOfSales(officerComp),
        cogsGaPct: pctOfSales(cogs + gaWages),
        rentPct: pctOfSales(rent),
        otherOverheadPct: pctOfSales(otherOverhead),
        niPct: pctOfSales(npbt),
        ebitdaPct: pctOfSales(ebitda),
      };
    });
}

function rangePctLabel(values: (number | undefined)[], digits = 0): string {
  const filtered = values.filter((value): value is number => value !== undefined && Number.isFinite(value));
  if (filtered.length === 0) return "";
  const min = Math.min(...filtered);
  const max = Math.max(...filtered);
  if (Math.abs(min - max) < 0.001) return formatPct(min, digits);
  return `${formatPct(min, digits)} to ${formatPct(max, digits)}`;
}

function revenueTrendNarrative(snapshots: YearSnapshot[]): string {
  if (snapshots.length === 0) return "";
  if (snapshots.length === 1) {
    return `Revenue for the period reviewed was ${money(snapshots[0]!.sales)} in ${snapshots[0]!.year}.`;
  }
  const first = snapshots[0]!;
  const last = snapshots[snapshots.length - 1]!;
  const change = last.sales - first.sales;
  if (change === 0) {
    return `Revenues remained relatively stable during the period of review at ${money(first.sales)} in ${first.year}.`;
  }
  const verb = change > 0 ? "increased" : "declined";
  return `Revenues have ${verb} during the period of review, going from ${money(first.sales)} in ${first.year} to ${money(last.sales)} in ${last.year}.`;
}

function cogsNarrative(snapshots: YearSnapshot[], benchCogs: number | undefined): string {
  const latest = snapshots[snapshots.length - 1];
  if (!latest?.cogsPct) return "";
  const benchLabel = benchCogs !== undefined ? formatPct(benchCogs, 0) : "industry benchmarks";
  const latestPct = formatPct(latest.cogsPct, 0);
  const range = rangePctLabel(
    snapshots.map((snapshot) => snapshot.cogsPct),
    0,
  );
  const rangeSuffix =
    range && range !== latestPct ? ` COGS ranges from ${range} of revenues.` : "";
  return `Industry benchmarks for COGS are ${benchLabel} of revenues. Subject reports ${latestPct} of revenues in Cost of Goods Sold in the most recent period.${rangeSuffix}`;
}

function wagesNarrative(snapshots: YearSnapshot[], benchGa: number | undefined): string {
  const benchLabel = benchGa !== undefined ? formatPct(benchGa, 0) : "industry benchmarks";
  const gaRange = rangePctLabel(
    snapshots.map((snapshot) => snapshot.gaWagesPct),
    0,
  );
  const officerRange = rangePctLabel(
    snapshots.map((snapshot) => snapshot.officerPct),
    0,
  );
  const parts = [`Benchmarks for wage expense are ${benchLabel} of revenues.`];
  if (gaRange) {
    parts.push(`For the subject business, wage expense ranges from ${gaRange} of revenues.`);
  }
  if (officerRange && snapshots.some((snapshot) => snapshot.officerComp > 0)) {
    parts.push(
      `This does not include officer compensation, which ranges from ${officerRange} of revenues.`,
    );
  }
  return parts.join("  ");
}

function cogsGaParentNarrative(benchCogs: number | undefined, benchGa: number | undefined): string {
  const cogsLabel = benchCogs !== undefined ? formatPct(benchCogs, 0) : "COGS";
  const gaLabel = benchGa !== undefined ? formatPct(benchGa, 0) : "G&A wages";
  const combined =
    benchCogs !== undefined && benchGa !== undefined
      ? formatPct(benchCogs + benchGa, 0)
      : "the combined benchmark";
  return `Perhaps the best comparison would be COGS plus G&A wages. Benchmarks are ${cogsLabel} (COGS) plus ${gaLabel} (G&A wages) for a total of ${combined}. For the subject:`;
}

function cogsGaYearBullet(snapshot: YearSnapshot, benchCombined: number | undefined): string {
  if (snapshot.cogsGaPct === undefined) return "";
  const subjectLabel = formatPct(snapshot.cogsGaPct, 0);
  if (benchCombined === undefined) return `${snapshot.year} — ${subjectLabel}`;

  const diffPts = Math.round(Math.abs(snapshot.cogsGaPct - benchCombined) * 100);
  if (diffPts < 1) return `${snapshot.year} — ${subjectLabel}`;

  const direction = snapshot.cogsGaPct > benchCombined ? "above" : "below";
  let comparison = ` (${diffPts}% ${direction} benchmark`;
  if (snapshot.officerPct !== undefined && snapshot.officerComp > 0) {
    comparison += `, not including officer compensation at ${formatPct(snapshot.officerPct, 0)}`;
  }
  comparison += ")";
  return `${snapshot.year} — ${subjectLabel}${comparison}`;
}

function rentNarrative(latest: YearSnapshot | undefined, benchRent: number | undefined): string {
  if (!latest?.rentPct) return "";
  const subjectLabel = formatPct(latest.rentPct, 0);
  const benchLabel = benchRent !== undefined ? formatPct(benchRent, 0) : "industry benchmarks";
  const comparison = compareToBenchmark(latest.rentPct, benchRent);
  if (comparison.includes("above") || comparison.includes("below")) {
    return `Rent expenses are ${subjectLabel} of revenues, which is ${comparison} (${benchLabel} of revenues).`;
  }
  return `Rent expenses are ${subjectLabel} of revenues, which is ${comparison}.`;
}

function otherOverheadNarrative(latest: YearSnapshot | undefined, benchOther: number | undefined): string {
  if (!latest?.otherOverheadPct || benchOther === undefined) {
    return "Other non-wage overhead expenses appear to be mostly similar to industry benchmarks.";
  }
  const diffPts = Math.abs(latest.otherOverheadPct - benchOther) * 100;
  if (diffPts <= 3) {
    return "Other non-wage overhead expenses appear to be mostly similar to industry benchmarks.";
  }
  return `Other non-wage overhead expenses are ${formatPct(latest.otherOverheadPct, 0)} of revenues, ${compareToBenchmark(latest.otherOverheadPct, benchOther)}.`;
}

function niEbitdaParentNarrative(benchNi: number | undefined, benchEbitda: number | undefined): string {
  const niLabel = benchNi !== undefined ? formatPct(benchNi, 0) : "industry net income";
  const ebitdaLabel = benchEbitda !== undefined ? formatPct(benchEbitda, 0) : "industry EBITDA";
  return `Benchmarks for net income (before taxes) are ${niLabel} and EBITDA benchmarks are ${ebitdaLabel}.`;
}

function niEbitdaYearBullet(snapshot: YearSnapshot): string {
  const ni = snapshot.niPct !== undefined ? formatPct(snapshot.niPct, 0) : "";
  const ebitda = snapshot.ebitdaPct !== undefined ? formatPct(snapshot.ebitdaPct, 0) : "";
  if (!ni && !ebitda) return "";
  return `${snapshot.year} net income ${ni}${ebitda ? `, EBITDA ${ebitda}` : ""}`;
}

function earningsGenerationNarrative(
  snapshots: YearSnapshot[],
  benchNi: number | undefined,
  benchEbitda: number | undefined,
): string {
  const latest = snapshots[snapshots.length - 1];
  if (!latest) return "";

  const aboveNi = benchNi !== undefined && (latest.niPct ?? 0) > benchNi * 1.1;
  const aboveEbitda = benchEbitda !== undefined && (latest.ebitdaPct ?? 0) > benchEbitda * 1.1;
  const belowNi = benchNi !== undefined && (latest.niPct ?? 0) < benchNi * 0.9;
  const belowEbitda = benchEbitda !== undefined && (latest.ebitdaPct ?? 0) < benchEbitda * 0.9;

  if (aboveNi || aboveEbitda) {
    return "Subject business appears to be generating earnings at a higher rate than benchmarks indicate.";
  }
  if (belowNi || belowEbitda) {
    return "Subject business appears to be generating earnings at a lower rate than benchmarks indicate.";
  }
  return "Subject business earnings appear generally in line with industry benchmarks.";
}

function annualizedIntro(snapshots: YearSnapshot[]): string {
  if (snapshots.length === 0) return "";
  const years = snapshots.map((snapshot) => snapshot.year).join(", ");
  return `The following compares annualized income statement figures from tax returns (${years}) to industry common-size benchmarks.`;
}

export type IncomeStatementNarrativeFields = {
  IS_Annualized: string;
  IS_Rev: string;
  IS_COGS: string;
  IS_GA_Wages: string;
  IS_COGS__GA_Wages: string;
  IS_COGS__GA_CY: string;
  IS_COGS__GA_Y1: string;
  IS_COGS__GA_Y2: string;
  IS_COGS__GA_Y3: string;
  IS_COGS__GA_Y4: string;
  IS_Rent_Expenses: string;
  IS_Other_Overhead: string;
  IS_Net_IncomeEBITDA: string;
  IS_NIEBITDA_CY: string;
  IS_NIEBITDA_Y1: string;
  IS_NIEBITDA_Y2: string;
  IS_NIEBITDA_Y3: string;
  IS_NIEBITDA_Y4: string;
  IS_Earnings_Generation: string;
};

/** Rule-based benchmark narrative for Main Current IS_* list merge fields (no Groq). */
export function buildIncomeStatementNarrativeFields(
  columns: TaxYearValues[],
  naics?: string,
): IncomeStatementNarrativeFields {
  const profile = buildNaicsBenchmarkProfile(naics);
  const benchCogs = benchmarkPct(profile, "COGS");
  const benchGa = benchmarkPct(profile, "G&A Wages");
  const benchRent = benchmarkPct(profile, "Rent Expenses");
  const benchOther = benchmarkPct(profile, "Other Operating Expenses");
  const benchNi = benchmarkPct(profile, "Net Income");
  const benchEbitda = benchmarkPct(profile, "EBITDA");
  const benchCombined =
    benchCogs !== undefined && benchGa !== undefined ? benchCogs + benchGa : undefined;

  const snapshots = buildYearSnapshots(columns);
  const latest = snapshots[snapshots.length - 1];

  const cogsGaYear = (offsetFromLatest: number) => {
    const index = snapshots.length - 1 - offsetFromLatest;
    if (index < 0) return "";
    return cogsGaYearBullet(snapshots[index]!, benchCombined);
  };

  const niEbitdaYear = (offsetFromLatest: number) => {
    const index = snapshots.length - 1 - offsetFromLatest;
    if (index < 0) return "";
    return niEbitdaYearBullet(snapshots[index]!);
  };

  return {
    IS_Annualized: annualizedIntro(snapshots),
    IS_Rev: revenueTrendNarrative(snapshots),
    IS_COGS: cogsNarrative(snapshots, benchCogs),
    IS_GA_Wages: wagesNarrative(snapshots, benchGa),
    IS_COGS__GA_Wages: cogsGaParentNarrative(benchCogs, benchGa),
    IS_COGS__GA_CY: cogsGaYear(0),
    IS_COGS__GA_Y1: cogsGaYear(1),
    IS_COGS__GA_Y2: cogsGaYear(2),
    IS_COGS__GA_Y3: cogsGaYear(3),
    IS_COGS__GA_Y4: cogsGaYear(4),
    IS_Rent_Expenses: rentNarrative(latest, benchRent),
    IS_Other_Overhead: otherOverheadNarrative(latest, benchOther),
    IS_Net_IncomeEBITDA: niEbitdaParentNarrative(benchNi, benchEbitda),
    IS_NIEBITDA_CY: niEbitdaYear(0),
    IS_NIEBITDA_Y1: niEbitdaYear(1),
    IS_NIEBITDA_Y2: niEbitdaYear(2),
    IS_NIEBITDA_Y3: niEbitdaYear(3),
    IS_NIEBITDA_Y4: niEbitdaYear(4),
    IS_Earnings_Generation: earningsGenerationNarrative(snapshots, benchNi, benchEbitda),
  };
}
