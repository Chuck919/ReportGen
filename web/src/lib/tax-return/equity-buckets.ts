import type { ResolvedFields } from "./merge";

function isScheduleLRetainedSource(source: string | undefined): boolean {
  return /schedule\s+l/i.test(source ?? "") && /line\s*24|23\+25|retained|unappropriated|apic \+ retained/i.test(source ?? "");
}

function isArizonaEmbeddedOseSource(source: string | undefined): boolean {
  return /embedded schedule l \(arizona\)/i.test(source ?? "");
}

function isWeakEquityBleedSource(source: string | undefined, confidence?: number): boolean {
  if (/embedded schedule l/i.test(source ?? "")) return false;
  if (/user correction|user selected/i.test(source ?? "")) return false;
  if (/schedule\s+l.*line\s*24|unappropriated/i.test(source ?? "")) {
    return (confidence ?? 70) < 95;
  }
  return /ocr label|label match|fuzzy/i.test(source ?? "");
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

  // Strong equity bucket already populated — drop weak Schedule L line-24 bleed.
  if (
    uni !== undefined &&
    ose !== undefined &&
    ose > 0 &&
    Math.abs(uni) <= Math.max(500, ose * 0.02) &&
    (isArizonaEmbeddedOseSource(oseSrc) ||
      (oseConf >= uniConf && (oseConf >= 90 || isArizonaEmbeddedOseSource(oseSrc)))) &&
    (isWeakEquityBleedSource(uniSrc, uniConf) ||
      (isArizonaEmbeddedOseSource(oseSrc) && /schedule\s+l.*line\s*24/i.test(uniSrc)))
  ) {
    delete resolved.values.unclassified_equity;
    delete resolved.confidence.unclassified_equity;
    delete resolved.sources.unclassified_equity;
    return;
  }
  if (uni !== undefined && uni > 0 && isScheduleLRetainedSource(uniSrc)) {
    if (
      ose !== undefined &&
      !isArizonaEmbeddedOseSource(oseSrc) &&
      (Math.abs(ose - uni) <= Math.max(500, uni * 0.02) ||
        /routed to other stock/i.test(oseSrc))
    ) {
      delete resolved.values.other_stock_equity;
      delete resolved.confidence.other_stock_equity;
      delete resolved.sources.other_stock_equity;
    }
    return;
  }

  // Arizona-style: common + APIC + large equity line already in other_stock_equity — drop duplicate uni.
  if (
    uni !== undefined &&
    ose !== undefined &&
    ose > 400_000 &&
    isArizonaEmbeddedOseSource(oseSrc) &&
    Math.abs(uni) < 50_000
  ) {
    delete resolved.values.unclassified_equity;
    delete resolved.confidence.unclassified_equity;
    delete resolved.sources.unclassified_equity;
    return;
  }

  // Large C-corp with common stock + other_stock_equity — tiny Schedule L line-24 bleed is noise.
  if (
    uni !== undefined &&
    Math.abs(uni) < 50_000 &&
    ose !== undefined &&
    ose > 400_000 &&
    cs !== undefined &&
    cs >= 100_000 &&
    !isScheduleLRetainedSource(uniSrc)
  ) {
    delete resolved.values.unclassified_equity;
    delete resolved.confidence.unclassified_equity;
    delete resolved.sources.unclassified_equity;
    return;
  }

  if (
    uni !== undefined &&
    uni > 0 &&
    ose !== undefined &&
    ose > 400_000 &&
    uni < 100_000
  ) {
    delete resolved.values.unclassified_equity;
    delete resolved.confidence.unclassified_equity;
    delete resolved.sources.unclassified_equity;
  }

  if (
    cs !== undefined &&
    cs > 0 &&
    cs < 10_000 &&
    (resolved.values.other_stock_equity ?? 0) > 50_000 &&
    (resolved.values.unclassified_equity ?? 0) === 0
  ) {
    return;
  }

  // Corporate with APIC + common stock but equity landed in unclassified — route to other_stock_equity.
  if (
    uni !== undefined &&
    uni > 50_000 &&
    (ose === undefined || ose === 0) &&
    apic !== undefined &&
    apic >= 100 &&
    cs !== undefined &&
    cs >= 1_000 &&
    !isScheduleLRetainedSource(uniSrc)
  ) {
    resolved.values.other_stock_equity = uni;
    resolved.confidence.other_stock_equity = resolved.confidence.unclassified_equity ?? 90;
    resolved.sources.other_stock_equity =
      resolved.sources.unclassified_equity ?? "Schedule L equity (routed to other stock)";
    delete resolved.values.unclassified_equity;
    delete resolved.confidence.unclassified_equity;
    delete resolved.sources.unclassified_equity;
  }
}
