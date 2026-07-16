import { TAX_WORKBOOK_ROWS } from "@/lib/tax-workbook";
import {
  pickComparisonColumnIndex,
  shrinkToYearColumns,
  stripEinNoise,
} from "@/lib/two-year-comparison-parser";
import {
  isEinOrPaymentInstructionBleed,
  lineMatchesLabelPattern,
  repairOcrLabel,
  stripOcrLinePrefix,
} from "./ocr-label-repair";
import {
  isFormReferenceNumber,
  isHistoricalGrossReceiptsLine,
  leadingScheduleLineNumber,
  parseMoney,
  substantialMoneyTokens,
} from "./money";

const INPUT_ROWS = TAX_WORKBOOK_ROWS.filter((row) => row.excelBehavior === "input");
const INPUT_ROW_IDS = new Set(INPUT_ROWS.map((row) => row.id));

export type ParseHit = {
  id: string;
  value: number;
  confidence: number;
  evidence: string;
};

const LABEL_ALIASES: Record<string, string> = {
  "sales (income)": "sales",
  "gross receipts or sales": "sales",
  "gross receipts": "sales",
  "cost of goods sold": "cogs",
  depreciation: "depreciation",
  amortization: "amortization",
  "officer compensation": "officer_compensation",
  "compensation of officers": "officer_compensation",
  "salaries and wages": "salaries_wages",
  "wages and salaries": "salaries_wages",
  "general and administrative wages and salaries": "salaries_wages",
  advertising: "advertising",
  rent: "rent",
  "taxes and licenses": "taxes_licenses",
  "bank and credit card": "bank_credit_card",
  "professional fees": "professional_fees",
  utilities: "utilities",
  "other operating expenses": "other_operating_expenses",
  "other operating income": "other_operating_income",
  "interest expense": "interest_expense",
  "other income": "other_income",
  cash: "cash",
  "accounts receivable": "accounts_receivable",
  inventory: "inventory",
  "other current assets": "other_current_assets",
  "gross fixed assets": "gross_fixed_assets",
  "accumulated depreciation": "accumulated_depreciation",
  "gross intangible assets": "gross_intangible_assets",
  "accumulated amortization": "accumulated_amortization",
  "other assets": "other_assets",
  "accounts payable": "accounts_payable",
  "other current liabilities": "other_current_liabilities",
  "notes minus short-term": "notes_minus_short_term",
  "retained earnings": "unclassified_equity",
  "unclassified equity": "unclassified_equity",
};

const LABEL_PATTERNS = Object.entries(LABEL_ALIASES).map(([label, id]) => {
  const body = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return { id, pattern: new RegExp(`(^|[^a-z0-9])${body}([^a-z0-9]|$)`, "i") };
});

function isIbisNoise(line: string): boolean {
  const t = line.toLowerCase();
  return /ibisworld|common size|% of sales|% of total assets|naics code/i.test(t);
}

function rejectValueForField(id: string, line: string, value: number, targetYear?: number | null): boolean {
  if (isFormReferenceNumber(Math.abs(value))) return true;
  if (targetYear && Math.abs(value) === targetYear) return true;
  if (targetYear && Math.abs(value) === targetYear % 100) return true;
  if (id === "bank_credit_card" && /payable/i.test(line)) return true;
  if (id === "officer_compensation" && /taxes?\s+and\s+(lic|license)/i.test(line)) return true;
  if (id === "taxes_paid" && /taxes?\s+and\s+(lic|license)/i.test(line)) return true;
  const lead = leadingScheduleLineNumber(line);
  if (id === "cogs" && /gross profit|\[3\b|\b3\b.*gross/i.test(line)) return true;
  if (id === "depreciation" && (/accumulated|less\s+acc|post-1986|adjustment|form\s*4562/i.test(line) || value < 0)) return true;
  if (id === "depreciation" && Math.abs(value) <= 99 && !substantialMoneyTokens(line).length) return true;
  if (id === "amortization" && /accumulated|less\s+acc|schedule\s*l|gross\s+intangible/i.test(line)) return true;
  if (id === "accumulated_depreciation" && !/accumulated|less\s+acc/i.test(line)) return true;
  if (id === "accumulated_amortization" && (/other\s+assets|\b14\b/i.test(line) && !/amort|accumulated/i.test(line))) return true;
  if (id === "accumulated_amortization" && /other\s+ass/i.test(line) && !/less\s+accumulated\s+amort/i.test(line)) return true;
  if (id === "other_current_assets" && (/accounts\s+payable|\b16\b/i.test(line) && !/other\s+current\s+asset|line\s*6|\b6\b/i.test(line))) return true;
  // Caption / line-anchor required — no bare <$1000 size floor.
  if (id === "other_current_assets" && !/other\s+current\s+ass|line\s*6|\b6\b/i.test(line)) return true;
  if (id === "unclassified_equity" && value < 0) return true;
  if (id === "unclassified_equity" && !/retained|equity|line\s*24|\b24\b/i.test(line)) return true;
  if (
    id === "other_income" &&
    (/\b10\b.*other\s+income|schedule\s*k-?1|shareholder|1045\s+other\s+income/i.test(line) ||
      /identifv?ying\s+number/i.test(line))
  ) {
    return true;
  }
  // Line-number crumbs only when no substantial money cell (not a bare <$100 floor).
  if (id === "other_income" && Math.abs(value) <= 99 && !substantialMoneyTokens(line).length) return true;
  if (
    id === "other_operating_income" &&
    /other\s+income/i.test(line) &&
    !/other\s+operat.{0,8}inc/i.test(line)
  ) {
    return true;
  }
  // Sales / COGS: caption structure — no bare <$1000 size floor.
  if (id === "sales" && !/receipt|sales|1a|1c/i.test(line)) return true;
  if (id === "cogs" && Math.abs(value) <= 99 && !/cost\s+of|cogs|goods\s+sold/i.test(line)) return true;
  if ((id === "sales" || id === "cogs" || id === "rent") && Math.abs(value) <= 1) return true;
  if (id === "rent" && /gross\s+profit|total\s+income|ordinary\s+income/i.test(line)) return true;
  if (lead !== undefined && Math.abs(value) === lead) return true;
  if (id === "taxes_licenses" && /(\b13\b|\[13\]).*interest/i.test(line)) return true;
  if (
    id === "other_assets" &&
    (/current\s+liabilit|total\s+assets|totlassets|total\s+liabilit|shareholders|ending\s+assets|beginning\s+assets|f\s+total\s+assets|\b15\b/i.test(
      line,
    ) ||
      (/other\s+current\s+asset|line\s*6|\b6\b/i.test(line) && !/line\s*14|\b14\b/i.test(line)))
  ) {
    return true;
  }
  // Line 14 / other-assets caption required — no <$10k / ≥$100k size bands.
  if (id === "other_assets" && !/\b14\b/i.test(line) && !/other\s+ass/i.test(line)) return true;
  const needsSubstantial =
    id === "other_current_liabilities" ||
    id === "accounts_payable" ||
    id === "accounts_receivable" ||
    id === "taxes_licenses" ||
    id === "depreciation" ||
    id === "other_income" ||
    id === "accumulated_amortization" ||
    id === "gross_intangible_assets";
  if (needsSubstantial && !substantialMoneyTokens(line).length) return true;
  return false;
}

export function findHitsLineScoped(text: string, baseConfidence: number, targetYear?: number | null): ParseHit[] {
  let col: 0 | 1 = 1;
  const headerM = text.match(/\b(20\d{2})\s*[\&\-–]\s*(20\d{2})\b/);
  if (headerM && targetYear) {
    col = pickComparisonColumnIndex(Number(headerM[1]), Number(headerM[2]), targetYear);
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => stripEinNoise(line.replace(/\s+/g, " ").trim()))
    .filter(Boolean);

  const hits: ParseHit[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const line = stripOcrLinePrefix(rawLine);
    if (isIbisNoise(line) || isHistoricalGrossReceiptsLine(line) || /\d\s*%/.test(line)) continue;

    const continuation = lines[i + 1] ?? "";
    const chunk =
      continuation && !/\d\s*%/.test(continuation)
        ? `${line} ${stripOcrLinePrefix(continuation)}`.slice(0, 520)
        : line.slice(0, 520);

    for (const { id, pattern } of LABEL_PATTERNS) {
      if (!INPUT_ROW_IDS.has(id) || !lineMatchesLabelPattern(line, pattern)) continue;
      if (id === "cash" && /cash\s*flow/i.test(line)) continue;

      const nums: number[] = [];
      for (const match of Array.from(chunk.matchAll(/\(?\$?\s*-?\d[\d,]*(?:\.\d{2})?\s*\)?/g))) {
        const idx = match.index ?? 0;
        if (chunk.slice(idx + match[0].length, idx + match[0].length + 1) === "%") continue;
        const value = parseMoney(match[0]);
        if (value === null || rejectValueForField(id, line, value, targetYear)) continue;
        if (id === "other_income" && /total\s+income/i.test(chunk) && Math.abs(value) >= 1000) continue;
        nums.push(value);
      }
      if (!nums.length) continue;

      const pair = shrinkToYearColumns(nums);
      const value = pair ? pair[col] : nums[nums.length - 1];

      hits.push({
        id,
        value,
        confidence: Math.max(1, Math.min(99, baseConfidence)),
        evidence: repairOcrLabel(line).slice(0, 220) || line.slice(0, 220),
      });
    }
  }
  return hits;
}

function pickConsensus(hits: ParseHit[]): { value: number; matching: ParseHit[] } | undefined {
  if (!hits.length) return undefined;
  const counts = new Map<number, ParseHit[]>();
  for (const h of hits) {
    const b = counts.get(h.value) ?? [];
    b.push(h);
    counts.set(h.value, b);
  }
  const ranked = Array.from(counts.entries()).sort((a, b) => {
    if (b[1].length !== a[1].length) return b[1].length - a[1].length;
    const avgA = a[1].reduce((s, h) => s + h.confidence, 0) / a[1].length;
    const avgB = b[1].reduce((s, h) => s + h.confidence, 0) / b[1].length;
    return avgB - avgA;
  });

  const [value, matching] = ranked[0]!;
  return { value, matching };
}

function pickSales(hits: ParseHit[]): { value: number; matching: ParseHit[] } | undefined {
  const anchored = hits.filter((h) => /gross receipts|\[1c\]|1c\s/i.test(h.evidence));
  const pool = anchored.length ? anchored : hits;
  return pickConsensus(pool);
}

export function resolveHits(
  hits: ParseHit[],
  ocrConfidenceAvg: number,
  relaxed = false,
): { values: Record<string, number>; confidence: Record<string, number>; sources: Record<string, string>; warnings: string[] } {
  const grouped = new Map<string, ParseHit[]>();
  for (const hit of hits) {
    const list = grouped.get(hit.id) ?? [];
    list.push(hit);
    grouped.set(hit.id, list);
  }

  const values: Record<string, number> = {};
  const confidence: Record<string, number> = {};
  const sources: Record<string, string> = {};
  const warnings: string[] = [];
  const minConfidence = relaxed ? 32 : Number(process.env.FREE_OCR_MIN_ROW_CONFIDENCE ?? 50);
  const minForOcr = relaxed ? 28 : Math.min(minConfidence, Math.max(32, Math.round(ocrConfidenceAvg * 0.72)));

  const salesPick = pickSales((grouped.get("sales") ?? []).filter((h) => !/%/.test(h.evidence)));
  if (salesPick) {
    const avg = salesPick.matching.reduce((s, h) => s + h.confidence, 0) / salesPick.matching.length;
    const rowConf = Math.round(avg);
    const threshold = ocrConfidenceAvg > 0 && ocrConfidenceAvg < 70 ? minForOcr : minConfidence;
    if (rowConf >= threshold) {
      values.sales = salesPick.value;
      confidence.sales = rowConf;
      sources.sales = "OCR label match";
    }
  }

  for (const row of INPUT_ROWS) {
    if (row.id === "sales") {
      if (!values.sales && (grouped.get("sales")?.length ?? 0) > 0) {
        warnings.push(`No OCR/text match for ${row.label}.`);
      }
      continue;
    }

    const candidates = (grouped.get(row.id) ?? []).filter((h) => !/%/.test(h.evidence));
    if (!candidates.length) {
      warnings.push(`No OCR/text match for ${row.label}.`);
      continue;
    }

    const maxAmountFields = new Set(["professional_fees", "utilities", "bank_credit_card"]);
    const pick =
      maxAmountFields.has(row.id) && candidates.length > 1
        ? (() => {
            const best = candidates.reduce((a, b) => (Math.abs(b.value) > Math.abs(a.value) ? b : a));
            const matching = candidates.filter(
              (h) => Math.abs(h.value - best.value) <= Math.max(2, Math.abs(best.value) * 0.01),
            );
            return { value: best.value, matching: matching.length ? matching : [best] };
          })()
        : pickConsensus(candidates);
    if (!pick) continue;

    const avg = pick.matching.reduce((s, h) => s + h.confidence, 0) / pick.matching.length;
    const conflictPenalty = new Set(candidates.map((h) => h.value)).size > 1 ? 12 : 0;
    const rowConf = Math.max(1, Math.min(99, Math.round(avg - conflictPenalty)));
    const threshold = ocrConfidenceAvg > 0 && ocrConfidenceAvg < 70 ? minForOcr : minConfidence;

    if (rowConf < threshold) {
      warnings.push(`Low confidence for ${row.label} (${pick.value}, ${rowConf}% < ${threshold}%) — left blank.`);
      continue;
    }

    values[row.id] = pick.value;
    confidence[row.id] = rowConf;
    sources[row.id] = "OCR label match";
    if (new Set(candidates.map((h) => h.value)).size > 1) {
      warnings.push(`Conflicting values for ${row.label}; selected ${pick.value}.`);
    }
  }

  return { values, confidence, sources, warnings };
}
