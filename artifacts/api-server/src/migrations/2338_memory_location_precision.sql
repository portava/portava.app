-- 2338_memory_location_precision.sql
--
-- Highlights/Memories Development Architecture Spec v1, §10 and §23:
--
--   §4  LocationPrecision  EXACT, VENUE, NEIGHBORHOOD, CITY, COUNTRY, HIDDEN
--   §10 "Publishing location must never exceed the owner's selected precision."
--   §23 "Exact location and private notes require tighter policies than
--        public-safe summary data."
--   §23 policy function  canSeeExactLocation(userId, memoryId)
--
-- Two artifacts and one flag:
--
--   1. public.memories.location_precision   — the owner's per-Memory ladder rung
--   2. public.memory_public_feed(...)       — the §18 PublicMemoryProjection: a
--                                             pre-filtered, field-narrowed public
--                                             derivative, so the discovery feed
--                                             stops reading canonical storage and
--                                             post-filtering privacy in TypeScript
--   3. memory_location_precision_enabled    — seeded FALSE
--   4. memory_public_feed_projection_enabled— seeded FALSE
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2338.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE STATE THIS MIGRATION IS WRITTEN AGAINST — MEASURED, NOT INFERRED
-- ══════════════════════════════════════════════════════════════════════════════
-- Read 2026-09-07 from BOTH databases:
--
--   travel-buddy   ajrurzioarfkagpuxfnb   (production)
--   portava-ci     hwokxgbmezheskbzskfr   (the sanctioned CI project)
--
--                                       production      portava-ci
--   memories rows                              80               0
--   memory_items rows                          80               0
--   memory_tags rows                            0               0
--   highlights rows                            23               0
--   stories rows                                0               0
--   memories.location_precision            ABSENT          ABSENT
--   feature_flags.memory_projection         FALSE           FALSE
--
-- Production carries 80 live Memories. This migration is therefore written so
-- that NOTHING about them changes: the column is added with a DEFAULT that
-- reproduces exactly today's behaviour ('exact' — the route serves the stored
-- coordinate, subject only to the Hidden-Gem ceiling), and the reader is gated.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THE ROUTE STILL HAS TO ASK THE FLAG BEFORE NAMING THE COLUMN
-- ══════════════════════════════════════════════════════════════════════════════
-- This migration is applied to portava-ci ONLY. Production does not have the
-- column, and in PostgREST one unknown column fails the WHOLE statement — a
-- select list naming `location_precision` returns PGRST100 and the discovery
-- feed goes to zero rows; an insert naming it returns PGRST204 and every
-- Memory creation fails. That is the exact failure class migration 0164
-- documents (highlights.filter_id, message_requests.updated_at, …).
--
-- So `memory_location_precision_enabled` is not a product rollout switch. It is
-- a SCHEMA-PRESENCE switch, in the sense of 2336's
-- media_canonical_schema_fallback_enabled: OFF means "this database does not
-- have the column, do not name it", and every read and write in
-- routes/memories.ts keeps its present shape byte for byte. Turning it ON in a
-- database that has not run this migration breaks the memories routes, which is
-- why the postconditions below assert the column exists in the same
-- transaction that seeds the flag FALSE.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THE LADDER IS DEFINED HERE AND NOT REUSED FROM media_assets
-- ══════════════════════════════════════════════════════════════════════════════
-- lib/mediaLocationVisibility.ts already carries a six-rung ladder
-- (hidden / country / city / neighborhood / place / precise_private) and it is
-- a good one — but it is the MEDIA spec's ladder, it lives on media_assets, and
-- its top rung is an owner-private state rather than a publication rung. The
-- spec's ladder is EXACT -> VENUE -> NEIGHBORHOOD -> CITY -> COUNTRY -> HIDDEN.
-- Mapping one onto the other would make `place` mean VENUE in one table and
-- something else in another. They are kept separate and COMPOSED at read time:
-- lib/memoryLocationPrecision.ts takes the STRICTER of the owner's rung and the
-- Hidden-Gem ceiling, so neither can be used to widen the other.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ══════════════════════════════════════════════════════════════════════════════
-- db/rollback/2026-09-07-2338-memory-location-precision-rollback.sql

BEGIN;

-- ── 1. The owner's per-Memory publication precision ──────────────────────────
--
-- DEFAULT 'exact' is chosen to be a NO-OP, not because EXACT is a good default
-- for a privacy control. Every one of the 80 production rows is served today at
-- the precision the owner stored, and a migration is not the place to decide
-- that they should suddenly be served at city level. What the DEFAULT should be
-- for NEWLY created Memories is an owner product decision, recorded in the
-- report accompanying this migration and deliberately NOT taken here.
ALTER TABLE public.memories
  ADD COLUMN IF NOT EXISTS location_precision text NOT NULL DEFAULT 'exact';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'memories_location_precision_check'
       AND conrelid = 'public.memories'::regclass
  ) THEN
    ALTER TABLE public.memories
      ADD CONSTRAINT memories_location_precision_check
      CHECK (location_precision IN ('exact', 'venue', 'neighborhood', 'city', 'country', 'hidden'));
  END IF;
END $$;

COMMENT ON COLUMN public.memories.location_precision IS
  'Spec v1 §4 LocationPrecision, the owner''s ceiling on how precisely this Memory''s location may be published: exact > venue > neighborhood > city > country > hidden. §10: publishing must never exceed it. The OWNER always sees the stored coordinate; this rung constrains every other viewer. Composed with the Hidden-Gem ceiling by taking the STRICTER of the two (lib/memoryLocationPrecision.ts). DEFAULT ''exact'' reproduces pre-2338 behaviour and is not a recommendation.';

-- ── 2. The §18 PublicMemoryProjection ────────────────────────────────────────
--
-- §10 invariant: "Public search only queries public derivatives, never private
-- canonical storage followed by post-query filtering." §28.6 restates it as a
-- prohibition. routes/memories.ts GET /memories does the forbidden thing today
-- and it is a defect independent of the spec: `.limit(n)` is applied by the
-- database BEFORE the block filter runs in TypeScript, so a page silently
-- shrinks by however many blocked owners it happened to contain, and — worse —
-- the feed never consults `hidden_user_ids` at all, so a viewer the owner
-- explicitly hid reads that owner's public Memory in the global feed. The
-- single-fetch path and the profile listing both check it (via canViewMemory);
-- the feed is the one read path that does not.
--
-- This function is the derivative: every privacy predicate is inside the query,
-- LIMIT applies to the already-filtered set, and the returned column list
-- OMITS `allowed_user_ids` and `hidden_user_ids` entirely — the owner's private
-- audience choices are used as a filter and never leave the database (audit
-- MEM·M2 made the same point about mapMemory; here it is structural).
--
-- SECURITY INVOKER, deliberately. A SECURITY DEFINER function taking a viewer
-- id as a parameter is an authorization oracle: anyone who can execute it can
-- ask "what would user X see". 2182_close_authz_rpc_oracle.sql closed exactly
-- that class of hole for is_blocked/in_accepted_circle. This one runs with the
-- caller's own rights and is granted to service_role only.
DROP FUNCTION IF EXISTS public.memory_public_feed(uuid, integer, timestamptz);

CREATE FUNCTION public.memory_public_feed(
  p_viewer uuid,
  p_limit  integer DEFAULT 30,
  p_cursor timestamptz DEFAULT NULL
)
RETURNS TABLE (
  id                    uuid,
  owner_id              uuid,
  title                 text,
  caption               text,
  visibility            text,
  trip_id               uuid,
  event_id              uuid,
  place_id              text,
  location_city         text,
  location_country      text,
  location_lat          numeric,
  location_lng          numeric,
  canonical_location_id uuid,
  location_precision    text,
  starts_at             timestamptz,
  ends_at               timestamptz,
  state                 text,
  created_at            timestamptz,
  updated_at            timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
  SELECT
    m.id, m.owner_id, m.title, m.caption, m.visibility,
    m.trip_id, m.event_id, m.place_id,
    m.location_city, m.location_country, m.location_lat, m.location_lng,
    m.canonical_location_id, m.location_precision,
    m.starts_at, m.ends_at, m.state, m.created_at, m.updated_at
  FROM public.memories m
  WHERE p_viewer IS NOT NULL
    AND m.state = 'published'
    AND m.visibility = 'public'
    AND (p_cursor IS NULL OR m.created_at < p_cursor)
    -- §10 / audit MEM·M1: a hidden viewer is denied under EVERY visibility mode.
    AND NOT (p_viewer = ANY (m.hidden_user_ids))
    -- §10: blocking suppresses social resurfacing, in both directions.
    AND NOT EXISTS (
      SELECT 1 FROM public.blocks b
       WHERE (b.blocker_id = p_viewer     AND b.blocked_id = m.owner_id)
          OR (b.blocker_id = m.owner_id   AND b.blocked_id = p_viewer)
    )
  ORDER BY m.created_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
$fn$;

COMMENT ON FUNCTION public.memory_public_feed(uuid, integer, timestamptz) IS
  'Spec v1 §18 PublicMemoryProjection. The public discovery derivative over public.memories: visibility/state/hidden/block predicates all run INSIDE the query so LIMIT applies to the filtered set, and allowed_user_ids / hidden_user_ids are never returned. SECURITY INVOKER and service_role-only EXECUTE — it takes a viewer id, so a DEFINER version would be the authorization oracle 2182 closed.';

-- Supabase ALTER DEFAULT PRIVILEGES grants EXECUTE on new functions to PUBLIC,
-- so a narrow GRANT without the REVOKE first is decorative.
-- Canonical pattern: migrations/2217_protected_locations.sql:156-161.
REVOKE ALL ON FUNCTION public.memory_public_feed(uuid, integer, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.memory_public_feed(uuid, integer, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.memory_public_feed(uuid, integer, timestamptz) FROM authenticated;
REVOKE ALL ON FUNCTION public.memory_public_feed(uuid, integer, timestamptz) FROM service_role;
GRANT EXECUTE ON FUNCTION public.memory_public_feed(uuid, integer, timestamptz) TO service_role;

-- ── 3. Control rows, both seeded FALSE ───────────────────────────────────────
--
-- `*_enabled` (lowercase) is the CAPABILITY convention in
-- scripts/check-flag-polarity.mjs, and both are read through
-- lib/featureFlags.isFlagEnabled, which is false-on-error. An unreadable flag
-- therefore leaves both surfaces exactly as they are today.
INSERT INTO public.feature_flags (flag, enabled, description)
VALUES
  ('memory_location_precision_enabled', false,
   'SCHEMA-PRESENCE + CAPABILITY gate for the spec §10 per-Memory location precision ladder (memories.location_precision). OFF (the seed, and the only correct value on a database without migration 2338): routes/memories.ts never names the column in a select or a payload, accepts no locationPrecision input, and applies no clamp — byte-identical to pre-2338 behaviour. ON: the owner''s rung is read, is settable on create/patch, and is composed with the Hidden-Gem ceiling by taking the stricter of the two for every non-owner read. Read fail-closed (isFlagEnabled).'),
  ('memory_public_feed_projection_enabled', false,
   'SCHEMA-PRESENCE + CAPABILITY gate for the spec §18 PublicMemoryProjection. OFF (the seed): GET /memories keeps its TypeScript query path — which 2338''s sibling change also repairs, so the two paths agree on which rows are visible. ON: the feed is served by public.memory_public_feed(), a pre-filtered field-narrowed derivative in which LIMIT applies after the privacy predicates. Read fail-closed (isFlagEnabled).')
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions ───────────────────────────────────────────────────────────
DO $$
DECLARE
  n_bad integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'memories'
       AND column_name = 'location_precision'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memories.location_precision missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'memories_location_precision_check'
       AND conrelid = 'public.memories'::regclass
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memories_location_precision_check missing — an unconstrained text column is not a ladder';
  END IF;

  -- No existing Memory may have been reclassified by this migration.
  SELECT count(*) INTO n_bad FROM public.memories WHERE location_precision <> 'exact';
  IF n_bad > 0 THEN
    RAISE NOTICE '% memories carry a non-exact precision (set deliberately after 2338, not by it)', n_bad;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'memory_public_feed'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: public.memory_public_feed() missing';
  END IF;

  -- The derivative must not be reachable from a client role: it takes a viewer
  -- id, so an anon/authenticated EXECUTE grant would make it an oracle.
  IF has_function_privilege('anon', 'public.memory_public_feed(uuid, integer, timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.memory_public_feed(uuid, integer, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_public_feed is EXECUTE-able by a client role — that is the authorization oracle 2182 closed';
  END IF;

  IF NOT has_function_privilege('service_role', 'public.memory_public_feed(uuid, integer, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role cannot execute memory_public_feed';
  END IF;

  -- Both controls exist, and neither was turned on by this migration.
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'memory_location_precision_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_location_precision_enabled row missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'memory_public_feed_projection_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_public_feed_projection_enabled row missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.feature_flags
     WHERE flag IN ('memory_location_precision_enabled', 'memory_public_feed_projection_enabled')
       AND enabled IS TRUE
  ) THEN
    RAISE WARNING 'a 2338 control flag is ON in this database — not set by this migration (ON CONFLICT DO NOTHING); confirm it was deliberate AND that this database has the column';
  END IF;
END $$;

COMMIT;
