-- 2982_layover_traveller_observation_submissions.sql
--
-- THE IDEMPOTENCY KEY THE §10 OBSERVATION CHANNEL NEEDS ONCE IT HAS A WRITER.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2982 (layover).
-- Creates NO table. Adds ONE nullable column and ONE partial unique index to
-- `airport_fact_observations`. Moves no row. Seeds no feature flag. Changes no
-- grant and no policy.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THIS EXISTS, AND WHY IT IS SEPARATE FROM 2860
-- ══════════════════════════════════════════════════════════════════════════════
-- 2860_layover_airport_truth_and_events.sql created `airport_fact_observations`
-- and said, in its ORDERING section:
--
--   "NO CODE WRITES EITHER TABLE, DELIBERATELY … The sequence is: apply this,
--    confirm the postconditions, THEN land an ingest route and a reader."
--
-- and in its WRITE BOUNDARY section:
--
--   "A traveller report, when one is built, arrives through a server route on
--    the service role and is screened by LayoverAirportTruth.screenObservations."
--
-- That traveller report is now built — census-layover L82, "Traveler observation
-- … confidence-weighted", whose last parseable verdict reads "The class exists
-- and is confidence-weighted the way the spec asks … There is NO SUBMISSION
-- SURFACE — no route, no screen, nothing a traveller can report from."
--
-- The surface is `POST /api/airport/sessions/:id/observations`
-- (artifacts/api-server/src/routes/airport.ts) over
-- artifacts/api-server/src/services/layover/LayoverObservationService.ts.
-- It is session-scoped so that the write is authorized as the reporter's own
-- layover and the airport ref comes from a session the server already trusts;
-- see that route's header.
--
-- 2860 needed no idempotency key because it had no writer. A writer needs one,
-- and that is the whole of this file.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE DEFECT THIS PREVENTS, STATED CONCRETELY
-- ══════════════════════════════════════════════════════════════════════════════
-- A traveller reports "security is 25 minutes". The phone is on airport wifi,
-- the POST succeeds server-side and the response is lost. The client retries.
--
-- Without this column the retry is a SECOND ROW: same airport, same fact, same
-- observer handle, a slightly later `observed_at`. What that costs:
--
--   * `screenObservations` rate-limits per (observer, factType) at 3 per 15
--     minutes (OBSERVATION_RATE_LIMIT). Two rows for one report spends two
--     thirds of a traveller's honest budget on one press.
--   * The reconciler's accepted set carries the same reading twice. It cannot
--     forge CORROBORATION — that counts DISTINCT observer ids, and both rows
--     carry the same handle — but it does double that observer's presence in
--     the weighted set, which is a quieter version of the same problem.
--
-- With it, the retry is `ON CONFLICT (submission_token) DO NOTHING` and the
-- second press is a no-op the route reports as the first press's outcome.
--
-- NOT A SUBSTITUTE FOR THE RATE LIMIT. The token makes a RETRY free; it does
-- not make a SUBMISSION free. A client that mints a fresh token per press is
-- still subject to OBSERVATION_RATE_LIMIT, which is where §23's abuse control
-- lives and which this file does not touch.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY A PARTIAL UNIQUE INDEX AND NOT A NOT NULL COLUMN
-- ══════════════════════════════════════════════════════════════════════════════
-- `airport_fact_observations` is designed to hold rows from producers that are
-- not this route — operator feeds, official schedules, sensors (2860's
-- `observer_kind` vocabulary). Those producers have their own dedup story or
-- none, and forcing a token on them would mean inventing one per row, which
-- makes the index unique over noise and guarantees nothing.
--
-- So: NULL means "this producer does not claim exactly-once", and the partial
-- index does not constrain those rows at all. A non-NULL token is a CLAIM, and
-- the index enforces it. Postgres treats NULLs as distinct in a unique index
-- anyway; the WHERE clause is there so the index holds only the rows that make
-- the claim, and so a reader of \d+ can see which rows those are.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DOES NOT CHANGE
-- ══════════════════════════════════════════════════════════════════════════════
-- Nothing about the write boundary. `anon` and `authenticated` keep exactly the
-- grants 2860 left them — SELECT for authenticated, nothing for anon, and no
-- INSERT/UPDATE/DELETE policy of any kind. The submission route writes on the
-- service role, exactly as 2860 specified. The postconditions below RE-ASSERT
-- that boundary rather than assuming it, because this file is the first change
-- to the table since it shipped and a widened grant here would be invisible.
--
-- Nothing about identity. `observer_id` stays a free TEXT handle that is not a
-- profiles FK, and 2860's `airport_fact_observations_community_not_a_profile`
-- CHECK — which forbids a bare UUID on a community row — is re-asserted below.
-- The submission route honours it by writing a per-(user, airport) HMAC handle
-- rather than a user id, so the table still cannot become a record of who was
-- standing in which queue. That is 2860's decision; this file only checks that
-- it is still in force.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- APPLY ORDER — 2860 FIRST, AND THIS FILE SAYS SO LOUDLY
-- ══════════════════════════════════════════════════════════════════════════════
-- HARD DEPENDENCY on 2860. As of this file's authoring 2860 is written and NOT
-- APPLIED: it is absent from src/lib/capability/production-applied-migrations.json
-- and census-layover §23.3 lists it under "blocked on a migration no database
-- has". If 2860 has not been applied, the precondition below RAISES rather than
-- creating anything, so the failure names the missing migration instead of
-- surfacing later as an unexplained "column does not exist" from the route.
--
-- Independent of 2971 and of every other file in the 29xx band.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- REVERSIBLE BY
-- ══════════════════════════════════════════════════════════════════════════════
--   DROP INDEX IF EXISTS public.airport_fact_obs_submission_token_uidx;
--   ALTER TABLE public.airport_fact_observations
--     DROP CONSTRAINT IF EXISTS airport_fact_observations_submission_token_len;
--   ALTER TABLE public.airport_fact_observations DROP COLUMN IF EXISTS submission_token;
-- Nothing else is touched, so those three statements restore 2860's state
-- exactly. The route degrades to at-least-once on a retry, which is the
-- behaviour described under THE DEFECT above.

BEGIN;

-- ── Precondition ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.airport_fact_observations') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2982): public.airport_fact_observations does not exist. Apply 2860_layover_airport_truth_and_events.sql first -- this file only adds an idempotency key to the table that migration creates.';
  END IF;

  -- The identity boundary this file is built on top of. If 2860's community
  -- CHECK has been dropped, then a community row may already carry a bare
  -- profiles UUID, the submission route's pseudonymous handle is no longer the
  -- only shape in the column, and adding an idempotency key to that table is
  -- not the change a reviewer approved. Fail rather than build on it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'airport_fact_observations'
       AND c.conname = 'airport_fact_observations_community_not_a_profile'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2982): airport_fact_observations_community_not_a_profile is missing. 2860 created it to keep a profiles id out of observer_id; this file will not add a writer-facing key to a table that has lost that guarantee.';
  END IF;
END $$;

-- ── The idempotency key ──────────────────────────────────────────────────────

ALTER TABLE public.airport_fact_observations
  ADD COLUMN IF NOT EXISTS submission_token TEXT;

COMMENT ON COLUMN public.airport_fact_observations.submission_token IS
  'Exactly-once key for producers that claim one. NULL = this producer makes no such claim and is unconstrained. Non-NULL is enforced unique by airport_fact_obs_submission_token_uidx, so a retried traveller report is ON CONFLICT DO NOTHING rather than a second row. Written by services/layover/LayoverObservationService.ts; see migration 2982.';

-- A bound, for the same reason every other TEXT column on this table has one.
-- Added separately from the column so the statement is idempotent on a database
-- where the column already exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'airport_fact_observations'
       AND c.conname = 'airport_fact_observations_submission_token_len'
  ) THEN
    ALTER TABLE public.airport_fact_observations
      ADD CONSTRAINT airport_fact_observations_submission_token_len
      CHECK (submission_token IS NULL OR length(submission_token) BETWEEN 8 AND 128);
  END IF;
END $$;

-- THE GUARANTEE. Partial, so it constrains only the rows that claim it.
CREATE UNIQUE INDEX IF NOT EXISTS airport_fact_obs_submission_token_uidx
  ON public.airport_fact_observations(submission_token)
  WHERE submission_token IS NOT NULL;

-- ── Postconditions ───────────────────────────────────────────────────────────
-- Absolute and re-runnable: every check below reads current catalog state only,
-- with no temp table and no before/after comparison, so `certify:migrations`
-- can re-run this block standalone.
DO $$
DECLARE
  token_unique BOOLEAN;
  token_partial BOOLEAN;
  writable_cols INTEGER;
  policy_count INTEGER;
  col_nullable TEXT;
BEGIN
  -- 1. The column exists and is NULLABLE. A NOT NULL here would mean every
  --    non-route producer has to mint a token, which is the failure mode the
  --    header's "WHY A PARTIAL UNIQUE INDEX" section exists to refuse.
  SELECT is_nullable INTO col_nullable
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'airport_fact_observations'
     AND column_name = 'submission_token';
  IF col_nullable IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2982): airport_fact_observations.submission_token missing';
  END IF;
  IF col_nullable <> 'YES' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2982): submission_token is NOT NULL. It must stay nullable -- NULL is how a producer declines to claim exactly-once, and a NOT NULL forces every operator feed to invent a token, which makes the unique index unique over noise.';
  END IF;

  -- 2. The length CHECK is present.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'airport_fact_observations'
       AND c.conname = 'airport_fact_observations_submission_token_len'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2982): airport_fact_observations_submission_token_len missing';
  END IF;

  -- 3. The index exists, is UNIQUE, and is PARTIAL. All three asserted
  --    separately: an index that exists but is not unique deduplicates
  --    nothing (2860's own wording), and one that is unique but NOT partial
  --    would additionally constrain every NULL-token producer row the moment
  --    Postgres semantics around NULL distinctness are changed by an index
  --    option, so the WHERE clause is part of the contract and not decoration.
  SELECT i.indisunique, i.indpred IS NOT NULL
    INTO token_unique, token_partial
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'airport_fact_obs_submission_token_uidx';
  IF token_unique IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2982): airport_fact_obs_submission_token_uidx missing';
  END IF;
  IF token_unique IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2982): airport_fact_obs_submission_token_uidx exists but is not UNIQUE, so it deduplicates nothing';
  END IF;
  IF token_partial IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2982): airport_fact_obs_submission_token_uidx is not PARTIAL -- it must carry WHERE submission_token IS NOT NULL, see the header';
  END IF;

  -- 4. THE WRITE BOUNDARY, re-asserted. This file is the first change to the
  --    table since 2860 shipped, and a widened client grant arriving alongside
  --    it would be exactly the L201 defect 2860's header is written about: a
  --    layover table whose write half was left implicit. A traveller must not
  --    be able to INSERT their own observation row and bypass the plausibility
  --    check, the rate limit and the corroboration floor.
  SELECT count(*) INTO writable_cols
    FROM information_schema.column_privileges
   WHERE table_schema = 'public'
     AND table_name = 'airport_fact_observations'
     AND grantee IN ('anon','authenticated')
     AND privilege_type IN ('INSERT','UPDATE','DELETE');
  IF writable_cols <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2982): % client-writable column grant(s) on airport_fact_observations. The submission route writes on the service role; a client INSERT bypasses screenObservations entirely.', writable_cols;
  END IF;

  -- 5. Still exactly one policy, still a SELECT. Same reasoning as 4.
  SELECT count(*) INTO policy_count
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'airport_fact_observations';
  IF policy_count <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2982): airport_fact_observations has % policies, expected exactly 1 (2860 airport_fact_obs_read)', policy_count;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'airport_fact_observations'
       AND policyname = 'airport_fact_obs_read' AND cmd = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2982): airport_fact_obs_read is not a SELECT policy';
  END IF;

  -- 6. RLS still on. A policy on a table with RLS off is decoration.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'airport_fact_observations'
       AND c.relrowsecurity = TRUE
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2982): RLS not enabled on airport_fact_observations';
  END IF;

  -- 7. The identity boundary, asserted at the end as well as the start, so a
  --    re-run of this block standalone still checks it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'airport_fact_observations'
       AND c.conname = 'airport_fact_observations_community_not_a_profile'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2982): airport_fact_observations_community_not_a_profile is gone. A community observation may now carry a bare profiles id, which turns this table into a record of who was standing in which queue.';
  END IF;
END $$;

COMMIT;
