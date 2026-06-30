-- ============================================================
-- Migration 0036 — pulse_geo_tags
--
-- Creates the pulse_geo_tags table that attaches location context
-- to Pulse posts. Without this table, all Pulse location tabs
-- (city / nearby / neighborhood) are broken.
--
-- PRIVACY: only public text labels are stored — exact GPS
-- coordinates are NEVER written to this table.
--
-- HOW TO APPLY: paste this entire block into the Supabase
-- SQL Editor and click Run.  The script is fully idempotent
-- (safe to re-run; uses IF NOT EXISTS + DROP POLICY IF EXISTS).
--
-- VERIFY: run the verification query at the bottom after applying.
-- ============================================================


-- ── 1. Table ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.pulse_geo_tags (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id              UUID        NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  user_id              UUID        REFERENCES public.profiles(id) ON DELETE SET NULL,

  -- Public-safe location context (no exact coordinates stored)
  location_visibility  TEXT        NOT NULL DEFAULT 'no_location',
  city                 TEXT,
  district             TEXT,
  country              TEXT,
  country_code         TEXT,
  venue_name           TEXT,

  hotel_blur_applied   BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.pulse_geo_tags IS
  'Location context attached to Pulse posts. '
  'Exact GPS is NEVER stored here — only city/district/country text labels.';


-- ── 2. Indexes ────────────────────────────────────────────────

-- PostgREST uses this to resolve the posts → pulse_geo_tags join
CREATE INDEX IF NOT EXISTS pulse_geo_tags_post_id_idx
  ON public.pulse_geo_tags (post_id);

-- Pulse "city" and "neighborhood" tab filters
CREATE INDEX IF NOT EXISTS pulse_geo_tags_city_idx
  ON public.pulse_geo_tags (city)
  WHERE city IS NOT NULL;

-- Visibility-tab filtering (city_only / neighborhood / venue_tagged)
CREATE INDEX IF NOT EXISTS pulse_geo_tags_visibility_idx
  ON public.pulse_geo_tags (location_visibility);

CREATE INDEX IF NOT EXISTS pulse_geo_tags_user_id_idx
  ON public.pulse_geo_tags (user_id);


-- ── 3. Row Level Security ─────────────────────────────────────

ALTER TABLE public.pulse_geo_tags ENABLE ROW LEVEL SECURITY;

-- Public read: any authenticated or anon client can read geo tags
-- (exact coords are not stored, so this is safe)
DROP POLICY IF EXISTS "pulse_geo_tags_public_read" ON public.pulse_geo_tags;
CREATE POLICY "pulse_geo_tags_public_read"
  ON public.pulse_geo_tags
  FOR SELECT
  USING (true);

-- Service role writes (the API server inserts via service role key,
-- fire-and-forget from POST /posts)
DROP POLICY IF EXISTS "pulse_geo_tags_service_write" ON public.pulse_geo_tags;
CREATE POLICY "pulse_geo_tags_service_write"
  ON public.pulse_geo_tags
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);


-- ── 4. Verification query (run after applying) ────────────────
--
-- Expected results after a clean apply:
--   table_exists  = true
--   row_count     = 0          (no posts existed when this was applied)
--   rls_enabled   = true
--   policy_count  = 2
--
-- SELECT
--   EXISTS (
--     SELECT 1
--     FROM information_schema.tables
--     WHERE table_schema = 'public'
--       AND table_name   = 'pulse_geo_tags'
--   )                                        AS table_exists,
--   (SELECT COUNT(*) FROM public.pulse_geo_tags) AS row_count,
--   relrowsecurity                           AS rls_enabled,
--   (
--     SELECT COUNT(*) FROM pg_policies
--     WHERE tablename = 'pulse_geo_tags'
--   )                                        AS policy_count
-- FROM pg_class
-- WHERE relname = 'pulse_geo_tags'
--   AND relnamespace = 'public'::regnamespace;
