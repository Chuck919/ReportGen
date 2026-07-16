import type { ResolvedFields } from "./merge";
import { computeWorkbookFormulas } from "@/lib/tax/workbook-formulas";

function dollarsEqual(a: number, b: number): boolean {
  return Math.round(a) === Math.round(b);
}

function isScheduleLRetainedSource(source: string | undefined): boolean {
  return (
    /schedule\s+l/i.test(source ?? "") &&
    /line\s*24|23\+25|retained|unappropriated|apic \+ retained/i.test(source ?? "")
  );
}

function isPairedColumnEmbeddedOseSource(source: string | undefined): boolean {
  return /embedded schedule l \(paired-column\)/i.test(source ?? "");
}

function isWeakEquityBleedSource(source: string | undefined, confidence?: number): boolean {
  if (/embedded schedule l/i.test(source ?? "")) return false;
  if (/user correction|user selected/i.test(source ?? "")) return false;
  if (/schedule\s+l.*line\s*24|unappropriated/i.test(source ?? "")) {
    return (confidence ?? 70) < 95;
  }
  return /ocr label|label match|fuzzy|two-year comparison/i.test(source ?? "");
}

/** IRS-common nominal par values for capital stock (layout convention, not company-specific). */
const NOMINAL_PAR = new Set([100, 500, 1000, 5000, 10_000]);

function isNominalPar(value: number): boolean {
  return NOMINAL_PAR.has(Math.round(Math.abs(value)));
}

function clearUnclassified(resolved: ResolvedFields): void {
  delete resolved.values.unclassified_equity;
  delete resolved.confidence.unclassified_equity;
  delete resolved.sources.unclassified_equity;
}

/**
 * When Sched L col-D RE sits in unclassified and every stock seat is blank, a BS gap that is
 * exactly an IRS nominal-par amount is the missing capital-stock roll (integrator books RE+par
 * in the equity seat). Evidence = BS identity + par vocabulary — not a company size floor.
 */
function rollMissingNominalParFromBalanceSheet(resolved: ResolvedFields): void {
  const uni = resolved.values.unclassified_equity;
  if (uni === undefined || uni <= 0) return;
  if (!isScheduleLRetainedSource(resolved.sources.unclassified_equity)) return;
  if ((resolved.values.common_stock ?? 0) !== 0) return;
  if ((resolved.values.preferred_stock ?? 0) !== 0) return;
  if ((resolved.values.other_stock_equity ?? 0) !== 0) return;
  if ((resolved.values.additional_paid_in_capital ?? 0) !== 0) return;

  const computed = computeWorkbookFormulas(resolved.values);
  if (computed.total_assets === undefined || computed.total_liabilities_equity === undefined) return;
  const gap = Math.round(computed.total_assets - computed.total_liabilities_equity);
  if (gap <= 0 || !isNominalPar(gap)) return;

  resolved.values.unclassified_equity = Math.round(uni + gap);
  resolved.confidence.unclassified_equity = Math.max(resolved.confidence.unclassified_equity ?? 90, 92);
  resolved.sources.unclassified_equity =
    (resolved.sources.unclassified_equity ?? "Schedule L equity") +
    " + nominal capital stock (BS identity)";
}

/** Route Schedule L equity into workbook buckets (common / other_stock / unclassified). */
export function normalizeEquityBuckets(resolved: ResolvedFields): void {
  const uni = resolved.values.unclassified_equity;
  const ose = resolved.values.other_stock_equity;
  const apic = resolved.values.additional_paid_in_capital;
  const cs = resolved.values.common_stock;
  const uniSrc = resolved.sources.unclassified_equity ?? "";
  const oseSrc = resolved.sources.other_stock_equity ?? "";
  const uniConf = resolved.confidence.unclassified_equity ?? 0;
  const oseConf = resolved.confidence.other_stock_equity ?? 0;
  const hasNominalCommon = cs !== undefined && isNominalPar(cs);
  const csRound = cs !== undefined ? Math.round(cs) : undefined;

  // Authoritative other-stock + weak/line-24 unclassified bleed — source structure wins (no $ floors).
  if (
    uni !== undefined &&
    ose !== undefined &&
    ose > 0 &&
    (isPairedColumnEmbeddedOseSource(oseSrc) || (oseConf >= uniConf && oseConf >= 90)) &&
    (isWeakEquityBleedSource(uniSrc, uniConf) ||
      (isPairedColumnEmbeddedOseSource(oseSrc) && /schedule\s+l.*line\s*24/i.test(uniSrc)))
  ) {
    clearUnclassified(resolved);
    return;
  }

  if (uni !== undefined && uni > 0 && isScheduleLRetainedSource(uniSrc)) {
    // $100 capital stock often rolled into unclassified equity (RE + capital).
    if (csRound === 100 && (ose === undefined || ose === 0)) {
      resolved.values.unclassified_equity = Math.round(uni + csRound);
      resolved.confidence.unclassified_equity = Math.max(
        resolved.confidence.unclassified_equity ?? 90,
        resolved.confidence.common_stock ?? 90,
      );
      resolved.sources.unclassified_equity =
        (resolved.sources.unclassified_equity ?? "Schedule L equity") + " + capital stock";
      delete resolved.values.common_stock;
      delete resolved.confidence.common_stock;
      delete resolved.sources.common_stock;
      return;
    }
    // Integrator convention: nominal-par common → Other Stock/Equity.
    if (hasNominalCommon && (ose === undefined || ose === 0)) {
      resolved.values.other_stock_equity = uni;
      resolved.confidence.other_stock_equity = resolved.confidence.unclassified_equity ?? 90;
      resolved.sources.other_stock_equity =
        (resolved.sources.unclassified_equity ?? "Schedule L equity") + " (routed to other stock)";
      clearUnclassified(resolved);
      return;
    }
    // Duplicate other_stock that mirrors retained unclassified — drop the weaker ose copy.
    if (
      ose !== undefined &&
      !isPairedColumnEmbeddedOseSource(oseSrc) &&
      (dollarsEqual(ose, uni) || /routed to other stock/i.test(oseSrc))
    ) {
      delete resolved.values.other_stock_equity;
      delete resolved.confidence.other_stock_equity;
      delete resolved.sources.other_stock_equity;
    }
    rollMissingNominalParFromBalanceSheet(resolved);
    return;
  }

  // Paired-column ose already present — drop weak/non-retained unclassified bleed only.
  if (
    uni !== undefined &&
    ose !== undefined &&
    isPairedColumnEmbeddedOseSource(oseSrc) &&
    !isScheduleLRetainedSource(uniSrc) &&
    isWeakEquityBleedSource(uniSrc, uniConf)
  ) {
    clearUnclassified(resolved);
    return;
  }

  // Corporate with APIC + common stock but equity landed in unclassified — route to other_stock.
  if (
    uni !== undefined &&
    uni > 0 &&
    (ose === undefined || ose === 0) &&
    apic !== undefined &&
    apic >= 1 &&
    cs !== undefined &&
    cs >= 1 &&
    !isScheduleLRetainedSource(uniSrc)
  ) {
    resolved.values.other_stock_equity = uni;
    resolved.confidence.other_stock_equity = resolved.confidence.unclassified_equity ?? 90;
    resolved.sources.other_stock_equity =
      resolved.sources.unclassified_equity ?? "Schedule L equity (routed to other stock)";
    clearUnclassified(resolved);
    return;
  }

  // Nominal-par common: integrator puts RE in Other Stock/Equity.
  if (uni !== undefined && uni > 0 && (ose === undefined || ose === 0) && hasNominalCommon) {
    resolved.values.other_stock_equity = uni;
    resolved.confidence.other_stock_equity = resolved.confidence.unclassified_equity ?? 90;
    resolved.sources.other_stock_equity =
      (resolved.sources.unclassified_equity ?? "Schedule L equity") + " (routed to other stock)";
    clearUnclassified(resolved);
    return;
  }

  rollMissingNominalParFromBalanceSheet(resolved);
}
