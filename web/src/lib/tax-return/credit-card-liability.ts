/**
 * Schedule L line-18 attachment whose detail is only credit-card / revolving payables.
 * Integrator worksheets book these as short_term_debt (not other_current_liabilities).
 * Mixed liability statements (accruals, tax payables, deposits, …) stay on OCL.
 */
export function statementBlockIsCreditCardPayables(stmtBlock: string): boolean {
  // Truncate at TOTAL or the next Statement header so later stmts (COGS / payroll) don't pollute.
  const truncated = truncateLine18AttachmentBlock(stmtBlock);
  const detailLines = truncated
    .split(/\n/)
    .map((r) => r.replace(/\s+/g, " ").trim())
    .filter(
      (r) =>
        r.length > 0 &&
        !/^total\b/i.test(r) &&
        !/^(?:statement|stmt|description|beginning|end)\b/i.test(r),
    );
  const moneyLines = detailLines.filter(
    (r) => /\d/.test(r) && !/form\s*1120|schedule\s*l|page\s*\d/i.test(r),
  );
  if (!moneyLines.length) return /credit\s+cards?\s+payable/i.test(truncated);
  const credit = moneyLines.filter((r) =>
    /credit\s+cards?\s+payable|revolving\s+(?:credit|payable)|visa|mastercard|amex/i.test(r),
  );
  const otherLiab = moneyLines.filter(
    (r) =>
      !/credit\s+cards?\s+payable|revolving\s+(?:credit|payable)|visa|mastercard|amex|description|amount|beginning|end|of\s+year/i.test(
        r,
      ) &&
      /\b(payable|accrued|deposit|liabilit|loan|note|payroll|sales\s+tax|deferred|liquor\s+tax)\b/i.test(
        r,
      ),
  );
  return credit.length > 0 && otherLiab.length === 0;
}

/** Keep only the Line-18 attachment body (through its TOTAL). */
function truncateLine18AttachmentBlock(stmtBlock: string): string {
  const rows = stmtBlock.split(/\n/);
  const out: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const line = rows[i]!.replace(/\s+/g, " ").trim();
    if (i > 0 && /^(?:statement|stmt)\s*\d/i.test(line)) break;
    out.push(rows[i]!);
    if (/^total\b/i.test(line)) break;
  }
  return out.join("\n");
}

export function statementLine18IsCreditCardPayables(text: string, stmtNum: string): boolean {
  const re = new RegExp(`(?:statement|stmt)\\s*${stmtNum}\\b[\\s\\S]{0,1200}`, "i");
  const m = text.match(re);
  if (!m) return false;
  return statementBlockIsCreditCardPayables(m[0]);
}

/**
 * True when any Schedule L line-18 attachment in `text` is credit-card-only.
 * Uses line-anchored slices (avoids catastrophic `matchAll` over huge OCR).
 */
export function textHasCreditCardLine18Attachment(text: string): boolean {
  const lines = text.split(/\n/);
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]!.replace(/\s+/g, " ").trim();
    if (
      /(?:statement|stmt)\s*\d/i.test(header) &&
      /line\s*18|other\s+curren|current\s+liabilit/i.test(header)
    ) {
      const block = lines.slice(i, i + 40).join("\n");
      if (statementBlockIsCreditCardPayables(block)) return true;
    }
    // Schedule L pointer row: "18 Other current liabilities … STMT N"
    const ptr = header.match(
      /(?:^|\b)18\b.{0,80}other\s+curren.{0,40}(?:stmt|statement)\s*(\d+)/i,
    );
    if (ptr?.[1] && statementLine18IsCreditCardPayables(text, ptr[1])) return true;
  }
  return false;
}
