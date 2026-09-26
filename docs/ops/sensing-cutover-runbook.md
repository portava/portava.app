# Sensing cutover runbook — schema, code, flags and scope, in the order they must go

**Status: PREPARED, NOT EXECUTED on production.** Every step below has been
applied, verified and recorded on `portava-ci` (`hwokxgbmezheskbzskfr`) unless
a row says otherwise. Production (`ajrurzioarfkagpuxfnb`) is read-only for the
integration owner and holds none of it. Nothing here manufactures consent,
enables a feature, or claims an operational fact that was not read from a
database.

This runbook composes with `docs/sensing-contributor-identity-cutover-runbook.md`
(the 3002 → 3003 → 3310 coupled window, quiesce/drain/verify-quiet, and its §5
rollback). That document is not repeated; it is referenced by step. Ledger
detail for every apply is in `docs/migrations.md`.

---

## 0. What is where — measured 2026-09-26

| Artifact | portava-ci | production | Recorded |
|---|---|---|---|
| 2277 / 2278 (scoped trust — 3002's precondition) | applied | **absent** | migrations.md |
| 3002 contributor identity (pepper, token, nullable subject) | applied 02:38 | absent | migrations.md, identity runbook |
| 3003 identity bridges | applied 02:40 | absent | identity runbook |
| 3004 `sensing_presence_context_enabled` seed (FALSE) | applied 09-25 | absent | migrations.md |
| 3110 `sensing_published_aggregates` | applied 09-25 | absent | migrations.md |
| 3310 consent bridge functions | applied 02:47 | absent | identity runbook |
| 3311 snapshot input provenance | applied 09:36 | absent | migrations.md (2026-09-26 second batch) |
| 3312 anonymous-store feature columns | applied 09:37 | absent | migrations.md (same entry) |
| 3313 `sensing_publication_enabled` seed (FALSE) | applied 16:50 (row read back `false`) | absent | migrations.md (2026-09-26 third batch) |
| 2841 `experience_session_enabled` seed (FALSE) — the sessions S92/S112 are made from | applied by CI; row `false` | **absent**: no ledger row, no flag row | read 2026-09-26 |
| 3314 `memory_projections.claim_refs` + retraction exemption | applied 16:52 | absent | migrations.md (same entry) |
| 3315 `sensing_anon_contributions.surface_permitted` | applied 16:51 | absent | migrations.md (same entry) |
| `SENSING_CONTRIBUTOR_PEPPER` (env, S18/S32) | — | **unconfigured**; the ingest's first statement refuses without it | census-sensing §14.2 |
| Branch code (PR #528), incl. the session issuer `POST /v1/sensing/session` | CI-verified | **not deployed** | — |
| Consent disclosure v2 (`sensing_contributions_v2`) | defined in code, not stamped | **not in force**: the server stamps v1 | `docs/contracts/sensing-consent-disclosure-v2.md` |
| Client build (capture, commitment, features, zone hint) | tests green | **not shipped** | — |

Flags, read on portava-ci after the last apply: `discovery_candidate_projection_enabled`,
`intel_claim_projection_crowd`, `media_evidence_enabled`, `memory_projection`,
`sensing_presence_context_enabled` and `sensing_publication_enabled` all
`false`. On production every one of these
is `false` or absent, and the identity runbook §3 records the two capture
flags that are `true` there.

Row counts on both databases, every sensing table: **0**. That is the fact
that makes this cutover cheap and its rollback honest; re-read it before
every step (§2, query Q0).

### 0a. Reconciliation: 3110 and 3004 are in the chain

census-sensing §26.5 once wrote the chain as `2277 → 2278 → 3002 → 3003 →
3310 → 3311 → 3312 (→ 3313)`, which omits 3110 and 3004. This runbook has
always carried both, as §3 step 5. Read on 2026-09-26, not assumed:

| | portava-ci | production |
|---|---|---|
| `3004_sensing_presence_context_flag.sql` in the ledger | yes, `manual`, 2026-09-25 20:41, sha `307a362614f2…` | **no row** |
| `sensing_presence_context_enabled` row | present, `false` | **no row** |
| `3110_sensing_published_aggregates.sql` in the ledger | yes, `manual`, 2026-09-25 20:43, sha `a2c91261449c…` | **no row** |
| `to_regclass('public.sensing_published_aggregates')` | present | **NULL** |

So 3110 is **satisfied on portava-ci, missing on production, and superseded by
nothing**: no later file creates `sensing_published_aggregates`, and the
publisher's differencing gate cannot keep its last published value without it
(3110's header). The omission was in the census sentence, not in the plan.
§27 of census-sensing corrects the sentence; the order below is the
authoritative one.

---

## 1. Dependencies, and why the order is what it is

```
2277 → 2278 ─┐
             ├→ 3002 → 3003 → 3310 ──┐
                                     ├→ [CODE DEPLOY] → un-quiesce
3311 ────────────────────────────────┤
3312 ────────────────────────────────┤   (3312 also BEFORE the client build)
3314 ────────────────────────────────┤   (before memory_projection is turned on)
3315 ────────────────────────────────┤   (before surface is granted)
3004, 3110, 3313 (flag seeds + store; any time before the flips) ─┘
```

| Edge | Why |
|---|---|
| 2277/2278 before 3002 | 3002's precondition block refuses without them (identity runbook §4 step 0). |
| 3002 → 3003 → 3310, then the code, inside ONE quiesced window | Coupled both ways: new code on old schema fails `subject_id NOT NULL`; old code on new schema writes duplicate rows past the token-aware replay check (identity runbook §1a/§1b). |
| **3311 before the code** | The projection writer tries `input_observation_ids`; on the schema-cache error for an unknown column it retries WITHOUT it and logs `intel.projection.provenance_unavailable`. Code-first therefore does not break projection — it degrades every snapshot written in the gap to "provenance unrecorded", and the deletion reach then falls back to SUBJECT granularity for those rows (over-inclusive, still correct). Schema-first gives exact provenance from the first write. |
| **3312 before the CLIENT build** | A contribution WITHOUT `features` inserts on a pre-3312 database (the row carries none of the fifteen columns). A contribution WITH `features` on a pre-3312 database fails on the unknown column and the ingest answers `error` — every featured contribution from a shipped client would be refused until 3312 lands. The server itself may go either side of 3312. |
| **3314 before `memory_projection` ON** | With the flag on and 3314 absent, the session memory writer REFUSES (`claim_refs_unavailable`) rather than write a memory without its lineage, so memories from closed sessions are simply not written. With 3314 present and the flag on, the SQL projector's watermark would otherwise retract every session memory on its next pass; 3314's one predicate prevents that. Code may go either side of 3314. |
| **3315 before `surface` is granted** | The publisher's cohort read filters on `surface_permitted` and fails closed without the column, so publication yields nothing. The ingest only names the column when a session carries `surface`, which no consent recorded today can produce, so the ingest works either side. |
| 3004 / 3110 / 3313 before their flips | Flag seeds and the publication store. Each changes no behaviour when applied (all seeded FALSE; the store is written only by the publisher, which refuses on its first gate). |
| `SENSING_CONTRIBUTOR_PEPPER` before any contribution | Operator artifact. Without it the anonymous ingest refuses every caller by design; with it and 3002 absent the human-claim path is unaffected (different population). |

**What does not depend on the schema at all:** the erasure recompute
(`services/accountDeletion/sensingErasureRecompute`) runs on any schema — with
3311 it recomputes exactly the affected snapshots; without it, every snapshot of
every subject the account observed. Both produce the effect; one is precise.

---

## 2. Preconditions — read-only queries (production and portava-ci)

```sql
-- Q0. Every sensing table must be EMPTY, or §6's rollback analysis does not hold.
select (select count(*) from public.intel_observations)            as observations,
       (select count(*) from public.intel_evidence)                as evidence,
       (select count(*) from public.intel_confirmations)           as confirmations,
       (select count(*) from public.intel_presence_verifications)  as presence_verifications,
       (select count(*) from public.intel_state_snapshots)         as snapshots,
       (select count(*) from public.intel_state_snapshot_versions) as snapshot_versions,
       (select count(*) from public.sensing_anon_contributions)    as anon_contributions,
       (select coalesce((select count(*) from public.sensing_published_aggregates), -1)) as published; -- -1 = 3110 absent

-- Q1. Which of the chain is already in the ledger.
select filename, applied_by, applied_at from public.schema_migration_ledger
 where filename ~ '^(2277|2278|3002|3003|3004|3110|3310|3311|3312|3313|3314|3315)_' order by filename;

-- Q2. The catalog, not the ledger: what actually exists.
select to_regclass('public.intel_contributor_pepper')       as pepper,
       to_regclass('public.sensing_published_aggregates')   as published_store,
       (select count(*) from information_schema.columns where table_schema='public' and column_name='input_observation_ids') as provenance_cols, -- 2 after 3311
       (select count(*) from pg_constraint where conname like 'sensing_anon_features_%') as feature_checks,  -- 3 after 3312
       (select is_nullable from information_schema.columns where table_schema='public' and table_name='intel_observations' and column_name='subject_id') as subject_nullable, -- YES after 3002
       (select udt_name from information_schema.columns where table_schema='public' and table_name='memory_projections' and column_name='claim_refs') as claim_refs,        -- _uuid after 3314
       (select data_type from information_schema.columns where table_schema='public' and table_name='sensing_anon_contributions' and column_name='surface_permitted') as surface_col; -- boolean after 3315

-- Q2b. 3314 replaces a function. Before applying it, the live body must be 2195's
-- (whitespace aside); after, its md5 must be c12a0ff3cf71a23373b03f025fb2a938.
select md5(p.prosrc), regexp_replace(p.prosrc, '\s+', ' ', 'g')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'project_user_memory_with_retraction';

-- Q3. Flags the cutover touches. Absent row reads false.
select flag, enabled from public.feature_flags
 where flag in ('intel_capture_quick_signal','intel_trail_followup','media_evidence_enabled',
                'sensing_presence_context_enabled','sensing_publication_enabled',
                'discovery_candidate_projection_enabled','memory_projection','intel_claim_projection_crowd')
 order by flag;
```

Expected on production today: Q0 all 0 and `published = -1`; Q1 zero rows;
Q2 `NULL, NULL, 0, 0, NO, NULL, NULL`; Q2b 2195's body; Q3 the two capture flags `true`, everything else
`false` or absent.

---

## 3. The schema steps

Apply with `scripts/src/apply-migrations.ts` wherever `SUPABASE_URL` /
`SUPABASE_SERVICE_ROLE_KEY` exist, so the ledger row, its sha256 and the
postcondition handling are the runner's. Where the runner cannot run (as on
portava-ci from this container), build the statement with the runner's own
`classifyMigration` / `checksumOf` / `buildApplyStatement` and send it
byte-for-byte — the 2026-09-26 entries in `docs/migrations.md` record exactly
that, including a `body === file` assertion before sending.

| # | File | Window | VERIFY after (read the catalog, not the apply) | Recovery |
|---|---|---|---|---|
| 1 | 2277, 2278 | any time before 2 | their own sections in migrations.md | their own rollbacks |
| 2 | 3002 → 3003 → 3310 | **quiesced** (identity runbook §4 steps 1–4) | identity runbook §6 queries | identity runbook §5a (only while Q0 is all-zero) |
| 3 | 3311 | any time before the code | Q2 `provenance_cols = 2`; both GIN indexes by name | `db/rollback/2026-09-26-3311-intel-snapshot-input-provenance-rollback.sql`, then delete its ledger row |
| 4 | 3312 | any time before the client ships | Q2 `feature_checks = 3`; fifteen nullable columns; 0 FKs; the five negative controls in migrations.md re-run and roll back | `db/rollback/2026-09-26-3312-sensing-anon-contribution-features-rollback.sql`, then the ledger row |
| 5 | 3004, 3110, 3313 | any time before the flips | Q3 shows the seeds `false` **and** Q1 shows their ledger rows. A flag seed creates no table or column, so no schema check can see it, and an absent row reads `false` at runtime exactly as the seed does: only the row plus the ledger row prove it ran (migrations.md, third batch). `published_store` non-NULL | each seed's rollback refuses if the flag was turned on since; 3110's own section |
| 6 | 3314 | any time before `memory_projection` ON; Q2b first | Q2 `claim_refs = _uuid`; the GIN index by name; Q2b md5 as stated | `db/rollback/2026-09-26-3314-memory-projection-claim-refs-rollback.sql` (refuses while any session memory exists), then the ledger row |
| 7 | 3315 | any time before `surface` is granted | Q2 `surface_col = boolean`; `select count(*) … where surface_permitted` = 0 | `db/rollback/2026-09-26-3315-sensing-anon-surface-consent-rollback.sql` (refuses while any row reads true), then the ledger row |

Each file is atomic with its ledger row; a raised postcondition rolls the whole
file back and leaves no row. Stop at the first failure and diagnose with the
window closed.

---

## 4. The code deploy

Identity runbook §4 steps 5–8, unchanged: deploy inside the quiesced window,
smoke read-only, un-quiesce by restoring exactly the pre-window flag values,
then VERIFY REALIZED — the first real capture must land with a non-null
contributor token. Until one does the cutover is *deployed*, not
*production-verified*.

Additional smoke for this branch, all read-only, all expected to be quiet:

- the api-server log shows `SensingPublicationScheduler scheduled` and, eleven
  minutes later, `sensing publication pass` with `reason: surface_scope_not_granted`
  — the publisher is alive and refusing on its FIRST gate;
- no `intel.projection.provenance_unavailable` line (3311 preceded the code);
- `POST /v1/sensing/contributions` answers the pepper refusal until
  `SENSING_CONTRIBUTOR_PEPPER` is configured (S18/S32);
- `POST /v1/sensing/session` answers the same pepper refusal until then, and
  after it, for every signed-in account, `403 disclosure_does_not_cover_passive_sensing`:
  every consent recorded today is v1, which covers no passive sensing. The
  installed client does not start its capture loop under v1 either.

---

## 5. Activation — each an owner act, each with its prerequisites, verification and recovery

None of these is executed by this runbook and none is implied by the steps
above. Every one changes what a user can see and is the owner's to take. They
are listed so that when a decision is taken, the action is one step and its
recovery is one step.

| Requirement | Act | Prerequisites | Verify (read-only) | Recover |
|---|---|---|---|---|
| S49 | `update feature_flags set enabled=true where flag='discovery_candidate_projection_enabled'` | 2361 seeded (present); nothing schema-side on this branch | a `DiscoveryCandidate` is served with `coverage` populated by the §24 protected-zone pass (`src/test/mapDiscoveryCandidateConsumer.test.ts` is the controlled form) | set it back to `false` |
| S92 | `… flag='memory_projection'`, and `… flag='experience_session_enabled'` (2841) so that sessions exist to be judged | the memory kernel's tables (2320 etc.) applied — a memory-lane decision, not a sensing one; **2841 applied** (on portava-ci since CI; absent on production, read 2026-09-26) | `memoryProjectionScheduler` stops answering `disabled` (its own log line) | set it back to `false`; the sweep expires what was projected |
| S112 (memory stage) | same two flags as S92. The persisting lane is built: closing a session writes the memory with its `claim_refs` (3314), the reach enumerates memories by overlap, and the erasure prunes withdrawn refs | 3314 applied (§3 step 6); the SNAPSHOT stage needs nothing (§1) | after an erasure the deletion log shows `recompute_intel_snapshots_after_erase` and then `prune_memory_lineage_after_erase` with `pruned`/`refsRemoved` counts and no failures | none needed; both steps are idempotent per erasure |
| S39 · S24 | (0) put consent v2 in force: the owner approves the text in `docs/contracts/sensing-consent-disclosure-v2.md`, and one release ships `INTEL_CONSENT_DISCLOSURE_VERSION = "sensing_contributions_v2"` with a client carrying that text; people then grant it one by one. (a) grant `surface` — a ONE-LINE change to `SENSING_ANON_GRANTED_SCOPES` in `lib/sensingContributionPolicy.ts`, reviewed and deployed; then (b) `flag='sensing_publication_enabled'` (3313); then (c) `flag='sensing_presence_context_enabled'` (3004) | 3110, 3313, 3004, 3315 applied; the pepper configured; at least k contributors per cohort holding v2 consent | (b): `sensing publication pass` logs `published > 0` and `sensing_published_aggregates` gains rows with **no contributor column**; (c): a Compass turn that sends `sensingZoneIds` gets the `[Zone presence …]` header — observed/unknown only | (c) then (b) back to `false` — the producer renders nothing the same instant; (a) is a code revert |
| S18 · S32 | configure `SENSING_CONTRIBUTOR_PEPPER` in production | 3002 applied (the pepper the DATABASE holds is a different secret: this env value is the ingest's, per `routes/sensingIngest.ts` header) | the ingest stops refusing with the pepper reason | unset it — the ingest refuses again |
| S17 | outside every tool here: `curl -sI https://portava.replit.app` from an origin the proxy does not block; Supabase's at-rest attestation | the Replit publish currently reads `failed` (`get_publish_status` 2026-09-26) and must be republished first | HSTS and TLS in the served headers | — |

**The order among the S39 acts is load-bearing and checked in code:** the
publisher and the producer both test the scope BEFORE reading their flag, so
(b) or (c) taken before (a) does nothing, and the suites go red if that order
is ever reversed (`sensingPublicationScheduler.test.ts` "the DEFAULT policy
refuses BEFORE any client exists").

**And (a) without (0) surfaces nothing.** The policy is the owner's ruling on
what the store may do; it cannot establish what anyone agreed to. A session
carries the intersection of the policy and its holder's recorded consent, each
contribution records `surface_permitted` from its own session, and the
publisher counts only rows where it is true. Under v1 consent that is no row.

---

## 6. Recovery, per stage

| Stage failed | Action |
|---|---|
| A schema file raised | It rolled itself back with no ledger row. Earlier files stand (each is independently consistent). Diagnose with the window closed. |
| Code deploy failed with 3002 applied | **Do not un-quiesce** (identity runbook §5). Roll forward or roll the identity schema back with its §5a — only while Q0 is all-zero. |
| 3311 / 3312 need to come out | Their rollback files, then delete the ledger row. Both tables were empty at every apply so far; 3311's column drop discards provenance only, never a snapshot; 3312's drops feature columns only, never a contribution. |
| A flag flip was wrong | Set it back. Every flag here is a capability (`*_enabled`, fail-closed); the producer, publisher and schedulers re-read on their next call or tick. |
| `surface` was granted and must not have been | Revert the one-line policy change and deploy; the publisher and producer refuse on the next call. Rows already in `sensing_published_aggregates` carry no identity and expire within 24 h (3110 TTL, swept by the retention scheduler); to remove them at once: `delete from public.sensing_published_aggregates`. |

---

## 7. What the rehearsal proved, and what it did not

**Proved, on portava-ci:** 3004, 3110, 3002, 3003, 3310, 3311, 3312, 3313, 3314 and 3315 apply
cleanly in the stated order against a database in production's shape; every
postcondition passed; each object was read back from the catalog; five
negative controls on 3312's CHECKs refused and two positive controls accepted
(all rolled back); the ledger records each with the file's sha256; the branch's
suites that exercise the new columns pass against fakes (the live-DB CI job
exercises `check:write-path-columns` against portava-ci's real schema on PR #528).

**Not proved:**

- 3313, 3314 and 3315 are applied on portava-ci only (third batch); none has
  run on production.
- No contribution has been written through the new code against any database,
  so nothing here is production-verified, and S26/S66's "the census working"
  rows remain launch-capped for that reason (census-sensing §23, §26).
- The identity rollback (§5a of the identity runbook) has never been executed.
- Production has not been touched, read-only reads excepted.
