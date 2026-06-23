"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { parseBenchmarkFile } from "@/lib/api/parse-benchmark";
import type { ParseBenchmarkResponse } from "@/lib/api/types";
import {
  clearBenchmarkSession,
  loadBenchmarkSession,
  saveBenchmarkSession,
} from "@/lib/benchmark/session-storage";

export function useBenchmarkUpload() {
  const [data, setData] = useState<ParseBenchmarkResponse | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progressLabel, setProgressLabel] = useState("");
  const [progressPercent, setProgressPercent] = useState<number | undefined>();

  useEffect(() => {
    const session = loadBenchmarkSession();
    if (session.data) setData(session.data);
    if (session.busy) {
      setBusy(session.busy);
      setProgressLabel(session.progressLabel ?? "");
      setProgressPercent(session.progressPercent);
      setError(session.error ?? "");
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveBenchmarkSession({
      data,
      busy,
      progressLabel,
      progressPercent,
      error,
    });
  }, [data, busy, progressLabel, progressPercent, error, hydrated]);

  const onFile = useCallback(async (file: File | null) => {
    if (!file) return;
    setError("");
    setData(null);
    setBusy(true);
    setProgressLabel("Parsing benchmark PDF…");
    setProgressPercent(12);
    try {
      const json = await parseBenchmarkFile(file);
      setData(json);
      setProgressPercent(100);
      setProgressLabel("Done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setData(null);
    } finally {
      setBusy(false);
      setTimeout(() => {
        setProgressLabel("");
        setProgressPercent(undefined);
      }, 800);
    }
  }, []);

  const clearAll = useCallback(() => {
    setData(null);
    setError("");
    setBusy(false);
    setProgressLabel("");
    setProgressPercent(undefined);
    clearBenchmarkSession();
  }, []);

  return useMemo(
    () => ({
      data,
      error,
      busy,
      progressLabel,
      progressPercent,
      onFile,
      clearAll,
    }),
    [data, error, busy, progressLabel, progressPercent, onFile, clearAll],
  );
}
