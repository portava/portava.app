-- 2981_layover_event_ingest_flag.sql
--
-- SEED `layover_event_ingest_enabled` AS A ROW, FALSE.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
-- Creates no table. Alters nothing that exists. Moves no row. Seeds ONE flag,
-- OFF.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THIS FILE EXISTS
-- ══════════════════════════════════════════════════════════════════════════════
-- Migration 2860 created `layover_external_events` and stated the sequence that
-- had to follow it, in its own words: "The sequence is: apply this, confirm the
-- postconditions, THEN land an ingest route and a reader, behind a flag seeded
-- FALSE."
--
-- 2860 is applied. It is listed in
-- `src/lib/capability/production-applied-migrations.json`, and all twelve
-- columns of `layover_external_events` appear in the production capture named
-- by `src/lib/capability/snapshots/current.ts`. Its postconditions ran at apply
-- time and are in the file. So this is the next step, and this file is the flag
-- half of it.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DOES NOT CHANGE
-- ══════════════════════════════════════════════════════════════════════════════
-- Nothing observable, in either direction.
--
-- `lib/featureFlags.ts` reads a missing row and an unreadable `feature_flags`
-- as the same answer -- false -- so the ingest route is refused before and
-- after this file. No traveller is served anything different, and no producer
-- can publish an event because of it.
--
-- It is worth a migration for the reason 2971 gives for the flag beside it: the
-- absence is load-bearing in one direction only. It makes the gate fail-closed,
-- which is right, and it also makes the gate UN-ENABLEABLE through the one
-- audited path the repository offers. `PATCH /api/admin/feature-flags/<flag>`
-- goes through the `toggle_feature_flag_with_audit` RPC so that the update and
-- its audit-log insert share a transaction, and it cannot patch a row that does
-- not exist. Without this file the only way to open the ingest is a direct
-- UPDATE, which writes no audit row at all.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY IT IS SEEDED OFF AND WHAT MUST BE TRUE BEFORE IT IS TURNED ON
-- ══════════════════════════════════════════════════════════════════════════════
-- Turning this on opens a WRITE PATH FOR NON-TRAVELLER DATA. An external event
-- moves a safety input: `flight.arrival_delayed` shortens a usable window,
-- `airport.security_wait_changed` moves a return deadline. A producer that can
-- publish one can move a traveller's return deadline.
--
-- So enabling it is an owner decision with two prerequisites, neither of which
-- this file can satisfy:
--   1. PRODUCER AUTHENTICATION. The route this flag gates authenticates its
--      producer with a shared secret held outside the repository. Being signed
--      in as a traveller is NOT authority to publish an airport fact, and the
--      route refuses that case whether or not the flag is on.
--   2. A CONSUMER THAT RUNS. Ingested events sit with `processed_at IS NULL`
--      until something claims and replans them. Opening the ingest without the
--      consumer scheduled fills a table and changes no traveller's plan, which
--      looks like working software and is not.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- SHAPE
-- ══════════════════════════════════════════════════════════════════════════════
-- Deliberately the same as 2971_layover_discovery_mode_flag.sql, which is
-- deliberately the same as 2922_creator_attribution_flag.sql: precondition on
-- the table and on the ON CONFLICT arbiter, INSERT ... ON CONFLICT DO NOTHING,
-- then postconditions asserting present AND off. Re-runnable.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
DECLARE conflict_target_ok boolean;
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2981): public.feature_flags does not exist.';
  END IF;

  -- The INSERT below says ON CONFLICT (flag). Postgres needs a unique index or
  -- constraint on exactly that column to infer an arbiter; without one the
  -- statement raises 42P10 rather than doing nothing.
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public' AND t.relname = 'feature_flags'
       AND c.contype IN ('p','u')
       AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute
                              WHERE attrelid = t.oid AND attname = 'flag')]::smallint[]
  ) INTO conflict_target_ok;
  IF NOT conflict_target_ok THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2981): public.feature_flags has no UNIQUE or PRIMARY KEY on (flag) alone, so ON CONFLICT (flag) has no arbiter to infer.';
  END IF;

  -- A flag gating a write path to a table that does not exist is a gate with
  -- nothing behind it. 2860 must be applied first; this is the ordering that
  -- file's own header sets out, asserted rather than assumed.
  IF to_regclass('public.layover_external_events') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2981): public.layover_external_events does not exist. Apply 2860_layover_airport_truth_and_events.sql first -- this flag gates the ingest into that table and means nothing without it.';
  END IF;
END $$;

-- ── Seed (CAPABILITY, OFF) ───────────────────────────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'layover_event_ingest_enabled',
    false,
    'Layover external event ingest: when ON, POST /api/layover/events accepts a canonical event envelope from an authenticated PRODUCER (a flight feed, an airport operations feed), normalises it through normalizeEvent, and stores it in layover_external_events for the replanner to claim. OFF (the seed): the route refuses every request with degraded_unavailable and nothing is written, which is the behaviour today because the flag has until now had no row and a missing row reads false. Fail-closed (isFlagEnabled) -- an unreadable feature_flags leaves the gate OFF, never silently on. Read by services/layover/LayoverExternalEventService.ts (LAYOVER_EVENT_INGEST_FLAG, literal name) and enforced in routes/layoverEvents.ts. ENABLING THIS OPENS A WRITE PATH THAT MOVES SAFETY INPUTS: an external event shortens a usable window or moves a return deadline, so a producer that can publish one can move a traveller return deadline. Two prerequisites before it is turned on -- a producer secret provisioned outside this repository, and a scheduled consumer that claims and replans pending rows. Seeded as a row so the audited toggle path (PATCH /api/admin/feature-flags, via toggle_feature_flag_with_audit) can reach it; before this the only way to enable it was a direct UPDATE that writes no audit row.'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions (present, OFF, and no near-miss spelling) ────────────────
DO $$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
   WHERE flag = 'layover_event_ingest_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2981): expected layover_event_ingest_enabled present exactly once, found %', present;
  END IF;

  SELECT count(*) INTO on_count FROM public.feature_flags
   WHERE flag = 'layover_event_ingest_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2981): layover_event_ingest_enabled seeded ON. This file exists to make the gate REACHABLE, not to open the ingest; opening it admits producer writes that move traveller return deadlines and is an owner decision with two prerequisites named in this file.';
  END IF;

  -- The near-miss names. LAYOVER_EVENT_INGEST_FLAG is the literal
  -- 'layover_event_ingest_enabled'; a row under any other spelling is a gate no
  -- code can reach, which is the defect 2922 hit with creator_attribution.
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag IN ('layover_event_ingest', 'layover_events_ingest_enabled')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2981): a row exists under a near-miss spelling of layover_event_ingest_enabled; no code reads it, so it is a gate nothing can reach.';
  END IF;
END $$;

COMMIT;

-- REVERSAL (manual):
--   DELETE FROM public.feature_flags WHERE flag = 'layover_event_ingest_enabled';
--   Safe: the reader treats an absent row and a false row identically, so the
--   ingest is refused either way. Reversing only removes the audited toggle
--   path, and cannot un-ingest a row that was stored while the flag was on.
