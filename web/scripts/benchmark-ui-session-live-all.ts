/**
 * Live UI-session benchmark — all clients, one subprocess per company.
 *
 * Spawns a fresh process per client so undici/OCR handles exit cleanly (avoids
 * the intermittent hang when all four clients run in one long-lived process).
 *
 * Usage:
 *   npx tsx scripts/benchmark-ui-session-live-all.ts [mode] [baseUrl]
 *
 * Requires dev server:
 *   cd web && npm run dev
 *
 * Then:
 *   npx tsx scripts/benchmark-ui-session-live-all.ts balanced
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { TAX_BENCHMARK_CLIENTS } from "./lib/tax-benchmark-clients";
import { forceExit } from "./lib/force-exit";

const mode = process.argv[2] ?? "balanced";
const base = process.argv[3] ?? process.env.BASE_URL ?? "http://localhost:3000";

function runClient(clientId: string): Promise<number> {
  return new Promise((resolve) => {
    console.log(`\n\n########## LIVE UI SESSION: ${clientId} mode=${mode} ##########\n`);
    const child = spawn("npx", ["tsx", path.join("scripts", "benchmark-ui-session.ts"), mode, clientId], {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: true,
      env: {
        ...process.env,
        UI_BENCH_LIVE: "1",
        BASE_URL: base,
      },
    });
    child.on("close", (code) => resolve(code ?? 2));
  });
}

async function main() {
  const codes: Record<string, number> = {};
  for (const client of TAX_BENCHMARK_CLIENTS) {
    codes[client.id] = await runClient(client.id);
  }

  console.log("\n\n########## LIVE UI SESSION — ALL CLIENTS ##########");
  for (const client of TAX_BENCHMARK_CLIENTS) {
    const code = codes[client.id] ?? 2;
    console.log(`  ${client.id.padEnd(14)} exit ${code} (${code === 0 ? "PASS" : "FAIL"})`);
  }

  forceExit(Object.values(codes).some((c) => c !== 0) ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  forceExit(2);
});
