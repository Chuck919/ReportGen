import sharp from "sharp";
import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from "pdf-lib";
import type { ReportBlock, ReportSection, ValuationReport } from "@/lib/valuation/types";

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 48;
const CONTENT_W = PAGE_W - MARGIN * 2;
const LINE = 14;
const FOOTER_Y = 28;

function parseSvgSize(svg: string): { width: number; height: number } {
  const width = Number(svg.match(/\bwidth="(\d+)"/)?.[1] ?? 720);
  const height = Number(svg.match(/\bheight="(\d+)"/)?.[1] ?? 260);
  return { width, height };
}

async function svgToPng(svg: string, targetWidth: number): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const { width, height } = parseSvgSize(svg);
  const scale = targetWidth / width;
  const targetHeight = Math.round(height * scale);
  const bytes = await sharp(Buffer.from(svg))
    .resize(targetWidth, targetHeight, { fit: "fill" })
    .png()
    .toBuffer();
  return { bytes: new Uint8Array(bytes), width: targetWidth, height: targetHeight };
}

function pdfSafeText(text: string): string {
  return text
    .replace(/Σ/g, "Sum")
    .replace(/×/g, "x")
    .replace(/÷/g, "/")
    .replace(/−/g, "-")
    .replace(/–/g, "-")
    .replace(/—/g, "-")
    .replace(/[^\x00-\xFF]/g, "?");
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = pdfSafeText(text).replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) {
      line = next;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

class PdfBuilder {
  private readonly doc: PDFDocument;
  private page!: PDFPage;
  private y = PAGE_H - MARGIN;
  private font!: PDFFont;
  private fontBold!: PDFFont;
  private fontMono!: PDFFont;
  private pageIndex = 0;
  private readonly entityName: string;

  private constructor(doc: PDFDocument, entityName: string) {
    this.doc = doc;
    this.entityName = entityName;
  }

  static async create(entityName: string): Promise<PdfBuilder> {
    const doc = await PDFDocument.create();
    doc.setTitle(`${entityName} Valuation`);
    doc.setCreator("ReportGen");
    const builder = new PdfBuilder(doc, entityName);
    builder.font = await doc.embedFont(StandardFonts.Helvetica);
    builder.fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
    builder.fontMono = await doc.embedFont(StandardFonts.Courier);
    builder.addPage();
    return builder;
  }

  private addPage(): void {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.pageIndex += 1;
    this.y = PAGE_H - MARGIN;
    this.page.drawText(pdfSafeText(this.entityName), {
      x: MARGIN,
      y: FOOTER_Y,
      size: 8,
      font: this.font,
      color: rgb(0.45, 0.45, 0.45),
    });
    this.page.drawText(`Page ${this.pageIndex}`, {
      x: PAGE_W - MARGIN - 40,
      y: FOOTER_Y,
      size: 8,
      font: this.font,
      color: rgb(0.45, 0.45, 0.45),
    });
  }

  private ensureSpace(needed: number): void {
    if (this.y - needed < MARGIN + 20) this.addPage();
  }

  private drawLines(lines: string[], size: number, font: PDFFont, color = rgb(0.15, 0.15, 0.15)): void {
    for (const line of lines) {
      this.ensureSpace(LINE);
      this.page.drawText(pdfSafeText(line), { x: MARGIN, y: this.y, size, font, color });
      this.y -= LINE;
    }
  }

  drawSectionTitle(title: string): void {
    this.ensureSpace(36);
    this.y -= 8;
    this.page.drawText(pdfSafeText(title), { x: MARGIN, y: this.y, size: 16, font: this.fontBold, color: rgb(0.1, 0.1, 0.1) });
    this.y -= 22;
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: PAGE_W - MARGIN, y: this.y },
      thickness: 1,
      color: rgb(0.85, 0.85, 0.85),
    });
    this.y -= 16;
  }

  drawSubheading(title: string): void {
    this.ensureSpace(24);
    this.page.drawText(pdfSafeText(title), { x: MARGIN, y: this.y, size: 12, font: this.fontBold, color: rgb(0.2, 0.2, 0.2) });
    this.y -= 18;
  }

  drawParagraph(text: string): void {
    const lines = wrapText(text, this.font, 10, CONTENT_W);
    this.drawLines(lines, 10, this.font);
    this.y -= 6;
  }

  drawBullets(items: string[]): void {
    for (const item of items) {
      const lines = wrapText(item, this.font, 10, CONTENT_W - 14);
      lines.forEach((line, index) => {
        this.ensureSpace(LINE);
        if (index === 0) {
          this.page.drawText("•", { x: MARGIN, y: this.y, size: 10, font: this.font });
          this.page.drawText(pdfSafeText(line), { x: MARGIN + 12, y: this.y, size: 10, font: this.font });
        } else {
          this.page.drawText(pdfSafeText(line), { x: MARGIN + 12, y: this.y, size: 10, font: this.font });
        }
        this.y -= LINE;
      });
    }
    this.y -= 4;
  }

  async drawSvg(svg: string): Promise<void> {
    const { bytes, width, height } = await svgToPng(svg, CONTENT_W);
    const image = await this.doc.embedPng(bytes);
    const drawHeight = (height / width) * CONTENT_W;
    this.ensureSpace(drawHeight + 12);
    this.page.drawImage(image, { x: MARGIN, y: this.y - drawHeight, width: CONTENT_W, height: drawHeight });
    this.y -= drawHeight + 12;
  }

  drawTable(columns: string[], rows: string[][]): void {
    const colCount = columns.length;
    const colW = CONTENT_W / colCount;
    const rowH = 18;
    const headerH = 22;
    this.ensureSpace(headerH + rows.length * rowH + 8);

    columns.forEach((col, index) => {
      const x = MARGIN + index * colW + 4;
      this.page.drawRectangle({
        x: MARGIN + index * colW,
        y: this.y - headerH,
        width: colW,
        height: headerH,
        color: rgb(0.93, 0.94, 0.96),
      });
      this.page.drawText(pdfSafeText(col.slice(0, 28)), { x, y: this.y - 14, size: 9, font: this.fontBold });
    });
    this.y -= headerH;

    for (const row of rows) {
      row.forEach((cell, index) => {
        const x = MARGIN + index * colW + 4;
        this.page.drawText(pdfSafeText(cell.slice(0, 32)), { x, y: this.y - 12, size: 8, font: this.font });
        this.page.drawRectangle({
          x: MARGIN + index * colW,
          y: this.y - rowH,
          width: colW,
          height: rowH,
          borderColor: rgb(0.9, 0.9, 0.9),
          borderWidth: 0.5,
        });
      });
      this.y -= rowH;
    }
    this.y -= 10;
  }

  drawFormulaSteps(
    steps: Array<{ label: string; expression: string; result: string }>,
  ): void {
    for (const step of steps) {
      const line = `${step.label}: ${step.expression} = ${step.result}`;
      const lines = wrapText(line, this.fontMono, 8, CONTENT_W);
      this.drawLines(lines, 8, this.fontMono, rgb(0.25, 0.25, 0.3));
    }
    this.y -= 4;
  }

  async finish(): Promise<Buffer> {
    const bytes = await this.doc.save();
    return Buffer.from(bytes);
  }
}

async function renderBlock(builder: PdfBuilder, block: ReportBlock): Promise<void> {
  switch (block.kind) {
    case "cover":
      await builder.drawSvg(block.svg);
      if (block.subtitle) builder.drawParagraph(block.subtitle);
      break;
    case "paragraph":
      if (block.title) builder.drawSubheading(block.title);
      builder.drawParagraph(block.content);
      break;
    case "list":
      if (block.title) builder.drawSubheading(block.title);
      builder.drawBullets(block.items);
      break;
    case "table":
      builder.drawSubheading(block.title);
      builder.drawTable(block.columns, block.rows);
      break;
    case "chart":
      builder.drawSubheading(block.title);
      await builder.drawSvg(block.svg);
      break;
    case "formula":
      builder.drawSubheading(block.title);
      builder.drawFormulaSteps(block.steps);
      break;
    default:
      break;
  }
}

async function renderSection(builder: PdfBuilder, section: ReportSection): Promise<void> {
  if (section.id === "cover") {
    for (const block of section.blocks) await renderBlock(builder, block);
    return;
  }
  builder.drawSectionTitle(section.title);
  for (const block of section.blocks) await renderBlock(builder, block);
}

export function sanitizePdfFilename(entityName: string): string {
  const base = entityName.trim() || "valuation-report";
  return `${base.replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").slice(0, 80)}-valuation.pdf`;
}

/** PDF export with embedded chart/cover graphics (SVG rasterized via sharp). */
export async function buildValuationPdf(report: ValuationReport): Promise<Buffer> {
  const builder = await PdfBuilder.create(report.entityName);
  for (const section of report.sections) {
    await renderSection(builder, section);
  }
  return builder.finish();
}
