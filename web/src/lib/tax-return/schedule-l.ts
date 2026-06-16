import type { FieldExtraction } from "./form-anchors";
import { lineMoneyTokens, scheduleLineAmount, substantialMoneyTokens } from "./money";

const STMT_AUTH_CONF = 99;

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

/** Schedule L row scanners + Stmt 4/5 totals (structure only, no dollar thresholds). */
export function extractScheduleLFields(text: string): FieldExtraction {
  const out: FieldExtraction = { values: {}, confidence: {}, sources: {} };

  let best10a: { value: number; score: number } | undefined;
  for (const row of text.split(/\n/)) {
    if (!/\b10a\s+build/i.test(row) && !/other depreciable assets/i.test(row)) continue;
    const gross = scheduleLineAmount(row);
    if (gross === undefined || gross <= 0) continue;
    const score =
      (/\b10a\b/i.test(row) ? 4 : 0) +
      (gross >= 1000 ? 2 : 0) +
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
    const acc = scheduleLineAmount(line10b);
    if (acc !== undefined) {
      out.values.accumulated_depreciation = Math.round(acc);
      out.confidence.accumulated_depreciation = 98;
      out.sources.accumulated_depreciation = "Schedule L line 10b";
    } else if (out.values.gross_fixed_assets && /less\s+accumulated/i.test(line10b) && /\b0\b/.test(line10b)) {
      out.values.accumulated_depreciation = out.values.gross_fixed_assets;
      out.confidence.accumulated_depreciation = 97;
      out.sources.accumulated_depreciation = "Schedule L line 10b (fully depreciated)";
    }
  }

  if (
    out.values.gross_fixed_assets &&
    (out.values.accumulated_depreciation ?? 0) < out.values.gross_fixed_assets &&
    line10b &&
    /less\s+accumulated/i.test(line10b)
  ) {
    const acc = scheduleLineAmount(line10b);
    if (acc === undefined || acc < out.values.gross_fixed_assets) {
      out.values.accumulated_depreciation = out.values.gross_fixed_assets;
      out.confidence.accumulated_depreciation = 97;
      out.sources.accumulated_depreciation = "Schedule L line 10b (fully depreciated)";
    }
  }

  for (const row of text.split(/\n/)) {
    if (!/13a\s+intangible/i.test(row)) continue;
    const gross = scheduleLineAmount(row);
    if (gross === undefined) continue;
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
      const amt = scheduleLineAmount(row);
      if (amt !== undefined && amt > 0) {
        out.values.gross_intangible_assets = Math.round(amt);
        out.confidence.gross_intangible_assets = source.includes("hi-dpi") ? 96 : 97;
        out.sources.gross_intangible_assets = source;
        break;
      }
      if (i > 0 && /^\s*\d[\d,]{5,}\s*$/.test(row.trim())) {
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
    out.values.accumulated_amortization < out.values.gross_intangible_assets * 0.95
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
    if (!/curren|liab|ladies|labi|faves|abides|iavit|lavites|avices|ladies/i.test(line)) return false;
    if (
      /schedule\s*k|shareholder|box\s*17|125,?925|income\s*\(los|two\s*year|comparison|ending\s+liab|enci?ng\s+liab/i.test(
        line,
      )
    ) {
      return false;
    }
    return scheduleLineAmount(line) !== undefined;
  });
  oclCandidates.sort((a, b) => {
    const score = (row: string) => {
      const amt = scheduleLineAmount(row) ?? 0;
      return (
        (/attach|stmt|statemen/i.test(row) ? 4 : 0) +
        (/curren|liab/i.test(row) ? 2 : 0) +
        Math.min(3, Math.log10(Math.max(amt, 1)))
      );
    };
    return score(b) - score(a);
  });
  const oclLine = oclCandidates[0];
  if (oclLine) {
    const amt = scheduleLineAmount(oclLine);
    if (amt !== undefined) {
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
    const amt = scheduleLineAmount(notesLine);
    if (amt !== undefined) {
      out.values.notes_minus_short_term = Math.round(amt);
      out.confidence.notes_minus_short_term = 97;
      out.sources.notes_minus_short_term = "Schedule L line 20";
    }
  }

  let bestEquity: { value: number; score: number } | undefined;
  for (const row of text.split(/\n/)) {
    if (!/(?:^\s*24\b|retained\s+e\w*rnings)/i.test(row.replace(/\s+/g, " ").trim())) continue;
    if (/schedule\s*m-?2|line\s*24.*attach/i.test(row) && !/retained/i.test(row)) continue;
    const amt = scheduleLineAmount(row);
    if (amt === undefined || amt <= 0) continue;
    const score = (/^\s*24\b/i.test(row) ? 3 : 1) + Math.min(3, Math.log10(amt));
    if (!bestEquity || score > bestEquity.score) bestEquity = { value: amt, score };
  }
  if (bestEquity) {
    out.values.unclassified_equity = Math.round(bestEquity.value);
    out.confidence.unclassified_equity = 97;
    out.sources.unclassified_equity = "Schedule L line 24";
  }


  for (const stmtMatch of text.matchAll(/(?:statement|stmt|tatement)\s*[\d§][\s\S]{0,2500}/gi)) {
    const block = stmtMatch[0];
    const header = block.slice(0, 320);
    if (!/line\s*18|other\s+curren|current\s+liabilit|ule\s+l.{0,40}line\s*18/i.test(header)) continue;
    const totalLine = block.split(/\n/).find((row) => /^total\b/i.test(row.replace(/\s+/g, " ").trim()));
    if (!totalLine) continue;
    const nums = lineMoneyTokens(totalLine);
    const endTotal = nums.length >= 2 ? nums[nums.length - 1] : scheduleLineAmount(totalLine);
    if (endTotal !== undefined) {
      setStmtTotal(out, "other_current_liabilities", endTotal, "Statement (Line 18) total");
      break;
    }
  }

  let best14: { value: number; score: number } | undefined;
  for (const row of text.split(/\n/)) {
    if (!/\b14\b/i.test(row) || /current\s+asset/i.test(row)) continue;
    if (!/other\s+ass|ot\w*\s+ass|ofer\s+ass|ter\s+ass|stmt\s*4/i.test(row)) continue;
    const amt = scheduleLineAmount(row);
    if (amt === undefined) continue;
    const score =
      (/stmt|attach|statemen/i.test(row) ? 2 : 0) + (amt > 0 ? Math.min(3, Math.log10(amt)) : -2);
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

  for (const stmtMatch of text.matchAll(/(?:statement|stmt|tatement)\s*[\d§][\s\S]{0,1500}/gi)) {
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
  const stmt5Block = text.match(/statement\s*5[\s\S]{0,1800}/i)?.[0];
  if (stmt5Block && /other\s+curren\w*\s+liabilit|curent\s+labi/i.test(stmt5Block)) {
    const totalLine = stmt5Block.split(/\n/).find((row) => /^total\b/i.test(row.replace(/\s+/g, " ").trim()));
    if (totalLine) {
      const nums = lineMoneyTokens(totalLine);
      const endTotal = nums.length >= 2 ? nums[nums.length - 1] : scheduleLineAmount(totalLine);
      setStmtTotal(out, "other_current_liabilities", endTotal, "Statement 5 total");
    }
  }

  if (out.values.other_assets && out.values.other_current_assets === out.values.other_assets) {
    delete out.values.other_current_assets;
    delete out.confidence.other_current_assets;
    delete out.sources.other_current_assets;
  }

  return out;
}
