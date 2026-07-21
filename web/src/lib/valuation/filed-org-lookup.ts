import { cacheGet, cacheSet, throttleHost } from "@/lib/valuation/cache";

export type OrgLookupResult = {
  entityName: string;
  state: string;
  fileNumber: string;
  formationDate: string;
  status: string;
  source: string;
};

/** Optional Filed.dev SOS lookup (free tier ~100/mo). Set FILED_API_KEY in .env.local */
export async function lookupOrgEntity(input: {
  entityName: string;
  state: string;
}): Promise<OrgLookupResult | null> {
  const apiKey = process.env.FILED_API_KEY?.trim();
  const name = input.entityName.trim();
  const state = input.state.trim().toUpperCase();
  if (!apiKey || !name || state.length !== 2) return null;

  const cacheKey = `filed:${state}:${name.toLowerCase()}`;
  const cached = cacheGet<OrgLookupResult | null>(cacheKey);
  if (cached !== undefined) return cached;

  try {
    await throttleHost("filed.dev", 500);
    const url = `https://filed.dev/api/v1/search?state=${encodeURIComponent(state)}&q=${encodeURIComponent(name)}`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      cacheSet(cacheKey, null, 60 * 60 * 1000);
      return null;
    }
    const json = (await res.json()) as {
      results?: Array<{
        name?: string;
        file_number?: string;
        status?: string;
        formation_date?: string;
        incorporation_date?: string;
      }>;
    };
    const hit = json.results?.[0];
    if (!hit) {
      cacheSet(cacheKey, null, 60 * 60 * 1000);
      return null;
    }
    const result: OrgLookupResult = {
      entityName: hit.name ?? name,
      state,
      fileNumber: hit.file_number ?? "",
      formationDate: hit.formation_date ?? hit.incorporation_date ?? "",
      status: hit.status ?? "Active",
      source: "Filed.dev SOS lookup",
    };
    return cacheSet(cacheKey, result, 7 * 24 * 60 * 60 * 1000);
  } catch {
    cacheSet(cacheKey, null, 30 * 60 * 1000);
    return null;
  }
}
