/** IRS form numbers that OCR often misreads as dollar amounts — not company-specific. */
const FORM_REFERENCE_NUMBERS = new Set([1040, 1099, 1120, 1125, 4562, 8990, 3800, 7004, 2220]);

/** OCR sometimes uses periods as thousands separators (e.g. `283.400`). */
function normalizeOcrThousandsSeparator(s: string): string {
  const t = s.trim();
  if (/^\d{1,3}(\.\d{3})+(?:\.\d{2})?$/.test(t)) return t.replace(/\./g, "");
  return t;
}

export function parseMoney(input: string): number | null {
  let s = normalizeOcrThousandsSeparator(input.trim().replace(/[$,]/g, ""));
  if (!s || s === "-") return null;
  let sign = 1;
  if (s.startsWith("(") && s.endsWith(")")) {
    sign = -1;
    s = s.slice(1, -1);
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(sign * n) : null;
}

export function isFormReferenceNumber(n: number): boolean {
  return FORM_REFERENCE_NUMBERS.has(Math.abs(Math.round(n)));
}

/** OCR money runs — supports comma, period, or space thousands grouping. */
function ocrMoneyRuns(line: string): string[] {
  const runs: string[] = [];
  const re =
    /\d{1,3}(?:[.,]\d{3})+(?:\.\d{2})?|\d{1,3}(?:\s+\d{3})+(?:\.\d{2})?|\d[\d,]{1,}(?:\.\d{2})?/g;
  for (const m of line.matchAll(re)) runs.push(m[0]);
  return runs;
}

function parseSpaceGroupedDigits(raw: string): number | null {
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 2 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null;
  const joined = parts.join("");
  const n = Number(joined);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function parseOcrMoneyRuns(line: string, minChars: number): number[] {
  const nums: number[] = [];
  for (const raw of ocrMoneyRuns(line)) {
    if (raw.replace(/[^\d]/g, "").length < minChars) continue;
    const n = parseMoney(raw) ?? parseSpaceGroupedDigits(raw);
    if (n !== null && !isFormReferenceNumber(Math.abs(n))) nums.push(n);
  }
  return nums;
}

/** Money tokens on a line, excluding form-reference numbers. */
export function lineMoneyTokens(line: string): number[] {
  return parseOcrMoneyRuns(line, 2);
}

/**
 * Form 1120-S page-1 line prefix — tolerates OCR junk before bracketed line numbers (e.g. `Z[11 Rents`).
 * Uses a lookbehind (not a `{0,2}` optional prefix class, which can match zero-width and silently
 * accept a digit right before `n`) so a trailing digit of a larger number — e.g. the `9` in a
 * comparison-schedule "change" column value like `5,439` — can never be mistaken for line number 9.
 */
export function isForm1120Line(line: string, n: number): boolean {
  const m = new RegExp(`(?<![\\d.])\\[?${n}(?:\\](?!\\d)|\\b(?!\\d))`, "i").exec(line);
  if (!m) return false;
  // A genuine form row prints its line number at (or near) the start of the row, tolerating a
  // short OCR-junk prefix (e.g. `Z[11 Rents`, `& | 26 Other deductions`). A match found deep into
  // the line is almost always a cross-reference inside unrelated prose — e.g. a local/state tax
  // form's instructions mentioning "...Line 31 is greater than $5,000..." as a threshold, not an
  // actual IRS Form 1120 row — which would otherwise be misread as that row's dollar amount.
  return m.index <= 30;
}

/** Leading IRS line number on a row (e.g. `18 Other current liabilities`). */
export function leadingScheduleLineNumber(line: string): number | undefined {
  const m = line.match(/^\s*(\d{1,2})(?:[a-z]\b)?/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/** Money tokens with at least 4 characters (excludes most line numbers like 12, 18). */
export function substantialMoneyTokens(line: string): number[] {
  const nums = parseOcrMoneyRuns(line, 4);
  const lead = leadingScheduleLineNumber(line);
  if (lead === undefined) return nums;
  const filtered = nums.filter((n) => Math.abs(n) !== lead);
  return filtered.length ? filtered : nums;
}

/** Rightmost money amount on a line (typical Form 1120-S layout). */
export function lineTailAmount(line: string): number | undefined {
  const nums = lineMoneyTokens(line);
  if (!nums.length) return undefined;
  // A blank amount cell is sometimes OCR'd as nothing but the row's own line-number reference,
  // repeated once leading and once bracketed (e.g. "13 Salaries and wages ... [13]") — when every
  // money-like token on the line is that same tiny value, there is no real dollar amount printed.
  const distinct = new Set(nums.map((n) => Math.abs(n)));
  if (distinct.size === 1) {
    const only = [...distinct][0]!;
    if (only >= 1 && only <= 99) return undefined;
  }
  return nums[nums.length - 1];
}

/** End-of-row amount on Schedule L / Stmt lines — skips leading line numbers. */
export function scheduleLineAmount(line: string): number | undefined {
  const nums = substantialMoneyTokens(line);
  if (!nums.length) return undefined;
  if (/less\s+accumulated\s+depreciation/i.test(line) && nums.length >= 2 && nums[nums.length - 1] === 0) {
    return nums[nums.length - 2];
  }
  return nums[nums.length - 1];
}

/** Amount after IRS bracket tag like [2], [1c], [5] on form rows. */
export function bracketLineAmount(line: string, tag: string): number | undefined {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\[${escaped}\\][^\\d]{0,48}([\\d\\s,'\\.]+)`, "i");
  const m = line.match(re);
  if (!m?.[1]) return undefined;
  const raw = m[1].trim();
  const direct = parseMoney(raw) ?? parseSpaceGroupedDigits(raw);
  if (direct !== null && isReasonableMoneyAmount(direct) && !isFormReferenceNumber(Math.abs(direct))) {
    return direct;
  }
  const joined = raw.replace(/[^\d]/g, "");
  if (joined.length >= 4) {
    const n = Number(joined);
    if (Number.isFinite(n) && isReasonableMoneyAmount(n) && !isFormReferenceNumber(Math.abs(n))) {
      return Math.round(n);
    }
  }
  return undefined;
}

/** Prefer bracket-tagged amount, then largest substantial token (typical form page-1 layout). */
export function formLineAmount(line: string, tag: string): number | undefined {
  return bracketLineAmount(line, tag) ?? scheduleLineAmount(line) ?? lineTailAmount(line);
}

/** OCR often prefixes a spurious leading 1 on 7–8 digit amounts (e.g. 110,031,771 → 10,031,771). */
export function derailOcrLeadingOne(n: number): number {
  const abs = Math.abs(Math.round(n));
  const s = String(abs);
  if (s.length === 9 && s.startsWith("1")) {
    const trimmed = Number(s.slice(1));
    if (trimmed >= 1_000_000 && trimmed < 100_000_000) return Math.sign(n) * trimmed;
  }
  if (s.length === 8 && s.startsWith("1")) {
    const trimmed = Number(s.slice(1));
    if (trimmed >= 1_000_000 && trimmed < 10_000_000) return Math.sign(n) * trimmed;
  }
  return n;
}

/** Reject OCR-concatenated money (digit run length, not company size). */
export function isReasonableMoneyAmount(n: number): boolean {
  const digits = String(Math.abs(Math.round(n))).length;
  return digits >= 1 && digits <= 7;
}

/** Statement / Stmt detail line amount — substantial tokens only. */
export function statementLineAmount(line: string): number | undefined {
  const nums = substantialMoneyTokens(line);
  return nums.length ? nums[nums.length - 1] : undefined;
}

/** Largest money amount on a line (useful when label + amount columns are noisy). */
export function lineMaxAmount(line: string): number | undefined {
  const nums = lineMoneyTokens(line);
  return nums.length ? Math.max(...nums.map(Math.abs)) * (nums.find((n) => Math.abs(n) === Math.max(...nums.map(Math.abs)))! < 0 ? -1 : 1) : undefined;
}

export function isHistoricalGrossReceiptsLine(line: string): boolean {
  const t = line.toLowerCase();
  if (/8990\s+gross\s+receipts\s+for\s+20\d{2}/.test(t)) return true;
  if (/gross\s+receipts\s+for\s+20\d{2}/.test(t) && /section\s+448|3\s+tax\s+years|aggregate\s+average/.test(t)) return true;
  if (/schedule\s+k-1.*gross\s+receipts\s+for\s+section\s+448/.test(t)) return true;
  return false;
}
