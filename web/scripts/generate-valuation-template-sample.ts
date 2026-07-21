/**
 * Generates public/templates/valuation-merge-template.docx — a starter user template
 * with docxtemplater placeholders. Run: npx tsx scripts/generate-valuation-template-sample.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Docxtemplater from "docxtemplater";
import { Document, Packer, Paragraph, TextRun } from "docx";
import PizZip from "pizzip";

const OUT = join(process.cwd(), "public", "templates", "valuation-merge-template.docx");

async function main() {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            children: [new TextRun({ text: "VALUATION REPORT (your template)", bold: true, size: 36 })],
          }),
          new Paragraph({ children: [new TextRun({ text: "" })] }),
          new Paragraph({ children: [new TextRun({ text: "Entity: {entityName}", size: 24 })] }),
          new Paragraph({ children: [new TextRun({ text: "Valuation date: {valuationDate}", size: 24 })] }),
          new Paragraph({ children: [new TextRun({ text: "Purpose: {purpose}", size: 24 })] }),
          new Paragraph({ children: [new TextRun({ text: "Engaging party: {engagingParty}", size: 24 })] }),
          new Paragraph({ children: [new TextRun({ text: "" })] }),
          new Paragraph({
            children: [new TextRun({ text: "Reconciled value: {reconciledValue}", bold: true, size: 28 })],
          }),
          new Paragraph({ children: [new TextRun({ text: "" })] }),
          new Paragraph({ children: [new TextRun({ text: "Methods", bold: true, size: 26 })] }),
          new Paragraph({ children: [new TextRun({ text: "{#methods}{label}: {adjustedValue} (weight {weight})", size: 22 })] }),
          new Paragraph({ children: [new TextRun({ text: "{/methods}", size: 22 })] }),
          new Paragraph({ children: [new TextRun({ text: "" })] }),
          new Paragraph({ children: [new TextRun({ text: "Conclusion", bold: true, size: 26 })] }),
          new Paragraph({ children: [new TextRun({ text: "{conclusion}", size: 22 })] }),
          new Paragraph({ children: [new TextRun({ text: "" })] }),
          new Paragraph({ children: [new TextRun({ text: "Formula audit", bold: true, size: 26 })] }),
          new Paragraph({
            children: [new TextRun({ text: "{#formulas}{label}: {expression} = {result}", size: 20 })],
          }),
          new Paragraph({ children: [new TextRun({ text: "{/formulas}", size: 20 })] }),
        ],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, buffer);

  // Verify placeholders survive round-trip through docxtemplater
  const zip = new PizZip(buffer);
  const testDoc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
  testDoc.render({
    entityName: "Sample Co",
    valuationDate: "2025-12-31",
    purpose: "SBA lending",
    engagingParty: "Lender",
    reconciledValue: "$800,000",
    conclusion: "Sample conclusion.",
    methods: [{ label: "Income", adjustedValue: "$800,000", weight: "1.00" }],
    formulas: [{ label: "Cap rate", expression: "WACC − growth", result: "27.27%" }],
  });
  const merged = testDoc.getZip().generate({ type: "nodebuffer" }) as Buffer;
  if (!merged.length) throw new Error("Template merge smoke test failed");

  console.log(`Wrote ${OUT} (${buffer.length} bytes)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
