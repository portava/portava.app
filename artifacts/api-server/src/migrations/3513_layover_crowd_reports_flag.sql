-- 3513_layover_crowd_reports_flag.sql
--
-- SEED `layover_crowd_reports_enabled` AS A ROW, **TRUE**.
--
-- Creates no table. Alters nothing that exists. Moves no row. Seeds ONE flag,
-- ON, so that a channel which is ALREADY SERVING can be turned OFF through the
-- audited toggle path.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THIS FILE EXISTS
-- ══════════════════════════════════════════════════════════════════════════════
-- The traveller crowd-report channel is two routes in `routes/airport.ts`:
--
--   GET  /api/airport/sessions/:id/observations   (the reconciled reading)
--   POST /api/airport/sessions/:id/observations   (a traveller's own report,
--                                                  written to
--                                                  airport_fact_observations
--                                                  via submitTravellerObservation)
--
-- Until this file their ONLY capability gate was `requireOwnedSession`, which
-- reads `airport_mode_enabled` — the flag that gates the WHOLE Layover router:
-- sessions, stops, plans, crew, the dashboard, everything. Migration 0127
-- (`0127_layover_system.sql`) seeds `airport_mode_enabled` TRUE, so the
-- crowd-report channel is live in production today.
--
-- That left the repository with no way to answer the one operational question
-- this channel will eventually ask. A crowd channel fails in ways the rest of
-- Layover does not: a brigading campaign, a single airport whose readings go
-- wrong, a plausibility range that turns out to be too wide. The only lever
-- available was `airport_mode_enabled`, and pulling it to stop traveller
-- reports would also stop a traveller mid-connection from seeing their own
-- plan. "Turn off crowd reports" and "turn off Layover" must not be the same
-- switch, and before this file they were.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THIS ONE IS SEEDED **TRUE**, AGAINST THE CONVENTION OF ITS SIBLINGS
-- ══════════════════════════════════════════════════════════════════════════════
-- Every layover/creator flag seeded in this family — 2981
-- (`layover_event_ingest_enabled`), 2971 (`layover_discovery_mode_enabled`),
-- 2922 (`creator_attribution_enabled`), 3465 (`layover_place_dwell_enabled`) —
-- is seeded FALSE, and each of those files argues for FALSE at length. This one
-- departs from that convention deliberately, and the reason is a difference of
-- FACT, not of appetite:
--
--   THOSE FLAGS GATED SURFACES THAT WERE NOT YET LIVE. 2981's ingest route
--   refused every request before its flag existed and after it, because
--   `isFlagEnabled` reads a missing row as false; the flag's own header says so.
--   2971, 2922 and 3465 are the same shape — the gate was already closed, the
--   row only made it REACHABLE by the audited toggle. For those, FALSE
--   preserved behaviour exactly.
--
--   THIS FLAG GATES A SURFACE THAT IS ALREADY LIVE AND REACHABLE IN PRODUCTION.
--   `airport_fact_observations` exists in production: 2860 created it and 2982
--   (the submission-token idempotency index) and 2983 (the
--   `airport_observation_reported` event) are listed in
--   `src/lib/capability/production-applied-migrations.json`. The POST handler
--   runs. Travellers' reports are being stored and reconciled back right now.
--
-- So for THIS flag, FALSE and "preserve behaviour" point in opposite
-- directions. Seeding FALSE would silently withdraw working behaviour — a
-- traveller who could submit a queue report yesterday would be refused today,
-- dressed up as a safety default. A safety default that removes a live feature
-- is not a safety default; it is an unannounced rollback with a reassuring
-- name, and the fail-closed convention does not license it.
--
-- TRUE preserves today's behaviour EXACTLY: the gate reads TRUE, both handlers
-- behave as they did before this file, nothing a traveller can see changes in
-- either direction. What changes is only that the channel now HAS a switch.
--
-- The purpose of this flag is therefore an INCIDENT LEVER, not a launch gate.
-- Nobody has to decide whether to open the channel — it is open, and that
-- decision was made when `airport_mode_enabled` went TRUE. The decision this
-- flag makes available is the one nobody could make before: close the crowd
-- channel, with an audit row, without closing Layover.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY IT IS A ROW RATHER THAN AN ABSENCE
-- ══════════════════════════════════════════════════════════════════════════════
-- The same argument 2971 and 2981 make, with the polarity reversed. The audited
-- path is `PATCH /api/admin/feature-flags/<flag>`, which goes through the
-- `toggle_feature_flag_with_audit` RPC so that the UPDATE and its audit-log
-- INSERT share one transaction — and it cannot patch a row that does not exist.
-- Without a row, the only way to close this channel in an incident is a direct
-- UPDATE that writes no audit row at all, or an INSERT invented under pressure
-- at 3am with a name nobody can check against the reader. A kill switch you
-- have to create before you can pull it is not a kill switch.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE POLARITY OF THE READER, WHICH IS WHY TRUE IS SAFE TO SEED
-- ══════════════════════════════════════════════════════════════════════════════
-- Both handlers read this flag with `isFlagEnabled` (lib/featureFlags.ts),
-- which is fail-closed: an error, an absent row, or an unreadable
-- `feature_flags` all read FALSE and the handlers REFUSE with
-- `degraded_unavailable`. It is deliberately NOT read with
-- `isKillSwitchEngaged` despite the word "kill switch" above: the flag's name
-- carries positive polarity (`..._enabled`), so the capability reader is the
-- one its name demands, and an unreadable flag closes the channel rather than
-- opening it. Seeding TRUE therefore does not make the gate fail OPEN — the
-- seeded VALUE is the steady state, and the FAILURE state is still closed.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- SHAPE
-- ══════════════════════════════════════════════════════════════════════════════
-- Deliberately the same as 2981_layover_event_ingest_flag.sql: precondition on
-- the table, on the ON CONFLICT arbiter and on the store this channel writes;
-- INSERT ... ON CONFLICT (flag) DO NOTHING; then postconditions asserting
-- present AND — the one inversion — ON. Re-runnable.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
DECLARE conflict_target_ok boolean;
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3513): public.feature_flags does not exist.';
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
    RAISE EXCEPTION 'PRECONDITION FAILED (3513): public.feature_flags has no UNIQUE or PRIMARY KEY on (flag) alone, so ON CONFLICT (flag) has no arbiter to infer.';
  END IF;

  -- A flag gating a channel whose store does not exist is a gate with nothing
  -- behind it, and — worse for THIS flag — a TRUE seed asserting that a live
  -- surface exists when it does not. 2860 created the table and 2982/2983 are
  -- the submission half; this asserts the store is there rather than assuming
  -- the claim this file's header makes about production.
  IF to_regclass('public.airport_fact_observations') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3513): public.airport_fact_observations does not exist. Apply 2860_layover_airport_truth_and_events.sql, then 2982_layover_traveller_observation_submissions.sql and 2983_layover_events_observation_reported.sql, first -- this flag gates the traveller crowd-report channel that writes that table, and seeding it TRUE here would assert a live surface that is not there.';
  END IF;
END $$;

-- ── Seed (CAPABILITY, **ON** — see the header's departure argument) ───────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'layover_crowd_reports_enabled',
    true,
    'Layover traveller crowd reports: when ON (the seed), GET /api/airport/sessions/:id/observations serves the reconciled per-airport reading and POST the same path accepts a signed-in traveller''s own report, screens it, and stores it in airport_fact_observations via submitTravellerObservation. OFF: both handlers refuse with degraded_unavailable and NOTHING is written -- the read serves no reading and the write reaches no store. SEEDED TRUE ON PURPOSE, against the FALSE convention of 2981/2971/2922/3465: those flags gated surfaces that were NOT yet live, so FALSE preserved behaviour; this channel is ALREADY live and reachable in production under airport_mode_enabled (0127, seeded TRUE) with 2860/2982/2983 applied, so seeding FALSE would silently withdraw working traveller behaviour dressed as a safety default. This flag is an INCIDENT LEVER, not a launch gate: it exists so the crowd channel can be closed -- for brigading, for a bad plausibility range, for one airport gone wrong -- WITHOUT pulling airport_mode_enabled and taking all of Layover down with it. Fail-closed (isFlagEnabled): an absent row or an unreadable feature_flags reads FALSE and both handlers refuse, so a TRUE seed is the steady state and not a fail-open gate. Read by services/layover/LayoverObservationService.ts (LAYOVER_CROWD_REPORTS_FLAG, literal name) and enforced in both observation handlers in routes/airport.ts -- NOT in requireOwnedSession, which the whole Layover router shares. Seeded as a row so the audited toggle path (PATCH /api/admin/feature-flags, via toggle_feature_flag_with_audit) can reach it; before this the only way to close the channel was a direct UPDATE that writes no audit row, or inventing a row under incident pressure.'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions (present, ON, and no near-miss spelling) ──────────────────
DO $$
DECLARE present int; off_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
   WHERE flag = 'layover_crowd_reports_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3513): expected layover_crowd_reports_enabled present exactly once, found %', present;
  END IF;

  -- THE INVERSION. 2981 asserts its flag is OFF; this asserts ON, for the
  -- reason the header gives: the channel is already serving, so an OFF row here
  -- is not a cautious default, it is this migration having silently switched a
  -- live traveller surface off. If this fires on a re-run, somebody turned the
  -- channel off deliberately (ON CONFLICT DO NOTHING preserves their decision)
  -- and this file must NOT be re-applied to overwrite it -- confirm the
  -- incident is over and re-enable through PATCH /api/admin/feature-flags so
  -- the re-opening gets its audit row.
  SELECT count(*) INTO off_count FROM public.feature_flags
   WHERE flag = 'layover_crowd_reports_enabled' AND enabled IS NOT TRUE;
  IF off_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3513): layover_crowd_reports_enabled is not TRUE. This file seeds it ON because the crowd-report channel is ALREADY live under airport_mode_enabled; an OFF row means either this migration withdrew working traveller behaviour, or an operator turned the channel off and this file is being re-run over their decision. Do not force it ON here -- re-enable through the audited toggle path so the change is in the audit log.';
  END IF;

  -- The near-miss names. LAYOVER_CROWD_REPORTS_FLAG is the literal
  -- 'layover_crowd_reports_enabled'; a row under any other spelling is a gate
  -- no code can reach, which is the defect 2922 hit with creator_attribution --
  -- and here it would be worse than inert, because an operator pulling the
  -- wrong name in an incident would watch the channel keep serving.
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag IN ('layover_crowd_report_enabled',
                             'layover_crowd_reports',
                             'layover_observations_enabled',
                             'layover_traveller_reports_enabled')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3513): a row exists under a near-miss spelling of layover_crowd_reports_enabled; no code reads it, so it is a gate nothing can reach and an operator who toggles it in an incident will see the channel keep serving.';
  END IF;
END $$;

COMMIT;

-- REVERSAL (manual):
--   See db/rollback/2026-10-03-3513-layover-crowd-reports-rollback.sql, which
--   is NOT a copy of the sibling pattern and explains why.
--   DELETE FROM public.feature_flags WHERE flag = 'layover_crowd_reports_enabled';
--   NOT safe unconditionally, and this is the mirror image of 2981's reversal.
--   `isFlagEnabled` reads an absent row as FALSE, so deleting this row does NOT
--   restore the state before this file (channel serving) -- it CLOSES the
--   channel, which is the one outcome the seed exists to avoid doing silently.
--   Reverting this migration therefore means: delete the row AND accept that
--   the crowd-report channel is now refused, or revert the route changes in the
--   same breath. The rollback file refuses the halfway state.
