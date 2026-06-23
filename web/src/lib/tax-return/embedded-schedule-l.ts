import type { FieldExtraction } from "./form-anchors";
import { parseMoney } from "./money";

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
  if (next && next.length >= 2 && next[1] === 0 && nums[0]! < 1_000_000) return 0;
  return nums[0];
}

function parseArizonaRows(block: string): number[][] {
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

/** Arizona REDW export: Schedule L rows are paired prior | current columns in fixed order. */
function extractArizonaScheduleL(text: string): FieldExtraction | null {
  const anchor = text.search(/schedule\s+l[\s\S]{0,400}?\d{1,3}(?:,\d{3})*\./i);
  if (anchor < 0) return null;

  const block = text.slice(anchor, anchor + 900);
  if (!/STATEMENT\s+8|STMT\s+7\s+STATEMENT\s+8|ARIZONA\s+SUN/i.test(block.slice(0, 280))) return null;

  const rows = parseArizonaRows(block);
  if (rows.length < 10) return null;

  const cur = (i: number) => rowCurrentAt(rows, i);
  const src = "Embedded Schedule L (Arizona)";

  const out: FieldExtraction = { values: {}, confidence: {}, sources: {} };
  setField(out, "cash", cur(0), src);
  setField(out, "accounts_receivable", cur(1), src);
  setField(out, "inventory", cur(3), src);
  setField(out, "other_current_assets", cur(4), src);

  const r5 = rows[5];
  const r6 = rows[6];
  const r5c = r5 ? rowCurrentAt(rows, 5) : undefined;
  let liabStart = 11;

  if (r5c !== undefined && r6 && r6.length > 2 && r5c >= 500_000) {
    setField(out, "other_assets", 0, src, 97);
    setField(out, "gross_fixed_assets", r5c, src);
    setField(out, "accumulated_depreciation", cur(6), src);
    setField(out, "gross_intangible_assets", cur(7), src);
    const amortRow = rows[8];
    if (amortRow?.length) setField(out, "accumulated_amortization", rowCurrent(amortRow), src);
    liabStart = 10;
  } else if (r5 && r6 && r6.length <= 2 && (r6[1] ?? r6[0])! >= 500_000) {
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
  if (stRow && stRow.length >= 2 && stRow[0] === 0 && stRow[1]! > 0 && stRow[1]! < 200_000) {
    setField(out, "short_term_debt", stRow[1], src);
    setField(out, "other_current_liabilities", cur(liabStart + 2), src);
    setField(out, "common_stock", cur(liabStart + 3), src);
  } else {
    setField(out, "other_current_liabilities", cur(liabStart + 1), src);
    setField(out, "common_stock", cur(liabStart + 2), src);
  }
  for (const nums of rows) {
    if (nums.length === 1 && nums[0] === 206) {
      setField(out, "additional_paid_in_capital", 206, src);
      break;
    }
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    const nums = rows[i]!;
    if (nums.length >= 2 && nums[1]! >= 1_000_000) {
      setField(out, "other_stock_equity", nums[1], src);
      break;
    }
  }

  return Object.keys(out.values).length >= 8 ? out : null;
}

/** Form 1120 dense Schedule L after entity EIN (Judd-style export). */
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
  for (const c of [extractArizonaScheduleL(embeddedText), extractDense1120ScheduleL(embeddedText)]) {
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
