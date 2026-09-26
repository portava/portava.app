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
* **C — strip the nine from this branch.** Also clears all three checks, since
  the obligation follows the tree. Keeps lane ownership intact and shrinks a
  483-file PR. Costs whatever branch surgery the dependent TypeScript needs —
  `LayoverDecisionStore.ts` and the highlights/memory kernel code would go too.

**Recommendation: A**, with C as the fallback if the lanes should certify their
own DDL. A is the only option that ends with the branch green *and* intact, and
the all-zero-rows state makes the rollback risk as low as it will ever be.

**Not doing:** applying 2977/2981/2990/2999 alone (§7.1 — moves zero objects),
and applying anything at all before this is answered.
