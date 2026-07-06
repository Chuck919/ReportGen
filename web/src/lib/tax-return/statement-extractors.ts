import {
  isFormReferenceNumber,
  isReasonableMoneyAmount,
  lineMoneyTokens,
  parseMoney,
  statementLineAmount,
  substantialMoneyTokens,
} from "./money";
import type { FieldExtraction } from "./form-anchors";
import { scanFormLine20OtherDeductionsTotal } from "./form-anchors";
import { detectTaxForm } from "./detect-tax-form";
import { pickComparisonColumnIndex } from "@/lib/two-year-comparison-parser";
import { pickStmt2BankCreditCard } from "./stmt2-bank-picker";
import { closureTolerance, formulasDisagree } from "./structural-tolerance";
import { isEinOrPaymentInstructionBleed, repairOcrLabel } from "./ocr-label-repair";
import { isPlausibleOtherOperatingExpense } from "./opex-plausibility";

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
    if (!/^total\b/i.test(line.replace(/\s+/g, " ").trim())) return;
    if (/total\s+deductions/i.test(line)) return;
    if (recentContext && isComparisonWorksheetContext(recentContext)) return;
    if (isTaxesLicensesStmt2Line(line)) return;
    if (taxesOnlyBlock) return;
    const total = statementLineAmount(line);
    if (total === undefined || !isReasonableMoneyAmount(total) || Math.abs(total) < 10_000) return;
    if (!inOtherDedBlock && Math.abs(total) < 50_000) return;
    if (best === undefined || Math.abs(total) > Math.abs(best)) best = Math.round(total);
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
      if (abs < 500 || abs > 2_000_000) continue;
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
    if (abs < 500 || abs > 2_000_000) continue;
    sum += abs;
    sawLine = true;
  }

  return sawLine && sum >= 10_000 ? Math.round(sum) : undefined;
}

/** Individual Stmt 2 misc line amounts (insurance, dues, etc.) — not bank/prof/util/total. */
export function scanStmt2MiscLineAmounts(text: string): number[] {
  let inStmt2 = false;
  const amounts: number[] = [];
  const primaryAmounts = new Set<number>();

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
      amounts.length = 0;
      primaryAmounts.clear();
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
    const amount = statementLineAmount(line);
    if (amount === undefined || !isReasonableMoneyAmount(amount)) continue;
    const abs = Math.round(Math.abs(amount));
    if (abs < 1_000 || abs > 500_000) continue;
    if (PRIMARY_STMT2_LABEL.test(line)) {
      primaryAmounts.add(abs);
      continue;
    }
    if (/\bamortization\b/i.test(line) && !/accumulated/i.test(line)) continue;
    if (/\bdepreciation\b/i.test(line) && !/accumulated/i.test(line)) continue;
    if (!/[a-z]{3,}/i.test(line)) continue;
    if ([...primaryAmounts].some((p) => Math.abs(p - abs) <= Math.max(2, abs * 0.01))) continue;
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
    pick.opex > best.opex * 1.15
  ) {
    return true;
  }
  if (
    /federal table minus slot/i.test(pick.source) &&
    /federal table minus slot/i.test(best.source) &&
    Math.abs(pick.opex - best.opex) > Math.max(500, best.opex * 0.02)
  ) {
    return pick.opex > best.opex;
  }
  return false;
}

const OPEX_DETAIL_LINE =
  /office\s+exp|supplies\b|telephone\b|travel\b|bank\s+charg|computer\s+and\s+internet|internet\s+expense|miscellaneous\b/i;

const LARGE_OPEX_EXCLUDED =
  /utilities\b|^auto\b|licenses?\s+and\s+permits|merchant\s+svc|merchant\s+service|professional|accounting\s+&|legal\s+and\s+prof|bank\s+charg|^insurance\b/i;

function isComparisonWorksheetContext(ctx: string): boolean {
  return /two\s*year\s*comparison|comparison\s+worksheet|t\w{0,3}\s*y\s*ear\s*\w{0,6}\s*omparison/i.test(
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

function isOtherDeductionsBlockHeader(line: string, recentContext?: string): boolean {
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
  return false;
}

function isFederalStatementsExpenseTable(line: string, recentContext: string): boolean {
  if (!/^description\s+amount\b/i.test(line.replace(/\s+/g, " ").trim())) return false;
  if (/federal\s+statements/i.test(recentContext)) return true;
  return /(?:statement|stmt|tatement)\s*2\b[\s\S]{0,120}other\s+deduct|line\s*20[\s\S]{0,80}other\s+deduct|other\s+deductions[\s\S]{0,80}line\s*20/i.test(
    recentContext,
  );
}

function endsOtherDeductionsBlock(line: string, recentContext?: string): boolean {
  const ctx = `${recentContext ?? ""} ${line}`;
  if (isComparisonWorksheetContext(ctx)) return true;
  if (/form\s+1120\s+return\s+summary/i.test(line)) return true;
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

/** Parse Stmt 2/3 other-deduction attachment blocks (Carithers stmt3, Arizona stmt2). */
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
      federalAdjusted < stmtTotal * 0.45 &&
      isReasonableMoneyAmount(federalAdjusted)
    ) {
      const officePlusStmt1 =
        opexDetail >= 500 && federalStmt1Carried > 0
          ? Math.round(opexDetail + federalStmt1Carried)
          : undefined;
      if (
        officePlusStmt1 === undefined ||
        federalAdjusted <= officePlusStmt1 * 1.05 ||
        travelInBlock >= 500
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
      }
    }

    if (
      federalSlotResidual !== undefined &&
      federalSlotResidual >= 1_000 &&
      federalSlotResidual < stmtTotal * 0.45 &&
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

    if (opexDetail >= 500 && opexDetail < stmtTotal * 0.5) {
      const officeBucket = Math.round(opexDetail);
      const federalLineSum =
        federalStmt1Carried > 0
          ? Math.round(officeBucket + federalStmt1Carried)
          : undefined;
      if (
        federalLineSum !== undefined &&
        federalLineSum >= 1_000 &&
        federalLineSum < stmtTotal * 0.45 &&
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
      const tol = closureTolerance(stmtTotal);
      const classicExcluded = utilities + autoTruck + licenses;
      const classicOpex = Math.round(stmtTotal - classicExcluded);

      type LargeCand = {
        opex: number;
        excludedSum: number;
        detailPreferred: boolean;
        confidence: number;
        source: string;
      };
      const candidates: LargeCand[] = [];
      if (utilities > 0) {
        candidates.push({
          opex: classicOpex,
          excludedSum: classicExcluded,
          detailPreferred: false,
          confidence: 76,
          source: "Statement 2 (total minus util/auto/licenses)",
        });
      }

      const typeAExcluded =
        professional + autoTruck + contractLabor + forkliftFuel + insuranceLine + productionSupport;
      if (typeAExcluded > 0 && typeAExcluded < stmtTotal * 0.92) {
        candidates.push({
          opex: Math.round(stmtTotal - typeAExcluded),
          excludedSum: typeAExcluded,
          detailPreferred: true,
          confidence: 91,
          source: "Statement 2 (summed detail lines)",
        });
      }
      if (insuranceLine >= 5_000 && contractLabor >= stmtTotal * 0.5) {
        candidates.push({
          opex: Math.round(stmtTotal - insuranceLine),
          excludedSum: insuranceLine,
          detailPreferred: true,
          confidence: 88,
          source: "Statement 2 (total minus insurance; contract line OCR bleed)",
        });
      }
      if (consulting >= 5_000) {
        const ex = autoTruck + consulting + productionSupport;
        candidates.push({
          opex: Math.round(stmtTotal - ex),
          excludedSum: ex,
          detailPreferred: true,
          confidence: 91,
          source: "Statement 2 (summed detail lines)",
        });
      }
      if (itSupport >= 5_000) {
        const ex = autoTruck + itSupport + miscAmount + telAmount + utilities;
        candidates.push({
          opex: Math.round(stmtTotal - ex),
          excludedSum: ex,
          detailPreferred: true,
          confidence: 91,
          source: "Statement 2 (summed detail lines)",
        });
      }

      const valid = candidates.filter((p) => {
        if (p.opex < 10_000) return false;
        const closes = Math.abs(p.excludedSum + p.opex - stmtTotal!) <= tol;
        if (!closes) return false;
        // High-ratio opex is valid when the block formula structurally closes.
        if (p.opex <= stmtTotal! * 0.92) return true;
        return p.detailPreferred && closes;
      });

      let chosen = valid.find((p) => !p.detailPreferred) ?? valid[0];
      if (valid.length > 1 && chosen) {
        if (itSupport >= 5_000) {
          const itEx = autoTruck + itSupport + miscAmount + telAmount + utilities;
          const alt = valid.find((p) => p.detailPreferred && p.excludedSum === itEx);
          if (alt && formulasDisagree(classicOpex, alt.opex)) chosen = alt;
        } else if (consulting >= 5_000) {
          const consultEx = autoTruck + consulting + productionSupport;
          const alt = valid.find((p) => p.detailPreferred && p.excludedSum === consultEx);
          if (alt && formulasDisagree(classicOpex, alt.opex)) chosen = alt;
        } else if (professional >= 5_000 && contractLabor >= 5_000 && typeAExcluded > 0) {
          const alt = valid.find((p) => p.detailPreferred && p.excludedSum === typeAExcluded);
          if (
            alt &&
            alt.opex !== classicOpex &&
            (formulasDisagree(classicOpex, alt.opex) ||
              Math.abs(alt.opex - classicOpex) > closureTolerance(classicOpex)) &&
            alt.opex >= classicOpex * 0.97
          ) {
            chosen = alt;
          }
        }
      }

      if (chosen) {
        const pick = {
          opex: chosen.opex,
          stmtTotal,
          excludedSum: chosen.excludedSum,
          detailPreferred: chosen.detailPreferred,
          confidence: chosen.confidence,
          source: chosen.source,
        };
        if (shouldReplaceBlockBest(best, pick)) {
          best = pick;
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
      const tol = closureTolerance(stmtTotal);
      const residualCloses =
        residual >= 1_000 && Math.abs(excluded + residual - stmtTotal) <= tol;
      const residualOk =
        residualCloses && residual < stmtTotal * 0.65 && isReasonableMoneyAmount(residual);
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
        federalAdjusted < stmtTotal * 0.45 &&
        isReasonableMoneyAmount(federalAdjusted)
      ) {
        const officePlusStmt1 =
          opexDetail >= 500 && federalStmt1Carried > 0
            ? Math.round(opexDetail + federalStmt1Carried)
            : undefined;
        if (
          officePlusStmt1 === undefined ||
          federalAdjusted <= officePlusStmt1 * 1.05 ||
          travelInBlock >= 500
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
        }
      } else if (
        federalWithoutUtilStmt1 !== undefined &&
        blockIsFederal &&
        federalWithoutUtilStmt1 >= 1_000 &&
        federalWithoutUtilStmt1 < stmtTotal * 0.45 &&
        isReasonableMoneyAmount(federalWithoutUtilStmt1) &&
        (federalWithStmt1 === undefined ||
          Math.abs(federalWithoutUtilStmt1 - federalWithStmt1) > Math.max(500, stmtTotal * 0.01))
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
        federalWithStmt1 < stmtTotal * 0.45 &&
        isReasonableMoneyAmount(federalWithStmt1) &&
        (opexDetail < 500 || federalWithStmt1 > opexDetail * 1.15)
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
      } else if (residualOk && opexDetail < 500) {
        const pick = {
          opex: residual,
          stmtTotal,
          excludedSum: excluded,
          detailPreferred: true,
          confidence: 90,
          source: "Statement 2 (small attachment residual)",
        };
        if (shouldReplaceBlockBest(best, pick)) best = pick;
      } else if (opexDetail >= 500 && opexDetail < stmtTotal * 0.5) {
        const officeBucket = Math.round(
          opexDetail + (!blockIsFederal && bankInBlock > 0 ? bankInBlock : 0),
        );
        const federalLineSum =
          blockIsFederal && federalStmt1Carried > 0
            ? Math.round(officeBucket + federalStmt1Carried)
            : undefined;
        if (
          federalLineSum !== undefined &&
          federalLineSum >= 1_000 &&
          federalLineSum < stmtTotal * 0.45 &&
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
    const amt = statementLineAmount(line);
    if (amt !== undefined && isReasonableMoneyAmount(amt)) {
      abs = Math.round(Math.abs(amt));
    } else if (OPEX_DETAIL_LINE.test(line)) {
      for (const n of lineMoneyTokens(line)) {
        const candidate = Math.round(Math.abs(n));
        if (candidate >= 10 && isReasonableMoneyAmount(candidate)) {
          abs = candidate;
          break;
        }
      }
    }
    if (abs === undefined || abs < 10) continue;

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
    } else if (/mileage\s+reimb|travel\s*&\s*mileage/i.test(line)) {
      travelInBlock = Math.max(travelInBlock, abs);
      if (blockIsFederal) opexDetail += abs;
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
    const lineIdx = allText.indexOf(line);
    const yearWindow = allText.slice(Math.max(0, lineIdx - 4000), lineIdx + line.length + 400);
    if (!new RegExp(`\\b${targetYear}\\b`).test(yearWindow)) continue;
    const nums = lineMoneyTokens(line).filter((n) => Math.abs(n) >= 0 && Math.abs(n) < 50_000);
    const pair =
      nums.length >= 2
        ? ([Math.round(nums[0]!), Math.round(nums[nums.length - 1]!)] as [number, number])
        : undefined;
    if (!pair) continue;
    const yearMatch =
      yearWindow.match(/\b(20\d{2})\s*[\&\-–]\s*(20\d{2})\b/) ??
      yearWindow.match(/\b(20\d{2})\b[^\d]{0,40}\b(20\d{2})\b/);
    const col = yearMatch
      ? pickComparisonColumnIndex(Number(yearMatch[1]), Number(yearMatch[2]), targetYear)
      : 1;
    return col === 0 ? pair[0] : pair[1];
  }
  return undefined;
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
  if (blockTotal === undefined || blockTotal < 5_000) return false;
  const refs = corroborators.filter((n): n is number => n !== undefined && n > 0);
  if (!refs.length) return blockTotal >= 100_000;
  return refs.some((ref) => Math.abs(blockTotal - ref) <= closureTolerance(ref));
}

/** True when stmt attachment detail opex closes the block total (prof + util + insurance + opex [+ bank]). */
export function blockOpexClosesStatement(
  blockOpex: { opex?: number; stmtTotal?: number; excludedSum?: number; detailPreferred?: boolean },
  resolved: { values: Record<string, number | undefined> },
  allText: string,
): boolean {
  if (blockOpex.opex === undefined || blockOpex.stmtTotal === undefined) return false;
  const tol =
    blockOpex.stmtTotal < 100_000
      ? Math.max(500, Math.abs(blockOpex.stmtTotal) * 0.05)
      : closureTolerance(blockOpex.stmtTotal);
  if (blockOpex.detailPreferred) {
    return blockOpex.opex >= 10_000 && blockOpex.opex <= blockOpex.stmtTotal * 0.92;
  }
  if (blockOpex.excludedSum !== undefined && blockOpex.excludedSum > 0) {
    return Math.abs(blockOpex.excludedSum + blockOpex.opex - blockOpex.stmtTotal) <= tol;
  }
  const prof = resolved.values.professional_fees ?? 0;
  const util = resolved.values.utilities ?? 0;
  const ins = scanStmt2InsuranceAmount(allText) ?? 0;
  const withIns = prof + util + ins + blockOpex.opex;
  if (Math.abs(withIns - blockOpex.stmtTotal) <= tol) return true;
  const bank = resolved.values.bank_credit_card ?? 0;
  return Math.abs(withIns + bank - blockOpex.stmtTotal) <= tol;
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
      if (!inStmt2 && (rounded >= 500_000 || rounded < 500)) continue;
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
    if (primaryHits.some((n) => Math.abs(n - abs) <= Math.max(2, abs * 0.01))) return;
    if (stmt2Total !== undefined && abs >= stmt2Total * 0.85) return;
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
  if (stmt2Scan !== undefined && stmt2Scan >= 5_000) {
    const bankPick = pickStmt2BankCreditCard(text, {
      professional_fees: out.values.professional_fees,
      utilities: out.values.utilities,
      stmt2Total: stmt2Scan,
      misc: scanStmt2MiscLineAmounts(text),
    });
    if (bankPick !== undefined) {
      const cur = out.values.bank_credit_card;
      const replace =
        cur === undefined ||
        bankPick.confidence >= 88 ||
        (cur !== undefined &&
          (Math.abs(cur - bankPick.value) / Math.max(bankPick.value, 1) > 0.15 ||
            cur >= stmt2Scan * 0.35));
      if (replace) {
        out.values.bank_credit_card = bankPick.value;
        out.confidence.bank_credit_card = bankPick.confidence;
        out.sources.bank_credit_card = bankPick.source;
      }
    }
    if (
      out.values.bank_credit_card !== undefined &&
      out.values.bank_credit_card >= stmt2Scan * 0.35
    ) {
      delete out.values.bank_credit_card;
      delete out.confidence.bank_credit_card;
      delete out.sources.bank_credit_card;
    }
  }

  if (otherDeductionSum > 0 && out.values.other_operating_expenses === undefined) {
    let opex = otherDeductionSum;
    const formKind = detectTaxForm(text).kind;
    const globalStmt2 =
      scanStatement2Total(text) ??
      scanFormLine20OtherDeductionsTotal(text, formKind) ??
      (/u\.s\.\s+corporation\s+income\s+tax\s+return/i.test(text)
        ? scanFormLine20OtherDeductionsTotal(text, "1120")
        : undefined);
    const stmtCap = stmt2Total ?? globalStmt2;
    if (stmtCap !== undefined) {
      const primary =
        (out.values.bank_credit_card ?? 0) +
        (out.values.professional_fees ?? 0) +
        (out.values.utilities ?? 0);
      const cap = stmtCap - primary;
      if (cap > 0 && opex > cap * 1.05) opex = cap;
      if (opex >= stmtCap * 0.8 || cap < 1000) {
        opex = 0;
      }
    }
    if (opex >= 1000 && isReasonableMoneyAmount(opex)) {
      const plausibilityCtx = {
        stmt2Total: stmtCap,
        knownStmt2Lines:
          (out.values.bank_credit_card ?? 0) +
          (out.values.professional_fees ?? 0) +
          (out.values.utilities ?? 0),
      };
      if (
        stmtCap !== undefined &&
        (opex >= stmtCap * 0.45 || !isPlausibleOtherOperatingExpense(Math.round(opex), plausibilityCtx))
      ) {
        opex = 0;
      }
    }
    if (opex >= 1000 && isReasonableMoneyAmount(opex)) {
      out.values.other_operating_expenses = Math.round(opex);
      out.confidence.other_operating_expenses = 90;
      out.sources.other_operating_expenses = "Statement 2 (summed detail lines)";
    }
  } else if (
    otherDeductionSum === 0 &&
    stmt2Total !== undefined &&
    out.values.other_operating_expenses === undefined
  ) {
    const primary =
      (out.values.bank_credit_card ?? 0) +
      (out.values.professional_fees ?? 0) +
      (out.values.utilities ?? 0);
    const residual = Math.round(stmt2Total - primary);
    if (residual >= 1000 && residual <= stmt2Total && isReasonableMoneyAmount(residual)) {
      out.values.other_operating_expenses = residual;
      out.confidence.other_operating_expenses = 88;
      out.sources.other_operating_expenses = "Statement 2 total minus bank/professional/utilities";
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

    if (
      /taxes\s+and\s+licenses/i.test(line) &&
      (/statement\s*[12]|stmt\s*[12]|line\s*12|line\s*17/i.test(line) ||
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
      paidSum += amt;
    } else if (/based\s+on\s+income/i.test(line)) {
      stateIncomeLines += 1;
      paidSum += amt;
    } else if (/payroll\s+tax|sales\s+and\s+use|property\s+tax|franchise|excise/i.test(line)) {
      licensesSum += amt;
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
          for (const n of lineMoneyTokens(line)) {
            const abs = Math.round(Math.abs(n));
            if (abs >= 10 && isReasonableMoneyAmount(abs)) {
              opexDetail += abs;
              break;
            }
          }
        }
        continue;
      }
      const abs = Math.round(Math.abs(amt));
      if (abs < 100) continue;

      if (/utilities?\b/i.test(line)) utilities = abs;
      else if (/merchant\s+svc|credit\s+card/i.test(line)) merchant = abs;
      else if (/auto\s+and\s+truck/i.test(line)) autoTruck = abs;
      else if (/licenses?\s+and\s+permits/i.test(line)) licenses = abs;
    }

    if (stmt3Total === undefined || stmt3Total < 15_000) continue;
    const subtractive = Math.round(stmt3Total - utilities - autoTruck - licenses - merchant);
    const detailOpex =
      opexDetail >= 500 && opexDetail <= stmt3Total * 0.5 ? Math.round(opexDetail) : undefined;
    const opex =
      detailOpex !== undefined &&
      subtractive >= 1_000 &&
      detailOpex <= subtractive * 1.2
        ? detailOpex
        : subtractive;
    if (opex >= 1_000 && opex <= stmt3Total * 0.95) {
      if (bestOpex === undefined || opex > bestOpex) bestOpex = opex;
    }
  }

  if (bestOpex === undefined) return out;

  out.values.other_operating_expenses = bestOpex;
  out.confidence.other_operating_expenses = bestOpex >= 10_000 ? 94 : 91;
  out.sources.other_operating_expenses =
    bestOpex >= 10_000
      ? "Statement 3 (total minus util/merchant/auto/licenses)"
      : "Statement 3 (detail or residual)";
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
    const header = m[0].slice(0, 280);
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
      const amt = statementLineAmount(line);
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
