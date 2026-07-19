/** Inspect live bench JSON for sssi 2023 — what values/sources did live parse produce? */
import balanced from "./benchmark-output/ui-session-live-balanced-1784278796847.json";

type AnyRec = Record<string, unknown>;
const results = (balanced as AnyRec).results as AnyRec[];
const sssi = results.find((r) => r.client === "sssi")!;
console.log("keys:", Object.keys(sssi));
console.log(JSON.stringify(sssi, null, 1).slice(0, 4000));
