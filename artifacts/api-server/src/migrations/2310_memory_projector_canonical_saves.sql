-- 2310_memory_projector_canonical_saves.sql
-- Repoint the memory projector's PLACE lane at the tables saves actually land in.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2310.
--
-- Idempotent: CREATE OR REPLACE FUNCTION only. No table is created, altered or
-- dropped, no row is written, no flag is flipped, and no reader changes shape.
-- Re-running the file is a no-op. Rolling back means replacing the function with
-- the 2193 body.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY
-- ══════════════════════════════════════════════════════════════════════════════
-- `project_user_memory`'s PLACE lane reads `public.saved_places` — a table with
-- ZERO writers anywhere: no INSERT, no upsert, no RPC, no trigger, in server TS,
-- client TS or SQL. Every save a user has ever made went to one of two OTHER
-- tables. So the PLACE lane has always produced nothing, and because an empty
-- table and an empty result are the same observation, the projector reported
-- success with `collected: 0` forever.
--
-- That single writerless table explains TWO dead surfaces. PR #446 fixed the
-- first (the Map `saved` layer) in TypeScript. This fixes the second: the
-- projector, and therefore the Map `memory` layer downstream of it, which
-- filters on `subject_type = 'place'` and so has never had an eligible subject.
--
-- Pressing `memory_projection` BEFORE this migration produces exactly
-- `{refusal: null, collected: 0}` — the signature that hid the defect. Press it
-- AFTER.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE CANONICAL SOURCE, AND WHY IT IS A UNION
-- ══════════════════════════════════════════════════════════════════════════════
-- Two independent write paths, neither a superset of the other:
--
--   public.wishlist_places        routes/wishlist.ts POST /api/wishlist. Every
--                                 save through TripWishlistPicker: Discovery
--                                 card and detail sheet, place detail, gem
--                                 detail, search, the messages Discovery card,
--                                 and the Map's own long-press save.
--   public.discovery_place_saves  routes/discovery.ts POST
--                                 /api/discovery/community/:id/save — the
--                                 DiscoveryWall bookmark. Writes NOTHING to
--                                 wishlist_places.
--
-- Reading either alone silently under-counts. This is the same union PR #446
-- proved for the Map layer, expressed in SQL against the same id-spaces.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- SUBJECT IDENTITY IS PRESERVED, NOT REDEFINED
-- ══════════════════════════════════════════════════════════════════════════════
-- The existing lane writes `subject_id = saved_places.place_id::text`, and that
-- column is `uuid REFERENCES discovery_places(id)`. So the memory subject space
-- IS `discovery_places.id`, and this migration keeps it exactly. Nothing that
-- cannot be resolved to a `discovery_places.id` becomes a memory subject —
-- substituting a different domain's id would corrupt every downstream join.
--
--   discovery_place_saves.place_id   already a discovery_places.id     -> direct
--   wishlist_places.place_id         TEXT, no FK, four id-spaces:
--     'db/<uuid>'      -> discovery_places.id, else
--                         discovery_places.canonical_location_id (migration 2053)
--     'node|way|relation/<id>' -> discovery_places.osm_id (migration 0086)
--     bare uuid        -> a hidden gem / event / city id in an unnamed space.
--                         Bridges to NOTHING and is DELIBERATELY EXCLUDED: there
--                         is no discovery_places row to be the subject, and
--                         inventing one would fabricate a place that does not
--                         exist.
--
-- The bridge is the SQL twin of lib/placeIdBridge.resolvePlaceIdBridge, which
-- resolves the same three forms with the same precedence.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- DEDUPE
-- ══════════════════════════════════════════════════════════════════════════════
-- Two ways one venue yields several rows, both closed by grouping on the
-- resolved discovery_places.id before insert:
--   * one OSM save writes BOTH tables (wishlist under 'node/123', and
--     discovery_place_saves under the mirror's uuid), and
--   * wishlist_places is UNIQUE(user_id, place_id, list_id), so a place saved to
--     three trips is three rows.
-- `occurred_at` / `last_supported_at` take MIN(saved_at) — the instant the user
-- FIRST saved that venue. A later re-save to another list is the same memory,
-- not a new one, and taking MAX would let re-saving rewrite history.
--
-- SCOPING: every read is `WHERE user_id = p_user_id`, exactly as before. The
-- function is SECURITY DEFINER, so that predicate is the only scoping there is.

CREATE OR REPLACE FUNCTION public.project_user_memory(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_total integer := 0;
  v_sub   integer := 0;
  v_now   timestamptz := now();
BEGIN
  -- ── PLACE ──────────────────────────────────────────────────────────────────
  -- The canonical saved-venue set for this user: both write paths, every
  -- bridgeable id-space, one row per resolved discovery_places.id.
  CREATE TEMP TABLE IF NOT EXISTS _canon_saves (
    place_id uuid PRIMARY KEY,
    saved_at timestamptz NOT NULL
  ) ON COMMIT DROP;
  DELETE FROM _canon_saves;

  INSERT INTO _canon_saves (place_id, saved_at)
  SELECT resolved_id, MIN(saved_at)
  FROM (
    -- (a) DiscoveryWall bookmarks — already in the discovery_places id-space.
    SELECT dps.place_id AS resolved_id, dps.saved_at
    FROM public.discovery_place_saves dps
    WHERE dps.user_id = p_user_id

    UNION ALL

    -- (b) 'db/<uuid>' where the uuid IS a discovery_places.id.
    SELECT dp.id AS resolved_id, wp.saved_at
    FROM public.wishlist_places wp
    JOIN public.discovery_places dp
      ON dp.id = substring(wp.place_id from 4)::uuid
    WHERE wp.user_id = p_user_id
      AND wp.place_id LIKE 'db/%'
      AND substring(wp.place_id from 4) ~
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

    UNION ALL

    -- (c) 'db/<uuid>' where the uuid is a public.places id, mirrored by
    --     discovery_places.canonical_location_id (migration 2053).
    SELECT dp.id AS resolved_id, wp.saved_at
    FROM public.wishlist_places wp
    JOIN public.discovery_places dp
      ON dp.canonical_location_id = substring(wp.place_id from 4)::uuid
    WHERE wp.user_id = p_user_id
      AND wp.place_id LIKE 'db/%'
      AND substring(wp.place_id from 4) ~
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

    UNION ALL

    -- (d) OSM saves, bridged by discovery_places.osm_id (migration 0086). The
    --     mirror row is created lazily on first save, so a save made before its
    --     mirror existed resolves on the NEXT projection pass rather than never.
    SELECT dp.id AS resolved_id, wp.saved_at
    FROM public.wishlist_places wp
    JOIN public.discovery_places dp ON dp.osm_id = wp.place_id
    WHERE wp.user_id = p_user_id
      AND (wp.place_id LIKE 'node/%' OR wp.place_id LIKE 'way/%' OR wp.place_id LIKE 'relation/%')
    -- A bare uuid reaches no branch: it has no discovery_places subject.
  ) AS unioned
  GROUP BY resolved_id;

  INSERT INTO public.memory_events
    (user_id, event_type, occurred_at, subject_type, subject_id, source, visibility, source_ref)
  SELECT p_user_id, 'saved_place', cs.saved_at, 'place', cs.place_id::text, 'explicit', 'private',
         jsonb_build_object('table', 'wishlist_places+discovery_place_saves')
  FROM _canon_saves cs
  ON CONFLICT (user_id, event_type, subject_type, subject_id, occurred_at) DO NOTHING;

  WITH sp AS (
    SELECT cs.place_id,
           cs.saved_at,
           coalesce(nullif(btrim(dp.name), ''), 'a place') AS place_name,
           nullif(btrim(dp.city), '')                      AS place_city
    FROM _canon_saves cs
    LEFT JOIN public.discovery_places dp ON dp.id = cs.place_id
  ), ins AS (
    INSERT INTO public.memory_projections
      (user_id, memory_type, subject_type, subject_id, content, confidence, provenance, retention_class,
       last_supported_at, valid_from, last_projected_at, visibility, source_event_ids)
    SELECT p_user_id, 'place', 'place', sp.place_id::text,
           'Saved ' || sp.place_name || coalesce(' in ' || sp.place_city, ''), 0.90::real,
           jsonb_build_object('derivation', 'wishlist_places+discovery_place_saves',
                              'support', jsonb_build_object('saved_at', sp.saved_at)),
           'durable_fact', sp.saved_at, sp.saved_at, v_now, 'private',
           coalesce((SELECT array_agg(me.id) FROM public.memory_events me
                     WHERE me.user_id = p_user_id AND me.subject_type = 'place'
                       AND me.subject_id = sp.place_id::text), '{}'::uuid[])
    FROM sp
    ON CONFLICT (user_id, memory_type, subject_type, subject_id) DO UPDATE SET
      content = EXCLUDED.content, provenance = EXCLUDED.provenance,
      last_supported_at = GREATEST(public.memory_projections.last_supported_at, EXCLUDED.last_supported_at),
      last_projected_at = EXCLUDED.last_projected_at, source_event_ids = EXCLUDED.source_event_ids,
      visibility = EXCLUDED.visibility,
      state = CASE WHEN public.memory_projections.state = 'retracted' THEN 'active'
                   ELSE public.memory_projections.state END
    RETURNING 1) SELECT count(*) INTO v_sub FROM ins;
  v_total := v_total + v_sub;

  RETURN v_total;
END
$fn$;

-- ══════════════════════════════════════════════════════════════════════════════
-- POSTCONDITIONS
-- ══════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'project_user_memory';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: public.project_user_memory is absent.';
  END IF;

  IF v_src LIKE '%public.saved_places%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: project_user_memory still reads public.saved_places, which has no writer.';
  END IF;

  IF v_src NOT LIKE '%wishlist_places%' OR v_src NOT LIKE '%discovery_place_saves%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: project_user_memory must read BOTH canonical save tables; neither alone is a superset of the other.';
  END IF;

  IF v_src NOT LIKE '%canonical_location_id%' OR v_src NOT LIKE '%osm_id%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the id-space bridge is incomplete — canonical and OSM saves would be silently dropped.';
  END IF;
END $$;

COMMENT ON FUNCTION public.project_user_memory(uuid) IS
  'Projects a user''s memory events and projections. The PLACE lane reads the UNION of wishlist_places and discovery_place_saves — the two tables saves actually land in — bridged into the discovery_places id-space and deduped per venue on MIN(saved_at). It previously read public.saved_places, which has no writer anywhere, so the lane produced nothing while reporting success. See migration 2310 and PR #446.';
