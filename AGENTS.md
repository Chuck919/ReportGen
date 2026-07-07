# ReportGen — Agent Handoff

**Read this entire file before changing code.** As of **Jul 7, 2026**, the e5 merge policy has been restored (Phase 0 done) and Phase 1–2 fixes are in and benchmarked: **KCF and Carithers now PASS the honest UI-session gate** (Carithers 100% field / 100% opex across all 5 years, up from a true ~85% baseline — see [Current status (Jul 7, 2026)](#current-status-jul-7-2026)). **SSSI and Arizona still FAIL.** Arizona's failure is the deeper architectural limit (fixed semantic opex slots vs. a client's actual top-8-by-amount selection); do not attempt a broad rewrite of the top-8 ranking logic without reading [What we tried and it did not work](#what-we-tried-and-it-did-not-work) first. SSSI has that same limit **plus** a real production bug found and fixed this session — the OCR attachment-gap rescan safety net was wired to a mode (`thorough`) the app never uses by default, so real balanced-mode uploads could silently return blank/wrong opex fields; see the second "Session update (Jul 7, continued further)" section for the fix and its (real, not free) latency trade-off.

Copy-paste iteration prompt: see [Agent iteration prompt](#agent-iteration-prompt) at the bottom.

---

## Current status (Jul 7, 2026)

**Committed HEAD still `e5f3593`.** Everything below is uncommitted (not committed unless explicitly asked).

Phase 0 (revert failed ledger-merge, restore e5 policy) and Phase 1 (honest `top8Amounts` fixtures wired into the gate) were already done by a prior agent. This session did **Phase 2 root-cause fixes**, re-validated with `benchmark-ui-session.ts balanced` (all 4 clients, real balanced OCR cache — no longer relying on live OCR fallback; caches for `arizona-sun-*-balanced.txt` and `sssi-2023/2024-balanced.txt` were generated and now exist):

| Client | Field | Opex | Misses | Status |
|--------|-------|------|--------|--------|
| `kcf` | 99.0% | **100%** | 1 (non-opex `other_operating_expenses`, pre-existing) | **PASS** |
| `carithers` | 100% | **100%** | **0** | **PASS** |
| `sssi` | 96.1% | 63.1% | 12 | FAIL |
| `arizona-sun` | 100% | 59.4% | 13 | FAIL |

Carithers went from a true (honest, 8-field) baseline of **~85%** opex to **100% opex, 0 misses, across all 5 years (2021–2025)**. This is the single biggest correctness win to date and came from two generalized, low-risk bugs (not client-specific hacks):

1. **`isForm1120Line` regex bug** (`web/src/lib/tax-return/money.ts`) — the "not preceded by a digit" guard was written as `[^\d\s]{0,2}` which allows a **zero-width** match, so it never actually excluded a digit sitting directly before `n`. Consequence: a trailing digit of a larger number (e.g. the `9` in `5,439`, a comparison-schedule *change* column) was matched as "line 9", so `extractDirectFormExpenseLines` grabbed the wrong number for Carithers 2025 repairs (`5,439` instead of the real Form 1120-S line 9 value `10,786`). Fixed with a lookbehind: `(?<![\d.])\[?${n}(?:\](?!\d)|\b(?!\d))`. This function is used broadly for form-line matching, so this fix likely helps other clients/years too, not just this one instance.
2. **`pickStmt2BankCreditCard` + `scanStmt2MiscLineAmounts` hardcoded "Statement 2 = Other deductions"** (`web/src/lib/tax-return/stmt2-bank-picker.ts`, `web/src/lib/tax-return/statement-extractors.ts`) — both had their own from-scratch "am I inside the Other-deductions block" detector using bare `/statement\s*2/` / exit-on-`/statement\s*[3-9]/` regexes. When a client's *Other deductions* attachment is Statement **3** (because Statement 2 is *Taxes and licenses*, e.g. Carithers), these scanners (a) never opened on the real block, since it turns off on "statement 3" regardless of content, and (b) misattributed a same-numbered-but-unrelated Statement 2 line (e.g. `PAYROLL TAXES 10,515`) as the bank/insurance figure. Fixed by making both reuse the *already-correct*, content-aware `isOtherDeductionsBlockHeader` / `endsOtherDeductionsBlock` detectors (now exported from `statement-extractors.ts`) instead of maintaining a second, drifted copy of the same logic. Carithers 2024 `bank_credit_card` (labeled "Insurance" for this client) went from `10515` (wrong, from the unrelated Statement 2 line) to the correct `9284`.

Both fixes were proven with `dump-opex-detail.ts` per-slot dumps before/after, then validated on all 4 clients with the full benchmark — no regressions on KCF/Carithers from either.

### SSSI / Arizona: still failing, and why a quick fix is unlikely

Both failures trace to the **same root cause**, which is the deeper architectural issue this file already flags below (see "Why we are bloated" / Phase 2–4 plan): **the code has 8 *fixed semantic* opex slots** (`officer_compensation`, `salaries_wages`, `advertising`, `rent`, `taxes_licenses`, `bank_credit_card`, `professional_fees`, `utilities`), but a client's real integrator paste is **whatever 8 categories rank highest by dollar amount** for that entity, which do not always align to those 8 fixed semantic buckets.

- **SSSI 2022**: the fixture's true top-8 (after officer comp) is `[rent, repairs, insurance, taxes, "job supplies", utilities, professional]` — there is **no distinct "Salaries and wages" row at all** in the real paste; the largest number our parser finds for `salaries_wages` (a "Two Year Comparison" multi-column schedule that renders the same conceptual row 3–5 different times across the OCR, with wildly different values: `208573` / `2019630` / `2082299`) is **never** one of the real top-8 amounts, because the real preparer excluded it. Confirmed via `extractOperatingExpenseLinesFromText` debug: the correct `70185` ("job supplies") and `258012` ("repairs") categorized lines **are already extracted correctly** — they just don't win their (wrong, fixed) slot IDs.
- **Arizona-sun**: `taxes_licenses` and `utilities` slots each have **two** different expected fixture amounts pointing at them as "nearest" (e.g. 2025: `151560` and `102370` both nearest to our single `taxes_licenses` value of `141702`) in every single year — a client-specific but *consistent* pattern suggesting Arizona's real paste splits what we treat as one category into two rows (or vice versa).

**Do not try to fix this by adding a "richest OCR rendering wins" heuristic to the shared comparison-table parsers** (`two-year-comparison-parser.ts`'s `parseTwoYearComparisonAt`, and `comparison-field-rows.ts`'s `refillFromComparisonLabeledRows`) — **this was tried in this session and reverted** because it regressed Carithers (5 years, 100%→87.5% on 3 years) and KCF (2023, 100%→87.5%) by letting a differently-shaped comparison row outrank a previously-correct single-value line. See new entries in [What we tried and it did not work](#what-we-tried-and-it-did-not-work). The real fix is the already-planned **top-8-by-amount ranking** work (Phase 2–4 below / "Path forward"), which must be done with per-change benchmarks on all 4 clients, exactly as this file already prescribes — not a shared-parser heuristic.

### Session update (Jul 7, 2026, continued) — empty-slot backfill shipped (safe, but proven inert for SSSI/Arizona); new hard evidence on why

This continuation session implemented and benchmarked the next low-risk step of the plan, then did a **deeper, targeted root-cause trace** on SSSI/Arizona specifically (not just categorization-level, but tracing each wrong slot value back to its exact source function) to find out *why* those two clients don't respond to safe fixes — with new, more specific evidence than the section above.

**What shipped (`web/src/lib/tax/operating-expenses.ts`, `fillWeakSlotsFromCategorizedLines`):**

1. **Bug 1 — stop collapsing same-category lines to a single max.** `byCategory` used to keep only `Math.max(...)` per category key, silently discarding every other distinct amount that matched the same regex (e.g. a client with two real "taxes"-shaped rows). Now every distinct amount per category is kept (`byCategoryAmounts`, sorted desc); the primary per-slot loop still only *uses* the max (unchanged behavior/no regression risk), but the rest are no longer thrown away before the next step can see them.
2. **Bug 2 — backfill genuinely-empty slots from leftover lines.** After the existing primary loop runs, any of the 8 slots still empty get filled from the highest-amount unclaimed line in the full `lines` pool (not just same-category leftovers — includes lines whose category has no `categoryToSlot` mapping at all, e.g. `"supplies"`). This **never touches a slot that already holds any value** — it is strictly additive to blank rows, so it cannot regress an already-correct or already-wrong-but-existing value.
3. **Double-count guard for `other_operating_expenses`.** Backfilling a slot from a line whose `source` is the Statement "Other deductions" attachment (`extractOperatingExpenseLinesFromText`, tagged `"Statement 2"`/`"Statement 3"`) means that dollar amount was *already* implicitly folded into `other_operating_expenses`'s residual at parse time (see `knownStmt2AttachmentSum`/`inferStmt2AttachmentTotal`, which subtracts only `bank_credit_card`/`professional_fees`/`utilities`/`amortization` — any other slot was invisible to that subtraction and thus stayed inside the residual). So the fix subtracts the newly-placed amount back out of `other_operating_expenses` when doing so keeps it non-negative. Lines from `extractDirectFormExpenseLines` (Form page-1 lines, e.g. `"Form 1120-S line 9"`) are **excluded** from this adjustment — those were never part of the Statement total in the first place.

**Benchmarked result: KCF and Carithers unchanged (still 100%/100%, all years) — zero regressions.** SSSI and Arizona are **numerically identical to before this change** (same field/opex %, same misses, to the decimal). This is expected once you see why (below) — it is not a bug in the new code, it is proof that "empty slot" was never the actual failure mode for these two clients.

**New root-cause trace — why Bug 1+2 (and any future "fill blanks" fix) cannot touch SSSI/Arizona's remaining misses:**

Traced every mis-scored opex slot for both clients back to its exact `fieldSources` value (via `dump-opex-detail.ts` and a one-off comparison-block inspector, both deleted after use — not worth keeping as permanent scripts). Result: **none of the 8 slots are ever empty for either client.** Every slot is already populated — either correctly by the primary category loop, or (for every slot that's actually wrong) by a **`"Two-year comparison"`-sourced value that was set *before* `fillWeakSlotsFromCategorizedLines` even runs**, back in `parse-from-text.ts` (~line 557) or by a bespoke per-field extractor in `two-year-comparison-parser.ts`/`comparison-field-rows.ts`. That earlier assignment is `isProtectedOpexSource`-protected, so the categorized-lines pool (where Bug 1's preserved extra amounts live) never gets a chance to compete for that slot at all — there is no "empty slot" for the leftover line to fall into.

- **SSSI 2022 `salaries_wages` = 2,082,299 (wrong):** the document contains **4 distinct, independently-parseable "Two Year Comparison" block locations** (verified by slicing the OCR at each of `startRe`'s match positions and re-running `parseTwoYearComparisonBlock` on each slice in isolation). All 4 blocks **agree** with each other on this row (`2082299`, `2082299`, `-2082299` [sign-flipped], `2019630` — all within ~3% of one another, not the order-of-magnitude spread you'd see from a genuine OCR misread). This rules out a "richest reading wins" or "reject on cross-reading disagreement" plausibility guard — there is no disagreement to detect; the OCR is reading the same real number consistently. Cross-checked against the fixture: `sales` = 3,593,368, and this number (~58% of sales) is not implausible on a pure magnitude basis either. The most likely explanation: this is a **genuine Form 1120-S "Salaries and wages" deduction figure**, just not one of the integrator's chosen top-8 SG&A rows for this client — their top-8 substitutes `"job supplies"` (`70185`, already correctly extracted and categorized, but with nowhere to go since `salaries_wages` is occupied) instead. This is a **document-vs-integrator-taxonomy mismatch**, not an extraction error, and no source-text signal available at parse time distinguishes "real deduction, wrong home" from "real deduction, right home" — this specific case needs the client's own top-8 list to know, which the parser cannot see in production.
- **Arizona-sun `taxes_licenses` (wrong every year) is not sourced from the Statement-2/categorized-lines pool at all.** Confirmed via the same category-amount dump: **no line categorized as `taxes_licenses` exists anywhere in `operatingExpenseLines` for any of Arizona's 4 years.** The slot's value instead comes from a dedicated derivation, `fieldSources.taxes_licenses = "Two-year comparison (taxes minus taxes paid)"` — i.e. a deliberate business rule (raw comparison "taxes" row minus a separate "taxes paid" row), not a raw misread. The integrator's true top-8 splits this into **two** separate amounts (e.g. 2025: `151560` and `102370`); neither appears anywhere in the extractable OCR text as its own line — only one combined "Taxes and licenses" comparison row exists in the source document. **The split literally is not present in this PDF's OCR text**, so no parsing change (safe or risky) can recover it without inventing a number. `utilities` has a smaller, non-split gap (e.g. `57,434` got vs `50,842` expected, ~13% off) that's a more ordinary "wrong reading" case and could theoretically be revisited in isolation, but was not chased further this session given the dominant, unfixable-from-source `taxes_licenses` gap already fails the client either way.

**Conclusion:** this is now the **third round of investigation** (original session + the reverted heuristic attempt + this session's per-slot source trace) reaching the same wall from different angles. The remaining SSSI/Arizona gap is a genuine **information-not-present-in-the-source-document** limit for at least the dominant misses (SSSI `salaries_wages`, Arizona `taxes_licenses`), not a fixable parsing bug — further generalized heuristics aimed at "pick a better number" are very unlikely to help these specific misses, because the *correct* number per the integrator's own top-8 is not extractable text anywhere in the OCR. Closing this gap for real would require either (a) accepting these as a hard ceiling given the source documents, or (b) the much higher-risk **global rank-by-amount slot reassignment** (Phase 2–4 "Path forward" below) that can *evict* an already-filled-but-wrong slot value (e.g. let `"job supplies"` displace `salaries_wages` when the latter is comparison-only-sourced) — every attempt at this class of fix in this project's history has regressed KCF/Carithers when tried broadly, so it must be scoped very narrowly and benchmarked after every micro-step, not attempted as one change.

**Also added this session:** a genuine single-request, multi-file live-API benchmark mode (`UI_BENCH_LIVE_BATCH=1`, see `web/scripts/benchmark-ui-session.ts`) that uploads every year's PDF as multiple `files` fields on **one** POST (the server already supports this via `form.getAll("files")`), instead of one POST per year. This exercises the server's own multi-file loop and validates cross-year opex grouping when years genuinely arrive together in a single request — not just after N sequential client-simulated calls. Note: the *actual production UI* (`parseTaxReturnFiles` in `web/src/lib/api/parse-tax-return.ts`) already sends one file per POST even when a user selects multiple years at once (intentional, for progress reporting/timeout safety), so the pre-existing sequential live mode was already a faithful simulation of production; the new batch mode is an additional robustness check of the less-exercised code path, not a replacement.

### Session update (Jul 7, 2026, continued further) — SSSI balance-sheet fix + a real production bug found: OCR attachment-gap rescan was silently disabled for the default (`balanced`) mode

Three more fixes this session, found by tracing **live production API calls** (not just cached OCR text), which surfaced a bug the cached-OCR benchmark could never have found on its own since it never exercises live OCR code paths.

1. **SSSI 2023 balance sheet ($393k gap) — `web/src/lib/tax/workbook-formulas.ts`.** `total_current_assets` required `anyPresent(out, currentAssetIds, 2)` — **at least 2** of `[cash, accounts_receivable, inventory, other_current_assets]` present before summing any of them. SSSI 2023's Schedule L genuinely only reports **Cash** (no AR/inventory line at all) — a normal, valid small-business balance sheet — so the correct `393,294` cash figure was silently dropped from `total_assets` entirely, even though it had been extracted correctly. Changed `minCount` from `2` to `1`, matching the equity-bucket threshold already used elsewhere in the same function. Balance-sheet gap for SSSI went from ~$393k to a residual **$263** (immaterial OCR rounding noise, unrelated). **No regression on any client** (KCF/Carithers/Arizona math mismatches unaffected).

2. **OCR attachment-gap rescan silently never ran in the app's actual default mode — `web/src/lib/tax-return-parser.ts`.** There is an existing, already-built safety net: `rescanMissingAttachmentsExperimental` (`web/src/lib/tax/ocr-recovery-experimental.ts`) detects when a document references "Statement 2" for Other Deductions but the OCR text never actually captured that attachment page (`probeOcrCoverageGaps` → `stmt2-detail-missing`), and does a targeted extra thorough-tier OCR pass on just the missing pages to fill the gap. **This only ran when `ocrMode` was `"thorough"`/`"vercel-thorough"`** (`usesAttachmentGapRescan`) — but `defaultOcrModeForDeploy()` (`web/src/lib/tax/resolve-ocr-mode.ts`) returns `"balanced"`/`"vercel-balanced"` for every normal user upload. In other words: **the safety net that exists specifically to catch this class of bug was wired to a mode the product never actually uses by default**, so any client whose real "Other Deductions" attachment page got skipped by the balanced-mode page-selection heuristic would silently get blank/wrong `other_operating_expenses`, `bank_credit_card`, `professional_fees`, and `utilities` — with zero chance of self-correcting. Confirmed via a real live single-file API call against the dev server (`web/scripts/test-live-single.ts`) for SSSI 2023: **balanced mode without the fix** returned `other_operating_expenses`, `bank_credit_card`, `professional_fees`, `utilities`, and `salaries_wages` **all `undefined`** — the entire "Statement 2 - Other Deductions" attachment page (containing `BANK CHARGES 3,821`, `INSURANCE 324,036`, `PROFESSIONAL FEES 53,833`, etc. — confirmed present in the `thorough`-mode OCR cache for the same document) was simply never OCR'd at all in balanced mode. Fixed by extending `usesAttachmentGapRescan` to also cover `"balanced"`/`"vercel-balanced"`, and generalizing the previously two-case-only `baselineMode` ternary (`thorough`→`balanced` else `vercel-balanced`, which would have been **wrong** for a `balanced`-mode baseline) to a mode-family check: `ocrModeLabel.startsWith("vercel") ? "vercel-balanced" : "balanced"`. **After the fix, the same live balanced-mode call for SSSI 2023 populated `bank_credit_card=3821`, `professional_fees=53833`, and `utilities=27159`** — all exact matches to the true Statement 2 detail / fixture top-8 amounts that were previously either blank or (worse) silently wrong-slotted. Mirrored the identical mode-gate change into the benchmark's own cached path (`parseYearCached` in `benchmark-ui-session.ts`, previously also `thorough`-only) so cached "balanced" benchmark runs now honestly reflect real production behavior instead of understating what a live balanced run actually recovers — the first time this ran per client-year it also **rewrites the `-balanced.txt` OCR cache file** with the recovered pages merged in (intentional: keeps the frozen cache faithful to what live balanced mode now produces; only happens once per client-year, not per run).
   - **Caveat / real trade-off, not free:** this adds a full extra thorough-tier OCR pass (multiple additional page-OCR calls) whenever the gap heuristic fires, which is expensive (observed 5–10+ minutes added on this dev machine, though that is heavily inflated by system memory pressure — see below). It only triggers when `probeOcrCoverageGaps` actually detects a real gap (rare — did not fire for KCF/Carithers/Arizona in this session's runs), so normal documents are unaffected, but a user whose document happens to trip this path will see a materially slower parse. This is a correctness-over-latency trade-off; if OCR latency becomes a product complaint, the next step would be narrowing `probeOcrCoverageGaps`'s trigger precision rather than reverting the fix outright (going back to "sometimes silently wrong/blank" is strictly worse).
3. **`isForm1120Line` false-positive on cross-references inside unrelated instruction text — `web/src/lib/tax-return/money.ts`.** Enabling the gap-rescan above (fix #2) pulled in additional real document pages that hadn't been visible before — including, for SSSI, a **Kentucky/Louisville local-tax-form instructions page** containing the sentence `"...Sum of Columns A & B of Line 30 (if Line 31 is greater [than] $5,000.00...)"`. `isForm1120Line(line, 31)` matched the literal "Line 31" token anywhere in that sentence (the function's "not preceded by a digit" guard only constrains what's immediately adjacent to the number, not *where* in the line it appears), so combined with `/total\s+tax/i` also being true earlier in the same sentence ("Total Tax Due..."), this got misread as **Form 1120 line 31 "Total tax" = $5,000** — a real, dangerous false positive (`taxes_paid: exp 0, got 5000`, flagged as a **green-tier danger** in the benchmark, i.e. a wrong value the UI would have shown as trustworthy). Root cause: `isForm1120Line`'s own docstring says it's meant to "tolerate OCR junk **before** bracketed line numbers" (a few garbled characters), but the implementation never actually enforced that the match stay near the start of the line — so a line number cross-referenced deep inside an unrelated paragraph (70+ characters in) matched exactly the same as a genuine form row's leading line number. Fixed by requiring the regex match start within the first 30 characters of the line (`m.index <= 30`), consistent with the function's documented intent; verified against every existing real-document match pattern this session has seen (all genuine form rows match well under this threshold — typically 0–10 chars of prefix junk). **Result: the `$5,000` green-danger false positive is gone; no other client/year regressed** (confirmed on full 4-client cached benchmark).

**Net result, all 4 clients, cached `balanced` benchmark, before → after these 3 fixes:**

| Client | Field before → after | Opex before → after | Misses before → after | Status |
|--------|----------------------|----------------------|------------------------|--------|
| `kcf` | 99.0% → 99.0% | 100% → 100% | 1 → 1 (unchanged, pre-existing) | PASS (unchanged) |
| `carithers` | 100% → 100% | 100% → 100% | 0 → 0 (unchanged) | PASS (unchanged) |
| `sssi` | 96.1% → 96.1% | **63.1% → 72.6%** | **12 → 10** | still FAIL, but real improvement |
| `arizona-sun` | 100% → 100% | 59.4% → 59.4% | 13 → 13 (unchanged — no OCR gap detected for this client; confirms Arizona's failure is the architectural top-8 taxonomy mismatch, not an OCR coverage issue) | FAIL (unchanged, as expected) |

SSSI's remaining misses after these fixes are the same class already documented above (`salaries_wages` document-vs-integrator-taxonomy mismatch, `taxes_licenses` split-row issue) plus one residual `other_operating_expenses` candidate-ranking imprecision (now populated with a real but imperfect comparison-residual value instead of blank, e.g. 2023: `77920` got vs `178480` expected) — **not yet root-caused this session**, a reasonable next target since the underlying data is now actually present in the OCR text (it wasn't before fix #2).

**Live-API verification:** used a small standalone script (`web/scripts/test-live-single.ts <clientId> <year> <mode>`) to hit the real dev server (`POST /api/parse-tax-return`) directly rather than only cached-text unit-level checks, since fixes #2 and #3 only manifest through the live OCR code path (`web/src/lib/tax-return-parser.ts`) that the cached benchmark bypasses by default. This is how the `stmt2-detail-missing` gap and the downstream `$5,000` false positive were actually found — **cached-only iteration would not have surfaced either bug**. Full live multi-client multi-year batch benchmark (`UI_BENCH_LIVE_BATCH=1`) was intentionally deferred to end-of-session per user direction (cached iteration is much faster; live is reserved for final verification) — **still pending** as of this writing given system memory pressure on the dev machine makes each live OCR call take several minutes.

---

## What this project is

ReportGen is a **Next.js tax-return parser** (`web/`) that ingests corporate tax PDFs (1120 / 1120-S and attachments), runs embedded-text + OCR extraction, and produces **tab-separated values** aligned to a fixed **integrator Excel workbook** (income statement rows 1–32, balance sheet rows 36–65).

The product goal is **hands-off accuracy**: upload a client’s multi-year PDFs, merge years in one session (same path as the Tax tab UI), and paste into Excel with correct **line items, eight ranked operating-expense rows, other operating expenses, and formula totals** that reconcile to what the integrator and the tax return actually show.

Ground truth for development is **integrator Excel files** (not the PDF alone). Benchmark clients:

| ID | Entity | Fixture source | Years |
|----|--------|----------------|-------|
| `kcf` | KC Fudge LLC | `web/src/lib/workbook-comparison-fixtures.ts` | 2023–2025 |
| `carithers` | Carithers Liquor LLC | `web/scripts/changwen-fixtures.json` | 2021–2025 |
| `sssi` | Strategic Solution Services Inc | `web/scripts/changwen-fixtures.json` | 2022–2024 |
| `arizona-sun` | Arizona Sun Supply Inc | `web/scripts/changwen-fixtures.json` | 2022–2025 |

PDFs live under `Documents/` and `Documents/For Changwen/`.

---

## What we are trying to achieve

1. **8/8 operating expenses** — all eight integrator SG&A row **amounts** correct per year, with **labels** aligned across years where the integrator does. Slot IDs (`advertising`, `bank_credit_card`, etc.) are **paste row positions**, not semantic categories; integrator row 3 may be “Repairs” while the slot ID is `advertising`.
2. **≥99% non-opex input fields** vs integrator fixtures (sales, COGS, B/S lines, etc.).
3. **P&L closure to Form page-1 anchors** — workbook **NPBT** should match **Form ordinary business income** (1120-S line 22 / 1120 line 30) when present in OCR; GP should match Form line 3. Integrator “net income” is not on the return; when `taxes_paid` and extraordinary items are zero, NPBT ≈ NI ≈ ordinary income.
4. **Trustworthy UI** — wrong values must not appear as green/high-confidence; formula rows must not silently disagree with form anchors **after merge**.
5. **Honest benchmarks** — scoring must use full 8-row ground truth, per-slot checks where possible, and P&L closure; cannot pass when repairs are missing or NI is tens of thousands off ordinary income.

**Out of scope / do not optimize for:**

- Excel column ordering beyond what integrator paste already does (newest→oldest multi-year is fine).
- Client-specific hardcoded branches unless unavoidable and benchmark-proven.
- Big-bang merge rewrites without per-change benchmark proof on all four clients.
- Multiset-only opex scoring (slot assignment errors must fail).

Success is measured against **integrator Excel**, on **post-merge** columns (same as UI paste path).

---

## Thresholds and limits (current gate + scoring rules)

### UI-session benchmark (`web/scripts/benchmark-ui-session.ts`)

Exit code **1** if any client fails:

| Metric | Threshold |
|--------|-----------|
| Avg field accuracy (excl. 8 opex slots) | **≥ 99%** |
| Avg opex amount multiset | **≥ 99%** |
| Green-danger failures | **0** (wrong value + trusted green tier, or wrong + high confidence unflagged) |
| False-positive review rate | **≤ 5%** (correct fields shown yellow/low) |
| Yellow/review highlight rate | **≤ 10%** of scanned fixture fields |
| Unclean opex labels | **0** |
| Internal workbook formula mismatches | **0** (`auditWorkbookMath`) |

**Trusted green tiers** (benchmark): `multi-source`, `authoritative`, `comparison`, `single-good`.

**High confidence** (green-danger unflagged): `displayConfidence ≥ 75` (`HIGH_CONFIDENCE_THRESHOLD` in `tax-benchmark-confidence.ts`).

**Low confidence**: `< 65` (`LOW_CONFIDENCE_THRESHOLD`).

### Field amount matching (`tax-benchmark-score.ts`)

- **Money tolerance:** `max($1, 0.5% × |expected|)` per field.
- **Opex:** multiset over expected amounts; **currently under-counts `n`** when fixtures omit slot amounts (see below).
- **Operating-expenses internal multiset** (`operating-expenses.ts`): uses `max($500, 1% × |expected|)` — stricter than field scoring in some paths.

### P&L identity (`pnl-identity.ts`)

- **Close match:** `max($1, 0.5% × scale)` via `pnlAmountsClose`.

### Parser / merge limits (design intent)

- **MIN_EXPENSE_AMOUNT:** $100 — amounts below this are ignored for top-8 ranking.
- **Strong opex year (e5):** ≥4 filled slots with non-remap sources → **label sync only**, no amount remap across years.
- **Generalized fixes only:** regex/category rules (`EXPENSE_CATEGORY_RULES`), Stmt-2 region gates, form/comparison priority — not per-client `if (client === 'carithers')` unless last resort.

### Benchmark gaps (not yet in gate — must be added)

These are **targets**, not current blockers:

- **8/8 opex** via `top8Amounts` in every fixture (not 4–6/8).
- **Per-slot opex** scoring (amount in correct paste row).
- **NPBT vs form ordinary income** post-merge (fail when form line found and gap > 0.5%).
- **GP vs form gross profit** when form GP found.

Until fixtures and P&L gates are fixed, **a passing UI-session run does not mean production-ready paste**.

---

## Where we are now (Jul 6, 2026)

### Git state

- **Committed HEAD:** `e5f3593` — last known-good **multi-year opex merge policy**.
- **Local uncommitted:** ~**1,429 lines** across 15 files under `web/` (+ untracked debug/benchmark scripts). **Dev server runs uncommitted code**, not clean `e5f3593`.
- **Nothing committed** since `e5f3593`.
- **Do not stash yet** on first pickup — read [What we tried](#what-we-tried-and-it-did-not-work), then agent stashes/branches and reverts merge rewrite itself.

### Three separate problems (do not conflate)

| # | Problem | Layer | Symptom |
|---|---------|-------|---------|
| **1** | Form $300 **advertising** blocks Stmt-2 **repairs** in slot 3 | Per-year parser (`fillWeakSlotsFromCategorizedLines`) | Carithers: repairs $10,786 missing; other_opex off by $300; NI ~$10k wrong vs form |
| **2** | Fixtures score **6/8** opex (Carithers), **4–5/8** (SSSI/Arizona); no `top8Amounts` in gate | Benchmark data | 100% opex while slot 3 = $300 |
| **3** | Local **always shared top-8 remap** (ledger-first) | Merge (`alignOperatingExpensesAcrossYears`) | NI collapse (e.g. 2025 local 42,777 vs e5 67,453); bank garbage in slots |

Fixing #3 without #2 still “passes” with wrong paste. Fixing #2 exposes #1. #1 is a small parser fix on e5 merge base.

### Benchmark snapshots

**Peak (e5f3593, balanced, cached, all 4 clients):** KCF 100%, Carithers 100%, Arizona 100%, SSSI 80% → **~95% avg** — but Carithers/Arizona multiset is on **partial** expected counts.

**Local uncommitted (thorough):** ~56–84% opex on several clients; Carithers **100% multiset (6/6)** with **catastrophic NI** (2025: 42,777 vs e5 67,453).

**Honest 8-field re-score (Carithers, balanced dumps + `compare-true-top8.json`):**

| Pipeline | Old fixture (6-field) | True `top8Amounts` (8-field) |
|----------|----------------------|--------------------------------|
| e5f3593 | 30/30 (100%) | 34/40 (**85%**) |
| local | 29/30 (97%) | 29/40 (**72.5%**) |

### Carithers 2025 concrete (balanced dumps)

| | e5f3593 | local |
|--|---------|-------|
| Slot 3 (`advertising` / repairs row) | **$300** (Form line 16) | **$5,439** |
| Expected repairs (Excel) | **$10,786** | **$10,786** |
| Bank slot | $11,894 (insurance) | **$31,431** (OCR garbage) |
| Net income | 67,453 | **42,777** |
| Benchmark opex | 100% (6/6) | 100% (6/6) |
| other_opex | 8,818 vs exp 9,118 | same |

---

## What we tried and it did not work

### 1. Ledger-first always-remap merge (local uncommitted) — **failed**

**What:** Replaced e5 `strongCount` guard with always `selectSharedTop8AcrossYears` + `applySharedTop8ToColumn` + `buildOperatingExpenseLedger`, document-wide category scan, category→slot assignment.

**Why it seemed good:** Theoretically fixes cross-year label alignment and fills weak slots from Stmt-2 ledger.

**Why it failed:**

- Overwrites per-year **good** form/comparison amounts with shared-category remap.
- `extractDocumentWideDeductionLines` / wide Stmt-2 scan pulls OCR noise (e.g. $31k merchant line into bank slot).
- Carithers NI collapsed multiple years; Arizona lost bank/supplies; KCF bank slot regressed.
- Still scored 97–100% on **6-field** multiset.

**Verdict:** Revert `operating-expenses.ts` + `merge-years.ts` to e5f3593 merge policy. Cherry-pick Stmt-2 extractors separately with benchmarks.

### 2. Multiset-only opex scoring — **misleading**

**What:** `matchTop8OpexAmounts` — expected amounts appear in any of 8 slots.

**Why it failed:** Insurance in bank slot, $300 advertising in repairs row, surplus garbage amounts — all can pass. Carithers 2025 = 100% with wrong slot assignment and wrong NI.

**Verdict:** Add `top8Amounts` to fixtures + per-slot scoring + P&L gate.

### 3. Incomplete fixtures — **false greens**

**What:** `changwen-fixtures.json` only has 6/8 opex amounts for Carithers; SSSI/Arizona 4–5/8.

**Why it failed:** `n` in opex score = count of fixture amounts present, not 8. Repairs/insurance/bank never counted → cannot fail.

**Verdict:** Regenerate fixtures; merge `compare-true-top8.json` into gate; extract KCF top8 too.

### 4. P&L identity at parse time only — **stale after merge**

**What:** `flagPnlIdentityMismatches` + `applyOrdinaryIncomeReverseOpex` at end of `parse-from-text.ts` (~1700), before `alignOperatingExpensesAcrossYears`.

**Why it failed:** Merge changes opex; warnings/flags don't update; only `other_operating_expenses` gets field flag; `net_income` / NPBT cells stay green while tens of thousands off form ordinary income.

**Verdict:** Re-run P&L checks post-`finalizeTaxColumns`; add to benchmark gate.

### 5. e5 “100%” Carithers as proof of correctness — **wrong**

**What:** Treated committed HEAD peak benchmarks as “done.”

**Why it failed:** True 8-field score is **85%** on e5. Root parser bug: form advertising protects slot 3 from repairs fill. NI inflated ~$10k vs form ordinary income — undetected.

**Verdict:** e5 merge policy is baseline; parser + fixtures + P&L gate still required.

### 6. Large architectural iteration without honest gate — **rabbit hole**

**What:** ~766 lines in `operating-expenses.ts` alone while benchmark still used 6-field multiset.

**Why it failed:** Optimized against a test that cannot measure the real failure mode.

### 7. "Richest OCR rendering wins" heuristic in shared comparison-table parsers — **failed, reverted (Jul 7, 2026)**

**What:** Tried to fix SSSI 2022's `salaries_wages` reading `2,082,299` off a garbled "Two Year Comparison" schedule fragment by preferring, per row-label, whichever matching OCR line had the *most* numeric tokens (reasoning: a 1-token fragment is more likely a garbled duplicate render of a fuller row seen elsewhere). Applied to both `two-year-comparison-parser.ts`'s `parseTwoYearComparisonAt` (the actual value-setting path for this case) and `comparison-field-rows.ts`'s `refillFromComparisonLabeledRows` (a secondary backfill pass — turned out to be inert for this specific bug since the primary parser already locks the value first).

**Why it seemed good:** Generalizable-sounding signal ("prefer more complete data"), no client-specific branching.

**Why it failed:** These comparison tables are structurally inconsistent across documents/rows — a line with *more* numbers is not reliably "more correct"; it can just as easily be an unrelated row, a different statement's line that happens to share a label pattern, or the row's real "variance/total" columns which should be *excluded*, not preferred. Concretely it changed the accepted value for `advertising` (Carithers 2022, "Repairs and maintenance" row) from the correct `3312` to a wrong `52927` picked up from a differently-shaped comparison line, and did the same to a KCF 2023 slot — regressing both clients that Phase 2 had just fixed to 100%. It also did **not** fix SSSI, because SSSI's real issue is that no amount belongs in `salaries_wages` at all (see below), not that the wrong amount was picked from that row.

**Verdict:** Reverted both files completely (`git diff` shows zero net change vs. pre-attempt). Do not resurrect this exact heuristic. The real fix for SSSI/Arizona is top-8-by-amount ranking (see [Current status](#current-status-jul-7-2026) and Phase 2–4 below), not a smarter per-row picker inside a fundamentally-fixed-slot architecture.

### 8. `isForm1120Line` and Statement-N block-boundary generalization — **worked, kept (Jul 7, 2026)**

See [Current status](#current-status-jul-7-2026) for the two fixes that *did* work and are now in the codebase: the `isForm1120Line` lookbehind fix in `money.ts`, and reusing `isOtherDeductionsBlockHeader`/`endsOtherDeductionsBlock` inside `stmt2-bank-picker.ts` and `scanStmt2MiscLineAmounts` instead of each maintaining its own hardcoded "Statement 2" window. Both are narrow, mechanical bug fixes (a broken regex guard; two drifted duplicate implementations of an already-correct detector) rather than new heuristics — that's likely why they didn't carry the same regression risk as attempt #7.

---

## What worked (keep / cherry-pick)

| Area | Notes |
|------|-------|
| e5 **strongCount → label-sync-only** merge | ~95% avg on old scoring; NI less broken than local |
| e5 **fillWeakSlotsFromCategorizedLines** | Repairs→slot3 mapping concept right; blocked by form $300 guard |
| KCF **bank_credit_card** from Stmt-2 + regex | Works on e5 |
| **Stmt-2 extractors** (local) | `extractStatementExpenseLines` — valuable if merged without always-remap |
| **comparison-field-rows** multiline | Keep with benchmarks |
| **apply-user-correction** review snapshot | UX; keep |
| **dump-opex-detail.ts**, **score-true-top8-compare.ts** | Diagnostics; keep |
| **fixture-top8.ts** + `extract-integrator-fixtures.py` top8 extraction | Wire into fixtures |
| Integrator copy **`.00`** decimals | `formatExcelPasteNumber` in `tax-workbook.ts` |

---

## Path forward (identified plan)

Work **in this order**. Do not skip Phase 1 (honest benchmarks) to chase parser fixes — the gate cannot prove correctness until fixtures score 8/8.

### Phase 0 — Understand, then clean baseline

**Goal:** Dev server = e5 merge policy + cherry-picked extractors only (not ledger always-remap).

1. Read this file + transcript; run diagnostics on **current** uncommitted code (see Phase A below).
2. **Then** stash/branch the experiment (`git stash push -u -m "ledger-merge experiment"` or `git branch experiment/ledger-merge`).
3. `git checkout e5f3593 -- web/src/lib/tax/operating-expenses.ts web/src/lib/tax/merge-years.ts`
4. Remove `buildOperatingExpenseLedger` call from `parse-from-text.ts` (~1693) if only used for failed merge.
5. Re-apply Stmt-2 / comparison extractor changes **one file at a time** with benchmarks — not the align rewrite.
6. Run `npx tsx scripts/benchmark-ui-session.ts balanced` — record baseline (~95% avg opex on old scoring).

**Done when:** Carithers 2025 NI back near e5 (~67k), not local (~43k).

### Phase 1 — Honest benchmarks (blocks everything else)

**Goal:** Benchmark fails on bugs we already know exist (repairs missing, wrong slot).

1. Run `python scripts/extract-integrator-fixtures.py` (or merge `compare-true-top8.json`) — add **`top8Amounts` + `top8Labels`** for every client/year, **including KCF**.
2. Update `changwen-fixtures.json` and KCF in `workbook-comparison-fixtures.ts`.
3. Gate must use `resolveExpectedTop8Amounts()` — score **8 amounts**, not 4–6.
4. Add **per-slot opex scoring** (correct amount in correct paste row, not multiset only).
5. Re-run `score-true-top8-compare.ts` and `dump-opex-detail.ts` on e5 baseline.

**Done when:** Carithers 2025 shows **7/8 or worse** on true top8 (not 6/6 = 100%) with repairs $10,786 missing.

### Phase 2 — Root parser fix: Carithers repairs vs form advertising

**Goal:** Fix Problem #1 without touching merge policy.

**Bug:** Form 1120-S line 16 **$300 advertising** fills slot `advertising` (integrator row 3 = repairs). `fillWeakSlotsFromCategorizedLines` skips repairs because `isProtectedOpexSource("Form 1120-S line 16")`.

**Fix (generalized):** In `fillWeakSlotsFromCategorizedLines` (e5 `operating-expenses.ts`): when advertising slot is form-sourced and **&lt; ~$1,000**, and Stmt-2 has **repairs** larger than that amount → repairs wins slot 3; move tiny advertising to **other_operating_expenses** (or leave in other_opex bucket).

**Proof after each attempt:**
```bash
cd web
npx tsx scripts/dump-opex-detail.ts balanced carithers
npx tsx scripts/score-true-top8-compare.ts
npx tsx scripts/benchmark-ui-session.ts balanced carithers
```

**Done when:** Carithers 2025 slot 3 = **10,786**; other_opex moves ~$300; true-8 improves; **no other client regresses**.

### Phase 3 — P&L closure in benchmark + UI flags

**Goal:** NI gaps cannot hide behind internal workbook math.

1. Re-run `flagPnlIdentityMismatches` **after** `alignOperatingExpensesAcrossYears` in `finalizeTaxColumns`.
2. Benchmark gate: compare workbook **NPBT** vs `scanFormOrdinaryBusinessIncome`; **GP** vs `scanFormGrossProfit` when present — fail if gap &gt; 0.5%.
3. Flag formula rows (`net_profit_before_taxes`, `operating_profit`, `net_income`) as `math-warning`, not only `other_operating_expenses`.
4. Refresh `parserFormulaBaseline` after merge so formula hints are not stale.

**Done when:** e5 Carithers **fails** NPBT gate before Phase 2; **passes** after Phase 2.

### Phase 4 — Client-by-client surgical fixes

**Only after Phases 1–3.** One client per change; benchmark all 4 after each.

| Client | Known issue | Where to look |
|--------|-------------|---------------|
| **Carithers** | other_opex 8,818 vs 9,118 ($300) | `other-operating-expenses.ts`, Phase 2 fallout |
| **KCF** | 2024 other_opex; bank payables vs charges | `statement-extractors.ts`, `opex-candidate-ranking.ts` |
| **Arizona** | bank/supplies evicted by remap | Should not recur if e5 merge guard kept |
| **SSSI** | Schedule L, salaries line-13, partial fixtures | `schedule-l.ts`, fixtures, comparison rows |

### Phase 5 — OCR cache parity (parallel)

Ensure `web/scripts/ocr-cache/` has `{client}-{year}-balanced.txt` for KCF, Arizona, SSSI (Carithers already has balanced). Fair comparisons require frozen OCR across clients.

### Exit criteria (definition of done)

| Metric | Target |
|--------|--------|
| Opex | **8/8** multiset **and** per-slot, every year, all 4 clients |
| Non-opex fields | **≥99%** vs integrator |
| P&L | **0** NPBT vs form ordinary-income failures when form line in OCR |
| Green-danger | **0** wrong values in trusted tiers |
| Merge | e5 **strongCount → label-sync-only**; no unconditional shared remap |
| Labels | **0** unclean opex labels (existing gate) |

### What NOT to do

- Do **not** keep building the ledger-first always-remap merge (local ~766-line `operating-expenses.ts` experiment).
- Do **not** trust multiset 100% until Phase 1 fixtures are complete.
- Do **not** large merge rewrites without per-change benchmark on all four clients.

---

## Iteration workflow (maps to path forward)

**Phase A — Understand (no stash yet)** → Path **Phase 0** step 1

1. Read this file and `agent-transcripts/3f012c05-e378-4407-bd2e-446cf6beee6e/3f012c05-e378-4407-bd2e-446cf6beee6e.jsonl`.
2. Run diagnostics on **current** uncommitted code:
   ```bash
   cd web
   npx tsx scripts/score-true-top8-compare.ts
   PIPELINE_LABEL=local npx tsx scripts/dump-opex-detail.ts balanced carithers
   npx tsx scripts/benchmark-ui-session.ts balanced carithers
   ```
3. Read `benchmark-output/opex-detail-e5f3593-balanced.json` vs `opex-detail-local-balanced.json`.

**Phase B — Stash + restore baseline** → Path **Phase 0** steps 2–6

**Phase C — Honest benchmarks** → Path **Phase 1**

**Phase D — Surgical fixes** → Path **Phases 2–4**

**Phase E — Loop until exit criteria** → Path **Phase 4–5** + exit table above

---

## Why we are bloated

| File / area | ~Δ lines | Role |
|-------------|----------|------|
| `web/src/lib/tax/operating-expenses.ts` | +519/−247 | Ledger-first, always shared top-8 — **revert** |
| `web/src/lib/tax-return/statement-extractors.ts` | +235 | Stmt-2 lines — **cherry-pick** |
| `web/src/lib/tax/apply-user-correction.ts` | +104 | Review snapshot — **keep** |
| `web/src/lib/tax-return/comparison-field-rows.ts` | +107 | Comparison parsing — **keep** |
| Benchmark scripts + `fixture-top8.ts` | untracked | **keep** |

~70% of diff is failed merge rewrite.

---

## Key files for handoff

### Parser & merge (production path)

| Path | Purpose |
|------|---------|
| `web/src/lib/tax-return/parse-from-text.ts` | Main parse; P&L at ~1700 **pre-merge** |
| `web/src/lib/tax-return/pnl-identity.ts` | Form GP / ordinary income; reverse other_opex |
| `web/src/lib/tax-return/statement-extractors.ts` | Stmt-2; local adds expense line extraction |
| `web/src/lib/tax-return/other-operating-expenses.ts` | `reconcileOtherOperatingExpenses` |
| `web/src/lib/tax-return/comparison-field-rows.ts` | Two-year comparison rows |
| `web/src/lib/tax/operating-expenses.ts` | **Largest diff** — merge / top-8 |
| `web/src/lib/tax/merge-years.ts` | `finalizeTaxColumns` |
| `web/src/lib/tax/client-merge.ts` | `mergeParsedTaxYears` (UI entry) |
| `web/src/lib/tax/reconcile-tax-year.ts` | Flags; P&L → other_opex only |
| `web/src/lib/tax-workbook.ts` | Paste TSV, `.00` format |
| `web/src/lib/tax/workbook-formulas.ts` | GP → OP → NPBT → NI |
| `web/src/lib/tax/field-trust-tier.ts` | Green/yellow tiers |

### Benchmarks & fixtures

| Path | Purpose |
|------|---------|
| `web/scripts/benchmark-ui-session.ts` | **Primary gate** |
| `web/scripts/lib/tax-benchmark-score.ts` | Field + opex scoring |
| `web/scripts/lib/tax-benchmark-confidence.ts` | Green-danger / calibration |
| `web/scripts/lib/workbook-math-audit.ts` | Internal formula only |
| `web/scripts/lib/tax-benchmark-clients.ts` | Four clients |
| `web/scripts/changwen-fixtures.json` | 3 clients — **incomplete opex** |
| `web/src/lib/workbook-comparison-fixtures.ts` | KCF — 8 slot IDs, no top8Amounts |
| `web/src/lib/tax/fixture-top8.ts` | `resolveExpectedTop8Amounts` (untracked) |
| `web/scripts/compare-true-top8.json` | Honest 8 amounts — **not in gate** |
| `web/scripts/extract-integrator-fixtures.py` | Extract top8 from Excel |
| `web/scripts/dump-opex-detail.ts` | Slot / NI dump (untracked) |
| `web/scripts/score-true-top8-compare.ts` | True-8 re-score (untracked) |

### Benchmark artifacts (`web/scripts/benchmark-output/`)

| File | Notes |
|------|-------|
| `opex-detail-e5f3593-balanced.json` | Carithers dump — **e5** merge |
| `opex-detail-local-balanced.json` | Carithers dump — **local** merge |
| `ui-session-balanced-*.json` | Latest balanced runs (many timestamps) |
| `ui-session-thorough-1783367155856.json` | Example thorough snapshot |
| `dump-e5.err`, `dump-local.err` | Multi-client dump failures (missing balanced cache) |

### Backups & cache

- `web/scripts/.compare-backup/` — six files before e5↔local file swaps
- `web/scripts/ocr-cache/` — frozen OCR; Carithers balanced present; KCF/Arizona/SSSI balanced may be missing

### UI

- `web/src/components/tax/TaxWorkbookCopyBar.tsx` — integrator paste
- `web/src/components/tax/TaxWorkbookTable.tsx` — table display
- `web/src/app/tax/page.tsx` — Tax tab

---

## Architecture (data flow)

```
PDF upload
  → embedded text + OCR (fast / balanced / thorough)
  → parseTaxReturnFromText (per year)
  → mergeParsedTaxYears (all years)
  → finalizeTaxColumns
       → applyCrossYearComparisonBackfill
       → alignOperatingExpensesAcrossYears  ← main opex risk
       → snapshotParserFormulaBaseline
  → Tax workbook table + Excel paste TSV
```

### Commands

```bash
cd web
npx tsx scripts/benchmark-ui-session.ts balanced           # all clients
npx tsx scripts/benchmark-ui-session.ts balanced carithers # one client
PIPELINE_LABEL=local npx tsx scripts/dump-opex-detail.ts balanced carithers
npx tsx scripts/score-true-top8-compare.ts
```

---

## What this project should be

A **focused integrator paste tool**: parse well per year, **guarded** multi-year label sync, honest 8-row opex accuracy, form-anchored P&L closure, benchmarks that cannot pass on wrong slots or missing repairs. Surgical fixes with per-change proof — not ledger-first always-remap without a gate that measures real failures.

---

## Issues encountered (historical)

| Issue | Detail |
|-------|--------|
| Carithers 2025 “100%” opex | $300 form advertising in slot 3; $10,786 repairs missing; other_opex 8,818 vs 9,118 |
| Carithers local NI | 2025 NI 42,777 vs e5 67,453; multiset still 100% |
| KCF bank | Stmt-2 bank/merchant → `bank_credit_card` works on e5 |
| Arizona | Unconditional shared top-8 evicted bank/supplies |
| SSSI | Schedule L, salaries line-13, partial fixtures |
| `dump-opex-detail.ts` | Use `mergeParsedTaxYears([], incoming)` |
| JSON BOM | Strip `\uFEFF` when reading PowerShell-written JSON |
| `debug-opex-candidates.ts` | Circular import |
| `parserFormulaBaseline` | Stale after merge |
| Dev server | Runs **uncommitted** code, not e5 HEAD |

---

## Agent iteration prompt

Use this as the first message to a new agent (or `@AGENTS.md` + this block):

```
You are continuing work on ReportGen (tax PDF → integrator Excel paste). Read AGENTS.md fully before any code change.

Context:
- HEAD is e5f3593 (good merge policy); ~1,429 lines uncommitted include a FAILED ledger-first always-remap experiment in operating-expenses.ts.
- Do NOT stash or revert until you have read AGENTS.md, score-true-top8-compare output, and opex-detail dumps. Then stash/branch the experiment and restore e5 merge policy yourself.
- Benchmark currently lies: Carithers fixtures only score 6/8 opex amounts; true 8-field score is ~85% e5 / ~72.5% local. Multiset ignores slot assignment.
- Root parser bug: Form $300 advertising blocks Stmt-2 repairs ($10,786) in slot 3 (advertising row) via fillWeakSlotsFromCategorizedLines + isProtectedOpexSource.

Your job: iterate until UI-session benchmark passes with HONEST gates (8/8 opex + per-slot + NPBT vs form ordinary income when available), all 4 clients, balanced cached OCR.

Rules:
- Generalized fixes only (no client-specific hacks unless last resort).
- One surgical change at a time; benchmark after each (all 4 clients).
- Revert merge rewrite; cherry-pick Stmt-2 extractors only with proof.
- Minimize diff; do not commit unless asked.
- Loop: diagnose → fix → benchmark-ui-session balanced → dump-opex-detail / score-true-top8 → if fail, smaller fix or revert.

Start by reading AGENTS.md (especially "Path forward"), running score-true-top8-compare.ts and dump-opex-detail.ts, then Phases 0→5 in order.
```

---

## Agent transcript

Full conversation: `agent-transcripts/3f012c05-e378-4407-bd2e-446cf6beee6e/3f012c05-e378-4407-bd2e-446cf6beee6e.jsonl`
