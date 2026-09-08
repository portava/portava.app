-- 2610_map_trip_projection_anchor.sql
--
-- THE MAP ANCHOR — the one field the §19.4 trip projection could not give the
-- Map, plus the flag that lets the Map read the projection at all.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2610 (Map).
-- Additive + idempotent. Safe to re-run.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THIS EXISTS: 2520 SHIPPED A PRODUCER WITH NO CONSUMER
-- ══════════════════════════════════════════════════════════════════════════════
-- 2520 built the projection worker — trip_outbox drained into
-- trip_map_projections in aggregate_version order, idempotent by event_id,
-- with a rebuild path — and said so in its own header:
--
--   "Whether the map's trip_stop layer should read this table instead of
--    canonical `trips` is a product decision NOT taken here."
--
-- Nothing took it, so routes/mapProjection.ts kept deriving the trip_stop
-- layer from canonical `trips` at request time and the projection had no
-- reader at all. lib/mapProjectionTripRead.ts is now that reader. This
-- migration supplies the ONE thing it needs and 2520 deliberately withheld.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE MISSING FIELD, EXACTLY: A PIN IS A COORDINATE
-- ══════════════════════════════════════════════════════════════════════════════
-- 2520's `body` is COORDINATE-FREE on purpose (§5.3 strips lat/lng from every
-- event; §14.4 forbids sensitive anchors in broad social projections). It
-- carries `has_destination_coordinates` — enough to know a trip COULD be
-- pinned, not enough to pin it. lib/mapProjection.projectTrip returns null
-- without destinationLat/destinationLng, so a Map reading only 2520's body
-- would serve an EMPTY trip layer forever, which on a map is indistinguishable
-- from "you have no trips". That is the exact silent-nothing this whole chain
-- exists to end.
--
-- Three ways to close it were available. This file takes the third:
--
--   (a) let the reader fetch coordinates from canonical `trips` behind the
--       projection's back. REJECTED: the projection would stay decorative —
--       the canonical read is still on the request path, so the read model
--       closes no census row and its failure modes are still untested in
--       production.
--   (b) put the coordinates in 2520's `body`. REJECTED: `body` is the §14.1
--       envelope, it is regenerated verbatim by the rebuild path, and a
--       capability probe cannot see inside a jsonb value — the readiness gate
--       this chain depends on would have nothing to name.
--   (c) THIS FILE: a MAP-OWNED anchor as REAL COLUMNS on the MAP-OWNED
--       projection table, filled by a trigger on the same write 2520's drain
--       already makes. `body` is untouched, byte for byte. The columns are
--       nameable by the capability probe, which is what makes the whole
--       fail-closed design possible.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THIS WIDENS NOTHING
-- ══════════════════════════════════════════════════════════════════════════════
-- * trip_map_projections keeps RLS enabled and NO grant to anon/authenticated
--   (2520 §3, re-asserted in the postconditions here). The anchor is
--   service-role-only, like every other column on the table.
-- * The value is `trips.destination_lat/lng` unchanged — which the CANONICAL
--   path already hands to exactly these viewers, at exactly this precision,
--   through toAuthorizedTripView. The reader applies the same accepted-
--   membership scope and the same `visibility <> 'private'` drop.
-- * §14.4's "sensitive anchors such as hotel/private lodging" are
--   trip_plan_items / accommodation rows. Those are NOT copied here and the
--   body's plan aggregation stays a COUNT. The trip destination is the pin the
--   owner already publishes to their crew.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS CHANGES FOR A USER: NOTHING, UNTIL A FLAG IS FLIPPED
-- ══════════════════════════════════════════════════════════════════════════════
-- Three columns on a service-only table, one trigger that fills them, and one
-- flag seeded FALSE. With `map_trip_projection_read_enabled` FALSE (or absent,
-- or unreadable) lib/mapProjectionTripRead takes the CANONICAL branch — the
-- byte-identical code that runs today — and the projection columns are never
-- read. The capability is `FLAG_ENABLED && SCHEMA_CAPABILITY_READY`, so even
-- with the flag ON a database missing these columns keeps the canonical branch
-- and logs the refusal at ERROR.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- DEPENDENCY ORDER — READ BEFORE APPLYING ANYWHERE
-- ══════════════════════════════════════════════════════════════════════════════
--   2334 -> 2337 -> 2420   trips.version, trip_events, trip_outbox
--   2520                   trip_map_projections + the drain/rebuild
--   2610                   THIS FILE
-- Measured 2026-09-07:
--   production (ajrurzioarfkagpuxfnb) has NONE of them (no trips.version, no
--     trip_events, no trip_outbox, no trip_map_projections) and 43 live trips
--     on the canonical path. The precondition below RAISES there; nothing
--     changes, and the Map keeps serving those 43 trips from `trips`.
--   portava-ci (hwokxgbmezheskbzskfr) has 2420 (trip_events, trip_outbox,
--     trips.version) but NOT 2520 — trip_map_projections does not exist and
--     trip_map_projection_worker_enabled has no row. So this file RAISES on CI
--     too until 2520 is applied first.
-- Apply order is therefore 2520 then 2610, on CI first.

BEGIN;

-- ── 0. Preconditions ──────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.trip_map_projections') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.trip_map_projections missing -- apply 2334 -> 2337 -> 2420 -> 2520 first.';
  END IF;
  IF to_regclass('public.trips') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.trips missing.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'trips'
                    AND column_name IN ('destination_lat', 'destination_lng')
                 HAVING count(*) = 2) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: trips.destination_lat / trips.destination_lng missing -- there is no anchor to project.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: feature_flags (0037) missing.';
  END IF;
END $$;

-- ── 1. The Map-owned anchor ───────────────────────────────────────────────────
-- map_contract_version is the READER'S gate, not decoration: a row written
-- before this migration keeps 1 and carries no anchor. The reader refuses the
-- WHOLE layer when it sees a 1, because a row without an anchor drops exactly
-- one pin and a trip layer missing one trip is indistinguishable from a viewer
-- with one fewer trip.
ALTER TABLE public.trip_map_projections
  ADD COLUMN IF NOT EXISTS destination_lat      double precision NULL,
  ADD COLUMN IF NOT EXISTS destination_lng      double precision NULL,
  ADD COLUMN IF NOT EXISTS map_contract_version integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.trip_map_projections.destination_lat IS
  'MAP-OWNED anchor (2610). trips.destination_lat at projection time. The §14.1 body stays coordinate-free; this column exists because lib/mapProjection.projectTrip cannot make a pin without it. Service-role only, like every column on this table.';
COMMENT ON COLUMN public.trip_map_projections.destination_lng IS
  'MAP-OWNED anchor (2610). trips.destination_lng at projection time. See destination_lat.';
COMMENT ON COLUMN public.trip_map_projections.map_contract_version IS
  'MAP-OWNED contract version (2610). 1 = written before the anchor existed (no coordinates); 2 = anchor present and current. lib/mapProjectionTripRead REFUSES the whole trip layer when any row it reads is below 2.';

-- ── 2. The fill, on the same write 2520 already makes ─────────────────────────
-- A BEFORE trigger rather than a rewrite of trip_map_projection_drain /
-- trip_map_projection_rebuild: those two functions carry the §19.4 idempotency
-- and atomic-publish semantics, they are pinned line by line by
-- src/test/mapTripProjectionWorker.test.ts, and re-issuing them to add two
-- assignments would put every one of those invariants back in play for a
-- change that has nothing to do with them. The trigger reads the same
-- canonical `trips` row the drain's own body builder reads, in the same
-- statement, so the anchor is exactly as fresh as the body beside it.
CREATE OR REPLACE FUNCTION public.trip_map_projection_fill_anchor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  SELECT t.destination_lat, t.destination_lng
    INTO NEW.destination_lat, NEW.destination_lng
    FROM public.trips t
   WHERE t.id = NEW.trip_id;
  -- No trip row (impossible under the FK, but a trigger must not assume):
  -- leave the anchor NULL. The reader treats an anchorless row as a trip it
  -- cannot pin and COUNTS it; it never invents a coordinate.
  NEW.map_contract_version := 2;
  RETURN NEW;
END;
$fn$;
COMMENT ON FUNCTION public.trip_map_projection_fill_anchor() IS
  'Fills the MAP-OWNED anchor (2610) on every trip_map_projections write from canonical trips, and stamps map_contract_version = 2. Writes no business state and touches no Trip table.';

DROP TRIGGER IF EXISTS trip_map_projection_anchor ON public.trip_map_projections;
CREATE TRIGGER trip_map_projection_anchor
  BEFORE INSERT OR UPDATE ON public.trip_map_projections
  FOR EACH ROW EXECUTE FUNCTION public.trip_map_projection_fill_anchor();

-- ── 3. Backfill rows 2520's drain already wrote ───────────────────────────────
-- The trigger fires on this UPDATE, so it is the fill, not a second copy of it.
UPDATE public.trip_map_projections SET map_contract_version = map_contract_version
 WHERE map_contract_version < 2;

-- ── 4. Grants: the anchor is service-role only, like the table ────────────────
REVOKE ALL ON public.trip_map_projections FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trip_map_projection_fill_anchor() FROM PUBLIC, anon, authenticated;

-- ── 5. The reader's flag, seeded FALSE ────────────────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('map_trip_projection_read_enabled', false,
   'MAP_TRIP_PROJECTION_READ owner decision. FALSE / absent / unreadable (the seed): GET /api/map/projection builds its trip_stop layer from canonical `trips` + toAuthorizedTripView, exactly as it does today — lib/mapProjectionTripRead takes the canonical branch and never reads trip_map_projections. TRUE: the layer is served from the §19.4 read model (2520 + this file''s anchor) instead — but ONLY if the capability probe also finds every column MAP_TRIP_PROJECTION_COLUMNS names on this database; flag-ON-over-absent-schema falls back to canonical and logs at ERROR (lib/capability). Flipping it also requires trip_map_projection_worker_enabled to be TRUE, or the projection is never fed and the reader serves a stale or empty layer. Two flags, in that order.')
ON CONFLICT (flag) DO NOTHING;

-- ── 6. Postconditions ─────────────────────────────────────────────────────────
DO $$
DECLARE
  n_cols   integer;
  n_stale  integer;
  n_rows   integer;
  n_anchor integer;
  worker   boolean;
BEGIN
  SELECT count(*) INTO n_cols FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'trip_map_projections'
     AND column_name IN ('destination_lat', 'destination_lng', 'map_contract_version');
  IF n_cols <> 3 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected 3 anchor columns, found %', n_cols;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.trip_map_projections'::regclass
                    AND tgname = 'trip_map_projection_anchor' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the anchor trigger is not installed';
  END IF;

  -- The body must still be coordinate-free: this migration must not have moved
  -- the §14.4 line, only added a column beside it.
  IF EXISTS (SELECT 1 FROM public.trip_map_projections
              WHERE body ? 'destination_lat' OR body ? 'destination_lng') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a coordinate reached the §14.1 body';
  END IF;

  -- Nothing may be left below the reader's contract floor, or the reader
  -- refuses the whole layer the first time the flag is flipped.
  SELECT count(*) INTO n_stale FROM public.trip_map_projections WHERE map_contract_version < 2;
  IF n_stale <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % projection row(s) still below map_contract_version 2', n_stale;
  END IF;

  IF has_table_privilege('anon', 'public.trip_map_projections', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('authenticated', 'public.trip_map_projections', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a client role holds a grant on trip_map_projections';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.feature_flags
                  WHERE flag = 'map_trip_projection_read_enabled' AND enabled = false) THEN
    RAISE NOTICE '2610: map_trip_projection_read_enabled was already TRUE on this database (re-run); left as found — that is an owner flip, not this seed.';
  END IF;

  -- Tell the applier the blast radius of a flip on THIS database.
  SELECT count(*), count(*) FILTER (WHERE destination_lat IS NOT NULL AND destination_lng IS NOT NULL)
    INTO n_rows, n_anchor FROM public.trip_map_projections;
  SELECT enabled INTO worker FROM public.feature_flags WHERE flag = 'trip_map_projection_worker_enabled';
  RAISE NOTICE '2610: % projection row(s), % with an anchor. trip_map_projection_worker_enabled = %. If map_trip_projection_read_enabled were flipped ON now, the Map trip layer would serve at most % pin(s) instead of the canonical read.',
    n_rows, n_anchor, coalesce(worker::text, 'ABSENT'), n_anchor;
END $$;

COMMIT;
