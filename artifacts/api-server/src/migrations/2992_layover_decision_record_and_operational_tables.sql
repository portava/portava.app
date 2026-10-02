-- 2992_layover_decision_record_and_operational_tables.sql
--
-- THE FIVE §4 TABLES THAT EXIST NOWHERE, AND THE FIVE §20 LEDGER COLUMNS THAT
-- `layoverLedger.ts` ALREADY NAMES AND CANNOT WRITE.
--
-- Lane 2992 (layover). Creates FIVE new tables and adds FIVE columns to
-- `layover_certified_computations`. It UPDATEs no row, DELETEs no row, drops
-- nothing, and changes no existing column's type, nullability or default.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE PREFIX, AND WHY IT IS 2992 AND NOT THE NUMBER THIS LANE WAS FIRST GIVEN
-- ══════════════════════════════════════════════════════════════════════════════
-- This file was first written as `3003_`, the number the lane was assigned.
-- THAT NUMBER IS NOT LEGAL IN THIS CHAIN. `src/scripts/migrationPrefixRules.ts`
-- declares `NEW_NUMERIC_PREFIX_RE = /^2[1-9]\d{2}_/` — a NEW 4-digit canonical
-- prefix must be 2100-2999 — so that a 4-digit prefix can never be confused
-- with an 8-digit YYYYMMDD prefix under the plain lexicographic ordering this
-- chain applies in. `check:migration-prefixes` rejected `3003_` outright:
--
--     prefix 3003 is >= 2100 but outside the required 2100-2999 range
--
-- The band was NOT widened to accommodate the filename. That rule lives in a
-- file this lane does not own, and loosening a guard so that a name fits is the
-- exact shape this repository's ratchets exist to refuse — so the guard stood
-- and the number moved. 2992 was free and was reserved to this lane.
--
-- Nothing in the SQL below is prefix-dependent; the rename touched this header,
-- every `(2992)` in the pre/postcondition messages, and the migration's name in
-- `src/test/layoverDecisionLedger.test.ts`. There is no `3003_` file left
-- behind — the rename was a `git mv`, not a copy.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY
-- ══════════════════════════════════════════════════════════════════════════════
-- census-layover §27.7 partitions the 94 NOT-BUILT rows and files FIFTY-ONE of
-- them under "(b) blocked on a migration no database has". This migration is
-- the storage half of that bucket for everything except the crew tables (2984,
-- applied) and the snapshot-identity column set (below).
--
-- Rows whose STATED blocker is one of these five tables, verbatim from the
-- census body:
--
--   L22  `layover_constraints`   "No such table."
--   L23  `layover_time_budgets`  "No writer, no table."
--   L24  `layover_return_plans`  "None of the six fields exists."
--   L30  `layover_checkpoints`   "Absent. No checkpoint is ever observed or recorded."
--   L32  `layover_outcomes`      "Absent, and unreachable in principle."
--   L173 `recordCheckpoint`      "(L30)"
--   L193 "Create constraints, snapshots, time budgets and return plans" —
--        "None of the four exists (L22-L25)."
--
-- and rows whose blocker is the §20 DECISION RECORD having nowhere to go:
--
--   L95  "Create a new immutable snapshot"                 "(L25)"
--   L190 `LayoverDecisionService.diff(prev, next)`         "No snapshots."
--   L209 metric `layover_sessions_evaluated`               "Nothing is certified to count."
--   L261 "immutable snapshots with bounded retention"      "(L25)"
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS MIGRATION DOES **NOT** CREATE, AND WHY THAT IS THE POINT
-- ══════════════════════════════════════════════════════════════════════════════
-- THERE IS NO `layover_snapshots` TABLE HERE. That is deliberate and it is the
-- single most important decision in this file.
--
-- The spec's §4 `layover_snapshots` (L25: version, input_hash, computed_at,
-- engine_version, safe_envelope_ref, candidate_set_version, sources_json,
-- reason_codes_json) is ALREADY BUILT, as `layover_certified_computations`
-- (migration 2700, written, UNAPPLIED). That table carries engine_version,
-- feasibility_version, input_hash, computed_at, verdict, confidence, the
-- deadline, the buffer total, usable_minutes and the full named input set, and
-- `services/airport/LayoverFeasibility.ts` produces exactly one such record per
-- session per instant with `replayFeasibility(record.inputs)` reproducing it
-- deep-equal.
--
-- Creating a SECOND snapshot table beside it would be the defect this census
-- has scored `W` more than any other: two surfaces owning one answer (L1 "one
-- canonical operational truth", L2 "no other surface owns feasibility"). A
-- second table is worse than a second function, because a row outlives the
-- request that wrote it and a consumer cannot tell which of the two is the one
-- that certified the card in their hand.
--
-- So this migration COMPLETES 2700's table instead of forking it, with the five
-- columns `services/airport/layoverLedger.ts` already declares it needs. That
-- module exports them as `LEDGER_MISSING_COLUMNS`, each with the DDL and the
-- reason; the five ALTERs below are those five DDL strings, and
-- `src/test/layoverDecisionLedger.test.ts` asserts this file contains each one
-- so the two cannot drift.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT `snapshot_id` MAKES POSSIBLE, AND WHY IT IS A REAL COLUMN
-- ══════════════════════════════════════════════════════════════════════════════
-- `snapshotIdFor(sessionId, inputHash)` (layoverLedger.ts) is already the
-- ledger's identity and is already what `LayoverSnapshot.snapshotId` publishes
-- to every consuming lane. It has never been storable.
--
-- With the column and its unique index, the snapshot-scoped tables below can
-- REFERENCE a computation rather than copy it, which is what Appendix C5 / L296
-- asks for: *"Never certify a recommendation against a snapshot other than the
-- one returned with it."* A `snapshot_id TEXT` foreign key is a join, and §4's
-- implementation rule says a field a join touches is a typed column and never
-- JSON.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- IMMUTABILITY IS A TRIGGER, NOT A COMMENT
-- ══════════════════════════════════════════════════════════════════════════════
-- L95 asks for an IMMUTABLE snapshot and L261 for immutable snapshots with
-- bounded retention. 2700's header answers the first with grants — no client
-- write verb exists — and `assertSnapshotImmutable` answers it again in the
-- service. Neither covers the case that actually happens: the SERVICE ROLE,
-- which bypasses RLS, issuing an UPDATE.
--
-- So the three snapshot-scoped tables below carry a BEFORE UPDATE trigger that
-- raises. Immutability that only holds for callers who were never able to write
-- anyway is not immutability; it is a description of the grant table.
--
-- DELETE IS NOT BLOCKED, deliberately. L261's "bounded retention/compaction"
-- requires rows to LEAVE. `compactLedger` (layoverLedger.ts) already decides
-- which — retention days, max-per-session, and an unconditional keep of the
-- newest entry per session so a compaction can never leave a traveller unable
-- to ask what they were told. Blocking DELETE would make that policy
-- unimplementable. UPDATE is the operation that rewrites history; DELETE is the
-- operation that ends it, and only the first is a lie.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WRITE BOUNDARY — THE FIVE NEW TABLES ARE SERVER-MEDIATED, NO CLIENT GRANT
-- ══════════════════════════════════════════════════════════════════════════════
-- Same decision as 2984 and 2860, taken for the same reason and restated rather
-- than inherited. census L201 records what happened the last time a layover
-- table shipped with its write half implicit: `layover_recommendations` carried
-- `FOR ALL ... USING` with no `WITH CHECK`, PostgreSQL reused USING as the
-- write check, and a session owner could write their own certified safety
-- fields. Certification fields a traveller can write are not certification.
--
-- RLS enabled, NO POLICY OF ANY KIND, every grant revoked from `anon` and
-- `authenticated`. With RLS on and no policy a client reaches nothing; the
-- service role bypasses RLS, which is how the routes read and write.
--
-- That costs this tree nothing and it was checked rather than assumed:
-- `travel-buddy-standalone/src/services/layover.ts` opens with "All calls go
-- through the API server (no direct Supabase from client for layover data)".
--
-- `layover_certified_computations` KEEPS the owner-read policy 2700 gives it.
-- This migration adds columns to that table and changes none of its policies or
-- grants; the postconditions assert both, so a later edit has to argue.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- NO COORDINATES, ANYWHERE — INCLUDING ON A CHECKPOINT
-- ══════════════════════════════════════════════════════════════════════════════
-- A checkpoint is the most tempting place in this schema to put a position: it
-- is literally "the traveller was here at this time". It gets none.
--
-- §14's map element "Crew member" is gated on "only with explicit temporary
-- location permission" (L124), and the precision ladder that would govern it
-- (`LOCATION_PRECISIONS`, `evaluateCrewLocationShare`) is built and has NO
-- GRANT STORE (census §28.2). L8 is one of this census's few `C` rows, and the
-- concrete artifact behind it is that layover presence STRUCTURALLY cannot
-- carry a coordinate. A `lat`/`lng` on `layover_checkpoints` would end that
-- property for a row type that is, by construction, a movement trace.
--
-- So a checkpoint names a PLACE KIND, not a place: SECURITY, IMMIGRATION,
-- CUSTOMS, GATE, LOUNGE, LANDSIDE_EXIT, AIRPORT_REENTRY, BOARDING. That is
-- enough for L43 (*"checkpoint confirms re-entry"*) and for L159's "short-lived
-- operational" retention, and it is not a track. The postconditions assert the
-- absence of every coordinate spelling, on all five tables.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- EXPIRY IS A FILTER, NOT A RETENTION PROMISE
-- ══════════════════════════════════════════════════════════════════════════════
-- `layover_checkpoints.expires_at` exists because L158/L159 ask for
-- short-lived, session-scoped operational data. THERE IS NO SWEEPER. There is
-- no scheduler in this tree at all (census L196), and this lane is explicitly
-- forbidden from building one.
--
-- So the column is what 2984 made `layover_crews.expires_at`: every read in
-- `services/layover/` is bounded by `expires_at > now()`, so an unswept
-- checkpoint is INVISIBLE rather than stale-but-live. The row survives until
-- something deletes it. That is honest and it is not retention. L158/L159 do
-- not close on this migration and `docs/BUILD-BACKLOG.md` should say so.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- PRESERVING USER DATA — WHAT THE FIVE ALTERS DO TO EXISTING ROWS
-- ══════════════════════════════════════════════════════════════════════════════
-- Nothing. Stated precisely rather than promised:
--
--   * All five are `ADD COLUMN IF NOT EXISTS`. None drops, renames, retypes or
--     re-nulls an existing column.
--   * Three carry a NOT NULL with a CONSTANT default ('[]'::jsonb, '{}'). Since
--     PostgreSQL 11 a constant default is stored in the catalog and does NOT
--     rewrite the heap, so no existing row is touched on disk. The other two
--     are plain nullable TEXT.
--   * `layover_certified_computations` has NO WRITER on this tree (verified:
--     `ledgerRowFor` had exactly one caller before this branch and it was a
--     test), so the table is empty on every database that has 2700 and the
--     question is moot in practice as well as in principle. The migration does
--     not rely on that.
--   * The unique index on `snapshot_id` is created over that empty table. On a
--     database where it is somehow NOT empty the index build would fail on a
--     duplicate rather than silently pick a winner, which is the correct
--     failure: two rows cannot share one snapshot identity.
--   * NO UPDATE AND NO DELETE appears anywhere below, and no backfill of any
--     kind: the existing production `layover_recommendations` rows were
--     produced by engine versions that predate the record, and minting a
--     snapshot id for them would fabricate a computation that never happened.
--   * The ONE INSERT is a new `feature_flags` row, seeded FALSE, with
--     `ON CONFLICT (flag) DO NOTHING`. It creates a row where there was none
--     and can never change one that exists — so an operator who has already
--     turned the gate on does not have it turned off under them by a re-run.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THE FLAG IS SEEDED, HAVING FIRST BEEN LEFT UNSEEDED
-- ══════════════════════════════════════════════════════════════════════════════
-- The first draft of this file seeded nothing, reasoning that `isFlagEnabled`
-- reads an ABSENT row as FALSE (`src/lib/featureFlags.ts`) so the gate is
-- already closed and a row would be redundant.
--
-- `check:flag-polarity` REFUSED THAT, and its argument is better:
--
--   > PHANTOM FLAG — READ BUT NEVER SEEDED … There is no row for it, so the
--   > read resolves to nothing … false, forever, UN-FLIPPABLE. The gate LOOKS
--   > deliberate and is not. It cannot be turned on without shipping a
--   > migration first.
--
-- A closed gate and an unreachable gate are not the same object. Step 5 of the
-- deployment sequence below says "flip the flag", and without a row there is
-- nothing to flip: an operator would have to INSERT one by hand, which is a
-- direct write that `toggle_feature_flag_with_audit` never sees and that leaves
-- no audit row. That is the same defect census L269 records against 2971 from
-- the other side — a gate whose row does not exist in production, so the
-- surface behind it cannot be turned on at all.
--
-- Seeding it FALSE keeps the behaviour identical (an absent row and a FALSE row
-- both read false) and makes the audited toggle path reachable. It follows
-- 2971's own convention exactly, including `ON CONFLICT (flag) DO NOTHING`.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- APPLY ORDER — 2700 FIRST, AND THIS FILE REFUSES OTHERWISE
-- ══════════════════════════════════════════════════════════════════════════════
-- Depends on 0127 (`layover_sessions`) and on 2700
-- (`layover_certified_computations`). 2700 is UNAPPLIED in production as of
-- `src/lib/capability/production-applied-migrations.json`.
--
-- The precondition block below RAISES if either is missing, rather than
-- creating the table itself. Recreating 2700's table from here would fork the
-- definition of the one object this whole design turns on.
--
-- INDEPENDENT of 2971 / 2982 / 2983 / 2984 / 2985. No co-toucher: the only
-- existing object it modifies is `layover_certified_computations`, which no
-- other unapplied migration touches (checked at this commit: `grep -l
-- layover_certified_computations src/migrations/` returns 2700 and this file).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- DEPLOYMENT SEQUENCE — DO NOT DEVIATE
-- ══════════════════════════════════════════════════════════════════════════════
--   1. Apply 2700 to the target. Confirm ITS postconditions pass.
--   2. Apply this file inside its own BEGIN ... COMMIT (it is one below).
--      Confirm the postcondition block prints no exception.
--   3. Re-probe, do not assume: the five new tables exist, RLS is on for each,
--      `pg_policies` returns ZERO rows for the five, and
--      `information_schema.column_privileges` returns ZERO rows for
--      anon/authenticated on the five. Confirm
--      `layover_certified_computations` still has exactly its ONE 2700 policy
--      and still grants SELECT (and only SELECT) to authenticated.
--   4. Record both in `src/lib/capability/production-applied-migrations.json`
--      and write a `schema_migration_ledger` row for each.
--   5. ONLY THEN flip `layover_decision_persistence_enabled` to TRUE. The
--      writer names every column added here; on a database that has not run
--      steps 1-2 supabase-js sends the whole payload and the INSERT fails
--      outright. That is the hazard 2700's own header records and 2410 gates
--      behind a flag, and it is why the flag is read rather than assumed.
--   6. Watch `layover_sessions_evaluated` (L209) go from unmeasurable to a
--      number before believing any of it.
--
-- THIS LANE APPLIED NOTHING. No database was contacted while writing this file.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- REVERSIBLE BY
-- ══════════════════════════════════════════════════════════════════════════════
-- TURN THE GATE OFF FIRST, AND CONFIRM IT, BEFORE ANYTHING ELSE HERE RUNS.
-- Dropping the tables under a writer that is still enabled makes every
-- `GET /:id/safety` take the `write_failed` path; the traveller still gets
-- their deadline (there is a test for exactly that), but the log fills with
-- failures that look like an outage and are a rollback in progress.
--
--   UPDATE public.feature_flags SET enabled = FALSE
--    WHERE flag = 'layover_decision_persistence_enabled';
--   -- …then confirm no process is still mid-request, and only then:
--
--   DROP TABLE IF EXISTS public.layover_outcomes;
--   DROP TABLE IF EXISTS public.layover_checkpoints;
--   DROP TABLE IF EXISTS public.layover_return_plans;
--   DROP TABLE IF EXISTS public.layover_time_budgets;
--   DROP TABLE IF EXISTS public.layover_constraints;
--   DROP FUNCTION IF EXISTS public.layover_snapshot_rows_are_immutable();
--   DROP INDEX IF EXISTS public.layover_certcomp_snapshot_uidx;
--   ALTER TABLE public.layover_certified_computations
--     DROP COLUMN IF EXISTS snapshot_id,
--     DROP COLUMN IF EXISTS input_facts,
--     DROP COLUMN IF EXISTS source_refs,
--     DROP COLUMN IF EXISTS rules_applied,
--     DROP COLUMN IF EXISTS ledger_version;
--
--   -- The flag row itself is left in place, disabled. Deleting it would
--   -- recreate the PHANTOM FLAG `check:flag-polarity` refuses (a read with no
--   -- row), and a disabled row costs nothing.
--
-- THE ROLLBACK LOSES DATA AND SAYS SO: dropping the five tables destroys every
-- constraint set, time budget, return plan, checkpoint and outcome written
-- since the flag was flipped. Nothing else in the schema references them, so
-- the loss is bounded to rows this migration made possible in the first place.
-- Dropping the five columns loses every decision record's provenance
-- (input_facts, source_refs, rules_applied) while leaving the computations
-- themselves intact.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.layover_sessions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2992): public.layover_sessions does not exist. Apply 0127_layover_system.sql first.';
  END IF;
  IF to_regclass('public.layover_certified_computations') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2992): public.layover_certified_computations does not exist. Apply 2700_layover_certified_feasibility.sql FIRST -- this migration completes that table rather than forking it, and creating it here would fork the definition of the one object the whole design turns on.';
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 1 — the five §20 columns `layoverLedger.ts` already names
-- ═════════════════════════════════════════════════════════════════════════════
-- Each statement below is the `ddl` string of the matching entry in
-- `LEDGER_MISSING_COLUMNS` (services/airport/layoverLedger.ts), reproduced so
-- the module and the migration cannot drift. A test asserts the containment.

-- snapshotId: a stored recommendation must be able to CITE the computation that
-- certified it (Appendix C5 / census L296).
ALTER TABLE layover_certified_computations ADD COLUMN IF NOT EXISTS snapshot_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS layover_certcomp_snapshot_uidx
  ON layover_certified_computations(snapshot_id);

-- inputFacts: §20 DecisionRecord.inputFacts[] — `inputs` holds the values but
-- not their provenance.
ALTER TABLE layover_certified_computations ADD COLUMN IF NOT EXISTS input_facts JSONB NOT NULL DEFAULT '[]'::jsonb;

-- sourceRefs: §20 DecisionRecord.sourceRefs[].
ALTER TABLE layover_certified_computations ADD COLUMN IF NOT EXISTS source_refs TEXT[] NOT NULL DEFAULT '{}';

-- rulesApplied: §20 DecisionRecord.rulesApplied[] — and the input to the §21
-- L241 decision diff.
ALTER TABLE layover_certified_computations ADD COLUMN IF NOT EXISTS rules_applied TEXT[] NOT NULL DEFAULT '{}';

-- engineVersion -> ledger_version: the PROJECTION's version
-- (LAYOVER_LEDGER_VERSION), which is a different question from the engine's.
ALTER TABLE layover_certified_computations ADD COLUMN IF NOT EXISTS ledger_version TEXT;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 2 — immutability, as a trigger the service role cannot bypass
-- ═════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.layover_snapshot_rows_are_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
-- SECURITY INVOKER (the default, stated because `check:search-path-hazard`
-- reads this) and a pinned empty search_path: this function resolves no
-- unqualified name and must not be able to.
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION
    'IMMUTABLE (2992): % row % may not be UPDATEd. A snapshot-scoped row names one certified computation forever (census L95/L261). Supersede it by writing a new snapshot; compact it by DELETE, which is permitted and is how bounded retention is implemented.',
    TG_TABLE_NAME, COALESCE(OLD.snapshot_id, '<no snapshot_id>');
END $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 3 — §4 L22: the constraint set
-- ═════════════════════════════════════════════════════════════════════════════
-- L22 asks for eleven concepts. Two of them survive today as booleans on the
-- session (`immigration_required`, `checked_bags`, 0127:69-70) and this table
-- does NOT delete or move those: 0127's columns stay exactly as they are and
-- keep their writer. This table is the VERSIONED, snapshot-scoped constraint
-- set the engine certifies against, and its baggage column is the one that
-- fixes L35 — `checked_bags BOOLEAN` collapses four states into two and
-- destroys UNKNOWN, recording a traveller who does not know as one who has no
-- checked bags, the optimistic reading, on the exact fact §12.1 calls decisive.

CREATE TABLE IF NOT EXISTS layover_constraints (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id              UUID        NOT NULL REFERENCES layover_sessions(id) ON DELETE CASCADE,

  -- The computation this constraint set was certified under. Nullable because a
  -- constraint set is DECLARED (by the traveller, or by a clarifying question)
  -- before anything certifies it; a set with no snapshot is a set nothing has
  -- reasoned from yet, and that is a real and visible state rather than an
  -- error. NOT an FK, for the same reason: the target may not exist yet.
  snapshot_id             TEXT,

  -- L22 version. Monotonic per session; the writer reads MAX+1.
  version                 INTEGER     NOT NULL CHECK (version >= 1),

  -- Terminals. TEXT because an IATA terminal designator is not a number
  -- ('2', '2E', 'S4', 'Satellite 1') and every deployment that has tried to
  -- make it one has lost 'A'.
  arrival_terminal        TEXT        CHECK (arrival_terminal IS NULL OR length(arrival_terminal) BETWEEN 1 AND 32),
  departure_terminal      TEXT        CHECK (departure_terminal IS NULL OR length(departure_terminal) BETWEEN 1 AND 32),

  immigration_required    BOOLEAN,
  customs_required        BOOLEAN,

  -- L35 `BaggageMode`, all four members INCLUDING UNKNOWN, which is the
  -- default. NOT NULL with 'UNKNOWN' rather than a nullable column: NULL is a
  -- second spelling of the same state and a predicate would have to test both.
  baggage_mode            TEXT        NOT NULL DEFAULT 'UNKNOWN'
                            CHECK (baggage_mode IN ('CHECKED_THROUGH','COLLECT_RECHECK','CARRY_ON_ONLY','UNKNOWN')),
  recheck_required        BOOLEAN,
  airport_change_required BOOLEAN,

  -- L34 `EntryPermissionState`, all three members, UNKNOWN the default. This is
  -- the column L48's hard invariant needs
  -- (`entry_permission_state != CONFIRMED_ALLOWED => forbid landside`), and it
  -- is deliberately stored WITHOUT any prohibition attached: the storage does
  -- not decide, the engine does. Nothing in this file forbids anything.
  entry_permission_state  TEXT        NOT NULL DEFAULT 'UNKNOWN'
                            CHECK (entry_permission_state IN ('CONFIRMED_ALLOWED','CONFIRMED_NOT_ALLOWED','UNKNOWN')),

  mobility_profile        TEXT        NOT NULL DEFAULT 'STANDARD'
                            CHECK (mobility_profile IN ('STANDARD','REDUCED','ASSISTED','UNKNOWN')),
  buffer_profile          TEXT        NOT NULL DEFAULT 'STANDARD'
                            CHECK (buffer_profile IN ('AGGRESSIVE','STANDARD','CONSERVATIVE')),

  minimum_boarding_buffer_min INTEGER CHECK (minimum_boarding_buffer_min IS NULL OR minimum_boarding_buffer_min BETWEEN 0 AND 600),

  -- L22 `critical_unknowns_json`. Provenance/reason detail, so JSONB is the
  -- right shape under §4's implementation rule. The SAFETY PREDICATE does not
  -- read this: it reads the typed columns above. An array of strings here is a
  -- record of what was unknown and why, not a thing to branch on.
  critical_unknowns       JSONB       NOT NULL DEFAULT '[]'::jsonb,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- ONE VERSION NUMBER PER SESSION. Without this a concurrent write produces
  -- two "version 3"s and the constraint set stops being a sequence.
  UNIQUE (session_id, version)
);

CREATE INDEX IF NOT EXISTS layover_constraints_session_idx
  ON layover_constraints(session_id, version DESC);
CREATE INDEX IF NOT EXISTS layover_constraints_snapshot_idx
  ON layover_constraints(snapshot_id) WHERE snapshot_id IS NOT NULL;

ALTER TABLE layover_constraints ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.layover_constraints FROM anon;
REVOKE ALL ON public.layover_constraints FROM authenticated;

DROP TRIGGER IF EXISTS layover_constraints_immutable ON layover_constraints;
CREATE TRIGGER layover_constraints_immutable
  BEFORE UPDATE ON layover_constraints
  FOR EACH ROW EXECUTE FUNCTION public.layover_snapshot_rows_are_immutable();

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 4 — §4 L23: the time budget, one row per certified computation
-- ═════════════════════════════════════════════════════════════════════════════
-- L23's evidence reads: "The breakdown is computed per request and returned in
-- the response body. No writer, no table." Every column below is a term the
-- engine ALREADY computes (`LayoverSafetyEngine` buffer breakdown +
-- `FeasibilityEstimates`); none is a new number and none is derived here.
--
-- ── NULL MEANS "NOT SEPARATELY MODELLED". READ THIS BEFORE WRITING A ZERO ────
-- The ten ladder columns are NULLABLE, and that is the most important decision
-- in this table. This tree does NOT model the ladder term by term: L46 records
-- that deplane + immigration + baggage + exit friction are ONE lumped
-- `estimateExitDelay`, that the base buffer covers security AND boarding, and
-- that `traffic_extra_min` covers transfer AND contingency. Six of eleven terms
-- are modelled; five are not modelled at all.
--
-- If those five were `NOT NULL DEFAULT 0` the table would record a MEASURED
-- ZERO for each of them, which is a claim — "we looked at deplaning and it
-- takes no time" — and it is false. That is precisely the fabricated
-- specificity §2.1 forbids and L9 scores: *"never fabricate freshness"*. A
-- `NULL` says the only true thing available, which is that nobody measured it,
-- and it makes the day a term becomes real a visible transition in the data
-- rather than a silent change of meaning for a column full of zeroes.
--
-- A zero in one of these columns therefore MEANS zero, and a writer that
-- cannot distinguish the two must write NULL. `usable_minutes`,
-- `scheduled_minutes` and `total_buffer_min` are NOT NULL because those three
-- are the answer, are always computed, and are what every consumer reads.

CREATE TABLE IF NOT EXISTS layover_time_budgets (
  snapshot_id       TEXT        PRIMARY KEY,
  session_id        UUID        NOT NULL REFERENCES layover_sessions(id) ON DELETE CASCADE,

  -- The scheduled window this budget subtracts from, so a stored budget can be
  -- checked against its own arithmetic without re-reading the session.
  scheduled_minutes INTEGER     NOT NULL CHECK (scheduled_minutes >= 0),

  -- The §6 ladder, one column per term, in the order the spec subtracts them.
  -- NULL = not separately modelled by the engine that wrote this row.
  deplane_min       INTEGER     CHECK (deplane_min       IS NULL OR deplane_min       >= 0),
  immigration_min   INTEGER     CHECK (immigration_min   IS NULL OR immigration_min   >= 0),
  baggage_min       INTEGER     CHECK (baggage_min       IS NULL OR baggage_min       >= 0),
  exit_min          INTEGER     CHECK (exit_min          IS NULL OR exit_min          >= 0),
  outbound_min      INTEGER     CHECK (outbound_min      IS NULL OR outbound_min      >= 0),
  -- L72 / L60: the return term is its own column and is NOT constrained to
  -- equal `outbound_min`. The tree's defect is that they are computed as
  -- `travelTimeMin * 2`; a schema that stored one number for both would make
  -- the defect permanent and unmeasurable. Two columns let a future asymmetric
  -- estimate land without a migration, and let a test observe today that they
  -- are equal.
  return_min        INTEGER     CHECK (return_min        IS NULL OR return_min        >= 0),
  security_min      INTEGER     CHECK (security_min      IS NULL OR security_min      >= 0),
  transfer_min      INTEGER     CHECK (transfer_min      IS NULL OR transfer_min      >= 0),
  boarding_min      INTEGER     CHECK (boarding_min      IS NULL OR boarding_min      >= 0),
  contingency_min   INTEGER     CHECK (contingency_min   IS NULL OR contingency_min   >= 0),

  -- The engine's own total, stored because it is the one figure the deadline is
  -- literally `cutoff - total_buffer_min` and a reader must not have to re-add
  -- a ladder half of whose terms are NULL.
  total_buffer_min  INTEGER     NOT NULL CHECK (total_buffer_min >= 0),

  usable_minutes    INTEGER     NOT NULL CHECK (usable_minutes >= 0),

  -- L54/L55: which percentile of each distribution the terms above were taken
  -- at. A budget without this is a set of numbers nobody can reproduce.
  buffer_percentile TEXT        NOT NULL DEFAULT 'p90'
                      CHECK (buffer_percentile IN ('p50','p75','p90')),

  computed_at       TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS layover_time_budgets_session_idx
  ON layover_time_budgets(session_id, computed_at DESC);

ALTER TABLE layover_time_budgets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.layover_time_budgets FROM anon;
REVOKE ALL ON public.layover_time_budgets FROM authenticated;

DROP TRIGGER IF EXISTS layover_time_budgets_immutable ON layover_time_budgets;
CREATE TRIGGER layover_time_budgets_immutable
  BEFORE UPDATE ON layover_time_budgets
  FOR EACH ROW EXECUTE FUNCTION public.layover_snapshot_rows_are_immutable();

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 5 — §4 L24: the return plan, one row per certified computation
-- ═════════════════════════════════════════════════════════════════════════════
-- L24's evidence: "`layover_sessions.return_reminder_at` stores one reminder
-- instant set by the user's tap. None of the six fields exists." This table
-- does not touch `return_reminder_at`: a reminder is something a traveller
-- ASKED FOR and a return plan is something the engine CERTIFIED, and collapsing
-- the two is how a tap became a deadline.

CREATE TABLE IF NOT EXISTS layover_return_plans (
  snapshot_id                   TEXT        PRIMARY KEY,
  session_id                    UUID        NOT NULL REFERENCES layover_sessions(id) ON DELETE CASCADE,

  -- The three instants, all typed TIMESTAMPTZ and all derived by the engine.
  hard_return_by                TIMESTAMPTZ NOT NULL,
  recommended_return_by         TIMESTAMPTZ NOT NULL,
  latest_activity_departure_at  TIMESTAMPTZ,

  -- L36 `RiskBand`, all four members INCLUDING UNSAFE. The tree's
  -- `SafetyRating` has no UNSAFE band and its fourth value (`airport_only`)
  -- encodes a user PREFERENCE rather than a risk level; storing the preference
  -- in the risk column is what makes L50's invariant
  -- (`risk_band == UNSAFE => status = BLOCKED`) unstatable. This column is the
  -- spec's axis. Nothing in this file maps the two; that is the engine's job
  -- and it is not done here.
  --
  -- NULLABLE, and for the same reason the ladder columns above are: all four
  -- bands are ASSESSMENTS and none of them means "nobody looked". A traveller
  -- who elected to stay airside was never assessed for leaving, and the engine
  -- says so structurally — `stay_airside` is returned from
  -- `if (!session.wantsToLeave)` BEFORE any window is consulted. Writing any of
  -- the four for that session would put a tick-box in the risk column.
  -- `riskBandFor` (services/layover/LayoverDecisionStore.ts) returns NULL there
  -- and a band everywhere else.
  risk_band                     TEXT
                                  CHECK (risk_band IS NULL OR risk_band IN ('LOW','MODERATE','HIGH','UNSAFE')),

  -- L37 `ConfidenceBand`, all four members. Matches `ESTIMATE_CONFIDENCES` in
  -- LayoverFeasibility.ts exactly, so a stored value and a computed one are the
  -- same vocabulary.
  confidence                    TEXT        NOT NULL
                                  CHECK (confidence IN ('INSUFFICIENT','LOW','MEDIUM','HIGH')),

  -- Provenance/reason detail. §4 JSON rule again: no predicate reads this.
  reason_codes                  JSONB       NOT NULL DEFAULT '[]'::jsonb,

  computed_at                   TIMESTAMPTZ NOT NULL,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- THE ONE INVARIANT THIS TABLE ENFORCES ITSELF. A recommended return that is
  -- LATER than the hard return is not a conservative plan, it is a plan that
  -- misses the flight, and it is the single arithmetic error in this domain
  -- that a database can catch. `<=` and not `<`: the two coincide exactly when
  -- the buffer is zero, which is legal and is not an error.
  CONSTRAINT layover_return_plans_recommended_before_hard
    CHECK (recommended_return_by <= hard_return_by),

  -- And the activity departure, when there is one, cannot be after the
  -- recommended return either -- leaving the activity IS the return.
  CONSTRAINT layover_return_plans_activity_before_recommended
    CHECK (latest_activity_departure_at IS NULL
           OR latest_activity_departure_at <= recommended_return_by)
);

CREATE INDEX IF NOT EXISTS layover_return_plans_session_idx
  ON layover_return_plans(session_id, computed_at DESC);

ALTER TABLE layover_return_plans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.layover_return_plans FROM anon;
REVOKE ALL ON public.layover_return_plans FROM authenticated;

DROP TRIGGER IF EXISTS layover_return_plans_immutable ON layover_return_plans;
CREATE TRIGGER layover_return_plans_immutable
  BEFORE UPDATE ON layover_return_plans
  FOR EACH ROW EXECUTE FUNCTION public.layover_snapshot_rows_are_immutable();

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 6 — §4 L30: checkpoints
-- ═════════════════════════════════════════════════════════════════════════════
-- L30: "Absent. No checkpoint is ever observed or recorded." L43's transition
-- (`RETURNING -> AIRPORT_REENTERED`: checkpoint confirms re-entry) has no input
-- without this table, and L173 (`recordCheckpoint`) has nowhere to write.
--
-- NO COORDINATES. See the header. A checkpoint names a KIND of place.

CREATE TABLE IF NOT EXISTS layover_checkpoints (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID        NOT NULL REFERENCES layover_sessions(id) ON DELETE CASCADE,

  checkpoint_type TEXT        NOT NULL
                    CHECK (checkpoint_type IN (
                      'SECURITY','IMMIGRATION','CUSTOMS','GATE','LOUNGE',
                      'LANDSIDE_EXIT','AIRPORT_REENTRY','BOARDING')),

  -- WHEN IT HAPPENED, and separately when we heard about it. §11's event
  -- envelope (L90) names both and the tree's `layover_events` has only
  -- `created_at`, which is why a delayed report currently reads as a fresh one.
  -- A stale observation must never read as "now": every read in
  -- `services/layover/` orders and filters on `observed_at`, never on
  -- `received_at`.
  observed_at     TIMESTAMPTZ NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Who says so. 'TRAVELLER' is a self-report and is the only source this tree
  -- can produce today; the other two exist so that the day a real one arrives
  -- it does not have to pretend to be a traveller.
  source          TEXT        NOT NULL DEFAULT 'TRAVELLER'
                    CHECK (source IN ('TRAVELLER','DEVICE','OPERATOR')),

  -- L82/L88: a community observation is confidence-weighted. Same four-member
  -- vocabulary as everywhere else in this domain.
  confidence      TEXT        NOT NULL DEFAULT 'MEDIUM'
                    CHECK (confidence IN ('INSUFFICIENT','LOW','MEDIUM','HIGH')),

  -- L90's dedup key. UNIQUE below, so a replayed report is one checkpoint.
  dedup_key       TEXT        NOT NULL CHECK (length(dedup_key) BETWEEN 1 AND 200),

  -- A FILTER, NOT A RETENTION PROMISE. See the header.
  expires_at      TIMESTAMPTZ NOT NULL,

  metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (session_id, dedup_key)
);

CREATE INDEX IF NOT EXISTS layover_checkpoints_session_idx
  ON layover_checkpoints(session_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS layover_checkpoints_expiry_idx
  ON layover_checkpoints(expires_at);

ALTER TABLE layover_checkpoints ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.layover_checkpoints FROM anon;
REVOKE ALL ON public.layover_checkpoints FROM authenticated;

-- NOTE: no immutability trigger. A checkpoint is an OBSERVATION, not a
-- certification, and `received_at` on a corrected report is a legitimate
-- update. The dedup key is what stops a replay becoming a second event.

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 7 — §4 L32: outcomes
-- ═════════════════════════════════════════════════════════════════════════════
-- L32: "Absent, and unreachable in principle: nothing ever marks a session
-- completed." L10 states the consequence — "The system cannot distinguish a
-- safe return from an abandonment" — and it is the row that says what this
-- whole domain is optimising, so it is the one row here whose absence is a
-- statement about the product rather than about the schema.
--
-- THIS MIGRATION DOES NOT MAKE `status='completed'` REACHABLE. That is a
-- lifecycle change in `LayoverSessionService` and it is not in this file.
-- An outcome row can be written for a session in any status; `boarding_outcome`
-- is the column that says what actually happened, and 'UNKNOWN' is a member
-- because a traveller who never came back to the app is the commonest case and
-- must not be recorded as a success.

CREATE TABLE IF NOT EXISTS layover_outcomes (
  session_id               UUID        PRIMARY KEY REFERENCES layover_sessions(id) ON DELETE CASCADE,

  completed_at             TIMESTAMPTZ,
  left_airport             BOOLEAN,
  completed_experience     BOOLEAN,
  met_people_count         INTEGER     CHECK (met_people_count IS NULL OR met_people_count BETWEEN 0 AND 1000),
  actual_airport_return_at TIMESTAMPTZ,

  boarding_outcome         TEXT        NOT NULL DEFAULT 'UNKNOWN'
                             CHECK (boarding_outcome IN ('BOARDED','MISSED','REBOOKED','CANCELLED','UNKNOWN')),

  comfort_rating           INTEGER     CHECK (comfort_rating IS NULL OR comfort_rating BETWEEN 1 AND 5),
  plan_change_reason       TEXT        CHECK (plan_change_reason IS NULL OR length(plan_change_reason) <= 500),

  -- L32's `anonymization_state`, and it is not decoration: an outcome is the
  -- one layover artifact that is interesting in AGGREGATE (L209-L217's
  -- metrics), and aggregation over identified rows is how a metrics table
  -- becomes a movement history. 'IDENTIFIED' is the default because a row is
  -- written while the session is live and its owner can still ask about it;
  -- moving it on is a lifecycle this migration does not implement and does not
  -- claim to.
  anonymization_state      TEXT        NOT NULL DEFAULT 'IDENTIFIED'
                             CHECK (anonymization_state IN ('IDENTIFIED','ANONYMIZED','PURGED')),

  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A return that happens before the session was completed is a clock error,
  -- not an outcome. Both nullable, so the constraint only bites when both are
  -- present.
  CONSTRAINT layover_outcomes_return_not_after_completion
    CHECK (actual_airport_return_at IS NULL
           OR completed_at IS NULL
           OR actual_airport_return_at <= completed_at)
);

CREATE INDEX IF NOT EXISTS layover_outcomes_completed_idx
  ON layover_outcomes(completed_at DESC) WHERE completed_at IS NOT NULL;

ALTER TABLE layover_outcomes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.layover_outcomes FROM anon;
REVOKE ALL ON public.layover_outcomes FROM authenticated;

-- NOTE: no immutability trigger. An outcome is AMENDED — the traveller boards,
-- then rates, then the anonymization lifecycle moves the row — and `updated_at`
-- exists for exactly that. It is not a certification.

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 8 — the gate, seeded OFF
-- ═════════════════════════════════════════════════════════════════════════════
-- See WHY THE FLAG IS SEEDED above. FALSE, and `ON CONFLICT DO NOTHING` so a
-- re-run can never turn an operator's TRUE back off.

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'layover_decision_persistence_enabled',
    false,
    'Layover §20 decision-record persistence: when ON, GET /api/airport/sessions/:id/safety stores the certified computation it just published into layover_certified_computations (with 2992''s five §20 columns) plus its layover_time_budgets and layover_return_plans rows, and publishes the snapshot id alongside the answer. OFF (the seed): nothing is written and the response reports persisted.state = "not_stored" with reason "persistence_disabled" — the traveller''s deadline is unaffected either way. MUST NOT BE TURNED ON until BOTH 2700 and 2992 are applied and their postconditions confirmed: supabase-js sends every key of the insert payload, so the writer names columns a pre-2992 database does not have and the INSERT fails outright. Fail-closed (isFlagEnabled) — an unreadable feature_flags leaves the gate OFF, never silently on. Read by services/layover/LayoverDecisionStore.ts (DECISION_PERSISTENCE_FLAG, literal name).'
  )
ON CONFLICT (flag) DO NOTHING;

-- ═════════════════════════════════════════════════════════════════════════════
-- Postconditions — absolute and re-runnable
-- ═════════════════════════════════════════════════════════════════════════════
-- Catalog state only, no temp table, no before/after comparison, so
-- `certify:migrations` can re-run this block standalone.
DO $$
DECLARE
  t                 TEXT;
  missing_col       TEXT;
  policy_count      INTEGER;
  client_grants     INTEGER;
  coord_cols        INTEGER;
  certcomp_policies INTEGER;
  certcomp_grants   TEXT;
  trig_count        INTEGER;
  snapshot_idx_unique BOOLEAN;
  new_tables CONSTANT TEXT[] := ARRAY[
    'layover_constraints','layover_time_budgets','layover_return_plans',
    'layover_checkpoints','layover_outcomes'];
BEGIN
  -- 1. Every new table exists.
  FOREACH t IN ARRAY new_tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (2992): % missing', t;
    END IF;
  END LOOP;

  -- 2. The five §20 columns landed on the EXISTING table.
  FOREACH missing_col IN ARRAY ARRAY['snapshot_id','input_facts','source_refs','rules_applied','ledger_version'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'layover_certified_computations'
         AND column_name = missing_col
    ) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (2992): layover_certified_computations.% missing -- LEDGER_MISSING_COLUMNS names it and ledgerRowFor cannot send it without it', missing_col;
    END IF;
  END LOOP;

  -- 3. snapshot_id is UNIQUE, or it is a label rather than an identity and
  --    "never certify a recommendation against a snapshot other than the one
  --    returned with it" (L296) is unenforceable.
  SELECT i.indisunique INTO snapshot_idx_unique
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_index i ON i.indexrelid = c.oid
   WHERE n.nspname = 'public' AND c.relname = 'layover_certcomp_snapshot_uidx';
  IF snapshot_idx_unique IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2992): layover_certcomp_snapshot_uidx is missing or not unique';
  END IF;

  -- 4. RLS on for every new table.
  FOREACH t IN ARRAY new_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = t AND c.relrowsecurity = TRUE
    ) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (2992): RLS not enabled on % -- every revoke below it would be decoration and the service role''s bypass would stop being the only way in', t;
    END IF;
  END LOOP;

  -- 5. ZERO policies on the new tables. This is the L201 check: a policy here
  --    would be a second, weaker answer sitting underneath the route layer.
  SELECT count(*) INTO policy_count
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = ANY(new_tables);
  IF policy_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2992): % policy/policies on the new layover tables, expected 0. These tables are server-mediated.', policy_count;
  END IF;

  -- 6. No client grant of ANY kind, read included, on the new tables.
  SELECT count(*) INTO client_grants
    FROM information_schema.column_privileges
   WHERE table_schema = 'public'
     AND table_name = ANY(new_tables)
     AND grantee IN ('anon','authenticated');
  IF client_grants <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2992): % client column grant(s) on the new layover tables, expected 0 (RLS is on and there is no policy, so a grant is inert today and a trap the day someone adds one)', client_grants;
  END IF;

  -- 7. NO COORDINATES, on any of the five. A checkpoint is the row type this
  --    would matter most for; see the header.
  SELECT count(*) INTO coord_cols
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = ANY(new_tables)
     AND column_name IN ('lat','lng','latitude','longitude','location','geog','geom','point','coords');
  IF coord_cols <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2992): % coordinate column(s) on the new layover tables. Layover presence structurally cannot carry a coordinate (census L8, one of this census''s few C rows) and the precision ladder that would govern one has no grant store (§28.2). A checkpoint with a position is a movement trace.', coord_cols;
  END IF;

  -- 8. The three snapshot-scoped tables REFUSE an UPDATE. Asserted as a trigger
  --    count, because "immutable" that is only true of callers who could never
  --    write anyway is a description of the grant table.
  SELECT count(*) INTO trig_count
    FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND NOT tg.tgisinternal
     AND c.relname IN ('layover_constraints','layover_time_budgets','layover_return_plans')
     AND tg.tgname IN ('layover_constraints_immutable','layover_time_budgets_immutable','layover_return_plans_immutable');
  IF trig_count <> 3 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2992): % immutability trigger(s) on the snapshot-scoped tables, expected 3', trig_count;
  END IF;

  -- 9. 2700's OWN boundary is UNCHANGED. This migration adds columns to that
  --    table; if it has also changed who may read or write it, that is a
  --    security change nobody asked for and it stops here.
  SELECT count(*) INTO certcomp_policies
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'layover_certified_computations';
  IF certcomp_policies <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2992): layover_certified_computations has % policies, expected exactly the 1 owner-read policy migration 2700 creates', certcomp_policies;
  END IF;

  SELECT COALESCE(string_agg(DISTINCT privilege_type, ','), '<none>')
    INTO certcomp_grants
    FROM information_schema.column_privileges
   WHERE table_schema = 'public'
     AND table_name = 'layover_certified_computations'
     AND grantee IN ('anon','authenticated');
  IF certcomp_grants IS DISTINCT FROM 'SELECT' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2992): client grants on layover_certified_computations are (%), expected exactly SELECT. Certification fields a traveller can write are not certification (census L201).', certcomp_grants;
  END IF;

  -- 10. The gate EXISTS, so the audited toggle path can reach it.
  --
  -- Its VALUE is deliberately not asserted. A re-run on a deployment that has
  -- already enabled the feature must not fail, and must not turn it off; the
  -- `ON CONFLICT DO NOTHING` above is what guarantees this migration never
  -- changes it. What matters here is that there is a row to flip at all, which
  -- is the whole of `check:flag-polarity`'s objection to seeding nothing.
  IF NOT EXISTS (
    SELECT 1 FROM public.feature_flags WHERE flag = 'layover_decision_persistence_enabled'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2992): layover_decision_persistence_enabled has no feature_flags row -- the gate would be un-flippable and step 5 of the deployment sequence impossible without a second migration';
  END IF;
END $$;

COMMIT;
