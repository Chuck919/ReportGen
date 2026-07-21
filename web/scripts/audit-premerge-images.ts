/**
 * Audit premerge.docx image placements with surrounding section context.
 * Usage: npx tsx scripts/audit-premerge-images.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import PizZip from "pizzip";

const repoRoot = join(process.cwd(), "..");
const premerge = join(repoRoot, "Documents", "MAIN CURRENT REPORT premerge.docx");
const kcf = join(repoRoot, "Documents", "KCF valuation.docx");

function extractText(xml: string): string {
  return [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)]
    .map((m) => m[1]!)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function auditDoc(path: string, label: string) {
  const zip = new PizZip(readFileSync(path));
  const doc = zip.file("word/document.xml")?.asText() ?? "";
  const media = Object.keys(zip.files).filter((p) => p.startsWith("word/media/"));
  const rels = zip.file("word/_rels/document.xml.rels")?.asText() ?? "";
  const imageRels = [...rels.matchAll(/Target="media\/([^"]+)"/g)].map((m) => m[1]!);

  const paras = doc.match(/<w:p[\s\S]*?<\/w:p>/g) ?? [];
  const hits: Array<{
    index: number;
    hasDrawing: boolean;
    contextBefore: string;
    contextAfter: string;
    sectionGuess: string;
  }> = [];

  let lastHeading = "";
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i]!;
    const text = extractText(p);
    if (/^([IVX]+\.|[0-9]+\.[0-9]+)/.test(text) || /Overview|Industry|Financial|Normalization|Valuation|Reconciliation/i.test(text)) {
      if (text.length < 120) lastHeading = text;
    }
    if (!p.includes("<w:drawing") && !p.includes("<w:pict")) continue;
    const before = paras
      .slice(Math.max(0, i - 5), i)
      .map(extractText)
      .filter((t) => t.length > 8)
      .slice(-2)
      .join(" | ");
    const after = paras
      .slice(i + 1, i + 4)
      .map(extractText)
      .filter((t) => t.length > 8)
      .slice(0, 1)
      .join(" | ");
    hits.push({
      index: hits.length + 1,
      hasDrawing: true,
      contextBefore: before.slice(0, 200),
      contextAfter: after.slice(0, 120),
      sectionGuess: lastHeading.slice(0, 100),
    });
  }

  const footerDrawings: string[] = [];
  for (const part of Object.keys(zip.files)) {
    if (!/^word\/(header|footer)\d+\.xml$/.test(part)) continue;
    const xml = zip.file(part)?.asText() ?? "";
    if (xml.includes("<w:drawing")) footerDrawings.push(part);
  }

  return { label, path, imageParagraphs: hits.length, mediaCount: media.length, imageRels, footerDrawings, hits };
}

const out = {
  generatedAt: new Date().toISOString(),
  premerge: auditDoc(premerge, "premerge"),
  kcfFinished: auditDoc(kcf, "kcf-finished"),
};

const outPath = join(process.cwd(), "scripts", "benchmark-output", "premerge-image-audit.json");
mkdirSync(join(process.cwd(), "scripts", "benchmark-output"), { recursive: true });
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log("Wrote", outPath);
console.log("Premerge images:", out.premerge.imageParagraphs, "media:", out.premerge.mediaCount);
for (const h of out.premerge.hits) {
  console.log(`#${h.index} [${h.sectionGuess}] ${h.contextBefore.slice(0, 80)}`);
}
