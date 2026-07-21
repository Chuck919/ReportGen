import type { FieldExtraction } from "./form-anchors";
import {
  isFormReferenceNumber,
  isKeepableWorksheetAmountOnLine,
  isReasonableMoneyAmount,
  keepableWorksheetMoneyTokens,
  lineMoneyTokens,
  parseMoney,
  scheduleLineAmount,
  stmtAttachmentMoneyTokens,
  substantialMoneyTokens,
} from "./money";

const STMT_AUTH_CONF = 99;

const NOMINAL_PAR_AMOUNTS = new Set([100, 500, 1000, 5000, 10_000]);

/** Schedule L line 22 — prefer end-column nominal par ($100) over garbled begin-column OCR. */
function scheduleLCapitalStockAmount(line: string): number | undefined {
  // OCR often ends with "100" (par value). Prefer that over "1 300 00]" junk.
  const nums = lineMoneyTokens(line);
  if (nums.length) {
    const end = Math.round(Math.abs(nums[nums.length - 1]!));
    if (NOMINAL_PAR_AMOUNTS.has(end)) return end;
  }
  const trail = line.match(/(?:^|[\s|\]}])(100|500|1,?000|5,?000|10,?000)\s*$/i);
  if (trail) return Number(trail[1]!.replace(/,/g, ""));

  const pipeIdx = line.indexOf("|");
  if (pipeIdx >= 0) {
    const endPart = line.slice(pipeIdx + 1);
    const endNums = lineMoneyTokens(endPart);
    if (endNums.length) {
      const end = Math.round(Math.abs(endNums[endNums.length - 1]!));
      // Prefer IRS nominal-par tokens; otherwise keepable end-column dollars.
      if (NOMINAL_PAR_AMOUNTS.has(end) || isKeepableWorksheetAmountOnLine(end, line)) return end;
      return undefined;
    }
  }

  if (nums.length >= 2) {
    const end = Math.round(Math.abs(nums[nums.length - 1]!));
    // Begin-column OCR junk is rejected only when it is the printed row reference.
    if (NOMINAL_PAR_AMOUNTS.has(end) || isKeepableWorksheetAmountOnLine(end, line)) return end;
  }

  const amt = scheduleLineAmount(line);
  if (amt === undefined) return undefined;
  const abs = Math.round(Math.abs(amt));
  if (NOMINAL_PAR_AMOUNTS.has(abs) || isKeepableWorksheetAmountOnLine(abs, line)) return amt;
  return undefined;
}

function scheduleLine17Amount(line: string): number | undefined {
  // Dense preparer Schedule L uses trailing-period cells (`564.` / `386.`). Prefer the
  // end-of-year column (last keepable token). Do NOT join spaced begin-column OCR
  // (`1 564`) into a single amount — that stole end-year 386 on thorough/live packs.
  const endCol = (nums: number[]): number | undefined => {
    const keep = nums.filter((n) => isKeepableWorksheetAmountOnLine(n, line));
    if (!keep.length) return undefined;
    return keep[keep.length - 1];
  };

  const fromTrailing = endCol(stmtAttachmentMoneyTokens(line));
  if (fromTrailing !== undefined) return fromTrailing;

  const segments = line.split("|");
  if (segments.length >= 2) {
    const tail = endCol(stmtAttachmentMoneyTokens(segments[segments.length - 1]!));
    if (tail !== undefined) return tail;
    const tailKeep = endCol(keepableWorksheetMoneyTokens(segments[segments.length - 1]!));
    if (tailKeep !== undefined) return tailKeep;
  }

  const fromLine = endCol(lineMoneyTokens(line));
  if (fromLine !== undefined) return fromLine;

  return endCol(keepableWorksheetMoneyTokens(line));
}

/** Prefer the Schedule L balance-sheet block (not return-summary / worksheet headers). */
function findScheduleLBalanceSheetBlock(text: string): string {
  const blocks: string[] = [];
  const re = /schedule\s+l.{0,100}balance\s*sheets?\s*per\s*books/i;
  let m: RegExpExecArray | null;
  const global = new RegExp(re.source, "gi");
  while ((m = global.exec(text)) !== null) {
    blocks.push(text.slice(m.index, m.index + 8000));
  }
  if (blocks.length) {
    const score = (chunk: string) =>
      (/\b18\b.{0,80}(?:curren|liab|faves|iavit|abides)/i.test(chunk) ? 4 : 0) +
      (/\b14\b.{0,60}other\s+ass/i.test(chunk) ? 2 : 0) +
      (/total\s+assets/i.test(chunk) ? 1 : 0);
    return blocks.sort((a, b) => score(b) - score(a))[0]!;
  }
  const fallback = text.match(/schedule\s+l[\s\S]{0,12000}/i)?.[0];
  return fallback ?? text;
}

function setStmtTotal(
  out: FieldExtraction,
  id: string,
  value: number | undefined,
  source: string,
): void {
  if (value === undefined) return;
  out.values[id] = Math.round(value);
  out.confidence[id] = STMT_AUTH_CONF;
  out.sources[id] = source;
}

/** True when the row's final numeric cell equals the amount (comma groups intact). */
function amountOccupiesEndCell(row: string, amount: number): boolean {
  const runs = row.match(/\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+(?:\.\d{2})?/g);
  if (!runs?.length) return false;
  const last = parseMoney(runs[runs.length - 1]!);
  return last !== null && Math.abs(last) === Math.abs(Math.round(amount));
}

function signedScheduleAmount(line: string): number | undefined {
  const amt = scheduleLineAmount(line);
  if (amt === undefined) return undefined;
  const normalized = line.replace(/\s+/g, " ");
  if (amt > 0 && /(?:^|[^\d])-\s*[\d,]+(?:\.\d+)?\s*$/.test(normalized)) return -amt;
  return amt;
}

/** Schedule L line 1 cash — prefer end-of-year column; skip fixed-asset "cash registers" rows. */
export function scheduleLLine1CashAmount(line: string): number | undefined {
  const normalized = line.replace(/\s+/g, " ").trim();
  const isCashRow =
    /^1\s*cash\b/i.test(normalized) ||
    /^1?\s*t?csh\b/i.test(normalized) ||
    /^1\s*[\[|]?\s*cash\b/i.test(normalized) ||
    /^1\s*[\[|]?\s*bank\s+funds?\b/i.test(normalized) ||
    (/^\[1\b/i.test(normalized) && /\d{1,3}(?:,\d{3})+/.test(normalized));
  if (!isCashRow) return undefined;
  if (/cash\s*regist|fixed\s+asset|form\s*4562|depreciat/i.test(normalized)) return undefined;

  const commaAmounts = [...normalized.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d{2})?/g)]
    .map((m) => parseMoney(m[0]))
    .filter((n): n is number => {
      if (n === null) return false;
      const abs = Math.abs(n);
      return isKeepableWorksheetAmountOnLine(abs, normalized);
    });
  if (commaAmounts.length >= 2) return commaAmounts[commaAmounts.length - 1]!;
  if (commaAmounts.length === 1) return commaAmounts[0]!;

  const nums = lineMoneyTokens(normalized).filter((n) => {
    const abs = Math.abs(n);
    return isKeepableWorksheetAmountOnLine(abs, normalized);
  });
  if (nums.length >= 2) return nums[nums.length - 1]!;
  return nums[0];
}

function pickScheduleLGross(row: string): number | undefined {
  const cleaned = row.replace(/(\d{1,3}),\s+(\d{3})/g, "$1,$2");
  const amounts = lineMoneyTokens(cleaned)
    .map(Math.abs)
    .filter((amount) => isKeepableWorksheetAmountOnLine(amount, cleaned));
  if (amounts.length >= 2) {
    // Schedule L 10a: beginning | end — workbook uses end-of-year (last column).
    return amounts[amounts.length - 1]!;
  }
  if (amounts.length) return amounts[0]!;
  const amt = scheduleLineAmount(cleaned);
  return amt !== undefined && isReasonableMoneyAmount(amt) ? Math.abs(amt) : undefined;
}

/** Schedule L row scanners + Stmt 4/5 totals (structure only, no dollar thresholds). */
export function extractScheduleLFields(text: string): FieldExtraction {
  const out: FieldExtraction = { values: {}, confidence: {}, sources: {} };

  const schedBlock = findScheduleLBalanceSheetBlock(text);
  let bestCash: { value: number; score: number } | undefined;
  const cashScanTexts = schedBlock !== text ? [schedBlock, text] : [text];
  for (const scanText of cashScanTexts) {
    for (const row of scanText.split(/\n/)) {
      const line = row.replace(/\s+/g, " ").trim();
      const amt = scheduleLLine1CashAmount(line);
      if (amt === undefined) continue;
      const inBlock = scanText === schedBlock;
      const score =
        (inBlock ? 2 : 0) +
        (/\d{1,3}(?:,\d{3})+/.test(line) ? 2 : 0);
      if (!bestCash || score > bestCash.score) bestCash = { value: amt, score };
    }
  }
  if (bestCash) {
    out.values.cash = Math.round(bestCash.value);
    out.confidence.cash = 97;
    out.sources.cash = "Schedule L line 1";
  }

  let best10a: { value: number; score: number } | undefined;
  for (const row of text.split(/\n/)) {
    if (!/\b10a\s+build/i.test(row) && !/other depreciable assets/i.test(row)) continue;
    const gross = pickScheduleLGross(row);
    if (gross === undefined || gross <= 0) continue;
    const score =
      (/\b10a\b/i.test(row) ? 4 : 0) +
      (substantialMoneyTokens(row).length ? 2 : 0) +
      Math.min(2, substantialMoneyTokens(row).length);
    if (!best10a || score > best10a.score) best10a = { value: gross, score };
  }
  if (best10a) {
    out.values.gross_fixed_assets = Math.round(best10a.value);
    out.confidence.gross_fixed_assets = 98;
    out.sources.gross_fixed_assets = "Schedule L line 10a";
  }

  const line10b = text.split(/\n/).find((row) => /less accumulated depreciation/i.test(row));
  if (line10b) {
    const commaNums = (line10b.match(/\d{1,3}(?:,\d{3})+(?:\.\d{2})?\b/g) ?? [])
      .map((r) => parseMoney(r))
      .filter((n): n is number => {
        if (n === null) return false;
        const abs = Math.abs(n);
        return isKeepableWorksheetAmountOnLine(abs, line10b);
      });
    const acc =
      commaNums.length >= 2
        ? Math.max(...commaNums.map((n) => Math.abs(n)))
        : commaNums.length
          ? commaNums[commaNums.length - 1]!
          : scheduleLineAmount(line10b);
    if (acc !== undefined && acc > 0) {
      const gfa = out.values.gross_fixed_assets;
      // When 10b is net book (acc + something = gfa) prefer gross − net as accum.
      // Exact identity only — no ×0.25 size band.
      if (gfa !== undefined && acc < gfa && Math.round(gfa - acc) > 0) {
        const maybeNet = Math.round(acc);
        const maybeAccum = Math.round(gfa - maybeNet);
        // Prefer reading as accum when the token sits near "less accumulated";
        // if OCR put net book on the line, gfa − token closes to a prior year column.
        const looksLikeNetBook =
          /net\s+book|book\s+value/i.test(line10b) ||
          (commaNums.length >= 2 &&
            commaNums.some((n) => Math.round(Math.abs(n)) === Math.round(gfa)));
        if (looksLikeNetBook) {
          out.values.accumulated_depreciation = maybeAccum;
          out.confidence.accumulated_depreciation = 98;
          out.sources.accumulated_depreciation = "Schedule L line 10b (from net book)";
        } else {
          out.values.accumulated_depreciation = Math.round(acc);
          out.confidence.accumulated_depreciation = 98;
          out.sources.accumulated_depreciation = "Schedule L line 10b";
        }
      } else {
        out.values.accumulated_depreciation = Math.round(acc);
        out.confidence.accumulated_depreciation = 98;
        out.sources.accumulated_depreciation = "Schedule L line 10b";
      }
    } else if (out.values.gross_fixed_assets && /less\s+accumulated/i.test(line10b) && /\b0\b/.test(line10b)) {
      out.values.accumulated_depreciation = out.values.gross_fixed_assets;
      out.confidence.accumulated_depreciation = 97;
      out.sources.accumulated_depreciation = "Schedule L line 10b (fully depreciated)";
    }
  }

  if (
    out.values.gross_fixed_assets &&
    out.values.accumulated_depreciation === undefined &&
    line10b &&
    /less\s+accumulated/i.test(line10b) &&
    /\b0\b/.test(line10b)
  ) {
    out.values.accumulated_depreciation = out.values.gross_fixed_assets;
    out.confidence.accumulated_depreciation = 97;
    out.sources.accumulated_depreciation = "Schedule L line 10b (fully depreciated)";
  }

  // Federal Asset Report grand totals — accumulated (end of year) = prior + current columns.
  // Exact identities only: the cost column must equal line 10a gross; a lone 10b token equal
  // to cost − accum is the net-book cell (OCR dropped the accum column), not accumulated dep.
  const assetReportTotals = (() => {
    for (const section of text.matchAll(/federal\s+asset\s+report[\s\S]{0,2500}/gi)) {
      for (const raw of section[0].split(/\n/)) {
        const row = raw.replace(/\s+/g, " ").trim();
        if (!/^grand totals?\b/i.test(row) || /^net\b/i.test(row)) continue;
        const nums = (row.match(/\d{1,3}(?:,\d{3})+(?:\.\d{2})?/g) ?? [])
          .map((t) => parseMoney(t))
          .filter((n): n is number => n !== null && n > 0 && isReasonableMoneyAmount(n));
        if (nums.length < 3) continue;
        const cost = Math.round(nums[0]!);
        const accum = Math.round(nums[nums.length - 2]! + nums[nums.length - 1]!);
        if (accum <= 0 || accum > cost) continue;
        return { cost, accum };
      }
    }
    return undefined;
  })();
  if (assetReportTotals) {
    const gfa = out.values.gross_fixed_assets;
    const acc = out.values.accumulated_depreciation;
    const costMatchesGross = gfa !== undefined && Math.round(gfa) === assetReportTotals.cost;
    if (costMatchesGross) {
      if (acc === undefined) {
        out.values.accumulated_depreciation = assetReportTotals.accum;
        out.confidence.accumulated_depreciation = 97;
        out.sources.accumulated_depreciation = "Federal Asset Report (prior + current)";
      } else if (Math.round(gfa! - assetReportTotals.accum) === Math.round(acc)) {
        out.values.accumulated_depreciation = assetReportTotals.accum;
        out.confidence.accumulated_depreciation = 98;
        out.sources.accumulated_depreciation =
          "Schedule L line 10b net book (accum from Federal Asset Report)";
      }
    } else if (
      gfa !== undefined &&
      Math.round(gfa) > 0 &&
      Math.round(gfa) < 10_000 &&
      assetReportTotals.cost > Math.round(gfa) &&
      String(assetReportTotals.cost).endsWith(String(Math.round(gfa)))
    ) {
      // OCR occasionally drops leading digits on Schedule L 10a (e.g. 144,991 -> 991).
      // When Federal Asset Report cost ends with that token, recover exact gross/accum pair.
      out.values.gross_fixed_assets = assetReportTotals.cost;
      out.confidence.gross_fixed_assets = Math.max(out.confidence.gross_fixed_assets ?? 98, 98);
      out.sources.gross_fixed_assets = "Schedule L line 10a (recovered from Federal Asset Report cost)";
      if (
        acc === undefined ||
        acc <= 0 ||
        (Math.round(acc) < assetReportTotals.accum && Math.round(acc) < assetReportTotals.cost)
      ) {
        out.values.accumulated_depreciation = assetReportTotals.accum;
        out.confidence.accumulated_depreciation = Math.max(
          out.confidence.accumulated_depreciation ?? 97,
          97,
        );
        out.sources.accumulated_depreciation = "Federal Asset Report (prior + current)";
      }
    } else if (gfa === undefined && acc === undefined) {
      // Schedule L 10a/10b unreadable — fill both from the asset report totals.
      out.values.gross_fixed_assets = assetReportTotals.cost;
      out.confidence.gross_fixed_assets = 95;
      out.sources.gross_fixed_assets = "Federal Asset Report cost total";
      out.values.accumulated_depreciation = assetReportTotals.accum;
      out.confidence.accumulated_depreciation = 95;
      out.sources.accumulated_depreciation = "Federal Asset Report (prior + current)";
    }
  }

  for (const row of text.split(/\n/)) {
    if (!/13a\s+intangible/i.test(row)) continue;
    if (/[|[\]~]\s*0\]?\s*$/.test(row)) {
      out.values.gross_intangible_assets = 0;
      out.confidence.gross_intangible_assets = 98;
      out.sources.gross_intangible_assets = "Schedule L line 13a (explicit zero)";
      break;
    }
    const gross = scheduleLineAmount(row);
    if (gross === undefined || !isKeepableWorksheetAmountOnLine(gross, row)) continue;
    // The amount must occupy the end cell. This rejects OCR fragments such as
    // `13a Intangible ... 71 1]`, where 71 is layout debris before a blank cell.
    if (!amountOccupiesEndCell(row, gross)) continue;
    out.values.gross_intangible_assets = Math.round(gross);
    out.confidence.gross_intangible_assets = 98;
    out.sources.gross_intangible_assets = "Schedule L line 13a";
    break;
  }

  const scanIntangibleBlock = (chunk: string, source: string) => {
    const idx = chunk.search(/13a\s+intangible/i);
    if (idx < 0) return;
    const block = chunk.slice(idx, idx + 900).split(/\n/).slice(0, 10);
    for (let i = 0; i < block.length; i++) {
      const row = block[i];
      if (i > 0 && /^14\b|other assets/i.test(row)) break;
      if (/less\s+accumulated\s+amort/i.test(row)) break;
      if (/[|[\]~]\s*0\]?\s*$/.test(row)) {
        out.values.gross_intangible_assets = 0;
        out.confidence.gross_intangible_assets = source.includes("hi-dpi") ? 96 : 97;
        out.sources.gross_intangible_assets = `${source} (explicit zero)`;
        break;
      }
      const amt = scheduleLineAmount(row);
      if (amt !== undefined && amt > 0 && amountOccupiesEndCell(row, amt)) {
        out.values.gross_intangible_assets = Math.round(amt);
        out.confidence.gross_intangible_assets = source.includes("hi-dpi") ? 96 : 97;
        out.sources.gross_intangible_assets = source;
        break;
      }
      if (
        i > 0 &&
        /^\s*\$?(?:\d{1,3}(?:,\d{3})+|\d+\.\d{2})\s*$/.test(row.trim())
      ) {
        const lone = scheduleLineAmount(row.trim());
        if (lone !== undefined && lone > 0) {
          out.values.gross_intangible_assets = Math.round(lone);
          out.confidence.gross_intangible_assets = source.includes("hi-dpi") ? 95 : 96;
          out.sources.gross_intangible_assets = `${source} (orphan amount row)`;
          break;
        }
      }
    }
  };

  if (out.values.gross_intangible_assets === undefined) {
    scanIntangibleBlock(text, "Schedule L line 13a block");
  }
  if (out.values.gross_intangible_assets === undefined) {
    for (const block of text.split(/---\s*OCR\s*PAGE\s*\d+\s*\(hi-dpi\)\s*---/i).slice(1)) {
      scanIntangibleBlock(block, "Schedule L line 13a (hi-dpi)");
      if (out.values.gross_intangible_assets !== undefined) break;
    }
  }

  for (const row of text.split(/\n/)) {
    if (!/less\s+accumulated\s+amort/i.test(row)) continue;
    const nums = substantialMoneyTokens(row);
    if (nums.length >= 2) {
      const head = Math.abs(nums[0]!);
      const tail = Math.abs(nums[nums.length - 1]!);
      if (head > 0 && head === tail) {
        out.values.gross_intangible_assets = Math.round(head);
        out.confidence.gross_intangible_assets = 97;
        out.sources.gross_intangible_assets = "Schedule L line 13a (from amort row)";
        out.values.accumulated_amortization = Math.round(head);
        out.confidence.accumulated_amortization = 98;
        out.sources.accumulated_amortization = "Schedule L less accumulated amortization";
        break;
      }
    }
    const acc = scheduleLineAmount(row);
    if (acc !== undefined && acc > 0) {
      out.values.accumulated_amortization = Math.round(acc);
      out.confidence.accumulated_amortization = 98;
      out.sources.accumulated_amortization = "Schedule L less accumulated amortization";
      if (out.values.gross_intangible_assets === undefined) {
        out.values.gross_intangible_assets = Math.round(acc);
        out.confidence.gross_intangible_assets = 96;
        out.sources.gross_intangible_assets = "Schedule L line 13a (inferred from amort)";
      }
      break;
    }
    if (
      out.values.gross_intangible_assets &&
      /\b0\b/.test(row) &&
      (acc === undefined || acc !== out.values.gross_intangible_assets)
    ) {
      out.values.accumulated_amortization = out.values.gross_intangible_assets;
      out.confidence.accumulated_amortization = 97;
      out.sources.accumulated_amortization = "Schedule L (fully amortized)";
      break;
    }
  }
  if (
    out.values.gross_intangible_assets &&
    out.values.accumulated_amortization !== undefined &&
    out.values.accumulated_amortization < out.values.gross_intangible_assets
  ) {
    const schedBlock = findScheduleLBalanceSheetBlock(text);
    let bestAmort: number | undefined;
    for (const row of schedBlock.split(/\n/)) {
      if (!/less\s+accumulated\s+amort/i.test(row)) continue;
      const acc = scheduleLineAmount(row);
      if (acc === undefined || acc <= 0) continue;
      if (bestAmort === undefined || acc > bestAmort) bestAmort = acc;
    }
    if (bestAmort !== undefined && bestAmort > out.values.accumulated_amortization) {
      out.values.accumulated_amortization = Math.round(bestAmort);
      out.confidence.accumulated_amortization = 97;
      out.sources.accumulated_amortization = "Schedule L less accumulated amortization (block scan)";
    }
  }

  findScheduleLBalanceSheetBlock(text);
  const oclCandidates = text.split(/\n/).filter((row) => {
    const line = row.replace(/\s+/g, " ").trim();
    if (!/(?:^\s*18\b|\bline\s*18\b)/i.test(line)) return false;
    if (!/curren|liab|ladies|labi|faves|abides|iavit|lavites|avices|abies|cument|liabiliti|stasmeny/i.test(line)) {
      return false;
    }
    if (
      /schedule\s*k|shareholder|box\s*17|income\s*\(los|two\s*year|comparison|ending\s+liab|enci?ng\s+liab/i.test(
        line,
      )
    ) {
      return false;
    }
    // Statement caption headers ("Statement 6 - Form 1120-S, Page 4, Schedule L,
    // Line 18 - …") carry no amount cell — only "Page N" crumbs parse as money.
    if (/schedule\s+l\W{0,15}line\s*18/i.test(line)) return false;
    return scheduleLineAmount(line) !== undefined;
  });
  oclCandidates.sort((a, b) => {
    const score = (row: string) =>
      (/attach|stmt|statemen/i.test(row) ? 4 : 0) +
      (/curren|liab/i.test(row) ? 2 : 0) +
      (/^\s*18\b|\bline\s*18\b/i.test(row) ? 3 : 0) +
      (scheduleLineAmount(row) !== undefined ? 1 : 0);
    return score(b) - score(a);
  });
  const oclLine = oclCandidates[0];
  if (oclLine) {
    const amt = scheduleLineAmount(oclLine);
    if (amt !== undefined && isKeepableWorksheetAmountOnLine(amt, oclLine)) {
      out.values.other_current_liabilities = Math.round(amt);
      out.confidence.other_current_liabilities = 97;
      out.sources.other_current_liabilities = "Schedule L line 18";
    }
  }

  const notesCandidates = text.split(/\n/).filter((row) => {
    if (/less\s*than|inless\s*then|in\s*1\s*year\b/i.test(row)) return false;
    return /1\s*year\s*or\s*more|1yearormore|yearormore|fyearormo|mortgages?.{0,12}notes.{0,12}bonds.{0,12}payable.{0,20}in/i.test(
      row,
    );
  });
  notesCandidates.sort((a, b) => {
    const score = (row: string) =>
      (/^\s*20\b/.test(row) ? 5 : 0) +
      (/1yearormore|yearormore|fyearormo/i.test(row) ? 3 : 0) +
      (scheduleLineAmount(row) !== undefined ? 2 : 0);
    return score(b) - score(a);
  });
  const notesLine = notesCandidates[0];
  if (notesLine) {
    // Caption "1 year or more" is not a dollar cell — strip before money parse.
    const notesMoneyLine = notesLine.replace(/\b1\s*year\s*or\s*more\b/gi, " ");
    const amt = scheduleLineAmount(notesMoneyLine);
    if (amt !== undefined && amt > 99 && isKeepableWorksheetAmountOnLine(amt, notesMoneyLine)) {
      out.values.notes_minus_short_term = Math.round(amt);
      out.confidence.notes_minus_short_term = 97;
      out.sources.notes_minus_short_term = "Schedule L line 20";
    }
  }

  let bestEquity: { value: number; score: number } | undefined;
  let apic: number | undefined;
  let retainedUnapprop: number | undefined;
  for (const row of text.split(/\n/)) {
    const line = row.replace(/\s+/g, " ").trim();
    if (/^\s*23\b/i.test(line) && /(?:paid.?in|p[aaoi]+(?:c|ck)?k?\s*in)\s+capital|addition.*capital/i.test(line)) {
      const commaNums = (line.replace(/(\d{1,3}),\s+(\d{3})/g, "$1,$2").match(/\d{1,3}(?:,\d{3})+/g) ?? [])
        .map((r) => parseMoney(r))
        .filter((n): n is number => n !== null && isKeepableWorksheetAmountOnLine(n, line));
      const amt = commaNums.length ? commaNums[commaNums.length - 1]! : signedScheduleAmount(line);
      if (amt !== undefined) apic = amt;
    }
    if (/^\s*25\b/i.test(line) && /unappropriated/i.test(line)) {
      const amt = signedScheduleAmount(line);
      if (amt !== undefined) retainedUnapprop = amt;
    }
  }
  if (apic !== undefined && retainedUnapprop !== undefined) {
    out.values.unclassified_equity = Math.round(apic + retainedUnapprop);
    out.confidence.unclassified_equity = 98;
    out.sources.unclassified_equity = "Schedule L lines 23+25 (APIC + retained)";
  }

  for (const row of text.split(/\n/)) {
    const line = row.replace(/\s+/g, " ").trim();
    if (/schedule\s+l\s*[=]|schedule\s+m-[23]|difference|page\s*1|screen\s+table/i.test(line)) continue;
    // Preparer packs: "BALANCE … SCHEDULE L, LINE 24, COLUMN (D) 1,234,567."
    // — not only a leading "24" form row (those are often UI crumbs).
    const colD = /schedule\s+l[,\s]+line\s*24[,\s]+column\s*\(D\)/i.test(line);
    const line24Lead = /^\s*24\b/i.test(line);
    const retained = /retained\s+e\w*rnings/i.test(line);
    if (!colD && !line24Lead && !retained) continue;
    if (/schedule\s*m-?2|line\s*24.*attach/i.test(row) && !retained && !colD) continue;
    const amt = scheduleLineAmount(row);
    if (amt === undefined || amt <= 0 || !isKeepableWorksheetAmountOnLine(amt, line)) continue;
    if (Math.abs(Math.round(amt)) <= 99) continue;
    const score =
      (colD ? 12 : 0) +
      (line24Lead ? 3 : 0) +
      (retained ? 2 : 0) +
      (/balance\s+at\s+end/i.test(line) ? 4 : 0);
    if (
      !bestEquity ||
      score > bestEquity.score ||
      (score === bestEquity.score && Math.abs(amt) > Math.abs(bestEquity.value))
    ) {
      bestEquity = { value: amt, score };
    }
  }
  if (bestEquity && out.values.unclassified_equity === undefined) {
    out.values.unclassified_equity = Math.round(bestEquity.value);
    out.confidence.unclassified_equity = 97;
    out.sources.unclassified_equity = "Schedule L line 24";
  }

  for (const row of text.split(/\n/)) {
    const line = row.replace(/\s+/g, " ").trim();
    if (/^\s*22\b/i.test(line) && /capital\s*stock/i.test(line) && !/retained|equity/i.test(line)) {
      const amt = scheduleLCapitalStockAmount(line);
      if (
        amt !== undefined &&
        (NOMINAL_PAR_AMOUNTS.has(Math.round(Math.abs(amt))) ||
          isKeepableWorksheetAmountOnLine(amt, line))
      ) {
        out.values.common_stock = Math.round(amt);
        out.confidence.common_stock = 97;
        out.sources.common_stock = "Schedule L line 22";
      }
    }
    if (/^\s*17\b/i.test(line) && /less\s+than\s+1\s+year|payable\s+in\s+less|payabl\w*less|mortgages?.{0,12}notes.{0,12}bonds.{0,12}payabl/i.test(line)) {
      const amt = scheduleLine17Amount(line);
      // Reject calendar-year crumbs mistaken as dollars (Form years ≠ line 17 LTD).
      if (amt !== undefined && isKeepableWorksheetAmountOnLine(amt, line)) {
        const prev = out.values.current_portion_ltd;
        if (prev === undefined || amt < prev) {
          out.values.current_portion_ltd = Math.round(amt);
          out.confidence.current_portion_ltd = 97;
          out.sources.current_portion_ltd = "Schedule L line 17";
        }
      }
    }
  }


  for (const stmtMatch of text.matchAll(/(?:stat(?:ement)?|stmt|tatement)\s*[\d§][\s\S]{0,2500}/gi)) {
    const block = stmtMatch[0];
    const header = block.slice(0, 320);
    if (!/line\s*18|other\s+curren|current\s+liabilit|ule\s+l.{0,40}line\s*18|liabiliti\b/i.test(header)) continue;
    const totalLine = block.split(/\n/).find((row) => /^total\b/i.test(row.replace(/\s+/g, " ").trim()));
    if (!totalLine) continue;
    const nums = lineMoneyTokens(totalLine);
    const endTotal = nums.length >= 2 ? nums[nums.length - 1] : scheduleLineAmount(totalLine);
    if (endTotal === undefined) continue;
    const schedLOcl = out.values.other_current_liabilities;
    const schedSrc = out.sources.other_current_liabilities ?? "";
    // Prefer Schedule L line 18 when it already has dollars that disagree with the statement
    // TOTAL (exact). Allow stmt overlay when Schedule L is missing or a line-number crumb.
    const schedIsCrumb =
      schedLOcl !== undefined && isFormReferenceNumber(Math.abs(schedLOcl));
    if (
      schedLOcl !== undefined &&
      !schedIsCrumb &&
      /schedule\s+l\s+line\s*18/i.test(schedSrc) &&
      Math.round(endTotal) !== Math.round(schedLOcl)
    ) {
      continue;
    }
    setStmtTotal(out, "other_current_liabilities", endTotal, "Statement (Line 18) total");
    break;
  }

  let best14: { value: number; score: number } | undefined;
  for (const row of text.split(/\n/)) {
    if (!/\b14\b/i.test(row) || /current\s+asset/i.test(row)) continue;
    if (!/other\s+ass|ot\w*\s+ass|ofer\s+ass|ter\s+ass|stmt\s*4/i.test(row)) continue;
    const amt = scheduleLineAmount(row);
    if (amt === undefined) continue;
    // A blank Schedule L row often yields its leading IRS line number as the only
    // numeric token. Keep explicit zero or keepable dollars, never the row number.
    if (amt !== 0 && !isKeepableWorksheetAmountOnLine(amt, row)) continue;
    const score =
      (/stmt|attach|statemen/i.test(row) ? 2 : 0) +
      (/\b14\b/i.test(row) ? 2 : 0) +
      (/other\s+ass/i.test(row) ? 1 : 0) +
      (amt === 0 ? 0 : isKeepableWorksheetAmountOnLine(amt, row) ? 1 : -2);
    if (!best14 || score > best14.score) best14 = { value: amt, score };
  }
  if (best14 && best14.value > 0) {
    out.values.other_assets = Math.round(best14.value);
    out.confidence.other_assets = 97;
    out.sources.other_assets = "Schedule L line 14";
  } else if (best14 && best14.value === 0) {
    out.values.other_assets = 0;
    out.confidence.other_assets = 96;
    out.sources.other_assets = "Schedule L line 14 (zero)";
  }

  for (const stmtMatch of text.matchAll(/(?:stat(?:ement)?|stmt|tatement)\s*[\d§][\s\S]{0,1500}/gi)) {
    const block = stmtMatch[0];
    const header = block.slice(0, 320);
    if (!/line\s*14|other\s+ass/i.test(header) || /current\s+asset/i.test(header)) continue;
    const totalLine = block.split(/\n/).find((row) => /^total\b/i.test(row.replace(/\s+/g, " ").trim()));
    if (!totalLine) continue;
    const nums = lineMoneyTokens(totalLine);
    const endTotal = nums.length >= 2 ? nums[nums.length - 1] : scheduleLineAmount(totalLine);
    if (endTotal !== undefined) {
      setStmtTotal(out, "other_assets", endTotal, "Statement (Line 14) total");
      break;
    }
  }

  const line6 = text.split(/\n/).find((row) => {
    const line = row.replace(/\s+/g, " ").trim();
    if (!/^\s*6\b/i.test(line)) return false;
    const amt = scheduleLineAmount(line);
    if (amt === undefined) return false;
    return /stmt\s*4|other\s+curren|curent\s+ass|asses|romm|prepaid|promm|oberaume/i.test(line);
  });
  if (line6) {
    const amt = scheduleLineAmount(line6);
    if (amt !== undefined) {
      out.values.other_current_assets = Math.round(amt);
      out.confidence.other_current_assets = 97;
      out.sources.other_current_assets = "Schedule L line 6";
    }
  }
  const stmt5Block = text.match(/stat(?:ement)?\s*5[\s\S]{0,1800}/i)?.[0];
  if (stmt5Block && /line\s*18|liabiliti\b|c\s+t\s+liabi/i.test(stmt5Block)) {
    const totalLine = stmt5Block.split(/\n/).find((row) => /^total\b/i.test(row.replace(/\s+/g, " ").trim()));
    if (totalLine) {
      const nums = lineMoneyTokens(totalLine);
      const endTotal = nums.length >= 2 ? nums[nums.length - 1] : scheduleLineAmount(totalLine);
      if (endTotal !== undefined) {
        const schedLOcl = out.values.other_current_liabilities;
        const schedIsCrumb =
          schedLOcl !== undefined && isFormReferenceNumber(Math.abs(schedLOcl));
        if (schedLOcl === undefined || schedIsCrumb) {
          setStmtTotal(out, "other_current_liabilities", endTotal, "Statement 5 total");
        }
      }
    }
  }

  if (out.values.other_current_liabilities === undefined) {
    const line18Stmt = text.match(
      /line\s*18[^\n]{0,100}liabi[\s\S]{0,2000}?\btotal\b[^\n]*/i,
    )?.[0];
    if (line18Stmt) {
      const totalLine = line18Stmt.split(/\n/).find((row) => /^total\b/i.test(row.replace(/\s+/g, " ").trim()));
      if (totalLine) {
        const nums = lineMoneyTokens(totalLine);
        const endTotal = nums.length >= 2 ? nums[nums.length - 1] : scheduleLineAmount(totalLine);
        if (endTotal !== undefined && isKeepableWorksheetAmountOnLine(endTotal, totalLine)) {
          const schedLOcl = out.values.other_current_liabilities;
          const schedIsCrumb =
            schedLOcl !== undefined && isFormReferenceNumber(Math.abs(schedLOcl));
          if (schedLOcl === undefined || schedIsCrumb) {
            setStmtTotal(out, "other_current_liabilities", endTotal, "Statement (Line 18) total scan");
          }
        }
      }
    }
  }

  if (out.values.other_assets && out.values.other_current_assets === out.values.other_assets) {
    delete out.values.other_current_assets;
    delete out.confidence.other_current_assets;
    delete out.sources.other_current_assets;
  }

  return out;
}

/** Stmt 5 / Schedule L line 18 attachment total — end column on "Total" row after Line 18 header. */
export function scanStatementLine18Total(text: string): number | undefined {
  const chunk = text.match(/line\s*18[^\n]{0,120}liabi[\s\S]{0,3000}/i)?.[0];
  if (!chunk) return undefined;
  const totalLine = chunk.split(/\n/).find((row) => /^total\b/i.test(row.replace(/\s+/g, " ").trim()));
  if (!totalLine) return undefined;
  const nums = lineMoneyTokens(totalLine);
  const endTotal = nums.length >= 2 ? nums[nums.length - 1] : scheduleLineAmount(totalLine);
  return endTotal !== undefined && isKeepableWorksheetAmountOnLine(endTotal, totalLine)
    ? Math.round(endTotal)
    : undefined;
}
