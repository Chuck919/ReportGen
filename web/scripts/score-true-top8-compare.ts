/** One-off: score saved opex dumps with old (6-field) vs true top8Amounts fixtures. */
import { readFileSync } from "node:fs";
import { diagnoseTop8OpexMultiset } from "../src/lib/tax/operating-expenses";
import { resolveExpectedTop8Amounts } from "../src/lib/tax/fixture-top8";
import { forceExit } from "./lib/force-exit";

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

const changwenFixtures = readJson("scripts/changwen-fixtures.json") as Record<
  string,
  { values: Record<string, number> }
>;

const trueTop8 = readJson("scripts/compare-true-top8.json") as Record<string, { top8Amounts: number[] }>;

const e5 = readJson("scripts/benchmark-output/opex-detail-e5f3593-balanced.json");
const local = readJson("scripts/benchmark-output/opex-detail-local-balanced.json");

function slotValues(slots: { id: string; actual: number | null }[]): Record<string, number> {
  const v: Record<string, number> = {};
  for (const s of slots) v[s.id] = s.actual ?? 0;
  return v;
}

function score(fixtureKey: string, values: Record<string, number>, mode: "committed-fixture" | "true-top8") {
  const fixture =
    mode === "true-top8"
      ? { values: {}, top8Amounts: trueTop8[fixtureKey]?.top8Amounts }
      : changwenFixtures[fixtureKey];
  const n = resolveExpectedTop8Amounts(fixture ?? { values: {} }).length;
  const d = diagnoseTop8OpexMultiset(fixture ?? { values: {} }, values);
  return { ok: d.ok, n, pct: d.pct, misses: d.unmatchedExpected.map((x) => x.amount) };
}

const years = Object.keys(e5.clients.carithers.years);
console.log("Carithers balanced — committed fixture vs true top8Amounts (8 integrator rows)\n");

let e5OldSum = 0,
  e5TrueSum = 0,
  lOldSum = 0,
  lTrueSum = 0,
  nOld = 0,
  nTrue = 0;

for (const y of years) {
  const fk = `carithers-liquor/integrator.xls / ${y}`;
  const e5v = slotValues(e5.clients.carithers.years[y].slots);
  const lv = slotValues(local.clients.carithers.years[y].slots);
  const e5old = score(fk, e5v, "committed-fixture");
  const e5true = score(fk, e5v, "true-top8");
  const lold = score(fk, lv, "committed-fixture");
  const ltrue = score(fk, lv, "true-top8");
  e5OldSum += e5old.ok;
  e5TrueSum += e5true.ok;
  lOldSum += lold.ok;
  lTrueSum += ltrue.ok;
  nOld += e5old.n;
  nTrue += e5true.n;
  console.log(`${y}:`);
  console.log(
    `  e5f3593   fixture ${e5old.ok}/${e5old.n} (${e5old.pct.toFixed(1)}%)  true8 ${e5true.ok}/${e5true.n} (${e5true.pct.toFixed(1)}%)  miss=${e5true.misses.join(",") || "—"}`,
  );
  console.log(
    `  local     fixture ${lold.ok}/${lold.n} (${lold.pct.toFixed(1)}%)  true8 ${ltrue.ok}/${ltrue.n} (${ltrue.pct.toFixed(1)}%)  miss=${ltrue.misses.join(",") || "—"}`,
  );
}

console.log(
  `\nTotals: e5 fixture ${e5OldSum}/${nOld} (${((e5OldSum / nOld) * 100).toFixed(1)}%)  true8 ${e5TrueSum}/${nTrue} (${((e5TrueSum / nTrue) * 100).toFixed(1)}%)`,
);
console.log(
  `        local fixture ${lOldSum}/${nOld} (${((lOldSum / nOld) * 100).toFixed(1)}%)  true8 ${lTrueSum}/${nTrue} (${((lTrueSum / nTrue) * 100).toFixed(1)}%)`,
);

forceExit(0);
