import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const premerge = join(tmpdir(), "main-premerge-inspect", "word", "document.xml");
const xml = readFileSync(premerge, "utf8");

// Find first MERGEFIELD entity block
const idx = xml.indexOf("MERGEFIELD");
console.log("sample around first MERGEFIELD:\n", xml.slice(idx - 200, idx + 600));

// Count «text» style placeholders
const guillemets = [...xml.matchAll(/«([^»]+)»/g)].map((m) => m[1]);
console.log("\nguillemet placeholders:", [...new Set(guillemets)].slice(0, 20));

// How many MERGEFIELD instructions
const mergefields = [...xml.matchAll(/MERGEFIELD\s+([^\\]+)/g)].map((m) => m[1]?.trim());
console.log("\nMERGEFIELD count:", mergefields.length);
console.log("unique:", [...new Set(mergefields)].length);
