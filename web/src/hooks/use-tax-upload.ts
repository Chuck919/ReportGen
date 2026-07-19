"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { parseTaxReturnFiles } from "@/lib/api/parse-tax-return";
import type { OcrMode } from "@/lib/api/types";
import { defaultOcrMode } from "@/lib/tax/ocr-modes";
import { mergeParsedTaxYears } from "@/lib/tax/client-merge";
import { finalizeTaxColumns } from "@/lib/tax/merge-years";
import { detectDuplicateYears, summarizeReupload } from "@/lib/tax/parse-quality";
import { clearTaxColumnsStorage, loadTaxSession, saveTaxColumns, saveTaxProgress } from "@/lib/tax/session-storage";
import { validateClientFileList } from "@/lib/tax/validate-upload";
import { applyUserFieldCorrection, applyUserFieldVerification } from "@/lib/tax/apply-user-correction";
import type { TaxYearValues } from "@/lib/tax-workbook";

export function useTaxUpload() {
  const [columns, setColumns] = useState<TaxYearValues[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progressLabel, setProgressLabel] = useState("");
  const [progressPercent, setProgressPercent] = useState<number | undefined>();
  const [progressHint, setProgressHint] = useState<string | undefined>();
  const [ocrMode, setOcrMode] = useState<OcrMode>(defaultOcrMode());
  const [batchWarnings, setBatchWarnings] = useState<string[]>([]);
  const [fileErrors, setFileErrors] = useState<Array<{ filename: string; message: string }>>([]);
  const [partial, setPartial] = useState(false);
  const [queuedFiles, setQueuedFiles] = useState<File[]>([]);
  const [queueError, setQueueError] = useState("");
  const [clientName, setClientName] = useState<string | undefined>();

  useEffect(() => {
    const session = loadTaxSession();
    // Stored columns were finalized before save. Hydration must preserve that snapshot;
    // edits explicitly re-finalize from parserBaseline below.
    if (session.columns.length) setColumns(session.columns);
    if (session.clientName) setClientName(session.clientName);
    // Never restore busy — in-flight fetches do not survive reload/HMR.
    if (session.batchWarnings?.length) setBatchWarnings(session.batchWarnings);
    if (session.fileErrors?.length) setFileErrors(session.fileErrors);
    if (session.partial) setPartial(session.partial);
    if (session.error) setError(session.error);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveTaxColumns(columns);
  }, [columns, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    saveTaxProgress({
      busy,
      progressLabel,
      progressPercent,
      progressHint,
      error,
      batchWarnings,
      fileErrors,
      partial,
      columns,
      clientName,
    });
  }, [
    hydrated,
    busy,
    progressLabel,
    progressPercent,
    progressHint,
    error,
    batchWarnings,
    fileErrors,
    partial,
    columns,
    clientName,
  ]);

  const hasData = columns.length > 0;
  const canStart = queuedFiles.length > 0 && !busy;

  const addFiles = useCallback(
    (files: FileList | null) => {
      if (!files?.length || busy) return;
      setQueueError("");
      setError("");

      // Queue every selected year PDF (up to 10). Allowed while a workbook is present —
      // same company merges; different company clears via mergeParsedTaxYears (see client-merge).
      const list = Array.from(files);
      const validation = validateClientFileList(list);
      if (!validation.ok) {
        const msg = validation.checks.flatMap((c) => c.errors.map((e) => `${c.filename}: ${e}`)).join(" ");
        setQueueError(msg || "Invalid file");
        return;
      }

      setQueuedFiles(list);
    },
    [busy],
  );

  const removeQueuedFile = useCallback((index: number) => {
    setQueuedFiles((prev) => prev.filter((_, i) => i !== index));
    setQueueError("");
  }, []);

  const clearQueue = useCallback(() => {
    setQueuedFiles([]);
    setQueueError("");
  }, []);

  const startParse = useCallback(async () => {
    if (!queuedFiles.length || busy) return;
    setError("");
    setQueueError("");
    setBatchWarnings([]);
    setFileErrors([]);
    setPartial(false);
    setBusy(true);
    // Fresh timer for this run (survives tab switches via sessionStorage).
    try {
      sessionStorage.removeItem("reportgen-tax-parse-started-at");
      sessionStorage.removeItem("reportgen-tax-parse-last-elapsed-ms");
      sessionStorage.setItem("reportgen-tax-parse-started-at", String(Date.now()));
    } catch {
      /* ignore */
    }

    const list = [...queuedFiles];
    const existingYears = columns.map((c) => c.year);
    // Snapshot base columns so progressive merges do not race the final merge.
    const baseColumns = columns;

    try {
      const json = await parseTaxReturnFiles(
        list,
        {
          ocrMode,
          onTierParsed: (row) => {
            // Accumulate only — UI hides workbook until busy clears.
            setColumns((prev) => {
              const { columns: merged, warnings } = mergeParsedTaxYears(prev, [row]);
              if (warnings.length) setBatchWarnings((w) => [...w, ...warnings]);
              if (merged[0]?.clientName) setClientName(merged[0].clientName);
              return merged;
            });
          },
        },
        (progress) => {
          setProgressLabel(progress.label);
          setProgressPercent(progress.percent);
          setProgressHint(progress.hint);
        },
      );

      // mergeParsedTaxYears → mergeTaxYearsByYear already runs finalizeTaxColumns.
      // Calling finalize again re-ran align on rank-scrambled seat ids and forced the
      // taxes pool line to whatever amount sat in the taxes_licenses paste index.
      const { columns: merged, warnings: clientWarnings } = mergeParsedTaxYears(baseColumns, json.parsed);
      setColumns(merged);
      if (merged[0]?.clientName) setClientName(merged[0].clientName);
      setFileErrors(json.fileErrors ?? []);
      setPartial(Boolean(json.partial));
      setQueuedFiles([]);

      const dupWarnings = detectDuplicateYears(json.parsed);
      const reuploadNotes = summarizeReupload(existingYears, json.parsed);
      const notes = [...clientWarnings, ...(json.batchWarnings ?? []), ...dupWarnings, ...reuploadNotes];
      if (notes.length) setBatchWarnings(notes);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
      setProgressLabel("");
      setProgressPercent(undefined);
      setProgressHint(undefined);
    }
  }, [busy, columns, ocrMode, queuedFiles]);

  const clearAll = useCallback(() => {
    setColumns([]);
    clearTaxColumnsStorage();
    setError("");
    setBatchWarnings([]);
    setFileErrors([]);
    setPartial(false);
    setQueuedFiles([]);
    setQueueError("");
    setClientName(undefined);
  }, []);

  const updateField = useCallback((year: number, fieldId: string, value: number, source?: string) => {
    setColumns((prev) =>
      finalizeTaxColumns(
        prev.map((col) =>
          col.year === year ? applyUserFieldCorrection(col, fieldId, value, source) : col,
        ),
      ),
    );
  }, []);

  const verifyField = useCallback((year: number, fieldId: string, verified: boolean) => {
    setColumns((prev) =>
      finalizeTaxColumns(
        prev.map((col) =>
          col.year === year ? applyUserFieldVerification(col, fieldId, verified) : col,
        ),
      ),
    );
  }, []);

  const updateOpexSlotLabel = useCallback((slotId: string, label: string) => {
    const trimmed = label.trim();
    if (!trimmed) return;
    setColumns((prev) =>
      finalizeTaxColumns(
        prev.map((col) => ({
          ...col,
          userOpexSlotLabels: { ...(col.userOpexSlotLabels ?? {}), [slotId]: trimmed },
        })),
      ),
    );
  }, []);

  return useMemo(
    () => ({
      columns,
      hasData,
      error,
      queueError,
      busy,
      progressLabel,
      progressPercent,
      progressHint,
      ocrMode,
      setOcrMode,
      batchWarnings,
      fileErrors,
      partial,
      queuedFiles,
      canStart,
      clientName,
      addFiles,
      removeQueuedFile,
      clearQueue,
      startParse,
      clearAll,
      updateField,
      verifyField,
      updateOpexSlotLabel,
    }),
    [
      columns,
      hasData,
      error,
      queueError,
      busy,
      progressLabel,
      progressPercent,
      progressHint,
      ocrMode,
      batchWarnings,
      fileErrors,
      partial,
      queuedFiles,
      canStart,
      clientName,
      addFiles,
      removeQueuedFile,
      clearQueue,
      startParse,
      clearAll,
      updateField,
      verifyField,
      updateOpexSlotLabel,
    ],
  );
}
