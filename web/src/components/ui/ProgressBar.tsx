import { formatElapsed } from "@/lib/ui/format-elapsed";

export function ProgressBar({
  label,
  elapsedMs,
  percent,
  hint,
}: {
  label: string;
  elapsedMs: number;
  percent?: number;
  hint?: string;
}) {
  const width = percent != null ? Math.max(8, Math.min(100, percent)) : undefined;
  return (
    <div className="rounded-xl bg-stone-100 px-4 py-4">
      <div className="flex justify-between text-sm font-medium text-stone-800">
        <span>{label}</span>
        <span className="tabular-nums text-stone-500">{formatElapsed(elapsedMs)}</span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-stone-200">
        <div
          className={[
            "h-full rounded-full bg-stone-800 transition-all duration-500",
            width == null ? "w-full animate-pulse" : "",
          ].join(" ")}
          style={width != null ? { width: `${width}%` } : undefined}
        />
      </div>
      {hint && <p className="mt-2 text-xs text-stone-500">{hint}</p>}
    </div>
  );
}
