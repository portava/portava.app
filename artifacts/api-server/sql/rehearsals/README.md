# Story retention rehearsal (migration 2998)

Decision 4/7, 2026-09-22: destructive cleanup is rehearsed on controlled fixtures
before it is trusted anywhere else. These three files are that rehearsal. They run
against a throwaway Postgres — never against production, never against the CI
project — and they assert the resulting STATE, with a negative case in each file
proving the guard can fail.

```bash
initdb -D /tmp/rehearse -U postgres --auth=trust        # as a non-root user
pg_ctl -D /tmp/rehearse -o "-p 55432 -k /tmp/rehearse -c listen_addresses=''" start
PSQL="psql -h /tmp/rehearse -p 55432 -U postgres -v ON_ERROR_STOP=1"

$PSQL -f sql/rehearsals/2998_00_fixture.sql             # the schema subset 2998 touches
$PSQL -c "CREATE TABLE IF NOT EXISTS job_health (job text PRIMARY KEY, last_run_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());"
$PSQL -f src/migrations/2998_story_retention.sql        # the migration, postconditions and all
$PSQL -f src/migrations/2998_story_retention.sql        # again: it must be idempotent
$PSQL -f sql/rehearsals/2998_01_deleted_at_freeze.sql
$PSQL -f sql/rehearsals/2998_02_destructive_purge.sql
```

Every `RAISE NOTICE` line beginning `T<n> pass` or `R<n> pass` is an assertion that
held. A failure raises and, with `ON_ERROR_STOP`, stops the run — so a silent pass
is not available.

What each file establishes, measured 2026-09-22:

**2998_01 — the recovery clock cannot be reset.** A delete starts it; a repeat
delete does not move it, even when the statement explicitly names a new time; a
recovery clears it; a genuinely new deletion starts a fresh one. **T5 drops the
trigger and repeats the repeat-delete case, requiring that the clock DOES move** —
without it, the first four assertions would pass just as well against a table with
no guard at all.

**2998_02 — the purge destroys what it should and keeps what the retry needs.**
The story row goes; viewers, reactions and replies cascade with it; and the ledger
entry survives, still naming the storage object. **R4 adds a cascading foreign key
and repeats the case, requiring that the ledger IS destroyed** — which is what makes
R3 evidence about the missing FK rather than a coincidence of the fixture.

The storage half of the purge is not rehearsed here, because these files have no
object store. It is covered in `src/test/storyRetention.test.ts`, where a
`remove()` that resolves cleanly and deletes nothing must NOT be recorded as a
deletion.

## 2998_03_chain_behaviour.sql — the rehearsal on production's real schema

`2998_00`–`2998_02` run against a hand-written fixture. That is fast and it
isolates the rule under test, and it is also the reason it cannot answer the
question that matters at deploy time: does this behave the same way on the table
production actually has?

`2998_03` runs against the database `scripts/local-db/up.sh` builds —
`baseline/20260819_baseline_structure.sql` (production's structure, no rows)
plus the whole migration chain replayed in order, 2998 included in its own
place. Every constraint, default, index, enum and cascade is the real one.

Two things it caught that the fixture could not:

- `profiles.name` is NOT NULL, so a story's owner cannot be conjured with an id
  and a handle.
- `stories.state` is the enum `story_state`, not text. The fixture declares it
  as text, so a `state` value the enum does not contain would pass there and be
  rejected in production.

What it checks:

- **A1–A4** the freeze trigger on the real table: a delete starts the clock, a
  repeat delete cannot move it *even when the writer names a new value*,
  recovery clears it without the route mentioning the column, and a delete after
  a recovery is a new deletion with its own clock.
- **A5** the negative control for A1–A4. With the trigger disabled the clock
  stays null — so those four measured the trigger and not some other writer.
- **B1–B2** the SELECT `enqueueDueStories` actually issues, including the
  archive-deadline disjunct that stops a delete/recover cycle holding a story
  past its cap.
- **B3** the negative control for B2. Drop the disjunct — the exact regression a
  later edit would make — and the capped row is missed.
- **C1** the ledger survives the story row being deleted. The queue carries no
  foreign key by design; on the real schema, where `stories` has cascading
  children, a FK added later would destroy the object path and orphan the file
  forever.
- **C2** an entry cannot record both a deletion and a retention.

Everything runs inside a transaction that ends in `ROLLBACK`, so the database is
reusable and no check can leave state for the next one to trip over.

Run it:

```
bash scripts/local-db/up.sh
psql -X -v ON_ERROR_STOP=1 \
  "postgresql://postgres@127.0.0.1:54329/portava_local" \
  -f sql/rehearsals/2998_03_chain_behaviour.sql
```

**What this does NOT establish.** That the hourly scheduler runs in a deployed
process, that `job_health` records its attempts and successes, or that the purge
reaches Supabase Storage. The service talks PostgREST and the Storage API, and
neither exists on this database. Those are the post-deployment checks, and they
stay unverified until then rather than being inferred from this.

## 3674-3676 — the memory graph model (2026-10-10, lane H band)

Decision: `docs/architecture/memories-graph-model-decision.md`. Rehearsed on a full-chain
replica (PGlite, PG 18, the chain `scripts/local-db/up.sh` applies), never on a real database:

```bash
$PSQL -f sql/rehearsals/3674_00_seed.sql                  # BEFORE 3674: rows that must read LEGACY_IMPORTED
$PSQL -f src/migrations/3674_memory_graph_model.sql
$PSQL -f src/migrations/3675_memory_graph_backfill.sql
$PSQL -f src/migrations/3676_memory_graph_kernel.sql
$PSQL -f sql/rehearsals/3674_01_memory_graph_behaviour.sql
```

Measured 2026-10-10, every block passing:

- **S1** a row inserted after 3674 is `USER_CREATED`; the seeded rows read `LEGACY_IMPORTED` with `updated_at` untouched.
- **S2** consent: a pending tag is no edge; approving makes one; withdrawing or deleting the tag removes it.
- **S3 / S4** a PATCH re-mirrors; a soft delete drops the legacy edges.
- **S5** merge refusals, each audited and none writing an event or deleting a row:
  - an audience mismatch (in both directions);
  - another person's Memory;
  - `trip_crew` of two trips;
  - a draft into a published Memory;
  - the survivor among the absorbed;
  - a deleted absorbed Memory;
  - a malformed payload.
- **S6** a merge:
  - items are appended and keep their visibility;
  - the absorbed Memory is soft-deleted, with a redirect;
  - tags take the least consent;
  - likes are deduplicated, saves moved and controls unioned;
  - the candidate link is re-pointed;
  - one event is written, with no content in its payload.
- **S7 / S8** a replay returns the original; a reused key is refused.
- **S9 / S10** a split:
  - the new Memory has the source's audience, place and `location_precision`, so it is never widened to the column's `exact` default;
  - no person is copied;
  - negative place constraints and controls carry over;
  - a lineage edge is written, with events on both streams;
  - splitting every item, or another Memory's item, is refused.
- **S11** a merge back: earlier redirects are re-pointed (one hop), and every item is accounted for.
- **S13** an episode's relations go with it.
- **S16** (VERIFY-MG MG-F2):
  - allow-list and hide-list audience differences are refused, in both directions;
  - the same allow-list SET merges;
  - a person tagged on two absorbed Memories takes the least consent;
  - a seeded `removed` Memory has no edge.
- **S6** also covers MG-F1: collection entries follow the content, one per collection, with the earliest kept.
- **S15** also refuses a moderation removal whose edges cannot be removed.
- **S14** the mirror's INSERT failing (sabotaged by a trigger) never fails the legacy write. A consent withdrawal and a soft delete still remove the edge.
- **S15** the removal half is never swallowed: a soft delete whose edges cannot be removed is REFUSED whole.
- **S12** account deletion, done the way AccountDeletionService does it:
  - tags are deleted by `tagged_user_id`, so the deleted person is named by no edge;
  - the owner's Memories are hard-deleted while the profiles tombstone is kept, and no relation or redirect is left. That needs no `profiles` cascade, which never fires in production.
- **Rollbacks**: 3676, then 3675, then 3674 succeed on that state. 3674's rollback REFUSES while a redirect exists. Every migration re-applies cleanly twice, and a second backfill pass changes nothing.

A negative control was run: one expectation was flipped on purpose, and the run then failed at exactly that block.
**23 of 23 SQL mutants were killed** (the 18 below, the verifier's three survivors, and two MG-F1 mutants) by this file, together with 3675's postcondition. Each mutant changed one of these:
- the audience rule;
- least consent;
- the precision copy on split;
- tag copy on split;
- pending-tag import;
- the withdrawal removal;
- the hard-delete erasure;
- path compression;
- the evidence re-point;
- the absorbed soft delete;
- the mirror's confidence;
- the 3674 rollback refusal;
- split emptying the source;
- another Memory's item;
- the owner check;
- the control union;
- the correction carry-over;
- the soft-delete removal.

## 3803-3804 — MemoryType and the occurrence-time place name (2026-10-14, B58 MEM-CANON)

Census-highlights-memories §BH (H40, H71). Rehearsed on PGlite over a fixture of exactly the objects the files touch
(roles, `auth.users`, `feature_flags`, `schema_migration_ledger`, `places` as 2028 declares it, `memories` as
0067 + 0148 + 2338 declare it), never on a real database. The full chain runs the same SQL in CI's local-db job
(`src/test/db/memoryCanonicalFields.db.test.ts`).

```bash
$PSQL -f sql/rehearsals/3803_00_seed.sql                   # BEFORE 3803: rows that must read NULL afterwards
$PSQL -f src/migrations/3803_memory_type.sql
$PSQL -f src/migrations/3804_memory_place_occurrence_name.sql
$PSQL -f sql/rehearsals/3803_01_memory_canonical_fields.sql
```

Measured 2026-10-14, 24 of 24 steps passing: apply and re-apply of both files; each `$post$` and 3804's `$pre$` run
alone (the live applier's split-session shape); T1–T11; then both rollbacks REFUSING (a TRIP row; flag ON; names
present), succeeding once cleared, re-running as no-ops, and both files re-applying.

- **T1** rows that existed before are NULL on both columns, `updated_at` untouched.
- **T2** a new untyped Memory is MOMENT; a chosen type holds; VACATION is refused; a type may be cleared.
- **T3** a catalog place records its name at the write; a later rename and merge leave the Memory's text alone.
- **T4** a provider pick keeps the writer's trimmed text; no text is NULL; a blank place carries no name.
- **T5** a writer's text on INSERT (3676's split copy) is kept, not replaced by today's catalog name.
- **T6** the same place never rewrites its text; a NULL text takes exactly one first capture.
- **T7** a new catalog place gets its name; a new pick without text is NULL; the old text echoed for a new place is not kept.
- **T8** clearing the place clears its name. **T9** a same-value `place_id` UPDATE (2711's shape) never backfills.
- **T10** no client role can execute the trigger function.
- **T11** negative control: with the trigger disabled the rewrite lands and untrimmed text is refused by the CHECK.

**11 of 11 SQL mutants killed**: the same-place rule dropped, the old-text carry-over, a catalog backfill on a first
capture, the no-place rule dropped, the catalog overriding a writer's text, EXECUTE granted, a stored default on
`memory_type`, the MOMENT default dropped, a fourteenth type, the trigger's column list narrowed, and a default on the
name column.

## 3810 — the owner's §10 person ceiling and the effective-policy view (2026-10-14, B58 MEM-POLICY)

Census-highlights-memories §BN (H33). Rehearsed on PGlite over a fixture of exactly the objects the file touches
(`anon` / `authenticated` / `service_role` with BYPASSRLS, `auth.users`, Supabase's default privileges granting a new
public table or view to the client roles, `schema_migration_ledger`, and `memories` as the 2026-08-19 baseline declares
it plus 2338's `location_precision`, with its client grants and RLS on), never on a real database. The full chain runs
the same SQL in CI's local-db job (`src/test/db/memoryVisibilityPolicies.db.test.ts`).

```bash
$PSQL -f sql/rehearsals/3810_00_seed.sql                   # BEFORE 3810: Memories that must show no ceiling afterwards
$PSQL -f src/migrations/3810_memory_visibility_policies.sql
$PSQL -f sql/rehearsals/3810_01_memory_visibility_policies.sql
```

Measured 2026-10-14, 15 of 15 steps passing: apply and re-apply; `$pre$` and `$post$` run alone (the live applier's
split-session shape); T1–T9; then the rollback REFUSING while a ceiling stands (and changing nothing), succeeding once
cleared (both relations and the ledger row gone), re-running as a no-op, and the file re-applying twice.

- **T1** the Memories that existed before are in the view with no ceiling, unrewritten; 3810 wrote no row.
- **T2** one ceiling per Memory; an off-ladder, a lower-case and a NULL ceiling are refused, and so is a Memory that does not exist; an upsert replaces.
- **T3** the view is a join, not a copy: a change to `memories` is the view's change; the same owner's other Memory does not inherit the ceiling; one view row per Memory; the table carries no audience or precision column.
- **T4** the ceiling goes with its Memory and with its owner's account.
- **T5** `anon` and `authenticated` reach neither relation, to read or to write.
- **T6** `service_role` sets, changes and clears a ceiling and reads it through the view; the view is not writable.
- **T7** security_invoker: a role granted the view but not `memories` is refused. Negative control: with security_invoker off, the same role reads past `memories`.
- **T8** 3813's predicate finds no client-readable view over `memories`. Negative control: grant the view to `anon` and the predicate names it.
- **T9** leaves one ceiling standing for the rollback to refuse.

**20 of 20 SQL mutants killed**: either cascade dropped, either REVOKE dropped, the view's REVOKE leaving `authenticated`,
security_invoker off, RLS off, a sixth rung, the CHECK dropped, a nullable ceiling, no primary key, a copied `visibility`
column, a view reading no audience, `service_role` without DELETE, a writable view, the rollback without its refusal, its
check planned whole (fails on a second run), its view left behind, an inner join, and a join on the owner.
