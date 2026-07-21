import sharp from "sharp";
import PizZip from "pizzip";
import type { ValuationReport } from "@/lib/valuation/types";

export type LiveChart = { id: string; title: string; svg: string };

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

export function extractLiveChartsFromReport(report: ValuationReport): LiveChart[] {
  const charts: LiveChart[] = [];
  for (const section of report.sections) {
    for (const block of section.blocks) {
      if (block.kind === "chart") {
        charts.push({ id: block.id, title: block.title, svg: block.svg });
      }
    }
  }
  return charts;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function nextRelationshipId(relsXml: string): number {
  const ids = [...relsXml.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
  return Math.max(0, ...ids) + 1;
}

function imageParagraphXml(input: {
  relId: number;
  docPrId: number;
  widthPx: number;
  heightPx: number;
  title: string;
}): string {
  const cx = Math.round(input.widthPx * 9525);
  const cy = Math.round(input.heightPx * 9525);
  const safeTitle = escapeXml(input.title);
  return `
<w:p>
  <w:pPr><w:spacing w:before="120" w:after="60"/></w:pPr>
  <w:r><w:rPr><w:b/><w:sz w:val="22"/></w:rPr><w:t>${safeTitle}</w:t></w:r>
</w:p>
<w:p>
  <w:r>
    <w:drawing>
      <wp:inline distT="0" distB="0" distL="0" distR="0">
        <wp:extent cx="${cx}" cy="${cy}"/>
        <wp:docPr id="${input.docPrId}" name="${safeTitle}"/>
        <wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>
        <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
            <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
              <pic:nvPicPr><pic:cNvPr id="0" name="${safeTitle}"/><pic:cNvPicPr/></pic:nvPicPr>
              <pic:blipFill>
                <a:blip r:embed="rId${input.relId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>
                <a:stretch><a:fillRect/></a:stretch>
              </pic:blipFill>
              <pic:spPr>
                <a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
                <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
              </pic:spPr>
            </pic:pic>
          </a:graphicData>
        </a:graphic>
      </wp:inline>
    </w:drawing>
  </w:r>
</w:p>`;
}

/** Appends session charts (rasterized SVG) before document end — preserves template branding. */
export async function appendLiveChartsToDocx(docxBuffer: Buffer, charts: LiveChart[]): Promise<Buffer> {
  if (!charts.length) return docxBuffer;

  const zip = new PizZip(docxBuffer);
  const documentPath = "word/document.xml";
  const relsPath = "word/_rels/document.xml.rels";
  const contentTypesPath = "[Content_Types].xml";

  let documentXml = zip.file(documentPath)?.asText();
  let relsXml = zip.file(relsPath)?.asText();
  let contentTypesXml = zip.file(contentTypesPath)?.asText();
  if (!documentXml || !relsXml || !contentTypesXml) return docxBuffer;

  const pngCharts = await Promise.all(
    charts.map(async (chart) => ({
      chart,
      png: await svgToPng(chart.svg),
    })),
  );

  let relId = nextRelationshipId(relsXml);
  let docPrId = 9000 + Math.floor(Math.random() * 1000);
  const appendixParts: string[] = [
    `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`,
    `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t>Appendix — Live Session Charts &amp; Graphics</w:t></w:r></w:p>`,
    `<w:p><w:r><w:t>Charts below are generated from parsed tax data and macro feeds in this session.</w:t></w:r></w:p>`,
  ];

  for (let index = 0; index < pngCharts.length; index += 1) {
    const { chart, png } = pngCharts[index]!;
    const mediaName = `media/chart-live-${index + 1}.png`;
    zip.file(`word/${mediaName}`, png.buffer);

    relsXml = relsXml.replace(
      "</Relationships>",
      `<Relationship Id="rId${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${mediaName}"/></Relationships>`,
    );

    appendixParts.push(
      imageParagraphXml({
        relId,
        docPrId: docPrId++,
        widthPx: png.width,
        heightPx: png.height,
        title: chart.title,
      }),
    );

    relId += 1;
  }

  if (!contentTypesXml.includes("Extension=\"png\"")) {
    contentTypesXml = contentTypesXml.replace(
      "</Types>",
      '<Default Extension="png" ContentType="image/png"/></Types>',
    );
  }

  const bodyClose = "</w:body>";
  const bodyEnd = documentXml.lastIndexOf(bodyClose);
  if (bodyEnd === -1) {
    throw new Error("Could not locate Word document body to append live charts.");
  }
  documentXml = `${documentXml.slice(0, bodyEnd)}${appendixParts.join("")}${documentXml.slice(bodyEnd)}`;
  if (!documentXml.includes("Appendix")) {
    throw new Error("Failed to inject chart appendix into Word document.");
  }

  zip.file(documentPath, documentXml);
  zip.file(relsPath, relsXml);
  zip.file(contentTypesPath, contentTypesXml);

  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
}
