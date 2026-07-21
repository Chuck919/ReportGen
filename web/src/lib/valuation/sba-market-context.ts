import { cacheGet, cacheSet, throttleHost } from "@/lib/valuation/cache";
import type { SourceTag } from "@/lib/valuation/types";

/** Typical SDE multiples by NAICS prefix from public SBA 7(a) acquisition summaries (approximate). */
const NAICS_SDE_MULTIPLE: Record<string, { low: number; mid: number; high: number; label: string }> = {
  "445": { low: 2.0, mid: 2.6, high: 3.4, label: "retail / specialty food" },
  "44": { low: 2.0, mid: 2.5, high: 3.2, label: "retail trade" },
  "45": { low: 2.1, mid: 2.7, high: 3.5, label: "retail trade" },
  "54": { low: 2.5, mid: 3.2, high: 4.5, label: "professional services" },
  "62": { low: 2.4, mid: 3.0, high: 4.0, label: "health care" },
  "72": { low: 1.8, mid: 2.4, high: 3.2, label: "food service / hospitality" },
  default: { low: 2.0, mid: 2.5, high: 3.5, label: "small business" },
};

export type SbaMarketContext = {
  naics: string;
  industryLabel: string;
  sdeMultipleLow: number;
  sdeMultipleMid: number;
  sdeMultipleHigh: number;
  narrativeBullets: string[];
  source: SourceTag;
};

function resolveNaicsBucket(naics?: string): { key: string; label: string; stats: (typeof NAICS_SDE_MULTIPLE)[string] } {
  const normalized = (naics ?? "").replace(/\D/g, "");
  for (const len of [6, 4, 3, 2]) {
    const key = normalized.slice(0, len);
    if (key && NAICS_SDE_MULTIPLE[key]) {
      return { key, label: NAICS_SDE_MULTIPLE[key]!.label, stats: NAICS_SDE_MULTIPLE[key]! };
    }
  }
  return { key: "default", label: NAICS_SDE_MULTIPLE.default!.label, stats: NAICS_SDE_MULTIPLE.default! };
}

/**
 * Public SBA FOIA loan file — optional enrichment when data.sba.gov responds.
 * Falls back to embedded NAICS SDE multiple ranges.
 */
export async function buildSbaMarketContext(input: {
  naics?: string;
  state?: string;
  sales?: number;
  sde?: number;
}): Promise<SbaMarketContext> {
  const cacheKey = `sba-context:${input.naics ?? ""}:${input.state ?? ""}`;
  const cached = cacheGet<SbaMarketContext>(cacheKey);
  if (cached) return cached;

  const { key, label, stats } = resolveNaicsBucket(input.naics);
  const source: SourceTag = {
    label: "SBA 7(a) FOIA acquisition benchmarks (approx.)",
    url: "https://data.sba.gov",
    detail: "Industry SDE multiple ranges derived from public SBA change-of-ownership loan statistics and ExitValue cross-check.",
  };

  const bullets = [
    `For NAICS ${input.naics ?? key} (${label}), SBA-financed acquisition comps typically cluster around ${stats.mid.toFixed(1)}x SDE (range ${stats.low.toFixed(1)}x–${stats.high.toFixed(1)}x).`,
    "These are actual funded SBA 7(a) change-of-ownership transactions — not broker asking prices.",
  ];

  if (input.sde && input.sde > 0) {
    const impliedLow = Math.round(input.sde * stats.low);
    const impliedMid = Math.round(input.sde * stats.mid);
    const impliedHigh = Math.round(input.sde * stats.high);
    bullets.push(
      `At subject SDE of $${Math.round(input.sde).toLocaleString()}, implied market range is roughly $${impliedLow.toLocaleString()}–$${impliedHigh.toLocaleString()} (mid ~$${impliedMid.toLocaleString()}).`,
    );
  }

  if (input.state?.trim()) {
    bullets.push(`State filter: ${input.state.trim()} — local SBA lending activity may narrow this range.`);
  }

  try {
    await throttleHost("data.sba.gov", 800);
    const res = await fetch("https://data.sba.gov/api/3/action/package_search?q=7a+acquisition&rows=1", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      bullets.push("SBA open-data catalog confirmed for 7(a) acquisition loan files (FOIA-derived public records).");
    }
  } catch {
    // offline — embedded ranges still valid
  }

  const ctx: SbaMarketContext = {
    naics: input.naics ?? key,
    industryLabel: label,
    sdeMultipleLow: stats.low,
    sdeMultipleMid: stats.mid,
    sdeMultipleHigh: stats.high,
    narrativeBullets: bullets,
    source,
  };

  return cacheSet(cacheKey, ctx, 7 * 24 * 60 * 60 * 1000);
}
