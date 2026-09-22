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
