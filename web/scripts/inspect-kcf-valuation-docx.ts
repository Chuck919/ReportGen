import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const extracted = join(tmpdir(), "kcf-val-inspect", "word", "document.xml");
const xml = readFileSync(extracted, "utf8");

const text = xml
  .replace(/<w:tab[^/]*\/>/g, "\t")
  .replace(/<w:br[^/]*\/>/g, "\n")
  .replace(/<[^>]+>/g, "")
  .replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"')
  .replace(/\s+\n/g, "\n")
  .replace(/\n\s+/g, "\n")
  .replace(/[ \t]+/g, " ");

const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 2);

const sectionRe =
  /^(I{1,3}V?|VI{0,3}|IX|X{0,3}|XI{0,3}|XII{0,3})\.\s|TABLE OF CONTENTS|VALUATION SUMMARY|RECONCILIATION|APPENDIX/i;

console.log("=== MAJOR SECTION HEADINGS ===");
for (const line of lines) {
  if (sectionRe.test(line) && line.length < 120) console.log(line);
}

console.log("\n=== KEY VALUES / PHRASES ===");
for (const line of lines) {
  if (
    (/\$801|801,929|reconciled|indicated value|DLOM|capitalization/i.test(line) ||
      /Blue Owl|Main Current|K\.?C\.? Fudge/i.test(line)) &&
    line.length < 160
  ) {
    console.log(line);
  }
}

console.log("\n=== MERGE / FIELD INSTRUCTIONS ===");
const instr = [...xml.matchAll(/<w:instrText[^>]*>([^<]+)<\/w:instrText>/g)].map((m) => m[1]?.trim());
const uniqueInstr = [...new Set(instr)].filter(Boolean).slice(0, 30);
console.log(uniqueInstr.join("\n") || "(none)");

console.log("\n=== STATS ===");
console.log({
  textChars: text.length,
  lineCount: lines.length,
  embeddedImages: (xml.match(/wp:docPr/g) ?? []).length,
  tables: (xml.match(/<w:tbl/g) ?? []).length,
  drawings: (xml.match(/<w:drawing/g) ?? []).length,
});

// Also inspect premerge template if extracted
import { existsSync } from "node:fs";
const premerge = join(tmpdir(), "main-premerge-inspect", "word", "document.xml");
if (existsSync(premerge)) {
  const preXml = readFileSync(premerge, "utf8");
  const fields = [
    ...preXml.matchAll(/MERGEFIELD\s+([^\\\s]+)/g),
  ].map((m) => m[1]?.replace(/&quot;/g, '"').replace(/^"|"$/g, "") ?? "");
  const uniq = [...new Set(fields)].filter(Boolean).sort();
  console.log("\n=== PREMERGE MERGEFIELDS ===");
  console.log("count:", uniq.length);
  uniq.forEach((f) => console.log(f));
}
