/**
 * Form 8990 / IRC §163(j) instruction crumbs — context only (no bare <$200 / <$5k floors).
 * Exact amount `163` is the Code section number on Form 8990 / limitation worksheets — never dollars.
 */
export function isInterestInstructionCrumb(amount: number, source: string): boolean {
  if (Math.round(amount) === 163) return true;
  const src = source ?? "";
  return /million|form\s*8990|see instructions|163\s*\(\s*j\s*\)|section\s*163|business\s+interest\s+(?:expense\s+)?limitation|irc\s*§?\s*163/i.test(
    src,
  );
}
