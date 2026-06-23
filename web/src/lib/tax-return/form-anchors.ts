import {
  bracketLineAmount,
  formLineAmount,
  isForm1120Line,
  isFormReferenceNumber,
  isHistoricalGrossReceiptsLine,
  lineMoneyTokens,
  lineMaxAmount,
  lineTailAmount,
  parseMoney,
  scheduleLineAmount,
  substantialMoneyTokens,
  derailOcrLeadingOne,
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
  if (
    id === "sales" &&
    out.values.sales !== undefined &&
    out.values.sales >= 100_000 &&
    rounded < out.values.sales * 0.05
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

/** OCR sometimes splits the last group: `3,593,6 368` → `3593368` (drop spurious middle digit). */
function repairOcrSplitThousands(s: string): string {
  return s.replace(/(\d{1,3}(?:,\d{3})),(\d)\s+(\d{3})\b/g, (_, prefix, _middle, tail) => {
    return prefix.replace(/,/g, "") + tail;
  });
}

function salesFromLine(line: string): number | undefined {
  if (/balance.*subtract.*line\s*1b.*line\s*1[ac]/i.test(line)) {
    const amt = lineMaxAmount(line) ?? scheduleLineAmount(line);
    if (amt !== undefined && amt >= 50_000) return derailOcrLeadingOne(amt);
  }

  if (!/gross\s+receipt|gross receipts or sales|line\s+1c|\b1c\b/i.test(line)) {
    return bracketLineAmount(line, "1c") ?? lineMaxAmount(line) ?? consensusFromLine(line);
  }

  const repaired = repairOcrSplitThousands(line);
  const commaAmounts = (repaired.match(/\d{1,3}(?:,\d{3})+(?:\.\d{2})?\b/g) ?? [])
    .map((r) => parseMoney(r))
    .filter((n): n is number => n !== null && n >= 100_000 && n < 50_000_000);
  if (commaAmounts.length) return Math.max(...commaAmounts);

  const labelMatch = repaired.match(/gross\s+receipts?\s+or\s*sales/i);
  if (labelMatch) {
    const segment = repaired.slice(labelMatch.index! + labelMatch[0].length);
    const moneyRun = segment.match(/\d[\d,]{4,}/);
    if (moneyRun) {
      const joined = moneyRun[0].replace(/[^\d]/g, "");
      if (joined.length >= 6 && joined.length <= 8) {
        const n = Number(joined);
        if (Number.isFinite(n) && n >= 50_000) return derailOcrLeadingOne(n);
      }
    }
  }

  const beforeLess = repaired.split(/less\s+return/i)[0] ?? repaired;
  const afterSales = beforeLess.split(/gross\s+receipts?\s+or\s*sales/i)[1] ?? beforeLess;
  const digitsOnly = afterSales.replace(/[^\d]/g, "");
  if (digitsOnly.length >= 6 && digitsOnly.length <= 8) {
    const n = Number(digitsOnly);
    if (Number.isFinite(n) && n >= 50_000) return derailOcrLeadingOne(n);
  }

  const bracket = bracketLineAmount(repaired, "1c");
  if (bracket !== undefined && bracket >= 50_000 && bracket < 50_000_000) {
    return derailOcrLeadingOne(bracket);
  }

  const tail = lineMaxAmount(repaired) ?? consensusFromLine(repaired);
  if (tail !== undefined && tail >= 10_000) return derailOcrLeadingOne(tail);
  if (tail !== undefined && /gross\s+receipt|1c/i.test(line) && tail >= 100_000) return derailOcrLeadingOne(tail);
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
    if (n !== null && n < 10_000) return n;
  }
  if (isForm1120Line(line, 5) && !/expense|investment/i.test(line)) {
    const oi = formLineAmount(line, "5") ?? scheduleLineAmount(line);
    if (oi !== undefined && oi < 10_000 && Math.abs(oi) !== 5) return oi;
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

/** @deprecated use extractFormAnchors */
export function extractForm1120Anchors(text: string): FieldExtraction {
  return extractFormAnchors(text, "1120-s");
}

function extractForm1120StyleAnchors(text: string, formKind: TaxFormKind): FieldExtraction {
  const out: FieldExtraction = { values: {}, confidence: {}, sources: {} };
  const inventoryCandidates: number[] = [];

  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line || isHistoricalGrossReceiptsLine(line)) continue;
    if (/form 1120/i.test(line) && !/schedule\s*l|stmt\s*\d|statement\s*\d/i.test(line)) continue;

    if (
      /\[1c\b|\[1c[\]| ]|gross receipts or sales|\b1a\b.*gross|\bgoss\s+(rece|csr|receipts)|balance.*subtract.*line\s*1b.*line\s*1[ac]/i.test(
        line,
      )
    ) {
      setField(out, "sales", salesFromLine(line), "Form 1120-S line 1c");
    }
    if ((isForm1120Line(line, 2) || /\[\s*2\s*\]/i.test(line)) && isCogsLine(line) && !/gross profit/i.test(line)) {
      const cogs = formLineAmount(line, "2");
      if (cogs !== undefined) setField(out, "cogs", cogs, "Form 1120-S line 2");
    }
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
      const dep = scheduleLineAmount(line);
      if (dep !== undefined && (Math.abs(dep) > 99 || substantialMoneyTokens(line).length)) {
        setField(out, "depreciation", dep, "Form 1120-S line 14");
      } else if (!substantialMoneyTokens(line).length) setField(out, "depreciation", 0, "Form 1120-S line 14", 96);
    }
    if (
      (formKind === "1120-s" || formKind === "1065") &&
      /(\b16\b|\[16\b)/i.test(line) &&
      /advertis/i.test(line)
    ) {
      setField(out, "advertising", scheduleLineAmount(line) ?? lineTailAmount(line), "Form 1120-S line 16");
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
        if (tax !== undefined && substantialMoneyTokens(line).length > 0 && Math.abs(tax) !== 31) {
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
        const dep = scheduleLineAmount(line);
        if (dep !== undefined) setField(out, "depreciation", dep, "Form 1120 line 20");
      }
      if (isForm1120Line(line, 22) && /advertis/i.test(line)) {
        setField(out, "advertising", scheduleLineAmount(line) ?? lineTailAmount(line), "Form 1120 line 22");
      }
      if (isForm1120Line(line, 10) && /other\s+income/i.test(line)) {
        const amt = scheduleLineAmount(line) ?? lineTailAmount(line);
        if (amt !== undefined && substantialMoneyTokens(line).length > 0 && Math.abs(amt) !== 10) {
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
      setField(out, "other_current_assets", scheduleLineAmount(line), "Schedule L line 6");
    }
    if (
      /\b14\b/i.test(line) &&
      !/current\s+asset/i.test(line) &&
      /other\s+ass|ot\w*\s+ass|ofer\s+ass|ter\s+ass|stmt\s*4/i.test(line)
    ) {
      setField(out, "other_assets", scheduleLineAmount(line), "Schedule L line 14");
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
      { id: "unclassified_equity", re: /24\s+retained|retained\s+e\w*rnings/i, source: "Schedule L line 24 (tail scan)", conf: 97 },
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
      if (isForm1120Line(line, 16) && /\brents?\b/i.test(line)) {
        setField(out, "rent", formLineAmount(line, "16") ?? scheduleLineAmount(line), "Form 1120 line 16 (page 1 block)", 99);
      }
      if (isForm1120Line(line, 18) && /interest/i.test(line) && !/investment/i.test(line)) {
        setField(out, "interest_expense", formLineAmount(line, "18") ?? scheduleLineAmount(line), "Form 1120 line 18 (page 1 block)", 99);
      }
      if (isForm1120Line(line, 20) && /depreciation/i.test(line) && !/accum/i.test(line)) {
        setField(out, "depreciation", formLineAmount(line, "20") ?? scheduleLineAmount(line), "Form 1120 line 20 (page 1 block)", 99);
      }
      if (isForm1120Line(line, 22) && /advertis/i.test(line)) {
        setField(out, "advertising", formLineAmount(line, "22") ?? scheduleLineAmount(line), "Form 1120 line 22 (page 1 block)", 99);
      }
      if (isForm1120Line(line, 5) && /^\s*5\b.*interest/i.test(line) && !/expense/i.test(line)) {
        const oi = form1120Line5Interest(line);
        if (oi !== undefined && oi < 1_000_000) setField(out, "other_income", oi, "Form 1120 line 5 interest income", 99);
      }
      if (isForm1120Line(line, 31) && /total\s+tax/i.test(line)) {
        const tax = formLineAmount(line, "31") ?? scheduleLineAmount(line);
        if (tax !== undefined && substantialMoneyTokens(line).length > 0 && Math.abs(tax) !== 31) {
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
      const dep = formLineAmount(line, "14") ?? scheduleLineAmount(line);
      if (dep !== undefined && substantialMoneyTokens(line).length) {
        setField(out, "depreciation", dep, "Form 1120-S line 14 (page 1 block)", 99);
      } else {
        setField(out, "depreciation", 0, "Form 1120-S line 14 (page 1 block)", 99);
      }
    }
    if ((isForm1120Line(line, 2) || /\[\s*2\s*\]/i.test(line)) && isCogsLine(line) && !/gross profit/i.test(line)) {
      const cogs = formLineAmount(line, "2");
      if (cogs !== undefined) {
        setField(out, "cogs", cogs, "Form 1120-S line 2 (page 1 block)", 99);
        break;
      }
    }
  }

  const form4562 = text.match(/form\s*4562[\s\S]{0,8000}/i)?.[0];
  if (form4562 && out.values.gross_intangible_assets === undefined) {
    for (const rawLine of form4562.split(/\n/)) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (!/intangible|goodwill|organizational|start-?up/i.test(line)) continue;
      const amt = scheduleLineAmount(line) ?? lineTailAmount(line);
      if (amt !== undefined) {
        setField(out, "gross_intangible_assets", amt, "Form 4562 amortization schedule", 96);
        break;
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
      setField(out, "other_current_liabilities", endTotal, "Statement total (Line 18)", 99);
    }
  }

  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!/sales\s+of\s+tangible\s+personal\s+property/i.test(line)) continue;
    const nums = lineMoneyTokens(line)
      .filter((n) => Math.abs(n) >= 100_000)
      .map((n) => derailOcrLeadingOne(Math.abs(n)));
    if (!nums.length) continue;
    const best = Math.max(...nums);
    if (out.values.sales === undefined || best > (out.values.sales ?? 0)) {
      setField(out, "sales", best, "State apportionment sales detail", 93);
    }
  }

  if (formKind === "1120" || formKind === "unknown") {
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

    const nums = substantialMoneyTokens(line).filter((n) => Math.abs(n) >= 5_000);
    if (!nums.length) continue;

    const tail = Math.round(nums[nums.length - 1]!);
    if (/\w{0,2}ires\b/i.test(line) && tail >= 10_000) {
      setField(out, "rent", tail, "Form 1120-S page 1 (garbled Rents row)", 91);
      continue;
    }
    if (/\badvert/i.test(line) && tail >= 1_000) {
      setField(out, "advertising", tail, "Form 1120-S page 1 (garbled Advertising row)", 91);
      continue;
    }
    if (/taxes\s*and\s*lic/i.test(line) && tail >= 1_000) {
      setField(out, "taxes_licenses", tail, "Form 1120-S page 1 (garbled Taxes row)", 91);
      continue;
    }
    if (!isForm1120Line(line, 9) && !isForm1120Line(line, 10) && !isForm1120Line(line, 11) && !isForm1120Line(line, 12)) {
      orphans.push(tail);
    }
  }

  const rentCandidates = orphans.filter((n) => n >= 50_000 && n <= 800_000);
  if (out.values.rent === undefined && rentCandidates.length) {
    setField(out, "rent", Math.max(...rentCandidates), "Form 1120-S page 1 (orphan deduction amount)", 90);
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
    if (/attach|see\s+stmt|federal\s+statem/i.test(line)) {
      const stmtAmt = formLineAmount(line, "5") ?? scheduleLineAmount(line) ?? lineTailAmount(line);
      if (stmtAmt !== undefined) return stmtAmt;
      return undefined;
    }
    const amt = formLineAmount(line, "5") ?? scheduleLineAmount(line) ?? lineTailAmount(line);
    if (amt !== undefined) return amt;
    if (!substantialMoneyTokens(line).length) return 0;
  }
  return undefined;
}

/** Form 1120-S line 19/20 — Stmt 2 attachment total (sum of all other deduction detail). */
export function scanFormLine20OtherDeductionsTotal(text: string, kind?: TaxFormKind): number | undefined {
  const formPage1 = extractFormPage1Block(text, kind);
  const lineNums = kind === "1120-s" ? ["19", "20"] : ["20"];
  for (const rawLine of formPage1.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!/other\s+deduct/i.test(line)) continue;
    const matchesLine = lineNums.some((n) => isForm1120Line(line, n));
    if (!matchesLine && !/\b(?:19|20)\b/i.test(line)) continue;
    const tokens = substantialMoneyTokens(line).filter((n) => Math.abs(n) >= 5000);
    if (tokens.length) return Math.round(Math.max(...tokens.map(Math.abs)));
    const amt = scheduleLineAmount(line) ?? lineTailAmount(line);
    if (amt !== undefined && Math.abs(amt) >= 5000) return Math.round(amt);
  }
  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!/\b(?:19|20)\b/i.test(line) || !/other\s+deduct/i.test(line) || !/stmt\s*2|statement\s*2|attach/i.test(line)) {
      continue;
    }
    const tokens = substantialMoneyTokens(line).filter((n) => Math.abs(n) >= 5000);
    if (tokens.length) return Math.round(Math.max(...tokens.map(Math.abs)));
  }
  return undefined;
}
