import {
  bracketLineAmount,
  formLineAmount,
  isForm1120Line,
  isFormReferenceNumber,
  isHistoricalGrossReceiptsLine,
  isKeepableWorksheetAmountOnLine,
  isReasonableMoneyAmount,
  lineMoneyTokens,
  lineMaxAmount,
  lineTailAmount,
  parseMoney,
  scheduleLineAmount,
  substantialMoneyTokens,
  unambiguousFormLineAmount,
  unambiguousFormLineAmountForTag,
} from "./money";
import { applyLineScans } from "./form-line-scan";
import { extractScheduleLFields, scheduleLLine1CashAmount } from "./schedule-l";
import { scanStateBusinessScheduleDeductions } from "./state-business-schedule";
import type { TaxFormKind } from "./detect-tax-form";
import { detectTaxForm } from "./detect-tax-form";
import { extractForm1041Anchors } from "./form-1041-anchors";

/** Prefer OCR for labeled return pages — embedded PDF text often has dot-leader forms that mis-parse. */
export function formAnchorSourceText(embeddedText: string, ocrText: string, kind: TaxFormKind): string {
  const ocrHas =
    kind === "1120"
      ? /u\.s\.\s*corporation\s+income\s+tax\s+return/i.test(ocrText) &&
        /gross receipts or sales/i.test(ocrText)
      : kind === "1120-s"
        ? /(?:s\s+corporation|1120-?s|s\.?\s*,?\s*corp)/i.test(ocrText) &&
          /gross receipts or sales|ross receipts/i.test(ocrText)
        : kind === "1065"
          ? /form\s+1065|partnership\s+income/i.test(ocrText)
          : kind === "1041"
            ? /form\s+1041|estates?\s+and\s+trusts/i.test(ocrText)
            : false;
  if (ocrHas && ocrText.length >= 5000) return ocrText;
  return `${embeddedText}\n${ocrText}`;
}

export type FieldExtraction = {
  values: Record<string, number>;
  confidence: Record<string, number>;
  sources: Record<string, string>;
};

const ANCHOR_CONF = 98;

function setField(
  out: FieldExtraction,
  id: string,
  value: number | undefined,
  source: string,
  conf = ANCHOR_CONF,
): void {
  if (value === undefined || isFormReferenceNumber(Math.abs(value))) return;
  const prev = out.confidence[id] ?? 0;
  if (prev > conf) return;
  const rounded = Math.round(value);
  // Equal-confidence duplicate sales reads must agree exactly. The old "keep the
  // larger value" rule let a lossy OCR digit concatenation overwrite a correct line.
  if (
    id === "sales" &&
    out.values.sales !== undefined &&
    rounded !== out.values.sales &&
    conf <= (out.confidence.sales ?? 0)
  ) {
    return;
  }
  out.values[id] = rounded;
  out.confidence[id] = conf;
  out.sources[id] = source;
}

function isCogsLine(line: string): boolean {
  return /cost\s*of\s*goods|c\.?o\.?g|costof\s*goods|goods\s*soid/i.test(line);
}

/** OCR sometimes splits the last group: `1,234,5 678` → `1234678` (drop spurious middle digit). */
function repairOcrSplitThousands(s: string): string {
  return s.replace(/(\d{1,3}(?:,\d{3})),(\d)\s+(\d{3})\b/g, (_, prefix, _middle, tail) => {
    return prefix.replace(/,/g, "") + tail;
  });
}

/** Keepable Form sales token — form-ref / year / line-number structure, not $50k floors. */
function keepableSalesAmount(n: number): boolean {
  const abs = Math.abs(Math.round(n));
  if (abs < 1 || !isReasonableMoneyAmount(abs)) return false;
  if (isFormReferenceNumber(abs)) return false;
  if (abs >= 1990 && abs <= 2035) return false;
  // Form line crumbs (1–99) are never gross receipts.
  if (abs <= 99) return false;
  return true;
}

function salesFromLine(line: string): number | undefined {
  if (/balance.*subtract.*line\s*1b.*line\s*1[ac]/i.test(line)) {
    const amt = lineMaxAmount(line) ?? scheduleLineAmount(line);
    if (amt !== undefined && keepableSalesAmount(amt)) return amt;
  }

  if (!/gross\s+receipt|gross receipts or sales|line\s+1c|\b1c\b/i.test(line)) {
    const tagged = bracketLineAmount(line, "1c");
    if (tagged !== undefined && keepableSalesAmount(tagged)) return tagged;
    const one = unambiguousFormLineAmount(line);
    if (one !== undefined && keepableSalesAmount(one)) return one;
    const fallback = lineMaxAmount(line) ?? consensusFromLine(line);
    return fallback !== undefined && keepableSalesAmount(fallback) ? fallback : undefined;
  }

  const repaired = repairOcrSplitThousands(line);
  // Explicit Form result cell wins. This handles damaged first-column OCR such as
  // `1 7 027 ’ 658 ... [1c] 1 027 658` without concatenating unrelated digits.
  const resultCell = bracketLineAmount(repaired, "1c");
  if (resultCell !== undefined && keepableSalesAmount(resultCell)) return resultCell;

  // Prefer comma-grouped money runs on the gross-receipts caption (layout grammar).
  const commaAmounts = (repaired.match(/\d{1,3}(?:,\d{3})+(?:\.\d{2})?\b/g) ?? [])
    .map((r) => parseMoney(r))
    .filter((n): n is number => n !== null && keepableSalesAmount(n));
  if (commaAmounts.length) return Math.max(...commaAmounts);

  const labelMatch = repaired.match(/gross\s+receipts?\s+or\s*sales/i);
  if (labelMatch) {
    const segment = repaired.slice(labelMatch.index! + labelMatch[0].length);
    const moneyRun = segment.match(/\d[\d,]{4,}/);
    if (moneyRun) {
      const joined = moneyRun[0].replace(/[^\d]/g, "");
      const n = Number(joined);
      if (Number.isFinite(n) && keepableSalesAmount(n)) return n;
    }
  }

  const one = unambiguousFormLineAmount(repaired);
  if (one !== undefined && keepableSalesAmount(one)) return one;

  const tail = lineMaxAmount(repaired) ?? consensusFromLine(repaired);
  if (tail !== undefined && keepableSalesAmount(tail)) return tail;
  return undefined;
}

function form1120Line5Interest(line: string): number | undefined {
  if (!/interest|ineest/i.test(line)) return undefined;
  if (
    /\[\s*1[89]\b|\b1[89]\b[^\d]{0,20}interest|\binterest[^\d]{0,20}\[\s*1[89]\b/i.test(line)
  ) {
    return undefined;
  }
  const pipe = line.match(/(?:^|[\s|])\s*5\s*\|[^\d]{0,80}(\d{1,3}(?:,\d{3})*|\d+)/i);
  if (pipe?.[1]) {
    const n = parseMoney(pipe[1]);
    // Form line 5 interest income — keepable token; reject the bare line tag itself.
    if (n !== null && isReasonableMoneyAmount(n) && Math.abs(n) !== 5 && !isFormReferenceNumber(Math.abs(n))) {
      return n;
    }
  }
  if (isForm1120Line(line, 5) && !/expense|investment/i.test(line)) {
    const oi =
      unambiguousFormLineAmountForTag(line, "5") ?? formLineAmount(line, "5") ?? scheduleLineAmount(line);
    if (
      oi !== undefined &&
      isReasonableMoneyAmount(oi) &&
      Math.abs(oi) !== 5 &&
      !isFormReferenceNumber(Math.abs(oi))
    ) {
      return oi;
    }
  }
  return undefined;
}

function consensusFromLine(line: string): number | undefined {
  const nums = lineMoneyTokens(line);
  if (!nums.length) return undefined;
  const counts = new Map<number, number>();
  for (const n of nums) counts.set(n, (counts.get(n) ?? 0) + 1);
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || Math.abs(b[0]) - Math.abs(a[0]))[0]?.[0];
}

function mergeExtractions(base: FieldExtraction, incoming: FieldExtraction): void {
  for (const [id, value] of Object.entries(incoming.values)) {
    const conf = incoming.confidence[id] ?? 0;
    const prev = base.confidence[id] ?? 0;
    if (conf >= prev) {
      base.values[id] = value;
      base.confidence[id] = conf;
      if (incoming.sources[id]) base.sources[id] = incoming.sources[id];
    }
  }
}

/**
 * Federal return page 1 + Schedule L/B anchors from labeled line numbers in OCR text.
 * Supports 1120-S, 1120 (C-corp), 1065 (shared page-1 patterns), and routes 1041 separately.
 */
export function extractFormAnchors(text: string, formKind?: TaxFormKind): FieldExtraction {
  const kind = formKind ?? detectTaxForm(text).kind;
  if (kind === "1041") return extractForm1041Anchors(text);
  return extractForm1120StyleAnchors(text, kind);
}

function isComparisonWorksheetLine(line: string, text: string, lineIdx: number): boolean {
  const ctx = text.slice(Math.max(0, lineIdx - 800), lineIdx + line.length + 200);
  return /two\s*year\s*comparison|comparison\s+worksheet|t\w{0,3}\s*y\s*ear\s*\w{0,6}\s*omparison/i.test(
    ctx,
  );
}

function extractForm1120StyleAnchors(text: string, formKind: TaxFormKind): FieldExtraction {
  const out: FieldExtraction = { values: {}, confidence: {}, sources: {} };
  const inventoryCandidates: number[] = [];

  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    const lineIdx = text.indexOf(rawLine);
    if (!line || isHistoricalGrossReceiptsLine(line)) continue;
    if (isComparisonWorksheetLine(line, text, lineIdx >= 0 ? lineIdx : 0)) continue;
    if (/form 1120/i.test(line) && !/schedule\s*l|stmt\s*\d|statement\s*\d/i.test(line)) continue;

    const salesSource =
      formKind === "1120" ? "Form 1120 line 1c" : "Form 1120-S line 1c";
    const cogsSource = formKind === "1120" ? "Form 1120 line 2" : "Form 1120-S line 2";

    if (
      /\[1c\b|\[1c[\]| ]|gross receipts or sales|\b1a\b.*gross|\bgoss\s+(rece|csr|receipts)|balance.*subtract.*line\s*1b.*line\s*1[ac]/i.test(
        line,
      )
    ) {
      setField(out, "sales", salesFromLine(line), salesSource);
    }
    if (
      (isForm1120Line(line, 2) || /\[\s*2\s*\]/i.test(line)) &&
      isCogsLine(line) &&
      !/gross profit/i.test(line) &&
      // State / Schedule COGS worksheets reuse "line 2" captions — not Form page-1.
      !/schedule\s+cogs/i.test(line)
    ) {
      const cogs = formLineAmount(line, "2");
      if (cogs !== undefined) setField(out, "cogs", cogs, cogsSource);
    }
    if (formKind === "1120-s" || formKind === "1065") {
      if (isForm1120Line(line, 7) && /compensation of officers/i.test(line)) {
        const amt = scheduleLineAmount(line) ?? lineTailAmount(line);
        if (amt !== undefined && substantialMoneyTokens(line).length > 0) {
          setField(out, "officer_compensation", amt, "Form 1120-S line 7");
        }
      }
      if (isForm1120Line(line, 8) && /salaries and wages/i.test(line)) {
        setField(out, "salaries_wages", scheduleLineAmount(line) ?? lineTailAmount(line), "Form 1120-S line 8");
      }
      if (
        isForm1120Line(line, 11) &&
        (/\brents?\b/i.test(line) || /\brens\b/i.test(line) || /\brent\b/i.test(line))
      ) {
        setField(out, "rent", scheduleLineAmount(line) ?? lineTailAmount(line), "Form 1120-S line 11");
      }
      if (isForm1120Line(line, 12) && /taxes\s*and\s*lic/i.test(line)) {
        setField(out, "taxes_licenses", scheduleLineAmount(line) ?? lineTailAmount(line), "Form 1120-S line 12");
      }
      if (
        isForm1120Line(line, 13) &&
        /interest/i.test(line) &&
        !/interest\s+income|investment|tax-exempt|business interest/i.test(line)
      ) {
        setField(out, "interest_expense", scheduleLineAmount(line) ?? lineTailAmount(line), "Form 1120-S line 13");
      }
      if (isForm1120Line(line, 14) && /depreciation/i.test(line) && !/accum|schedule\s*l|post-1986/i.test(line)) {
        // Multi-column bleed (e.g. "14 DEPRECIATION 3,035 2,665 5,700") is not a Form cell —
        // leave unset so NET DEPRECIATION / reconcile can win.
        const dep = unambiguousFormLineAmount(line);
        if (dep !== undefined) {
          setField(out, "depreciation", dep, "Form 1120-S line 14");
        } else if (!substantialMoneyTokens(line).length) {
          setField(out, "depreciation", 0, "Form 1120-S line 14", 96);
        }
      }
      if (/(\b16\b|\[16\b)/i.test(line) && /advertis/i.test(line)) {
        setField(out, "advertising", scheduleLineAmount(line) ?? lineTailAmount(line), "Form 1120-S line 16");
      }
    }
    if (formKind === "1120" || formKind === "unknown") {
      if (isForm1120Line(line, 12) && /compensation of officers/i.test(line)) {
        const amt = formLineAmount(line, "12") ?? scheduleLineAmount(line);
        if (amt !== undefined && substantialMoneyTokens(line).length > 0) {
          setField(out, "officer_compensation", amt, "Form 1120 line 12");
        }
      }
      if (isForm1120Line(line, 5) && /interest/i.test(line) && !/expense|investment/i.test(line)) {
        const oi = form1120Line5Interest(line);
        if (oi !== undefined) setField(out, "other_income", oi, "Form 1120 line 5 interest income", 99);
      }
      if (isForm1120Line(line, 31) && /total\s+tax/i.test(line)) {
        const tax = formLineAmount(line, "31") ?? scheduleLineAmount(line);
        if (tax !== undefined && isKeepableWorksheetAmountOnLine(tax, line)) {
          setField(out, "taxes_paid", tax, "Form 1120 line 31 total tax", 97);
        } else if (/\|\s*31\s*\|[^\d]*\b0\b/.test(line) || /\b31\b[^\d]{0,20}\b0\b/.test(line)) {
          setField(out, "taxes_paid", 0, "Form 1120 line 31 total tax (zero)", 97);
        }
      }
      if (isForm1120Line(line, 13) && /salaries and wages/i.test(line)) {
        setField(out, "salaries_wages", scheduleLineAmount(line) ?? lineTailAmount(line), "Form 1120 line 13");
      }
      if (
        (isForm1120Line(line, 16) || /\|\s*16\b|\bT\s*\|\s*16\b/i.test(line)) &&
        /\brents?\b/i.test(line)
      ) {
        setField(out, "rent", formLineAmount(line, "16") ?? scheduleLineAmount(line) ?? lineTailAmount(line), "Form 1120 line 16");
      }
      if (
        (isForm1120Line(line, 17) || /\|\s*17\b|\bT\s*\|\s*17\b/i.test(line)) &&
        /taxes\s*and\s*lic/i.test(line)
      ) {
        setField(out, "taxes_licenses", formLineAmount(line, "17") ?? scheduleLineAmount(line) ?? lineTailAmount(line), "Form 1120 line 17");
      }
      if (isForm1120Line(line, 18) && /interest/i.test(line) && !/investment/i.test(line)) {
        setField(out, "interest_expense", scheduleLineAmount(line) ?? lineTailAmount(line), "Form 1120 line 18");
      }
      if (isForm1120Line(line, 20) && /depreciation/i.test(line) && !/accum/i.test(line)) {
        const dep = unambiguousFormLineAmount(line);
        if (dep !== undefined) setField(out, "depreciation", dep, "Form 1120 line 20");
      }
      if (isForm1120Line(line, 22) && /advertis/i.test(line)) {
        setField(out, "advertising", scheduleLineAmount(line) ?? lineTailAmount(line), "Form 1120 line 22");
      }
      if (isForm1120Line(line, 10) && /other\s+income/i.test(line)) {
        const amt = scheduleLineAmount(line) ?? lineTailAmount(line);
        if (amt !== undefined && isKeepableWorksheetAmountOnLine(amt, line)) {
          setField(out, "other_income", amt, "Form 1120 line 10");
        }
      }
    }
    if (/^1\s*cash\b/i.test(line)) {
      const cashAmt = scheduleLLine1CashAmount(line) ?? scheduleLineAmount(line) ?? lineTailAmount(line);
      setField(out, "cash", cashAmt, "Schedule L line 1");
    }
    if (
      /inventor/i.test(line) &&
      /\b3\b/i.test(line) &&
      !/beginning|end of year|lifo|closing|form\s*1125/i.test(line)
    ) {
      const amt = scheduleLineAmount(line) ?? lineTailAmount(line);
      if (amt !== undefined) inventoryCandidates.push(Math.round(amt));
    }
    if (
      (/^\s*6\b/i.test(line) || /other\s+curren/i.test(line)) &&
      /curren\w*\s+ass|ment\s+asel|ronases|curent\s+ass|asses|romm|stmt\s*4/i.test(line) &&
      !/\b14\b.*other\s+ass/i.test(line)
    ) {
      const amt = scheduleLineAmount(line);
      if (amt === 0 || (amt !== undefined && isKeepableWorksheetAmountOnLine(amt, line))) {
        setField(out, "other_current_assets", amt, "Schedule L line 6");
      }
    }
    if (
      /\b14\b/i.test(line) &&
      !/current\s+asset/i.test(line) &&
      /other\s+ass|ot\w*\s+ass|ofer\s+ass|ter\s+ass|stmt\s*4/i.test(line)
    ) {
      const amt = scheduleLineAmount(line);
      // A blank row may expose only the leading IRS line number. Explicit zero and
      // keepable worksheet dollars are valid; the row number itself is not.
      if (amt === 0 || (amt !== undefined && isKeepableWorksheetAmountOnLine(amt, line))) {
        setField(out, "other_assets", amt, "Schedule L line 14");
      }
    }
  }

  if (inventoryCandidates.length) {
    const counts = new Map<number, number>();
    for (const v of inventoryCandidates) counts.set(v, (counts.get(v) ?? 0) + 1);
    const [value] = Array.from(counts.entries()).sort(
      (a, b) => b[1] - a[1] || Math.abs(b[0]) - Math.abs(a[0]),
    )[0]!;
    setField(out, "inventory", value, "Schedule L line 3");
  }

  mergeExtractions(
    out,
    applyLineScans(text, [
      { id: "taxes_licenses", re: /taxes\s*and\s*licen/i, source: "Form 1120-S line 12 (tail scan)", conf: 99 },
      { id: "rent", re: /\brents\b|\brens\b|\w{0,2}ires\b/i, source: "Form 1120-S line 11 (tail scan)", conf: 99 },
      {
        id: "cogs",
        re: /(?:\bc\s*)?ost\s+of\s*goods|cost\s*of\s*goods|costof\s*goods|goods\s*soid/i,
        source: "Form 1120-S line 2 (tail scan)",
        conf: 98,
      },
      { id: "other_current_liabilities", re: /other\s+curren\w*\s+liabilit|curent\s+labi|liabiliti\b/i, source: "Schedule L line 18 (tail scan)", conf: 98 },
      {
        id: "notes_minus_short_term",
        re: /1\s*year\s*or\s*more|1yearormore|yearormore|fyearormo|payable.{0,16}in\s*1\s*year/i,
        source: "Schedule L line 20 (tail scan)",
        conf: 97,
      },
      { id: "unclassified_equity", re: /schedule\s+l[,\s]+line\s*24[,\s]+column\s*\(D\)|24\s+retained|retained\s+e\w*rnings/i, source: "Schedule L line 24 (tail scan)", conf: 97 },
    ]),
  );

  mergeExtractions(out, extractScheduleLFields(text));
  mergeExtractions(out, scanStateBusinessScheduleDeductions(text));
  mergeExtractions(out, scanOrphanPage1DeductionAmounts(extractFormPage1Block(text, formKind)));

  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!/(?:^\s*18\b|\b18\b.{0,40}other\s+curren)/i.test(line) || !/stmt\s*3/i.test(line)) continue;
    const amt = scheduleLineAmount(line) ?? lineTailAmount(line);
    if (amt === undefined) continue;
    setField(out, "short_term_debt", amt, "Schedule L line 18 (Stmt 3)", 99);
    if (out.values.other_current_liabilities === amt) {
      delete out.values.other_current_liabilities;
      delete out.confidence.other_current_liabilities;
      delete out.sources.other_current_liabilities;
    }
  }

  const otherIncomeHit = scanFormLine5OtherIncome(extractFormPage1Block(text));
  if (otherIncomeHit !== undefined) {
    setField(out, "other_income", otherIncomeHit, "Form 1120-S line 5", 97);
  }

  const formPage1 = extractFormPage1Block(text, formKind);
  for (const rawLine of formPage1.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (
      /\[1c\b|\[1c[\]| ]|gross receipts or sales|\b1a\b.*gross|\bgoss\s+(rece|csr|receipts)|balance.*subtract.*line\s*1b.*line\s*1[ac]/i.test(
        line,
      )
    ) {
      const sales = salesFromLine(line);
      if (sales !== undefined) {
        const src =
          formKind === "1120"
            ? "Form 1120 line 1c (page 1 block)"
            : "Form 1120-S line 1c (page 1 block)";
        setField(out, "sales", sales, src, 99);
      }
    }
    if (formKind === "1120") {
      if (isForm1120Line(line, 12) && /compensation of officers/i.test(line)) {
        const amt = formLineAmount(line, "12") ?? scheduleLineAmount(line);
        if (amt !== undefined && substantialMoneyTokens(line).length > 0) {
          setField(out, "officer_compensation", amt, "Form 1120 line 12 (page 1 block)", 99);
        }
      }
      if (isForm1120Line(line, 17) && /taxes\s*and\s*lic/i.test(line)) {
        setField(out, "taxes_licenses", formLineAmount(line, "17") ?? scheduleLineAmount(line), "Form 1120 line 17 (page 1 block)", 99);
      }
      if (isForm1120Line(line, 16) && /\brents?\b/i.test(line) && !/gross\s+profit|total\s+income/i.test(line)) {
        setField(out, "rent", formLineAmount(line, "16") ?? scheduleLineAmount(line), "Form 1120 line 16 (page 1 block)", 99);
      }
      if (isForm1120Line(line, 18) && /interest/i.test(line) && !/investment/i.test(line)) {
        setField(out, "interest_expense", formLineAmount(line, "18") ?? scheduleLineAmount(line), "Form 1120 line 18 (page 1 block)", 99);
      }
      if (isForm1120Line(line, 20) && /depreciation/i.test(line) && !/accum/i.test(line)) {
        const dep = unambiguousFormLineAmountForTag(line, "20");
        if (dep !== undefined) {
          setField(out, "depreciation", dep, "Form 1120 line 20 (page 1 block)", 99);
        }
      }
      if (isForm1120Line(line, 22) && /advertis/i.test(line)) {
        setField(out, "advertising", formLineAmount(line, "22") ?? scheduleLineAmount(line), "Form 1120 line 22 (page 1 block)", 99);
      }
      if (isForm1120Line(line, 5) && /^\s*5\b.*interest/i.test(line) && !/expense/i.test(line)) {
        const oi = form1120Line5Interest(line);
        if (oi !== undefined) setField(out, "other_income", oi, "Form 1120 line 5 interest income", 99);
      }
      if (isForm1120Line(line, 31) && /total\s+tax/i.test(line)) {
        const tax = formLineAmount(line, "31") ?? scheduleLineAmount(line);
        if (tax !== undefined && isKeepableWorksheetAmountOnLine(tax, line)) {
          setField(out, "taxes_paid", tax, "Form 1120 line 31 total tax", 97);
        } else if (/\|\s*31\s*\|[^\d]*\b0\b/.test(line) || /\b31\b[^\d]{0,20}\b0\b/.test(line)) {
          setField(out, "taxes_paid", 0, "Form 1120 line 31 total tax (zero)", 97);
        }
      }
      continue;
    }
    if (isForm1120Line(line, 12) && /taxes\s*and\s*lic/i.test(line)) {
      const taxes = formLineAmount(line, "12") ?? scheduleLineAmount(line) ?? lineTailAmount(line);
      if (taxes !== undefined) {
        setField(out, "taxes_licenses", taxes, "Form 1120-S line 12 (page 1 block)", 99);
      }
    }
    if (
      isForm1120Line(line, 11) &&
      (/\brents?\b/i.test(line) || /\brens\b/i.test(line) || /\brent\b/i.test(line))
    ) {
      const rent = formLineAmount(line, "11") ?? scheduleLineAmount(line) ?? lineTailAmount(line);
      if (rent !== undefined) {
        setField(out, "rent", rent, "Form 1120-S line 11 (page 1 block)", 99);
      }
    }
    if (isForm1120Line(line, 14) && /depreciation/i.test(line) && !/accum|schedule\s*l/i.test(line)) {
      const dep = unambiguousFormLineAmountForTag(line, "14");
      if (dep !== undefined) {
        setField(out, "depreciation", dep, "Form 1120-S line 14 (page 1 block)", 99);
      } else if (!substantialMoneyTokens(line).length) {
        setField(out, "depreciation", 0, "Form 1120-S line 14 (page 1 block)", 99);
      }
      // Multi-column OCR bleed: leave unset (do not guess last token).
    }
    if (
      (isForm1120Line(line, 2) || /\[\s*2\s*\]/i.test(line)) &&
      isCogsLine(line) &&
      !/gross profit/i.test(line) &&
      !/schedule\s+cogs/i.test(line)
    ) {
      const cogs = formLineAmount(line, "2");
      if (cogs !== undefined) {
        setField(out, "cogs", cogs, "Form 1120-S line 2 (page 1 block)", 99);
        break;
      }
    }
  }

  // Anchor to the actual Form 4562 page (header carries its title) — page-1 references like
  // "Depreciation from Form 4562 not claimed…" would slice into unrelated schedules.
  const form4562 = [...text.matchAll(/(?:form\s*)?4562[\s\S]{0,8000}/gi)
    ].map((m) => m[0]).find((slice) => /depreciation\s+and\s+amortization/i.test(slice.slice(0, 300)));
  if (form4562 && out.values.gross_intangible_assets === undefined) {
    for (const rawLine of form4562.split(/\n/)) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (!/intangible|goodwill|organizational|start-?up/i.test(line)) continue;
      // GILTI / attach-form captions: "attach Form(s) 5471 and Form 8992" — form numbers are not dollars.
      if (/low-?taxed|GILTI|subpart\s+F|dividends/i.test(line)) continue;
      const amt = scheduleLineAmount(line) ?? lineTailAmount(line);
      if (amt === undefined) continue;
      const formRefs = [...line.matchAll(/form\(?s?\)?\s*(\d{3,4})\b/gi)].map((m) => Number(m[1]));
      if (formRefs.includes(Math.round(amt))) continue;
      setField(out, "gross_intangible_assets", amt, "Form 4562 amortization schedule", 96);
      break;
    }
  }

  // Dense-export Federal Statements: "Form 1120, Page 1, Line 5 - Interest" table.
  // Bare page-1 cells (e.g. "21") are rejected as potential line-number crumbs; the
  // attachment table's $-anchored TOTAL corroborates small interest dollars structurally.
  if (out.values.other_income === undefined) {
    const line5Table = text.match(
      /form\s*1120,?\s*page\s*1,?\s*line\s*5\b\s*[-–—]?\s*interest\b[\s\S]{0,600}/i,
    )?.[0];
    if (line5Table && !/expense|investment/i.test(line5Table.slice(0, 100))) {
      const totalRow = line5Table
        .split(/\n/)
        .map((r) => r.replace(/\s+/g, " ").trim())
        .find((r) => /^total\b/i.test(r));
      const m = totalRow?.match(/\$\s*([\d,]+)\s*$/);
      const amt = m ? parseMoney(m[1]!) : null;
      if (amt !== null && amt >= 0 && isReasonableMoneyAmount(amt)) {
        setField(out, "other_income", amt, "Form 1120 line 5 interest income (statement total)", 97);
      }
    }
  }

  for (const stmtMatch of text.matchAll(/(?:stat(?:ement)?|stmt|tatement)\s*[\d§][\s\S]{0,1500}/gi)) {
    const stmtBlock = stmtMatch[0];
    const header = stmtBlock.slice(0, 320);
    const totalLine = stmtBlock.split(/\n/).find((row) => /^total\b/i.test(row.replace(/\s+/g, " ").trim()));
    if (!totalLine) continue;
    const nums = lineMoneyTokens(totalLine);
    const endTotal = nums.length >= 2 ? nums[nums.length - 1] : scheduleLineAmount(totalLine);
    if (endTotal === undefined) continue;
    if (/line\s*6|other\s+current\s+ass/i.test(header)) {
      setField(out, "other_current_assets", endTotal, "Statement total (Line 6)", 99);
    } else if (/line\s*14|other\s+ass/i.test(header) && !/current\s+asset/i.test(header)) {
      setField(out, "other_assets", endTotal, "Statement total (Line 14)", 99);
    } else if (/line\s*18|other\s+curren|current\s+liabilit|liabiliti\b|other\s+c\s+t/i.test(header)) {
      // Line-18 statements that itemize only revolving/short-term debt captions
      // (credit cards payable, line of credit, short-term notes) sit on the
      // short-term-debt workbook row — same routing as the Schedule L body line
      // "18 … STMT n" scan which books short_term_debt when readable.
      const rows = stmtBlock.split(/\n/).map((r) => r.replace(/\s+/g, " ").trim());
      const totalIdx = rows.findIndex((r) => /^total\b/i.test(r));
      const detailRows = rows
        .slice(0, totalIdx === -1 ? rows.length : totalIdx)
        .filter(
          (r) =>
            /[a-z]{3,}/i.test(r) &&
            !/^description\b|^beginning\b|^statement\b|of\s+year\s*$/i.test(r) &&
            /\$|\d{1,3}(?:,\d{3})+/.test(r),
        );
      const debtRe = /credit\s+cards?\s+payable|line\s+of\s+credit|short[-\s]?term\s+note|revolv/i;
      const allDebtCaptions = detailRows.length > 0 && detailRows.every((r) => debtRe.test(r));
      if (allDebtCaptions) {
        setField(out, "short_term_debt", endTotal, "Statement total (Line 18, revolving debt)", 98);
      } else {
        setField(out, "other_current_liabilities", endTotal, "Statement total (Line 18)", 99);
      }
    }
  }

  const stateSalesDetails: number[] = [];
  const stateSalesTotals: number[] = [];
  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    const nums = lineMoneyTokens(line).filter((n) => keepableSalesAmount(n));
    if (!nums.length) continue;
    const amountCell = Math.abs(nums[nums.length - 1]!);
    if (/sales\s+of\s+tangible\s+personal\s+property/i.test(line)) {
      stateSalesDetails.push(amountCell);
    } else if (/^total\s+sales\b/i.test(line)) {
      stateSalesTotals.push(amountCell);
    }
  }
  // State apportionment OCR can prefix a stray digit to one detail row. Never mutate
  // a value by digit length: use an exact printed Total-sales corroboration, the
  // already-extracted Form value, or unanimous repeated detail instead.
  const corroboratedStateSales = stateSalesDetails.find((value) =>
    stateSalesTotals.some((total) => total === value),
  );
  const stateSales =
    corroboratedStateSales ??
    stateSalesDetails.find((value) => out.values.sales === value) ??
    (stateSalesDetails.length > 0 && stateSalesDetails.every((value) => value === stateSalesDetails[0])
      ? stateSalesDetails[0]
      : undefined);
  if (corroboratedStateSales !== undefined) {
    out.values.sales = corroboratedStateSales;
    out.confidence.sales = 96;
    out.sources.sales = "State apportionment sales detail + Total sales (exact agreement)";
  } else if (stateSales !== undefined && out.values.sales === undefined) {
    setField(out, "sales", stateSales, "State apportionment sales detail (exactly corroborated)", 93);
  }

  // Strict 1120 only — `unknown` was admitting Line-5 interest into S-corp returns
  // (false other_income → Form-OI reverse other_opex drift). No $10k size gate.
  if (formKind === "1120") {
    let bestInterest: number | undefined;
    for (const rawLine of text.split(/\n/)) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      const oi = form1120Line5Interest(line);
      if (oi !== undefined && (bestInterest === undefined || oi > bestInterest)) bestInterest = oi;
    }
    if (bestInterest !== undefined) {
      setField(out, "other_income", bestInterest, "Form 1120 line 5 interest income", 99);
    }
  }

  return out;
}

/** Garbled page-1 rows between salaries (8) and interest (13) — OCR often drops line labels. */
function scanOrphanPage1DeductionAmounts(formPage1: string): FieldExtraction {
  const out: FieldExtraction = { values: {}, confidence: {}, sources: {} };
  let afterLine8 = false;
  const orphans: number[] = [];

  for (const rawLine of formPage1.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;

    if (isForm1120Line(line, 8) && /salar/i.test(line)) afterLine8 = true;
    if (isForm1120Line(line, 13) && /interest/i.test(line) && !/income/i.test(line)) break;
    if (!afterLine8) continue;
    if (isForm1120Line(line, 7) || isForm1120Line(line, 8) || isForm1120Line(line, 13)) continue;

    // Keepable Form money only — no $1k/$5k/$10k floors for garbled caption rows.
    const keepable = (n: number) => {
      const abs = Math.abs(Math.round(n));
      if (abs < 1 || !isReasonableMoneyAmount(abs) || isFormReferenceNumber(abs)) return false;
      if (abs >= 1990 && abs <= 2035) return false;
      const rowRefs = [
        ...line.matchAll(/(?:^\s*[\W_]*|\[)\s*(\d{1,2})(?=\s|[_\][|.:])/g),
      ].map((m) => Number(m[1]));
      return !rowRefs.includes(abs);
    };
    const one = unambiguousFormLineAmount(line);
    const nums = (one !== undefined ? [one] : substantialMoneyTokens(line)).filter(keepable);
    if (!nums.length) continue;

    const tail = Math.round(nums[nums.length - 1]!);
    if (/\w{0,2}ires\b/i.test(line)) {
      setField(out, "rent", tail, "Form 1120-S page 1 (garbled Rents row)", 91);
      continue;
    }
    if (/\badvert/i.test(line)) {
      setField(out, "advertising", tail, "Form 1120-S page 1 (garbled Advertising row)", 91);
      continue;
    }
    if (/taxes\s*and\s*lic/i.test(line)) {
      setField(out, "taxes_licenses", tail, "Form 1120-S page 1 (garbled Taxes row)", 91);
      continue;
    }
    if (!isForm1120Line(line, 9) && !isForm1120Line(line, 10) && !isForm1120Line(line, 11) && !isForm1120Line(line, 12)) {
      orphans.push(tail);
    }
  }

  // Orphan rent only when a single keepable amount remains between salaries and interest.
  if (out.values.rent === undefined && orphans.length === 1) {
    setField(out, "rent", orphans[0]!, "Form 1120-S page 1 (orphan deduction amount)", 90);
  }

  return out;
}

/** Real Form 1120-S / 1120 page 1 — skip Two Year Comparison worksheets that also mention 1120-S. */
export function extractFormPage1Block(text: string, formKind?: TaxFormKind): string {
  const kind = formKind ?? detectTaxForm(text).kind;
  const scoreBlock = (block: string) => {
    let s = 0;
    if (/cost\s*of\s*goods|costof\s*goods/i.test(block) && /\d{1,3},\d{3}/.test(block)) s += 6;
    if (/compensation of officers/i.test(block)) s += 2;
    if (/\[?\s*1c\s*\]?/i.test(block)) s += 1;
    if (/two\s*year\s*comparison|t\w{0,3}\s*y\s*ear\s*\w{0,6}\s*omparison/i.test(block)) s -= 4;
    if (kind === "1120" && /u\.s\.\s*corporation\s+income\s+tax\s+return/i.test(block)) s += 8;
    if (kind === "1120-s" && /s\s+corporation|1120-?s/i.test(block)) s += 4;
    return s;
  };

  const cautionRe = /caution:\s*include\s+only\s+trade\s+or\s+business\s+income/gi;
  const cautionBlocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = cautionRe.exec(text)) !== null) {
    cautionBlocks.push(text.slice(m.index, m.index + 14000));
  }
  if (cautionBlocks.length) {
    return cautionBlocks.sort((a, b) => scoreBlock(b) - scoreBlock(a))[0]!;
  }

  if (kind === "1120") {
    const corpRe = /u\.s\.\s*corporation\s+income\s+tax\s+return|form\s*1120\s*\(\d{4}\)/gi;
    const corpBlocks: string[] = [];
    while ((m = corpRe.exec(text)) !== null) {
      corpBlocks.push(text.slice(Math.max(0, m.index - 4000), m.index + 14000));
    }
    if (corpBlocks.length) {
      return corpBlocks.sort((a, b) => scoreBlock(b) - scoreBlock(a))[0]!;
    }
  }

  const anchors = [
    /u\.s\.\s*income\s*tax\s*return\s+for\s+an\s+s\s+corporation/i,
    /income\s*tax\s*return\s+for\s+an\s+s\s+corporation/i,
  ];
  for (const re of anchors) {
    const idx = text.search(re);
    if (idx >= 0) return text.slice(idx, idx + 14000);
  }
  const idx = text.search(/\b5\s+other\s+income/i);
  if (idx >= 0) return text.slice(Math.max(0, idx - 6000), idx + 800);
  const fallback = text.match(/form\s*1120-?s[\s\S]{0,14000}/i)?.[0];
  return fallback && !/two\s*year\s*comparison/i.test(fallback) ? fallback : text;
}

function scanFormLine5OtherIncome(block: string): number | undefined {
  for (const rawLine of block.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!isForm1120Line(line, 5) || !/other\s+income/i.test(line)) continue;
    if (/statement\s*[2-9]|stmt\s*[2-9]|discount|description/i.test(line)) continue;
    // Attachment pointer ("See Stmt 1") — do not paste Form box dollars here.
    // Leave unset so Stmt-1 / comparison / zero-summary paths decide.
    if (/attach|see\s+stmt|federal\s+statem/i.test(line)) {
      return undefined;
    }
    const one = unambiguousFormLineAmountForTag(line, "5");
    if (one !== undefined) {
      if (!isKeepableWorksheetAmountOnLine(one, line)) return undefined;
      return Math.round(one);
    }
    const amt = formLineAmount(line, "5") ?? scheduleLineAmount(line) ?? lineTailAmount(line);
    if (amt !== undefined) {
      if (!isKeepableWorksheetAmountOnLine(amt, line)) return undefined;
      return Math.round(amt);
    }
    if (!substantialMoneyTokens(line).length) return 0;
  }
  return undefined;
}

/** Form line Stmt 2 attachment total — 1120-S line 19/20, 1120 line 26. */
export function scanFormLine20OtherDeductionsTotal(text: string, kind?: TaxFormKind): number | undefined {
  const formPage1 = extractFormPage1Block(text, kind);
  const lineNums =
    kind === "1120-s" ? [19, 20] : kind === "1120" ? [26] : [19, 20, 26];
  const lineNumPattern =
    kind === "1120-s" ? /\b(?:19|20)\b/i : kind === "1120" ? /\b(?:26)\b/i : /\b(?:19|20|26)\b/i;

  const keepableOdToken = (n: number): boolean => {
    const abs = Math.abs(Math.round(n));
    if (abs < 1 || !isReasonableMoneyAmount(abs)) return false;
    if (isFormReferenceNumber(abs)) return false;
    if (abs >= 1990 && abs <= 2035) return false;
    return true;
  };

  const pickFromLine = (line: string): number | undefined => {
    // Prefer unambiguous single cell (multi-column bleed → refuse).
    const one = unambiguousFormLineAmount(line);
    if (one !== undefined && keepableOdToken(one)) return Math.round(Math.abs(one));
    const tokens = substantialMoneyTokens(line).filter(keepableOdToken);
    if (tokens.length) return Math.round(Math.max(...tokens.map(Math.abs)));
    const amt = scheduleLineAmount(line) ?? lineTailAmount(line);
    if (amt !== undefined && keepableOdToken(amt)) return Math.round(Math.abs(amt));
    return undefined;
  };

  for (const rawLine of formPage1.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!/other\s+deduct/i.test(line)) continue;
    const matchesLine = lineNums.some((n) => isForm1120Line(line, n));
    if (!matchesLine && !lineNumPattern.test(line)) continue;
    const picked = pickFromLine(line);
    if (picked !== undefined) return picked;
  }
  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (
      !/\b(?:19|20|26)\b/i.test(line) ||
      !/other\s+deduct/i.test(line) ||
      !/stmt\s*2|statement\s*2|attach|see\s+stmt/i.test(line)
    ) {
      continue;
    }
    if (/two\s*year\s*comparison|comparison\s+worksheet/i.test(line)) continue;
    const picked = pickFromLine(line);
    if (picked !== undefined) return picked;
  }
  return undefined;
}

/** Best-effort Stmt 2 form-line total — tries detected kind and cross-kind fallbacks. */
export function scanFormLineOtherDeductionsTotalBest(text: string, kind?: TaxFormKind): number | undefined {
  const detected = kind ?? detectTaxForm(text).kind;
  const candidates = [
    scanFormLine20OtherDeductionsTotal(text, detected),
    detected !== "1120" ? scanFormLine20OtherDeductionsTotal(text, "1120") : undefined,
    detected !== "1120-s" ? scanFormLine20OtherDeductionsTotal(text, "1120-s") : undefined,
  ].filter((n): n is number => n !== undefined);
  if (!candidates.length) return undefined;
  if (candidates.length === 1) return candidates[0];
  if (/u\.s\.\s+corporation\s+income\s+tax\s+return/i.test(text)) {
    const corp = scanFormLine20OtherDeductionsTotal(text, "1120");
    if (corp !== undefined) return corp;
  }
  return Math.min(...candidates);
}

/** Form page 1 rents line — authoritative over inflated comparison worksheet rent. */
export function scanFormPageRent(text: string, formKind?: TaxFormKind): number | undefined {
  const detected = formKind ?? detectTaxForm(text).kind;
  const kinds: TaxFormKind[] =
    detected === "unknown"
      ? ["1120", "1120-s", "1065"]
      : detected === "1120"
        ? ["1120", "1120-s"]
        : [detected, "1120", "1120-s"];
  for (const kind of kinds) {
    const block = extractFormPage1Block(text, kind);
    for (const rawLine of block.split(/\n/)) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (!/\brents?\b/i.test(line) || /gross\s+rent/i.test(line)) continue;
      if (kind === "1120" && isForm1120Line(line, 16)) {
        const amt = formLineAmount(line, "16") ?? scheduleLineAmount(line) ?? lineTailAmount(line);
        if (
          amt !== undefined &&
          isReasonableMoneyAmount(amt) &&
          !isFormReferenceNumber(Math.abs(amt)) &&
          !(Math.abs(amt) >= 1990 && Math.abs(amt) <= 2035)
        ) {
          return Math.round(Math.abs(amt));
        }
      }
      if ((kind === "1120-s" || kind === "1065") && isForm1120Line(line, 11)) {
        const amt = formLineAmount(line, "11") ?? scheduleLineAmount(line) ?? lineTailAmount(line);
        if (
          amt !== undefined &&
          isReasonableMoneyAmount(amt) &&
          !isFormReferenceNumber(Math.abs(amt)) &&
          !(Math.abs(amt) >= 1990 && Math.abs(amt) <= 2035)
        ) {
          return Math.round(Math.abs(amt));
        }
      }
    }
  }
  return undefined;
}
