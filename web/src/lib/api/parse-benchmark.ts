import type { ParseBenchmarkResponse } from "./types";

export async function parseBenchmarkFile(file: File): Promise<ParseBenchmarkResponse> {
  const fd = new FormData();
  fd.set("file", file);

  const res = await fetch("/api/parse-report", { method: "POST", body: fd });
  const json = (await res.json()) as ParseBenchmarkResponse;
  if (!res.ok) {
    throw new Error(json.error || "Upload failed");
  }
  return json;
}
