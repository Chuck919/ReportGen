/**
 * Converts Word MERGEFIELD complex fields to docxtemplater «placeholder» runs.
 * The Blue Owl premerge template uses MERGEFIELD wrappers around «field» display text;
 * docxtemplater only replaces bare «field» tokens reliably when MERGEFIELD instrText is removed.
 */

const SKIP_FIELD = /^(TOC|PAGEREF|HYPERLINK|LINK|STYLEREF|SEQ|INDEX|XE|AUTOTEXT)/i;

/** Count MERGEFIELD tokens that should have been converted (excludes TOC/PAGEREF). */
export function countRemainingDataMergeFields(xml: string): number {
  const names: string[] = [];
  for (const match of xml.matchAll(/<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/gi)) {
    const name = extractMergeFieldName(match[1] ?? "");
    if (name) names.push(name);
  }
  for (const match of xml.matchAll(/w:instr="([^"]*)"/gi)) {
    const name = extractMergeFieldName(match[1] ?? "");
    if (name) names.push(name);
  }
  return names.length;
}

function extractMergeFieldName(instrText: string): string | null {
  const decoded = instrText.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  const match = decoded.match(/MERGEFIELD\s+"([^"]+)"|MERGEFIELD\s+([^\s\\]+)/i);
  if (!match) return null;
  const name = (match[1] || match[2] || "").trim();
  if (!name || SKIP_FIELD.test(name)) return null;
  return name;
}

function convertFldSimpleFields(xml: string): { xml: string; converted: number } {
  let converted = 0;
  const result = xml.replace(/<w:fldSimple\b[\s\S]*?<\/w:fldSimple>/gi, (block) => {
    const instrMatch = block.match(/w:instr="([^"]*)"/i);
    if (!instrMatch) return block;
    const name = extractMergeFieldName(instrMatch[1] ?? "");
    if (!name) return block;
    converted += 1;
    return placeholderRun(name);
  });
  return { xml: result, converted };
}

function placeholderRun(field: string, runProps?: string): string {
  const rPr = runProps ? `<w:rPr>${runProps}</w:rPr>` : "";
  return `<w:r>${rPr}<w:t xml:space="preserve">«${field}»</w:t></w:r>`;
}

function findFieldBlock(xml: string, instrIndex: number): { start: number; end: number; name: string } | null {
  const instrOpen = xml.lastIndexOf("<w:instrText", instrIndex);
  if (instrOpen < 0) return null;
  const instrClose = xml.indexOf("</w:instrText>", instrIndex);
  if (instrClose < 0) return null;
  const instrBody = xml.slice(instrOpen, instrClose + "</w:instrText>".length);
  const name = extractMergeFieldName(instrBody);
  if (!name) return null;

  const beginMarker = 'w:fldCharType="begin"';
  let begin = xml.lastIndexOf(beginMarker, instrOpen);
  if (begin < 0) return null;
  begin = xml.lastIndexOf("<w:r", begin);
  if (begin < 0) return null;

  const endMarker = 'w:fldCharType="end"';
  let end = xml.indexOf(endMarker, instrClose);
  if (end < 0) return null;
  end = xml.indexOf("</w:r>", end);
  if (end < 0) return null;
  end += "</w:r>".length;

  return { start: begin, end, name };
}

/** Replace MERGEFIELD blocks with «field» placeholders. Processes right-to-left to preserve indices. */
export function convertMergeFieldsToGuillemets(xml: string): { xml: string; converted: number } {
  const blocks: Array<{ start: number; end: number; name: string }> = [];
  const instrPattern = /<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/gi;
  let match: RegExpExecArray | null;
  while ((match = instrPattern.exec(xml)) !== null) {
    if (!/MERGEFIELD/i.test(match[1] ?? "")) continue;
    const block = findFieldBlock(xml, match.index);
    if (!block) continue;
    if (blocks.some((b) => b.start === block.start)) continue;
    blocks.push(block);
  }

  blocks.sort((a, b) => b.start - a.start);
  let result = xml;
  for (const block of blocks) {
    result = result.slice(0, block.start) + placeholderRun(block.name) + result.slice(block.end);
  }

  return { xml: result, converted: blocks.length };
}

/** Remove stale Excel LINK field paragraphs (integrator workbook link — replaced by merge data). */
export function removeExcelLinkFields(xml: string): { xml: string; removed: number } {
  let removed = 0;
  let result = xml.replace(/<w:fldSimple\b[\s\S]*?<\/w:fldSimple>/gi, (block) => {
    if (!/LINK\s+Excel\.Sheet/i.test(block)) return block;
    removed += 1;
    return `<w:p><w:r><w:t xml:space="preserve">«BS_Normalization_Summary»</w:t></w:r></w:p>`;
  });
  result = result.replace(/<w:p[\s\S]*?<\/w:p>/g, (paragraph) => {
    if (!/LINK\s+Excel\.Sheet/i.test(paragraph)) return paragraph;
    removed += 1;
    return `<w:p><w:r><w:t xml:space="preserve">«BS_Normalization_Summary»</w:t></w:r></w:p>`;
  });
  return { xml: result, removed };
}

export function prepareWordXmlForDocxtemplater(xml: string): { xml: string; mergeFieldsConverted: number; linksRemoved: number } {
  const linkPass = removeExcelLinkFields(xml);
  const simplePass = convertFldSimpleFields(linkPass.xml);
  const mergePass = convertMergeFieldsToGuillemets(simplePass.xml);
  return {
    xml: mergePass.xml,
    mergeFieldsConverted: simplePass.converted + mergePass.converted,
    linksRemoved: linkPass.removed,
  };
}
