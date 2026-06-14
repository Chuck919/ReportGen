"use client";

export function UploadResultSummary({
  batchWarnings,
  fileErrors,
  partial,
}: {
  batchWarnings: string[];
  fileErrors: Array<{ filename: string; message: string }>;
  partial: boolean;
}) {
  const notes = batchWarnings.filter(
    (w) => !w.includes("sequentially") && !w.includes("one file is processed"),
  );
  if (!notes.length && !fileErrors.length && !partial) return null;

  const top = fileErrors[0]?.message ?? notes[0];
  if (!top) return null;

  return (
    <p
      className={[
        "mt-4 rounded-lg px-4 py-3 text-sm",
        fileErrors.length ? "bg-amber-50 text-amber-900" : "bg-stone-50 text-stone-600",
      ].join(" ")}
      role="status"
    >
      {partial && fileErrors.length ? "Partial result — " : ""}
      {top}
      {fileErrors.length > 1 ? ` (+${fileErrors.length - 1} more)` : ""}
    </p>
  );
}
