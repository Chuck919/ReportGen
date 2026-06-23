"use client";

import { useMemo } from "react";
import { useAppSession } from "@/components/providers/AppSessionProvider";
import {
  buildBenchmarkExcelPaste,
  buildBenchmarkValuesColumn,
} from "@/lib/benchmark-excel";
import { useElapsedTimer } from "@/hooks/use-elapsed-timer";
import { Container } from "@/components/ui/Container";
import { PageHeader } from "@/components/ui/PageHeader";
import { BenchmarkUploadPanel } from "./BenchmarkUploadPanel";
import { BenchmarkMetaCard } from "./BenchmarkMetaCard";
import { BenchmarkTable } from "./BenchmarkTable";

export function BenchmarkPage() {
  const { benchmark } = useAppSession();
  const { data, error, busy, progressLabel, progressPercent, onFile } = benchmark;

  const elapsedMs = useElapsedTimer(busy);

  const clipboardPayloads = useMemo(() => {
    if (!data?.benchmarkRows.length) return null;
    return {
      valuesColumn: buildBenchmarkValuesColumn(data.benchmarkRows),
      withHeaders: buildBenchmarkExcelPaste(data.benchmarkRows),
    };
  }, [data]);

  return (
    <Container className="py-10">
      <PageHeader
        title="Benchmark PDF"
        description="Upload IBIS-style industry reports. Paste layout matches the full Benchmark Entry workbook (all rows, blank lines between sections)."
      />

      <BenchmarkUploadPanel
        onFile={onFile}
        busy={busy}
        elapsedMs={elapsedMs}
        error={error}
        progressLabel={progressLabel}
        progressPercent={progressPercent}
      />

      {data && (
        <div className="mt-6 space-y-4">
          <BenchmarkMetaCard data={data} clipboardPayloads={clipboardPayloads} />
          <BenchmarkTable rows={data.benchmarkRows} />
        </div>
      )}
    </Container>
  );
}
