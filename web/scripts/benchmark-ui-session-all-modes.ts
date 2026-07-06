/**
 * Run UI-session benchmarks for fast, balanced, and thorough sequentially.
 *   npx tsx scripts/benchmark-ui-session-all-modes.ts [clientId?]
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { forceExit } from "./lib/force-exit";

const modes = ["fast", "balanced", "thorough"] as const;
const onlyClient = process.argv[2];

function runMode(mode: string): Promise<number> {
  return new Promise((resolve) => {
    const args = ["tsx", path.join("scripts", "benchmark-ui-session.ts"), mode];
    if (onlyClient) args.push(onlyClient);
    console.log(`\n\n########## UI SESSION MODE=${mode} ##########\n`);
    const child = spawn("npx", args, {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: true,
      env: process.env,
    });
    child.on("close", (code) => resolve(code ?? 2));
  });
}

async function main() {
  const codes: Record<string, number> = {};
  for (const mode of modes) {
    codes[mode] = await runMode(mode);
  }
  console.log("\n\n########## ALL MODES DONE ##########");
  for (const mode of modes) {
    console.log(`  ${mode}: exit ${codes[mode]}`);
  }
  forceExit(Object.values(codes).some((c) => c !== 0) ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  forceExit(2);
});
