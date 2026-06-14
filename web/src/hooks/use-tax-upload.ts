"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { parseTaxReturnFiles } from "@/lib/api/parse-tax-return";
import type { OcrMode } from "@/lib/api/types";
import { defaultOcrMode } from "@/lib/tax/ocr-modes";
import { mergeTaxYearsByYear } from "@/lib/tax/merge-years";
import { detectDuplicateYears, summarizeReupload } from "@/lib/tax/parse-quality";
import { clearTaxColumnsStorage, loadTaxColumns, saveTaxColumns } from "@/lib/tax/session-storage";
import type { TaxYearValues } from "@/lib/tax-workbook";

export function useTaxUpload() {
  const [columns, setColumns] = useState<TaxYearValues[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progressLabel, setProgressLabel] = useState("");
  const [progressPercent, setProgressPercent] = useState<number | undefined>();
  const [ocrMode, setOcrMode] = useState<OcrMode>(defaultOcrMode());
  const [batchWarnings, setBatchWarnings] = useState<string[]>([]);
  const [fileErrors, setFileErrors] = useState<Array<{ filename: string; message: string }>>([]);
  const [partial, setPartial] = useState(false);

  useEffect(() => {
    const saved = loadTaxColumns();
    if (saved.length) setColumns(saved);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveTaxColumns(columns);
  }, [columns, hydrated]);

  const hasData = columns.length > 0;

  const onFiles = useCallback(
    async (files: FileList | null) => {
      if (!files?.length) return;
      setError("");
      setBatchWarnings([]);
      setFileErrors([]);
      setPartial(false);
      setBusy(true);

      const list = Array.from(files);
      const existingYears = columns.map((c) => c.year);

      try {
        const json = await parseTaxReturnFiles(
          list,
          {
            ocrMode,
            onTierParsed: (row) => {
              setColumns((prev) => mergeTaxYearsByYear(prev, [row]));
            },
          },
          (progress) => {
            setProgressLabel(progress.label);
            setProgressPercent(progress.percent);
          },
        );

        setColumns((prev) => mergeTaxYearsByYear(prev, json.parsed));
        setFileErrors(json.fileErrors ?? []);
        setPartial(Boolean(json.partial));

        const dupWarnings = detectDuplicateYears(json.parsed);
        const reuploadNotes = summarizeReupload(existingYears, json.parsed);
        const notes = [...(json.batchWarnings ?? []), ...dupWarnings, ...reuploadNotes];
        if (notes.length) setBatchWarnings(notes);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Upload failed");
      } finally {
        setBusy(false);
        setProgressLabel("");
        setProgressPercent(undefined);
      }
    },
    [columns, ocrMode],
  );

  const clearAll = useCallback(() => {
    setColumns([]);
    clearTaxColumnsStorage();
    setError("");
    setBatchWarnings([]);
    setFileErrors([]);
    setPartial(false);
  }, []);

  return useMemo(
    () => ({
      columns,
      hasData,
      error,
      busy,
      progressLabel,
      progressPercent,
      ocrMode,
      setOcrMode,
      batchWarnings,
      fileErrors,
      partial,
      onFiles,
      clearAll,
    }),
    [
      columns,
      hasData,
      error,
      busy,
      progressLabel,
      progressPercent,
      ocrMode,
      batchWarnings,
      fileErrors,
      partial,
      onFiles,
      clearAll,
    ],
  );
}
