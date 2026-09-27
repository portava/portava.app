-- 3352_media_perspective_vantage.sql
-- Media — spec §12 perspective GROUPS (census-media §36, MD82–MD85, MD444): a
-- contributor-declared vantage on a post, and ONE capability flag, seeded OFF.
--
-- ── WHAT THE SPEC SAYS ─────────────────────────────────────────────────────
-- §12: "Perspective is a permitted visual contribution showing an aspect of a
-- place or experience", and a table of four entity types with their groups:
--   Nightclub  Entrance · Queue · Street · Main Room · Stage · Bar · VIP · Outside
--   Festival   Main Gate · Stage A · Stage B · Food · Bathrooms · Meeting Area · Exit
--   Beach      Water · Crowd · Weather · Beachfront · Food · Sunset · Access
--   Restaurant Exterior · Entrance · Seating · Food · View · Queue · Menu context
-- The CHECK below is the union of those words (a word shared by two lists —
-- Entrance, Queue, Food — is one value). Nothing is added to them.
--
-- ── WHAT IS ADDED ───────────────────────────────────────────────────────────
--   * posts.perspective_vantage text NULL, CHECKed over the union. NULL for
--     every existing row and for every post that names none. No default, no
--     backfill, no index (it is read by post id, a primary-key lookup).
--   * feature_flags 'media_perspective_vantage_enabled', seeded FALSE.
--
-- ── WHAT THE FLAG GATES (lib/media/perspectiveVantage) ──────────────────────
-- OFF / absent / unreadable (the seed): POST /posts refuses a vantage
-- (feature_disabled) and writes nothing; no projection reads the column; the
-- contribution sheet offers none. ON: the contributor may name one of the
-- §12 groups for the category they say the media shows; the place page groups
-- by it; a vantage is served ONLY where the viewer may be told the place.
-- Because this migration creates both the column and the flag row, "flag on"
-- implies "column exists" — the read never names a column the database lacks.
--
-- ── RUNTIME EFFECT OF APPLYING: NONE, AND THAT IS CHECKED ──────────────────
-- ADD COLUMN … NULL with no default is a catalog-only change (no rewrite). The
-- postconditions refuse a seed that finds the flag ON and report how many rows
-- carry a vantage (0 on a first apply).
-- Rollback: db/rollback/2026-09-27-3352-media-perspective-vantage-rollback.sql
-- NOT applied to any database by the lane that wrote it.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.posts') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.posts does not exist.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist.';
  END IF;
END $$;

ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS perspective_vantage text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'posts_perspective_vantage_check'
      AND conrelid = 'public.posts'::regclass
  ) THEN
    ALTER TABLE public.posts ADD CONSTRAINT posts_perspective_vantage_check CHECK (
      perspective_vantage IS NULL OR perspective_vantage = ANY (ARRAY[
        -- Nightclub
        'entrance', 'queue', 'street', 'main_room', 'stage', 'bar', 'vip', 'outside',
        -- Festival
        'main_gate', 'stage_a', 'stage_b', 'food', 'bathrooms', 'meeting_area', 'exit',
        -- Beach
        'water', 'crowd', 'weather', 'beachfront', 'sunset', 'access',
        -- Restaurant
        'exterior', 'seating', 'view', 'menu_context'
      ]::text[])
    );
  END IF;
END $$;

COMMENT ON COLUMN public.posts.perspective_vantage IS
  'Spec §12 perspective group the CONTRIBUTOR named for this post (census-media §36): one of the four §12 vocabularies, chosen by the category the media shows. Written only while media_perspective_vantage_enabled; served only where the viewer may be told the place.';

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'media_perspective_vantage_enabled',
    false,
    'Media (census-media §36, MD82–MD85): §12 perspective groups. ON: POST /posts accepts perspectiveVantage — one of the §12 groups for the category the contributor says the media shows (nightlife→Nightclub, festival→Festival, beach→Beach, food→Restaurant) — the Media Contribution sheet offers them, and a place page groups its perspectives by the declared vantage. A vantage is served only where the viewer may be told the place. OFF / absent / unreadable (the seed): the write refuses a vantage and writes nothing, no read names the column, and the sheet offers none.'
  )
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE present int; on_count int; col int; carrying bigint;
BEGIN
  SELECT count(*) INTO col FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'posts' AND column_name = 'perspective_vantage';
  IF col <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: posts.perspective_vantage missing';
  END IF;

  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'media_perspective_vantage_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected media_perspective_vantage_enabled present, found %', present;
  END IF;

  SELECT count(*) INTO carrying FROM public.posts WHERE perspective_vantage IS NOT NULL;
  RAISE NOTICE '3352: posts.perspective_vantage present; % post(s) carry a vantage on this database (0 on a first apply).', carrying;

  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'media_perspective_vantage_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_perspective_vantage_enabled is ON — offering vantages is an owner decision and this must ship OFF';
  END IF;
END $$;

COMMIT;
