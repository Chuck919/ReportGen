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
  // Dense/scanned OCR often inserts a space after a thousands comma: `2,539, 740` → `2,539,740`.
  const normalized = line.replace(/(\d{1,3}(?:,\d{3})*),\s+(\d{3})\b/g, "$1,$2");
  const runs: string[] = [];
  // Space-thousands must not start after "LINE n" ("LINE 20 419,737" ≠ 20,419).
  const re =
    /\d{1,3}(?:[.,]\d{3})+(?:\.\d{2})?|(?<!line\s)\d{1,3}(?:\s+\d{3})+(?:\.\d{2})?|\d[\d,]{1,}(?:\.\d{2})?/gi;
  for (const m of normalized.matchAll(re)) runs.push(m[0]);
  return runs;
}

/**
 * Trailing-period amount cells from dense preparer Stmt exports (`8.`, `500.`) —
 * Stmt Other-deductions detail only (not Form / Schedule L global money).
 */
function ocrMoneyRunsWithTrailingPeriodCells(line: string): string[] {
  const normalized = line.replace(/(\d{1,3}(?:,\d{3})*),\s+(\d{3})\b/g, "$1,$2");
  const runs: string[] = [];
  const re =
    /\d{1,3}(?:[.,]\d{3})+(?:\.\d{2})?|(?<!line\s)\d{1,3}(?:\s+\d{3})+(?:\.\d{2})?|\d{1,7}\.(?!\d)|\d[\d,]{1,}(?:\.\d{2})?/gi;
  for (const m of normalized.matchAll(re)) runs.push(m[0]);
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

/**
 * Money on Stmt Other-deductions attachment lines, including trailing-period micro amounts
 * (`TRAVEL 8.`). Do not use for Form / Schedule L — those layouts treat bare digits as line #s.
 */
export function stmtAttachmentMoneyTokens(line: string): number[] {
  const nums: number[] = [];
  for (const raw of ocrMoneyRunsWithTrailingPeriodCells(line)) {
    const digitLen = raw.replace(/[^\d]/g, "").length;
    const trailingPeriodCell = /^\d{1,7}\.$/.test(raw.trim());
    if (!trailingPeriodCell && digitLen < 2) continue;
    const n = parseMoney(raw) ?? parseSpaceGroupedDigits(raw);
    if (n === null) continue;
    const abs = Math.abs(n);
    if (isFormReferenceNumber(abs)) continue;
    if (abs >= 1990 && abs <= 2035) continue;
    nums.push(n);
  }
  const lead = leadingScheduleLineNumber(line);
  if (lead === undefined) return nums;
  const filtered = nums.filter((n) => Math.abs(n) !== lead);
  return filtered.length ? filtered : nums;
}

/** Rightmost Stmt-attachment amount (prefers trailing-period cells). */
export function stmtAttachmentLineAmount(line: string): number | undefined {
  const nums = stmtAttachmentMoneyTokens(line);
  return nums.length ? nums[nums.length - 1] : undefined;
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
  const head = line.slice(0, 35);
  const m = new RegExp(`(?<![\\d.])\\[?${n}(?:\\](?!\\d)|\\b(?!\\d))`, "i").exec(head);
  if (m && m.index <= 30) return true;
  // OCR bleed: one junk digit prepended to the real line number ("214" → line 14).
  const leadDigits = head.match(/^(\d{1,3})\b/);
  if (leadDigits) {
    const digits = leadDigits[1]!;
    const nStr = String(n);
    if (digits === nStr) return true;
    if (digits.length === nStr.length + 1 && digits.endsWith(nStr)) return true;
  }
  return false;
}

/** Leading IRS line number on a row (e.g. `18 Other current liabilities`). */
export function leadingScheduleLineNumber(line: string): number | undefined {
  const m = line.match(/^\s*[\W_]*(\d{1,2})(?:[a-z])?(?=\s|[_\][|.:])/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/** Money tokens excluding the row's own leading IRS line reference. */
export function substantialMoneyTokens(line: string): number[] {
  const nums = parseOcrMoneyRuns(line, 1);
  const refs = new Set<number>();
  const lead = leadingScheduleLineNumber(line);
  if (lead !== undefined) refs.add(lead);
  for (const match of line.matchAll(/\[\s*(\d{1,3})[a-z]?(?=\s*[|\]])/gi)) {
    refs.add(Number(match[1]));
  }
  for (const match of line.matchAll(/\|\s*(\d{1,3})[a-z]?\s*(?=[_|])/gi)) {
    refs.add(Number(match[1]));
  }
  for (const match of line.matchAll(/\bline\s*(\d{1,3})\b/gi)) {
    refs.add(Number(match[1]));
  }
  // Statement caption headers ("Statement 6 - Form 1120-S, Page 4, Schedule L,
  // Line 18 …") — statement and page numbers are references, never dollar cells.
  for (const match of line.matchAll(/\bpage\s*(\d{1,3})\b/gi)) {
    refs.add(Number(match[1]));
  }
  for (const match of line.matchAll(/\b(?:stat(?:ement)?|stmt)\s*(\d{1,3})\b/gi)) {
    refs.add(Number(match[1]));
  }
  const gluedLeading = line.match(/^\s*[\W_]*(\d{3,})\s+(?=[a-z])/i);
  return nums.filter((n) => {
    const abs = Math.abs(Math.round(n));
    if (refs.has(abs)) return false;
    if (
      gluedLeading &&
      Number(gluedLeading[1]) === abs &&
      [...refs].some((ref) => String(abs).endsWith(String(ref)))
    ) {
      return false;
    }
    return true;
  });
}

/** Rightmost money amount on a line (typical Form 1120-S layout). */
export function lineTailAmount(line: string): number | undefined {
  const nums = lineMoneyTokens(line);
  if (!nums.length) return undefined;
  // A blank amount cell is sometimes OCR'd as nothing but the row's own line-number reference,
  // repeated once leading and once bracketed (e.g. "13 Salaries and wages ... [13]").
  const distinct = new Set(nums.map((n) => Math.abs(n)));
  if (distinct.size === 1) {
    const only = [...distinct][0]!;
    const rowRef = leadingScheduleLineNumber(line);
    const bracketRefs = [...line.matchAll(/\[\s*(\d{1,3})\s*\]/g)].map((m) => Number(m[1]));
    if (rowRef === only || bracketRefs.includes(only)) return undefined;
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

/**
 * Form page-1 expense boxes hold a single dollar cell. Multiple substantial tokens usually
 * mean multi-column OCR bleed (comparison / depreciation-report columns on the same line) —
 * refuse rather than guessing last/first (charter: no soft year/% pick).
 */
export function unambiguousFormLineAmount(line: string): number | undefined {
  const toks = substantialMoneyTokens(line);
  if (toks.length !== 1) return undefined;
  return Math.round(toks[0]!);
}

/** Bracket tag if present; otherwise only when the line has exactly one money cell. */
export function unambiguousFormLineAmountForTag(line: string, tag: string): number | undefined {
  return bracketLineAmount(line, tag) ?? unambiguousFormLineAmount(line);
}

/**
 * Reject OCR-concatenated digit runs (cell shape), not company size.
 * Ungrouped IRS money cells on corporate returns are ≤9 digits ($999,999,999);
 * 10+ digit runs are almost always glued OCR (e.g. two amounts smashed together).
 */
export function isReasonableMoneyAmount(n: number): boolean {
  if (!Number.isFinite(n) || !Number.isSafeInteger(Math.round(n))) return false;
  const digits = String(Math.abs(Math.round(n))).length;
  return digits >= 1 && digits <= 9;
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

/** Comparison / worksheet column dollars — exclude form refs, tax years, line-number crumbs. */
export function isKeepableWorksheetAmount(n: number): boolean {
  const abs = Math.abs(Math.round(n));
  if (abs < 1) return false;
  if (!isReasonableMoneyAmount(abs)) return false;
  if (isFormReferenceNumber(abs)) return false;
  if (abs >= 1990 && abs <= 2035) return false;
  return true;
}

/**
 * Keepable worksheet dollar with row context. Small dollars are valid; reject a
 * printed row number only when every parsed numeric token is that same reference
 * (a blank amount cell such as `16 Accounts payable`).
 */
export function isKeepableWorksheetAmountOnLine(n: number, line: string): boolean {
  if (!isKeepableWorksheetAmount(n)) return false;
  const abs = Math.abs(Math.round(n));
  const rowRefs = [
    ...line.matchAll(/(?:^\s*[\W_]*|\[|\bline\s*)(\d{1,3})(?=\s|[_\][|.:,])/gi),
  ].map((m) => Number(m[1]));
  if (!rowRefs.includes(abs)) return true;
  const tokens = lineMoneyTokens(line).filter(isKeepableWorksheetAmount);
  return tokens.some((token) => Math.abs(Math.round(token)) !== abs);
}

/** Substantial tokens suitable for comparison / Stmt TOTAL columns. */
export function keepableWorksheetMoneyTokens(line: string): number[] {
  return substantialMoneyTokens(line).filter((n) => isKeepableWorksheetAmountOnLine(n, line));
}

export function isHistoricalGrossReceiptsLine(line: string): boolean {
  const t = line.toLowerCase();
  if (/8990\s+gross\s+receipts\s+for\s+20\d{2}/.test(t)) return true;
  if (/gross\s+receipts\s+for\s+20\d{2}/.test(t) && /section\s+448|3\s+tax\s+years|aggregate\s+average/.test(t)) return true;
  if (/schedule\s+k-1.*gross\s+receipts\s+for\s+section\s+448/.test(t)) return true;
  return false;
}
