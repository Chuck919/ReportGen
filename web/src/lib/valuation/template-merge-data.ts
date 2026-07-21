import type { ReportBlock, ReportSection, ValuationReport } from "@/lib/valuation/types";
import { buildWordMergeData, type WordMergeContext } from "@/lib/valuation/premerge-merge-data";
import { buildChartMarkerMergeData } from "@/lib/valuation/word-chart-markers";
import { extractLiveChartsFromReport } from "@/lib/valuation/word-chart-appendix";

function money(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function blockToPlainText(block: ReportBlock): string {
  switch (block.kind) {
    case "cover":
      return [block.title, block.subtitle].filter(Boolean).join("\n");
    case "paragraph":
      return block.title ? `${block.title}\n${block.content}` : block.content;
    case "list":
      return [
        block.title ?? "",
        ...block.items.map((item) => `• ${item}`),
      ]
        .filter(Boolean)
        .join("\n");
    case "table":
      return [
        block.title,
        block.columns.join(" | "),
        ...block.rows.map((row) => row.join(" | ")),
      ].join("\n");
    case "chart":
      return `[Chart: ${block.title}]`;
    case "formula":
      return [
        block.title,
        ...block.steps.map((step) => `${step.label}: ${step.expression} = ${step.result}`),
      ].join("\n");
    default:
      return "";
  }
}

function sectionToPlainText(section: ReportSection): string {
  return section.blocks.map(blockToPlainText).filter(Boolean).join("\n\n");
}

/** Flat merge payload for docxtemplater `{placeholders}` in user-uploaded .docx files. */
export function buildTemplateMergeData(report: ValuationReport) {
  const { valuation } = report;
  const conclusionBlock = report.sections
    .flatMap((section) => section.blocks)
    .find((block) => block.kind === "paragraph" && block.id === "conclusion");

  return {
    entityName: report.entityName,
    abbreviation: report.abbreviation ?? "",
    valuationDate: report.valuationDate,
    dateOfIssuance: report.dateOfIssuance,
    purpose: report.purpose,
    engagingParty: report.engagingParty ?? "",
    naics: report.naics ?? "",
    naicsTitle: report.naicsTitle ?? "",
    msaLabel: report.msaLabel ?? "",
    taxYears: report.taxYears.join(", "),
    reconciledValue: money(valuation.reconciledValue),
    reconciledValueRaw: valuation.reconciledValue,
    incomeValue: money(valuation.incomeValue),
    assetValue: money(valuation.assetValue),
    marketValue: valuation.marketValue !== undefined ? money(valuation.marketValue) : "",
    tangibleAssetValue: money(valuation.tangibleAssetValue),
    intangibleValue: money(valuation.intangibleValue),
    capitalizationRate: `${(valuation.capitalizationRate * 100).toFixed(2)}%`,
    normalizedEarnings: money(valuation.normalizedEarnings),
    conclusion:
      conclusionBlock && conclusionBlock.kind === "paragraph"
        ? conclusionBlock.content
        : `${report.entityName} has a draft reconciled value of ${money(valuation.reconciledValue)}.`,
    methods: valuation.methods.map((row) => ({
      method: row.method,
      label: row.label,
      indicatedValue: money(row.indicatedValue),
      dlomRate: `${(row.dlomRate * 100).toFixed(1)}%`,
      adjustedValue: money(row.adjustedValue),
      weight: row.weight.toFixed(2),
    })),
    formulas: valuation.formulas.map((step) => ({
      id: step.id,
      label: step.label,
      expression: step.expression,
      substitution: step.substitution,
      result: step.result,
    })),
    assumptions: [
      { label: "Risk-free rate", value: `${(valuation.assumptions.riskFreeRate * 100).toFixed(2)}%` },
      { label: "Equity risk premium", value: `${(valuation.assumptions.equityRiskPremium * 100).toFixed(2)}%` },
      { label: "Size premium", value: `${(valuation.assumptions.sizePremium * 100).toFixed(2)}%` },
      { label: "Company-specific risk", value: `${(valuation.assumptions.companySpecificRisk * 100).toFixed(2)}%` },
      { label: "Long-term growth", value: `${(valuation.assumptions.longTermGrowthRate * 100).toFixed(2)}%` },
      { label: "DLOM", value: `${(valuation.assumptions.dlomRate * 100).toFixed(2)}%` },
    ],
    sections: report.sections
      .filter((section) => section.id !== "cover")
      .map((section) => ({
        id: section.id,
        title: section.title,
        body: sectionToPlainText(section),
      })),
  };
}

export type ValuationTemplateMergeData = ReturnType<typeof buildTemplateMergeData>;

/** Premerge «fields» + brace aliases + loop arrays for any template style. */
export function buildFullWordMergeData(context: WordMergeContext): Record<string, unknown> {
  const chartIds = new Set(extractLiveChartsFromReport(context.report).map((chart) => chart.id));
  return {
    ...buildWordMergeData(context),
    ...buildTemplateMergeData(context.report),
    ...buildChartMarkerMergeData(chartIds),
  };
}
