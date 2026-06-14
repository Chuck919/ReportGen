import type { TaxYearValues } from "@/lib/tax-workbook";

const STORAGE_KEY = "reportgen-tax-columns-v1";

function readStore(): TaxYearValues[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as TaxYearValues[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStore(columns: TaxYearValues[]): void {
  if (typeof window === "undefined") return;
  try {
    if (!columns.length) {
      localStorage.removeItem(STORAGE_KEY);
      sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    const json = JSON.stringify(columns);
    localStorage.setItem(STORAGE_KEY, json);
    sessionStorage.setItem(STORAGE_KEY, json);
  } catch {
    // quota or private mode — ignore
  }
}

export function loadTaxColumns(): TaxYearValues[] {
  return readStore();
}

export function saveTaxColumns(columns: TaxYearValues[]): void {
  writeStore(columns);
}

export function clearTaxColumnsStorage(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(STORAGE_KEY);
  sessionStorage.removeItem(STORAGE_KEY);
}
