import type { FieldExtraction } from "./form-anchors";
import { isKeepableWorksheetAmount, parseMoney } from "./money";

const CONF = 99;

function setField(
  out: FieldExtraction,
  id: string,
  value: number | undefined,
  source: string,
  conf = CONF,
): void {
  if (value === undefined || !Number.isFinite(value)) return;
  const prev = out.confidence[id] ?? 0;
  if (prev > conf) return;
  out.values[id] = Math.round(value);
  out.confidence[id] = conf;
  out.sources[id] = source;
}

/** Right column (current year end) from a Schedule L pair row. */
function rowCurrent(nums: number[]): number | undefined {
  if (!nums.length) return undefined;
  if (nums.length >= 2) return nums[1];
  return nums[0];
}

function rowCurrentAt(rows: number[][], i: number): number | undefined {
  const nums = rows[i];
  if (!nums?.length) return undefined;
  if (nums.length >= 2) return nums[1];
  const next = rows[i + 1];
  if (next && next.length >= 2 && next[1] === 0) return 0;
  return nums[0];
}

/**
 * Paired prior|current Schedule L rows from dense preparer exports that use trailing-period
 * money cells (`1,234.`). Layout grammar only — not a taxpayer or preparer-firm name gate.
 */
function parsePairedColumnScheduleLRows(block: string): number[][] {
  const rows: number[][] = [];
  for (const rawLine of block.split(/\n/)) {
    const line = rawLine.trim();
    if (!/\d{1,3}(?:,\d{3})*\./.test(line)) continue;
    const nums = [...line.matchAll(/(\d{1,3}(?:,\d{3})*)\./g)]
      .map((m) => parseMoney(m[1]!))
      .filter((n): n is number => n !== null);
    if (nums.length) rows.push(nums);
  }
  return rows;
}

/** Attachment captions that reuse "Schedule L" — not the Balance Sheets table itself. */
const SCHEDULE_L_ATTACHMENT_CAPTION =
  /^schedule\s+l\s+(other\s+current|other\s+assets|other\s+invest|analysis\s+of|taxes\s+and)/i;

/**
 * Dense preparer packs omit blank AR / OCA / other-asset lines, so inventory sits at row 1
 * and liabilities start ~row 5. Full packs keep AR (often echoed on the next row).
 * Detect by AR-echo structure — not by dollar size or taxpayer name.
 */
function isCompactPairedScheduleL(rows: number[][]): boolean {
  if (rows.length < 8 || rows.length > 14) return false;
  const r1 = rowCurrent(rows[1] ?? []);
  const r2 = rowCurrent(rows[2] ?? []);
  if (r1 === undefined || r2 === undefined) return false;
  // Full Form layout: allowance row echoes AR (same current dollars) — exact only.
  const arEcho = Math.round(r1) === Math.round(r2);
  if (arEcho) return false;
  // Compact: buildings/GFA row is often multi-column (cost + accum + net) soon after inventory.
  const hasDepBundle = rows.slice(2, 5).some((r) => r.length >= 4);
  return hasDepBundle || rows.length <= 12;
}

/**
 * Paired-column Schedule L: activates on dense preparer packs (`Schedule L` + trailing-period
 * cells near STATEMENT markers, or ≥8 dense prior|current pairs). Skips attachment titles
 * like "SCHEDULE L OTHER CURRENT LIABILITIES STATEMENT N". Maps full vs compact row packs
 * by AR-echo structure — never by taxpayer name.
 */
function extractPairedColumnScheduleL(text: string): FieldExtraction | null {
  const headingRe = /schedule\s+l\b/gi;
  let heading: RegExpExecArray | null;
  let block: string | null = null;

  while ((heading = headingRe.exec(text)) !== null) {
    const anchor = heading.index;
    const captionHead = text.slice(anchor, anchor + 100);
    if (SCHEDULE_L_ATTACHMENT_CAPTION.test(captionHead)) continue;

    const near = text.slice(anchor, anchor + 400);
    if (!/\d{1,3}(?:,\d{3})*\./.test(near)) continue;

    const candidate = text.slice(anchor, anchor + 900);
    const rows = parsePairedColumnScheduleLRows(candidate);
    if (rows.length < 10) continue;

    const head = candidate.slice(0, 280);
    // Dense 1120-S packs list STATEMENT N under Schedule L; STATEMENT 8 is common but not
    // required — smaller returns often start at STATEMENT 3/4/5 with the same grammar.
    const hasStmtMarker = /STATEMENT\s+[3-9]|STMT\s+\d+\s+STATEMENT\s+\d+/i.test(head);
    const densePairs = rows.filter((r) => r.length >= 2).length;
    if (!hasStmtMarker && densePairs < 8) continue;

    block = candidate;
    break;
  }

  if (!block) return null;

  const rows = parsePairedColumnScheduleLRows(block);
  const cur = (i: number) => rowCurrentAt(rows, i);
  const src = "Embedded Schedule L (paired-column)";
  const out: FieldExtraction = { values: {}, confidence: {}, sources: {} };

  if (isCompactPairedScheduleL(rows)) {
    // Omitted blank asset lines: cash → inventory → GFA → accum → total → ST debt → OCL → stock.
    setField(out, "cash", cur(0), src);
    setField(out, "accounts_receivable", 0, src, 97);
    setField(out, "inventory", cur(1), src);
    setField(out, "other_current_assets", 0, src, 97);
    setField(out, "other_assets", 0, src, 97);
    setField(out, "gross_fixed_assets", cur(2), src);
    const depRow = rows[3];
    if (depRow && depRow.length >= 4) {
      // prior|current accum, then prior|current net → book ending accum (index 1).
      setField(out, "accumulated_depreciation", depRow[1], src);
    } else {
      setField(out, "accumulated_depreciation", cur(3), src);
    }
    setField(out, "gross_intangible_assets", 0, src, 97);
    setField(out, "accumulated_amortization", 0, src, 97);
    // Compact packs omit blank AP — next liability row is mortgages/notes < 1 year.
    setField(out, "current_portion_ltd", cur(5), src);
    setField(out, "other_current_liabilities", cur(6), src);
    // Optional loans-from-shareholders may sit between OCL and capital stock.
    let stockIdx = 7;
    const nomPar = new Set([100, 500, 1000, 5_000, 10_000]);
    const r7 = cur(7);
    const r8 = cur(8);
    if (
      r7 !== undefined &&
      !nomPar.has(Math.round(Math.abs(r7))) &&
      r8 !== undefined &&
      nomPar.has(Math.round(Math.abs(r8)))
    ) {
      stockIdx = 8;
    }
    setField(out, "common_stock", cur(stockIdx), src);
    // Do not book retained earnings here — Schedule L line 24 / STATEMENT already fills
    // unclassified_equity; dual-booking doubles L+E in the workbook identity check.
  } else {
    setField(out, "cash", cur(0), src);
    setField(out, "accounts_receivable", cur(1), src);
    setField(out, "inventory", cur(3), src);
    setField(out, "other_current_assets", cur(4), src);

    const r5 = rows[5];
    const r6 = rows[6];
    const r5c = r5 ? rowCurrentAt(rows, 5) : undefined;
    let liabStart = 11;

    const r6IsDepBundle = r6 && r6.length > 2;
    const r7IsDepBundle = rows[7] && rows[7]!.length >= 4;

    if (r5c !== undefined && r6IsDepBundle) {
      setField(out, "other_assets", 0, src, 97);
      setField(out, "gross_fixed_assets", r5c, src);
      setField(out, "accumulated_depreciation", cur(6), src);
      setField(out, "gross_intangible_assets", cur(7), src);
      const amortRow = rows[8];
      if (amortRow?.length) setField(out, "accumulated_amortization", rowCurrent(amortRow), src);
      liabStart = 10;
    } else if (r5 && r6 && r6.length <= 2 && r7IsDepBundle) {
      setField(out, "other_assets", cur(5), src);
      setField(out, "gross_fixed_assets", cur(6), src);
      setField(out, "accumulated_depreciation", cur(7), src);
      setField(out, "gross_intangible_assets", cur(8), src);
      const amortRow = rows[9];
      if (amortRow?.length) setField(out, "accumulated_amortization", rowCurrent(amortRow), src);
    } else {
      setField(out, "other_assets", cur(5), src);
      setField(out, "gross_fixed_assets", cur(6), src);
      setField(out, "accumulated_depreciation", cur(7), src);
      setField(out, "gross_intangible_assets", cur(8), src);
      const amortRow = rows[9];
      if (amortRow?.length) setField(out, "accumulated_amortization", rowCurrent(amortRow), src);
    }

    setField(out, "accounts_payable", cur(liabStart), src);
    const stRow = rows[liabStart + 1];
    // ST debt row = zero begin / positive end (column structure), not a $200k size band.
    if (
      stRow &&
      stRow.length >= 2 &&
      stRow[0] === 0 &&
      stRow[1]! > 0 &&
      isKeepableWorksheetAmount(stRow[1]!)
    ) {
      setField(out, "short_term_debt", stRow[1], src);
      setField(out, "other_current_liabilities", cur(liabStart + 2), src);
      setField(out, "common_stock", cur(liabStart + 3), src);
    } else {
      setField(out, "other_current_liabilities", cur(liabStart + 1), src);
      setField(out, "common_stock", cur(liabStart + 2), src);
    }
    // APIC (line 23) with begin == end renders as two consecutive single-cell rows of the
    // same amount (the column pair splits around the taxpayer-name line). Structural match:
    // adjacent equal singles in the liability/equity section — never a hardcoded dollar value.
    for (let i = liabStart; i < rows.length - 1; i++) {
      const a = rows[i]!;
      const b = rows[i + 1]!;
      if (
        a.length === 1 &&
        b.length === 1 &&
        a[0] !== undefined &&
        a[0] === b[0] &&
        isKeepableWorksheetAmount(a[0])
      ) {
        setField(out, "additional_paid_in_capital", a[0], src);
        break;
      }
    }
    // Equity = last prior|current keepable pair that changed — skip line-number / YY-year crumbs.
    for (let i = rows.length - 1; i >= liabStart; i--) {
      const nums = rows[i]!;
      const end = nums[1];
      if (
        nums.length >= 2 &&
        nums[0] !== undefined &&
        end !== undefined &&
        end > 99 &&
        end !== nums[0] &&
        isKeepableWorksheetAmount(end)
      ) {
        setField(out, "other_stock_equity", end, src);
        break;
      }
    }
  }

  return Object.keys(out.values).length >= 8 ? out : null;
}

/** Form 1120 dense Schedule L after entity EIN (preparer summary-block export). */
function extractDense1120ScheduleL(text: string): FieldExtraction | null {
  const m = text.match(
    /([A-Z][\w\s,.&'-]{8,60}(?:INC|LLC|CORP)\.?)\s+(\d{2}-\d{7})\s+(\d{1,3}(?:,\d{3})+\s+\d{1,3}(?:,\d{3})+[\s\S]{0,300}?STMT\s+3\s+\d{1,3}(?:,\d{3})+\s+\d{1,3}(?:,\d{3})+)/i,
  );
  if (!m?.[3]) return null;

  const chunk = m[3];
  const lines = chunk
    .split(/\n/)
    .map((row) => row.trim())
    .filter((row) => /\d{1,3}(?:,\d{3})+/.test(row));

  const lineNums = lines.map((row) => {
    if (/^STMT\s+3/i.test(row)) {
      const stmt = row.match(/STMT\s+3\s+(\d{1,3}(?:,\d{3})+)\s+(\d{1,3}(?:,\d{3})+)/i);
      if (!stmt) return [] as number[];
      return [parseMoney(stmt[1]!), parseMoney(stmt[2]!)].filter((n): n is number => n !== null);
    }
    return [...row.matchAll(/(\d{1,3}(?:,\d{3})+)/g)]
      .map((x) => parseMoney(x[1]!))
      .filter((n): n is number => n !== null);
  });

  const current = (pair: number[]) => (pair.length >= 2 ? pair[pair.length - 1]! : pair[0]);
  const cashLine = lineNums[0];
  const gfaLine = lineNums[1];
  const depLine = lineNums[2];
  const totalLine = lineNums[3];
  const stmtLine = lineNums[4];

  const cash = cashLine?.length ? current(cashLine) : undefined;
  const grossFixed = gfaLine?.length ? current(gfaLine) : undefined;
  let accum: number | undefined;
  if (depLine?.length === 4) accum = depLine[2];
  else if (depLine?.length >= 2) accum = current(depLine);
  const totalAssets = totalLine?.length ? current(totalLine) : undefined;
  const stDebt = stmtLine?.length ? stmtLine[stmtLine.length - 1]! : undefined;

  if (cash === undefined || grossFixed === undefined || accum === undefined || totalAssets === undefined) return null;

  const out: FieldExtraction = { values: {}, confidence: {}, sources: {} };
  const src = "Embedded Schedule L (1120 dense)";
  setField(out, "cash", cash, src);
  setField(out, "gross_fixed_assets", grossFixed, src);
  setField(out, "accumulated_depreciation", accum, src);
  if (stDebt !== undefined) {
    setField(out, "short_term_debt", stDebt, src);
    setField(out, "unclassified_equity", totalAssets - stDebt, src, 97);
  }
  return out;
}

/** Parse Schedule L from embedded PDF text when OCR skipped those pages. */
export function extractEmbeddedScheduleL(embeddedText: string): FieldExtraction {
  const out: FieldExtraction = { values: {}, confidence: {}, sources: {} };
  for (const c of [extractPairedColumnScheduleL(embeddedText), extractDense1120ScheduleL(embeddedText)]) {
    if (!c) continue;
    for (const [id, value] of Object.entries(c.values)) {
      const conf = c.confidence[id] ?? CONF;
      if (conf >= (out.confidence[id] ?? 0)) {
        out.values[id] = value;
        out.confidence[id] = conf;
        out.sources[id] = c.sources[id] ?? "Embedded Schedule L";
      }
    }
  }
  return out;
}

/** Find PDF page numbers that mention Schedule L in embedded text (for OCR targeting). */
export function findScheduleLPagesFromEmbedded(embeddedText: string): number[] {
  const pages: number[] = [];
  const re = /--\s*(\d+)\s+of\s+(\d+)\s*--/g;
  const markers: Array<{ page: number; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(embeddedText)) !== null) {
    markers.push({ page: Number(m[1]), index: m.index });
  }
  if (!markers.length) return pages;

  const slRe = /schedule\s+l|balance\s*sheets?\s*per\s*books/gi;
  let sm: RegExpExecArray | null;
  while ((sm = slRe.exec(embeddedText)) !== null) {
    const idx = sm.index;
    let page = markers[0]!.page;
    for (const mk of markers) {
      if (mk.index <= idx) page = mk.page;
      else break;
    }
    if (page > 0 && !pages.includes(page)) pages.push(page);
  }
  return pages.sort((a, b) => a - b);
}
