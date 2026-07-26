-- 20260811_media_rls.sql
--
-- Harden Row Level Security on the media canonical tables.
--
-- Context: migration 0191_media_assets.sql created media_assets and
-- media_attachments with RLS enabled and owner-read policies.  That was
-- a correct first pass, but it blocked one legitimate read pattern:
--   Public media rows should be readable by authenticated users
--   (needed for the public feed, profile cards, place cards, etc.)
--
-- Security intent: anon (unauthenticated) callers must NOT be able to read
-- any row, even public ones, through a direct Supabase client connection.
-- All public access goes through the API (service-role key, which bypasses
-- RLS). The authenticated role is only issued to verified app clients via
-- Supabase Auth JWTs; the anon role is issued to completely unauthenticated
-- requests.
--
-- Policy additions:
--   media_assets
--     media_assets_owner_select       (existing) — owner reads own rows
--     media_assets_public_select      (new) — authenticated users only read
--                                       rows where visibility = 'public'
--                                       AND moderation_status = 'approved'
--
--   media_attachments
--     media_attachments_owner_select  (existing) — owner via asset join
--     media_attachments_public_select (new) — authenticated users only read
--                                       attachments for public approved assets
--
-- TO authenticated scoping: `TO authenticated` restricts the policy to the
-- `authenticated` role (Supabase Auth JWTs), explicitly excluding the `anon`
-- role.  Anon callers never match any SELECT policy and get 0 rows (RLS
-- returns empty, not an error, per PostgreSQL semantics).
--
-- Note: INSERT / UPDATE / DELETE on these tables is intentionally left to
-- the API service-role key only (no authenticated-role DML policies).

-- ── media_assets: public rows readable by authenticated users only ─────────────

DO $$ BEGIN
  CREATE POLICY media_assets_public_select ON media_assets
    FOR SELECT
    TO authenticated
    USING (
      visibility = 'public'
      AND moderation_status = 'approved'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── media_attachments: public assets' attachments readable by auth users only ──

DO $$ BEGIN
  CREATE POLICY media_attachments_public_select ON media_attachments
    FOR SELECT
    TO authenticated
    USING (
      EXISTS (
        SELECT 1 FROM media_assets a
        WHERE a.id = media_attachments.media_asset_id
          AND a.visibility = 'public'
          AND a.moderation_status = 'approved'
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Ensure RLS is enabled (idempotent no-op if already enabled) ───────────────

ALTER TABLE media_assets      ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_attachments ENABLE ROW LEVEL SECURITY;

-- ── Annotation: role matrix ───────────────────────────────────────────────────
--
--   anon role (unauthenticated callers)
--     → No SELECT policy applies → 0 rows returned (RLS deny).
--     → Direct Supabase reads from an unauthenticated client cannot see any
--       media_assets or media_attachments row.
--
--   authenticated role (Supabase Auth JWT holders)
--     → media_assets_owner_select: own rows (owner_user_id = auth.uid())
--     → media_assets_public_select: public+approved rows (TO authenticated)
--     → media_attachments_owner_select: own assets' attachments
--     → media_attachments_public_select: public+approved assets' attachments
--
--   service_role key (API only)
--     → Bypasses RLS entirely. Unrestricted read/write.
--     → Used by all server-side authorization and eligibility logic.
