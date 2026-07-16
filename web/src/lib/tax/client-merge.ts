import type { ParsedTaxYear } from "@/lib/api/types";
import type { TaxYearValues } from "@/lib/tax-workbook";
import { enrichParsedTaxYear } from "@/lib/tax/apply-user-correction";
import { mergeTaxYearsByYear } from "./merge-years";

export function stampClientOnColumns(
  columns: TaxYearValues[],
  clientKey?: string,
  clientName?: string,
): TaxYearValues[] {
  if (!clientKey && !clientName) return columns;
  return columns.map((col) => ({
    ...col,
    clientKey: col.clientKey ?? clientKey,
    clientName: col.clientName ?? clientName,
  }));
}

/** Prefer real taxpayer captions over Schedule / preparer OCR bleed. */
export function clientKeyQuality(key: string): number {
  const t = key.toLowerCase().trim();
  if (!t) return -10;
  let score = 0;
  if (/\b(llc|inc|corp|company|services|supply)\b/.test(t)) score += 2;
  const tokens = t.split(/\s+/).filter(Boolean);
  if (tokens.length >= 2) score += 1;
  if (tokens.length >= 3) score += 1;
  // Form/schedule caption bleed (OCR of ownership / schedule headers as the taxpayer).
  if (/identification|incorporation|stock\s+owned|schedule\s*[a-z]|form\s*\d/.test(t)) score -= 6;
  // Lone tokens on cover pages are often the preparer firm, not the taxpayer.
  if (tokens.length === 1) score -= 1;
  // Repeated surname firm ("judd judd") after PLLC strip — preparer, not taxpayer.
  if (tokens.length === 2 && tokens[0] === tokens[1]) score -= 3;
  if (/\b(pllc|cpa|p\.?c\.?)\b/.test(t)) score -= 2;
  return score;
}

function keysShareIdentity(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const ta = new Set(a.split(/\s+/).filter((t) => t.length > 2));
  const tb = new Set(b.split(/\s+/).filter((t) => t.length > 2));
  if (!ta.size || !tb.size) return false;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared >= 1 && shared / Math.min(ta.size, tb.size) >= 0.5;
}

/**
 * Wipe the session only for a confident different-company upload.
 * Progressive multi-year uploads of the same taxpayer often OCR different cover
 * names (Schedule captions, preparer LLC) — those must not clear prior years.
 */
export function shouldClearForDifferentCompany(
  existingKey: string | undefined,
  incomingKey: string | undefined,
  existingYears: number[],
  incomingYears: number[],
): boolean {
  if (!existingKey || !incomingKey) return false;
  if (existingKey === incomingKey) return false;
  if (keysShareIdentity(existingKey, incomingKey)) return false;

  const qE = clientKeyQuality(existingKey);
  const qI = clientKeyQuality(incomingKey);
  // Either side looks like OCR/preparer junk — keep merging years.
  if (qE < 0 || qI < 0) return false;

  const existingSet = new Set(existingYears);
  const yearOverlap = incomingYears.some((y) => existingSet.has(y));
  // New-year progressive add: only clear when both names look like strong, distinct entities.
  // Threshold 3 avoids preparer OCR (q≈0–2) wiping a real taxpayer during multi-file upload.
  if (!yearOverlap) {
    return qE >= 3 && qI >= 3;
  }
  return true;
}

function pickPreferredIdentity(rows: Array<{ clientKey?: string; clientName?: string }>): {
  clientKey?: string;
  clientName?: string;
} {
  let best: { clientKey?: string; clientName?: string; score: number } | undefined;
  for (const row of rows) {
    if (!row.clientKey) continue;
    const score = clientKeyQuality(row.clientKey);
    if (!best || score > best.score) best = { clientKey: row.clientKey, clientName: row.clientName, score };
  }
  return best ? { clientKey: best.clientKey, clientName: best.clientName } : {};
}

/**
 * If incoming PDFs are a different company, replace the workbook instead of merging years.
 */
export function mergeParsedTaxYears(
  existing: TaxYearValues[],
  incoming: ParsedTaxYear[],
): { columns: TaxYearValues[]; warnings: string[] } {
  const warnings: string[] = [];
  const preferredIncoming = pickPreferredIdentity(incoming);
  const preferredExisting = pickPreferredIdentity(existing);
  const incomingKey = preferredIncoming.clientKey ?? incoming.find((r) => r.clientKey)?.clientKey;
  const incomingName = preferredIncoming.clientName ?? incoming.find((r) => r.clientName)?.clientName;
  const existingKey = preferredExisting.clientKey ?? existing.find((c) => c.clientKey)?.clientKey;

  let base = existing;
  if (
    shouldClearForDifferentCompany(
      existingKey,
      incomingKey,
      existing.map((c) => c.year),
      incoming.map((r) => r.year),
    )
  ) {
    // Do not surface OCR'd legal names — extraction is unreliable (preparer vs taxpayer bleed).
    warnings.push(
      "Different company detected. Cleared previous results so this upload starts a new workbook.",
    );
    base = [];
  }

  // Prefer the stronger taxpayer key when stamping blanks (avoid locking onto OCR junk).
  const stampKey = pickPreferredIdentity([
    ...incoming.map((r) => ({ clientKey: r.clientKey, clientName: r.clientName })),
    ...base.map((c) => ({ clientKey: c.clientKey, clientName: c.clientName })),
  ]);
  const stamped = stampClientOnColumns(
    incoming.map(enrichParsedTaxYear),
    stampKey.clientKey ?? incomingKey,
    stampKey.clientName ?? incomingName,
  );
  return { columns: mergeTaxYearsByYear(base, stamped), warnings };
}
