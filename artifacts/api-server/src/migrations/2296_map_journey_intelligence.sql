-- 2296_map_journey_intelligence.sql
-- Map spec §36 Phase 6 — Journey Intelligence.
-- Scope taken by the implementing agent 2026-09-05, NOT an owner approval:
-- see docs/map/scope-ruling-phases-6-7.md, which used to claim one and no
-- longer does. The flag below is seeded OFF precisely because the owner
-- decision is the press, and it has not happened.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Map band 2296.
-- (Was 2292; renumbered because 2292 is main's
-- 2292_intel_stmt_trigger_removal_ig_campaign.sql. 2291/2293/2294/2295 are
-- taken by PRs in flight, so this phase took the next free lane.)
--
-- Additive + idempotent. Safe to re-run. Two things, and nothing else:
--
--   1. ONE capability flag, `map_journey_intelligence_enabled`, SEEDED OFF.
--      It gates all three Phase-6 surfaces at once, because they are one
--      capability the owner either has or does not:
--        * the Along My Way corridor filter on GET /api/map/projection
--          (lib/mapCorridor, read in routes/mapProjection.ts),
--        * the group-decision shortlist + accept/decline
--          (lib/journeyGroupDecision, read in routes/mapJourney.ts),
--        * the recovery / Plan-B surface
--          (lib/journeyRecovery, read in routes/mapJourney.ts).
--      Every reader goes through isFlagEnabled, which is fail-closed: an
--      unreadable flag leaves Phase 6 OFF, never silently on.
--
--   2. ONE table, `trip_plan_item_votes`: the accept/decline half of the
--      group decision. There is no existing table that can hold it —
--      `meetup_time_option_votes` votes on a meetup TIME, not on a trip plan
--      item — and a shared decision cannot be derived from per-user state.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT CREATE
-- ================================================
-- A shortlist table. The shortlist IS the trip's existing plan: the
-- `trip_plan_items` rows with status = 'tentative' that the crew already
-- shares, written through the EXISTING plan write path (routes/plan.ts). A
-- second "candidates" table would be a second answer to "what is on this
-- trip", and the boundedness the spec asks for is a CAP enforced at the read
-- (lib/journeyGroupDecision.SHORTLIST_MAX), not a new store.
--
-- A crew/membership table. The crew IS `trip_members`. §36's group decision
-- introduces no social graph, and this migration creates none.
--
-- WHY user_id REFERENCES auth.users AND NOT profiles
-- ==================================================
-- Account deletion keeps an ANONYMISED TOMBSTONE profile, so an ON DELETE
-- CASCADE to public.profiles never fires and the rows would outlive the user
-- (the 2187 lesson, recorded in lib/deletionDispositions.ts). The deletion
-- service DOES call auth.admin.deleteUser, so a cascade to auth.users is a
-- cascade that actually runs — the same reasoning that makes
-- passport_stamps_gps the one entry in ERASED_BY_CASCADE erased by a database
-- constraint rather than by service code. A departed member's votes go with
-- the member; the plan item the crew voted on is trip content and stays.
--
-- RUNTIME EFFECT: NONE. The flag is OFF, so every Phase-6 reader refuses, and
-- the new table has no writer that can run while it is off.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist.';
  END IF;
  IF to_regclass('public.trips') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.trips does not exist.';
  END IF;
  IF to_regclass('public.trip_plan_items') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.trip_plan_items does not exist — the shortlist IS the plan.';
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. trip_plan_item_votes — the accept/decline half of the group decision
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.trip_plan_item_votes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Denormalised from the plan item so a per-trip read (the only read there
  -- is) never has to join through trip_plan_items to scope itself. Kept
  -- honest by trip_plan_item_votes_trip_matches below.
  trip_id       uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  plan_item_id  uuid NOT NULL REFERENCES public.trip_plan_items(id) ON DELETE CASCADE,
  -- See the header: auth.users, because the profiles cascade never fires.
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  vote          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- Accept or decline. Nothing else: an abstention is the ABSENCE of a row,
  -- so a third value would give one state two spellings.
  CONSTRAINT trip_plan_item_votes_vote_check CHECK (vote IN ('accept', 'decline'))
);

-- One vote per member per item. Changing your mind is an UPDATE of your own
-- row, never a second row — otherwise a tally would double-count a member.
CREATE UNIQUE INDEX IF NOT EXISTS trip_plan_item_votes_once
  ON public.trip_plan_item_votes (plan_item_id, user_id);
CREATE INDEX IF NOT EXISTS trip_plan_item_votes_trip
  ON public.trip_plan_item_votes (trip_id, plan_item_id);

-- The denormalised trip_id must equal the plan item's own trip. Without this a
-- vote could be filed under trip A while pointing at trip B's item, and the
-- per-trip read would serve it. Enforced as a trigger rather than a composite
-- FK because trip_plan_items has no (id, trip_id) unique key to reference.
CREATE OR REPLACE FUNCTION public.trip_plan_item_votes_trip_matches()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE item_trip uuid;
BEGIN
  SELECT trip_id INTO item_trip FROM public.trip_plan_items WHERE id = NEW.plan_item_id;
  IF item_trip IS NULL THEN
    RAISE EXCEPTION 'trip_plan_item_votes: plan item % does not exist', NEW.plan_item_id;
  END IF;
  IF item_trip <> NEW.trip_id THEN
    RAISE EXCEPTION 'trip_plan_item_votes: trip_id % does not match plan item trip %', NEW.trip_id, item_trip;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trip_plan_item_votes_trip_matches ON public.trip_plan_item_votes;
CREATE TRIGGER trip_plan_item_votes_trip_matches
  BEFORE INSERT OR UPDATE ON public.trip_plan_item_votes
  FOR EACH ROW EXECUTE FUNCTION public.trip_plan_item_votes_trip_matches();

-- RLS deny-default; REVOKE-first (Supabase default-grants ALL to service_role
-- and SELECT-ish grants to anon/authenticated on new tables). anon and
-- authenticated are revoked EXPLICITLY, not left to a role-inheritance
-- assumption. The table is server-written only: routes/mapJourney.ts holds the
-- membership check, so no PostgREST client may reach these rows at all.
ALTER TABLE public.trip_plan_item_votes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trip_plan_item_votes FROM PUBLIC;
REVOKE ALL ON public.trip_plan_item_votes FROM anon;
REVOKE ALL ON public.trip_plan_item_votes FROM authenticated;
REVOKE ALL ON public.trip_plan_item_votes FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.trip_plan_item_votes TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. The Phase-6 capability flag (CAPABILITY, OFF)
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'map_journey_intelligence_enabled',
    false,
    'Map spec §36 Phase 6 — Journey Intelligence, as ONE switch. OFF (the seed): GET /api/map/projection ignores a corridor= parameter and reports {"refusal":"flag_off"} (its answer is byte-for-byte what it served before Phase 6), and every /api/map/journey/* surface answers enabled:false with empty content. ON: (a) Along My Way — objects the gateway already decided this viewer may see are FILTERED to those within corridorMeters of the viewer''s own route polyline, keeping §31 rank order, each with an explicit detour-cost estimate (lib/mapCorridor); (b) group decision — a bounded shared shortlist over the trip''s existing tentative trip_plan_items with per-member accept/decline in trip_plan_item_votes, crew shown as COARSE AREA LABELS ONLY, never coordinates (lib/journeyGroupDecision); (c) recovery — when a LIVE access/closure/window constraint takes a planned stop out, the next-best alternative in the same category with the reason and its claim ref, via the Compass Plan-B seam (lib/journeyRecovery + compass/CompassLiveConstraints.computePlanB). The corridor can only ever REMOVE objects, so this flag opens no new privacy surface. Fail-closed (isFlagEnabled). Read by routes/mapProjection.ts and routes/mapJourney.ts.'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions ───────────────────────────────────────────────────────────
DO $$
DECLARE present int; on_count int; rls boolean; grantees int;
BEGIN
  -- The flag exists and is OFF.
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'map_journey_intelligence_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected map_journey_intelligence_enabled present, found %', present;
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'map_journey_intelligence_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: map_journey_intelligence_enabled seeded ON — Phase 6 must ship OFF';
  END IF;

  -- The table exists with RLS enabled and no policy (deny-default).
  IF to_regclass('public.trip_plan_item_votes') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: public.trip_plan_item_votes was not created';
  END IF;
  SELECT c.relrowsecurity INTO rls
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'trip_plan_item_votes';
  IF rls IS NOT TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: RLS is not enabled on trip_plan_item_votes';
  END IF;

  -- anon and authenticated hold NO privilege on it.
  SELECT count(*) INTO grantees
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND table_name = 'trip_plan_item_votes'
     AND grantee IN ('anon', 'authenticated', 'PUBLIC');
  IF grantees <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % grant(s) on trip_plan_item_votes remain for anon/authenticated/PUBLIC', grantees;
  END IF;
END $$;

COMMIT;

-- REVERSAL (manual):
--   DROP TRIGGER IF EXISTS trip_plan_item_votes_trip_matches ON public.trip_plan_item_votes;
--   DROP FUNCTION IF EXISTS public.trip_plan_item_votes_trip_matches();
--   DROP TABLE IF EXISTS public.trip_plan_item_votes;
--   DELETE FROM public.feature_flags WHERE flag = 'map_journey_intelligence_enabled';
-- The reversal removes a disabled capability flag and a table nothing can write
-- to while that flag is off; no served data changes.
