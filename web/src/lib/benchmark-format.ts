/** Shared number formatting for benchmark ratios (matches workbook paste style). */
export function r2(x: number): string {
  if (!Number.isFinite(x)) return "";
  const a = Math.abs(x);
  if (a >= 100) return x.toFixed(2);
  if (a >= 1) return x.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return x.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

/** Excel-friendly percent text (e.g. `41%`) from a 0–1 ratio. */
export function formatPercentDisplay(ratio: number): string {
  if (!Number.isFinite(ratio)) return "";
  const pct = ratio * 100;
  const rounded = Math.round(pct * 100) / 100;
  if (Math.abs(rounded - Math.round(rounded)) < 1e-9) return `${Math.round(rounded)}%`;
  return `${rounded}%`;
}
