/** Infer tax year from document text; filename is last resort. */
export function inferTaxYear(filename: string, text: string): number | null {
  const phraseRes = [
    /(?:tax\s+year|calendar\s+year|for\s+(?:the\s+)?calendar\s+year|taxable\s+year)\s*[:\s.-]+\s*(20\d{2})\b/i,
    /(?:year\s+ended|ending|ended)\s+(?:[a-z]{3,9}\.?\s+\d{1,2},?\s+)?(20\d{2})\b/i,
    /\b(?:dec|december)\.?\s+\d{1,2},?\s+(20\d{2})\b/i,
    /\bform\s+1120[^0-9]{0,48}(20\d{2})\b/i,
    /\breturn\s+summary[^0-9]{0,120}(20\d{2})\b/i,
    /\b(20\d{2})\s+(?:tax\s+return|u\.?s\.?\s+return)\b/i,
  ];

  for (const re of phraseRes) {
    const m = text.match(re);
    if (m) {
      const y = Number(m[1]);
      if (y >= 2000 && y <= 2100) return y;
    }
  }

  const twoYear = text.match(/\b(20\d{2})\s*[\&\-–]\s*(20\d{2})\b/);
  if (twoYear) {
    const ys = [Number(twoYear[1]), Number(twoYear[2])].filter((y) => y >= 2000 && y <= 2100);
    if (ys.length) return Math.max(...ys);
  }

  const years = (text.match(/\b20\d{2}\b/g) ?? []).map(Number).filter((y) => y >= 2000 && y <= 2100);
  if (years.length) {
    if (/comparison|two\s*year|worksheet/i.test(text)) return Math.max(...years);
    const counts = new Map<number, number>();
    for (const y of years) counts.set(y, (counts.get(y) ?? 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  }

  const fromName = filename.match(/(20\d{2})/g);
  if (fromName?.length) {
    const ys = Array.from(new Set(fromName.map(Number))).filter((y) => y >= 2000 && y <= 2100);
    if (ys.length) return Math.max(...ys);
  }

  return null;
}
