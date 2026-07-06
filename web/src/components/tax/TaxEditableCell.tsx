"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { formatTableNumber } from "@/lib/tax-workbook";
import type { FieldCandidateOption } from "@/lib/tax/correction-storage";
import { parseEditedNumber } from "@/lib/tax/apply-user-correction";
import type { FieldTrustTier } from "@/lib/tax/field-trust-tier";
import { trustTierCellClass } from "@/lib/tax/field-trust-tier";
import type { FormulaMismatchHint } from "@/lib/tax/workbook-display";

type Props = {
  value: number | null;
  tier: FieldTrustTier;
  tooltip?: string;
  needsReview: boolean;
  verified: boolean;
  options?: FieldCandidateOption[];
  className?: string;
  hint?: ReactNode;
  formulaHints?: FormulaMismatchHint[];
  onCommit: (value: number, source?: string) => void;
  onVerifyToggle: (verified: boolean) => void;
};

function FormulaMismatchHints({ hints }: { hints: FormulaMismatchHint[] }) {
  if (!hints.length) return null;
  return (
    <div className="mt-0.5 space-y-0.5 text-right">
      {hints.map((h) => (
        <p key={h.kind} className="text-[10px] leading-tight text-amber-800">
          {h.label}: {formatTableNumber(h.referenceValue)}
        </p>
      ))}
    </div>
  );
}

export function TaxEditableCell({
  value,
  tier,
  tooltip,
  needsReview,
  verified,
  options = [],
  className = "",
  hint,
  formulaHints = [],
  onCommit,
  onVerifyToggle,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!editing) return;
    setDraft(value == null ? "" : String(Math.round(value)));
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps -- draft only when entering edit mode

  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const id = window.setTimeout(() => {
      el.focus();
      el.select();
    }, 0);
    return () => window.clearTimeout(id);
  }, [editing]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const commitDraft = () => {
    setEditing(false);
    const parsed = parseEditedNumber(draft);
    if (parsed === null) return;
    if (value !== null && parsed === Math.round(value)) return;
    onCommit(parsed, "User correction");
  };

  const displayTier: FieldTrustTier = verified ? "user-confirmed" : tier;
  const showReviewMark = needsReview && !verified;
  const showOptions = options.length > 0 && !verified;

  const cellClass = [
    "relative px-2 py-2 text-right font-mono tabular-nums align-top",
    className,
    trustTierCellClass(displayTier),
    verified ? "ring-1 ring-inset ring-indigo-400" : "",
    showReviewMark ? "ring-1 ring-inset ring-amber-400/80" : "",
    value == null && !verified ? "ring-1 ring-inset ring-stone-300 border-dashed" : "",
    formulaHints.length ? "ring-1 ring-inset ring-amber-300/70" : "",
  ].join(" ");

  const verifyBox = (
    <button
      type="button"
      role="checkbox"
      aria-checked={verified}
      aria-label={verified ? "Verified — click to unmark" : "Mark as verified"}
      title={verified ? "Verified by you" : "Click to verify this value"}
      className={[
        "h-4 w-4 shrink-0 rounded border transition-colors",
        verified
          ? "border-indigo-500 bg-indigo-500 text-white"
          : "border-stone-300 bg-white hover:border-indigo-400 hover:bg-indigo-50",
      ].join(" ")}
      onClick={(e) => {
        e.stopPropagation();
        onVerifyToggle(!verified);
      }}
    >
      {verified ? (
        <svg viewBox="0 0 12 12" className="h-full w-full p-0.5" aria-hidden>
          <path
            fill="currentColor"
            d="M10.2 3.2a.75.75 0 0 1 0 1.06l-5 5a.75.75 0 0 1-1.06 0l-2.5-2.5a.75.75 0 1 1 1.06-1.06L4.7 7.64l4.47-4.47a.75.75 0 0 1 1.06 0Z"
          />
        </svg>
      ) : null}
    </button>
  );

  if (!editing) {
    return (
      <td title={tooltip} className={cellClass}>
        <div className="flex flex-col items-end gap-0.5">
          <div className="flex items-center justify-end gap-1.5">
            {showOptions ? (
              <div className="relative" ref={menuRef}>
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
              onMouseDown={(e) => {
                e.preventDefault();
                setEditing(true);
              }}
            >
              {value == null ? (
                <span className="italic text-stone-400">—</span>
              ) : (
                <>
                  {formatTableNumber(value)}
                  {showReviewMark ? (
                    <span className="ml-1 text-[10px] font-sans font-semibold text-amber-700">?</span>
                  ) : null}
                </>
              )}
            </button>
            {verifyBox}
          </div>
          <FormulaMismatchHints hints={formulaHints} />
          {!verified ? hint : null}
        </div>
      </td>
    );
  }

  return (
    <td title={tooltip} className={cellClass}>
      <div className="flex flex-col items-end gap-0.5">
        <div className="flex w-full items-center justify-end gap-1.5">
          <input
            ref={inputRef}
            type="text"
            inputMode="decimal"
            className="min-w-0 flex-1 rounded border border-indigo-300 bg-white px-2 py-1 text-right font-mono text-sm tabular-nums outline-none ring-2 ring-indigo-200"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => {
              const el = e.target;
              window.setTimeout(() => el.select(), 0);
            }}
            onClick={(e) => {
              const el = e.currentTarget;
              if (document.activeElement === el) el.select();
            }}
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
          {verifyBox}
        </div>
        <FormulaMismatchHints hints={formulaHints} />
      </div>
    </td>
  );
}
