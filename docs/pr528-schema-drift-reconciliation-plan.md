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
| 2999 | `ALTER TABLE trust_profiles` drop NOT NULL/DEFAULT on 6 cols | still `NOT NULL DEFAULT 50.00` | **NO** — nullability is not an audited object |
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
- 2994 needs `memory_event_outbox` — **present**.
- 2999 is independent, and its own header demands it be applied **before**
  anything enables `trust_engine_enabled` (an unapplied 2999 makes every score
  persist raise 23502 and PostgREST reject the whole upsert).

No cycle. Safe order: **2986 → 2992 → 2993 → 2994 → 3001**, with 2977/2981/2990/2999
anywhere (and 2999 before any trust-engine enablement).

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

## 7. A separate finding, found while reconciling: portava-ci's ledger records an apply that did not happen

This section is not about the nine. It is about a tenth file, and it was found
by checking objects rather than reading a report — the same method §3 uses.

### 7.1 What the ledger says, and what the catalog says

`public.schema_migration_ledger` in portava-ci (`hwokxgbmezheskbzskfr`) holds:

| filename | applied_by | checksum (12) | applied_at | run |
|---|---|---|---|---|
| `2481_sensing_sessions_option_a_issuer.sql` | `ci` | `56c1244782e8` | 2026-09-09 14:44:05+00 | `run=34365037936` |

That row satisfies `isProofOfApply` in `scripts/src/apply-migrations.ts` on
every count: the applier wrote it, `applied_by` is `ci`, and the checksum is a
real sha256 rather than the literal `backfill` that 2254's seed rows carry. Read
through the ledger alone, 2481 is applied.

Every object 2481 declares is absent from that database. Measured
2026-09-26 by read-only catalog queries:

| object 2481 declares | present in portava-ci |
|---|---|
| `sensing_contribution_sessions.issued_to_profile_id` | **no** |
| constraint `sensing_contribution_sessions_issuer_fk` | **no** |
| constraint `sensing_contribution_sessions_option_a_check` | **no** |
| function `revoke_sensing_sessions_for_profile(uuid, timestamptz)` | **no** |

The 2480 table itself IS there, with its twelve columns and zero rows, so this
is not a missing prerequisite. 2481 ends in `COMMIT;` after a postcondition
block that raises if `issued_to_profile_id` is missing, so a committed run
could not have left this state. The file's own header says what happened:

> `artifacts/api-server/src/migrations/2481_sensing_sessions_option_a_issuer.sql:6#-- NOT APPLIED. The owner runs all SQL. Dry-run inside a ROLLED-BACK transaction`

A rehearsal rolled back and the ledger row stayed. census-sensing's DB-2 row
already records the history in one line — "2481 then 2480 rolled back, then
re-applied" — what it does not say is that the retraction never reached the
ledger.

**Production is clean, and this is portava-ci only.** Read read-only on
2026-09-26 against `ajrurzioarfkagpuxfnb`: there is NO 2481 ledger row there at
all, and none of its four objects. 2480 is there, `applied_by` `manual`, with
checksum `f0e8511beea6` — byte-identical to portava-ci's 2480 row, so the two
databases got the same file. census-sensing's own last word on production,
measured 2026-09-25, reads "`2481` absent, correctly", and that statement is
true and stays true. It was never a statement about portava-ci, and nothing in
that census has measured portava-ci's ledger for 2481.

### 7.2 Why nothing has caught it since 2026-09-09

`certify:migrations` STAGE 2 is exactly the check for this. Its own words for
the failure are "the apply reported success and the objects are not there —
which is exactly the state an applier's own report cannot rule out." It would
name all four objects.

It never looks. Its default scope is the ledger rows tagged with the CURRENT
run id:

> `artifacts/api-server/src/scripts/certifyMigrations.ts:424# * read from the database rather than a value passed between two processes that`

2481's row is tagged `run=34365037936`. That run is finished, so 2481 has been
out of scope for every certification since, and will be forever. The stage that
would catch a false apply only ever sees applies that are minutes old. A
`--files` or `--all-ledger` invocation reaches it; nothing schedules one.

### 7.3 The cohort, checked rather than assumed

Nine migration files on disk carry a "NOT APPLIED" header. All nine have a
proof-of-apply row in portava-ci. That header is authoring boilerplate written
before the apply and not updated after it, so by itself it proves nothing —
which the catalog confirms. Eight of the nine ARE applied:

| file | object checked | present |
|---|---|---|
| `2402_telegraph_membership_rls_recursion.sql` | `authz.is_active_thread_member` + policies `msg_select`, `mt_select`, `mtm_select` | yes (3/3) |
| `2411_layover_recommendation_rec_key_backfill.sql` | `layover_recommendations.rec_key` | yes |
| `2460_meetup_invites_self_invite_latent_disclosure.sql` | `authz.is_meetup_invitee` + policy `mi_own` | yes |
| `2461_meetup_rls_recursion.sql` | policies `meetups_invitee_select`, `mto_invitee_select` | yes (2/2) |
| `2462_meetup_time_votes_write_boundary.sql` | policy `mtv_own` | yes |
| `2470_media_asset_canonical_columns_flag_agnostic.sql` | the four `media_assets` columns it adds | yes (4/4) |
| `2480_sensing_contribution_sessions.sql` | the table and its twelve columns | yes |
| `2796_trip_reservation_history_security_definer.sql` | `public.trip_reservations_history` | yes |
| `2481_sensing_sessions_option_a_issuer.sql` | the four objects in §7.1 | **NO — 0/4** |

One false apply in nine. That is a rate, not a one-off, and the eight true ones
are why the header text cannot be used as the signal.

### 7.4 Which direction the danger runs

The outcome is the safe one and the evidence is the unsafe one, and they must
not be confused.

2481 is the migration that attaches `issued_to_profile_id` — a profiles foreign
key — to the sensing session row. It is Option A only; the anonymous posture
this branch builds against forbids it, and `lib/sensingAuthPosture` records
why. **The column is absent, which is what the posture requires.** No identity
column reached the session table and no live privacy boundary is crossed today.

What is wrong is the record, in one database. portava-ci's ledger asserts, with
the applier's own proof marks, that a posture-forbidden migration was applied by
CI. Production's ledger does not, so no production claim rests on it. Anything that
reads the ledger to decide what the schema holds — a future lane, a rollout
plan, a person — is told the identity column exists. The §5 procedure in this
document reads ledger rows. So does the cutover in
`docs/sensing-contributor-identity-cutover-runbook.md`, whose whole subject is
this column.

### 7.5 What I did not do

**I did not delete the row.** It is the only durable evidence that a rehearsal
rolled back without retracting its ledger entry, and deleting it would make
the ledger agree with the catalog by erasing the disagreement.

**I did not apply 2481.** The posture forbids it and no owner decision has
changed that. The absent column is the correct state.

**I did not edit the row's notes.** That is a write to a ledger row another
run authored, and whether a correction belongs in `notes` or in a retraction
row of its own is the owner's call, not mine.

### 7.6 What the owner is being asked to decide

1. **How the row is retracted.** Either an appended `notes` correction on the
   existing row, or a separate retraction row, or a ledger column that can say
   "recorded, then rolled back". The requirement is that the original row stays
   readable — the problem is worth keeping.
2. **Whether `certify:migrations -- --all-ledger` runs once against portava-ci.**
   It is the existing, unmodified check, and it is the only way to learn whether
   2481 is the only false apply or the one that happened to be looked at. It
   needs the CI credentials this session does not hold.
3. **Whether STAGE 2 should have a scheduled `--all-ledger` run.** A check that
   only ever certifies minutes-old applies cannot find a false apply that is
   two weeks old, and this one was found by hand.

Nothing in §7 blocks the nine of §1–§6, and nothing in §1–§6 fixes §7.
