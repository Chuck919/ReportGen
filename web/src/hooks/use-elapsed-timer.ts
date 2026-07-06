"use client";

import { useEffect, useState } from "react";

const START_KEY = "reportgen-tax-parse-started-at";
const FINAL_KEY = "reportgen-tax-parse-last-elapsed-ms";

function readStart(): number | null {
  if (typeof window === "undefined") return null;
  const stored = sessionStorage.getItem(START_KEY);
  if (!stored) return null;
  const n = Number(stored);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function readFinal(): number {
  if (typeof window === "undefined") return 0;
  const stored = sessionStorage.getItem(FINAL_KEY);
  if (!stored) return 0;
  const n = Number(stored);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Elapsed timer that survives tab switches (sessionStorage start time) and
 * keeps showing the final duration after `active` becomes false.
 */
export function useElapsedTimer(active: boolean): number {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;

    if (active) {
      sessionStorage.removeItem(FINAL_KEY);
      let startAt = readStart();
      if (startAt == null) {
        startAt = Date.now();
        sessionStorage.setItem(START_KEY, String(startAt));
      }
      setElapsedMs(Math.max(0, Date.now() - startAt));
      const id = setInterval(() => {
        setElapsedMs(Math.max(0, Date.now() - startAt!));
      }, 400);
      return () => clearInterval(id);
    }

    // Finished or idle: freeze duration and persist for tab switches after completion.
    const startAt = readStart();
    if (startAt != null) {
      const total = Math.max(0, Date.now() - startAt);
      setElapsedMs(total);
      sessionStorage.setItem(FINAL_KEY, String(total));
      sessionStorage.removeItem(START_KEY);
      return;
    }
    setElapsedMs(readFinal());
  }, [active]);

  return elapsedMs;
}
