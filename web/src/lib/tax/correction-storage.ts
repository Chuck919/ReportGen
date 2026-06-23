import type { TaxYearValues } from "@/lib/tax-workbook";

export type FieldCandidateOption = {
  value: number;
  source: string;
  kind?: "alternate" | "opex" | "manual";
  confidence?: number;
  closureScore?: number;
  evidenceScore?: number;
  consistencyScore?: number;
  totalScore?: number;
  valid?: boolean;
};

export type CorrectionCandidateScores = {
  closure?: number;
  evidence?: number;
  consistency?: number;
  total?: number;
};

export type TaxFieldCorrection = {
  id: string;
  createdAt: string;
  clientKey?: string;
  clientName?: string;
  year: number;
  fieldId: string;
  parserValue?: number;
  correctedValue: number;
  chosenSource?: string;
  rejectedOptions?: FieldCandidateOption[];
  /** Structured scores for the parser's chosen candidate (ML training). */
  chosenCandidateScores?: CorrectionCandidateScores;
  /** Confidence warning codes active when the user corrected. */
  flags?: string[];
  filename?: string;
};

const STORAGE_KEY = "reportgen-tax-corrections-v1";

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function storage(): Storage | null {
  if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  if (typeof globalThis.localStorage !== "undefined") return globalThis.localStorage;
  return null;
}

export function loadTaxCorrections(): TaxFieldCorrection[] {
  const s = storage();
  if (!s) return [];
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as TaxFieldCorrection[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveTaxCorrections(rows: TaxFieldCorrection[]): void {
  const s = storage();
  if (!s) return;
  s.setItem(STORAGE_KEY, JSON.stringify(rows.slice(-500)));
}

export function appendTaxCorrection(correction: Omit<TaxFieldCorrection, "id" | "createdAt">): TaxFieldCorrection {
  const row: TaxFieldCorrection = {
    ...correction,
    id: newId(),
    createdAt: new Date().toISOString(),
  };
  const existing = loadTaxCorrections();
  saveTaxCorrections([...existing, row]);
  return row;
}

export async function syncTaxCorrectionToServer(correction: TaxFieldCorrection): Promise<void> {
  try {
    await fetch("/api/tax-corrections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(correction),
    });
  } catch {
    // Offline or read-only deploy — localStorage is the source of truth.
  }
}

export function candidateOptionsForField(
  col: TaxYearValues | undefined,
  fieldId: string,
): FieldCandidateOption[] {
  if (!col) return [];
  const out: FieldCandidateOption[] = [];
  const seen = new Set<number>();

  const push = (opt: FieldCandidateOption) => {
    if (seen.has(opt.value)) return;
    seen.add(opt.value);
    out.push(opt);
  };

  for (const opt of col.fieldCandidateOptions?.[fieldId] ?? []) push(opt);
  for (const alt of col.fieldAlternates?.[fieldId] ?? []) {
    push({
      value: alt.value,
      source: alt.sourceLabel ? `${alt.family} (${alt.sourceLabel})` : alt.family,
      kind: "alternate",
      confidence: alt.confidence,
    });
  }

  const parser = col.parserBaseline?.[fieldId];
  if (parser !== undefined) {
    push({ value: parser, source: col.fieldSources?.[fieldId] ?? "Parser", kind: "alternate" });
  }

  return out.sort((a, b) => (b.totalScore ?? b.confidence ?? 0) - (a.totalScore ?? a.confidence ?? 0));
}
