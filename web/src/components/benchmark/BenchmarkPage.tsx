"use client";

import { useCallback, useMemo, useState } from "react";
import { parseBenchmarkFile } from "@/lib/api/parse-benchmark";
import type { ParseBenchmarkResponse } from "@/lib/api/types";
import {
  buildBenchmarkHeaderAndValuesTsv,
  buildBenchmarkTableTsv,
  buildBenchmarkValuesColumn,
} from "@/lib/benchmark-excel";
import { useElapsedTimer } from "@/hooks/use-elapsed-timer";
import { Container } from "@/components/ui/Container";
import { PageHeader } from "@/components/ui/PageHeader";
import { BenchmarkUploadPanel } from "./BenchmarkUploadPanel";
import { BenchmarkMetaCard } from "./BenchmarkMetaCard";
import { BenchmarkTable } from "./BenchmarkTable";

export function BenchmarkPage() {
  const [data, setData] = useState<ParseBenchmarkResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const elapsedMs = useElapsedTimer(busy);

  const clipboardPayloads = useMemo(() => {
    if (!data?.benchmarkRows.length) return null;
    return {
      fullTable: buildBenchmarkTableTsv(data.benchmarkRows),
      valuesColumn: buildBenchmarkValuesColumn(data.benchmarkRows),
      headerValueCol: buildBenchmarkHeaderAndValuesTsv(data.benchmarkRows),
    };
  }, [data]);

  const onFile = useCallback(async (file: File | null) => {
    if (!file) return;
    setError("");
    setData(null);
    setBusy(true);
    try {
      const json = await parseBenchmarkFile(file);
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setData(null);
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <Container className="py-10">
      <PageHeader
        title="Benchmark PDF"
        description="Upload IBIS-style industry reports. Extract financial ratios and common-size percentages for your Benchmark Entry sheet."
      />

      <BenchmarkUploadPanel onFile={onFile} busy={busy} elapsedMs={elapsedMs} error={error} />

      {data && (
        <div className="mt-6 space-y-4">
          <BenchmarkMetaCard data={data} clipboardPayloads={clipboardPayloads} />
          <BenchmarkTable rows={data.benchmarkRows} />
        </div>
      )}
    </Container>
  );
}
