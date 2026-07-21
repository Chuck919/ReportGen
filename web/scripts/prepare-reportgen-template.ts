/**
 * Builds ReportGen's edited copy of the Blue Owl premerge template:
 * - Replaces embedded static images (IBIS, etc.) with «GRAPHIC_*» merge-field placeholders
 * - Converts Word MERGEFIELD wrappers to bare «field» tokens for docxtemplater
 * - Removes stale Excel LINK fields (replaced by BS_Normalization_Summary merge)
 * - Prunes legacy word/media/* assets no longer referenced
 *
 * Run: npx tsx scripts/prepare-reportgen-template.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import PizZip from "pizzip";
import { REPORTGEN_GRAPHIC_SLOT_NAMES } from "@/lib/valuation/word-chart-markers";
import { prepareWordXmlForDocxtemplater } from "@/lib/valuation/word-merge-field-strip";

const repoRoot = join(process.cwd(), "..");
const source = join(repoRoot, "Documents", "MAIN CURRENT REPORT premerge.docx");
const destDoc = join(repoRoot, "Documents", "MAIN CURRENT REPORT reportgen.docx");
const destPublic = join(process.cwd(), "public", "templates", "main-current-reportgen.docx");

if (!existsSync(source)) {
  console.error("Source template not found:", source);
  process.exit(1);
}

function placeholderParagraph(slot: string): string {
  return `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:t xml:space="preserve">«${slot}»</w:t></w:r></w:p>`;
}

function replaceImageParagraphs(documentXml: string, slots: readonly string[]): { xml: string; replaced: number } {
  let slotIndex = 0;
  let replaced = 0;

  const xml = documentXml.replace(/<w:p[\s\S]*?<\/w:p>/g, (paragraph) => {
    const hasImage = paragraph.includes("<w:drawing") || paragraph.includes("<w:pict");
    if (!hasImage) return paragraph;
    const slot = slots[slotIndex];
    if (!slot) return "";
    slotIndex += 1;
    replaced += 1;
    return placeholderParagraph(slot);
  });

  return { xml, replaced };
}

function replaceFooterLogo(footerXml: string): { xml: string; replaced: number } {
  if (!footerXml.includes("<w:drawing") && !footerXml.includes("<w:pict")) {
    return { xml: footerXml, replaced: 0 };
  }
  let replaced = 0;
  const xml = footerXml.replace(/<w:p[\s\S]*?<\/w:p>/g, (paragraph) => {
    if (!paragraph.includes("<w:drawing") && !paragraph.includes("<w:pict")) return paragraph;
    replaced += 1;
    return placeholderParagraph("GRAPHIC_firm_logo");
  });
  return { xml, replaced };
}

function pruneUnusedMedia(zip: PizZip): number {
  const partXmls: string[] = [];
  for (const path of Object.keys(zip.files)) {
    if (!/^word\/(document|header\d+|footer\d+)\.xml$/.test(path)) continue;
    partXmls.push(zip.file(path)?.asText() ?? "");
  }
  const combinedParts = partXmls.join("");

  const referencedRels = new Set<string>();
  for (const match of combinedParts.matchAll(/r:(?:embed|link)="(rId\d+)"/g)) {
    referencedRels.add(match[1]!);
  }

  let removed = 0;
  for (const relsPath of Object.keys(zip.files)) {
    if (!/^word\/_rels\/(document|header\d+|footer\d+)\.xml\.rels$/.test(relsPath)) continue;
    let relsXml = zip.file(relsPath)?.asText() ?? "";
    const partPath = relsPath.replace("/_rels/", "/").replace(".rels", "");
    const partXml = zip.file(partPath)?.asText() ?? "";

    relsXml = relsXml.replace(/<Relationship\b[^>]*\/>/g, (rel) => {
      const id = rel.match(/Id="(rId\d+)"/)?.[1];
      const target = rel.match(/Target="([^"]+)"/)?.[1];
      const isImage = rel.includes("relationships/image");
      if (!id) return rel;
      if (!partXml.includes(id) && !referencedRels.has(id)) {
        if (isImage && target?.startsWith("media/")) {
          const mediaPath = `word/${target}`;
          if (zip.files[mediaPath]) {
            delete zip.files[mediaPath];
            removed += 1;
          }
        }
        removed += 1;
        return "";
      }
      return rel;
    });
    zip.file(relsPath, relsXml);
  }

  for (const path of Object.keys(zip.files)) {
    if (!path.startsWith("word/media/")) continue;
    let stillReferenced = false;
    for (const relsPath of Object.keys(zip.files)) {
      if (!relsPath.endsWith(".rels")) continue;
      const relsXml = zip.file(relsPath)?.asText() ?? "";
      const fileName = path.replace("word/media/", "");
      if (relsXml.includes(`Target="media/${fileName}"`)) {
        stillReferenced = true;
        break;
      }
    }
    if (!stillReferenced) {
      delete zip.files[path];
      removed += 1;
    }
  }

  return removed;
}

function buildReportgenTemplate(sourceBuffer: Buffer): Buffer {
  const zip = new PizZip(sourceBuffer);
  let totalMergeConverted = 0;
  let totalLinksRemoved = 0;
  const bodySlots = REPORTGEN_GRAPHIC_SLOT_NAMES.filter((slot) => slot !== "GRAPHIC_firm_logo");

  for (const path of Object.keys(zip.files)) {
    if (!/^word\/(document|header\d+|footer\d+)\.xml$/.test(path)) continue;
    const part = zip.file(path)?.asText();
    if (!part) continue;

    let xml = part;
    let replaced = 0;
    if (path === "word/document.xml") {
      const imagesPass = replaceImageParagraphs(part, bodySlots);
      xml = imagesPass.xml;
      replaced = imagesPass.replaced;
    } else if (/^word\/footer\d+\.xml$/.test(path)) {
      const footerPass = replaceFooterLogo(part);
      xml = footerPass.xml;
      replaced = footerPass.replaced;
    }

    const prepared = prepareWordXmlForDocxtemplater(xml);
    zip.file(path, prepared.xml);
    totalMergeConverted += prepared.mergeFieldsConverted;
    totalLinksRemoved += prepared.linksRemoved;
    if (path === "word/document.xml") {
      console.log(`Replaced ${replaced} embedded image paragraph(s) with graphic placeholders.`);
    }
    if (replaced > 0 && path.startsWith("word/footer")) {
      console.log(`Replaced footer logo in ${path} with «GRAPHIC_firm_logo».`);
    }
  }

  const pruned = pruneUnusedMedia(zip);
  console.log(`Converted ${totalMergeConverted} MERGEFIELD block(s) to «placeholders».`);
  console.log(`Replaced ${totalLinksRemoved} Excel LINK paragraph(s).`);
  console.log(`Pruned ${pruned} legacy media file(s) / relationship(s).`);
  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
}

const sourceBuffer = readFileSync(source);
const output = buildReportgenTemplate(sourceBuffer);

mkdirSync(join(process.cwd(), "public", "templates"), { recursive: true });
writeFileSync(destDoc, output);
writeFileSync(destPublic, output);

console.log("Wrote:", destDoc);
console.log("Wrote:", destPublic);
