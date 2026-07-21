import { buildBuiltinValuationDocx } from "@/lib/valuation/docx-builtin";
import { fillWordTemplate, loadFirmValuationTemplate } from "@/lib/valuation/docx-template";
import { buildFullWordMergeData, type WordMergeContext } from "@/lib/valuation/template-merge-data";
import { appendLiveChartsToDocx, extractLiveChartsFromReport } from "@/lib/valuation/word-chart-appendix";
import { injectChartsAtMarkers } from "@/lib/valuation/word-chart-inject";
import { CHART_MARKER_PREFIX } from "@/lib/valuation/word-chart-markers";
import type { ValuationReport } from "@/lib/valuation/types";

export type ValuationDocxExportMode = "builtin" | "firm" | "uploaded";

export type ValuationDocxExportOptions = {
  report: ValuationReport;
  mode: ValuationDocxExportMode;
  templateBuffer?: Buffer;
  mergeContext?: Omit<WordMergeContext, "report">;
  /** Append live session charts (SVG → PNG) to firm/uploaded Word exports. Default true. */
  includeLiveCharts?: boolean;
};

export function sanitizeDocxFilename(entityName: string): string {
  const base = entityName.trim() || "valuation-report";
  return `${base.replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").slice(0, 80)}-valuation.docx`;
}

export async function exportValuationDocx(options: ValuationDocxExportOptions): Promise<{ buffer: Buffer; filename: string }> {
  const { report, mode, templateBuffer, mergeContext, includeLiveCharts = true } = options;
  const filename = sanitizeDocxFilename(report.entityName);

  if (mode === "firm" || mode === "uploaded") {
    const buffer = templateBuffer?.length ? templateBuffer : mode === "firm" ? loadFirmValuationTemplate() : undefined;
    if (!buffer?.length) {
      throw new Error("Upload a Word template (.docx) or use the Main Current firm template.");
    }
    const merge = buildFullWordMergeData({
      report,
      columns: mergeContext?.columns ?? [],
      valuationInputs: mergeContext?.valuationInputs,
      engagement: mergeContext?.engagement,
    });
    let docx = fillWordTemplate(buffer, merge);
    const charts = extractLiveChartsFromReport(report);
    docx = await injectChartsAtMarkers(docx, charts);

    if (includeLiveCharts) {
      const placedIds = new Set(
        Object.values(merge)
          .filter((value): value is string => typeof value === "string" && value.includes(CHART_MARKER_PREFIX))
          .map((value) => value.match(/\[\[CHART:([^\]]+)\]\]/)?.[1])
          .filter((id): id is string => Boolean(id)),
      );
      const appendixCharts = charts.filter((chart) => !placedIds.has(chart.id));
      if (appendixCharts.length) {
        docx = await appendLiveChartsToDocx(docx, appendixCharts);
      }
    }
    return { buffer: docx, filename };
  }

  const docx = await buildBuiltinValuationDocx(report);
  return { buffer: docx, filename };
}
