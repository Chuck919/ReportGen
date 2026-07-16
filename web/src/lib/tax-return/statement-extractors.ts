import {
  isFormReferenceNumber,
  isReasonableMoneyAmount,
  lineMoneyTokens,
  parseMoney,
  statementLineAmount,
  stmtAttachmentLineAmount,
  stmtAttachmentMoneyTokens,
  substantialMoneyTokens,
} from "./money";
import type { FieldExtraction } from "./form-anchors";
import { scanFormLine20OtherDeductionsTotal } from "./form-anchors";
import { detectTaxForm } from "./detect-tax-form";
import { pickComparisonColumnIndex, shrinkToYearColumns } from "@/lib/two-year-comparison-parser";
import { pickStmt2BankCreditCard } from "./stmt2-bank-picker";
import { exactClosureTolerance } from "./structural-tolerance";
import { isEinOrPaymentInstructionBleed, repairOcrLabel } from "./ocr-label-repair";
import { isPlausibleOtherOperatingExpense } from "./opex-plausibility";

/** Labeled Stmt-attachment detail dollars — keep micro-lines (`TRAVEL 8.`); reject form-refs/years. */
function isKeepableStmtDetailAmount(n: number): boolean {
  const abs = Math.round(Math.abs(n));
  if (abs < 1) return false;
  if (!isReasonableMoneyAmount(abs)) return false;
  if (isFormReferenceNumber(abs)) return false;
  if (abs >= 1990 && abs <= 2035) return false;
  return true;
}

function tailFromLine(line: string, mode: "last" | "max"): number | undefined {
  const nums = substantialMoneyTokens(line);
  if (!nums.length) return undefined;
  const raw = mode === "max" ? Math.max(...nums.map(Math.abs)) * (nums.find((n) => Math.abs(n) === Math.max(...nums.map(Math.abs)))! < 0 ? -1 : 1) : nums[nums.length - 1];
  if (raw === undefined || isFormReferenceNumber(Math.abs(raw)) || !isReasonableMoneyAmount(raw)) return undefined;
  return raw;
}

function isTaxesLicensesStmt2Line(line: string): boolean {
  return /taxes\s+and\s+licenses|payroll\s+tax|sales\s+and\s+use/i.test(line);
}

/** Stmt 2 attachment total from the block "Total" line (often more accurate than Form line 20 OCR). */
export function scanStatement2Total(text: string): number | undefined {
  let best: number | undefined;

  const considerTotal = (
    line: string,
    inOtherDedBlock: boolean,
    taxesOnlyBlock: boolean,
    recentContext?: string,
  ) => {
    const normalized = line.replace(/\s+/g, " ").trim();
    if (!/^total\b/i.test(normalized)) return;
    if (/total\s+deductions/i.test(normalized)) return;
    if (recentContext && isComparisonWorksheetContext(recentContext)) return;
    if (isTaxesLicensesStmt2Line(line)) return;
    if (taxesOnlyBlock) return;
    const total = statementLineAmount(line);
    if (total === undefined || !isReasonableMoneyAmount(total)) return;
    // Labeled form footers ("TOTAL TO FORM … LINE 19/20") are authoritative.
    // Bare "Total": only inside an Other-deductions block (drops column crumbs outside the pack).
    // Size floors ($10k/$50k) removed — use keepable-money + block membership instead.
    const labeledFormFooter =
      /total\s+to\s+(?:form|schedule|sch\.?)\b|total\s+to\s+line\s*(?:19|20|26)\b/i.test(normalized);
    const abs = Math.round(Math.abs(total));
    if (isFormReferenceNumber(abs)) return;
    if (!labeledFormFooter && !inOtherDedBlock) return;
    if (abs < 1) return;
    if (best === undefined || abs > Math.abs(best)) best = abs;
  };

  const stmt2BlockRe =
    /(?:statement|stmt|tatement)\s*2\b[\s\S]{0,5000}?(?=(?:statement|stmt|tatement)\s*[3-9]\b|1-5\b)/gi;
  let m: RegExpExecArray | null;
  while ((m = stmt2BlockRe.exec(text)) !== null) {
    const header = m[0].slice(0, 400);
    const taxesOnly =
      /line\s*11\b.*tax|schedule\s*c.*line\s*11|taxes.*(?:statement|stmt)\s*2/i.test(header) &&
      !/other\s+deduct/i.test(header);
    for (const rawLine of m[0].split(/\n/)) considerTotal(rawLine, true, taxesOnly, undefined);
  }

  let inStmt2 = false;
  let inOtherDed = false;
  let taxesOnlyBlock = false;
  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;

    const lineIdx = text.indexOf(rawLine);
    const recentContext =
      lineIdx >= 0
        ? text.slice(Math.max(0, lineIdx - 600), lineIdx + rawLine.length).replace(/\s+/g, " ")
        : "";

    if (isComparisonWorksheetContext(recentContext)) {
      inStmt2 = false;
      inOtherDed = false;
      taxesOnlyBlock = false;
    }
    if (isOtherDeductionsBlockHeader(line, recentContext)) {
      inStmt2 = true;
      inOtherDed = true;
      taxesOnlyBlock = false;
    } else if (
      !isFormLineOtherDeductionsPointer(line, recentContext) &&
      /statement\s*2|stmt\s*2|line\s*(?:19|20|26)\b.*other\s+deductions|other\s+deductions.*statement\s*2/i.test(
        line,
      )
    ) {
      inStmt2 = true;
      taxesOnlyBlock =
        /line\s*11\b.*tax|schedule\s*c.*line\s*11|taxes.*(?:statement|stmt)\s*2/i.test(line) &&
        !/other\s+deduct/i.test(line);
    }
    if (/statement\s*[3-9]|stmt\s*[3-9]/i.test(line)) {
      inStmt2 = false;
      inOtherDed = false;
      taxesOnlyBlock = false;
    }
    if (isTaxesLicensesStmt2Line(line)) inOtherDed = false;
    if (!inStmt2) continue;
    considerTotal(line, inOtherDed, taxesOnlyBlock, recentContext);
  }

  return best;
}

/** Sum labeled Stmt 2 exclusion lines anywhere in the document (when attachment pages OCR separately). */
export function scanDocumentWideStmt2Exclusions(text: string): number {
  const rules: Array<{ key: string; re: RegExp }> = [
    { key: "insurance", re: /^insurance\b/i },
    { key: "contract", re: /contract\s+labor/i },
    { key: "auto", re: /auto\s+and\s+truck/i },
    { key: "forklift", re: /forklift|fork\s+lift/i },
    { key: "production", re: /production\s+support|product\s+develop/i },
    { key: "consulting", re: /^consulting\b/i },
    { key: "it", re: /IT\s+support|website\s+support/i },
    { key: "merchant", re: /merchant\s+svc|merchant\s+service|merchant\s+fee/i },
    { key: "licenses", re: /licenses?\s+and\s+permits/i },
    { key: "accounting", re: /accounting\s*&|legal\s+and\s+prof/i },
  ];
  const maxByKey = new Map<string, number>();

  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line || /^total\b/i.test(line)) continue;
    const lineIdx = text.indexOf(rawLine);
    const recentContext = text
      .slice(Math.max(0, lineIdx - 400), lineIdx + rawLine.length)
      .replace(/\s+/g, " ");
    if (isComparisonWorksheetContext(recentContext)) continue;
    if (isTaxesLicensesStmt2Line(line)) continue;
    for (const rule of rules) {
      if (!rule.re.test(line)) continue;
      const amt = statementLineAmount(line);
      if (amt === undefined || !isReasonableMoneyAmount(amt)) continue;
      const abs = Math.round(Math.abs(amt));
      if (!isKeepableStmtDetailAmount(abs)) continue;
      const cur = maxByKey.get(rule.key) ?? 0;
      if (abs > cur) maxByKey.set(rule.key, abs);
      break;
    }
  }

  return [...maxByKey.values()].reduce((sum, n) => sum + n, 0);
}

/** Sum itemized Stmt 2 lines (excl. "Total") — often higher than OCR-truncated total line. */
export function sumStmt2BlockLineItems(text: string): number | undefined {
  let inStmt2 = false;
  let sum = 0;
  let sawLine = false;

  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;

    if (/statement\s*2|stmt\s*2|line\s*(?:19|20)\b.*other\s+deductions|other\s+deductions.*statement\s*2/i.test(line)) {
      const lineIdx = text.indexOf(rawLine);
      const recentContext = text
        .slice(Math.max(0, lineIdx - 500), lineIdx + rawLine.length)
        .replace(/\s+/g, " ");
      if (isComparisonWorksheetContext(recentContext)) continue;
      inStmt2 = true;
      sum = 0;
      sawLine = false;
      continue;
    }
    if (/statement\s*[3-9]|stmt\s*[3-9]/i.test(line)) inStmt2 = false;
    if (!inStmt2) continue;
    const lineIdx = text.indexOf(rawLine);
    const recentContext = text
      .slice(Math.max(0, lineIdx - 400), lineIdx + rawLine.length)
      .replace(/\s+/g, " ");
    if (isComparisonWorksheetContext(recentContext)) continue;
    if (/^total\b/i.test(line)) continue;
    if (PRIMARY_STMT2_LABEL.test(line)) {
      const amt = statementLineAmount(line);
      if (amt !== undefined && isReasonableMoneyAmount(amt)) {
        sum += Math.abs(amt);
        sawLine = true;
      }
      continue;
    }
    if (/\bamortization\b/i.test(line) && !/accumulated/i.test(line)) continue;
    if (/\bdepreciation\b/i.test(line) && !/accumulated/i.test(line)) continue;
    if (!/[a-z]{3,}/i.test(line)) continue;
    const amount = statementLineAmount(line);
    if (amount === undefined || !isReasonableMoneyAmount(amount)) continue;
    const abs = Math.abs(amount);
    if (abs < 1 || abs > 2_000_000 || isFormReferenceNumber(abs)) continue;
    sum += abs;
    sawLine = true;
  }

  // No $10k floor — itemized OD sum is admissible whenever labeled lines exist.
  return sawLine && sum >= 1 ? Math.round(sum) : undefined;
}

/** Individual Stmt 2 misc line amounts (insurance, dues, etc.) — not bank/prof/util/total. */
export function scanStmt2MiscLineAmounts(text: string): number[] {
  let inStmt2 = false;
  const amounts: number[] = [];
  const primaryAmounts = new Set<number>();

  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;
    const lineIdx = text.indexOf(rawLine);
    const recentContext = text
      .slice(Math.max(0, lineIdx - 500), lineIdx + rawLine.length)
      .replace(/\s+/g, " ");
    // "Other deductions" isn't always Statement 2 (e.g. Statement 3 when Stmt 2 is Taxes and
    // licenses) — use the same block-boundary detector as the main extractor so this misc scan
    // targets the actual other-deductions attachment, not a same-numbered unrelated statement.
    if (isOtherDeductionsBlockHeader(line, recentContext)) {
      if (isComparisonWorksheetContext(recentContext)) continue;
      inStmt2 = true;
      amounts.length = 0;
      primaryAmounts.clear();
      continue;
    }
    if (inStmt2 && endsOtherDeductionsBlock(line, recentContext)) inStmt2 = false;
    if (!inStmt2) continue;
    if (isComparisonWorksheetContext(recentContext)) continue;
    if (/^total\b/i.test(line)) continue;
    const amount = statementLineAmount(line);
    if (amount === undefined || !isReasonableMoneyAmount(amount)) continue;
    const abs = Math.round(Math.abs(amount));
    // Keepable Stmt detail only — no `$1000` / `$500k` size floors (line #s/years/form-refs
    // already rejected by isKeepableStmtDetailAmount; exactAgree consumers gate reconstruct).
    if (!isKeepableStmtDetailAmount(abs)) continue;
    if (PRIMARY_STMT2_LABEL.test(line)) {
      primaryAmounts.add(abs);
      continue;
    }
    if (/\bamortization\b/i.test(line) && !/accumulated/i.test(line)) continue;
    if (/\bdepreciation\b/i.test(line) && !/accumulated/i.test(line)) continue;
    if (!/[a-z]{3,}/i.test(line)) continue;
    // Exact dollar exclusion only — soft OCR near-dup bands undercount stmtInTop8.
    if ([...primaryAmounts].some((p) => p === abs)) continue;
    amounts.push(abs);
  }
  return amounts;
}

/** Money amounts on Stmt 2 lines within a band (for truncated-total recovery). */
export function scanStmt2AmountsInBand(text: string, low: number, high: number): number[] {
  let inStmt2 = false;
  const out = new Set<number>();
  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;
    if (/statement\s*2|stmt\s*2|line\s*(?:19|20)\b.*other\s+deductions|other\s+deductions.*statement\s*2/i.test(line)) {
      const lineIdx = text.indexOf(rawLine);
      const recentContext = text
        .slice(Math.max(0, lineIdx - 500), lineIdx + rawLine.length)
        .replace(/\s+/g, " ");
      if (isComparisonWorksheetContext(recentContext)) continue;
      inStmt2 = true;
      continue;
    }
    if (/statement\s*[3-9]|stmt\s*[3-9]/i.test(line)) inStmt2 = false;
    if (!inStmt2) continue;
    const lineIdx = text.indexOf(rawLine);
    const recentContext = text
      .slice(Math.max(0, lineIdx - 400), lineIdx + rawLine.length)
      .replace(/\s+/g, " ");
    if (isComparisonWorksheetContext(recentContext)) continue;
    if (/^total\b/i.test(line)) continue;
    for (const token of substantialMoneyTokens(line)) {
      const abs = Math.round(Math.abs(token));
      if (abs >= low && abs <= high && isReasonableMoneyAmount(abs)) out.add(abs);
    }
  }
  return [...out];
}

const PRIMARY_STMT2_LABEL =
  /bank|credit\s+card|professional|utilities?\b|utility\s+expense|description|statement\s*\d|amount\b/i;

function shouldReplaceBlockBest(
  best:
    | {
        opex: number;
        stmtTotal?: number;
        confidence: number;
        source: string;
      }
    | undefined,
  pick: { opex: number; stmtTotal?: number; confidence: number; source: string },
): boolean {
  if (!best) return true;
  if ((best.stmtTotal ?? 0) < (pick.stmtTotal ?? 0)) return true;
  if ((best.stmtTotal ?? 0) !== (pick.stmtTotal ?? 0)) return false;
  if (pick.confidence > best.confidence) return true;
  if (
    /summed detail/i.test(pick.source) &&
    /office\/supplies/i.test(best.source) &&
    pick.opex > best.opex * 1.5
  ) {
    return true;
  }
  if (
    /federal table minus slot/i.test(pick.source) &&
    /office\/supplies/i.test(best.source) &&
    Math.round(pick.opex) !== Math.round(best.opex)
  ) {
    return true;
  }
  if (
    /federal table minus slot/i.test(pick.source) &&
    /federal table minus slot/i.test(best.source) &&
    Math.round(pick.opex) !== Math.round(best.opex)
  ) {
    return pick.opex > best.opex;
  }
  return false;
}

const OPEX_DETAIL_LINE =
  /office\s+exp|supplies\b|telephone\b|travel\b|bank\s+charg|computer\s+and\s+internet|internet\s+expense|miscellaneous\b/i;

const LARGE_OPEX_EXCLUDED =
  /utilities\b|^auto\b|licenses?\s+and\s+permits|merchant\s+svc|merchant\s+service|professional|accounting\s+&|legal\s+and\s+prof|bank\s+charg|^insurance\b/i;

export function isComparisonWorksheetContext(ctx: string): boolean {
  return /two\s*year\s*comparison|comparison\s+worksheet|tax\s+projection\s+worksheet|t\w{0,3}\s*y\s*ear\s*\w{0,6}\s*omparison/i.test(
    ctx,
  );
}

/** Form page line reference ("line 26 other deductions … see stmt 2") — not an attachment block. */
function isFormLineOtherDeductionsPointer(line: string, recentContext?: string): boolean {
  const ctx = `${recentContext ?? ""} ${line}`;
  if (/federal\s+statements/i.test(ctx)) return false;
  if (!/other\s+deduct/i.test(line)) return false;
  if (
    /\b(?:19|20|26)\b/i.test(line) &&
    /(?:attach\s+statement|see\s+stmt)/i.test(line) &&
    !/^description\s+amount/i.test(line)
  ) {
    return true;
  }
  if (
    /form\s+1120\s*\(\d{4}\)|u\.s\.\s+corporation\s+income\s+tax\s+return/i.test(ctx) &&
    /\b(?:19|20|26)\b/i.test(line)
  ) {
    return true;
  }
  return false;
}

export function isOtherDeductionsBlockHeader(line: string, recentContext?: string): boolean {
  const repaired = repairOcrLabel(line);
  const ctx = `${recentContext ?? ""} ${repaired} ${line}`;
  if (isFormLineOtherDeductionsPointer(line, recentContext)) return false;
  if (isComparisonWorksheetContext(ctx)) return false;
  if (/federal\s+statements/i.test(ctx) && /other\s+(?:deduct|ions|expense)/i.test(repaired + line)) {
    return true;
  }
  if (
    /federal\s+statements/i.test(ctx) &&
    /other\s*(?:deduct|ions)/i.test(line) &&
    /(?:form|stmt|statement|tatement)\s*[12]\b|line\s*(?:19|20|26)\b/i.test(line)
  ) {
    return true;
  }
  if (/other\s+(?:deduct|ions|expense)/i.test(repaired) || /other\s+deduct/i.test(line)) {
    if (/statement\s*[23]\b|stmt\s*[23]\b|tatement\s*2/i.test(repaired + line)) return true;
    if (
      /line\s*(?:19|20)\b/i.test(repaired + line) &&
      /other\s+deduct|see\s+stmt/i.test(repaired + line)
    ) {
      return true;
    }
  }
  if (
    /^description\s+amount\b/i.test(line) &&
    /see\s+stmt\s*2|line\s*20/i.test(repaired + line)
  ) {
    return true;
  }
  if (
    /kentucky\s+statements/i.test(ctx) &&
    /other\s+deduct|line\s*26\b/i.test(repaired + line)
  ) {
    return true;
  }
  if (
    /statement\s*1\b.*form\s*1120.*line\s*26/i.test(repaired + line) &&
    /other\s+deduct/i.test(repaired + line)
  ) {
    return true;
  }
  if (
    /statement\s*\d+\b.*form\s*1120.*line\s*26/i.test(repaired + line) &&
    /other\s+deduct/i.test(repaired + line)
  ) {
    return true;
  }
  if (/federal\s+statements/i.test(ctx) && /line\s*26.*other\s+deduct/i.test(repaired + line)) {
    return true;
  }
  if (
    /statement\s*1\b/i.test(repaired + line) &&
    /other\s+deduct/i.test(line) &&
    /form\s+1120|line\s*(?:19|20|26)/i.test(line)
  ) {
    return true;
  }
  return false;
}

function isFederalStatementsExpenseTable(line: string, recentContext: string): boolean {
  if (!/^description\s+amount\b/i.test(line.replace(/\s+/g, " ").trim())) return false;
  // Form 1125-A "Other costs" (COGS line 5) shares Federal Statements pages — not SG&A Stmt-2.
  if (/form\s*1125|other\s+costs?\b|total\s+to\s+line\s*5/i.test(recentContext)) return false;
  if (/federal\s+statements/i.test(recentContext)) {
    return /other\s+deduct|line\s*(?:19|20|26)\b|other\s+trade\s+or\s+business\s+deduct/i.test(
      recentContext,
    );
  }
  return /(?:statement|stmt|tatement)\s*2\b[\s\S]{0,120}other\s+deduct|line\s*20[\s\S]{0,80}other\s+deduct|other\s+deductions[\s\S]{0,80}line\s*20/i.test(
    recentContext,
  );
}

export function endsOtherDeductionsBlock(line: string, recentContext?: string): boolean {
  const ctx = `${recentContext ?? ""} ${line}`;
  if (isComparisonWorksheetContext(ctx)) return true;
  if (/form\s+1120\s+return\s+summary/i.test(line)) return true;
  if (/form\s*1125|other\s+costs?\b|total\s+to\s+line\s*5/i.test(line)) return true;
  if (/statement\s*[3-9]|stmt\s*[3-9]/i.test(line) && !/other\s+deduct/i.test(line)) return true;
  if (/statement\s*4|stmt\s*4/i.test(line)) return true;
  return false;
}

function scanFederalStmt1MiniTotal(text: string): number {
  const m = text.match(
    /federal\s+statements[\s\S]{0,1200}?description\s+amount[\s\S]{0,800}?total\s+\$?\s*([\d,]+)[\s\S]{0,200}statement\s*2\b[\s\S]{0,120}other\s+deduct/i,
  );
  if (!m) return 0;
  const parsed = parseMoney(m[1]!);
  if (parsed === null || !isReasonableMoneyAmount(parsed) || Math.abs(parsed) >= 50_000) return 0;
  return Math.round(Math.abs(parsed));
}

/** Parse Stmt 2/3 other-deduction attachment blocks (federal OD statements). */
export function extractOtherDeductionsBlockOpex(text: string): {
  opex?: number;
  stmtTotal?: number;
  excludedSum?: number;
  detailPreferred?: boolean;
  confidence: number;
  source: string;
} {
  let best:
    | {
        opex: number;
        stmtTotal?: number;
        excludedSum?: number;
        detailPreferred?: boolean;
        confidence: number;
        source: string;
      }
    | undefined;

  let inBlock = false;
  let stmtTotal: number | undefined;
  let utilities = 0;
  let autoTruck = 0;
  let licenses = 0;
  let merchant = 0;
  let opexDetail = 0;
  let largeDetailSum = 0;
  let professional = 0;
  let contractLabor = 0;
  let forkliftFuel = 0;
  let productionSupport = 0;
  let consulting = 0;
  let itSupport = 0;
  let insuranceLine = 0;
  let miscAmount = 0;
  let telAmount = 0;
  let bankInBlock = 0;
  let federalStmt1Total = 0;
  let federalStmt1Carried = scanFederalStmt1MiniTotal(text);
  let sawFederalStmt2 = false;
  let blockIsFederal = false;
  let travelInBlock = 0;
  let duesInBlock = 0;
  let amortInBlock = 0;

  const appendFederalTableOpex = () => {
    if (!blockIsFederal || stmtTotal === undefined || stmtTotal < 1_000) return;
    if (bankInBlock <= 0 || professional <= 0) return;

    const slotExcluded = Math.round(
      bankInBlock + utilities + professional + autoTruck + licenses + merchant + amortInBlock,
    );
    const federalSlotResidual =
      slotExcluded > 0 ? Math.round(stmtTotal - slotExcluded) : undefined;
    const federalWithoutUtil =
      bankInBlock > 0 && professional > 0
        ? Math.round(stmtTotal - bankInBlock - professional)
        : undefined;
    const federalWithoutUtilStmt1 =
      federalWithoutUtil !== undefined && federalStmt1Carried > 0
        ? Math.round(federalWithoutUtil + federalStmt1Carried)
        : federalWithoutUtil;
    const federalAdjusted =
      federalWithoutUtilStmt1 !== undefined && utilities > 0 && travelInBlock > 0
        ? Math.round(federalWithoutUtilStmt1 - utilities + travelInBlock + duesInBlock)
        : undefined;

    if (
      federalAdjusted !== undefined &&
      federalAdjusted >= 1_000 &&
      federalAdjusted < stmtTotal &&
      isReasonableMoneyAmount(federalAdjusted)
    ) {
      // Constructed slot residual is admitted as-is (no office×1.05 soft gate).
      const pick = {
        opex: federalAdjusted,
        stmtTotal,
        excludedSum: bankInBlock + professional + utilities - travelInBlock - duesInBlock,
        detailPreferred: true,
        confidence: 94,
        source: "Statement 2 (federal table minus slot lines)",
      };
      if (shouldReplaceBlockBest(best, pick)) best = pick;
    }

    if (
      federalSlotResidual !== undefined &&
      federalSlotResidual >= 1_000 &&
      federalSlotResidual < stmtTotal &&
      isReasonableMoneyAmount(federalSlotResidual)
    ) {
      const pick = {
        opex: federalSlotResidual,
        stmtTotal,
        excludedSum: slotExcluded,
        detailPreferred: true,
        confidence: 94,
        source: "Statement 2 (federal table minus slot lines)",
      };
      if (shouldReplaceBlockBest(best, pick)) best = pick;
    }

    if (isKeepableStmtDetailAmount(opexDetail) && opexDetail < stmtTotal) {
      const officeBucket = Math.round(opexDetail);
      const federalLineSum =
        federalStmt1Carried > 0
          ? Math.round(officeBucket + federalStmt1Carried)
          : undefined;
      if (
        federalLineSum !== undefined &&
        federalLineSum >= 1_000 &&
        federalLineSum < stmtTotal &&
        isReasonableMoneyAmount(federalLineSum)
      ) {
        const pick = {
          opex: federalLineSum,
          stmtTotal,
          excludedSum: opexDetail,
          detailPreferred: true,
          confidence: 93,
          source: "Statement 2 (federal table minus slot lines)",
        };
        if (shouldReplaceBlockBest(best, pick)) best = pick;
      }
    }
  };

  const flush = () => {
    appendFederalTableOpex();

    const hasLargeDetail =
      utilities > 0 ||
      insuranceLine > 0 ||
      contractLabor > 0 ||
      professional > 0 ||
      opexDetail > 0 ||
      largeDetailSum > 0;
    const skipLargeFederal =
      blockIsFederal && bankInBlock > 0 && professional > 0 && best?.detailPreferred;
    if (stmtTotal !== undefined && stmtTotal >= 100_000 && hasLargeDetail && !skipLargeFederal) {
      /**
       * Large-corp OD: do NOT nominate hand label-bucket recipes (typeA / consulting / IT /
       * insurance $5k gates / ×0.97). Those closed by construction and needed soft floors to
       * avoid collapsed "summed detail" sticking through align.
       *
       * Emit only a soft classic for early ranking. Final other_opex comes from charter
       * identity `stmtTOTAL − stmtInTop8` at align (formula recipes are no longer authoritative).
       * Small-attachment office/detail inventory remains on the stmtTotal < 100k branch.
       */
      if (utilities > 0) {
        const classicExcluded = utilities + autoTruck + licenses;
        const classicOpex = Math.round(stmtTotal - classicExcluded);
        if (classicOpex > 0 && classicOpex < stmtTotal) {
          const pick = {
            opex: classicOpex,
            stmtTotal,
            excludedSum: classicExcluded,
            detailPreferred: false,
            confidence: 76,
            source: "Statement 2 (total minus util/auto/licenses)",
          };
          if (shouldReplaceBlockBest(best, pick)) {
            best = pick;
          }
        }
      }
    } else if (stmtTotal !== undefined && stmtTotal >= 1_000) {
      const slotExcluded = Math.round(
        bankInBlock + utilities + professional + autoTruck + licenses + merchant,
      );
      const federalSlotResidual =
        slotExcluded > 0 && bankInBlock > 0 && professional > 0
          ? Math.round(stmtTotal - slotExcluded)
          : undefined;
      const federalWithoutUtil =
        bankInBlock > 0 && professional > 0
          ? Math.round(stmtTotal - bankInBlock - professional)
          : undefined;
      const federalWithStmt1 =
        federalSlotResidual !== undefined && federalStmt1Carried > 0
          ? Math.round(federalSlotResidual + federalStmt1Carried)
          : federalSlotResidual;
      const federalWithoutUtilStmt1 =
        federalWithoutUtil !== undefined && federalStmt1Carried > 0
          ? Math.round(federalWithoutUtil + federalStmt1Carried)
          : federalWithoutUtil;

      const excluded = Math.round(
        utilities + autoTruck + licenses + merchant + professional + contractLabor,
      );
      const residual = Math.round(stmtTotal - excluded);
      // Constructed TOTAL − exclusions closes by definition; admit when leftover is keepable.
      const residualOk =
        residual >= 1 &&
        residual < stmtTotal &&
        isReasonableMoneyAmount(residual) &&
        Math.abs(excluded + residual - stmtTotal) <= exactClosureTolerance(stmtTotal);
      const federalAdjusted =
        federalWithoutUtilStmt1 !== undefined &&
        utilities > 0 &&
        travelInBlock > 0
          ? Math.round(federalWithoutUtilStmt1 - utilities + travelInBlock + duesInBlock)
          : undefined;

      if (
        federalAdjusted !== undefined &&
        blockIsFederal &&
        federalAdjusted >= 1_000 &&
        federalAdjusted < stmtTotal &&
        isReasonableMoneyAmount(federalAdjusted)
      ) {
        const pick = {
          opex: federalAdjusted,
          stmtTotal,
          excludedSum: bankInBlock + professional + utilities - travelInBlock - duesInBlock,
          detailPreferred: true,
          confidence: 94,
          source: "Statement 2 (federal table minus slot lines)",
        };
        if (shouldReplaceBlockBest(best, pick)) best = pick;
      } else if (
        federalWithoutUtilStmt1 !== undefined &&
        blockIsFederal &&
        federalWithoutUtilStmt1 >= 1_000 &&
        federalWithoutUtilStmt1 < stmtTotal &&
        isReasonableMoneyAmount(federalWithoutUtilStmt1) &&
        (federalWithStmt1 === undefined ||
          Math.round(federalWithoutUtilStmt1) !== Math.round(federalWithStmt1))
      ) {
        const pick = {
          opex: federalWithoutUtilStmt1,
          stmtTotal,
          excludedSum: bankInBlock + professional,
          detailPreferred: true,
          confidence: 90,
          source: "Statement 2 (federal table minus slot lines)",
        };
        if (shouldReplaceBlockBest(best, pick)) best = pick;
      }
      if (
        federalWithStmt1 !== undefined &&
        blockIsFederal &&
        federalWithStmt1 >= 1_000 &&
        federalWithStmt1 < stmtTotal &&
        isReasonableMoneyAmount(federalWithStmt1) &&
        (!isKeepableStmtDetailAmount(opexDetail) ||
          Math.round(federalWithStmt1) !== Math.round(opexDetail))
      ) {
        const pick = {
          opex: federalWithStmt1,
          stmtTotal,
          excludedSum: slotExcluded,
          detailPreferred: true,
          confidence: 92,
          source: "Statement 2 (federal table minus slot lines)",
        };
        if (shouldReplaceBlockBest(best, pick)) best = pick;
      } else if (residualOk && !isKeepableStmtDetailAmount(opexDetail)) {
        const pick = {
          opex: residual,
          stmtTotal,
          excludedSum: excluded,
          detailPreferred: true,
          confidence: 90,
          source: "Statement 2 (small attachment residual)",
        };
        if (shouldReplaceBlockBest(best, pick)) best = pick;
      } else if (isKeepableStmtDetailAmount(opexDetail) && opexDetail < stmtTotal) {
        const officeBucket = Math.round(
          opexDetail + (!blockIsFederal && bankInBlock > 0 ? bankInBlock : 0),
        );
        const federalLineSum =
          blockIsFederal && federalStmt1Carried > 0
            ? Math.round(officeBucket + federalStmt1Carried)
            : undefined;
        if (
          federalLineSum !== undefined &&
          isKeepableStmtDetailAmount(federalLineSum) &&
          federalLineSum < stmtTotal &&
          isReasonableMoneyAmount(federalLineSum)
        ) {
          const pick = {
            opex: federalLineSum,
            stmtTotal,
            excludedSum: opexDetail,
            detailPreferred: true,
            confidence: 93,
            source: "Statement 2 (federal table minus slot lines)",
          };
          if (shouldReplaceBlockBest(best, pick)) best = pick;
        } else {
          const pick = {
            opex: officeBucket,
            stmtTotal,
            confidence: 93,
            source: "Statement other deductions (office/supplies/telephone/travel/bank detail)",
          };
          if (shouldReplaceBlockBest(best, pick)) best = pick;
        }
      }
    }
    stmtTotal = undefined;
    utilities = 0;
    autoTruck = 0;
    licenses = 0;
    merchant = 0;
    opexDetail = 0;
    largeDetailSum = 0;
    professional = 0;
    contractLabor = 0;
    forkliftFuel = 0;
    productionSupport = 0;
    consulting = 0;
    itSupport = 0;
    insuranceLine = 0;
    miscAmount = 0;
    telAmount = 0;
    bankInBlock = 0;
    federalStmt1Total = 0;
    sawFederalStmt2 = false;
    blockIsFederal = false;
    travelInBlock = 0;
    duesInBlock = 0;
    amortInBlock = 0;
  };

  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;

    const lineIdx = text.indexOf(rawLine);
    const recentContext = text
      .slice(Math.max(0, lineIdx - 600), lineIdx + rawLine.length)
      .replace(/\s+/g, " ");

    if (
      isOtherDeductionsBlockHeader(line, recentContext) ||
      isFederalStatementsExpenseTable(line, recentContext)
    ) {
      if (inBlock) flush();
      blockIsFederal = /federal\s+statements/i.test(recentContext);
      inBlock = true;
      if (/statement\s*2\b|stmt\s*2\b/i.test(line)) sawFederalStmt2 = true;
      continue;
    }
    if (inBlock && endsOtherDeductionsBlock(line, recentContext)) {
      flush();
      inBlock = false;
      continue;
    }
    if (isComparisonWorksheetContext(recentContext)) {
      if (inBlock) flush();
      inBlock = false;
      continue;
    }
    if (!inBlock) {
      const lineIdx = text.indexOf(rawLine);
      const ctxWindow = text.slice(Math.max(0, lineIdx - 250), lineIdx + rawLine.length + 80);
      if (
        /federal\s+statements/i.test(ctxWindow) &&
        /^total\b/i.test(line) &&
        !/statement\s*2\b.*other\s+deduct/i.test(ctxWindow) &&
        !sawFederalStmt2
      ) {
        const commaAmounts = Array.from(line.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d{2})?/g))
          .map((x) => parseMoney(x[0]))
          .filter((n): n is number => n !== null && Math.abs(n) >= 100);
        const miniTotal =
          commaAmounts.length > 0
            ? Math.max(...commaAmounts.map((n) => Math.abs(n)))
            : undefined;
        if (miniTotal !== undefined && miniTotal < 50_000 && isReasonableMoneyAmount(miniTotal)) {
          federalStmt1Carried = Math.max(federalStmt1Carried, Math.round(miniTotal));
        }
      }
      continue;
    }

    const readBlockTotal = (line: string): number | undefined => {
      const commaAmounts = Array.from(line.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d{2})?/g))
        .map((x) => parseMoney(x[0]))
        .filter(
          (n): n is number =>
            n !== null && Math.abs(n) >= 1_000 && !isFormReferenceNumber(Math.abs(n)),
        );
      const total =
        commaAmounts.length > 0
          ? Math.max(...commaAmounts.map((n) => Math.abs(n)))
          : substantialMoneyTokens(line)
              .filter((n) => Math.abs(n) >= 1_000 && !isFormReferenceNumber(Math.abs(n)))
              .sort((a, b) => Math.abs(b) - Math.abs(a))[0];
      if (total !== undefined && isReasonableMoneyAmount(total)) {
        return Math.abs(Math.round(total));
      }
      return undefined;
    };

    if (/^total\s+to\s+form/i.test(line)) {
      const total = readBlockTotal(line);
      if (total !== undefined) stmtTotal = total;
      continue;
    }
    if (/^total\b/i.test(line)) {
      const total = readBlockTotal(line);
      if (total !== undefined) {
        const ctxBefore = text.slice(Math.max(0, text.indexOf(rawLine) - 400), text.indexOf(rawLine));
        if (inBlock && !sawFederalStmt2 && /federal\s+statements/i.test(ctxBefore)) {
          federalStmt1Carried = Math.max(federalStmt1Carried, total);
        } else {
          stmtTotal = total;
        }
      }
      continue;
    }

    let abs: number | undefined;
    const amt = stmtAttachmentLineAmount(line) ?? statementLineAmount(line);
    if (amt !== undefined && isKeepableStmtDetailAmount(amt)) {
      abs = Math.round(Math.abs(amt));
    } else if (OPEX_DETAIL_LINE.test(line)) {
      for (const n of stmtAttachmentMoneyTokens(line)) {
        const candidate = Math.round(Math.abs(n));
        if (isKeepableStmtDetailAmount(candidate)) {
          abs = candidate;
          break;
        }
      }
    }
    if (abs === undefined || !isKeepableStmtDetailAmount(abs)) continue;

    if (/^utilities\b/i.test(line)) utilities = Math.max(utilities, abs);
    else if (/bank\s+&?\s*credit|bank\s+charg|credit\s+card\s+charg/i.test(line)) {
      bankInBlock = Math.max(bankInBlock, abs);
    }
    else if (/auto\s+and\s+truck/i.test(line)) autoTruck = abs;
    else if (/licenses?\s+and\s+permits/i.test(line)) licenses = abs;
    else if (/merchant\s+svc|merchant\s+service|merchant\s+fee/i.test(line)) merchant = abs;
    else if (/^professional\b|accounting\s*&|legal\s+and/i.test(line)) professional = Math.max(professional, abs);
    else if (/contract\s+labor/i.test(line)) contractLabor = Math.max(contractLabor, abs);
    else if (/forklift|fork\s+lift/i.test(line)) forkliftFuel = Math.max(forkliftFuel, abs);
    else if (/production\s+support|product\s+develop/i.test(line)) {
      productionSupport = Math.max(productionSupport, abs);
    } else if (/^consulting\b/i.test(line)) consulting = Math.max(consulting, abs);
    else if (/IT\s+support|website\s+support/i.test(line)) itSupport = Math.max(itSupport, abs);
    else if (/^insurance\b/i.test(line)) {
      insuranceLine = Math.max(insuranceLine, abs);
    } else if (/^amortization\b/i.test(line) && !/accumulated/i.test(line)) {
      amortInBlock = Math.max(amortInBlock, abs);
    } else if (blockIsFederal && /office\s+suppl/i.test(line)) {
      opexDetail += abs;
    } else if (blockIsFederal && /cash\s+over|over\/short/i.test(line)) {
      opexDetail += abs;
    } else if (blockIsFederal && /temporary\s+labor/i.test(line)) {
      opexDetail += abs;
    } else if (blockIsFederal && /^settlement\b|dues\s*&\s*subscription/i.test(line)) {
      opexDetail += abs;
      if (/dues\s*&\s*subscription/i.test(line)) duesInBlock = Math.max(duesInBlock, abs);
    } else if (blockIsFederal && /staff\s+meetings?|store\s+suppl|50%\s+of\s+meals/i.test(line)) {
      opexDetail += abs;
    } else if (/travel\b/i.test(line) && !/mileage\s+reimb/i.test(line)) {
      travelInBlock = Math.max(travelInBlock, abs);
      // Residual detail bucket (office/supplies/telephone/travel/bank) must include micro travel.
      opexDetail += abs;
    } else if (/mileage\s+reimb|travel\s*&\s*mileage/i.test(line)) {
      travelInBlock = Math.max(travelInBlock, abs);
      opexDetail += abs;
    } else if (/^miscellaneous\b/i.test(line)) miscAmount = Math.max(miscAmount, abs);
    else if (/^telephone\b/i.test(line)) {
      telAmount = Math.max(telAmount, abs);
      opexDetail += abs;
    } else if (
      OPEX_DETAIL_LINE.test(line) &&
      !/bank\s+charg|credit\s+card\s+charg|professional|utilities\b|insurance\b/i.test(line)
    ) {
      opexDetail += abs;
    } else if (
      inBlock &&
      !LARGE_OPEX_EXCLUDED.test(line) &&
      /[a-z]{3,}/i.test(line)
    ) {
      largeDetailSum += abs;
    }
  }

  void merchant;
  if (inBlock) flush();

  if (best === undefined) return { confidence: 0, source: "" };
  return best;
}

/** Books / two-year comparison OTHER INCOME row for target year (current column). */
export function scanBooksOtherIncomeForYear(allText: string, targetYear: number): number | undefined {
  for (const rawLine of allText.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!/other\s+income/i.test(line) || /operat/i.test(line) || !/\d/.test(line)) continue;
    const lineIdx = allText.indexOf(rawLine);
    const yearWindow = allText.slice(Math.max(0, lineIdx - 4000), lineIdx + rawLine.length + 400);
    if (!new RegExp(`\\b${targetYear}\\b`).test(yearWindow)) continue;
    const nums = lineMoneyTokens(line).filter((n) => Math.abs(n) >= 0 && Math.abs(n) < 50_000);
    const pair = shrinkToYearColumns(nums);
    if (!pair) continue;
    const yearMatch =
      yearWindow.match(/\b(20\d{2})\s*[\&\-–]\s*(20\d{2})\b/) ??
      yearWindow.match(/\b(20\d{2})\b[^\d]{0,40}\b(20\d{2})\b/);
    const col = yearMatch
      ? pickComparisonColumnIndex(Number(yearMatch[1]), Number(yearMatch[2]), targetYear)
      : 1;
    const picked = col === 0 ? pair[0] : pair[1];
    // Books other-income is never a negative YoY delta.
    if (picked <= 0) continue;
    return Math.round(picked);
  }
  return undefined;
}

export type StatementExpenseLine = { label: string; amount: number; source: string };

function stripStmt2MoneyLabel(line: string): string {
  return repairOcrLabel(line)
    .replace(/[\d$,.()-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Hard rejects only — weak labels are kept for extraction; repair in pool-quality pass. */
function isObviouslyNotStmtExpenseLine(label: string): boolean {
  if (label.length < 2 || label.length > 120) return true;
  if (/^total\b|^description\b|^amount\b/i.test(label)) return true;
  if (
    /\b(omb no|fein number|electronically filed|form corp|payment type|officer's signature|reserved for future|taxable business income|liquor\s+tax\s+payable)\b/i.test(
      label,
    )
  ) {
    return true;
  }
  if (/\bpayable\b/i.test(label) && !/insurance/i.test(label)) return true;
  if (/calendar year|tax year beginning|for calendar year ending/i.test(label)) return true;
  if (/form\s+other\s+deductions\s+statement|form\s+taxes\s+and\s+licenses\s+statement/i.test(label)) {
    return true;
  }
  if (/^form\s+s\s+page\s+line\b/i.test(label)) return true;
  if (/SECTION\s+199A|ORDINARY\s+(?:BUSINESS\s+)?INCOME|SCHEDULE\s+K\b|DISTRIBUTIONS/i.test(label)) {
    return true;
  }
  if (!/[a-z]{2,}/i.test(label)) return true;
  return false;
}

/** Informational — used for label-quality notes, not extraction keep/drop. */
export function isPlausibleStmt2ExpenseLabel(label: string): boolean {
  if (isObviouslyNotStmtExpenseLine(label)) return false;
  return /\b(fees?|rents?|utilit|insur\w*|suppl\w*|office|bank|credit|merchant|profession|legal|account|advert|tax|licen|payroll|repairs?|maint|travel|telephone|dues|salaries?|wages?|officers?|compens|benefit\w*|gasoline|\bfuel\b|vehicle|job|misc|gas\b|toll|meals|education|amort|dues|subscription|meeting|labor|janitor|contract|cleaning|donation|charit)/i.test(
    label,
  );
}

/** Itemized Stmt-2 expense lines for top-8 ledger (same regions as extractStatementDeductions). */
export function extractStatementExpenseLines(text: string): StatementExpenseLine[] {
  const out: StatementExpenseLine[] = [];
  let inStmt2 = false;
  let inFederalExpenseTable = false;

  const pushLine = (line: string, source: string) => {
    if (/^total\b/i.test(line)) return;
    if (/^description\b/i.test(line) && /\bamount\b/i.test(line)) return;
    if (/\bdepreciation\b/i.test(line) && !/accumulated/i.test(line)) return;
    if (/\bamortization\b/i.test(line) && !/accumulated/i.test(line)) return;
    const amount = stmtAttachmentLineAmount(line) ?? statementLineAmount(line);
    if (amount === undefined || !isReasonableMoneyAmount(amount)) return;
    const rounded = Math.round(Math.abs(amount));
    if (!isKeepableStmtDetailAmount(rounded)) return;
    const label = stripStmt2MoneyLabel(line);

    if (isObviouslyNotStmtExpenseLine(label)) return;
    out.push({ label, amount: rounded, source });
  };

  for (const { rawLine, line, lineIdx } of iterTextLines(text)) {
    if (!line) continue;

    const recentContext = text
      .slice(Math.max(0, lineIdx - 600), lineIdx + rawLine.length)
      .replace(/\s+/g, " ");

    if (isOtherDeductionsBlockHeader(line, recentContext)) {
      inStmt2 = true;
      inFederalExpenseTable = false;
    }
    if (isFederalStatementsExpenseTable(line, recentContext)) {
      inFederalExpenseTable = true;
      inStmt2 = true;
    }
    if (isComparisonWorksheetContext(recentContext)) {
      inStmt2 = false;
      inFederalExpenseTable = false;
    }
    if (inStmt2 && endsOtherDeductionsBlock(line, recentContext)) {
      inStmt2 = false;
      inFederalExpenseTable = false;
    }

    if (!inStmt2) continue;
    pushLine(
      line,
      inFederalExpenseTable ? "Statement 2 (federal statements table)" : "Statement 2",
    );
  }

  // Federal Statements Stmt-2 tables (DESCRIPTION / AMOUNT) — tight anchor to avoid Stmt-3 / Schedule K bleed.
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const hit = text.slice(searchFrom).search(/FORM\s+1120[\s\S]{0,120}?OTHER\s+DEDUCT(?:IONS)?[\s\S]{0,80}?STATEMENT\s*2/i);
    if (hit < 0) break;
    const start = searchFrom + hit;
    const chunk = text.slice(start, start + 2800);
    searchFrom = start + 80;
    if (isComparisonWorksheetContext(chunk.slice(0, 400))) continue;
    if (!/DESCRIPTION/i.test(chunk) || !/\bAMOUNT\b/i.test(chunk)) continue;
    for (const rawLine of chunk.split(/\n/)) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (!line) continue;
      // Stop before COGS Other-costs / later statements / Schedule K.
      if (/FORM\s*1125|OTHER\s+COSTS\b|TOTAL\s+TO\s+LINE\s*5/i.test(line)) break;
      if (/SECTION\s+199A|ORDINARY\s+(?:BUSINESS\s+)?INCOME|SCHEDULE\s+K|DISTRIBUTIONS/i.test(line)) break;
      if (/statement\s*[3-9]\b|stmt\s*[3-9]\b/i.test(line) && !/other\s+deduct/i.test(line)) break;
      pushLine(line, "Statement 2 (federal statements table)");
    }
  }

  const insurance = scanStmt2InsuranceAmount(text);
  if (insurance !== undefined && insurance >= 100) {
    out.push({ label: "Insurance", amount: insurance, source: "Statement 2 (insurance line)" });
  }

  const seen = new Set<string>();
  const deduped: StatementExpenseLine[] = [];
  for (const line of out) {
    const key = `${line.label.toLowerCase().replace(/\s+/g, " ")}:${line.amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(line);
  }
  return deduped.sort((a, b) => b.amount - a.amount);
}

function dedupeStatementExpenseLines(lines: StatementExpenseLine[]): StatementExpenseLine[] {
  const seen = new Set<string>();
  const deduped: StatementExpenseLine[] = [];
  for (const line of lines) {
    const key = `${line.label.toLowerCase().replace(/\s+/g, " ")}:${line.amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(line);
  }
  return deduped.sort((a, b) => b.amount - a.amount);
}

/** Walk lines with stable byte offsets (indexOf breaks on duplicate OCR rows). */
function* iterTextLines(text: string): Generator<{ rawLine: string; line: string; lineIdx: number }> {
  let pos = 0;
  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    yield { rawLine, line, lineIdx: pos };
    pos += rawLine.length + 1;
  }
}

function isGarbageStmtBlockLine(label: string, amount: number, anchor?: number): boolean {
  if (
    /\b(aggregate business activity|balance at (beginning|end)|net income per books|gross income or gain|section 199a|schedule l line|distributions)\b/i.test(
      label,
    )
  ) {
    return true;
  }
  // Short entity captions with large amounts are cover/header bleed, not SG&A lines.
  if (/\b(llc|inc|corp)\b/i.test(label) && label.split(/\s+/).length <= 6 && amount > 250_000) {
    return true;
  }
  // FEIN / entity header bleed ("TAXPAYER NAME, INC. 12-3456789" → OCR amount from EIN digits).
  if (
    /\b(supply|inc|llc|corp|services)\b/i.test(label) &&
    label.split(/\s+/).length <= 8 &&
    amount > 100_000
  ) {
    return true;
  }
  if (anchor !== undefined && anchor > 0 && amount > anchor * 2.5) return true;
  return false;
}

function tryPushStmt2ExpenseLine(
  line: string,
  source: string,
  recentContext: string,
  out: StatementExpenseLine[],
): void {
  if (isComparisonWorksheetContext(recentContext)) return;
  if (/^total\b/i.test(line)) return;
  if (/^description\b/i.test(line) && /\bamount\b/i.test(line)) return;
  if (/\bdepreciation\b/i.test(line) && !/accumulated/i.test(line)) return;
  if (/\bamortization\b/i.test(line) && !/accumulated/i.test(line)) return;
  let amount = stmtAttachmentLineAmount(line) ?? statementLineAmount(line);
  if (amount === undefined) {
    const tokens = stmtAttachmentMoneyTokens(line)
      .map((n) => Math.round(Math.abs(n)))
      .filter((n) => isKeepableStmtDetailAmount(n));
    if (tokens.length === 1) amount = tokens[0];
    else if (tokens.length >= 2) amount = tokens[tokens.length - 1];
  }
  if (amount === undefined || !isReasonableMoneyAmount(amount)) return;
  const rounded = Math.round(Math.abs(amount));
  if (!isKeepableStmtDetailAmount(rounded)) return;
  const label = stripStmt2MoneyLabel(line);
  if (isObviouslyNotStmtExpenseLine(label)) return;
  out.push({ label, amount: rounded, source });
}

function collectOtherDeductionsBlocks(text: string): StatementExpenseLine[][] {
  const blocks: StatementExpenseLine[][] = [];
  let cur: StatementExpenseLine[] = [];
  let inBlock = false;
  let inFederal = false;

  const flush = () => {
    if (cur.length) blocks.push(cur);
    cur = [];
    inBlock = false;
    inFederal = false;
  };

  for (const { rawLine, line, lineIdx } of iterTextLines(text)) {
    if (!line) continue;

    const recentContext = text
      .slice(Math.max(0, lineIdx - 600), lineIdx + rawLine.length)
      .replace(/\s+/g, " ");

    if (isOtherDeductionsBlockHeader(line, recentContext)) {
      flush();
      inBlock = true;
    } else if (isFederalStatementsExpenseTable(line, recentContext)) {
      flush();
      inFederal = true;
      inBlock = true;
    }

    if (isComparisonWorksheetContext(recentContext)) {
      flush();
      continue;
    }

    if (inBlock && endsOtherDeductionsBlock(line, recentContext)) {
      flush();
      continue;
    }

    if (!inBlock) continue;
    tryPushStmt2ExpenseLine(
      line,
      inFederal ? "Statement 2 (federal statements table)" : "Statement 2",
      recentContext,
      cur,
    );
  }
  flush();

  const federalStmtRe =
    /FORM\s+1120[\s\S]{0,160}?OTHER\s+DEDUCT(?:IONS)?[\s\S]{0,120}?STATEMENT\s*[23]\b/i;
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const hit = text.slice(searchFrom).search(federalStmtRe);
    if (hit < 0) break;
    const start = searchFrom + hit;
    const chunk = text.slice(start, start + 3200);
    searchFrom = start + 80;
    if (isComparisonWorksheetContext(chunk.slice(0, 400))) continue;
    if (!/DESCRIPTION/i.test(chunk) || !/\bAMOUNT\b/i.test(chunk)) continue;
    const chunkLines: StatementExpenseLine[] = [];
    for (const rawLine of chunk.split(/\n/)) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (!line) continue;
      if (/SECTION\s+199A|ORDINARY\s+(?:BUSINESS\s+)?INCOME|SCHEDULE\s+K|DISTRIBUTIONS/i.test(line)) {
        continue;
      }
      tryPushStmt2ExpenseLine(line, "Statement 2 (federal statements table)", chunk.slice(0, 400), chunkLines);
    }
    if (chunkLines.length) blocks.push(chunkLines);
  }

  const seen = new Set<string>();
  return blocks.filter((b) => {
    const key = [...b]
      .map((l) => `${l.amount}:${l.label.toLowerCase()}`)
      .sort()
      .join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pickBestOtherDeductionsBlock(
  blocks: StatementExpenseLine[][],
  anchor: number | undefined,
): StatementExpenseLine[] {
  if (!blocks.length) return [];
  const viable = blocks.filter(
    (b) => !b.some((l) => isGarbageStmtBlockLine(l.label, l.amount, anchor)),
  );
  const pool = viable.length ? viable : blocks;
  if (anchor === undefined) {
    // No TOTAL anchor — prefer densest labeled block (structural), not a $5k size floor.
    const ranked = pool
      .map((b) => ({ b, sum: b.reduce((s, l) => s + l.amount, 0), lineCount: b.length }))
      .filter((x) => x.sum >= 1 && x.lineCount >= 1)
      .sort((a, b) => b.lineCount - a.lineCount || b.sum - a.sum);
    return dedupeStatementExpenseLines(ranked[0]?.b ?? pool[pool.length - 1]!);
  }

  const exactTol = exactClosureTolerance(anchor);
  const scored = pool.map((b) => {
    const sum = b.reduce((s, l) => s + l.amount, 0);
    const diff = Math.abs(sum - anchor);
    return {
      b,
      sum,
      diff,
      exact: diff <= exactTol,
      lineCount: b.length,
      properRemainder: sum >= 1 && sum < anchor,
    };
  });

  // Dollar-exact TOTAL match first. Soft 1% harvest removed — otherwise densest
  // proper-remainder block (sum < TOTAL) by line count / closest sum.
  const exactClosing = scored.filter((s) => s.exact);
  const structural = scored.filter((s) => s.properRemainder);
  const ranked = exactClosing.length
    ? exactClosing
    : structural.length
      ? structural
      : scored;
  ranked.sort((a, b) => {
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    if (b.lineCount !== a.lineCount) return b.lineCount - a.lineCount;
    return a.diff - b.diff;
  });
  return dedupeStatementExpenseLines(ranked[0]!.b);
}

/** Small satellite Stmt blocks (discount income, interest) split from the primary Other Deductions table. */
function isAdjunctOtherDeductionsBlock(
  block: StatementExpenseLine[],
  anchor: number | undefined,
  primarySum: number,
): boolean {
  if (!block.length) return false;
  if (block.some((l) => isGarbageStmtBlockLine(l.label, l.amount, anchor))) return false;
  const sum = block.reduce((s, l) => s + l.amount, 0);
  // Structural size of satellite tables — not a dollar soft band against TOTAL.
  if (block.length > 6) return false;
  if (
    primarySum > 0 &&
    Math.abs(Math.round(sum) - Math.round(primarySum)) <= exactClosureTolerance(primarySum)
  ) {
    return false;
  }
  return sum >= 1;
}

function mergeAdjunctOtherDeductionsBlocks(
  primary: StatementExpenseLine[],
  blocks: StatementExpenseLine[][],
  anchor: number | undefined,
): StatementExpenseLine[] {
  if (!primary.length) return primary;
  const primarySum = primary.reduce((s, l) => s + l.amount, 0);
  const keys = new Set(primary.map((l) => `${l.amount}:${l.label.toLowerCase()}`));
  const merged = [...primary];

  for (const block of blocks) {
    if (!isAdjunctOtherDeductionsBlock(block, anchor, primarySum)) continue;
    for (const line of block) {
      const key = `${line.amount}:${line.label.toLowerCase()}`;
      if (keys.has(key)) continue;
      keys.add(key);
      merged.push(line);
    }
  }
  return dedupeStatementExpenseLines(merged);
}

/** Sum itemized Stmt lines not already claimed as bank / professional / utilities. */
function computeOtherOpexFromItemizedStmt(
  text: string,
  known: { bank_credit_card?: number; professional_fees?: number; utilities?: number },
): number | undefined {
  const lines = extractBestOtherDeductionsBlockLines(text);
  if (!lines.length) return undefined;

  const primaryAmounts = [known.bank_credit_card, known.professional_fees, known.utilities]
    .filter((n): n is number => n !== undefined && isKeepableStmtDetailAmount(n))
    .map((n) => Math.round(n));

  let sum = 0;
  for (const line of lines) {
    const amt = Math.round(line.amount);
    if (!isKeepableStmtDetailAmount(amt)) continue;
    const label = line.label.toLowerCase();
    const isPrimaryLine =
      (/bank|credit\s+card|merchant/i.test(label) && primaryAmounts.some((p) => p === amt)) ||
      (/professional|legal|accounting/i.test(label) && primaryAmounts.some((p) => p === amt)) ||
      (/^utilities?\b|utility\s+expense/i.test(label) && primaryAmounts.some((p) => p === amt));
    if (isPrimaryLine) continue;
    sum += amt;
  }
  return isKeepableStmtDetailAmount(sum) && isReasonableMoneyAmount(sum) ? Math.round(sum) : undefined;
}

/** All Other Deductions blocks (for audits). */
export function enumerateOtherDeductionsBlocks(
  text: string,
): Array<{ lines: StatementExpenseLine[]; sum: number }> {
  return collectOtherDeductionsBlocks(text).map((lines) => ({
    lines,
    sum: lines.reduce((s, l) => s + l.amount, 0),
  }));
}

/**
 * Itemized lines from the single Other Deductions block whose sum best matches the return anchor.
 * Avoids multi-block / comparison-worksheet bleed that inflates partition sums.
 */
export function extractBestOtherDeductionsBlockLines(text: string): StatementExpenseLine[] {
  const blocks = collectOtherDeductionsBlocks(text);
  if (!blocks.length) return extractStatementExpenseLines(text);

  const anchor = scanStatement2Total(text) ?? sumStmt2BlockLineItems(text);
  const primary = pickBestOtherDeductionsBlock(blocks, anchor);
  return mergeAdjunctOtherDeductionsBlocks(primary, blocks, anchor);
}

type DocumentScanRule = {
  key: string;
  label: string;
  re: RegExp;
  reject?: RegExp;
};

/** Known deduction categories — document-wide scan when Stmt-2 region gates miss attachment pages. */
const DOCUMENT_SCAN_RULES: DocumentScanRule[] = [
  {
    key: "bank_credit_card",
    label: "Bank and credit card",
    re: /(?:^bank\b|bank\s*(?:&|and)?\s*credit\s+card|credit\s+card|merchant\s+(?:fee|service|svc))/i,
  },
  {
    key: "professional_fees",
    label: "Professional fees",
    re: /^(?:professional|legal\s+and\s+prof|accounting\s*&|accounting\s+fee)/i,
    reject: /staff\s+meetings?|pension|profit[\s-]*sharing|dues\s*&\s*subscriptions?/i,
  },
  { key: "utilities", label: "Utilities", re: /^(?:utilities\b|utility\s+expense)/i },
  { key: "insurance", label: "Insurance", re: /^insurance\b/i },
  { key: "repairs", label: "Repairs and maintenance", re: /^(?:repairs?\b|repairs?\s+and\s+maint)/i },
  {
    key: "rent",
    label: "Rent",
    re: /^rents?\b/i,
    reject: /gross\s+rent|rental\s+real\s+estate|net\s+rental/i,
  },
  { key: "advertising", label: "Advertising", re: /^(?:advert|marketing)/i },
  { key: "employee_benefits", label: "Employee benefit programs", re: /^employee\s+benefit/i },
  { key: "gasoline", label: "Gasoline", re: /^gasoline\b|\bfuel\b/i },
  { key: "vehicle_insurance", label: "Vehicle insurance", re: /^vehicle\s+insur/i },
  { key: "supplies", label: "Supplies", re: /^(?:supplies\b|office\s+suppl|job\s+suppl|misc\s+office)/i },
];

/**
 * Targeted document-wide deduction lines — only accepts rows whose label matches a known category.
 * Lower noise than region parsing; catches Stmt-2 detail on pages where block headers were missed.
 */
export function extractDocumentWideDeductionLines(text: string): StatementExpenseLine[] {
  type ScanHit = StatementExpenseLine & { matchStrength: number };

  const maxByKey = new Map<string, ScanHit>();

  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line || /^total\b/i.test(line)) continue;
    if (/^description\b/i.test(line) && /\bamount\b/i.test(line)) continue;

    const lineIdx = text.indexOf(rawLine);
    const recentContext =
      lineIdx >= 0
        ? text.slice(Math.max(0, lineIdx - 500), lineIdx + rawLine.length).replace(/\s+/g, " ")
        : "";

    if (isComparisonWorksheetContext(recentContext)) {
      const repaired = repairOcrLabel(line);
      const expenseLead = DOCUMENT_SCAN_RULES.some(
        (rule) => rule.re.test(repaired) && repaired.search(rule.re) === 0,
      );
      if (!expenseLead) continue;
    }
    // Form line 5 "Other costs" attachments are COGS, not SG&A Other Deductions.
    if (
      /other\s+costs?\b|total\s+to\s+line\s*5\b|cost\s+of\s+(?:goods|sales)|form\s*1120[-\s]?[sb]?\s*(?:page\s*\d+[.,]?\s*)?line\s*5\b/i.test(
        recentContext,
      )
    ) {
      continue;
    }
    if (isFormLineOtherDeductionsPointer(line, recentContext)) continue;
    if (isTaxesLicensesStmt2Line(line)) continue;
    if (isEinOrPaymentInstructionBleed(line, 0)) continue;
    if (
      /\b(sign and return|form\s*8879|payment type|banking\s+information|apply for|fein number|omb no)\b/i.test(
        recentContext + line,
      )
    ) {
      continue;
    }
    if (/SECTION\s+199A|ORDINARY\s+(?:BUSINESS\s+)?INCOME|SCHEDULE\s+K\b|DISTRIBUTIONS/i.test(line)) {
      continue;
    }

    const repaired = repairOcrLabel(line);
    for (const rule of DOCUMENT_SCAN_RULES) {
      if (!rule.re.test(repaired) && !rule.re.test(line)) continue;
      if (rule.reject?.test(repaired) || rule.reject?.test(line)) continue;
      if (rule.key === "bank_credit_card" && /payment|instruction/i.test(line)) continue;
      if (rule.key === "bank_credit_card" && /payables?|accounts\s+payable|credit\s+card\s+payable/i.test(line)) {
        continue;
      }

      let amount = statementLineAmount(line);
      if (rule.key === "bank_credit_card") {
        const labelAmt = line.match(
          /(?:bank|credit\s+card|merchant)[^0-9]{0,40}(\d{1,3}(?:,\d{3})+(?:\.\d{2})?)/i,
        );
        if (labelAmt?.[1] !== undefined) {
          const n = Number(labelAmt[1].replace(/,/g, ""));
          if (Number.isFinite(n) && isKeepableStmtDetailAmount(n)) amount = n;
        }
      }
      if (amount === undefined) {
        const tokens = substantialMoneyTokens(line)
          .map((n) => Math.round(Math.abs(n)))
          .filter((n) => isKeepableStmtDetailAmount(n));
        if (tokens.length === 1) amount = tokens[0];
      }
      if (amount === undefined || !isReasonableMoneyAmount(amount)) continue;
      const abs = Math.round(Math.abs(amount));
      if (!isKeepableStmtDetailAmount(abs)) continue;

      const matchStrength = rule.re.test(repaired) && repaired.search(rule.re) === 0 ? 0 : 1;
      const prev = maxByKey.get(rule.key);
      if (
        !prev ||
        matchStrength < prev.matchStrength ||
        (matchStrength === prev.matchStrength && abs > prev.amount)
      ) {
        maxByKey.set(rule.key, {
          label: rule.label,
          amount: abs,
          source: "Document scan (targeted category)",
          matchStrength,
        });
      }
      break;
    }
  }

  return [...maxByKey.values()]
    .map(({ matchStrength: _s, ...line }) => line)
    .sort((a, b) => b.amount - a.amount);
}

/** Insurance line amount from Stmt 2/3 other-deductions attachment (excluded from workbook opex). */
export function scanStmt2InsuranceAmount(text: string): number | undefined {
  let inBlock = false;
  let best: number | undefined;
  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;
    const lineIdx = text.indexOf(rawLine);
    const recentContext =
      lineIdx >= 0
        ? text.slice(Math.max(0, lineIdx - 600), lineIdx + rawLine.length).replace(/\s+/g, " ")
        : "";
    if (isOtherDeductionsBlockHeader(line, recentContext)) {
      inBlock = true;
      continue;
    }
    if (inBlock && endsOtherDeductionsBlock(line)) inBlock = false;
    if (!inBlock || !/^insurance\b/i.test(line)) continue;
    const amt = statementLineAmount(line);
    if (amt !== undefined && isReasonableMoneyAmount(amt)) best = Math.round(Math.abs(amt));
  }
  return best;
}

/** Block-local Stmt 2 total must agree with an independent Stmt 2 / Form 20 read before closure credit. */
export function blockStmtTotalCorroborated(
  blockTotal: number | undefined,
  corroborators: (number | undefined)[],
): boolean {
  if (blockTotal === undefined || blockTotal < 1) return false;
  const refs = corroborators.filter((n): n is number => n !== undefined && n > 0);
  if (!refs.length) return false;
  // Dollar-exact TOTAL agreement only — soft 1% corroboration admitted paste-side junk.
  return refs.some((ref) => Math.abs(blockTotal - ref) <= exactClosureTolerance(ref));
}

/** True when stmt attachment detail opex closes the block total (prof + util + insurance + opex [+ bank]). */
export function blockOpexClosesStatement(
  blockOpex: { opex?: number; stmtTotal?: number; excludedSum?: number; detailPreferred?: boolean },
  resolved: { values: Record<string, number | undefined> },
  allText: string,
): boolean {
  if (blockOpex.opex === undefined || blockOpex.stmtTotal === undefined) return false;
  // Must be a proper remainder of TOTAL — no size-band / detailPreferred short-circuit.
  if (!(blockOpex.opex >= 1 && blockOpex.opex < blockOpex.stmtTotal)) return false;

  if (blockOpex.excludedSum !== undefined && blockOpex.excludedSum > 0) {
    // Constructed identity (opex = TOTAL − excluded) — dollar-exact only.
    return (
      Math.abs(blockOpex.excludedSum + blockOpex.opex - blockOpex.stmtTotal) <=
      exactClosureTolerance(blockOpex.stmtTotal)
    );
  }
  // Soft rebuilt-from-slots close removed — cannot vouch paste override without constructed exclusions.
  void resolved;
  void allText;
  return false;
}

/** Stmt 2 deduction lines — bank, professional, utilities, other (detail sum). */
export function extractStatementDeductions(text: string): FieldExtraction {
  const out: FieldExtraction = { values: {}, confidence: {}, sources: {} };

  const labelRules: Array<{ id: string; test: RegExp; amount: "last" | "max" }> = [
    { id: "bank_credit_card", test: /bank\s+charg|credit\s+card|merchant\s+(?:fee|service)/i, amount: "max" },
    { id: "professional_fees", test: /professional|legal\s+and\s+account|accounting\s+&|accounting\s+fee/i, amount: "max" },
    { id: "utilities", test: /^utilities\b|utility\s+expense/i, amount: "max" },
    { id: "rent", test: /\brents?\b/i, amount: "max" },
  ];

  const tryLabelLine = (line: string, source: string, inStmt2: boolean) => {
    const repaired = repairOcrLabel(line);
    if (isEinOrPaymentInstructionBleed(line, 0) && /credit\s+card|fein|ein/i.test(line)) return;
    for (const rule of labelRules) {
      if (!rule.test.test(repaired) && !rule.test.test(line)) continue;
      if (
        rule.id === "professional_fees" &&
        /staff\s+meetings?|pension|profit[\s-]*sharing|dues\s*&\s*subscriptions?/i.test(repaired)
      ) {
        continue;
      }
      if (rule.id === "rent" && /gross\s+rent|rental\s+real\s+estate|net\s+rental/i.test(repaired + line)) {
        continue;
      }
      if (/payment|instruction|banking\s+information|apply for/i.test(line) && rule.id === "bank_credit_card") {
        continue;
      }
      const amount = tailFromLine(line, rule.amount);
      if (amount === undefined) continue;
      if (isEinOrPaymentInstructionBleed(line, amount)) continue;
      const rounded = Math.round(amount);
      // Outside Stmt-2: only accept structurally keepable amounts (no $500 floor).
      if (!inStmt2 && !isKeepableStmtDetailAmount(rounded)) continue;
      const cur = out.values[rule.id];
      if (cur === undefined) {
        out.values[rule.id] = rounded;
        out.confidence[rule.id] = 92;
        out.sources[rule.id] = source;
      } else if (
        (rule.id === "utilities" ||
          rule.id === "professional_fees" ||
          rule.id === "bank_credit_card") &&
        Math.abs(rounded) > Math.abs(cur)
      ) {
        out.values[rule.id] = rounded;
        out.confidence[rule.id] = 92;
        out.sources[rule.id] = source;
      }
    }
  };

  let inStmt2 = false;
  let inFederalExpenseTable = false;
  let otherDeductionSum = 0;
  let stmt2Total: number | undefined;

  const accumulateOther = (line: string) => {
    if (!inStmt2) return;
    if (PRIMARY_STMT2_LABEL.test(line)) return;
    if (/^total\b/i.test(line)) return;
    if (/\bamortization\b/i.test(line) && !/accumulated/i.test(line)) return;
    if (/\bdepreciation\b/i.test(line) && !/accumulated/i.test(line)) return;
    if (!/[a-z]{3,}/i.test(line)) return;
    if (
      /\b(taxable business income|enterprise zone|bond credit|credit from form|indiana corporate|electronically filed|fein number|omb no|check the box for the tax return|officer's signature|reserved for future)\b/i.test(
        line,
      )
    ) {
      return;
    }
    const amount = statementLineAmount(line);
    if (amount === undefined || !isReasonableMoneyAmount(amount)) return;
    const abs = Math.abs(amount);
    const primaryHits = [
      out.values.bank_credit_card,
      out.values.professional_fees,
      out.values.utilities,
    ].filter((n): n is number => n !== undefined);
    if (primaryHits.some((n) => Math.round(Math.abs(n)) === Math.round(abs))) return;
    // Skip the stmt footer itself — not a ×0.85 size band.
    if (stmt2Total !== undefined && abs >= stmt2Total) return;
    otherDeductionSum += amount;
  };

  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;

    const lineIdx = text.indexOf(rawLine);
    if (lineIdx < 0) continue;
    const recentContext = text
      .slice(Math.max(0, lineIdx - 600), lineIdx + rawLine.length)
      .replace(/\s+/g, " ");

    if (isOtherDeductionsBlockHeader(line, recentContext)) {
      inStmt2 = true;
      inFederalExpenseTable = false;
      otherDeductionSum = 0;
      stmt2Total = undefined;
    }
    if (isFederalStatementsExpenseTable(line, recentContext)) {
      inFederalExpenseTable = true;
      inStmt2 = true;
      otherDeductionSum = 0;
      stmt2Total = undefined;
    }
    if (isComparisonWorksheetContext(recentContext)) {
      inStmt2 = false;
      inFederalExpenseTable = false;
    }
    if (inStmt2 && endsOtherDeductionsBlock(line, recentContext)) {
      inStmt2 = false;
      inFederalExpenseTable = false;
    }

    if (inStmt2) {
      if (/^total\b/i.test(line)) {
        const total = statementLineAmount(line);
        if (total !== undefined && isReasonableMoneyAmount(total)) stmt2Total = total;
      } else {
        accumulateOther(line);
        tryLabelLine(
          line,
          inFederalExpenseTable ? "Statement 2 (federal statements table)" : "Statement 2",
          true,
        );
      }
    }
  }

  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;
    const repaired = repairOcrLabel(line);
    if (
      !/(?:professional|utilities|bank\s+charg|credit\s+card\s+charg|merchant)/i.test(repaired) &&
      !/(?:professional|utilities|bank\s+charg|credit\s+card\s+charg|merchant)/i.test(line)
    ) {
      continue;
    }
    if (!statementLineAmount(line)) continue;
    tryLabelLine(line, "Statement 2 (document-wide label scan)", false);
  }

  const stmt2Scan = stmt2Total ?? scanStatement2Total(text);
  if (stmt2Scan !== undefined && stmt2Scan >= 1) {
    const bankPick = pickStmt2BankCreditCard(text, {
      professional_fees: out.values.professional_fees,
      utilities: out.values.utilities,
      stmt2Total: stmt2Scan,
      misc: scanStmt2MiscLineAmounts(text),
    });
    if (bankPick !== undefined) {
      const cur = out.values.bank_credit_card;
      // Prefer labeled picker when missing, high-confidence, or current is the Stmt TOTAL footer.
      // No %-disagreement replace — dual OCR reads of the same line are exact-token resolved.
      const replace =
        cur === undefined ||
        bankPick.confidence >= 88 ||
        (cur !== undefined && Math.round(cur) >= Math.round(stmt2Scan));
      if (replace) {
        out.values.bank_credit_card = bankPick.value;
        out.confidence.bank_credit_card = bankPick.confidence;
        out.sources.bank_credit_card = bankPick.source;
      }
    }
    // Clear only when bank amount is the Stmt footer itself.
    if (
      out.values.bank_credit_card !== undefined &&
      out.values.bank_credit_card >= stmt2Scan
    ) {
      delete out.values.bank_credit_card;
      delete out.confidence.bank_credit_card;
      delete out.sources.bank_credit_card;
    }
  }

  const itemizedOpex = computeOtherOpexFromItemizedStmt(text, {
    bank_credit_card: out.values.bank_credit_card,
    professional_fees: out.values.professional_fees,
    utilities: out.values.utilities,
  });
  const stmtAnchor =
    stmt2Total ??
    scanStatement2Total(text) ??
    scanFormLine20OtherDeductionsTotal(text, detectTaxForm(text).kind);
  const blocks = collectOtherDeductionsBlocks(text);
  const primarySum = pickBestOtherDeductionsBlock(blocks, stmtAnchor).reduce(
    (s, l) => s + l.amount,
    0,
  );
  const itemizedClosesAnchor =
    stmtAnchor === undefined ||
    primarySum <= 0 ||
    Math.abs(Math.round(primarySum) - Math.round(stmtAnchor)) <=
      exactClosureTolerance(stmtAnchor) ||
    // Structural: primary block is a proper subset leftover of TOTAL, not soft %.
    (primarySum >= 1 && primarySum < stmtAnchor);

  if (
    itemizedOpex !== undefined &&
    isReasonableMoneyAmount(itemizedOpex) &&
    itemizedClosesAnchor
  ) {
    out.values.other_operating_expenses = itemizedOpex;
    out.confidence.other_operating_expenses = 90;
    out.sources.other_operating_expenses = "Statement 2 (itemized closure lines)";
  } else if (out.values.other_operating_expenses === undefined) {
    // Root cause of ×1.05 / $1000 floors: early TOTAL−(bank+prof+util) invents residual before
    // top-8 is known. Align owns charter identity stmtTOTAL − stmtInTop8 — leave unset here
    // unless we have a keepable itemized detail sum and no independent TOTAL (cannot identity).
    const formKind = detectTaxForm(text).kind;
    const stmtCap =
      stmt2Total ??
      scanStatement2Total(text) ??
      scanFormLine20OtherDeductionsTotal(text, formKind);
    if (
      stmtCap === undefined &&
      otherDeductionSum > 0 &&
      isKeepableStmtDetailAmount(otherDeductionSum)
    ) {
      out.values.other_operating_expenses = Math.round(otherDeductionSum);
      out.confidence.other_operating_expenses = 88;
      out.sources.other_operating_expenses = "Statement 2 (summed detail lines)";
    }
  }

  return out;
}

/** Itemized "Taxes and Licenses" Stmt 2 — when payroll + sales/use are split from state income taxes (multi-state). */
export function extractStatementTaxesSplit(text: string): FieldExtraction {
  const out: FieldExtraction = { values: {}, confidence: {}, sources: {} };
  let inTaxesBlock = false;
  let licensesSum = 0;
  let paidSum = 0;
  let sawSalesUse = false;
  let stateIncomeLines = 0;
  let sawPriorYears = false;
  const blockLines: string[] = [];

  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;

    // Federal "Taxes and Licenses" Stmt *or* CA "Trade or Business Income - Taxes" detail.
    // Require payroll + sales/use later (sawSalesUse) so property-only blocks stay Form total.
    if (
      (/taxes\s+and\s+licenses/i.test(line) ||
        /trade\s+or\s+business\s+income\s*-?\s*taxes/i.test(line)) &&
      (/statement\s*\d+|stmt\s*\d+|line\s*12|line\s*17/i.test(line) ||
        (inTaxesBlock && /payroll|sales\s+and\s+use|based\s+on\s+income/i.test(line)))
    ) {
      if (!inTaxesBlock) {
        inTaxesBlock = true;
        licensesSum = 0;
        paidSum = 0;
        sawSalesUse = false;
        stateIncomeLines = 0;
        sawPriorYears = false;
        blockLines.length = 0;
      }
      if (/payroll|sales\s+and\s+use/i.test(line)) continue;
    }
    if (inTaxesBlock && /statement\s*[3-9]|stmt\s*[3-9]|other\s+deductions/i.test(line) && !/tax/i.test(line)) {
      break;
    }
    if (!inTaxesBlock) continue;
    if (/^total\b/i.test(line)) break;

    blockLines.push(line);

    if (/sales\s+and\s+use/i.test(line)) sawSalesUse = true;

    const amt = statementLineAmount(line) ?? parseMoney(line.match(/\d{1,3}(?:,\d{3})*(?:\.\d{2})?\b/)?.[0] ?? "");
    if (amt === null || amt === undefined || !isReasonableMoneyAmount(amt)) continue;

    if (/state\s+taxes\s*-?\s*prior/i.test(line)) {
      sawPriorYears = true;
      if (amt > 0) paidSum += amt;
    } else if (/based\s+on\s+income/i.test(line) && !/other\s+state|foreign\s+tax/i.test(line)) {
      // Federal taxes_paid = state income-tax lines only (exclude OTHER STATE offsets).
      if (amt > 0) {
        stateIncomeLines += 1;
        paidSum += amt;
      }
    } else if (/income\/franchise|franchise\s+tax/i.test(line)) {
      // CA schedule adjustments — not federal payroll/sales or taxes_paid.
      continue;
    } else if (
      /payroll\s+tax|sales\s+and\s+use|property\s+tax/i.test(line) ||
      (/excise/i.test(line) && !/income/i.test(line))
    ) {
      // Payroll / sales-use / property only — never CA income/franchise adjustments.
      if (amt > 0) licensesSum += amt;
    }
  }

  if (!sawSalesUse || licensesSum <= 0) return out;

  out.values.taxes_licenses = Math.round(licensesSum);
  out.confidence.taxes_licenses = 96;
  out.sources.taxes_licenses = "Statement 2 taxes (payroll/sales portion)";

  if (paidSum > 0 && stateIncomeLines >= 1) {
    out.values.taxes_paid = Math.round(paidSum);
    out.confidence.taxes_paid = 96;
    out.sources.taxes_paid = "Statement 2 taxes (state income tax portion)";
  }
  return out;
}

/** Statement 3 other-deduction detail → workbook other_operating_expenses (excl. util/auto/licenses/merchant). */
export function extractStatement3OtherOperatingExpenses(text: string): FieldExtraction {
  const out: FieldExtraction = { values: {}, confidence: {}, sources: {} };

  const starts: number[] = [];
  const startRe =
    /statement\s*3\b[^\n]{0,220}(?:other\s+deduct|form\s+1120|schedule\s*c|r[dD]-108|line\s*18)/gi;
  let m: RegExpExecArray | null;
  while ((m = startRe.exec(text)) !== null) starts.push(m.index);
  if (!starts.length) return out;

  let bestOpex: number | undefined;

  for (const start of starts) {
    const block = text.slice(start, start + 12_000);
    let stmt3Total: number | undefined;
    let autoTruck = 0;
    let licenses = 0;
    let utilities = 0;
    let merchant = 0;
    let opexDetail = 0;
    let sawTotal = false;

    for (const rawLine of block.split(/\n/)) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (!line) continue;
      if (sawTotal && /statement\s*[4-9]\b/i.test(line) && !/statement\s*3/i.test(line)) break;

      if (/^total\s+to\s+form/i.test(line)) {
        const commaAmounts = Array.from(line.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d{2})?/g))
          .map((x) => parseMoney(x[0]))
          .filter(
            (n): n is number =>
              n !== null &&
              Math.abs(n) >= 50_000 &&
              !isFormReferenceNumber(Math.abs(n)),
          );
        const total =
          commaAmounts.length > 0
            ? Math.max(...commaAmounts.map((n) => Math.abs(n)))
            : substantialMoneyTokens(line)
                .filter((n) => Math.abs(n) >= 50_000 && !isFormReferenceNumber(Math.abs(n)))
                .sort((a, b) => Math.abs(b) - Math.abs(a))[0];
        if (total !== undefined && isReasonableMoneyAmount(total)) {
          stmt3Total = Math.abs(Math.round(total));
          sawTotal = true;
        }
        continue;
      }
      if (/^total\b/i.test(line)) {
        const commaAmounts = Array.from(line.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d{2})?/g))
          .map((x) => parseMoney(x[0]))
          .filter(
            (n): n is number =>
              n !== null &&
              Math.abs(n) >= 15_000 &&
              !isFormReferenceNumber(Math.abs(n)),
          );
        const total =
          commaAmounts.length > 0
            ? Math.max(...commaAmounts.map((n) => Math.abs(n)))
            : substantialMoneyTokens(line)
                .filter((n) => Math.abs(n) >= 15_000 && !isFormReferenceNumber(Math.abs(n)))
                .sort((a, b) => Math.abs(b) - Math.abs(a))[0];
        if (total !== undefined && isReasonableMoneyAmount(total)) {
          stmt3Total = Math.abs(Math.round(total));
          sawTotal = true;
        }
        continue;
      }

      const amt = statementLineAmount(line);
      if (amt === undefined || !isReasonableMoneyAmount(amt)) {
        if (OPEX_DETAIL_LINE.test(line)) {
          for (const n of stmtAttachmentMoneyTokens(line)) {
            const abs = Math.round(Math.abs(n));
            if (isKeepableStmtDetailAmount(abs)) {
              opexDetail += abs;
              break;
            }
          }
        }
        continue;
      }
      const abs = Math.round(Math.abs(amt));
      if (!isKeepableStmtDetailAmount(abs)) continue;

      if (/utilities?\b/i.test(line)) utilities = abs;
      else if (/merchant\s+svc|credit\s+card/i.test(line)) merchant = abs;
      else if (/auto\s+and\s+truck/i.test(line)) autoTruck = abs;
      else if (/licenses?\s+and\s+permits/i.test(line)) licenses = abs;
    }

    if (stmt3Total === undefined || !isKeepableStmtDetailAmount(stmt3Total)) continue;
    const subtractive = Math.round(stmt3Total - utilities - autoTruck - licenses - merchant);
    const detailOpex =
      isKeepableStmtDetailAmount(opexDetail) && opexDetail < stmt3Total
        ? Math.round(opexDetail)
        : undefined;
    // Prefer labeled detail when it exactly matches constructed TOTAL − exclusions.
    const opex =
      detailOpex !== undefined &&
      Math.abs(detailOpex - subtractive) <= exactClosureTolerance(stmt3Total)
        ? detailOpex
        : subtractive;
    if (opex >= 1 && opex < stmt3Total) {
      if (bestOpex === undefined || opex > bestOpex) bestOpex = opex;
    }
  }

  if (bestOpex === undefined) return out;

  out.values.other_operating_expenses = bestOpex;
  out.confidence.other_operating_expenses = 92;
  out.sources.other_operating_expenses =
    "Statement 3 (total minus util/merchant/auto/licenses)";
  return out;
}

export function extractStatementOtherIncome(text: string): { value?: number; source?: string } {
  for (const block of iterStatement1Blocks(text)) {
    for (const rawLine of block.split(/\n/)) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (!/^total\b/i.test(line)) continue;
      const nums: number[] = [];
      for (const m of Array.from(line.matchAll(/\d[\d,]{1,}/g))) {
        const n = parseMoney(m[0]);
        if (n !== null && !isFormReferenceNumber(Math.abs(n))) nums.push(n);
      }
      if (nums.length) return { value: nums[nums.length - 1], source: "Statement 1 total" };
    }
  }
  return {};
}

function iterStatement1Blocks(text: string): string[] {
  const blocks: string[] = [];
  const seen = new Set<string>();
  const push = (block: string) => {
    const key = block.replace(/\s+/g, " ").trim().slice(0, 160);
    if (!seen.has(key)) {
      seen.add(key);
      blocks.push(block);
    }
  };

  const re =
    /(?:(?:statement|stmt|tatement)\s*1\b|ment1\b|st\w*\s*nt\s*1|sf\w*\s*nt\s*1)[^\n]{0,160}[\s\S]{0,1400}?(?=(?:(?:statement|stmt|tatement)\s*[2-9]\b|nt\s*2\s*-)|\n1-5\b)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // Include preceding same-line caption ("OTHER INCOME … STATEMENT 1").
    const header = text.slice(Math.max(0, m.index - 80), m.index + Math.min(280, m[0].length));
    if (!/line\s*5|other\s+income|discount\s+income/i.test(header)) continue;
    push(m[0]);
  }

  const federalRe =
    /federal\s+statements[\s\S]{0,320}?description[\s\S]{0,60}amount[\s\S]{0,500}?^total\b[^\n]*/gim;
  while ((m = federalRe.exec(text)) !== null) {
    const block = m[0];
    if (!/discount\s+income|other\s+income|line\s*5/i.test(block)) continue;
    push(block);
  }

  return blocks;
}

function statement1DetailStats(text: string): { count: number; hasMiscellaneous: boolean } {
  let bestCount = 0;
  let hasMiscellaneous = false;
  for (const block of iterStatement1Blocks(text)) {
    let count = 0;
    let pastHeader = false;
    for (const rawLine of block.split(/\n/)) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (/statement\s*[2-9]|line\s*20|other\s+deduct/i.test(line)) break;
      if (/^description\b|description\s+amount/i.test(line)) {
        pastHeader = true;
        continue;
      }
      if (!pastHeader || !line || /^total\b/i.test(line)) continue;
      if (!/[a-z]{3,}/i.test(line)) continue;
      if (/miscellaneous/i.test(line)) hasMiscellaneous = true;
      if (statementLineAmount(line) === undefined) continue;
      count += 1;
    }
    if (count > bestCount) bestCount = count;
  }
  return { count: bestCount, hasMiscellaneous };
}

/** Stmt 1 total equals a lone tax-refund line — not workbook other_income. */
export function statement1TotalIsTaxRefund(text: string, total: number): boolean {
  for (const block of iterStatement1Blocks(text)) {
    for (const rawLine of block.split(/\n/)) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (!/tax\s+refund|refund.*income|refund\s*-?\s*based/i.test(line)) continue;
      // Prefer lineMoneyTokens — refunds are often 3-digit ($857) and fail substantialMoneyTokens.
      const nums = lineMoneyTokens(line);
      const amt = nums.length ? nums[nums.length - 1] : undefined;
      if (amt !== undefined && Math.abs(amt - total) <= Math.max(2, Math.abs(total) * 0.02)) {
        return true;
      }
    }
  }
  return false;
}

/** Workbook copies Stmt 1 total to other_income when stmt has 3+ lines or includes Miscellaneous. */
export function statement1ReportsToWorkbookOtherIncome(text: string): boolean {
  const { count, hasMiscellaneous } = statement1DetailStats(text);
  return hasMiscellaneous || count >= 3;
}

/** True when `amount` matches a Stmt-1 detail row (not the Total line). */
export function statement1DetailAmountMatches(text: string, amount: number): boolean {
  const target = Math.round(Math.abs(amount));
  if (target < 100) return false;
  for (const block of iterStatement1Blocks(text)) {
    let pastHeader = false;
    for (const rawLine of block.split(/\n/)) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (/statement\s*[2-9]|line\s*20|other\s+deduct/i.test(line)) break;
      if (/^description\b|description\s+amount/i.test(line)) {
        pastHeader = true;
        continue;
      }
      if (!pastHeader || !line || /^total\b/i.test(line)) continue;
      const amt = statementLineAmount(line);
      if (amt !== undefined && Math.round(Math.abs(amt)) === target) return true;
    }
  }
  return false;
}

/** Stmt 1 rows labeled "Other Income" (workbook often nets these to zero on the summary line). */
export function statement1HasOtherIncomeDetailLine(text: string): boolean {
  for (const block of iterStatement1Blocks(text)) {
    for (const rawLine of block.split(/\n/)) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (/^total\b|^description\b/i.test(line)) continue;
      if (/line\s*5|statement\s*1|form\s*1120|page\s*1|federal\s+statements/i.test(line)) continue;
      if (/other\s+income/i.test(line) && !/discount/i.test(line)) return true;
    }
  }
  return false;
}

/** Count Stmt 1 detail rows (multi-item stmt often nets to zero on Form 1120-S line 5). */
export function countStatement1DetailLines(text: string): number {
  return statement1DetailStats(text).count;
}
