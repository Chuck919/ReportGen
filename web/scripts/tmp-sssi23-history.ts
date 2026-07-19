/** Check sssi 2023 results across recent live bench JSONs. */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const dir = "scripts/benchmark-output";
const files = readdirSync(dir)
  .filter((f) => f.startsWith("ui-session-live-") && f.endsWith(".json"))
  .sort();
for (const f of files) {
  try {
    const j = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    const s = (j.results as Array<Record<string, unknown>>)?.find((r) => r.client === "sssi");
    if (!s) {
      console.log(f, "— no sssi");
      continue;
    }
    const fp = (s.fieldPctByYear as Record<string, number>)?.["2023"];
    const op = (s.opexPctByYear as Record<string, number>)?.["2023"];
    const misses = ((s.misses as string[]) ?? []).filter((m) => m.startsWith("2023"));
    console.log(`${f} | 2023 field=${fp?.toFixed(1)} opex=${op?.toFixed(1)} | ${misses.join(" ;; ") || "clean"}`);
  } catch {
    console.log(f, "— unreadable");
  }
}
