import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  Packer,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import type { ReportBlock, ReportSection, ValuationReport } from "@/lib/valuation/types";
import { buildTemplateMergeData } from "@/lib/valuation/template-merge-data";

const BRAND = "1e3a5f";
const ACCENT = "2563eb";

function heading(text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel] = HeadingLevel.HEADING_1) {
  return new Paragraph({
    heading: level,
    spacing: { before: 280, after: 160 },
    children: [new TextRun({ text, bold: true, color: BRAND })],
  });
}

function body(text: string) {
  return new Paragraph({
    spacing: { after: 120 },
    children: [new TextRun({ text, size: 22 })],
  });
}

function bullet(items: string[]) {
  return items.map(
    (item) =>
      new Paragraph({
        bullet: { level: 0 },
        spacing: { after: 80 },
        children: [new TextRun({ text: item, size: 22 })],
      }),
  );
}

function tableFromBlock(block: Extract<ReportBlock, { kind: "table" }>) {
  const header = new TableRow({
    tableHeader: true,
    children: block.columns.map(
      (column) =>
        new TableCell({
          shading: { fill: "e8eef5" },
          children: [new Paragraph({ children: [new TextRun({ text: column, bold: true, size: 20 })] })],
        }),
    ),
  });
  const rows = block.rows.map(
    (row) =>
      new TableRow({
        children: row.map(
          (cell) =>
            new TableCell({
              children: [new Paragraph({ children: [new TextRun({ text: cell, size: 20 })] })],
            }),
        ),
      }),
  );
  return [
    heading(block.title, HeadingLevel.HEADING_3),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [header, ...rows],
    }),
    new Paragraph({ spacing: { after: 200 }, children: [] }),
  ];
}

function blocksToDocx(blocks: ReportBlock[]) {
  const nodes: Array<Paragraph | Table> = [];
  for (const block of blocks) {
    if (block.kind === "cover") continue;
    if (block.kind === "paragraph") {
      if (block.title) nodes.push(heading(block.title, HeadingLevel.HEADING_3));
      nodes.push(body(block.content));
    } else if (block.kind === "list") {
      if (block.title) nodes.push(heading(block.title, HeadingLevel.HEADING_3));
      nodes.push(...bullet(block.items));
    } else if (block.kind === "table") {
      nodes.push(...tableFromBlock(block));
    } else if (block.kind === "chart") {
      nodes.push(
        heading(block.title, HeadingLevel.HEADING_3),
        body("[Chart rendered in web report — export includes title and data tables above/below where applicable.]"),
      );
    } else if (block.kind === "formula") {
      nodes.push(heading(block.title, HeadingLevel.HEADING_3));
      for (const step of block.steps) {
        nodes.push(
          new Paragraph({
            spacing: { after: 80 },
            children: [
              new TextRun({ text: `${step.label}: `, bold: true, size: 20 }),
              new TextRun({ text: `${step.expression} = ${step.result}`, size: 20, font: "Consolas" }),
            ],
          }),
        );
      }
    }
  }
  return nodes;
}

function coverSection(report: ValuationReport, merge: ReturnType<typeof buildTemplateMergeData>) {
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 600, after: 200 },
      border: {
        bottom: { style: BorderStyle.SINGLE, size: 12, color: ACCENT },
      },
      children: [
        new TextRun({
          text: "VALUATION REPORT",
          bold: true,
          size: 40,
          color: BRAND,
          characterSpacing: 120,
        }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [new TextRun({ text: report.entityName, bold: true, size: 52, color: BRAND })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
      children: [
        new TextRun({
          text: merge.reconciledValue,
          bold: true,
          size: 44,
          color: ACCENT,
        }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
      children: [
        new TextRun({ text: `Valuation date: ${report.valuationDate}`, size: 24 }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
      children: [new TextRun({ text: `Purpose: ${report.purpose}`, size: 24 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
      children: [
        new TextRun({ text: `Engaging party: ${report.engagingParty ?? "To be confirmed"}`, size: 24 }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
      children: [
        new TextRun({
          text: `Issued ${report.dateOfIssuance} · ReportGen draft`,
          italics: true,
          size: 20,
          color: "64748b",
        }),
      ],
    }),
    new Paragraph({ pageBreakBefore: true, children: [] }),
  ];
}

function sectionNodes(section: ReportSection) {
  if (section.id === "cover") return [];
  return [heading(section.title), ...blocksToDocx(section.blocks)];
}

export async function buildBuiltinValuationDocx(report: ValuationReport): Promise<Buffer> {
  const merge = buildTemplateMergeData(report);
  const children = [
    ...coverSection(report, merge),
    ...report.sections.flatMap(sectionNodes),
    heading("Sources & disclaimer"),
    body(
      "This draft was generated from uploaded tax returns and public macro/industry datasets. Analyst review is required before reliance. Formula steps and assumption sources are shown in the web report.",
    ),
  ];

  const doc = new Document({
    creator: "ReportGen",
    title: `${report.entityName} Valuation`,
    description: report.purpose,
    styles: {
      default: {
        document: {
          run: { font: "Calibri", size: 22 },
        },
      },
    },
    sections: [
      {
        properties: {},
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: `${report.entityName} · `, size: 18, color: "64748b" }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 18, color: "64748b" }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}
