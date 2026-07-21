/** Shared SVG helpers — truncation, escaping, and layout QA for Word-bound charts. */

export function escapeSvg(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Truncate long labels for chart axes (prevents overlap in Word rasterization). */
export function truncateLabel(text: string, maxLen = 22): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen - 1)}…`;
}

export function wrapLabel(text: string, maxCharsPerLine = 18, maxLines = 2): string[] {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxCharsPerLine) {
      current = next;
    } else {
      if (current) lines.push(current);
      current = word.length > maxCharsPerLine ? truncateLabel(word, maxCharsPerLine) : word;
      if (lines.length >= maxLines - 1) break;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines.slice(0, maxLines);
}

export type ChartQaIssue = {
  chartId: string;
  severity: "warn" | "error";
  code: string;
  detail: string;
};

export function qaChartSvg(chartId: string, svg: string): ChartQaIssue[] {
  const issues: ChartQaIssue[] = [];
  if (!svg.includes("<svg")) {
    issues.push({ chartId, severity: "error", code: "missing-svg", detail: "Not valid SVG" });
    return issues;
  }
  const textNodes = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1] ?? "");
  for (const text of textNodes) {
    if (text.length > 48) {
      issues.push({
        chartId,
        severity: "warn",
        code: "long-label",
        detail: `Label may truncate in Word: "${text.slice(0, 60)}…"`,
      });
    }
    if (/\bNaN\b|undefined|\bnull\b/i.test(text)) {
      issues.push({ chartId, severity: "error", code: "bad-value", detail: `Invalid text node: ${text}` });
    }
  }
  const width = Number(svg.match(/\bwidth="(\d+)"/)?.[1] ?? 0);
  const height = Number(svg.match(/\bheight="(\d+)"/)?.[1] ?? 0);
  if (width > 900 || height > 700) {
    issues.push({ chartId, severity: "warn", code: "large-canvas", detail: `${width}×${height}px may overflow Word margins` });
  }
  if (width < 400 || height < 120) {
    issues.push({ chartId, severity: "warn", code: "small-canvas", detail: `${width}×${height}px may be hard to read` });
  }
  return issues;
}
