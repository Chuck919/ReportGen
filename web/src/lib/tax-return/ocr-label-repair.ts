/** Strip leading OCR junk (form marks, brackets, symbols). */
export function stripOcrLinePrefix(line: string): string {
  return line
    .replace(/^[\s|§£€[\]{}#@*\\/>~_:=+]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const WORD_REPAIRS: Array<[RegExp, string]> = [
  [/\badetsing\b/gi, "advertising"],
  [/\badvert?is(?:ing|ng)\b/gi, "advertising"],
  [/\btees\s*and\s*li(?:c|es)(?:enses?)?\b/gi, "taxes and licenses"],
  [/\btaes\s*and\s*li(?:c|es)\b/gi, "taxes and licenses"],
  [/\bteesandlicenses?\b/gi, "taxes and licenses"],
  [/\botner\b/gi, "other"],
  [/\butilit(?:y|ies|es)\b/gi, "utilities"],
  [/\bprofes{1,2}ional\b/gi, "professional"],
  [/\bcompensat(?:ion)?\s*of\s*officers?\b/gi, "compensation of officers"],
  [/\bsalar(?:y|ies)\s*and\s*wages?\b/gi, "salaries and wages"],
  [/\bmerchant\s*svc\b/gi, "merchant service"],
  [/\baccounting\s*&\s*legal\b/gi, "accounting legal"],
  [/\blegal\s+and\s+professional\b/gi, "legal and professional"],
  [/\brepairs?\s+and\s+maint(?:enance)?\b/gi, "repairs and maintenance"],
  [/\bbank\s*&\s*credit\s+card\b/gi, "bank credit card"],
  [/\bcost\s+of\s+(?:goods|sales)\b/gi, "cost of goods sold"],
  [/\baxes\s+and\s+lic/i, "taxes and licenses"],
  [/\bross\s+receipts?\b/gi, "gross receipts"],
  [/\bost\s+of\s+goods\b/gi, "cost of goods"],
  [/\bompensation\s+of\s+officers?\b/gi, "compensation of officers"],
  [/\balaries\s+and\s+wages?\b/gi, "salaries and wages"],
  [/\brofessional\b/gi, "professional"],
  [/\brofessional\s+fees?\b/gi, "professional fees"],
  [/\btilities\b/gi, "utilities"],
  [/\btatement\s*2\b/gi, "statement 2"],
  [/\bther\s+deduct/i, "other deduct"],
  [/\bank\s*&\s*credit\s+card\s+charg/i, "bank credit card charges"],
  [/\bdues\s*&\s*subscriptions?\b/gi, "dues and subscriptions"],
  [/\btravel\s*&\s*mileage\b/gi, "travel and mileage"],
];

/** Repair common OCR typos in a label line (generalized, not client-specific). */
export function repairOcrLabel(line: string): string {
  let t = stripOcrLinePrefix(line).toLowerCase();
  for (const [re, rep] of WORD_REPAIRS) {
    t = t.replace(re, rep);
  }
  return t.replace(/\s+/g, " ").trim();
}

/** Lines to test against label patterns — includes simple missing-first-character variants. */
export function ocrLabelMatchVariants(line: string): string[] {
  const repaired = repairOcrLabel(line);
  const variants = new Set<string>([line, repaired, stripOcrLinePrefix(line)]);
  const words = repaired.split(/\s+/).filter(Boolean);
  if (words[0] && words[0].length >= 4) {
    for (const ch of "aetoucrsl") {
      variants.add(`${ch}${repaired}`);
      variants.add(`${ch}${words[0].slice(1)} ${words.slice(1).join(" ")}`.trim());
    }
  }
  return [...variants].filter(Boolean);
}

export function lineMatchesLabelPattern(line: string, pattern: RegExp): boolean {
  return ocrLabelMatchVariants(line).some((v) => pattern.test(v));
}

/** Reject amounts scraped from EIN / payment-instruction noise. */
export function isEinOrPaymentInstructionBleed(line: string, amount: number): boolean {
  const t = line.toLowerCase();
  if (/\b(?:fein|ein|employer\s+ident|tax\s+period|payment\s+type|credit\s+card\s*\(fees)\b/i.test(t)) {
    return true;
  }
  const ein = line.match(/\b(\d{2})-(\d{7})\b/);
  if (ein) {
    const suffix = ein[2]!;
    const amt = String(Math.round(Math.abs(amount)));
    if (suffix === amt || suffix.endsWith(amt) || amt === `${ein[1]}${suffix}`) return true;
  }
  if (/\bcredit\s+card\b/i.test(t) && /payment|instruction|apply|banking\s+information/i.test(t)) {
    return true;
  }
  return false;
}
