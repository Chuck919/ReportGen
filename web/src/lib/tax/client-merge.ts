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

export type ClientKeyQuality = "unreliable" | "plausible" | "strong-entity";

/** Classify taxpayer identity from caption structure, without weighted score cutoffs. */
export function clientKeyQuality(key: string): ClientKeyQuality {
  const t = key.toLowerCase().trim();
  if (!t) return "unreliable";
  // Form/schedule caption bleed (OCR of ownership / schedule headers as the taxpayer).
  if (/identification|incorporation|stock\s+owned|schedule\s*[a-z]|form\s*\d/.test(t)) {
    return "unreliable";
  }
  // Repeated-surname firm name after PLLC strip — preparer, not taxpayer.
  if (/^(\S+)\s+\1$/i.test(t) || /\b(pllc|cpa|p\.?c\.?)\b/.test(t)) {
    return "unreliable";
  }
  if (
    /\b(llc|inc|corp|corporation|company|services|service|supply)\b/.test(t) &&
    /[a-z]{3,}/i.test(t)
  ) {
    return "strong-entity";
  }
  return "plausible";
}

function keysShareIdentity(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const generic = new Set([
    "llc", "inc", "corp", "corporation", "company", "services", "service",
    "supply", "the", "and",
  ]);
  const identityTokens = (key: string) =>
    new Set(key.split(/\s+/).filter((token) => /[a-z]{3,}/i.test(token) && !generic.has(token)));
  const ta = identityTokens(a);
  const tb = identityTokens(b);
  if (!ta.size || !tb.size) return false;
  return [...ta].some((token) => tb.has(token));
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
  if (qE === "unreliable" || qI === "unreliable") return false;

  const existingSet = new Set(existingYears);
  const yearOverlap = incomingYears.some((y) => existingSet.has(y));
  // New-year progressive add: only clear for two explicit legal-entity captions.
  if (!yearOverlap) {
    return qE === "strong-entity" && qI === "strong-entity";
  }
  return true;
}

function pickPreferredIdentity(rows: Array<{ clientKey?: string; clientName?: string }>): {
  clientKey?: string;
  clientName?: string;
} {
  let best: { clientKey?: string; clientName?: string; quality: ClientKeyQuality } | undefined;
  for (const row of rows) {
    if (!row.clientKey) continue;
    const quality = clientKeyQuality(row.clientKey);
    const outranks =
      !best ||
      (quality === "strong-entity" && best.quality !== "strong-entity") ||
      (quality === "plausible" && best.quality === "unreliable");
    if (outranks) best = { clientKey: row.clientKey, clientName: row.clientName, quality };
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
