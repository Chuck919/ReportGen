import { computeWorkbookFormulas } from "@/lib/tax/workbook-formulas";
import type { TaxYearValues } from "@/lib/tax-workbook";
import type { CompanyProfile } from "@/lib/valuation/company-profile";

export type BalanceSheetFootnotes = {
  Acct_rec_note: string;
  invent_note: string;
  intang_note: string;
  longterm_liab_note: string;
  net_dep_note: string;
  other_curr_note: string;
  account_pay_note: string;
  curr_port_ltd_note: string;
  short_term_note: string;
  other_curr_liab_note: string;
  other_note: string;
};

function money(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function pct(value: number, total: number): string {
  if (!total) return "";
  return `${((value / total) * 100).toFixed(0)}%`;
}

function latestColumn(columns: TaxYearValues[]): TaxYearValues | undefined {
  return [...columns].sort((a, b) => a.year - b.year).at(-1);
}

function priorColumn(columns: TaxYearValues[]): TaxYearValues | undefined {
  const sorted = [...columns].sort((a, b) => a.year - b.year);
  return sorted.length >= 2 ? sorted[sorted.length - 2] : undefined;
}

/** Rule-based B/S footnote prose from tax data (+ optional user normalization hints). */
export function buildBalanceSheetFootnotes(
  columns: TaxYearValues[],
  profile?: Partial<CompanyProfile>,
): BalanceSheetFootnotes {
  const empty: BalanceSheetFootnotes = {
    Acct_rec_note: "",
    invent_note: "",
    intang_note: "",
    longterm_liab_note: "",
    net_dep_note: "",
    other_curr_note: "",
    account_pay_note: "",
    curr_port_ltd_note: "",
    short_term_note: "",
    other_curr_liab_note: "",
    other_note: "",
  };

  const latest = latestColumn(columns);
  if (!latest) return empty;

  const raw = latest.workbookValues ?? latest.values;
  const comp = computeWorkbookFormulas(raw);
  const prior = priorColumn(columns);
  const priorRaw = prior ? prior.workbookValues ?? prior.values : {};
  const priorComp = prior ? computeWorkbookFormulas(priorRaw) : {};

  const sales = raw.sales ?? comp.sales ?? 0;
  const assets = comp.total_assets ?? raw.total_assets ?? 0;
  const equity = comp.total_equity ?? raw.total_equity ?? 0;
  const liabilities = comp.total_liabilities ?? raw.total_liabilities ?? 0;

  const ar = comp.accounts_receivable ?? raw.accounts_receivable ?? 0;
  const inventory = comp.inventory ?? raw.inventory ?? 0;
  const otherCurrent = comp.other_current_assets ?? raw.other_current_assets ?? 0;
  const ap = comp.accounts_payable ?? raw.accounts_payable ?? 0;
  const stDebt = comp.short_term_debt ?? raw.short_term_debt ?? 0;
  const currPortLtd = comp.current_portion_long_term_debt ?? raw.current_portion_long_term_debt ?? 0;
  const otherCurrLiab = comp.other_current_liabilities ?? raw.other_current_liabilities ?? 0;
  const ltd = comp.long_term_liabilities ?? raw.long_term_liabilities ?? 0;
  const netFixed = comp.net_fixed_assets ?? 0;
  const grossFixed = comp.gross_fixed_assets ?? raw.gross_fixed_assets ?? 0;
  const accumDep = comp.accumulated_depreciation ?? raw.accumulated_depreciation ?? 0;
  const intangNet = Math.max((raw.gross_intangible_assets ?? 0) - (raw.accumulated_amortization ?? 0), 0);
  const depreciation = raw.depreciation ?? 0;

  const year = latest.year;

  let Acct_rec_note = "";
  if (ar <= 0) {
    Acct_rec_note = `Accounts receivable were not material at ${year} year-end (cash or point-of-sale collections likely dominate).`;
  } else {
    const arPct = sales > 0 ? (ar / sales) * 100 : 0;
    Acct_rec_note = `Accounts receivable of ${money(ar)} (${arPct.toFixed(0)}% of sales) at ${year} year-end.`;
    if (arPct > 15) Acct_rec_note += " Receivable concentration warrants review of collectibility and aging.";
    else Acct_rec_note += " Balance appears consistent with reported revenue levels.";
  }

  let invent_note = "";
  if (inventory <= 0) {
    invent_note = `No inventory balance was reported at ${year} year-end (service or low-inventory model).`;
  } else {
    const invPct = sales > 0 ? (inventory / sales) * 100 : 0;
    invent_note = `Inventory of ${money(inventory)} (${invPct.toFixed(0)}% of sales) at ${year}.`;
    const priorInv = priorComp.inventory ?? priorRaw.inventory ?? 0;
    if (priorInv > 0 && inventory > priorInv * 1.25) invent_note += " Inventory increased materially year-over-year.";
    else if (priorInv > 0 && inventory < priorInv * 0.75) invent_note += " Inventory declined year-over-year.";
  }

  let intang_note = "";
  if (intangNet <= 0) {
    intang_note = "No separately reported intangible assets on the balance sheet.";
  } else {
    intang_note = `Net intangible assets of ${money(intangNet)} (${pct(intangNet, assets)} of total assets) at ${year}.`;
    if (profile?.normalizationNotes?.toLowerCase().includes("goodwill")) {
      intang_note += ` ${profile.normalizationNotes.trim()}`;
    }
  }

  let longterm_liab_note = "";
  if (ltd <= 0) {
    longterm_liab_note = `No long-term liabilities reported at ${year} year-end.`;
  } else {
    longterm_liab_note = `Long-term liabilities of ${money(ltd)} at ${year}`;
    if (equity > 0) longterm_liab_note += ` (${pct(ltd, equity)} of equity)`;
    longterm_liab_note += ".";
    if (liabilities > 0 && ltd / liabilities > 0.6) longterm_liab_note += " Debt is predominantly long-term in nature.";
  }

  let net_dep_note = "";
  if (grossFixed > 0 || netFixed > 0) {
    net_dep_note = `Net fixed assets of ${money(netFixed || grossFixed - accumDep)} at ${year}`;
    if (grossFixed > 0 && accumDep > 0) {
      net_dep_note += ` (gross ${money(grossFixed)}, accumulated depreciation ${money(accumDep)})`;
    }
    net_dep_note += ".";
    if (depreciation > 0) net_dep_note += ` Annual depreciation expense of ${money(depreciation)}.`;
  } else {
    net_dep_note = `Fixed asset base is modest at ${year}; depreciation is ${depreciation > 0 ? money(depreciation) : "not separately material"}.`;
  }

  let other_curr_note = "";
  if (otherCurrent <= 0) {
    other_curr_note = "Other current assets were not separately reported.";
  } else {
    other_curr_note = `Other current assets of ${money(otherCurrent)} at ${year} year-end.`;
  }

  let account_pay_note = "";
  if (ap <= 0) {
    account_pay_note = "Accounts payable were not separately reported or were immaterial.";
  } else {
    const cogs = raw.cogs ?? comp.cogs ?? 0;
    account_pay_note = `Accounts payable of ${money(ap)} at ${year}`;
    if (cogs > 0) account_pay_note += ` (${pct(ap, cogs)} of COGS)`;
    account_pay_note += ".";
  }

  let curr_port_ltd_note = "";
  if (currPortLtd <= 0) {
    curr_port_ltd_note = "No current portion of long-term debt reported.";
  } else {
    curr_port_ltd_note = `Current portion of long-term debt: ${money(currPortLtd)} at ${year}.`;
  }

  let short_term_note = "";
  if (stDebt <= 0) {
    short_term_note = "No short-term debt balance reported.";
  } else {
    short_term_note = `Short-term debt of ${money(stDebt)} at ${year} year-end.`;
  }

  let other_curr_liab_note = "";
  if (otherCurrLiab <= 0) {
    other_curr_liab_note = "Other current liabilities were not separately disclosed.";
  } else {
    other_curr_liab_note = `Other current liabilities of ${money(otherCurrLiab)} at ${year}.`;
  }

  let other_note = "";
  const otherNonCurrent = Math.max(liabilities - ap - stDebt - currPortLtd - otherCurrLiab - ltd, 0);
  if (otherNonCurrent > 1000) {
    other_note = `Residual non-current or unclassified liability items total approximately ${money(otherNonCurrent)}.`;
  } else {
    other_note = "No other material non-operating balance sheet items identified from tax return data.";
  }

  return {
    Acct_rec_note,
    invent_note,
    intang_note,
    longterm_liab_note,
    net_dep_note,
    other_curr_note,
    account_pay_note,
    curr_port_ltd_note,
    short_term_note,
    other_curr_liab_note,
    other_note,
  };
}
