"use client";

import { useEffect, useRef, useState } from "react";

export function useElapsedTimer(active: boolean) {
  const [elapsedMs, setElapsedMs] = useState(0);
  const startRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!active) {
      if (tickRef.current) clearInterval(tickRef.current);
      tickRef.current = null;
      setElapsedMs(0);
      return;
    }

    startRef.current = Date.now();
    tickRef.current = setInterval(() => setElapsedMs(Date.now() - startRef.current), 400);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [active]);

  return elapsedMs;
}
