import { readFileSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";

const repoRoot = join(process.cwd(), "..");
const src = join(repoRoot, "Documents", "MAIN CURRENT REPORT premerge.docx");
const out = join(process.cwd(), "public", "templates", "main-current-premerge.docx");

mkdirSync(join(process.cwd(), "public", "templates"), { recursive: true });
copyFileSync(src, out);

const buffer = readFileSync(out);
const zip = new PizZip(buffer);
const doc = new Docxtemplater(zip, {
  delimiters: { start: "«", end: "»" },
  paragraphLoop: true,
  linebreaks: true,
  nullGetter: () => "",
});

const data: Record<string, string> = {
  entity: "Test Entity LLC",
  valuation_date: "December 31, 2025",
  date_of_issuance: "July 8, 2026",
  engaging_party: "Test Bank",
  title: "VP Lending",
  company: "Test Bank",
  city: "Kansas City, MO",
  purpose: "SBA lending support",
  reconciled_value: "$801,929",
  abbreviation: "TE",
  NAICS: "445292",
  NAICS_Desc: "Confectionery Retail",
  comp_description: "A specialty retail confectionery business.",
  income_value: "$801,929",
  asset_method_value: "$4,500",
  market_value: "$790,000",
  cap_rate: "27.27%",
  WACC: "18.5%",
  benefit_stream: "$143,777",
  goodwill: "$797,429",
  assets_: "$5,000",
};

try {
  doc.render(data);
  const merged = doc.getZip().generate({ type: "nodebuffer" }) as Buffer;
  console.log("merge ok", merged.length, "bytes");
} catch (error) {
  console.error("merge failed", error);
  process.exit(1);
}
