"use client";

import { confidenceFlagMessage, flagCodeInText } from "@/lib/tax-confidence/confidence-flags";

function humanizeFlag(raw: string): string {
  const code = flagCodeInText(raw);
  if (code) return confidenceFlagMessage(code);
  if (raw.length < 64) return raw;
  return `${raw.slice(0, 61)}…`;
}

type Props = {
  displayConfidence?: number;
  flags?: string[];
  compact?: boolean;
};

export function FieldConfidenceHint({ displayConfidence, flags, compact }: Props) {
  const warningFlags = (flags ?? []).filter((f) =>
    /candidate_conflict|source_disagreement|formula_inconsistency|ocr_incomplete|comparison_missing|stmt2_missing|verify manually|other reads|subtractive/i.test(
      f,
    ),
  );
  const showConfidence =
    displayConfidence !== undefined && (displayConfidence < 75 || warningFlags.length > 0);
  if (!showConfidence && !warningFlags.length) return null;

  const topFlags = warningFlags.slice(0, compact ? 1 : 3);

  return (
    <div className="mt-0.5 space-y-0.5 text-left font-sans">
      {showConfidence ? (
        <p className="text-[10px] tabular-nums text-stone-500">Confidence: {displayConfidence}%</p>
      ) : null}
      {topFlags.map((flag) => (
        <p key={flag} className="text-[10px] leading-tight text-amber-800">
          ⚠ {humanizeFlag(flag)}
        </p>
      ))}
    </div>
  );
}

export function formatFlagsForTooltip(flags?: string[]): string | undefined {
  if (!flags?.length) return undefined;
  return flags.map(humanizeFlag).join("\n");
}
