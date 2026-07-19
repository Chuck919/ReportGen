# ReportGen — Agent Handoff

**Read this entire file before changing code.** Canonical product + iteration status as of **Jul 15, 2026 (evening)**.

Committed HEAD is still historically `e5f3593`. **Everything below is uncommitted** unless the user asked to commit. Dev server runs local uncommitted code. Production is **OVH VPS** (`https://reportgen.duckdns.org`) — not Vercel / Hetzner / Oracle.

Copy-paste iteration prompt: see [Agent iteration prompt](#agent-iteration-prompt).

---

## Where we are (Jul 15 evening)

### Holdout gate (sssi deferred)

| Fixture | Field | Opex | Cached | Live API (all years sequential) |
|---------|-------|------|--------|----------------------------------|
| kcf | 100% | 100% | PASS | PASS |
| carithers | 100% | 100% | PASS | PASS |
| arizona-sun | 100% | 100% | PASS | PASS |
| sssi | — | — | deferred | deferred |

Green-danger = 0 on the three holdouts. Charter smell backlog **S1–S15** is peeled/done.

### Threshold peel (Jul 18) — S16, all four fixtures 100/100 after each batch

All remaining paste-deciding `$`/`%` floors were replaced with structure (benched per batch, session + upload-routes green, sssi included):

| Old gate | Replacement |
|----------|-------------|
| Stmt-3 TOTAL `≥$50k`/`≥$15k` + start matching any `Statement 3 - Form 1120…` | Start requires `other deduct`/`RD-108` on the header line; TOTAL read = `readStatementTotalCell` (comma-grouped → trailing-period cell → 4+ digit run, rightmost column, keepable) |
| OD `readBlockTotal` `≥$1k` + `Math.max` | Same `readStatementTotalCell` (cell shape + column position) |
| Federal mini Stmt-1 total `<$50k` cap | `miniTableTotalWithClosure` — printed Total accepted only when its own detail rows exactly close to it |
| Federal residual nominations `≥$1_000` / `stmtTotal ≥$1k` | `≥ 1` (positivity only; residuals are constructed, crumbs already impossible) |
| Large-corp OD split `stmtTotal ≥ $100k` | `largeDetailSum > 0` — block has detail lines outside the recipe buckets, so recipes cannot partition it (structural) |
| Entity-caption garbage `>$250k`/`>$100k` + `anchor×2.5` | Label ends in entity suffix (`inc/llc/corp`, ≤8 words); detail line `> block TOTAL` identity; date+clock page-header bleed and `isEinOrPaymentInstructionBleed` rejected at push time |
| Books other-income `<$50k` token cap | `isKeepableWorksheetAmount` tokens |
| Coverage-rescan hints `≥$5k` ×2 | `≥ 1` (keepable already enforced upstream) |
| Form-1041 `common_stock ≥$1000` / sales schedule `≥$100k`+max | `isKeepableWorksheetAmount` + rightmost cell |
| Formula-hint tolerance `0.5%` (`workbook-display`) | Dollar-exact (±$1) |

Also: dead `scanStmt2AmountsInBand` deleted; `OPERATING_EXPENSE_SLOT_IDS` now lives in leaf module `web/src/lib/tax/opex-slot-ids.ts` (breaks the `workbook-formulas ↔ operating-expenses` import cycle; `operating-expenses` re-exports it).

**Still numeric but charter-acceptable (do not "fix"):** LINE_NUMBER_TRAP ≤$99, tax-year 1990–2035, nominal par set, 7-digit `isReasonableMoneyAmount`, OCR digit-shape repairs in `money.ts`, text scan windows (12k/30k/80k chars), OCR mode timing estimates, YoY flag bands in `cross-year-*` (flag/diagnostic only — never change values; `consistencyScore` is stored but excluded from `totalScore`).

### What is left

1. **Phase C — sssi** — incomplete top-8 / mega-salary OCR (~63.9% opex historically). Do not peel floors to paper over; extraction-first when started.
2. **Ship** — commit uncommitted Jul 13–15 work → push `master` → redeploy OVH (`npm run deploy:vps` / VPS README) after UI live smoke looks good.
3. **Optional** — `UI_BENCH_LIVE_BATCH=1` multi-file POST parity; any residual Schedule L soft layout that still rewrites paste (bench after each peel).
4. **Timing bands** (per-PDF wall clock, workers≥2):
   - **Typical returns (~40–80pp):** fast ≈0.5–2 min · balanced ≈3–5 min · thorough ≈3.5–5 min (often under the UI progress targets of 2–3 / 5–6 / 7–10).
   - **Large packs (140–180pp arizona):** balanced/thorough ≈6.5–11 min per PDF — phase-2 caps scale down after 100pp but wall clock still exceeds the 5–6 / 7–10 progress targets.
5. **Thorough ≥ balanced** — live thorough must never regress holdout accuracy vs balanced. Stale `*-thorough.txt` caches (Jul 2) are not the gate; live regenerates OCR.

### Live timed results (Jul 16 re-run)

| Mode | kcf | carithers | arizona-sun | Notes |
|------|-----|-----------|-------------|-------|
| balanced | PASS 100/100 | PASS 100/100 | PASS 100/100 | Ship gate |
| thorough | PASS 100/100 | PASS 100/100 | PASS 100/100 | ≥ balanced (LTD fix) |
| fast | FAIL (preview) | PASS | FAIL (preview) | Timing/preview only |

Per-PDF (s): balanced kcf ~187–232 · carithers ~223–252 · arizona ~388–664; thorough slightly longer; fast carithers ~27–39s.

### UI smoke notes (Jul 16)

- **kcf / carithers / arizona** sampled amounts + top-8 + other_opex match fixtures on balanced live (user paste).
- **arizona 2023 missing** in one UI session — empty/invalid JSON on large PDF; retry that year.
- **carithers 2022 amort 1945** low-trust warning while fixture is 0 — bench alias allows small actual when expected 0; warning is correct.
- **Schedule L line 17** — spaced begin-column OCR (`1 564`) no longer steals end-year `386.` (thorough ≥ balanced).

### Fixed parameters (do not invent new `$` / `%` gates)

| Parameter | Value | Where / meaning |
|-----------|-------|-----------------|
| Holdout clients | `kcf`, `carithers`, `arizona-sun` | Bench gate; `sssi` out of scope until Phase C |
| Primary OCR mode | `balanced` | Tax-tab default / UI-session gate |
| OCR modes | `fast` / `balanced` / `thorough` | `web/src/lib/tax/ocr-modes.ts` |
| Exact closure | `$1` (`exactClosureTolerance` → `1`) | Stmt/Form TOTAL agreement — no soft 1%/$50 |
| Line-number crumb | `abs ≤ 99` | `LINE_NUMBER_TRAP` / keepable worksheet rejects |
| Tax-year crumb | `1990–2035` | `isKeepableWorksheetAmount` / money helpers |
| Nominal par (capital stock) | `{100, 500, 1000, 5000, 10000}` | IRS par vocabulary — Schedule L / equity roll |
| BS nominal-par roll | gap ∈ nominal par, stock seats blank, Sched L RE present | `equity-buckets.ts` — live OCR miss of line 22 |
| UI-session gates | field ≥99%, opex ≥99%, greenDanger=0, math=0, FP≤5%, yellow≤10% | `benchmark-ui-session.ts` |
| Bench timeout | `BENCHMARK_TIMEOUT_MS` default **25 min** | Per live client process |
| Progress-bar OCR estimate (per PDF) | fast **2.5 min**, balanced **5.5 min**, thorough **8.5 min** | `estimateOcrDurationMs` — large 100+ page packs run longer |
| Live API | `UI_BENCH_LIVE=1` + `BASE_URL` (default `http://localhost:3000`) | One POST per PDF then `mergeParsedTaxYears` |
| Live batch | `UI_BENCH_LIVE_BATCH=1` | Single multi-file POST (optional parity) |
| Auth | `PARSE_TAX_API_KEY` Bearer if set in `.env.local` | Live benches / API |
| Prod URL | `https://reportgen.duckdns.org` | OVH VPS |
| OCR cache path | `web/scripts/ocr-cache/{fixture}-{year}-{mode}.txt` | Cached gate |
| Empty API body | Client shows `Empty response… retry this year` (not raw JSON SyntaxError) | `parse-tax-return.ts` — failed year skipped from merge |

---

## Product goal (non-negotiable)

ReportGen parses corporate tax PDFs (1120 / 1120-S + attachments) → integrator Excel paste (fixed workbook rows). Success is measured against **integrator Excel fixtures**, post-merge (same path as Tax tab UI).

### Success criteria (current iteration charter)

1. **100% top-8 amounts** on all years × all 4 holdout fixtures — **exact dollars** (`Math.round` equality).
2. **Readable labels** for those amounts (whatever OCR caption we scanned — not forced semantic slot names).
3. **No hardcoded / arbitrary / company-specific thresholds** (no `if (client === '…')`, no sales×0.4 caps, no “insurance belongs in bank slot”, **no taxpayer/preparer names in production logic or comments**).
4. **Scoring / ranking identity = amount exists + readable label only.**  
   - Do **not** require amount→slot-id assignment for the gate.  
   - Do **not** add “category X must land in paste row Y” logic.  
   - Workbook still has 8 paste *rows* (positions); row IDs (`advertising`, `bank_credit_card`, …) are **paste indices**, not semantic categories. Integrator row 3 may be “Repairs” while the id is still `advertising`.
5. **other_operating_expenses exact** — secondary priority after top-8 amounts.
6. Non-opex fields ≥99% exact vs fixtures; green-danger = 0.

### Generality rules (new companies)

- Build for **any** corporate return. Fixture ids (`kcf` / `carithers` / …) exist **only** in benches/fixtures — never in parse logic.
- **Trailing-period amount cells** (`8.`, `1,234.`) come from **dense preparer PDF exports** (historically referred to as “REDW-style”). That is a **layout grammar**, not a client company. Prefer names like `trailingPeriodCell` / “preparer dense export”.
- **Taxpayer name extraction is unreliable** (preparer firm / schedule captions often win). Use soft identity keys for same-vs-different merge only. **Do not show OCR’d legal names to users** — warn “Different company detected…” without quoting names.
- `liquor tax payable` in filters = **balance-sheet liability caption**, not a fixture brand.

### Out of scope

- Excel column ordering beyond integrator paste.
- Big-bang merge rewrites without per-change 4-fixture benches.
- Multiset-only scoring that ignores missing amounts (fixtures must list all 8).
- Per-slot semantic assignment as a *correctness* requirement.

---

## Current status detail (Jul 15, 2026)

### Bench (stable — holdouts ignore sssi)

| Fixture | Field | Opex | Notes |
|---------|-------|------|-------|
| kcf | 100% | 100% | PASS (cached + live API all years) |
| carithers | 100% | 100% | PASS (cached + live API all years) |
| arizona-sun | 100% | 100% | PASS (cached + live API all years) |
| sssi | — | — | Phase C — deferred |

Green-danger = 0 on kcf / carithers / arizona-sun.

### Root-cause: Schedule L equity caption + legacy soft helpers (Jul 15 evening)

**Cause:** Line-24 equity on dense preparer exports is captioned `SCHEDULE L, LINE 24, COLUMN (D) 4,248,685.` (trailing-period cell). Matcher only accepted leading `24` / “retained earnings”, so UI screen-table crumbs won (or blanked after coherence). Paired-column other-stock scan also accepted non-keepable crumbs (`22`). Soft `closureTolerance` / unused ML ranker / coverage `$`/`%` density bands remained as dead legacy.

**Fixes (generic):**
1. Prefer `LINE 24, COLUMN (D)` / balance-at-end captions + keepable dollars; skip `screen table` crumbs; magnitude only as same-score tie-break.
2. Paired-column ST-debt / other-stock: keepable prior|current structure (drop `$200k` band); AR-echo compact detect = exact dollars.
3. Coverage diagnostics: exact opex closure 0/1; incomplete detail = under OD total; drop `$5k` invent / density `$` bands.
4. Delete unused soft `closureTolerance` / `valuesClose` / `formulasDisagree` and off-path ML ranker weights + train script (`train:opex-ranker` npm script removed).
5. When Sched L RE is in unclassified, stock seats blank, and BS gap is an IRS nominal-par amount — roll gap into equity (live OCR miss of line 22).
6. Schedule L line 17 — prefer trailing-period end-of-year column; never glue spaced begin-column OCR (`1 564` → 1564) ahead of end `386.` (thorough ≥ balanced).

---

### Root-cause: Form-OI reverse shrink after cross-year top-8 (Jul 15)

**Cause:** Post-align `applyOrdinaryIncomeReverseOpexFromAnchor` treated Form ordinary-income identity as authoritative for `other_opex`. Cross-year top-8 remapping changes paste-row overhead (positions ≠ Form line categories), so reverse often *understates* other_opex (carithers 2022: true itemized **8320** → reverse plug **6375**). Soft `$` / invent gates had been hiding related residual races.

**Fixes (generic):**
1. Prefer labeled Stmt itemized residual (`office/supplies|telephone/travel`) when partition identity disagrees (`resolveOtherOperatingExpenses`).
2. Never **shrink** labeled Stmt itemized other_opex with a smaller Form-OI plug; still allow a *larger* plug when itemized under-counted (kcf 2023 **17425**).
3. Do not invent early `TOTAL − (bank+prof+util)` when TOTAL known — leave residual to align identity.
4. Peeled leftover `$1000` office/misc sum floors → `isKeepableStmtDetailAmount`.

### Root-cause size/% peel (Jul 15 continued)

**Cause:** Remaining `$1000` / `$5000` / `×0.95` / `>0.15` gates papered over line-number crumbs and multi-column bleed instead of keepable/exact structure.

**Fixes (generic):**
1. `scanStmt2MiscLineAmounts` — keepable Stmt detail only (no `$1000`/`$500k` bands); reconstruct/rank still gated by exact TOTAL agreement.
2. Form line OD total — keepable tokens + unambiguous single-cell preference (no `$5000` floor).
3. AP / gross_fixed confidence — LINE_NUMBER_TRAP ≤$99 only (no bare `<$1000` wipe).
4. Schedule L amort rescan when `accum < gross` (drop `×0.95`); OCL stmt overlay skipped on exact Schedule L disagree (drop `>0.15` / `$1k`/`$40k`).
5. `other_assets` / `other_current_assets` OCR clears — require Line 14 / Line 6 corroboration (no `$10k`/`$50k` size).

### Root-cause scanner + ranking peels (Jul 15 later)

**Cause:** `line-hits` / Form sales / opex ranking still used `$` / `%` to pick among OCR crumbs; soft closure scores could paste winners when TOTAL didn't exact-close. Form line 5 “See Stmt” also pasted box dollars into other_income (broke reverse other_opex).

**Fixes (generic):**
1. `line-hits` — caption / line-anchor required (no `<$1k` / `<$10k` / `≥$100k` size rejects).
2. Form sales / orphan page-1 — `keepableSalesAmount` + unambiguous cell (no `$50k`/`$100k`/`$1k` floors); 1120 interest only on kind=`1120`.
3. Form line 5 other income — attachment pointer does not paste box $; Stmt/comparison/zero paths decide.
4. Opex ranking — exact TOTAL closure only (`closureScore` 0/1); integer evidence priority; no ML 0.35/0.65 on paste; reconcile paste from exact closers only.
5. `withinTolerance` → dollar-exact; Schedule L cash/gross/10b keepable + exact net-book structure (no `×0.25` / `$10k`).

---

## Prior status (Jul 14, 2026)

### UI / merge / hygiene (keep)

| Change | Why |
|--------|-----|
| Taxes seat only anchors Form/comparison/stmt sources (`filterRankExpensePool`) | Second finalize treated rank-pasted professional fees in `taxes_licenses` as taxes truth |
| No extra `finalizeTaxColumns` after `mergeParsedTaxYears` in `use-tax-upload.ts` | Same double-finalize bug |
| `shouldClearForDifferentCompany` + `clientKeyQuality` (`client-merge.ts`) | Progressive upload wiped years on preparer/junk client keys |
| Dropzone allows merge while table present | Users could not add later-year PDFs |
| `benchmark-ui-upload-routes.ts` | Progressive / startParse / session-restore parity vs batch |
| Different-company warning **without OCR names** | Names unreliable; show detection only |
| Strip taxpayer names from prod logic/comments; trailing-period / paired-column structural | Generality |

### Hosting / dead-code cleanup (Jul 13)

- Removed Vercel / Hetzner / Oracle deploy configs, Supabase client, multipass/Vercel bench scripts.
- Deleted unused audit/score helpers: `opex-label-value-benchmark.ts`, partition-audit exports, `buildOtherOpexClosurePool` / `auditOtherOpexResidual`, no-op `fillWeakSlotsFromCategorizedLines`, unused `matchTop8OpexAmounts`.
- Interest crumbs: bare `<$200` / `===163` / `<$5k` non-Form clears → **Form 8990 / §163(j) source-context only**. Kept structural Form line-number traps.

### Bench snapshot (Jul 14)

| Fixture | Field | Opex | Notes |
|---------|-------|------|-------|
| kcf | 100% | 100% | PASS |
| carithers | 100% | 100% | PASS (compact paired-column Schedule L) |
| arizona-sun | 100% | 100% | PASS — 2023 dep fixed (multi-column Form bleed + verification snapshot undo); other_opex charter identity |
| sssi | ~98% | ~63.9% | Phase C — deferred |

Green-danger = 0 on kcf / carithers / arizona-sun.

### Root-cause residual fix (Jul 14)

**Cause:** Soft floors ($5k / ×0.97 / ×0.92 sticky priors) existed because several hand label-bucket recipes (`opex = TOTAL − fixed categories`, sourced as “summed detail”) always closed by construction; when OCR under-excluded, a collapsed recipe marked **authoritative** blocked align’s `stmtTOTAL − stmtInTop8`. Separately, bare `Attachment table` sources were excluded from partition membership, so identity often never fired (stmtInTop8=0) and recipes filled the hole.

**Fixes (generic):**
1. Authoritative other_opex priors = inventory only (`office/supplies`, comparison OD residual) — not formula recipes.
2. Large-corp block path: drop typeA/consulting/IT/$5k/×0.97 recipe enumeration; soft classic for ranking only.
3. Treat `Attachment table` as supplemental in `sumStmtAmountsInTop8` (capped by stmt TOTAL) so OCR-tagged OD lines join the partition.
4. Exact footer/combined traps + primary-line exclusion (no ×1% / `$500` OCR near-dup).
5. Identity residual keeps `usedStmtPartition` even when inventory source label matches — prevents form page-1 double-add.
6. Comparison field-rows: Form/Stmt rent dollar-disagree overwrite (no `>0.15` paste replace).

### Paired-column Schedule L — how it activates

Path: `extractEmbeddedScheduleL` → `extractPairedColumnScheduleL` (`embedded-schedule-l.ts`).

**Only runs when the layout matches** (not always):

1. Find `Schedule L` within ~400 chars of a trailing-period money token (`\d{1,3}(?:,\d{3})*\.`).
2. Slice ~900 chars; parse lines that contain those trailing-period cells into prior|current numeric rows.
3. Require **≥10** such rows.
4. Additionally require **either**:
   - Stmt markers near the head (`STATEMENT 8` / `STMT 7 STATEMENT 8`), **or**
   - **≥8** dense prior|current pairs (`row.length >= 2`).

Taxpayer names are **not** part of the fingerprint (removed). Source string stays `Embedded Schedule L (paired-column)`.

### Root cause (why floors/% existed)

OCR mixes real Stmt detail, Form page-1 lines, and junk (years, line #s, footer echoes). Size floors suppressed bad extractors instead of fixing them.

**Smoking gun:** residual truth is `stmt TOTAL − stmtInTop8` including micro lines like `TRAVEL 8.` from trailing-period cells. Extractors dropped them (`abs < 10` / `amt < 50`) **and** global money parse never saw `8.` cells. Incomplete office/detail sum then competed with residual; `%` bands blocked the wrong candidate.

### Charter smell experiments (Jul 13–14)

| # | Change | Result |
|---|--------|--------|
| … | Earlier sales-% / bank×% / soft-flag / advertising-seat / COGS>95% / paired-column rename | **Keep** |
| E1 | Stmt micro-lines: `stmtAttachmentMoneyTokens` + `isKeepableStmtDetailAmount` | **Keep** (scoped to Stmt; global trailing-period parse regressed holdouts) |
| E2 | Stmt residual `%` bands → `< stmtTotal` + closure | **Keep** |
| E3 | Delete unlabeled misc sum + `$500` MISC_FLOOR | **Keep** |
| E4 | Bank clears → Stmt footer only (not ×0.35) | **Keep** |
| E5 | Residual `$100` / pool `MIN_LINE` → `isKeepableResidualAmount` (+ typeA ×0.92 → `< stmtTotal`) | **Keep** |
| E6 | Bulk drop `$5k`/`$10k`/`×0.97` | **Revert** — other_opex collapse when typeA under-excludes |
| E6b | `contractLabor ×0.5` → `≥ stmtTotal` | **Keep** |
| E6c | Drop `×0.97` alone | **Revert** — same collapse |
| H1 | Client-name hygiene + anonymous company warning + structural paired-column | **Keep** (Jul 14; re-bench if Schedule L drifts) |

---

## Charter smell backlog (do not “fix” without extraction-first + bench)

**Policy:** one surgical change + full `benchmark-ui-session.ts balanced`. Prefer fixing extraction over deleting floors that paper over holes. **Do not implement these until asked.**

### P0 — still company-shaped or blocks odd returns

| ID | Location | Smell | Context | Preferred fix direction |
|----|----------|-------|---------|-------------------------|
| S1 | `statement-extractors.ts` large-path | ~~$5k / $10k / ×0.97 typeA recipes~~ | **Removed** (Jul 14) — inventory identity at align; soft classic only | Done |
| S2 | `opex-candidate-ranking.ts` | ~~attach / wideExcl `×0.92`~~ | **Removed** (Jul 14) — fold wideExcl only when `known+wide < stmtTOTAL`; doc residual `$5k`/`$1k` → `< TOTAL` + `$1` | Done |
| S3 | `confidence-gates.ts` | ~~`other_opex < $1000`~~ | **Removed** (Jul 14) — LINE_NUMBER_TRAP ≤$99 + form-ref/year only | Done |
| S4 | `structural-tolerance.ts` / extractors | ~~Soft `closureTolerance` harvest~~ | **Peeled** (Jul 14) — exact TOTAL / densest proper-remainder harvest; adjunct exact-eq only | Done |

### P1 — soft $ / % still driving correctness

| ID | Area | Examples | Notes |
|----|------|----------|-------|
| S5 | `comparison-opex.ts` | ~~`$5k`/`$150k` / soft close / `$500` traps~~ | **Peeled** (Jul 14) — fold + residual `$1`; footer/combined traps dollar-exact |
| S6 | `comparison-field-rows.ts` | ~~`>0.15` / ×0.5–0.75 / rent near ×5% / taxes `$50k` split~~ | **Peeled** (Jul 14) — missing/weak (+ Form salaries caption) only; Form/Stmt rent dollars win on disagree; taxes split = `taxes − paid` identity |
| S7 | `statement-extractors.ts` | ~~bare Total `$10k`/`$50k`; bank `>0.15`; rebuilt soft close; primary ×1%; `$500` office invent; stmt3 ×0.95~~ | **Peeled** (Jul 14) — exact primary exclusion; keepable office detail; stmt3 `< TOTAL`; block corroboration exact |
| S8 | `stmt2-bank-picker.ts` / `stmt2-total-inference.ts` | ~~`$5k`/`$500`/`×0.35`/0.98–1.15~~ | **Peeled** (Jul 14) — Form/footer exact agreement; labeled bank + dollar-exact misc close |
| S9 | `opex-candidate-ranking.ts` | ~~5%/15% winner swaps; soft invalidation~~ | **Peeled** (Jul 14) — exact TOTAL closers first; `preferCandidate` score/evidence; office invalidate only when not a proper remainder |
| S10 | `other-operating-expenses.ts` | ~~`sales * 0.05`~~ | **Gone** — helper file removed; identity path at align |
| S11 | Rank path `operating-expenses.ts` | ~~`MIN_EXPENSE_AMOUNT = 100`~~ | **Peeled** (Jul 14) — `isTop8EligibleAmount` / `isKeepableResidualAmount` / `isExpenseRankCrumb`; dollar-exact dupes |

### P2 — non-opex / BS / equity (same charter spirit)

| ID | Area | Smell |
|----|------|-------|
| S12 | `equity-buckets.ts` / `coherence-gates.ts` / `parse-from-text.ts` | ~~`$5k–$400k` / `%` near-eq equity~~ | **Peeled** (Jul 15) — source-structure (paired-column / weak bleed / exact dup); Form/Stmt amort beats BS fully-amortized zero |
| S13 | `form-anchors.ts` | ~~multi-column Form line-14 dep~~ / ~~OD `$5000` floor~~ | **Peeled** (Jul 14–15) — unambiguous cell; keepable OD tokens |
| S14 | `parse-from-text.ts` / … | Dep overlays + ~~`$10k`/`$50k` OCR other_assets~~ | **Peeled** (Jul 14–15) — Line 14/6 corroboration |
| S15 | `schedule-l.ts` / `confidence-gates.ts` | ~~amort `×0.95`~~ / ~~OCL `>0.15`~~ / ~~AP `<$1000`~~ | **Peeled** (Jul 15) — exact / ≤$99 trap |
### Already acceptable / false positives

- Trailing-period Stmt money helpers (E1) — preparer layout grammar.
- Paired-column path — structural (see above).
- Pool `amount > sales` — identity, not a % band.
- Rank paste into `OPERATING_EXPENSE_SLOT_IDS[i]` — positions, not categories.
- No live insurance→bank seat assignment.
- Fixture filenames / bench client ids — test harness only.

### Holdout misses (product Phase C — not “add a floor”)

- sssi: incomplete top-8 amounts / mega-salary OCR (~63.9% opex) — deferred.
- arizona other_opex now charter identity (fixture updated); S1 recipe floors removed.

---

## Prior status snapshot (Jul 12 ranking cleanup)

| Change | Outcome |
|--------|---------|
| Allow `label:` into top-8 rank | Restored exclusion (OCR junk flood) |
| Delete adv↔repairs keep-larger / repairs→advertising map | Deleted (charter) |
| Remove `$100` ranking floor | Restored (line-number crumbs) |
| Comparison `labelPrefix` bleed | Fixed |

---

## Net income / P&L double-check (implemented)

`finalizeTaxColumns` → after `alignOperatingExpensesAcrossYears` → `reflagPnlIdentityAfterOpexAlign` → `refreshTaxYearVerification`. Formula rows get `math-warning` when P&L warnings fire. Does **not** auto-correct top-8. Form-OI reverse may fill other_opex when residual fails identity, but **never shrinks** labeled Stmt itemized residuals.

Key files: `pnl-identity.ts`, `merge-years.ts`, `reconcile-tax-year.ts`.

---

## Next steps (ordered)

1. **UI live smoke** — Tax tab upload all years for holdouts against local `npm run dev`.
2. **Commit + push `master` + OVH redeploy** — only when user asks after smoke looks good.
3. **Phase C — sssi** top-8 (deferred; extraction-first).
4. Optional: `UI_BENCH_LIVE_BATCH=1` multi-file POST; residual Schedule L soft heuristics only with holdout bench.

---

## Architecture (data flow)

```
PDF upload
 → embedded text + OCR (fast / balanced / thorough)
 → parseTaxReturnFromText (per year)
 → mergeParsedTaxYears / finalizeTaxColumns
    → alignOperatingExpensesAcrossYears
    → reflagPnlIdentityFromAnchors + refreshTaxYearVerification
 → Tax workbook table + Excel paste TSV
```

### Key files

| Path | Role |
|------|------|
| `web/src/lib/tax/operating-expenses.ts` | Rank pool, top-8, other_opex |
| `web/src/lib/tax/client-merge.ts` | Progressive company-key wipe guard |
| `web/src/lib/tax-return/embedded-schedule-l.ts` | Paired-column Schedule L |
| `web/src/lib/tax-return/equity-buckets.ts` | Equity seat routing + nominal-par BS roll |
| `web/src/hooks/use-tax-upload.ts` | Upload / merge / finalize |
| `web/scripts/benchmark-ui-session.ts` | Primary gate |
| `web/scripts/benchmark-ui-upload-routes.ts` | UI route parity gate |

### Commands

```powershell
cd web
# Cached holdout gate (clear live env if set)
Remove-Item Env:UI_BENCH_LIVE -ErrorAction SilentlyContinue
npx tsx scripts/benchmark-ui-session.ts balanced
npx tsx scripts/benchmark-ui-session.ts balanced kcf   # or carithers / arizona-sun

# UI route parity
npx tsx scripts/benchmark-ui-upload-routes.ts balanced

# Live API — sequential all-years (matches Tax-tab UI)
$env:UI_BENCH_LIVE="1"; $env:BASE_URL="http://localhost:3000"
npx tsx scripts/benchmark-ui-session.ts balanced kcf

# Optional live multi-file batch POST
$env:UI_BENCH_LIVE_BATCH="1"
npx tsx scripts/benchmark-ui-session.ts balanced kcf
```

OCR caches: `web/scripts/ocr-cache/{fixture}-{year}-balanced.txt`.

Dev server: `cd web; npm run dev` → `http://localhost:3000`.

---

## Cleanup done this session (Jul 15)

- Hosting: Vercel / Hetzner / Oracle / Supabase removed; prod → DuckDNS / OVH.
- Soft `closureTolerance` / `valuesClose` / `formulasDisagree` deleted; only `exactClosureTolerance` ($1).
- Unused ML opex ranker (`src/lib/tax/ml/*`) + `scripts/train-opex-ranker.ts` + `train:opex-ranker` npm script removed.
- Debug `scripts/tmp-*` scratch files removed.
- Dead audit/score helpers + no-op semantic slot fill removed (earlier).
- Interest bare dollar floors → Form 8990 / §163(j) context-only.
- Client-name hygiene; trailing-period / paired-column structural.
- Smell backlog S1–S15 peeled (see tables above).

**Do not delete** `OPERATING_EXPENSE_SLOT_IDS` — paste row positions, not semantic categories.

---

## Agent iteration prompt

```
You are continuing ReportGen (tax PDF → integrator Excel paste). Read AGENTS.md fully before any code change.

Charter:
- Exact dollars only (exactClosureTolerance = $1; no soft $/% paste gates).
- Holdout gate: 100% top-8 + field on kcf / carithers / arizona-sun (sssi = Phase C deferred).
- Identity for keep/score: amount exists + readable label. NO slot-assignment correctness. NO client-specific thresholds or names in prod logic.
- Taxpayer OCR names unreliable — do not surface them; trailing-period cells = preparer layout.
- other_opex exact is secondary; large overs usually stmtInTop8 under-subtraction.
- Post-merge P&L flags vs Form ordinary income are wired — do not show green NI when off.

Smell backlog S1–S15 is done. Next: Phase C sssi (when asked) or ship to OVH after UI smoke.
Keep upload-routes parity green after merge/UI changes.

Rules: generalized fixes; one surgical change + full balanced UI-session bench; minimize diff; do not commit unless asked.
```
