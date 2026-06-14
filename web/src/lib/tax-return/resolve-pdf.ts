import { readdir } from "node:fs/promises";
import path from "node:path";

/** Find a business tax return PDF for a year — no company-specific filename. */
export async function resolveTaxReturnPdf(docsDir: string, year: number): Promise<string> {
  const files = (await readdir(docsDir)).filter((f) => f.toLowerCase().endsWith(".pdf"));
  const ys = String(year);
  const matches = files.filter((f) => {
    const l = f.toLowerCase();
    if (!l.includes(ys)) return false;
    if (/business\s*tax|1120|tax\s*return/i.test(f)) return true;
    return l.includes(`${ys}-12-31`) || l.includes(`_${ys}_`);
  });
  if (!matches.length) throw new Error(`No tax return PDF for year ${year} in ${docsDir}`);
  matches.sort((a, b) => a.length - b.length);
  return path.join(docsDir, matches[0]!);
}