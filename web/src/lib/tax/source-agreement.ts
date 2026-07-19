/** Independent extraction families for multi-source agreement checks. */
import { isWeakSource } from "@/lib/tax-return/confidence-gates";

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

export function valuesExactlyEqual(a: number, b: number): boolean {
  return Math.round(a) === Math.round(b);
}

export function classifySourceFamily(source?: string): SourceFamily {
  const s = source ?? "";
  if (/structured financial/i.test(s)) return "structured";
  if (/form 1120|page 1 block|NET\s+DEPRECIATION|depreciation report/i.test(s)) return "form";
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

/** Families treated as independent cross-check evidence (excludes OCR noise). */
const CROSS_CHECK_FAMILIES = new Set<SourceFamily>([
  "form",
  "schedule-l",
  "comparison",
  "structured",
]);

function credibleCrossCheckSnapshots(snapshots: SourceSnapshot[]): SourceSnapshot[] {
  // Family provenance makes a read an independent cross-check. Parser confidence
  // is metadata, not a threshold that can hide an exact-dollar disagreement.
  return snapshots.filter((s) => CROSS_CHECK_FAMILIES.has(s.family));
}

/**
 * Material cross-family disagreement: a credible independent source disagrees by
 * at least one rounded dollar and fewer than two families corroborate the chosen value.
 * OCR reads and uncorroborated statement-only alternates are ignored.
 */
export function hasMaterialDisagreement(chosen: number, snapshots: SourceSnapshot[]): boolean {
  const crossCheck = credibleCrossCheckSnapshots(snapshots);
  if (crossCheck.length < 2) return false;
  if (countAgreeingFamilies(chosen, crossCheck) >= 2) return false;
  return crossCheck.some((s) => !valuesExactlyEqual(s.value, chosen));
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

    const parserVal = values[id];
    const parserSrc = fieldSources[id];
    // Dep/amort: keep parser cross-reference (NET DEPRECIATION / Form 4562) over blank Form 0 snapshots.
    if (
      (id === "depreciation" || id === "amortization") &&
      parserVal !== undefined &&
      Math.round(parserVal) > 0 &&
      (/NET\s+DEPRECIATION|depreciation report|Form 4562|Statement amortization/i.test(parserSrc ?? "") ||
        (!/blank/i.test(parserSrc ?? "") && !isWeakSource(parserSrc)))
    ) {
      const alternates = getAlternateReads(snaps, parserVal);
      if (alternates.length) fieldAlternates[id] = alternates;
      continue;
    }

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
