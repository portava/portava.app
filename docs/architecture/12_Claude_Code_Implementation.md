# Claude Code Implementation — build order and rollout

*Derived from the repository, 2026-09-07. This document sequences the work named in `07`–`11`; it
does not restate their designs. Citation convention as in `11`: unless a path starts with `docs/`,
`.github/`, `supabase/` or `artifacts/`, it is relative to `artifacts/api-server/src/`. Every
current-state claim below was re-verified against the tree at this commit rather than inherited
from the document that first made it. Defers absolutely to `docs/discovery/ROADMAP.md` for what may
be started.*

**This is the SEQUENCING document.** `07`–`11` say what exists and what a correct design would
look like. None of them says what to do first, and three of them contain work that **may not be
started at all**. That is the gap this file closes, and it closes it in one direction: it orders
work, marks what is blocked, and proposes no flag flip, no ranker change and no new capability that
a standing ruling has not already permitted.

**The stub this replaces read "Build order and rollout." Both halves are here; the order matters
more than the rollout, because the most common failure available in this repo is not building the
wrong thing — it is building a real thing on top of a record that was already wrong.**

---

## 0. The honest headline — what fraction of `07`–`11` is built

| Doc | Subject | Built and reaching a user | Built and switched OFF | Designed only, zero code |
|---|---|---|---|---|
| `07` | Creator economy | **1 of 4 standings** — contribution level L1–L5, derived on read (`services/passport/PassportReputationService.ts:134-160`) | CreatorActivityScore (`ACTIVITY_DISCOVERY_BOOST_ENABLED` seeded false, `migrations/2084_codify_live_read_flags.sql:55`); non-cash credits (`intel_rewards` seeded false, `migrations/2170_intel_reward_ledger.sql:61-63`) | Traveler Impact as a measured construct; every rule D1–D8; all Sybil resistance |
| `08` | Revenue model | **nothing** | the marketplace itself — `rent_buddy_enabled` seeded false (`migrations/2210_rent_buddy_default_off.sql:29-31`) | 6 of 7 revenue lines; subscriptions; entitlements; multi-currency |
| `09` | Payments | **nothing** | — | **sections 3–10 in full**: wallet, double-entry ledger, attribution, idempotency, FX settlement, payout lifecycle, refunds, audit posture |
| `10` | Database | **almost all of it** — 416-file canonical chain, applier, ledger, RLS posture, CI | — | Event Truth; a live-side inventory; a workflow for `audit:live-unexplained` |
| `11` | API | **almost all of it** — 1382 registrations, one envelope writer, fail-closed admin guard | — | an API spec artifact; a request-schema registry; idempotency keys; a list envelope; the read-side silence guard (10 PRs open, none merged) |

**Stated as one sentence: `10` and `11` describe machinery that is built and running; `07` and `08`
describe machinery that is built and switched off; `09` describes machinery that does not exist.**

Three numbers carry the weight:

- **Portava moves no money.** No `package.json` in the tree depends on a payment processor; the two
  charge routes return 503 with no side effects (`routes/rentABuddy.ts:1686-1692`) and refund
  eligibility returns 501 (`routes/rentABuddy.ts:3198-3203`). `09` §11.
- **Of the seven revenue lines in `08` §1, exactly one — marketplace commission — has an end-to-end
  code path, and that path stops before money.** The other six are unbuilt, refused, or handed off
  platform.
- **Everything in `09` sections 3–10 is design: no migration, no table, no route, no flag** (`09`
  §11). There is no `wallet` table anywhere in the tree, and `rent_buddy_payouts` has no INSERT
  anywhere in the repository (verified: `routes/rentABuddySpec.ts:2170`, `:2208` are the only two
  references outside dispositions and hashes, and both are UPDATEs).

**The distinguishing fact is never the row count.** An empty `creator_activity_scores`, an empty
`rent_buddy_payouts` and an empty `feature_flags` row all look identical from outside to a working
system. What separates them is the flag, the writer and the ledger — which is why §5 is not
paperwork.

---

## 1. What may NOT be started, and the line that gates it

**Read this section before §4.** Every row here is a standing owner ruling. None of them is
this document's to move, and `08` §6.1 states the reason a revenue document in particular must not
try: *a revenue document is exactly the pressure that ratchets are built to resist.*

| # | Item, as named in `07`–`11` | Gated by | The line |
|---|---|---|---|
| **B1** | Traveler Impact as a **measured** construct — any outcome-weighted Impact, any generalisation of the `intel_*` attribution lane | **Event Truth, step 2, NOT STARTED — gated. Packet written; no migrations, no tables** | `ROADMAP.md:944`; `ROADMAP.md:1001` ("Step 2 is GATED"); `07` §7 |
| **B2** | Discovery→purchase payment attribution | Same gate. `09` §6 is deliberately designed **not** to depend on it | `ROADMAP.md:944`; `09` §6 closing note |
| **B3** | Enabling `ACTIVITY_DISCOVERY_BOOST_ENABLED` | **Ranker on explicit owner HOLD** | `ROADMAP.md:222`, `:648`; `07` §7 |
| **B4** | Enabling `discovery_ranking_modifiers_enabled` | Ranker HOLD, with a migration postcondition that RAISEs if the flag is ever seeded on (`migrations/2289_discovery_ranking_modifiers_flag.sql:71-74`) | `ROADMAP.md:648` |
| **B5** | Flipping `DISCOVERY_ENGINE_MODE` to `pde` | **Phase F gate 2 — FROZEN + NOT AGENT WORK**, and unruled | `ROADMAP.md:534`, `:646` |
| **B6** | Enabling shadow for any cohort | **Phase F gate 1** — same freeze, also unruled | `ROADMAP.md:534`, `:647` |
| **B7** | Phase E measurement work, including the deferred D5 empirical check | **FROZEN** — and the instrument it reads was corrected twice, so no pre-`4cc19af82` reading is comparable | `ROADMAP.md:533` |
| **B8** | Step 9, learned residual | **NOT STARTED — and must stay that way.** Entry condition is trustworthy outcomes; step 2 is unbuilt | `ROADMAP.md:951`; `07` §7 |
| **B9** | Tier 3 place intelligence (experiential / opinionated, people-like-you, social proof) | **The gate is users, and it does not open by completing the tier below it** | `ROADMAP.md:263` |
| **B10** | Trails or Trending as **peer scoring systems** | **STALE — must be re-scoped before implementation** | `ROADMAP.md:148`; `02`, `03` |
| **B11** | Any revenue signal as a ranking input | **Refused permanently**, not merely blocked — four independent enforcements in code | `08` §6.1; `09` §10 and §"Standing rulings", point 1 |

**Two consequences that are easy to miss.**

**First, a block propagates.** `07`'s D2 — the rule that Impact means *a traveller did something in
the real world because of this contribution* — is blocked by B1, and therefore so is every
user-facing string that would call the number an impact measurement. `07` §1.3 states the fallback:
until Event Truth exists, what can honestly be measured is **contribution and care**. That is not a
smaller version of the blocked work; it is a different claim, and building it does not advance B1.

**Second, "no new prerequisite work" is itself a ruling.** The 2026-08-15 owner statement
(`ROADMAP.md:162-165`) is verbatim: *"Discovery measurement work may close its existing proof
obligation, but it NO LONGER GETS TO GENERATE NEW PREREQUISITE WORK BY DEFAULT."* The sequence in §4
is written to obey it — the only items placed **before** repair work are verifications that can be
discharged with a read query, not chains of new construction. `09` §"Standing rulings" point 2
records the same discipline for payments.

---

## 2. Defect repair versus new capability — the distinction that orders everything

The register in §3 and the sequence in §4 both turn on one test, so it is stated once:

> **An item is DEFECT REPAIR if, after the change, the system does what its own code, comment,
> schema or shipped user-facing string already claims it does. It is NEW CAPABILITY if the system
> would do something it has never claimed to do.**

Worked examples, because the boundary is narrower than it looks:

| Item | Which | Why |
|---|---|---|
| Make the three take-rate constants agree | **repair** | `lib/rentBuddyEarningsLedger.ts:60-66` already treats `rent_buddy_fee_rules` as the schedule; the two literals are drift from it |
| Charge a traveller a service fee | **capability** | Revenue line 2 has never existed; `08` §2.4 shows the `_pct` column has no reader anywhere |
| Make the payout hold/release routes compare-and-swap | **repair** | Both routes exist and are reachable; asserting a target state unconditionally is a bug in a shipped route |
| Insert a `rent_buddy_payouts` row | **capability** | Nothing has ever created one, and `09` §9.1 says the lifecycle has no entry point until a funding source exists |
| Stop `in_app_amount_collected` recording money that was never collected | **repair** | The module header already says *"THIS IS NOT PAYMENT … The row is an ESTIMATE"* (`lib/rentBuddyEarningsLedger.ts:24-28`), and the field contradicts it |
| Build the double-entry ledger | **capability** | `09` §5 is design; nothing in the tree is double-entry except by analogy |
| Convert an error-discarding read to fail-closed | **repair** | `11`'s stated rule — *a failed read must never be reported as empty, clean, or done* — is the contract the codebase is converging on, with two correct helpers already shipped (`lib/blockGuard.ts:25-40`, `lib/blocks.ts:21-40`) |
| Promote a buddy up the level ladder automatically | **capability** | `08` §2.5: *"Promotion is an unbuilt product decision, not an oversight to patch inside a fee change."* |

**Repair is safe to start now.** It needs no ruling, changes no product surface, and — this is the
operative point — **it must precede the capability that would sit on top of it**, because a new
payment path built over a ledger that books uncollected money inherits the wrong number rather than
replacing it.

**Capability needs a ruling first.** §4 Stage 2 lists the specific decisions, each with the document
that says it is an owner call rather than an engineering one.

**A third category exists and is neither: verification.** Six of the most consequential facts in
`08`–`10` are *not in-tree facts at all* — whether a seed row, a flag row or a staged migration is
present in production. Per `.agents/memory/migration-applied-vs-committed.md`, a migration file is
not evidence of an apply **in either direction**. These sit in Stage 0 because they can invalidate
Stage 1 work that is otherwise correct.

---

## 3. The defect register

Every row was re-verified at this commit. **Severity is about what is wrong now, not about effort.**

- **S1** — a wrong number or a wrong authorization decision can reach a user or an operator today,
  **or** a security boundary's production status is unproven.
- **S2** — the system returns a confident answer that is unfounded, **or** the defect becomes S1 on
  the day a flag flips or a row first exists.
- **S3** — the record is incomplete or stale; nothing wrong reaches anyone today.

**R/C** = repair (safe now) or capability (needs a ruling first, per §2).

### 3.1 Money — `08` and `09`

| # | Defect | Sev | R/C | Citation |
|---|---|---|---|---|
| **M1** | **Three disagreeing take rates.** `rent_buddy_fee_rules` seeds 25/22/15/12/12 per level (`artifacts/api-server/migrations/0048_rent_buddy_marketplace.sql:418-424`); the ledger falls back to `DEFAULT_PLATFORM_FEE_PERCENT = 22` (`lib/rentBuddyEarningsLedger.ts:37`); the buddy dashboard falls back to `defaultFeePercent = 22` (`routes/rentABuddyMarketplace.ts:2192`); the earnings summary hard-codes `platformFeePct = 0.15` **for every buddy at every level** (`routes/rentABuddy.ts:6237`). A `new` buddy is quoted 15 %, ledgered at 25 %, dashboarded at 22 %. Nothing reconciles them and nothing fails when they diverge. | **S1** | R | verified above; `08` §2.3, `09` §1.3.3 |
| **M2** | **`rent_buddy_payouts` has no INSERT anywhere in the repository.** The only two references in `src/` are UPDATEs — hold (`routes/rentABuddySpec.ts:2170`) and release (`:2208`). The table can only ever be empty; two admin routes operate on rows no code creates. | **S2** | C | `09` §1.4 |
| **M3** | **Payout transitions are unguarded.** Both are a bare `.update({ status: … }).eq("id", payoutId)` with no predicate on the current status, so releasing an already-released or held-under-investigation payout succeeds silently. | **S2** | R | `routes/rentABuddySpec.ts:2169-2178`, `:2207-2215` |
| **M4** | **The traveller service fee is structurally always zero.** The ledger reads `traveler_service_fee_usd` (`lib/rentBuddyEarningsLedger.ts:67`); both seeds populate only `traveler_service_fee_pct`; **no code anywhere reads `_pct`** — the only non-type references are the admin write (`routes/rentABuddyMarketplace.ts:2579`) and the admin screen (`travel-buddy-standalone/app/(rent-a-buddy)/admin/fee-rules.tsx:54`). The 5 % in the seed is a number nothing can act on. | **S2** | R (mismatch) / C (charging) | `08` §2.4 |
| **M5** | **The ledger records money as collected that was never collected.** `in_app_amount_collected: Number(booking.deposit_usd ?? 0)` (`lib/rentBuddyEarningsLedger.ts:87`), and for `payment_mode = 'full_in_app'` `deposit_usd` **is** the whole total (`routes/rentABuddy.ts:1579`). So a full-in-app booking books its entire value as in-app collected at the moment of booking, while `pay-full` returns 503. | **S1** | R | `09` §1.3.1 |
| **M6** | **The ledger never settles.** `is_estimated: true` and `cash_balance_confirmed: false` are written at creation (`lib/rentBuddyEarningsLedger.ts:89-90`) and `createEarningsLedgerEntry` is the only writer in the tree; the flag the read path branches on (`routes/rentABuddyMarketplace.ts:2266`) can therefore never be false. | **S2** | R | `09` §1.3.2 |
| **M7** | **Earnings aggregates are summed in JavaScript over an unpaginated select.** `routes/rentABuddy.ts:6229-6268` and `routes/rentABuddyMarketplace.ts:2149-2196` pull booking rows and sum them with no pagination; PostgREST's default row cap silently truncates the sum for any buddy past it. | **S1** | R | `09` §1.3.4 |
| **M8** | **A second tip overwrites the first.** The tip path performs three unrelated writes with no transaction — an upsert into `rent_buddy_tips` keyed on `booking_id` that **replaces** rather than accumulates, plus two explicitly best-effort UPDATEs. | **S1** | R | `routes/rentABuddyMarketplace.ts:1891-1912`; `09` §1.3 |
| **M9** | **`payment_status` is a seven-value enum with no reader and no writer.** Verified by grep over `src/`: zero non-generated references. Every booking carries the column default `not_required` forever — a modelled payment state machine with no transitions. | **S3** | C | `09` §1.2 |
| **M10** | **The fee schedule's seed is unproven in production.** `rent_buddy_fee_rules` appears in **no file in the canonical chain** — its DDL and seed exist only in the frozen legacy root (`src/scripts/frozenMigrationRoots.ts:73-75`). The table is in the 2026-08-19 baseline, but that dump is schema-only. If the five rows are absent, every booking settles at the 22 % fallback and nothing reports it: the `.agents/memory/unseeded-feature-flag-gates.md` failure shape applied to pricing. | **S1** | R (verify first) | `08` §2.6 |
| **M11** | **The level ladder is partly unreachable.** The admin route validates against `['standard','pro','elite']` (`routes/rentABuddy.ts:4605`); `'standard'` has **no row in the fee table**, so setting it moves the buddy silently to the 22 % fallback, and `'rising'` has a fee row and **no writer at all**. No automatic progression exists anywhere. | **S2** | R (the `'standard'` hole) / C (progression) | `08` §2.5 |
| **M12** | **Two booking paths, two deposit policies.** The canonical route hard-codes `totalUsd * 0.3` (`routes/rentABuddy.ts:1579-1580`); the marketplace paths call `calculateDeposit` with risk rules (`routes/rentABuddyMarketplace.ts:1610`, `:1828`). `rent_buddy_launch_controls.min_deposit_pct` is **write-only** — an admin can set it (`routes/rentABuddy.ts:5428`) and nothing reads it. | **S2** | R | `08` §3.2 |
| **M13** | **Cash confirmation races and is inflatable.** The confirm-cash route reads the booking and writes it in a separate statement (`routes/rentABuddy.ts:2584-2605`), so two simultaneous confirmations race; `docs/rent-buddy-audit.md:397` names the other half — *"A buddy could confirm an inflated cash amount."* | **S2** | R | `09` §9.2 |
| **M14** | **The live money tables carry table-level `GRANT ALL … TO anon, authenticated`.** `baseline:37347-37349` (`rent_buddy_earnings_ledger`) and `:37464-37466` (`rent_buddy_payouts`), verified in the dump. They are protected **only** by RLS policies — which is exactly the posture `10` §8 exists to prevent, and the reason the canonical pattern revokes before it grants. | **S1** | R | `09` §10; `10` §8 |

### 3.2 API contract — `11`

| # | Defect | Sev | R/C | Citation |
|---|---|---|---|---|
| **A1** | **`requireUser` fails open on the ban gate.** The `account_status` read discards `error` and defaults to `"active"`, by documented choice; banning writes `profiles.account_status` and nothing else — **there is no session revocation anywhere**, so this is the only ban enforcement point there is. | **S1** | R | `lib/http.ts:213-222` (verified: comment reads *"Fail-open: if the profile query errors we still allow the request through"*) |
| **A2** | **Two error-envelope shapes.** Every route returns flat `{ error: <code>, message }` (`lib/http.ts:140-152`); the global handler returns nested `{ error: { code, message } }` (`app.ts:242-247`). A client reading `body.error` as a code gets an **object** for any unhandled throw. An unreconciled inconsistency, not a documented tier. | **S2** | R | verified both sites |
| **A3** | **146 single-line `const { data } = await` reads in `src/routes/` discard the error** (against 374 that bind it). supabase-js **resolves** on a rejected PostgREST query, so the read never enters the `try/catch` written for it, logs nothing, and hands the caller an empty list indistinguishable from a genuinely empty one. | **S1** | R | `11` §"The defect class" (census taken there) |
| **A4** | **Three shared helpers turn a failed read into a confident answer.** `requireTripMember` returns `null` on error (`lib/http.ts:263`); `tripExists` returns `false` on error (`:315`) → a 404 for a trip that exists; `canEditPlan` does not bind `error` at all (`:342-348`) → an unreadable `trips` row reads as "trip not found". Every route inherits them. | **S2** | R | `11` §"Authorization guards fail closed" |
| **A5** | **Cross-router mount order is enforced by comments only.** `routes/index.ts:221-231` and `:268-276` record the required orderings (stamp routers before `stampsRouter`; media world/actions before `mediaFeedRouter`); nothing tests it, and PR #468's checker is per-file by design. | **S2** | R | `11` Rule 2 |
| **A6** | **Rule 1's guard runs in a job that can be skipped.** `check:api-prefix` runs only at `.github/workflows/unwired-checks.yml:247-250` — the probation workflow — and its verdict job is **not yet a required status check**. Verified: the script is not in `run-all-checks.sh` and not in `check:all`. | **S2** | R | `11` Rule 1 |
| **A7** | **Rate limiting fails open to per-process buckets.** Redis-backed when `REDIS_URL` is set, in-memory otherwise, and the module says so — *"fail-open: stay on the in-memory backend"* (`lib/rateLimit.ts:90`, `:124`). With N instances a client gets N× the budget. | **S2** | R | `11` §"Auth and authorization posture" |

### 3.3 Creator economy — `07`

| # | Defect | Sev | R/C | Citation |
|---|---|---|---|---|
| **C1** | **`featured_count` is maintained by a read-modify-write increment** — select, then `update({ featured_count: current + 1 })` (`routes/adminFeatured.ts:333-342`, and the same shape at `:444-449`, `:561-565`). `.agents/memory/counter-update-atomicity.md` records this pattern as **rejected in completion review**; the required form is a SECURITY DEFINER RPC with `GREATEST(0, col + delta)`. | **S2** | R | `07` D6 |
| **C2** | **Row-absent and score-zero are different, and two writers disagree.** `DiscoveryRankingService` defaults a missing creator row to `{ score: 0 }` (`services/ranking/DiscoveryRankingService.ts:898-900`) while the scheduler deliberately writes a floor-10 row for every profile **because the two produce different downstream boosts** — stated in the scheduler's own comment (`lib/creatorActivityScoreScheduler.ts:176-186`). Any future consumer must branch on row present/absent, never on `score === 0`. | **S2** | R | `07` D3 |
| **C3** | **The safety multiplier turns an unreadable trust input into a confident value.** `catch { return 1.0; // fail-open: don't penalise on DB error }` (`services/ranking/CreatorActivityScoreService.ts:1140-1141`) — the last place in the trust-consuming code that still does this, and directly against the contract PR #458 is establishing. | **S2** | R | `07` §5, #458 reconciliation |
| **C4** | **The new-user floor is a free per-account grant.** `NEW_USER_BASE_SCORE = 10` applies per account and the scheduler seeds **every profile**, not only contributors (`lib/creatorActivityScoreScheduler.ts:36-39`). N sockpuppets earn N floors. Costs nothing while the boost is OFF; **becomes a Sybil surface on the day the flag is flipped** — which is B3, and not this document's to propose. | **S2** | R (a prerequisite to B3, not B3) | `07` §4, D8 |
| **C5** | **Received engagement is an unnormalised count, so large accounts are no longer normalised down** — the rewrite states it in the function's own comment (`services/ranking/CreatorActivityScoreService.ts:304-312`). That is a popularity coupling in a score `07` §2 exists to keep free of one. Tolerable only while the boost is OFF. | **S2** | R (a prerequisite to B3) | `07` §2 point 3 |

### 3.4 Database, migrations and CI — `10`

| # | Defect | Sev | R/C | Citation |
|---|---|---|---|---|
| **B‑1** | **`2160_portava_featured_write_boundary.sql` is marked "STAGED. Apply to portava-ci ONLY. DO NOT APPLY TO PRODUCTION without owner approval"** (`src/migrations/2160_portava_featured_write_boundary.sql:3`). It is the migration that revokes anon/authenticated INSERT/UPDATE on `portava_featured`. **The boundary's production status is therefore an open item, not a settled fact** — and `08` §6.1 names it the single most important thing to verify before any "featured" surface is called safe. | **S1** | verify | `08` §6.1; `10` §12 |
| **B‑2** | **The environments disagree about where the authorization helpers live.** `2182` moved `is_blocked`, `in_accepted_circle` and `can_see_location` into schema `authz`; its own status block records **APPLIED TO CI 2026-08-28 … PROD PRESS PENDING OWNER** (`src/migrations/2182_close_authz_rpc_oracle.sql:8-14`). A migration that writes `public.is_blocked(...)` in a `USING` clause **fails at apply time** against a database where 2182 landed; a hard-coded `authz.` fails against one where it did not. | **S2** | R | `10` §7 |
| **B‑3** | **The inverse schema audit runs in no workflow.** `audit:live-unexplained` is built (`package.json:15`) and its only caller is `.github/scripts/clean-build-proof.sh:172-174`, whose header names `clean-build-proof.yml` — **and that file does not exist**; `.github/workflows/` holds `ci.yml`, `live-db.yml` and `unwired-checks.yml` and nothing else (verified). So live objects no migration declares are found only by accident. | **S2** | R | `10` §12 |
| **B‑4** | **`src/lib/database.types.ts` is stale and is regenerated by nothing.** It drifts in **both** directions — naming columns live does not have (code compiles, every insert fails PGRST204) and omitting columns live does have. | **S2** | R | `10` §12; `.agents/memory/db-column-drift.md` |
| **B‑5** | **The baseline has not been recaptured since 2026-08-19.** Everything the post-cutover band built since is invisible to it — which is why `deletionDispositions.ts` cannot yet list tables the deletion service already clears. **A recapture is a prerequisite for several open items, not a chore.** | **S3** | R | `10` §12 |
| **B‑6** | **Every money table and `creator_activity_scores` sit in `UNCLASSIFIED_BACKLOG`** — `creator_activity_scores` at `lib/deletionDispositions.ts:324`, and `rent_buddy_bookings` `:406`, `rent_buddy_earnings_ledger` `:408`, `rent_buddy_payouts` `:415`, `rent_buddy_tips` `:423`. That file is explicit that the backlog is **not a decision**: the data survives account deletion and nobody has said whether it should. | **S3** | C (an owner ruling) | `07` §6; `09` §10 |

### 3.5 Count by severity

| | S1 | S2 | S3 | Total |
|---|---|---|---|---|
| Money (`08`, `09`) | 6 | 7 | 1 | **14** |
| API (`11`) | 2 | 5 | 0 | **7** |
| Creator economy (`07`) | 0 | 5 | 0 | **5** |
| Database / CI (`10`) | 1 | 3 | 2 | **6** |
| **Total** | **9** | **20** | **3** | **32** |

**Of the 32, 26 are repair and 6 are capability or an owner ruling** (M2, M9, part of M4, part of
M11, B‑6, and the progression half of M11). Repair outnumbers capability roughly four to one, which
is the single most important input to §4: **there is a great deal of correct work available that
needs no ruling at all.**

---

## 4. The build sequence

Read top to bottom. A stage may not start before the stage above it has closed **for the items it
depends on** — not for the whole stage; the dependencies are named per item.

### Stage 0 — Verification. No code. Blocks Stage 1's money items.

Six facts that `08`–`10` explicitly refuse to assert from files, because
`.agents/memory/migration-applied-vs-committed.md` says a migration file is not evidence of an
apply **in either direction**. Each is one read query.

| | Verify | Why it blocks | Source |
|---|---|---|---|
| **V1** | The live `feature_flags` rows for `rent_buddy_enabled`, `intel_rewards`, `ACTIVITY_DISCOVERY_BOOST_ENABLED`, `discovery_ranking_modifiers_enabled`, `DISCOVERY_ENGINE_MODE` | The canonical default of each is OFF, but the live value is not an in-tree fact. `08` §1.1 warns specifically against restating "Rent a Buddy is live" from `docs/rent-buddy-product.md`'s July header | `08` §1.1 |
| **V2** | Whether `rent_buddy_fee_rules` holds its five seed rows in production | **Blocks M1 and M11 entirely.** Reconciling three take rates onto a schedule that is not there produces a fourth wrong answer | `08` §2.6 |
| **V3** | Whether `2160` has been pressed to production | **Blocks any claim that the `portava_featured` write boundary holds** (B‑1) | `2160:3` |
| **V4** | Whether `2182` has been pressed to production | Determines how every **new** RLS policy must name its predicates; getting it wrong breaks DDL at apply time | `2182:8-14`; `10` §7 |
| **V5** | Re-read the `schema_migration_ledger` with `isProofOfApply()`, not by row presence | `2254` seeded a row for **every one of the 382 filenames on disk when it ran**, carrying `applied_by='backfill'` and the literal string `'backfill'` where a hash belongs. **Presence of a row is not the test** | `10` §4.1 |
| **V6** | Recapture the baseline | B‑5; a prerequisite for the deletion-disposition and grant work below | `10` §12 |

**None of these generates new prerequisite work** in the sense the 2026-08-15 ruling forbids: each
is a read against a system that already exists, and each *removes* a possible wrong answer rather
than adding a construction step.

### Stage 1 — Defect repair. Safe to start now; no ruling required.

Ordered by dependency, not by severity. **1A must precede 1B**, because 1B's money work lands in
routes whose error handling 1A fixes; **1C must precede nothing but should not lag**, because it is
what stops 1A and 1B from silently regressing.

**1A — Close the API contract. (`11`; A1–A4)**

1. **Land the in-flight campaign, do not fork it.** Eleven PRs — #458, #459, #460, #462, #465,
   #466, #469, #471, #473, #474, #468 — are **all open at this commit** and all touch the same
   surface. `11` §"The in-flight campaign" lists what each establishes. **Opening a twelfth parallel
   PR into `lib/http.ts` is the fastest way to lose the campaign**; the sequencing rule is land what
   exists, then take the residue.
2. **A1 — the ban gate.** `lib/http.ts:213-222`. This is the highest-value single repair in the
   register: it is the only ban enforcement point in the system and there is no session revocation.
   The fix is a three-state read (present / absent / unreadable), matching #458's
   `getTrustProfileResult` shape and #466's three-state passport visibility, not a fourth invention.
3. **A2 — one envelope.** `app.ts:242-247` must emit the flat shape `lib/http.ts:140-152` writes,
   or the nested shape must be documented as a tier. It cannot stay undecided; `11` calls it
   *"an unreconciled inconsistency, not a documented tier."*
4. **A4 — `requireTripMember`, `tripExists`, `canEditPlan`.** Same three-state treatment.
5. **A3 — the 146-site class.** Only after #473's scanner and its 301-site shrink-only baseline
   land, so the work is measured rather than estimated.

**1B — Repair the money record. (`08`, `09`; M1, M3, M5–M8, M10–M13)**

Nothing here moves money, adds a table, or requires a processor. All of it makes the existing
record say what its own code already claims.

6. **M1 + M10 — one take rate, read from one place.** Requires **V2**. `08` §2.3 states the
   resolution direction and it is not a judgement call: `rent_buddy_fee_rules` is the schedule of
   record *because it is the only one an operator can change without a deploy*; the two literals are
   drift, and `routes/rentABuddy.ts:6237` in particular is not a default — it ignores the buddy's
   level entirely. Delete the second reader, not the first.
7. **M5 — stop booking uncollected money.** `in_app_amount_collected` must be 0 until a payment
   path exists; `09` §1.3.1 is the reasoning, and the field currently contradicts the module's own
   header two dozen lines above it.
8. **M8 — accumulate tips instead of replacing them.** A destroyed money record is not recoverable
   later; this one is ordered ahead of the rest of 1B for that reason alone.
9. **M7 — aggregate DB-side or paginate.** A silently truncated earnings total is a wrong number
   shown to a buddy today.
10. **M3 — compare-and-swap on both payout transitions.** `UPDATE … WHERE id = :id AND status =
    :expected`, zero rows → 409. Cheap now; mandatory before M2 ever exists.
11. **M11 (the `'standard'` hole) — reject a level with no fee row**, rather than silently
    dropping to the 22 % fallback. The promotion half is Stage 2.
12. **M12 — one deposit policy.** Either `min_deposit_pct` gets a reader or the literal `0.3` gets
    a comment saying it is the policy; two policies and a write-only control is the worst of the
    three states.
13. **M13 — atomic cash confirmation.** Same RPC shape as C1.
14. **M6 — either a settlement writer or an honest name.** If `is_estimated` can never be false,
    the read path's branch on it is dead code claiming a capability.
15. **M4 (the mismatch half) — make `_pct` and `_usd` agree**, so that a value an admin sets is the
    value the ledger reads. Charging travellers remains Stage 4.
16. **M14 — revoke the table-level grants on the existing money tables.** The canonical pattern is
    `2217_protected_locations.sql:156-161`, and the fifth line is the one people omit: **revoke from
    `service_role` too, unconditionally, before granting**, because Supabase's `public` schema
    carries `ALTER DEFAULT PRIVILEGES` granting ALL at `CREATE TABLE` time. `2092`→`2093` is the
    worked failure.

**1C — Repair the standings, and wire the guards that keep 1A/1B from regressing.**

17. **C1 — `featured_count` via a SECURITY DEFINER RPC** with `GREATEST(0, col + delta)`, a column
    allowlist, `REVOKE ALL … FROM PUBLIC` then `GRANT EXECUTE … TO service_role` — the
    `rb_adjust_buddy_counter` shape (`src/migrations/2305_rent_buddy_signal_writers.sql:57-75`).
    Plus a concurrency test; completion review rejects the pattern without one.
18. **C3 — the safety multiplier's `catch → 1.0`.** Under #458's rule the honest posture is to
    **skip the creator this pass**, not to score them at full multiplier. `07` §5 flags it as a
    contract gap and deliberately does not change it; this is where it gets changed.
19. **C2 — make row-absent and score-zero distinguishable at the consumer.** Inert today; a trap
    the moment anything reads the table.
20. **A6 — move `check:api-prefix` out of the probation workflow** into `run-all-checks.sh`, or make
    `unwired · verdict` a required status check. A rule enforced by a skippable job is a rule with a
    schedule.
21. **A5 / #468 — land the route-shadowing checker**, which ships with **no baseline** because
    there is currently nothing to grandfather. That property expires; land it while it holds.
22. **B‑3 — give `audit:live-unexplained` a workflow that exists.**
23. **B‑2, B‑4, B‑5, V6 — resolve the schema-truth gaps**: pin the `authz`/`public` resolution at
    runtime rather than in a literal (the `verify-search-path-hazard.mjs` pattern), regenerate
    `database.types.ts` from live, recapture the baseline.

### Stage 2 — Rulings. No code. Blocks Stage 3.

Each of these is named by `07`–`09` as an owner decision, not an engineering one. They are listed
here so Stage 3 does not start by assuming an answer.

| | Decision | Named as an owner call by |
|---|---|---|
| **R1** | Does the traveller-side service fee exist as a revenue line at all? | `08` §2.4, §7 |
| **R2** | Is buddy-level progression manual forever, or is there an automatic ladder? *"Promotion is an unbuilt product decision, not an oversight to patch inside a fee change."* | `08` §2.5 |
| **R3** | **Retention versus erasure for financial records.** The non-cash ledger resolved it easily (no tax obligation → erase); real money cannot take that route. `09` §10's position is `RETAINED_WITH_REASON` with personal columns pseudonymised — **but it says explicitly that this is an owner decision it may not make**, recorded so it cannot be inherited as silence. Also closes B‑6. | `09` §10 |
| **R4** | **Which payment processor**, with its KYC, tax and fraud consequences. `2170:12-15` states the shape of the boundary. Nothing in Stage 3 can be built against an unnamed processor without inventing a webhook contract. | `09` §11 |
| **R5** | Whether event ticketing becomes a Portava-side transaction. `08` §3.5 calls it the largest unexercised revenue option — capacity, RSVP funnel and attendance all exist; only the money does not — and a payments decision plus a policy decision, **not a discovery one**. | `08` §3.5 |
| **R6** | Whether a consumer subscription tier exists. If yes, `08` §4.4 rule 2 binds: **entitlement must not be built on the flag table**, because a flag is a global boolean that cannot express "this user's plan lapsed on Tuesday." | `08` §4 |

### Stage 3 — The payment foundation. New capability; requires R3 + R4 and Stage 1B.

This is `09` §§4–10 in dependency order. **Every step is a migration plus a writer; none of it is a
refactor of anything that exists.**

24. **`payment_accounts`, `payment_transactions`, `payment_ledger_entries`**, with invariants I1–I7
    installed as constraints and triggers **in the same migration as the tables**, not after
    (`09` §5.3). I3 is a deliberate omission and must stay one: **no `FOR EACH STATEMENT`
    append-only trigger** — it has been retracted twice for the same reason (`10` §9;
    `2137`, `2292`), because a statement-level trigger refuses an erasure cascade whether or not
    there is anything to protect, and makes users undeletable.
25. **RLS and grants on each of those tables, revoke-first** (`09` §10; `10` §8) — in the same
    migration. M14 taught this on the tables that already exist; do not relearn it on new ones.
26. **The balance projection** as a single statement or a SECURITY DEFINER function
    (`09` §4). Never a read-modify-write from the API process.
27. **Idempotency** (`09` §7): a `UNIQUE (scope, idempotency_key)` **index**, a key derived from the
    *event* and not the attempt, and a `23505` treated as a **replay** that reads back and returns
    the original. And the recorded trap: **do not attempt PostgREST `on_conflict` inference against
    a partial index** (`2180:17-19`). This must exist before the first writer, not after it.
28. **Attribution** (`09` §6): frozen on the transaction at write time, with `attribution_version`,
    never reconstructed later by a join against mutable rows. **It resolves creators through the
    causing entity** (booking → buddy profile → `user_id`), *not* through ranking metadata —
    `creatorId` population is HELD, and a payment design that depended on it would be blocked on a
    decision that is not a payments decision.
29. **Currency and FX** (`09` §8): minor units as `bigint` + `currency char(3)` as a pair; a
    **settlement** rate stored on the transaction, never `fx_rates`' ECB **reference** rate; a
    missing rate is a **refusal to book**, not a guess; the rounding residual is booked to a named
    account rather than dropped.
30. **The payout lifecycle** (`09` §9.1) — states, compare-and-swap on every transition (already
    done for the two existing routes by M3), and the first real INSERT path, closing **M2**. Gated
    on the same KYC gate as bookings (`lib/rentBuddyKycGate.ts:57`), **not a second
    independently-defaulting switch** — that reproduces the defect `2210` had to correct.
31. **Refunds, chargebacks, reversals** (`09` §9.2) — three distinct things; a reversal is always a
    new transaction, never a DELETE, which I2 makes impossible anyway.
32. **Only then**: a processor integration, and the removal of the two 503 stubs. Removing them
    earlier re-creates precisely what the comment above them prevents — *"so no booking is ever
    marked 'paid' and no false milestone notification is sent to the traveler."*

### Stage 4 — Revenue lines. Requires Stage 3 and the matching Stage 2 ruling.

33. **The traveller service fee** (R1 + M4) — `08` §2.4.
34. **Event ticketing** (R5) — `08` §3.5. Note the current refusal is enforced in four places:
    `priceType` is `z.enum(["free","external"])` on create and update, `priceUrl` must resolve to
    one of eight allowlisted third-party hosts, and `priceUrl` is returned only to the host and
    participants. Turning it on means editing all of them deliberately.
35. **Subscriptions and entitlements** (R6) — a **new store**, per `08` §4.4 rule 2, with a
    migration postcondition that RAISEs if the row is absent (the `2300:145-165` / `2289:70-74`
    pattern), because *a tier gate that is never seeded silently disables the paid feature for every
    paying customer* and the subscriber is charged anyway.
36. **Multi-currency commercial records** — `08` §5; adopt `lib/fx.ts`'s honesty contract, not its
    rates.

### Stage 5 — BLOCKED. May not be started.

Everything in §1's table B1–B11, restated once as a sequence position so it is not read as "later":

- **B1, B2, B8** wait on **Event Truth**, which is step 2, **NOT STARTED — gated**, with the
  packet written and **no migrations and no tables** (`ROADMAP.md:944`).
- **B3, B4** wait on the **ranker HOLD** (`ROADMAP.md:222`, `:648`). C4 and C5 are named in `07` §4
  as *prerequisites* to B3 — repairing them does not open the gate and must not be described as
  progress toward it. `07` D8 is explicit: **enabling the boost is a Sybil decision, not a flag
  flip.**
- **B5, B6, B7** are **Phase F / Phase E — FROZEN + NOT AGENT WORK** (`ROADMAP.md:533`, `:534`).
- **B9** waits on **users**, and *"the gate is users, and it does not open by completing the tier
  below it"* (`ROADMAP.md:263`).
- **B10** must be **re-scoped before implementation** (`ROADMAP.md:148`).
- **B11 is not blocked; it is refused.** No revenue signal may become a ranking input, ever.

---

## 5. Rollout posture

### 5.1 Flags ship OFF, and an unseeded flag reads as FALSE

**Both halves matter and they fail differently.**

- **Ship OFF.** Every gate in this area is seeded false and several carry a postcondition that
  *fails the migration* if the seed is ever on — `2289:71-74` RAISEs with the message *"the ranker
  is on hold and this must ship OFF"*. `rent_buddy_enabled` uses
  `ON CONFLICT (flag) DO UPDATE SET enabled = false` (`2210:29-31`) specifically to supersede an
  earlier migration that forced it TRUE on every restore. Copy that shape; `DO NOTHING` would have
  left the old value standing.
- **Unseeded reads as FALSE, silently.** Per `.agents/memory/unseeded-feature-flag-gates.md`, a flag
  key referenced in code — **even mocked `true` in green tests** — but never inserted into the live
  `feature_flags` table is permanently `false`, with **no error and no log**, and is
  indistinguishable from "feature not built yet." Both readers behave this way by design:
  `lib/featureFlags.ts:14-26` (server) and
  `travel-buddy-standalone/src/context/FeatureFlagsContext.tsx` (client). `2300` is the recorded
  case — five phantom rows — and its verdict is the sentence to remember: **"a seed in a directory
  nothing runs is not a seed."**

**Three rules follow for anything in §4.**

1. **Every new flag is classified in `scripts/check-flag-polarity.mjs` in the same PR that
   introduces it.** The check reconciles **in both directions** — every seeded flag has a reader or
   a written reason, and every flag the code reads has a row or a written reason. Its own header
   records why the second direction exists: R9 was missing for 24 days, eight phantom flags were
   live behind the gap, and the two halves of one defect sat 300 lines apart in that very file, each
   individually plausible, *"and the check went green because no rule ever compared them in that
   direction."* It runs at `artifacts/api-server/scripts/run-all-checks.sh:127`.
2. **The check does not enforce that a classification is right, or that a seeded value is the one
   anyone intended** — its own header says so. It buys that the judgement gets **made**, in writing,
   in a diff. Write the reason.
3. **A privacy or safety gate is not feature-flagged at all.** `2217:26-32` is the reference: *a
   privacy gate with an off switch is not a gate, and the natural default of a new flag (OFF) is the
   unsafe direction.* This binds M14 and Stage 3 step 25.

**And the standing prohibition: nothing in §4 proposes flipping a flag that ships OFF.** B3–B6 are
flag flips and all four are owner gates.

### 5.2 Migrations: applied out-of-band **before** the PR that adds one can go green

This is `10` §6.1, and it is the single most surprising piece of the rollout for anyone new:

> A PR adding `2310_whatever.sql` is **red on `schema-drift` from the moment it is pushed** until
> somebody applies that migration to the CI project.

The mechanism: `audit:schema` runs on **every ref** (`.github/workflows/live-db.yml:727`) and fails
when a migration file claims an object the live catalog does not have; `db:apply-migrations` runs on
**main only** (`:705`). Applying an unmerged branch's migrations to the shared CI database would
leave it ahead of main with no commit accounting for it, so the order is deliberate.
`2120_canonical_events.sql:8-13` states it in its own header as **expected behaviour, not a
finding**.

**Do not "fix" it by allowlisting the new objects.** `10` §6.1 and
`.agents/memory/db-column-drift.md` both record why: an allowlist entry written optimistically
("migration pending") becomes a permanent hole, and one already shipped a raw Postgres error to
users.

Four more properties of the applier that constrain how a Stage 3 migration may be written
(`10` §5) — it **refuses** files it cannot make atomic with their ledger row:

- an interior `COMMIT`, a second `BEGIN`, or `START TRANSACTION`;
- a top-level `ROLLBACK` / `ABORT` / `SAVEPOINT` (this is why `2182`'s verification probe is applied
  by hand);
- SQL before the opening `BEGIN`, or a non-assertion tail after the final `COMMIT`;
- `CREATE INDEX CONCURRENTLY` — Postgres cannot run it inside a transaction block, so it can never
  be atomic with its ledger row. **No file in the tree currently trips this; it is a forward rule**,
  and it is a real constraint on a payments schema that will want concurrent index builds.

And **production is out of reach from here**: the applier's target guard refuses the production ref
unconditionally, even if an operator sanctions it. CI proves a migration on `portava-ci`; the
production press is a separate, deliberate human act (`10` §12). `2182` has been in that state since
2026-08-28, and `2160` has never left it.

### 5.3 The CI gates that must pass

| Where | Gate | Notes |
|---|---|---|
| `.github/workflows/ci.yml:201` | `check:schema-references` | static; no DB, **cannot be starved** |
| `ci.yml:216` | `check:enum-literals` | the VALUE half of the same contract |
| `ci.yml:230` | `check:writerless-reads` | *can the data exist at all* — the guard written for the `activity_events` class of defect |
| `run-all-checks.sh:108` | `check:guard-coverage` | a check nothing runs is not a check |
| `run-all-checks.sh:114` | `check:route-auth-gate` | a mutating handler must authenticate through `requireUser`, because it is the only place the ban gate applies |
| `run-all-checks.sh:127` | `check:flag-polarity` | §5.1 |
| `run-all-checks.sh:128` | `check:frozen-dir` | 19 frozen roots pinned by sha256 |
| `run-all-checks.sh:129` | `check:async-handlers` | |
| `run-all-checks.sh:130` | `check:migration-prefixes` | `2059` and `2089` are permanently shared; the allowlist matches the **exact file set** |
| `run-all-checks.sh:143` | `check:silent-supabase-writes` | shrink-only against a 29-file / 39-site baseline; the read half (#473) is **not merged** |
| `run-all-checks.sh:177` | `check:rank-events-surfaces` | a gate, not a check |
| `live-db.yml:690` | `db:apply-migrations:dry-run` | **every ref including PRs** — turns "cannot be applied atomically" into a red on the PR that introduces it |
| `live-db.yml:705` | `db:apply-migrations` | main only |
| `live-db.yml:716` | `certify:migrations` | main only; re-runs each migration's **own postcondition `DO` blocks after the commit** |
| `live-db.yml:727` | `audit:schema` | every ref — §5.2 |
| `live-db.yml:755` | `audit:shadow-append-only` | asserts the **exact** grant set, not a claimed subset |
| `unwired-checks.yml:247` | `check:api-prefix` | **probation workflow; its verdict is not yet a required status check** — A6 |

**Two things the gates do not do, stated because assuming otherwise has already cost time here:**

- **`audit:schema` models grants as a presence check.** It asks "is each grant a migration claimed
  actually present?" It **cannot see excess privilege and does not model `REVOKE` at all**
  (`10` §8). That is why `2092`'s header could claim `service_role` held "INSERT and SELECT and
  nothing else" while the live catalog said all seven, and nothing caught it. M14 and Stage 3
  step 25 are not covered by CI; they are covered by `audit:shadow-append-only`'s exact-set
  assertion only for the tables it names.
- **A green `npm test` in `api-server` covers no database behaviour.** Per
  `.agents/memory/api-server-live-db-suites.md`, the `test` script pins `SUPABASE_URL` to a dead
  port and omits `rlsHardening`, `profileRoleNotSelfWritable` and `isOfficialPrivileged`. Run those
  three by name with real credentials before claiming an RLS change is proven.

### 5.4 What a PR in this area must carry

Derived from the checks above and from the failure shapes `07`–`11` record, not invented here:

1. **A file:line citation for every current-state claim in the description.** `11`'s own citation
   convention notes that `artifacts/api-server/scripts/check-doc-citations.mjs` covers
   `docs/discovery/`, `00_STATUS.md` and `01` only, and deliberately does not glob
   `docs/architecture/` — so architecture citations are **not** mechanically re-verified. They are
   a promise, and a stale one is worse than none.
2. **A red-proof for any new test.** `.agents/memory/prove-the-test-fails-before-trusting-it.md`;
   and `ROADMAP.md`'s first face of the governing invariant — **a check that examines nothing
   passes**.
3. **For any migration: the postcondition `DO` block**, because `certify:migrations` re-runs it
   after the commit and it is the only assertion that survives into the certification stage.
4. **For any flag: the `check-flag-polarity.mjs` classification and its written reason.**
5. **For any counter or balance: a concurrency test**, per
   `.agents/memory/counter-update-atomicity.md`.
6. **For any read that can fail: a stated three-state outcome** — present, absent, unreadable —
   never a default. This is `11`'s convergent rule and `ROADMAP.md`'s governing invariant wearing
   different clothes: **absence of evidence must never silently become evidence of absence.**

---

## 6. What is NOT built, and why — the sequencing view

`07`–`11` each carry their own "what is NOT built" section and this does not restate them. What is
absent **from the sequence itself** is worth naming:

- **There is no unit that owns Stage 3.** `09` is a design with no assignee, no ruling, and no
  processor chosen (R4). It is written to be buildable; it is not authorised to be built.
- **There is no measurement of the marketplace to sequence against.** `08` §3.4: the addressable
  market today is **three Philippine cities** — Cebu, Manila, Davao City — behind a deny-by-default
  launch-control gate. Sizing any of Stage 4 against a global TAM is not supported by the code.
- **There is no path from this repository to production.** Stage 0's V3/V4 and Stage 3's migrations
  all terminate at `portava-ci`. The production press is a human act outside the repo's reach
  (`10` §12), which means **every stage has a hand-off step that the sequence cannot execute.**
- **There is no API specification artifact to sequence a contract against.** `lib/api-spec/openapi.yaml`
  describes **three** paths out of 1382 registrations — a working pipeline at 0.2 % coverage, not a
  contract (`11` §"What is NOT built"). Stage 3's endpoints have nothing to be generated from and
  nothing to validate against but their own hand-rolled zod schemas.
- **There is no plan here for Event Truth, deliberately.** It is step 2, gated, and this document
  does not sketch it — `04` and `docs/discovery/event-truth-schema-packet.md` hold what exists, and
  sketching a build order for gated work is how a gate becomes a queue.

---

## 7. Reading order for anyone starting work from this document

1. **`docs/discovery/ROADMAP.md`** — the owner rulings, and the only place a gate may be moved.
   Ranker **HOLD** (`:222`), Event Truth **gated** (`:944`), Phase F **FROZEN + NOT AGENT WORK**
   (`:534`), Tier 3 gated on users (`:263`), peer scoring systems **STALE** (`:148`).
2. **`00_STATUS.md`** — which of `01`–`12` describe the running system, and the 2026-08-10 findings
   with their current disposition.
3. **The document that owns the surface you are touching**: `07` rewards and standings, `08` the
   commercial model, `09` money mechanics, `10` schema and migrations, `11` routing and envelopes.
4. **§3 of this file**, for whether what you are about to build sits on top of a known-wrong record.
5. **`.agents/memory/unseeded-feature-flag-gates.md`** and
   **`.agents/memory/migration-applied-vs-committed.md`** — before asserting that any gate, flag,
   seed row or migration is in force.
6. **`.agents/memory/counter-update-atomicity.md`**, **`.agents/memory/discarded-write-audits.md`**,
   **`.agents/memory/api-server-live-db-suites.md`** — the three that most often decide whether a
   change in this area passes completion review.
