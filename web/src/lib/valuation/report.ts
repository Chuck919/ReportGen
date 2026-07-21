import { computeWorkbookFormulas } from "@/lib/tax/workbook-formulas";
import type { TaxYearValues } from "@/lib/tax-workbook";
import { buildNaicsBenchmarkProfile } from "@/lib/valuation/benchmark-naics";
import { buildFinancialFactBullets, draftReportNarrativeBatched } from "@/lib/valuation/ai-narrative";
import { buildBalanceSheetFootnotes } from "@/lib/valuation/balance-sheet-footnotes";
import { buildCompanyNarrativeContext } from "@/lib/valuation/company-profile";
import { formatLegalEntityName, deriveEntityAbbreviation } from "@/lib/valuation/integrator-workbook";
import { enrichValuationInputsFromLiveData, latestSde } from "@/lib/valuation/enrich-valuation-inputs";
import { lookupOrgEntity } from "@/lib/valuation/filed-org-lookup";
import { inferValuationInputs } from "@/lib/valuation/defaults";
import { buildMarketMultiplesProfile } from "@/lib/valuation/market-multiples";
import { buildMsaMacroSnapshot, buildNationalMacroSnapshot, seriesToSvg } from "@/lib/valuation/macro-data";
import { buildValuationMath } from "@/lib/valuation/math";
import { buildSbaMarketContext } from "@/lib/valuation/sba-market-context";
import { buildCoverPageSvg, buildFinancialTrendCharts, buildMacroMetricCharts } from "@/lib/valuation/valuation-charts";
import { buildBenchmarkVisualCharts } from "@/lib/valuation/valuation-benchmark-visuals";
import type {
  GenerateValuationRequest,
  GenerateValuationResponse,
  ReportSection,
  SourceTag,
  ValuationChecklistItem,
} from "@/lib/valuation/types";

function latestColumn(columns: TaxYearValues[]): TaxYearValues {
  return [...columns].sort((a, b) => a.year - b.year)[columns.length - 1]!;
}

function money(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function number(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return Math.round(value).toLocaleString();
}

function sourceLine(label: string, url?: string, detail?: string): SourceTag {
  return { label, url, detail };
}

function chartBlocks(charts: Array<{ id: string; title: string; svg: string }>) {
  return charts.map((chart) => ({
    kind: "chart" as const,
    id: chart.id,
    title: chart.title,
    svg: chart.svg,
    sources: [sourceLine("ReportGen charts", undefined, "Generated from session tax + macro data.")],
  }));
}

function yearRows(columns: TaxYearValues[]): string[][] {
  return [...columns]
    .sort((a, b) => a.year - b.year)
    .map((column) => {
      const computed = computeWorkbookFormulas(column.workbookValues ?? column.values);
      return [
        String(column.year),
        money(computed.sales),
        money(computed.cogs),
        money(computed.gross_profit),
        money(computed.net_profit_before_taxes),
        money(computed.total_assets),
        money(computed.total_liabilities),
      ];
    });
}

export async function buildValuationReport(
  input: GenerateValuationRequest,
): Promise<GenerateValuationResponse> {
  const columns = input.columns;
  const latest = latestColumn(columns);
  const latestComputed = computeWorkbookFormulas(latest.workbookValues ?? latest.values);
  const benchmark = buildNaicsBenchmarkProfile(input.naics);

  let companyProfile = input.companyProfile;
  if (companyProfile && !companyProfile.entityFileNumber && companyProfile.entityState.trim()) {
    const org = await lookupOrgEntity({
      entityName: input.entityName?.trim() || latest.clientName || "",
      state: companyProfile.entityState,
    });
    if (org) {
      companyProfile = {
        ...companyProfile,
        entityFileNumber: org.fileNumber || companyProfile.entityFileNumber,
        entityFormationDate: org.formationDate || companyProfile.entityFormationDate,
      };
    }
  }

  const balanceSheetFootnotes =
    input.balanceSheetFootnotes ?? buildBalanceSheetFootnotes(columns, companyProfile);

  const baseDraft = {
    ...inferValuationInputs(columns),
    ...(input.valuationAssumptions ?? input.excelAssumptions ?? {}),
    fieldSources: {
      ...inferValuationInputs(columns).fieldSources,
      ...(input.valuationAssumptions ?? input.excelAssumptions)?.fieldSources,
    },
  };
  const enrichedInputs = await enrichValuationInputsFromLiveData(columns, baseDraft);

  const sbaContext = await buildSbaMarketContext({
    naics: input.naics,
    state: companyProfile?.entityState,
    sales: latestComputed.sales ?? 0,
    sde: latestSde(columns),
  });

  const [national, msa, market] = await Promise.all([
    buildNationalMacroSnapshot(),
    buildMsaMacroSnapshot({ msaLabel: input.msaLabel, cbsaCode: input.cbsaCode }),
    buildMarketMultiplesProfile({
      naics: input.naics,
      sales: latestComputed.sales ?? 0,
      ebitda: latestComputed.operating_profit ?? 0,
      sde: latestComputed.adjusted_net_profit_before_taxes ?? latestComputed.net_profit_before_taxes ?? 0,
    }),
  ]);

  const valuation = buildValuationMath({
    columns,
    market,
    valuationAssumptions: enrichedInputs,
    sourceTags: [market.source, sbaContext.source],
  });

  const entityName = formatLegalEntityName(input.entityName?.trim() || latest.clientName || "Subject Company");
  const purpose = input.purpose?.trim() || "SBA lending support";
  const engagingParty = input.engagingParty?.trim() || "To be confirmed";
  const issuanceDate = input.dateOfIssuance?.trim() || new Date().toISOString().slice(0, 10);

  const implicationBullets = [
    national.observations[0] ?? "",
    msa.observations[0] ?? "",
    benchmark.narrative[0] ?? "",
    ...sbaContext.narrativeBullets,
    `The current reconciled draft value is ${money(valuation.reconciledValue)}, before analyst review of discounts and cost-of-capital inputs.`,
  ].filter(Boolean);

  const financialBullets = buildFinancialFactBullets(columns);
  const companyContext =
    input.companyContext?.trim() ||
    (companyProfile ? buildCompanyNarrativeContext(companyProfile) : undefined);

  const normalizationBullets = [
    companyProfile?.normalizationNotes?.trim(),
    companyProfile?.relatedPartyRent?.trim() && `Related-party rent: ${companyProfile.relatedPartyRent.trim()}`,
    companyProfile?.ownerCompAdjustment?.trim() && `Owner comp adjustment: ${companyProfile.ownerCompAdjustment.trim()}`,
    companyProfile?.oneTimeItems?.trim() && `One-time items: ${companyProfile.oneTimeItems.trim()}`,
    companyProfile?.discretionaryExpenses?.trim() && `Discretionary expenses: ${companyProfile.discretionaryExpenses.trim()}`,
  ].filter(Boolean) as string[];

  const { draft: narrative, provider: narrativeProvider } = await draftReportNarrativeBatched(
    {
      entityName,
      purpose,
      engagingParty,
      naics: input.naics,
      naicsTitle: benchmark.title,
      msaLabel: msa.areaLabel,
      companyContext,
      normalizationBullets,
      sbaMarketBullets: sbaContext.narrativeBullets,
      valuationDate: `${latest.year}-12-31`,
      issuanceDate,
      taxYears: columns.map((column) => column.year).sort((a, b) => a - b),
      reconciledValue: money(valuation.reconciledValue),
      capitalizationRate: `${(valuation.capitalizationRate * 100).toFixed(2)}%`,
      normalizedEarnings: money(valuation.normalizedEarnings),
      tangibleAssetValue: money(valuation.tangibleAssetValue),
      intangibleValue: money(valuation.intangibleValue),
      implicationBullets,
      financialBullets,
      sources: [market.source, ...benchmark.sources],
      columns,
    },
    { useAi: input.useGroq },
  );

  const financialCharts = buildFinancialTrendCharts(columns);
  const macroMetricCharts = buildMacroMetricCharts({
    nationalMetrics: national.metrics.map((metric) => ({ label: metric.label, value: metric.value })),
    msaMetrics: msa.metrics.map((metric) => ({ label: metric.label, value: metric.value })),
    msaLabel: msa.areaLabel,
  });
  const benchmarkVisuals = buildBenchmarkVisualCharts({
    columns,
    benchmark,
    valuation,
    marketMetrics: market.metrics.map((metric) => ({
      name: metric.name,
      multiple: metric.multiple,
      impliedValue: metric.impliedValue,
    })),
  });
  const coverGraphic = buildCoverPageSvg(entityName, valuation.reconciledValue);
  const purposeSummarySvg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="120">`,
    `<rect width="100%" height="100%" fill="#fafaf9" stroke="#d6d3d1"/>`,
    `<text x="24" y="42" font-size="14" font-family="Arial,sans-serif">Purpose: ${purpose}</text>`,
    `<text x="24" y="72" font-size="12" fill="#57534e">Engaging party: ${engagingParty || "—"} · Valuation date ${latest.year}-12-31</text>`,
    `</svg>`,
  ].join("");

  const sections: ReportSection[] = [
    {
      id: "cover",
      title: "Cover",
      blocks: [
        {
          kind: "cover",
          id: "cover-page",
          title: entityName,
          subtitle: `${purpose} · Valuation date ${latest.year}-12-31 · Issued ${issuanceDate}`,
          svg: coverGraphic,
        },
        ...chartBlocks([{ id: "cover-graphic", title: "Cover graphic", svg: coverGraphic }]),
      ],
    },
    {
      id: "assignment",
      title: "I. Description of Assignment",
      blocks: [
        {
          kind: "paragraph",
          id: "assignment-summary",
          content: narrative.assignment_summary,
          review: true,
        },
        {
          kind: "list",
          id: "assignment-facts",
          title: "Key draft facts",
          review: true,
          items: [
            `Engaging party: ${engagingParty}`,
            `Valuation date: ${latest.year}-12-31`,
            `Date of issuance: ${issuanceDate}`,
            `Tax years parsed: ${columns.map((column) => column.year).sort((a, b) => a - b).join(", ")}`,
            `Reconciled value: ${money(valuation.reconciledValue)}`,
          ],
        },
        ...chartBlocks([{ id: "purpose-summary", title: "Purpose summary", svg: purposeSummarySvg }]),
      ],
    },
    {
      id: "company",
      title: "II. Survey of the Subject Company",
      blocks: [
        {
          kind: "paragraph",
          id: "company-description",
          content: narrative.company_description,
          review: true,
          sources: benchmark.sources,
        },
      ],
    },
    {
      id: "economy",
      title: "III. Economic Conditions",
      blocks: [
        {
          kind: "table",
          id: "national-table",
          title: "National economic snapshot",
          columns: ["Metric", "Value"],
          rows: national.metrics.map((metric) => [metric.label, metric.value]),
          sources: national.metrics.map((metric) => metric.source),
        },
        ...national.charts.map((chart) => ({
          kind: "chart" as const,
          id: chart.id,
          title: chart.title,
          svg: seriesToSvg(chart.series),
          sources: [chart.series.source],
        })),
        ...chartBlocks(macroMetricCharts.filter((c) => c.id.startsWith("national-"))),
        {
          kind: "table",
          id: "msa-table",
          title: `${msa.areaLabel} snapshot`,
          columns: ["Metric", "Value"],
          rows: msa.metrics.filter((metric) => metric.value).map((metric) => [metric.label, metric.value]),
          sources: msa.metrics.map((metric) => metric.source),
        },
        ...msa.charts.map((chart) => ({
          kind: "chart" as const,
          id: chart.id,
          title: chart.title,
          svg: seriesToSvg(chart.series, "#92400e"),
          sources: [chart.series.source],
        })),
        ...chartBlocks(macroMetricCharts.filter((c) => c.id.startsWith("msa-"))),
        {
          kind: "list",
          id: "implications",
          title: "Implications",
          items: narrative.economic_implications.length ? narrative.economic_implications : implicationBullets,
          review: true,
          sources: [market.source, ...benchmark.sources],
        },
      ],
    },
    {
      id: "financials",
      title: "IV. Financial Performance",
      blocks: [
        {
          kind: "table",
          id: "historical-financials",
          title: "Historical financial summary",
          columns: ["Year", "Sales", "COGS", "Gross Profit", "NPBT", "Total Assets", "Total Liabilities"],
          rows: yearRows(columns),
          sources: [sourceLine("Tax return parser", undefined, "Workbook totals derived from uploaded tax returns.")],
        },
        ...financialCharts.map((chart) => ({
          kind: "chart" as const,
          id: chart.id,
          title: chart.title,
          svg: chart.svg,
          sources: [sourceLine("Tax return parser", undefined, "Chart computed from parsed workbook values.")],
        })),
        ...chartBlocks(
          benchmarkVisuals.filter((chart) =>
            ["benchmark-entry-table", "benchmark-is-compare", "benchmark-bs-compare", "benchmark-metrics-compare"].includes(
              chart.id,
            ),
          ),
        ),
        {
          kind: "table",
          id: "industry-benchmark",
          title: `Industry benchmark entry (${benchmark.title})`,
          columns: ["Section", "Label", "Benchmark"],
          rows: benchmark.benchmarkRows.filter((row) => row.value).map((row) => [row.section, row.label, row.value]),
          sources: benchmark.sources,
        },
        {
          kind: "list",
          id: "financial-observations",
          title: "Draft observations",
          review: true,
          items: narrative.financial_observations,
          sources: benchmark.sources,
        },
      ],
    },
    {
      id: "normalization",
      title: "V. Normalization Adjustments",
      blocks: [
        {
          kind: "list",
          id: "normalization-checklist",
          title: "Normalization inputs (user + tax data)",
          review: true,
          items: normalizationBullets.length
            ? normalizationBullets
            : [
                "Confirm owner compensation replacement cost assumptions.",
                "Review related-party rent and any one-time expenses not visible in the tax return alone.",
                "All normalization inputs are shown in the Formula Transparency section with cited sources.",
              ],
        },
      ],
    },
    {
      id: "methods",
      title: "VI–XI. Valuation Methods, Reconciliation & Conclusion",
      blocks: [
        {
          kind: "table",
          id: "valuation-reconciliation",
          title: "Reconciliation (income approach)",
          columns: ["Method", "Indicated", "DLOM", "Adjusted", "Weight"],
          rows: valuation.methods.map((row) => [
            row.label,
            money(row.indicatedValue),
            `${(row.dlomRate * 100).toFixed(1)}%`,
            money(row.adjustedValue),
            row.weight.toFixed(2),
          ]),
          sources: [market.source],
        },
        {
          kind: "table",
          id: "valuation-summary",
          title: "Valuation summary",
          columns: ["Method", "Adjusted value"],
          rows: [
            ...valuation.methods.map((row) => [row.label, money(row.adjustedValue)]),
            ["Reconciled value", money(valuation.reconciledValue)],
          ],
          sources: [market.source],
        },
        {
          kind: "table",
          id: "valuation-assumptions",
          title: "Key assumptions",
          columns: ["Input", "Value"],
          rows: [
            ["Risk-free rate", `${(valuation.assumptions.riskFreeRate * 100).toFixed(2)}%`],
            ["Equity risk premium", `${(valuation.assumptions.equityRiskPremium * 100).toFixed(2)}%`],
            ["Size premium", `${(valuation.assumptions.sizePremium * 100).toFixed(2)}%`],
            ["Company-specific risk", `${(valuation.assumptions.companySpecificRisk * 100).toFixed(2)}%`],
            ["Long-term growth", `${(valuation.assumptions.longTermGrowthRate * 100).toFixed(2)}%`],
            ["DLOM", `${(valuation.assumptions.dlomRate * 100).toFixed(2)}%`],
            ["Capitalization rate", `${(valuation.capitalizationRate * 100).toFixed(2)}%`],
          ],
          sources: [
            sourceLine("FRED / Treasury", "https://fred.stlouisfed.org/series/DGS20", "Risk-free rate proxy."),
            sourceLine("Damodaran ERP", "https://pages.stern.nyu.edu/~adamodar/", "Equity risk premium reference."),
          ],
        },
        {
          kind: "paragraph",
          id: "ideal-rate-language",
          content:
            narrative.ideal_rate_language ??
            `The indicated capitalization rate is ${(valuation.capitalizationRate * 100).toFixed(2)}% based on the build-up method applied to normalized earnings of ${money(valuation.normalizedEarnings)}.`,
          review: true,
        },
        {
          kind: "paragraph",
          id: "conclusion",
          content: narrative.conclusion,
          review: true,
          sources: [market.source],
        },
        ...chartBlocks(
          benchmarkVisuals.filter((chart) =>
            [
              "buildup-waterfall",
              "reconciliation-summary",
              "market-multiples-table",
              "market-comps-scatter",
              "dealstats-detail",
              "firm-logo",
            ].includes(chart.id),
          ),
        ),
      ],
    },
    {
      id: "formulas",
      title: "Formula Transparency — Full Calculation Audit",
      blocks: [
        {
          kind: "formula",
          id: "valuation-formulas",
          title: "Every step from tax data to reconciled value",
          steps: valuation.formulas,
        },
      ],
    },
  ];

  const checklist: ValuationChecklistItem[] = [
    {
      id: "has-tax-years",
      label: "At least one tax year parsed",
      pass: columns.length > 0,
    },
    {
      id: "has-naics",
      label: "NAICS present or manually confirmed",
      pass: Boolean(input.naics),
      detail: input.naics ? undefined : "Provide NAICS for better industry benchmarking.",
    },
    {
      id: "msa-reviewed",
      label: "MSA confirmed for local section",
      pass: Boolean(input.msaLabel),
      detail: input.msaLabel ? undefined : "Local market section is running in proxy mode until MSA is confirmed.",
    },
    {
      id: "reconciled-positive",
      label: "Reconciled value is positive",
      pass: valuation.reconciledValue > 0,
    },
  ];

  return {
    report: {
      entityName,
      abbreviation: deriveEntityAbbreviation(entityName),
      valuationDate: `${latest.year}-12-31`,
      dateOfIssuance: issuanceDate,
      purpose,
      engagingParty,
      naics: input.naics,
      naicsTitle: benchmark.title,
      msaLabel: msa.areaLabel,
      taxYears: columns.map((column) => column.year).sort((a, b) => a - b),
      sections,
      sources: [
        ...benchmark.sources,
        market.source,
        sbaContext.source,
        sourceLine("FRED", "https://fred.stlouisfed.org/"),
        sourceLine("BEA", "https://apps.bea.gov/API/signup/index.html"),
        sourceLine("Census ACS", "https://api.census.gov/"),
      ],
      checklist,
      valuation,
    },
    benchmark,
    market,
    macro: { national, msa },
    logs: [
      `Generated draft for ${entityName}`,
      `Benchmark profile: ${benchmark.title}`,
      `Market vertical: ${market.vertical} (${market.bracket})`,
      `Narrative provider: ${narrativeProvider}`,
      `B/S footnotes: ${Object.values(balanceSheetFootnotes).filter(Boolean).length} fields populated`,
    ],
  };
}
