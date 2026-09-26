# PR #528 schema drift: why nine migrations are pending, and what reconciling them costs

**A PROPOSAL. NOTHING IN §5 HAS BEEN EXECUTED.** Every fact below was measured
against portava-ci (`hwokxgbmezheskbzskfr`) and the git history on 2026-09-26,
not inferred from the migration files.

---

## 1. The failing check, and that it is this PR's

`audit:schema` reports **44 missing objects across 5 files** and exits 1, which
fails all three red jobs: *schema drift*, *api-server · check:all + live_pulse*
and *live DB · verdict*. They are one failure, counted three times.

It is **not** a pre-existing failure and the "not this PR's" escape does not
apply. All nine pending migrations are absent from `origin/main` and present in
this branch's diff.

CI is **not** credential-starved: the job log shows
`CI_SUPABASE_PROJECT_REF=hwokxgbmezheskbzskfr` and the guard passing. (The
inability to run these checks in a local agent container is a different fact,
true only there, and it excuses nothing here.)

---

## 2. Why these nine are on this branch

They are four other lanes' work, not sensing work. Introduced 2026-09-22/23:

| Migration | Commit | Lane |
|---|---|---|
| 2977_layover_maturity_gate_flag | `c34d058cf` | Layover L249 |
| 2981_layover_event_ingest_flag | `83ff49b0b` | Layover external events |
| 2986_layover_sessions_fanout_indexes | `b79e38db8` | Layover |
| 2990_nearby_reachable_flag | `234e942b0` | arrived via "Integrate PR 524 + PR 525" |
| 2992_layover_decision_record_and_operational_tables | `6066a765a` | Layover |
| 2993_highlight_command_boundary | `74890f906` | Highlights §17 |
| 2994_memory_relations_and_outbox_consumer | `1cc0e6a8a` | Memory |
| 2999_trust_profiles_nullable_scores | `52b428853` | Trust |
| 3001_highlight_kernel_admits_unhide | `a09c6af81` | Highlights |

The branch is **337 commits and 483 changed files ahead of main, and 0 behind**.
It is a multi-lane integration branch, not a sensing PR.

**Are they required for this PR?** Not by the sensing code — nothing in the
sensing work reads any object these create. They are required *because the
branch carries the files*: `audit:schema` audits **every** migration file in the
tree against the live database, so a file's presence in the PR is what creates
the obligation. Removing them from the branch would also clear the check, and
that is a real option (§6).

---

## 3. Ledger versus live schema, measured

**Ledger: zero rows for all nine.** Not even a 2254 backfill sentinel — 2254
seeded only filenames that existed when it ran, and all nine postdate it. So the
dry-run's "pending" verdict is correct and there is no ledger/schema
contradiction of the kind found for 3002 earlier.

**Live schema, and the finding that matters:**

| Migration | What it does | Live state | Visible to `audit:schema`? |
|---|---|---|---|
| 2977 | one `INSERT INTO feature_flags` | flag row **absent** | **NO** — a flag row is not a schema object |
| 2981 | one `INSERT INTO feature_flags` | flag row **absent** | **NO** |
| 2990 | one `INSERT INTO feature_flags` | flag row **absent** | **NO** |
| 2999 | `ALTER TABLE trust_profiles` drop NOT NULL/DEFAULT on **10** cols | still `NOT NULL DEFAULT 50.00` | **NO** — nullability is not an audited object |
| 2986 | 2 indexes on `layover_sessions` | table exists, **2 indexes missing** | YES |
| 2992 | 5 new tables + 5 cols + fn + 8 idx + 3 trg | `layover_certified_computations` exists; **all 5 tables absent** | YES |
| 2993 | 4 `highlight_id` cols + fn + idx + policy | all 4 memory tables exist; **`highlight_kernel_execute` absent** | YES |
| 2994 | `memory_relations` + 3 fns + cols/idx/policy/trg | `memory_event_outbox` exists; **`memory_relations` and all 3 fns absent** | YES |
| 3001 | `CREATE OR REPLACE highlight_kernel_execute` | function **absent** | YES |

**The load-bearing conclusion: applying 2977, 2981, 2990 and 2999 changes
nothing `audit:schema` measures.** They are genuinely unapplied and genuinely
worth applying for their own sake, but they cannot move this check by one
object. Applying them to "make progress" is exactly the partial subset that
leaves the check red.

**The only set that clears the check is 2986, 2992, 2993, 2994, 3001.**

---

## 4. Dependencies

- **3001 hard-depends on 2993.** It is a `CREATE OR REPLACE` of
  `highlight_kernel_execute`, which 2993 defines. Applied first it either fails
  or creates a function 2993 then overwrites — either way the order is fixed:
  **2993 before 3001**.
- 2986 needs `layover_sessions` — **present**.
- 2992 needs `layover_certified_computations` — **present** (it adds 5 columns
  to it) — and creates its 5 tables fresh.
- 2993 needs `memory_domain_events`, `memory_event_outbox`,
  `memory_command_receipts`, `memory_command_audit` — **all four present**.
- **2994 hard-depends on 2993**, and enforces it: `memory_outbox_claim` names
  `memory_event_outbox.highlight_id`, which 2993 adds, and 2994's precondition
  block raises `apply 2993 first` without it. 2993's header states the same
  ordering. (CORRECTED 2026-09-26 — this line previously read only "2994 needs
  `memory_event_outbox` — present", which is true and is not the constraint
  that matters.)
- 2999 is independent, and its own header demands it be applied **before**
  anything enables `trust_engine_enabled` (an unapplied 2999 makes every score
  persist raise 23502 and PostgREST reject the whole upsert).

No cycle, and two hard edges — **2993 → 2994** and **2993 → 3001**. Safe order:
**2986 → 2992 → 2993 → 2994 → 3001**, with 2977/2981/2990/2999 anywhere (and
2999 before any trust-engine enablement).

---

## 5. Proposed reconciliation — NOT EXECUTED

For each of the five, in order: read the file in full; confirm its
preconditions against live state; apply in one transaction; verify its objects
**independently of the file's own POST block**; write the
`schema_migration_ledger` row with `applied_by='manual'` and the sha256 of the
file bytes. That last detail is confirmed to work — `isProofOfApply` accepts
`applied_by ∈ {ci, manual}` with a real sha256, which is why none of the five
sensing migrations appears in the pending list.

Apply 2977/2981/2990/2999 in the same pass, not to move the check but because
they are unapplied and 2999 is a documented footgun while it stays that way.

**Shared-database changes this makes to portava-ci:** 6 new tables
(`layover_constraints`, `layover_time_budgets`, `layover_return_plans`,
`layover_checkpoints`, `layover_outcomes`, `memory_relations`); 5 new columns on
`layover_certified_computations`; 4 `highlight_id` columns plus
`memory_event_outbox.locked_until`; ~6 functions; ~12 indexes; ~4 triggers; 2
RLS policies; 3 feature-flag rows; nullability dropped on 6 `trust_profiles`
columns.

**Recovery, and why it is cheap here:** every affected existing table is
**empty** on portava-ci — `memory_domain_events`, `memory_event_outbox`,
`memory_command_receipts`, `memory_command_audit`,
`layover_certified_computations`, `layover_sessions`,
`layover_external_events`, `trust_profiles`, `highlights` all measured at **0
rows**. So a rollback destroys no data. 2986 and 2994 declare explicit
`ROLLBACK` sections; 2992 and 2993 declare `REVERSIBLE BY` (2992 warns its
rollback loses data, which is moot at zero rows); 3001 reverts by re-running
2993's function body. 2999 reverts by restoring `SET DEFAULT 50.00` and
`SET NOT NULL`, which is safe only while no NULL has been written.

**The honest risk:** this certifies four other lanes' DDL on a database those
lanes share. Correctness of their *design* is not established by this apply and
this document does not claim it — only that the objects match what the files
declare.

---

## 6. The alternative that also clears the check

Remove the nine files from this branch and let each lane land and apply its own.
`audit:schema` obligations follow the tree, so a branch that does not carry them
does not owe their objects. This keeps lane ownership intact and shrinks a
483-file PR. It costs whatever branch surgery the dependent code needs — the
branch also carries those lanes' TypeScript, which would go with them.

**Recommendation: §5, applying all nine, with §6 as the fallback if the owner
would rather the lanes certified their own DDL.** §5 is the only path that ends
with `audit:schema` green on this branch without changing what the branch
contains, and the zero-row state makes it the cheapest this reconciliation will
ever be.

---

## 7. The decision, stated once

Everything above describes the situation. This section is the thing to answer.
**Nothing here has been executed.** All state re-measured against portava-ci
(`hwokxgbmezheskbzskfr`) on 2026-09-26, after `8fdf94ba9`.

### 7.1 Why nine became five, in one paragraph

The applier's dry run lists **nine** pending files. `audit:schema` names
**five**. Both are right, and the difference is not a filter anyone applied —
it is what `audit:schema` measures. The auditor parses each migration for the
*objects* it claims (tables, columns, indexes, functions, triggers, policies)
and asks the live catalog whether each exists. Four of the nine claim no
object at all:

| Pending, not audited | What it actually is | Live state | Objects it would add |
|---|---|---|---|
| `2977_layover_maturity_gate_flag` | one `INSERT INTO feature_flags ('layover_maturity_gate_enabled', FALSE)` | row absent | **0** |
| `2981_layover_event_ingest_flag` | one `INSERT INTO feature_flags ('layover_event_ingest_enabled', FALSE)` | row absent | **0** |
| `2990_nearby_reachable_flag` | one `INSERT INTO feature_flags ('nearby_reachable_enabled', FALSE)` | row absent | **0** |
| `2999_trust_profiles_nullable_scores` | `ALTER TABLE trust_profiles` dropping NOT NULL **and** DEFAULT on **10** score columns | still `NOT NULL DEFAULT 50.00` | **0** — nullability and defaults are not objects |

A feature-flag row is data, not schema. A dropped NOT NULL changes a column
that already exists. So all four are genuinely unapplied and none of them can
move the check by a single object. **Applying them to show progress is the
partial subset that leaves the check exactly as red as it is now** — the thing
the earlier instruction warned against.

Nine minus those four is five, and those five carry all 44 objects.

### 7.2 The five, each with the four facts

Counts are the auditor's own, from the `8fdf94ba9` run.

---

**`2986_layover_sessions_fanout_indexes`** — 2 objects

* **Changes:** two partial indexes on `layover_sessions`
  (`layover_sessions_airport_active_idx`, `layover_sessions_manual_iata_active_idx`).
  No table, no column, no data.
* **Depends on:** `layover_sessions`, which is **present**. Nothing depends on it.
* **Why this PR:** only because the branch carries the file. No code on this
  branch requires either index to function; they are a fan-out read
  optimisation.
* **Recovery:** the file states it —
  `DROP INDEX IF EXISTS public.layover_sessions_airport_active_idx;` and the
  same for the second. Both are `IF EXISTS`, both are instant on a **0-row**
  table. This is the cheapest of the five by a wide margin.

---

**`2992_layover_decision_record_and_operational_tables`** — 22 objects

* **Changes:** creates 5 tables (`layover_constraints`, `layover_time_budgets`,
  `layover_return_plans`, `layover_checkpoints`, `layover_outcomes`); adds 5
  columns to the existing `layover_certified_computations`
  (`snapshot_id`, `input_facts`, `source_refs`, `rules_applied`,
  `ledger_version`); 1 function (`layover_snapshot_rows_are_immutable`);
  8 indexes; 3 immutability triggers.
* **Depends on:** `layover_certified_computations`, **present** with 0 rows.
  Creates its own 5 tables fresh. Nothing else on the list depends on it.
* **Why this PR:** this is the one of the five with a live code caller on the
  branch. `services/layover/LayoverDecisionStore.ts` writes
  `layover_time_budgets` and `layover_return_plans` and writes the five new
  columns, which is why **`check:write-path-columns` and
  `check:missing-live-columns` are red and not only `audit:schema`**. Those two
  checks are reporting this file, not a defect in the TypeScript.
* **Recovery:** the file's own `REVERSIBLE BY` block, and its first instruction
  is the one that matters: set
  `layover_decision_persistence_enabled = FALSE` **before** dropping anything,
  because dropping under a live writer sends every `GET /:id/safety` down the
  `write_failed` path. **That precondition is already satisfied here** — that
  flag row does not exist in portava-ci at all, and `isFlagEnabled` returns
  false for a missing row, so nothing can write these tables today. Then
  `DROP TABLE IF EXISTS` the five, in the file's stated order
  (`layover_outcomes`, `layover_checkpoints`, `layover_return_plans`, …).
  The file warns its rollback loses data; at **0 rows** there is none to lose.

---

**`2993_highlight_command_boundary`** — 7 objects

* **Changes:** adds `highlight_id` to four memory-kernel tables
  (`memory_domain_events`, `memory_event_outbox`, `memory_command_receipts`,
  `memory_command_audit`), relaxes `memory_id` to nullable on two of them with
  `one_subject` CHECK constraints, creates `highlight_kernel_execute(jsonb)`,
  one index, one RLS policy.
* **Depends on:** all four memory tables, **present**, all at **0 rows**.
  **3001 depends on this one** — see below.
* **Why this PR:** the branch carries the highlights command-boundary
  TypeScript that dispatches through `highlight_kernel_execute`.
* **Recovery:** the file's `REVERSIBLE BY` block, which is explicit and
  ordered: drop the function, drop the policy, then drop the four columns and
  their constraints, and only then restore `memory_id SET NOT NULL` on the two
  tables. It states the safety condition itself — *"Safe while
  `memory_kernel_enabled` is false: nothing writes these tables."*
  **Measured: `memory_kernel_enabled` is `false` in portava-ci**, so the
  condition holds now.

---

**`2994_memory_relations_and_outbox_consumer`** — 12 objects

* **Changes:** creates `memory_relations`; adds
  `memory_event_outbox.locked_until`; creates 4 functions
  (`memory_relations_owner_matches_source`, `memory_outbox_claim`,
  `memory_outbox_ack`, `memory_outbox_fail`); 4 indexes; 1 policy; 1 trigger.
* **Depends on:** `memory_event_outbox`, **present**, 0 rows — **and on 2993,
  hard.** The file enforces it itself: `memory_outbox_claim` selects
  `o.highlight_id`, which 2993 adds, and a precondition block raises
  `2994 PRECONDITION FAILED: public.memory_event_outbox.highlight_id does not
  exist — apply 2993 first`. 2993's own header states the same ordering from
  the other side. So there are **two** ordering constraints among the five,
  not one.
* **Why this PR:** the branch carries the outbox consumer that calls
  `memory_outbox_claim`/`ack`/`fail`.
* **Recovery:** the file's ROLLBACK note — `DROP TABLE memory_relations`, drop
  the three outbox functions, `ALTER TABLE memory_event_outbox DROP COLUMN
  locked_until`. Its own words: dropping the column *"loses only in-flight
  leases, which are by definition re-claimable. Nothing else in the schema
  references any of it."* The file also states plainly that it is **NOT
  REHEARSED AGAINST PRODUCTION** — rehearsed only against `scripts/local-db`.
  That is a caveat about production, not about portava-ci.

---

**`3001_highlight_kernel_admits_unhide`** — 1 object

* **Changes:** a single `CREATE OR REPLACE FUNCTION highlight_kernel_execute`,
  adding `UNHIDE_HIGHLIGHT` to a vocabulary gate that 2993 wrote listing only
  PIN / UNPIN / HIDE.
* **Depends on:** **2993, hard.** It replaces the function 2993 creates. Run
  before 2993 and either it fails or 2993 overwrites it — the order is fixed.
  This is the second of the two ordering constraints; 2994 carries the other.
* **Why this PR:** `memoryCommandBus.ts` on this branch already declares
  `UNHIDE_HIGHLIGHT` in full. Without 3001 the TypeScript dispatches a command
  the database answers with `MEMORY_COMMAND_UNKNOWN_TYPE`.
* **Recovery:** it has no declared ROLLBACK section, and does not need one —
  reverting is re-running 2993's function body, a second `CREATE OR REPLACE`
  back to the previous definition. Nothing else changes.

### 7.3 What happens if an apply fails, measured from the applier

This is the part that makes the decision cheaper than it looks, and it comes
from reading `scripts/src/apply-migrations.ts` rather than from assurance:

1. **Each migration and its ledger row commit together or not at all.**
   `buildApplyStatement` emits `BEGIN; <body> ; INSERT INTO
   schema_migration_ledger … ; COMMIT;`. A failure inside the body rolls back
   the DDL **and** writes no ledger row. **Recovery after a failed apply is
   nothing** — fix the file and re-run; the applier still sees it as pending.
2. **The run stops at the first failure.** `runPlan` returns immediately on a
   failure or refusal, so a later migration never executes against a schema
   state its predecessor did not reach.
3. **There is exactly one outcome that needs a human**, and the applier names
   it separately rather than calling it a failure: `postcondition-failed`. The
   migration applied and is recorded — that part is atomic and true — but the
   file's own post-COMMIT assertion did not hold. The per-migration recovery
   in §7.2 is for that case, and for that case only.
4. **`decideExitCode` has no partial-success code**, deliberately: *"a run that
   stopped halfway left the database in a state no environment has ever had."*

**Every table any of the five touches is empty.** Re-measured 2026-09-26:
`layover_sessions`, `layover_certified_computations`, `layover_external_events`,
`layover_recommendations`, `memory_domain_events`, `memory_event_outbox`,
`memory_command_receipts`, `memory_command_audit`, `memory_episodes`,
`highlights`, `trust_profiles` — **0 rows, all eleven.** No rollback among the
five can destroy data today. That is a property of this week, not of the
migrations.

### 7.4 The decision

**Order (the only constraint is 2993 before 3001):**
`2986 → 2992 → 2993 → 2994 → 3001`, then 2977 / 2981 / 2990 / 2999 in any order.

Pick one:

* **A — apply all nine to portava-ci.** Clears `audit:schema`,
  `check:write-path-columns` and `check:missing-live-columns` together, because
  all three are reporting the same absence. Costs: certifying four other lanes'
  DDL on a database those lanes share. This document does not claim their
  *design* is right, only that the objects will match what the files declare.
* **B — apply only the five.** Same check result. Leaves 2999 as a live footgun
  (an unapplied 2999 makes every trust-score persist raise 23502 the moment
  anything enables `trust_engine_enabled`, which is currently absent, hence
  false) and leaves three flag rows missing.
* **C — strip the nine from this branch.** Clears `audit:schema`, and **§9
  measures what it costs**: removing the files alone breaks
  `check:schema-references`, a currently-green static check that runs on every
  PR, with 7 new dead references from `LayoverDecisionStore.ts` against a
  ratchet at zero. So C means removing the dependent code as well — seven files
  that do not exist on main, plus reverting the `TrustScoreService` change. It
  is branch surgery across four lanes, not a cleanup.

**Recommendation: A**, with C as the fallback if the lanes should certify their
own DDL. A is the only option that ends with the branch green *and* intact, and
the all-zero-rows state makes the rollback risk as low as it will ever be.
§8 strengthens this: every one of the nine has a reader that is new or changed
on this branch, so B's leftovers are not cosmetic either — an unapplied 2999 is
the schema half of a `TrustScoreService` change this PR already contains.

**Not doing:** applying 2977/2981/2990/2999 alone (§7.1 — moves zero objects),
and applying anything at all before this is answered.

---

## 8. Why each of the nine is required, and by what

§2 said these are "four other lanes' work, not sensing work" and that they are
"not required by the sensing code… required *because* the branch carries the
files". Both halves are true and together they mislead, because they invite the
reading that the nine are severable paperwork. **They are not.** Every one of
the nine has a code reader that is new or changed on this branch. The lane
question is about *who wrote them*; the requirement question is about *what
this branch's code does without them*, and those are different questions.

Measured by asking `origin/main` whether each reader exists there:

| Migration | Reader | On main? | Without the migration, this branch's code… |
|---|---|---|---|
| 2977 | `services/airport/layoverMaturityGate.ts` | **NEW** | runs, gate open (see §8.1) |
| 2981 | `services/layover/LayoverExternalEventService.ts`, `routes/layoverEvents.ts` | **NEW** | runs, route refuses (see §8.1) |
| 2986 | fan-out reads on `layover_sessions` | — | runs, unindexed |
| 2990 | `routes/nearbyReachable.ts` | **NEW** | runs, disabled envelope (see §8.1) |
| 2992 | `services/layover/LayoverDecisionStore.ts` | **NEW** | **breaks** — writes tables and columns that do not exist |
| 2993 | `services/memoryProjections/outboxConsumer.ts`, `highlightEventReplay.ts` | **NEW** | **breaks** — `highlight_kernel_execute` absent |
| 2994 | `services/memoryProjections/outboxConsumer.ts` | **NEW** | **breaks** — `memory_outbox_claim`/`ack`/`fail` absent |
| 2999 | `services/trust/TrustScoreService.ts` | on main, **+187/−35 here** | **breaks** — see §8.2 |
| 3001 | `lib/memoryCommandBus.ts` (on main) + `highlightEventReplay.ts` (NEW) | — | answers `MEMORY_COMMAND_UNKNOWN_TYPE` |

So: **none of the nine is unrelated work that happens to be in the tree.** What
is true is narrower — none of them is *sensing* work, and the sensing code
reads nothing any of them creates.

### 8.1 The three feature-flag rows: the value is FALSE and the point is not the value

All three insert exactly one row, `enabled = FALSE`:

| Migration | Flag | Seeded value | What ON would do |
|---|---|---|---|
| 2977 | `layover_maturity_gate_enabled` | `false` | classify the session airport on the six-rung maturity ladder and gate `landside_recommendations` at `L1_MAPPED`. Its own description records that **no production airport reaches L1 today (0 of 3,206 rows, 0 with `terminal_info`)**, so turning it ON *withdraws every landside card everywhere* until an airport is curated. Airside guidance, the certified window and the return deadline sit at L0 and are untouched. |
| 2981 | `layover_event_ingest_enabled` | `false` | `POST /api/layover/events` accepts a canonical envelope from an authenticated producer and writes `layover_external_events` for the replanner. Its description flags the risk in its own words: **"ENABLING THIS OPENS A WRITE PATH THAT MOVES SAFETY INPUTS"** — an external event can shorten a usable window or move a return deadline. It names two prerequisites: a producer secret provisioned outside this repository, and a scheduled consumer. |
| 2990 | `nearby_reachable_enabled` | `false` | `GET /api/nearby/reachable` serves a `ReachablePersonProjection` over circle members and accepted trip crew. Proximity is a 5 km bucket and never a coordinate; availability only where opted in; a person in invisible mode is absent. |

**The row does not change behaviour, and that is the whole point.** `isFlagEnabled`
is fail-closed: a missing row yields `data = null` and reads **false**, the same
as a row set false. So on portava-ci today all three features are already off,
and applying these three migrations leaves them off.

What the row changes is **who can turn it on, and whether that is recorded.**
The audited toggle path — `PATCH /api/admin/feature-flags` via
`toggle_feature_flag_with_audit` — operates on a row. Without a row the only
way to enable the feature is a direct `UPDATE`, which 2981's description names
exactly: *"before this the only way to enable it was a direct UPDATE that
writes no audit row."* Seeding the row converts an unaudited enable into an
audited one.

That is a real requirement and it is a governance one, not a functional one. It
is also why these three are worth applying even though §7.1 proves they move
`audit:schema` by zero objects — the two facts are not in tension.

### 8.2 2999: ten columns, and the one where the branch's code is already ahead of the schema

Ten columns on `public.trust_profiles`, each declared
`numeric(5,2) DEFAULT 50.00 NOT NULL` in the baseline, each getting
`DROP NOT NULL` **and** `DROP DEFAULT`:

`overall_score`, `plan_attendance`, `host_quality`, `communication`,
`respect_safety`, `location_honesty`, `content_quality`, `community_value`,
`guide_accuracy`, `passport_authenticity`.

**Intended effect:** make "not scored" representable. The file implements a
named owner decision (Q1, 2026-09-22): *"Approve nullable trust scores… NULL
meaning not scored. Remove fabricated neutral defaults… Unmeasured categories
must not contribute an invented 50."* The defect it closes is concrete and the
file states it: a user with **zero** trust events currently scores exactly
50.00 overall and is promoted to `reliable_traveler` (`level_reliable = 50`),
and a user with one negative event is dragged back toward 50 by eight
fabricated neutrals.

**It converts no data, deliberately.** There is no `UPDATE` in the file and its
header forbids adding one, because a measured 50.00 and a substituted 50.00 are
byte-identical in a `numeric(5,2)` and nothing on the row distinguishes them —
`evidence_count` (2371) is per-profile, not per-category. Every existing row
keeps the value it held. Only rows written after the migration carry the
distinction.

**Why the DEFAULT goes too and not just the NOT NULL:** with `DEFAULT 50.00`
still in place, an insert that omits the column silently gets 50 again, so
dropping only the constraint would leave the fabrication intact by another
route.

**This is the one where the branch's code has already moved.**
`TrustScoreService.ts` is on main but is changed here by +187/−35, and the
change is exactly this:

* `origin/main` — `if (relevant.length === 0) return 50; // neutral default`
* this branch — `if (relevant.length === 0) return null; // NOT SCORED`

So this branch's engine writes `null` into columns that are still
`NOT NULL DEFAULT 50.00` on portava-ci **and on production**. Every category
persist would raise 23502 and PostgREST would reject the whole upsert. The only
reason it is not failing today is that `trust_engine_enabled` has no row and
therefore reads false. **2999 is not a tidy-up; it is the schema half of a code
change this PR already contains**, and the order is fixed: 2999 must be applied
before anything enables the trust engine.

---

## 9. Option C, measured rather than estimated

§6 offered "remove the nine files and let each lane land its own", and asserted
it costs "whatever branch surgery the dependent code needs". That was a guess.
It has now been run.

**The experiment:** all nine migration files moved out of
`src/migrations/`, `check:schema-references` run, files restored, working tree
verified clean. Nothing was committed and no database was touched.

**The result — it does not merely leave a check red, it turns a currently-green
one red:**

```
Canonical schema: 512 tables from baseline + 661 migrations   [was 518 / 670]

✗ Schema-reference ratchet broken:
  src/services/layover/LayoverDecisionStore.ts: 7 NEW dead reference(s)
        layover_certified_computations.input_facts       :453 (insert)
        layover_certified_computations.ledger_version    :453 (insert)
        layover_certified_computations.rules_applied     :453 (insert)
        layover_certified_computations.snapshot_id       :453 (insert), :581, :604 (select)
        layover_certified_computations.source_refs       :453 (insert)
```

`check:schema-references` is the **static** twin of the live check: it diffs
against the canonical schema (baseline + migrations) and therefore runs on
**every** PR, in the `api-server · typecheck + static checks` job, with no
database and no slot to be starved of. Its ratchet is at **zero** known dead
references. Removing the migrations while keeping the code that reads them
takes it from green to red — trading a live-lane failure for a static-lane
failure, and adding a *new* one.

**So option C is not "delete nine SQL files."** It is: delete the nine files
**and** the branch code that reads them — `LayoverDecisionStore.ts` at minimum,
and by §8's table also `layoverMaturityGate.ts`, `LayoverExternalEventService.ts`,
`routes/layoverEvents.ts`, `routes/nearbyReachable.ts`,
`outboxConsumer.ts`, `highlightEventReplay.ts`, and the
`TrustScoreService.ts` change back to returning `50`. Seven of those files do
not exist on main at all, so "removing" them means removing the lanes' work
from this branch, not tidying it.

That is a legitimate choice — it is what "let each lane land and apply its own"
actually means — but it is branch surgery across four lanes, not a cleanup, and
the seven dead references above are the machine-checked proof that the SQL and
the TypeScript cannot be separated silently.

**What option C is NOT available for:** removing the migrations to make
`audit:schema` stop complaining while keeping the code. The tree would still
contain writers for objects no migration declares, `check:schema-references`
would say so on every PR, and the only thing achieved would be moving the
evidence from a lane that runs sometimes to a lane that runs always.

---

## 10. Executed — decision A, portava-ci only, 2026-09-26

The owner chose **A**, conditional on the running test suite passing. It
passed (`api-server · node:test suite` on `8679f5cc9`: success), and the nine
were applied to `portava-ci` in the §7.4 order, one transaction each, no
failure. §5's "NOT EXECUTED" banner is historical from this point.

The full record — timestamps, per-file catalog verification, the STAGE-2 and
STAGE-4 equivalents, the negative control, production's untouched state, and
rollback — is the 2026-09-26 batch entry at the end of `docs/migrations.md`.
The facts this document's earlier sections predicted and that held:

| Predicted | Measured |
|---|---|
| §7.3: a failed apply rolls back DDL and ledger row together | not exercised — no apply failed |
| §7.3: `postcondition-failed` is the only outcome needing a human | could not occur — all nine carry postconditions inside the transaction |
| §4/§8: two hard edges, 2993→2994 and 2993→3001 | 2994's precondition and 3001's precondition both passed *because* 2993 preceded them |
| §7.1: 2977/2981/2990/2999 move `audit:schema` by zero objects | not re-measured separately; all 43 distinct objects come from the other five |
| §8.1: the flag rows change no behaviour | all four inserted `false`; every gate reads `false` after |
| §7.3: all affected tables at 0 rows | still 0 rows after — every probe rolled itself back |

**What this does not do.** Production is unchanged (0 of the nine, verified
read-only). No feature was enabled. No scope was granted. `certify:migrations`'s
STAGE 1 still cannot pass on this branch for the reason the 2998 entry records,
which is unrelated to these nine.
