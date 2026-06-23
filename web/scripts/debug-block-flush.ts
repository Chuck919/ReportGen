import { readFile } from "node:fs/promises";
import path from "node:path";
import { getEmbeddedPdfText } from "./lib/pdf-embedded-text";
import { resolveTaxReturnPdf } from "../src/lib/tax-return/resolve-pdf";
import {
  isFormReferenceNumber,
  isReasonableMoneyAmount,
  lineMoneyTokens,
  parseMoney,
  statementLineAmount,
  substantialMoneyTokens,
} from "../src/lib/tax-return/money";

const OPEX_DETAIL_LINE =
  /office\s+exp|supplies\b|telephone\b|travel\b|bank\s+charg|miscellaneous\b/i;

function isOtherDeductionsBlockHeader(line: string): boolean {
  if (/statement\s*[23]\b|stmt\s*[23]\b/i.test(line) && /other\s+deduct/i.test(line)) return true;
  return /statement\s*2|stmt\s*2|line\s*(?:19|20)\b.*other\s+deductions/i.test(line);
}

function endsOtherDeductionsBlock(line: string): boolean {
  if (/statement\s*[3-9]|stmt\s*[3-9]/i.test(line) && !/other\s+deduct/i.test(line)) return true;
  if (/statement\s*4|stmt\s*4/i.test(line)) return true;
  return false;
}

async function main() {
  const pdf = await resolveTaxReturnPdf(
    path.resolve("../Documents/For Changwen/arizona-sun-supply"),
    2022,
  );
  const text = await getEmbeddedPdfText(await readFile(pdf));
  let inBlock = false;
  let stmtTotal: number | undefined;
  let utilities = 0;
  let autoTruck = 0;
  let licenses = 0;
  let merchant = 0;

  const flush = () => {
    console.log("FLUSH", { stmtTotal, utilities, autoTruck, licenses, merchant });
    if (stmtTotal !== undefined && stmtTotal >= 100_000 && utilities > 0) {
      const large = Math.round(stmtTotal - utilities - autoTruck - licenses - merchant);
      console.log("LARGE", large);
    }
  };

  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;
    if (isOtherDeductionsBlockHeader(line)) {
      if (inBlock) flush();
      inBlock = true;
      continue;
    }
    if (inBlock && endsOtherDeductionsBlock(line)) {
      flush();
      inBlock = false;
      continue;
    }
    if (!inBlock) continue;
    if (/^total\s+to\s+form/i.test(line)) {
      const commaAmounts = Array.from(line.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d{2})?/g))
        .map((x) => parseMoney(x[0]))
        .filter((n): n is number => n !== null && Math.abs(n) >= 1_000 && !isFormReferenceNumber(Math.abs(n)));
      stmtTotal = commaAmounts.length ? Math.max(...commaAmounts.map((n) => Math.abs(n))) : undefined;
      console.log("SET TOTAL", stmtTotal, line);
      continue;
    }
    let abs: number | undefined;
    const amt = statementLineAmount(line);
    if (amt !== undefined && isReasonableMoneyAmount(amt)) abs = Math.round(Math.abs(amt));
    if (abs === undefined || abs < 10) continue;
    if (/^utilities\b/i.test(line)) utilities = Math.max(utilities, abs);
    else if (/auto\s+and\s+truck/i.test(line)) autoTruck = abs;
    else if (/licenses?\s+and\s+permits/i.test(line)) licenses = abs;
    else if (/merchant\s+svc|merchant\s+service|merchant\s+fee/i.test(line)) merchant = abs;
  }
}

main();
