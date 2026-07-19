/**
 * Form 8990 / IRC §163(j) instruction crumbs — context only (no bare <$200 / <$5k floors).
 * Exact $163 from a weak OCR caption is the Code section number bleed, not interest dollars;
 * a real Form/Stmt interest line carries a Form/statement source and is kept even at $163.
 */
export function isInterestInstructionCrumb(amount: number, source: string): boolean {
  const src = source ?? "";
  if (
    /million|form\s*8990|see instructions|163\s*\(\s*j\s*\)|section\s*163|business\s+interest\s+(?:expense\s+)?limitation|irc\s*§?\s*163/i.test(
      src,
    )
  ) {
    return true;
  }
  return Math.round(amount) === 163 && /OCR label match|fuzzy|tail scan/i.test(src);
}
