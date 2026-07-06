"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  slotId: string;
  label: string;
  onCommit: (slotId: string, label: string) => void;
};

/** Inline editor for the eight shared operating-expense row titles. */
export function OpexSlotLabelCell({ slotId, label, onCommit }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) {
      setDraft(label);
      return;
    }
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [editing, label]);

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (!trimmed || trimmed === label) return;
    onCommit(slotId, trimmed);
  };

  if (!editing) {
    return (
      <button
        type="button"
        className="rounded px-1 py-0.5 text-left hover:bg-indigo-50 hover:text-indigo-900"
        title="Click to rename this expense row (applies to all years)"
        onClick={() => setEditing(true)}
      >
        {label}
        <span className="ml-1 text-[10px] text-stone-400">✎</span>
      </button>
    );
  }

  return (
    <input
      ref={inputRef}
      type="text"
      className="w-full min-w-[10rem] rounded border border-indigo-300 bg-white px-2 py-1 text-sm outline-none ring-2 ring-indigo-200"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
        if (e.key === "Escape") {
          setEditing(false);
          setDraft(label);
        }
      }}
    />
  );
}
