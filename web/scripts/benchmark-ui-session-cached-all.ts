/**
 * Cached UI-session benchmark — all clients, one subprocess per company.
 *
 * Avoids intermittent hangs when all four clients run in one long-lived process
 * (undici/pdf-parse handles not always releasing).
 *
 * Usage:
 *   npx tsx scripts/benchmark-ui-session-cached-all.ts [mode]
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { TAX_BENCHMARK_CLIENTS } from "./lib/tax-benchmark-clients";
import { forceExit } from "./lib/force-exit";

const mode = process.argv[2] ?? "balanced";

function runClient(clientId: string): Promise<number> {
  return new Promise((resolve) => {
    console.log(`\n\n########## CACHED UI SESSION: ${clientId} mode=${mode} ##########\n`);
    const env = { ...process.env };
    delete env.UI_BENCH_LIVE;
    const child = spawn("npx", ["tsx", path.join("scripts", "benchmark-ui-session.ts"), mode, clientId], {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: true,
      env,
    });
    child.on("close", (code) => resolve(code ?? 2));
  });
}

async function main() {
  const codes: Record<string, number> = {};
  for (const client of TAX_BENCHMARK_CLIENTS) {
    codes[client.id] = await runClient(client.id);
  }

  console.log("\n\n########## CACHED UI SESSION — ALL CLIENTS ##########");
  let pass = 0;
  for (const client of TAX_BENCHMARK_CLIENTS) {
    const code = codes[client.id] ?? 2;
    const status = code === 0 ? "PASS" : "FAIL";
    if (code === 0) pass++;
    console.log(`  ${client.id.padEnd(14)} exit ${code} (${status})`);
  }
  console.log(`\n${pass}/${TAX_BENCHMARK_CLIENTS.length} clients passed gate`);

  forceExit(Object.values(codes).some((c) => c !== 0) ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  forceExit(2);
});
