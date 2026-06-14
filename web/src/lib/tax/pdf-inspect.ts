import { PDFParse } from "pdf-parse";
import { isLikelyScannedPdf, isLikelyTaxReturnText } from "./validate-upload";

export type PdfInspectResult = {
  pageCount: number;
  embeddedTextLen: number;
  likelyScanned: boolean;
  likelyTaxReturn: boolean;
};

export async function inspectPdfBuffer(buffer: Buffer): Promise<PdfInspectResult> {
  const parser = new PDFParse({ data: buffer });
  try {
    const textResult = await parser.getText();
    const info = await parser.getInfo();
    const embedded = textResult.text ?? "";
    const pageCount = info.total ?? countPageMarkers(embedded);
    return {
      pageCount: Math.max(pageCount, 1),
      embeddedTextLen: embedded.trim().length,
      likelyScanned: isLikelyScannedPdf(embedded.trim().length),
      likelyTaxReturn: isLikelyTaxReturnText(embedded),
    };
  } finally {
    await parser.destroy?.();
  }
}

function countPageMarkers(text: string): number {
  const m = text.match(/\f/g);
  return m ? m.length + 1 : 1;
}
