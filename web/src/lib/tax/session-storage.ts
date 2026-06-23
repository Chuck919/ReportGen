import type { TaxYearValues } from "@/lib/tax-workbook";

/** Session-only — closing the tab clears data (no cross-company bleed via localStorage). */
const STORAGE_KEY = "reportgen-tax-session-v2";
const LEGACY_KEY = "reportgen-tax-columns-v1";

export type TaxWorkbookSession = {
  clientKey?: string;
  clientName?: string;
  columns: TaxYearValues[];
  busy?: boolean;
  progressLabel?: string;
  progressPercent?: number;
  progressHint?: string;
  error?: string;
  batchWarnings?: string[];
  fileErrors?: Array<{ filename: string; message: string }>;
  partial?: boolean;
};

function readSession(): TaxWorkbookSession {
  if (typeof window === "undefined") return { columns: [] };
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as TaxWorkbookSession;
      if (parsed && Array.isArray(parsed.columns)) return parsed;
    }

    // One-time migration from legacy localStorage (then discard legacy).
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      localStorage.removeItem(LEGACY_KEY);
      const cols = JSON.parse(legacy) as TaxYearValues[];
      if (Array.isArray(cols) && cols.length) {
        return {
          clientKey: cols.find((c) => c.clientKey)?.clientKey,
          clientName: cols.find((c) => c.clientName)?.clientName,
          columns: cols,
        };
      }
    }
  } catch {
    // ignore
  }
  return { columns: [] };
}

function writeSession(session: TaxWorkbookSession): void {
  if (typeof window === "undefined") return;
  try {
    if (!session.columns.length && !session.busy) {
      sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // quota or private mode
  }
}

export function loadTaxSession(): TaxWorkbookSession {
  return readSession();
}

export function loadTaxColumns(): TaxYearValues[] {
  return readSession().columns;
}

export function saveTaxSession(session: TaxWorkbookSession): void {
  writeSession(session);
}

export function saveTaxColumns(columns: TaxYearValues[]): void {
  const prev = readSession();
  writeSession({
    clientKey: columns[0]?.clientKey ?? prev.clientKey,
    clientName: columns[0]?.clientName ?? prev.clientName,
    columns,
    busy: prev.busy,
    progressLabel: prev.progressLabel,
    progressPercent: prev.progressPercent,
    progressHint: prev.progressHint,
    error: prev.error,
    batchWarnings: prev.batchWarnings,
    fileErrors: prev.fileErrors,
    partial: prev.partial,
  });
}

export function saveTaxProgress(session: Partial<TaxWorkbookSession>): void {
  const prev = readSession();
  writeSession({ ...prev, ...session });
}

export function clearTaxColumnsStorage(): void {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(LEGACY_KEY);
}
