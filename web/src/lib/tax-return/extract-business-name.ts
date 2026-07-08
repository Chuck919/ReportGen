/** Normalize business name for same-client comparison across uploads. */
export function normalizeClientKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(inc|llc|l\.l\.c|corp|corporation|co|company|ltd)\b\.?/gi, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const JUNK_NAME =
  /^(do not send|keep for your records|officer'?s signature|under penalties|internal revenue|department of the treasury|form\s+\d|schedule\s+[a-z]|see instructions|u\.?s\.?\s+individual)/i;

function isPlausibleBusinessName(name: string): boolean {
  if (name.length < 4 || name.length > 80) return false;
  if (JUNK_NAME.test(name)) return false;
  if (/^(form|schedule|u\.?s\.?|internal revenue)/i.test(name)) return false;
  return true;
}

function cleanBusinessName(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/\b(OMB|EIN|DATE|SEE\s+INSTR|NUMBER)\b.*$/i, "")
    .replace(/^\d+\s*/, "")
    .trim();
}

/**
 * Best-effort taxpayer name from return cover / page 1 OCR.
 * Used to prevent merging Arizona + KCF in the same workbook session.
 */
export function extractBusinessName(text: string, filename?: string): string | undefined {
  const head = text.slice(0, 25_000);

  const patterns = [
    /PREPARED\s+FOR:\s*\n\s*([^\n]{3,80})/i,
    /(?:name\s+of\s+corporation|business\s+name|name\s+of\s+partnership|partnership(?:'s)?\s+name)[^\n]{0,60}\n\s*([^\n]{3,80})/i,
    /(?:^|\n)\s*([A-Z][A-Za-z0-9 &.,'()-]{4,70}(?:\s+LLC|\s+INC|\s+CORP|\s+LP|\s+LTD)\.?)\s*(?:\n|$)/m,
    /(?:^|\n)\s*([A-Z][A-Za-z0-9 &.,'()-]{6,70})\s*\n\s*\d{3,5}\s+[A-Z]/m,
  ];

  for (const re of patterns) {
    const m = head.match(re);
    if (m?.[1]) {
      const name = cleanBusinessName(m[1]);
      if (isPlausibleBusinessName(name)) return name;
    }
  }

  if (filename) {
    const base = filename.replace(/\.pdf$/i, "").trim();
    const fromName = base.match(/^(.+?)\s*(?:20\d{2}|tax|return)/i)?.[1]?.trim();
    if (fromName) {
      const name = cleanBusinessName(fromName);
      if (isPlausibleBusinessName(name)) return name;
    }
  }

  return undefined;
}

export function clientIdentityFromText(
  text: string,
  filename?: string,
): { clientName?: string; clientKey?: string } {
  const clientName = extractBusinessName(text, filename);
  if (!clientName) return {};
  const clientKey = normalizeClientKey(clientName);
  return clientKey.length >= 3 ? { clientName, clientKey } : { clientName };
}
