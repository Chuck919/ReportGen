"use client";

import { useEffect, useId, useRef, useState } from "react";
import { formatTableNumber } from "@/lib/tax-workbook";
import type { FieldCandidateOption } from "@/lib/tax/correction-storage";
import { parseEditedNumber } from "@/lib/tax/apply-user-correction";
import type { FieldTrustTier } from "@/lib/tax/field-trust-tier";
import { trustTierCellClass } from "@/lib/tax/field-trust-tier";

type Props = {
  value: number | null;
  tier: FieldTrustTier;
  tooltip?: string;
  needsReview: boolean;
  userEdited?: boolean;
  options?: FieldCandidateOption[];
  displayConfidence?: number;
  flags?: string[];
  onCommit: (value: number, source?: string) => void;
};

export function TaxEditableCell({
  value,
  tier,
  tooltip,
  needsReview,
  userEdited,
  options = [],
  displayConfidence,
  flags: _flags,
  onCommit,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    if (editing) {
      setDraft(value == null ? "" : String(Math.round(value)));
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing, value]);

  const commitDraft = () => {
    setEditing(false);
    const parsed = parseEditedNumber(draft);
    if (parsed === null) return;
    if (value !== null && parsed === Math.round(value)) return;
    onCommit(parsed, "User correction");
  };

  const cellClass = [
    "relative px-2 py-2 text-right font-mono tabular-nums",
    trustTierCellClass(tier),
    userEdited ? "ring-1 ring-inset ring-indigo-400" : "",
    needsReview && value != null ? "ring-1 ring-inset ring-amber-400/80" : "",
    value == null ? "ring-1 ring-inset ring-stone-300 border-dashed" : "",
  ].join(" ");

  if (!editing) {
    return (
      <td title={tooltip} className={cellClass}>
        <div className="flex items-center justify-end gap-1">
          {options.length > 0 ? (
            <div className="relative">
              <button
                type="button"
                aria-label="Other values found"
                aria-expanded={menuOpen}
                aria-controls={listId}
                className="rounded px-1 text-[10px] font-sans text-stone-500 hover:bg-stone-100 hover:text-stone-800"
                onClick={() => setMenuOpen((o) => !o)}
              >
                ▾
              </button>
              {menuOpen ? (
                <ul
                  id={listId}
                  className="absolute right-0 z-20 mt-1 max-h-48 w-56 overflow-auto rounded-lg border border-stone-200 bg-white py-1 text-left text-xs shadow-lg"
                >
                  {options.map((opt) => (
                    <li key={`${opt.value}-${opt.source}`}>
                      <button
                        type="button"
                        className="block w-full px-3 py-1.5 hover:bg-indigo-50"
                        onClick={() => {
                          setMenuOpen(false);
                          onCommit(opt.value, `User selected: ${opt.source}`);
                        }}
                      >
                        <span className="font-mono tabular-nums">{formatTableNumber(opt.value)}</span>
                        <span className="mt-0.5 block truncate text-stone-500">{opt.source}</span>
                        {opt.totalScore !== undefined ? (
                          <span className="text-[10px] text-stone-400">score {opt.totalScore.toFixed(1)}</span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          <button
            type="button"
            className="min-w-[4.5rem] rounded px-2 py-0.5 text-right hover:bg-white/60"
            onClick={() => setEditing(true)}
          >
            {value == null ? (
              <span className="italic text-stone-400">—</span>
            ) : (
              <>
                {formatTableNumber(value)}
                {needsReview ? (
                  <span className="ml-1 text-[10px] font-sans font-semibold text-amber-700">?</span>
                ) : null}
              </>
            )}
          </button>
        </div>
      </td>
    );
  }

  return (
    <td title={tooltip} className={cellClass}>
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        className="w-full rounded border border-indigo-300 bg-white px-2 py-1 text-right font-mono text-sm tabular-nums outline-none ring-2 ring-indigo-200"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitDraft}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitDraft();
          }
          if (e.key === "Escape") {
            setEditing(false);
          }
        }}
      />
    </td>
  );
}
