import { fillWordTemplate } from "@/lib/valuation/docx-template";
import type { ValuationTemplateMergeData } from "@/lib/valuation/template-merge-data";

/** @deprecated Use fillWordTemplate from docx-template.ts */
export function fillUploadedValuationTemplate(templateBuffer: Buffer, data: ValuationTemplateMergeData): Buffer {
  return fillWordTemplate(templateBuffer, data as Record<string, string>);
}

export { fillWordTemplate, detectWordTemplateStyle, loadFirmValuationTemplate } from "@/lib/valuation/docx-template";
