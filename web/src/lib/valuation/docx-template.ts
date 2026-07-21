import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";

export type WordTemplateStyle = "guillemet" | "brace";

export function detectWordTemplateStyle(templateBuffer: Buffer): WordTemplateStyle {
  const zip = new PizZip(templateBuffer);
  const xml = zip.file("word/document.xml")?.asText() ?? "";
  if (xml.includes("«") && xml.includes("»")) return "guillemet";
  return "brace";
}

export function loadFirmValuationTemplate(): Buffer {
  const candidates = [
    join(process.cwd(), "public", "templates", "main-current-reportgen.docx"),
    join(process.cwd(), "..", "Documents", "MAIN CURRENT REPORT reportgen.docx"),
    join(process.cwd(), "public", "templates", "main-current-premerge.docx"),
    join(process.cwd(), "..", "Documents", "MAIN CURRENT REPORT premerge.docx"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return readFileSync(path);
  }
  throw new Error(
    "ReportGen Word template not found. Run: npx tsx scripts/prepare-reportgen-template.ts",
  );
}

export function fillWordTemplate(templateBuffer: Buffer, data: Record<string, unknown>): Buffer {
  const style = detectWordTemplateStyle(templateBuffer);
  const delimiters =
    style === "guillemet" ? ({ start: "«", end: "»" } as const) : ({ start: "{", end: "}" } as const);

  const zip = new PizZip(templateBuffer);
  const doc = new Docxtemplater(zip, {
    delimiters,
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: () => "",
  });

  try {
    doc.render(data);
  } catch (error) {
    const detail =
      error && typeof error === "object" && "properties" in error
        ? JSON.stringify((error as { properties?: unknown }).properties)
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`Could not merge Word template (${style} placeholders). ${detail}`);
  }

  return doc.getZip().generate({
    type: "nodebuffer",
    compression: "DEFLATE",
  }) as Buffer;
}
