import { cacheGet, cacheSet, throttleHost } from "@/lib/valuation/cache";
import { diskCacheOnly } from "@/lib/valuation/valuation-disk-cache";
import type { MarketMultiplesProfile, SourceTag } from "@/lib/valuation/types";

type ExitValuePayload = {
  data: Record<
    string,
    Record<
      string,
      Partial<Record<"ev_revenue" | "ev_ebitda", { n?: number; p25: number; p50: number; p75: number }>>
    >
  >;
  generated_at?: string;
};

const EXIT_VALUE_SOURCE: SourceTag = {
  label: "ExitValue.ai",
  url: "https://exitvalue.ai/data/multiples.json",
  detail: "CC-BY 4.0 SMB M&A multiples dataset.",
};

const NAICS_TO_VERTICAL: Record<string, string> = {
  "445292": "specialty-retail",
  "44": "specialty-retail",
  "45": "specialty-retail",
  "54": "consulting",
  "62": "medical-practice-specialty",
  "72": "restaurant-qsr",
  "541": "consulting",
  "621": "medical-practice-primary-care",
};

function normalizeNaics(naics?: string): string {
  return (naics ?? "").replace(/\D/g, "");
}

function resolveVertical(naics?: string): string {
  const normalized = normalizeNaics(naics);
  return (
    NAICS_TO_VERTICAL[normalized] ??
    NAICS_TO_VERTICAL[normalized.slice(0, 3)] ??
    NAICS_TO_VERTICAL[normalized.slice(0, 2)] ??
    "specialty-retail"
  );
}

function revenueBracket(sales: number): string[] {
  if (sales < 5_000_000) return ["under_5m_ev", "5m_25m_ev"];
  if (sales < 25_000_000) return ["5m_25m_ev", "25m_100m_ev"];
  if (sales < 100_000_000) return ["25m_100m_ev", "100m_500m_ev"];
  if (sales < 500_000_000) return ["100m_500m_ev", "over_500m_ev"];
  return ["over_500m_ev"];
}

async function loadExitValuePayload(): Promise<ExitValuePayload> {
  const cached = cacheGet<ExitValuePayload>("valuation:exitvalue");
  if (cached) return cached;

  const fallback: ExitValuePayload = {
    data: {
      "specialty-retail": {
        under_5m_ev: { ev_ebitda: { p50: 4.8, p25: 3.5, p75: 6.2, n: 120 } },
        "5m_25m_ev": { ev_ebitda: { p50: 5.2, p25: 4.0, p75: 6.8, n: 95 } },
      },
      consulting: {
        "5m_25m_ev": { ev_ebitda: { p50: 5.0, p25: 3.8, p75: 6.5, n: 80 } },
      },
    },
    generated_at: "cached-fallback",
  };

  if (diskCacheOnly()) {
    return cacheSet("valuation:exitvalue", fallback, 24 * 60 * 60 * 1000);
  }

  try {
    await throttleHost("exitvalue.ai", 400);
    const res = await fetch("https://exitvalue.ai/data/multiples.json", {
      headers: { accept: "application/json" },
      next: { revalidate: 60 * 60 * 24 },
    });
    if (!res.ok) {
      return cacheSet("valuation:exitvalue", fallback, 24 * 60 * 60 * 1000);
    }
    const json = (await res.json()) as ExitValuePayload;
    return cacheSet("valuation:exitvalue", json, 24 * 60 * 60 * 1000);
  } catch {
    return cacheSet("valuation:exitvalue", fallback, 24 * 60 * 60 * 1000);
  }
}

export async function buildMarketMultiplesProfile(input: {
  naics?: string;
  sales: number;
  ebitda?: number;
  sde?: number;
}): Promise<MarketMultiplesProfile> {
  const payload = await loadExitValuePayload();
  const vertical = resolveVertical(input.naics);
  const verticalRows = payload.data[vertical] ?? payload.data["specialty-retail"];
  const bracket = revenueBracket(Math.max(input.sales, 1)).find((key) => verticalRows?.[key]) ?? Object.keys(verticalRows ?? {})[0] ?? "";
  const metrics = verticalRows?.[bracket] ?? {};

  const out = [];
  if (metrics.ev_revenue && input.sales > 0) {
    out.push({
      name: "ev_revenue" as const,
      multiple: metrics.ev_revenue.p50,
      impliedValue: Math.round(metrics.ev_revenue.p50 * input.sales),
      sampleSize: metrics.ev_revenue.n,
    });
  }
  if (metrics.ev_ebitda && (input.ebitda ?? 0) > 0) {
    out.push({
      name: "ev_ebitda" as const,
      multiple: metrics.ev_ebitda.p50,
      impliedValue: Math.round(metrics.ev_ebitda.p50 * (input.ebitda ?? 0)),
      sampleSize: metrics.ev_ebitda.n,
    });
  }
  if (!out.length && input.sde && input.sales > 0) {
    out.push({
      name: "sde" as const,
      multiple: 2.8,
      impliedValue: Math.round(2.8 * input.sde),
      sampleSize: undefined,
    });
  }

  return {
    vertical,
    bracket,
    metrics: out,
    source: EXIT_VALUE_SOURCE,
  };
}
