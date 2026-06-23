/** Independent extraction families for multi-source agreement checks. */
export type SourceFamily = "form" | "schedule-l" | "comparison" | "statement" | "ocr" | "structured" | "other";

export type SourceSnapshot = {
  family: SourceFamily;
  value: number;
  confidence: number;
  sourceLabel?: string;
};

const FAMILY_PRIORITY: SourceFamily[] = [
  "form",
  "schedule-l",
  "comparison",
  "statement",
  "structured",
  "ocr",
  "other",
];

/** Loose tolerance for balance-sheet totals and YoY — not for source agreement. */
export function withinTolerance(a: number, b: number, pct = 0.02): boolean {
  const diff = Math.abs(a - b);
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return diff <= Math.max(1000, scale * pct);
}

export function valuesExactlyEqual(a: number, b: number): boolean {
  return Math.round(a) === Math.round(b);
}

export function classifySourceFamily(source?: string): SourceFamily {
  const s = source ?? "";
  if (/structured financial/i.test(s)) return "structured";
  if (/form 1120|page 1 block/i.test(s)) return "form";
  if (/schedule l|embedded schedule/i.test(s)) return "schedule-l";
  if (/comparison/i.test(s)) return "comparison";
  if (/statement|stmt \d/i.test(s)) return "statement";
  if (/OCR label|fuzzy|label match/i.test(s)) return "ocr";
  return "other";
}

export function buildSourceSnapshots(
  tiers: Array<{
    family: SourceFamily;
    values: Record<string, number>;
    confidence?: Record<string, number>;
    sources?: Record<string, string>;
  }>,
): Record<string, SourceSnapshot[]> {
  const out: Record<string, SourceSnapshot[]> = {};
  for (const tier of tiers) {
    for (const [id, value] of Object.entries(tier.values)) {
      if (value === undefined) continue;
      const rounded = Math.round(value);
      const snap: SourceSnapshot = {
        family: tier.family,
        value: rounded,
        confidence: tier.confidence?.[id] ?? 70,
        sourceLabel: tier.sources?.[id],
      };
      const list = out[id] ?? [];
      if (
        !list.some(
          (s) => s.family === tier.family && valuesExactlyEqual(s.value, rounded),
        )
      ) {
        list.push(snap);
      }
      out[id] = list;
    }
  }
  return out;
}

/** Count distinct families whose value matches `final` exactly. */
export function countAgreeingFamilies(final: number, snapshots: SourceSnapshot[]): number {
  const families = new Set<SourceFamily>();
  const rounded = Math.round(final);
  for (const snap of snapshots) {
    if (valuesExactlyEqual(snap.value, rounded)) families.add(snap.family);
  }
  return families.size;
}

/** Any independent read differs — even by one digit. */
export function hasSourceDisagreement(snapshots: SourceSnapshot[]): boolean {
  if (snapshots.length < 2) return false;
  const values = snapshots.map((s) => Math.round(s.value));
  return new Set(values).size > 1;
}

export function pickBestSnapshot(snapshots: SourceSnapshot[]): SourceSnapshot {
  const byValue = new Map<number, SourceSnapshot[]>();
  for (const snap of snapshots) {
    const rounded = Math.round(snap.value);
    const list = byValue.get(rounded) ?? [];
    list.push(snap);
    byValue.set(rounded, list);
  }

  let bestGroup: SourceSnapshot[] = [];
  for (const group of byValue.values()) {
    const families = new Set(group.map((s) => s.family));
    const bestFamilies = new Set(bestGroup.map((s) => s.family));
    if (
      group.length > bestGroup.length ||
      (group.length === bestGroup.length && families.size > bestFamilies.size)
    ) {
      bestGroup = group;
    }
  }

  if (bestGroup.length >= 2) {
    return [...bestGroup].sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return FAMILY_PRIORITY.indexOf(a.family) - FAMILY_PRIORITY.indexOf(b.family);
    })[0]!;
  }

  return [...snapshots].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return FAMILY_PRIORITY.indexOf(a.family) - FAMILY_PRIORITY.indexOf(b.family);
  })[0]!;
}

export function getAlternateReads(
  snapshots: SourceSnapshot[],
  chosen: number,
): SourceSnapshot[] {
  return snapshots.filter((s) => !valuesExactlyEqual(s.value, chosen));
}

export function sourceDisagreementDetail(
  snapshots: SourceSnapshot[],
  chosen: number,
): string | undefined {
  const alternates = getAlternateReads(snapshots, chosen);
  if (!alternates.length) return undefined;
  const parts = alternates.map((s) => {
    const label = s.sourceLabel ? `${s.family} (${s.sourceLabel})` : s.family;
    return `${label}: ${s.value.toLocaleString()}`;
  });
  return `Other reads: ${parts.join(" · ")}`;
}

export function resolveValuesFromSnapshots(
  values: Record<string, number>,
  confidence: Record<string, number>,
  fieldSources: Record<string, string>,
  snapshots: Record<string, SourceSnapshot[]>,
): {
  values: Record<string, number>;
  confidence: Record<string, number>;
  fieldSources: Record<string, string>;
  fieldAlternates: Record<string, SourceSnapshot[]>;
} {
  const outValues = { ...values };
  const outConf = { ...confidence };
  const outSources = { ...fieldSources };
  const fieldAlternates: Record<string, SourceSnapshot[]> = {};

  for (const [id, snaps] of Object.entries(snapshots)) {
    if (!hasSourceDisagreement(snaps)) continue;

    const best = pickBestSnapshot(snaps);
    outValues[id] = best.value;
    outConf[id] = best.confidence;
    if (best.sourceLabel) outSources[id] = best.sourceLabel;

    const alternates = getAlternateReads(snaps, best.value);
    if (alternates.length) fieldAlternates[id] = alternates;
  }

  return {
    values: outValues,
    confidence: outConf,
    fieldSources: outSources,
    fieldAlternates,
  };
}

/** @deprecated Use hasSourceDisagreement */
export function hasTightSourceDisagreement(snapshots: SourceSnapshot[]): boolean {
  return hasSourceDisagreement(snapshots);
}

/** @deprecated Use sourceDisagreementDetail */
export function tightDisagreementDetail(snapshots: SourceSnapshot[]): string | undefined {
  if (!hasSourceDisagreement(snapshots)) return undefined;
  const best = pickBestSnapshot(snapshots);
  return sourceDisagreementDetail(snapshots, best.value);
}
