import sharp from "sharp";
import PizZip from "pizzip";
import { CHART_MARKER_PREFIX, CHART_MARKER_SUFFIX } from "@/lib/valuation/word-chart-markers";
import type { LiveChart } from "@/lib/valuation/word-chart-appendix";

function parseSvgSize(svg: string): { width: number; height: number } {
  return {
    width: Number(svg.match(/\bwidth="(\d+)"/)?.[1] ?? 720),
    height: Number(svg.match(/\bheight="(\d+)"/)?.[1] ?? 260),
  };
}

async function svgToPng(svg: string, targetWidth = 620): Promise<{ buffer: Buffer; width: number; height: number }> {
  const { width, height } = parseSvgSize(svg);
  const targetHeight = Math.round(height * (targetWidth / width));
  const buffer = await sharp(Buffer.from(svg)).resize(targetWidth, targetHeight, { fit: "fill" }).png().toBuffer();
  return { buffer, width: targetWidth, height: targetHeight };
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function nextRelationshipId(relsXml: string): number {
  const ids = [...relsXml.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
  return Math.max(0, ...ids) + 1;
}

function imageBlockXml(input: {
  relId: number;
  docPrId: number;
  widthPx: number;
  heightPx: number;
  title: string;
}): string {
  const cx = Math.round(input.widthPx * 9525);
  const cy = Math.round(input.heightPx * 9525);
  const safeTitle = escapeXml(input.title);
  return `<w:p><w:pPr><w:spacing w:before="60" w:after="120"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${input.docPrId}" name="${safeTitle}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="${safeTitle}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId${input.relId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

function markerPattern(chartId: string): RegExp {
  const escaped = `${CHART_MARKER_PREFIX}${chartId}${CHART_MARKER_SUFFIX}`.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  return new RegExp(escaped, "g");
}

/** Replace [[CHART:id]] markers in document body with rasterized session charts. */
export async function injectChartsAtMarkers(docxBuffer: Buffer, charts: LiveChart[]): Promise<Buffer> {
  if (!charts.length) return docxBuffer;

  const zip = new PizZip(docxBuffer);
  const documentPath = "word/document.xml";
  const relsPath = "word/_rels/document.xml.rels";
  const contentTypesPath = "[Content_Types].xml";

  let documentXml = zip.file(documentPath)?.asText();
  let relsXml = zip.file(relsPath)?.asText();
  let contentTypesXml = zip.file(contentTypesPath)?.asText();
  if (!documentXml || !relsXml || !contentTypesXml) return docxBuffer;

  const chartById = new Map(charts.map((chart) => [chart.id, chart]));
  let relId = nextRelationshipId(relsXml);
  let docPrId = 8000 + Math.floor(Math.random() * 1000);
  let injected = 0;

  for (const [chartId, chart] of chartById) {
    const marker = markerPattern(chartId);
    if (!marker.test(documentXml)) continue;

    const png = await svgToPng(chart.svg);
    const mediaName = `media/chart-slot-${chartId.replace(/[^a-z0-9-]/gi, "-")}.png`;
    zip.file(`word/${mediaName}`, png.buffer);

    relsXml = relsXml.replace(
      "</Relationships>",
      `<Relationship Id="rId${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${mediaName}"/></Relationships>`,
    );

    const imageXml = imageBlockXml({
      relId,
      docPrId: docPrId++,
      widthPx: png.width,
      heightPx: png.height,
      title: chart.title,
    });

    documentXml = documentXml.replace(marker, imageXml);
    relId += 1;
    injected += 1;
  }

  if (!injected) return docxBuffer;

  if (!contentTypesXml.includes('Extension="png"')) {
    contentTypesXml = contentTypesXml.replace(
      "</Types>",
      '<Default Extension="png" ContentType="image/png"/></Types>',
    );
  }

  zip.file(documentPath, documentXml);
  zip.file(relsPath, relsXml);
  zip.file(contentTypesPath, contentTypesXml);

  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
}
