import type { TaxYearValues } from "@/lib/tax-workbook";
import type { SourceTag } from "@/lib/valuation/types";
import { buildIncomeStatementNarrativeFields } from "@/lib/valuation/financial-narrative-merge";
import {
  diskCacheKey,
  diskCacheOnly,
  readDiskCache,
  writeDiskCache,
} from "@/lib/valuation/valuation-disk-cache";

/** Groq free-tier default (replaces deprecated llama-3.3-70b-versatile). Override via GROQ_MODEL. */
export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";

/**
 * Smaller model when rate-limited or primary fails after 429.
 * llama-3.1-8b-instant is deprecated 2026-08-16 — use gpt-oss-20b instead.
 * Override via GROQ_FALLBACK_MODEL.
 */
export const DEFAULT_GROQ_FALLBACK_MODEL = "openai/gpt-oss-20b";

/** Cap JSON narrative output — keeps free-tier TPD usage low (~1 report ≈ 2–4K tokens total). */
const DEFAULT_MAX_COMPLETION_TOKENS = 1800;

export type BatchedNarrativeDraft = {
  company_description: string;
  economic_implications: string[];
  financial_observations: string[];
  assignment_summary: string;
  conclusion: string;
  ideal_rate_language?: string;
};

export type BatchedNarrativeInput = {
  entityName: string;
  purpose: string;
  engagingParty: string;
  naics?: string;
  naicsTitle?: string;
  msaLabel?: string;
  companyContext?: string;
  normalizationBullets?: string[];
  sbaMarketBullets?: string[];
  valuationDate: string;
  issuanceDate: string;
  taxYears: number[];
  reconciledValue: string;
  capitalizationRate: string;
  normalizedEarnings: string;
  tangibleAssetValue: string;
  intangibleValue: string;
  implicationBullets: string[];
  financialBullets: string[];
  sources: SourceTag[];
  columns: TaxYearValues[];
};

type ChatMessage = { role: "system" | "user"; content: string };

type ProviderConfig = {
  name: string;
  url: string;
  apiKey: string;
  model: string;
  supportsJson: boolean;
  maxCompletionTokens: number;
};

type ProviderCallResult =
  | { ok: true; draft: BatchedNarrativeDraft }
  | { ok: false; rateLimited: boolean };

function trimForPrompt(text: string | undefined, maxChars = 3500): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}…`;
}

function groqFallbackModel(): string {
  return process.env.GROQ_FALLBACK_MODEL?.trim() || DEFAULT_GROQ_FALLBACK_MODEL;
}

function groqMaxCompletionTokens(): number {
  const raw = Number(process.env.GROQ_MAX_COMPLETION_TOKENS ?? DEFAULT_MAX_COMPLETION_TOKENS);
  return Number.isFinite(raw) && raw > 256 ? Math.min(raw, 4096) : DEFAULT_MAX_COMPLETION_TOKENS;
}

function money(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(
    value,
  );
}

function ruleBasedDraft(input: BatchedNarrativeInput): BatchedNarrativeDraft {
  const isNarrative = buildIncomeStatementNarrativeFields(input.columns, input.naics);
  return {
    company_description: `${input.entityName} operates in ${(input.naicsTitle ?? "its industry").toLowerCase()} based on uploaded tax returns and NAICS ${input.naics ?? "classification"}. ${input.companyContext?.trim() ?? "Management, ownership, and competitive positioning should be confirmed by the analyst."}`,
    economic_implications: [...input.sbaMarketBullets ?? [], ...input.implicationBullets].filter(Boolean),
    financial_observations: [
      ...(input.normalizationBullets ?? []).map((b) => `Normalization: ${b}`),
      ...input.financialBullets.filter(Boolean),
      isNarrative.IS_Rev,
      isNarrative.IS_COGS,
      isNarrative.IS_Earnings_Generation,
    ].filter(Boolean),
    assignment_summary: `${input.entityName} is being reviewed for ${input.purpose}. Engaging party: ${input.engagingParty}. Valuation date: ${input.valuationDate}.`,
    conclusion: `Based on the analysis described in this report, the value of ${input.entityName} is ${input.reconciledValue} as of the valuation date, consisting of ${input.tangibleAssetValue} in tangible operating assets and ${input.intangibleValue} in intangible assets.`,
    ideal_rate_language: `The indicated capitalization rate is ${input.capitalizationRate} based on the build-up method applied to normalized earnings of ${input.normalizedEarnings}.`,
  };
}

function buildPrompt(input: BatchedNarrativeInput): { system: string; user: string } {
  const isNarrative = buildIncomeStatementNarrativeFields(input.columns, input.naics);
  const facts = [
    `Entity: ${input.entityName}`,
    `Purpose: ${input.purpose}`,
    `Engaging party: ${input.engagingParty}`,
    `Valuation date: ${input.valuationDate}`,
    `Issuance date: ${input.issuanceDate}`,
    `NAICS: ${input.naics ?? "n/a"} — ${input.naicsTitle ?? "n/a"}`,
    `MSA: ${input.msaLabel ?? "n/a"}`,
    `Tax years: ${input.taxYears.join(", ")}`,
    `Reconciled value: ${input.reconciledValue}`,
    `Normalized earnings: ${input.normalizedEarnings}`,
    `Capitalization rate: ${input.capitalizationRate}`,
    `Tangible assets: ${input.tangibleAssetValue}`,
    `Intangible residual: ${input.intangibleValue}`,
    input.companyContext?.trim() ? `Analyst / company context: ${trimForPrompt(input.companyContext)}` : undefined,
    ...(input.normalizationBullets ?? []).map((bullet) => `Normalization input: ${bullet}`),
    ...(input.sbaMarketBullets ?? []).map((bullet) => `SBA market comp: ${bullet}`),
    ...input.implicationBullets.map((bullet) => `Macro/industry fact: ${bullet}`),
    ...input.financialBullets.map((bullet) => `Financial fact: ${bullet}`),
    `Income statement narrative (rule-based, use for accuracy): ${isNarrative.IS_Rev}`,
    `COGS narrative: ${isNarrative.IS_COGS}`,
    `Wages narrative: ${isNarrative.IS_GA_Wages}`,
    `Earnings vs benchmarks: ${isNarrative.IS_Earnings_Generation}`,
  ]
    .filter(Boolean)
    .join("\n");

  const system = `You draft sections of a business valuation report. Use ONLY supplied facts and figures. Do not invent customers, ownership, contracts, or numbers.
Return valid JSON with exactly these keys:
- company_description (string, 1-2 paragraphs)
- economic_implications (array of 3-5 concise bullet strings)
- financial_observations (array of 4-8 concise bullet strings; incorporate supplied income-statement narratives)
- assignment_summary (string, 1 short paragraph on purpose and scope ONLY — do not mention asset sale or transaction presentation)
- conclusion (string, 1 short paragraph referencing reconciled value and tangible/intangible split — do not repeat asset sale language)
- ideal_rate_language (string, one sentence on cap rate and normalized earnings)`;

  const user = `Facts:\n${facts}\n\nSources:\n${input.sources
    .map((source) => `- ${source.label}${source.detail ? ` (${source.detail})` : ""}`)
    .join("\n")}`;

  return { system, user };
}

function resolveGroqAttempts(): Array<ProviderConfig & { onlyAfterRateLimit?: boolean }> {
  const primaryKey = process.env.GROQ_API_KEY?.trim();
  const fallbackKey = process.env.GROQ_API_KEY_FALLBACK?.trim();
  const primaryModel = process.env.GROQ_MODEL?.trim() || DEFAULT_GROQ_MODEL;
  const liteModel = groqFallbackModel();
  const maxCompletionTokens = groqMaxCompletionTokens();
  const url = "https://api.groq.com/openai/v1/chat/completions";

  const attempts: Array<ProviderConfig & { onlyAfterRateLimit?: boolean }> = [];
  if (primaryKey) {
    attempts.push({
      name: "groq-primary",
      url,
      apiKey: primaryKey,
      model: primaryModel,
      supportsJson: true,
      maxCompletionTokens,
    });
  }
  if (fallbackKey && fallbackKey !== primaryKey) {
    attempts.push({
      name: "groq-fallback-key",
      url,
      apiKey: fallbackKey,
      model: primaryModel,
      supportsJson: true,
      maxCompletionTokens,
      onlyAfterRateLimit: true,
    });
  }
  if (liteModel !== primaryModel) {
    if (primaryKey) {
      attempts.push({
        name: "groq-lite",
        url,
        apiKey: primaryKey,
        model: liteModel,
        supportsJson: true,
        maxCompletionTokens,
        onlyAfterRateLimit: true,
      });
    }
    if (fallbackKey && fallbackKey !== primaryKey) {
      attempts.push({
        name: "groq-fallback-key-lite",
        url,
        apiKey: fallbackKey,
        model: liteModel,
        supportsJson: true,
        maxCompletionTokens,
        onlyAfterRateLimit: true,
      });
    }
  }
  return attempts;
}

function resolveProviders(): ProviderConfig[] {
  const providers: ProviderConfig[] = [...resolveGroqAttempts()];
  // Paid optional — omit OPENAI_API_KEY for a fully free stack (Groq + rule-based only).
  const openaiKey = process.env.OPENAI_API_KEY?.trim();
  if (openaiKey) {
    providers.push({
      name: "openai-paid",
      url: "https://api.openai.com/v1/chat/completions",
      apiKey: openaiKey,
      model: process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
      supportsJson: true,
      maxCompletionTokens: groqMaxCompletionTokens(),
    });
  }
  return providers;
}

function parseJsonDraft(content: string): BatchedNarrativeDraft | null {
  const trimmed = content.trim();
  const jsonText = trimmed.startsWith("{")
    ? trimmed
    : trimmed.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText) as Partial<BatchedNarrativeDraft>;
    if (!parsed.company_description || !parsed.conclusion) return null;
    return {
      company_description: String(parsed.company_description).trim(),
      economic_implications: Array.isArray(parsed.economic_implications)
        ? parsed.economic_implications.map(String).filter(Boolean)
        : [],
      financial_observations: Array.isArray(parsed.financial_observations)
        ? parsed.financial_observations.map(String).filter(Boolean)
        : [],
      assignment_summary: String(parsed.assignment_summary ?? "").trim(),
      conclusion: String(parsed.conclusion).trim(),
      ideal_rate_language: parsed.ideal_rate_language
        ? String(parsed.ideal_rate_language).trim()
        : undefined,
    };
  } catch {
    return null;
  }
}

async function callProvider(
  provider: ProviderConfig,
  messages: ChatMessage[],
): Promise<ProviderCallResult> {
  const cacheKey = diskCacheKey([provider.name, provider.model, JSON.stringify(messages)]);
  const cached = readDiskCache<ProviderCallResult>("groq", cacheKey);
  if (cached) return cached;
  if (diskCacheOnly()) {
    return { ok: false, rateLimited: false };
  }

  const body: Record<string, unknown> = {
    model: provider.model,
    temperature: 0.2,
    max_tokens: provider.maxCompletionTokens,
    messages,
  };
  if (provider.supportsJson) {
    body.response_format = { type: "json_object" };
  }

  const res = await fetch(provider.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (res.status === 429) {
    const miss: ProviderCallResult = { ok: false, rateLimited: true };
    return miss;
  }
  if (!res.ok) {
    const miss: ProviderCallResult = { ok: false, rateLimited: false };
    return miss;
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content?.trim();
  if (!content) {
    const miss: ProviderCallResult = { ok: false, rateLimited: false };
    return miss;
  }
  const draft = parseJsonDraft(content);
  if (!draft) {
    const miss: ProviderCallResult = { ok: false, rateLimited: false };
    return miss;
  }
  const hit: ProviderCallResult = { ok: true, draft };
  writeDiskCache("groq", cacheKey, hit);
  return hit;
}

/** One batched AI call for all prose sections; falls back through providers then rule-based text. */
export async function draftReportNarrativeBatched(
  input: BatchedNarrativeInput,
  options?: { useAi?: boolean },
): Promise<{ draft: BatchedNarrativeDraft; provider: string }> {
  const fallback = ruleBasedDraft(input);
  if (!options?.useAi) {
    return { draft: fallback, provider: "rule-based" };
  }

  const groqAttempts = resolveGroqAttempts();
  const openAiProviders = resolveProviders().filter((p) => p.name === "openai-paid");
  const attempts = [...groqAttempts, ...openAiProviders];

  if (!attempts.length) {
    return { draft: fallback, provider: "rule-based" };
  }

  const { system, user } = buildPrompt(input);
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  let hitRateLimit = false;
  for (const provider of attempts) {
    if (provider.onlyAfterRateLimit && !hitRateLimit) continue;
    const result = await callProvider(provider, messages);
    if (result.ok) {
      const draft = result.draft;
      return {
        draft: {
          ...fallback,
          ...draft,
          economic_implications: draft.economic_implications.length
            ? draft.economic_implications
            : fallback.economic_implications,
          financial_observations: draft.financial_observations.length
            ? draft.financial_observations
            : fallback.financial_observations,
        },
        provider: provider.name,
      };
    }
    if (result.rateLimited) hitRateLimit = true;
  }

  return { draft: fallback, provider: hitRateLimit ? "rule-based (rate-limited)" : "rule-based" };
}

/** Build financial fact bullets from parsed tax columns (no API). */
export function buildFinancialFactBullets(columns: TaxYearValues[]): string[] {
  const sorted = [...columns].sort((a, b) => a.year - b.year);
  if (!sorted.length) return [];
  const latest = sorted[sorted.length - 1]!;
  const raw = latest.workbookValues ?? latest.values;
  const first = sorted[0]!;
  const firstRaw = first.workbookValues ?? first.values;
  const bullets: string[] = [];
  if (raw.sales && firstRaw.sales) {
    bullets.push(
      `Sales moved from ${money(firstRaw.sales)} in ${first.year} to ${money(raw.sales)} in ${latest.year}.`,
    );
  }
  if (raw.net_profit_before_taxes) {
    bullets.push(
      `Latest-year net profit before taxes is ${money(raw.net_profit_before_taxes)} (${latest.year}).`,
    );
  }
  if (raw.total_assets) {
    bullets.push(`Latest-year total assets are ${money(raw.total_assets)}.`);
  }
  return bullets;
}
