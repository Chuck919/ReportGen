/**
 * Timed live UI-session for holdouts × OCR modes.
 * Reports per-PDF wall times vs progress-bar targets:
 *   fast 2–3 min | balanced 5–6 min | thorough 7–10 min
 *
 * Usage:
 *   npx tsx scripts/benchmark-live-modes-timed.ts [mode?] [clientId?]
 * Default: all modes × kcf/carithers/arizona-sun
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { forceExit } from "./lib/force-exit";

const HOLDOUTS = ["kcf", "carithers", "arizona-sun"] as const;
/** Balanced/thorough first (accuracy gate); fast last (timing / preview only). */
const MODES = ["balanced", "thorough", "fast"] as const;
const TARGETS: Record<(typeof MODES)[number], { lo: number; hi: number; label: string }> = {
  fast: { lo: 2 * 60, hi: 3 * 60, label: "2–3 min" },
  balanced: { lo: 5 * 60, hi: 6 * 60, label: "5–6 min" },
  thorough: { lo: 7 * 60, hi: 10 * 60, label: "7–10 min" },
};

const onlyMode = process.argv[2] as (typeof MODES)[number] | undefined;
const onlyClient = process.argv[3];
const base = process.env.BASE_URL ?? "http://localhost:3000";

const modes = onlyMode && MODES.includes(onlyMode) ? [onlyMode] : [...MODES];
const clients = onlyClient ? [onlyClient] : [...HOLDOUTS];

type RunResult = {
  mode: string;
  client: string;
  exit: number;
  wallSec: number;
  yearSecs: number[];
  pass: boolean;
};

function runOne(mode: string, clientId: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const yearSecs: number[] = [];
    console.log(`\n\n########## LIVE TIMED ${clientId} mode=${mode} ##########\n`);
    const child = spawn(
      "npx",
      ["tsx", path.join("scripts", "benchmark-ui-session.ts"), mode, clientId],
      {
        cwd: process.cwd(),
        shell: true,
        env: {
          ...process.env,
          UI_BENCH_LIVE: "1",
          BASE_URL: base,
        },
      },
    );
    let buf = "";
    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(text);
      buf += text;
      // Re-scan full buffer — per-chunk match misses times when "… (123.4s)" straddles chunks.
      yearSecs.length = 0;
      for (const m of buf.matchAll(/parse \S+ \d+[.…]+\s*\((\d+(?:\.\d+)?)s\)/g)) {
        yearSecs.push(Number(m[1]));
      }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.on("close", (code) => {
      const wallSec = (Date.now() - started) / 1000;
      const pass = /PASS/.test(buf) && (code ?? 1) === 0;
      resolve({
        mode,
        client: clientId,
        exit: code ?? 2,
        wallSec,
        yearSecs,
        pass,
      });
    });
  });
}

function fmtMin(sec: number): string {
  return `${(sec / 60).toFixed(1)}m`;
}

async function main() {
  const results: RunResult[] = [];
  for (const mode of modes) {
    for (const client of clients) {
      results.push(await runOne(mode, client));
    }
  }

  console.log("\n\n########## TIMING SUMMARY (per-PDF from bench logs) ##########");
  for (const mode of modes) {
    const t = TARGETS[mode as (typeof MODES)[number]];
    const rows = results.filter((r) => r.mode === mode);
    const allYear = rows.flatMap((r) => r.yearSecs);
    const avg = allYear.length ? allYear.reduce((a, b) => a + b, 0) / allYear.length : 0;
    const inBand = allYear.filter((s) => s >= t.lo && s <= t.hi).length;
    console.log(
      `\n${mode} target ${t.label}: avg/PDF ${fmtMin(avg)} (${avg.toFixed(0)}s) ` +
        `${inBand}/${allYear.length} PDFs in band | ` +
        (mode === "fast"
          ? `accuracy n/a (preview mode)`
          : `accuracy ${rows.every((r) => r.pass) ? "ALL PASS" : "FAILS: " + rows.filter((r) => !r.pass).map((r) => r.client).join(",")}`),
    );
    for (const r of rows) {
      const y = r.yearSecs.map((s) => `${s.toFixed(0)}s`).join(", ") || "n/a";
      console.log(
        `  ${r.client.padEnd(14)} ${r.pass ? "PASS" : "FAIL"} wall=${fmtMin(r.wallSec)} years=[${y}]`,
      );
    }
  }

  const anyAccFail = results.some((r) => r.mode !== "fast" && !r.pass);
  // Fast is preview-quality — timing only. Balanced + thorough must PASS accuracy.
  forceExit(anyAccFail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  forceExit(2);
});
