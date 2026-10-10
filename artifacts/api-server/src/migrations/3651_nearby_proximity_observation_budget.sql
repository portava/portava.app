-- 3651_nearby_proximity_observation_budget.sql
-- Telegraph §4.3 — the per-RELATIONSHIP observation budget for Nearby (census-telegraph T26).
-- POST-CUTOVER CANONICAL FORWARD MIGRATION. Lane T band 3650-3669.
--
-- Spec §4.3, verbatim: "Do not allow repeated refreshes to become a movement-tracking
-- side channel."
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THE CENSUS FOUND
-- ══════════════════════════════════════════════════════════════════════════════
-- T26 (BUILT-BUT-WRONG): GET /nearby/reachable floors its clock to a 60-second
-- quantum and rate-limits the viewer — both bound a REQUEST. "Still W: the guard is
-- per-request quantisation, not the per-relationship budget §4.5 describes, and
-- nothing bounds observations across a long session." A viewer polling once a minute
-- all day saw every bucket edge a crewmate crossed, timed to the minute.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS CREATES
-- ══════════════════════════════════════════════════════════════════════════════
-- public.nearby_proximity_observations — ONE row per (viewer, person): the proximity
-- the viewer was last SHOWN for that person (bucket, travel band, freshness — the
-- coarse vocabularies of lib/proximityBuckets.ts and services/telegraph/
-- reachablePeople.ts, CHECKed here) and when. services/telegraph/
-- proximityObservationBudget.ts serves that recorded proximity for 15 minutes after
-- it was observed, so a relationship is observed at most 96 times a day however fast
-- anyone polls, from however many instances.
--
-- Data minimisation: no coordinate column (a postcondition refuses one), the latest
-- observation only (the primary key is the pair — there is no history), rows older
-- than 24 hours deleted on the next read by ANY viewer, the pair's row deleted the
-- moment the person stops publishing proximity or leaves the viewer's list, and both user columns CASCADE on account
-- deletion (lib/deletionDispositions.ts ERASED_BY_CASCADE). Service role only: RLS
-- on, no policy, no client privilege.
--
-- No flag. Nearby itself is dark behind nearby_reachable_enabled (absent → OFF), and
-- the route REFUSES (503) when this table cannot be read or written, so on a database
-- without 3651 Nearby cannot serve proximity at all — the safe direction.
--
-- ROLLBACK: db/rollback/2026-10-07-3651-nearby-proximity-observation-budget-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3651): public.profiles must exist.';
  END IF;
END $pre$;

CREATE TABLE IF NOT EXISTS public.nearby_proximity_observations (
  viewer_id   UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  subject_id  UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  bucket      TEXT        NOT NULL
                CHECK (bucket IN ('same_area', 'nearby', 'same_city', 'same_region', 'far', 'unknown')),
  travel      TEXT        NOT NULL
                CHECK (travel IN ('walkable', 'short_ride', 'long_ride', 'out_of_range', 'unknown')),
  freshness   TEXT        NOT NULL
                CHECK (freshness IN ('live', 'recent', 'stale')),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT nearby_proximity_observations_pkey PRIMARY KEY (viewer_id, subject_id),
  CONSTRAINT nearby_proximity_observations_not_self CHECK (viewer_id <> subject_id)
);

CREATE INDEX IF NOT EXISTS nearby_proximity_observations_observed_idx
  ON public.nearby_proximity_observations (observed_at);
CREATE INDEX IF NOT EXISTS nearby_proximity_observations_subject_idx
  ON public.nearby_proximity_observations (subject_id);

ALTER TABLE public.nearby_proximity_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.nearby_proximity_observations FROM PUBLIC;
REVOKE ALL ON public.nearby_proximity_observations FROM anon;
REVOKE ALL ON public.nearby_proximity_observations FROM authenticated;

COMMENT ON TABLE public.nearby_proximity_observations IS
  'Telegraph §4.3 per-relationship observation budget for Nearby (census-telegraph T26, migration 3651). One row per (viewer, person): the bucketed proximity last SHOWN to the viewer and when; served for 15 minutes so a relationship is observed at most once per interval. No coordinate, no history, rows older than 24 h deleted on any viewer''s next read, deleted when the person stops publishing proximity or leaves the viewer''s list. Service role only.';

DO $post$
DECLARE
  coord_cols TEXT;
  rls BOOLEAN;
  client_privs INT;
  policies INT;
  fk_cascades INT;
BEGIN
  IF to_regclass('public.nearby_proximity_observations') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3651): nearby_proximity_observations was not created';
  END IF;

  SELECT string_agg(column_name, ', ') INTO coord_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'nearby_proximity_observations'
     AND column_name ~* '(^|_)(lat|lng|lon|latitude|longitude|location|geom|geog|point|distance|km|meters)($|_)';
  IF coord_cols IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3651): a position column on nearby_proximity_observations: %', coord_cols;
  END IF;

  SELECT relrowsecurity INTO rls FROM pg_class WHERE oid = 'public.nearby_proximity_observations'::regclass;
  IF NOT rls THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3651): RLS is not enabled on nearby_proximity_observations';
  END IF;

  SELECT count(*) INTO policies FROM pg_policies WHERE schemaname = 'public' AND tablename = 'nearby_proximity_observations';
  IF policies <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3651): nearby_proximity_observations carries % polic(ies); service role only means none', policies;
  END IF;

  SELECT count(*) INTO client_privs FROM information_schema.table_privileges
   WHERE table_schema = 'public' AND table_name = 'nearby_proximity_observations' AND grantee IN ('anon', 'authenticated');
  IF client_privs <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3651): anon/authenticated hold % privilege(s) on nearby_proximity_observations', client_privs;
  END IF;

  SELECT count(*) INTO fk_cascades FROM pg_constraint
   WHERE conrelid = 'public.nearby_proximity_observations'::regclass AND contype = 'f' AND confdeltype = 'c';
  IF fk_cascades <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3651): expected 2 ON DELETE CASCADE foreign keys (viewer, subject), found %', fk_cascades;
  END IF;
END $post$;

COMMIT;
