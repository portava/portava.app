-- 3359_passport_postcard_cover_nullable.sql
-- Media — a passport postcard may have NO cover (census-media §37.10 item 3).
--
-- Schema only: ONE column loses its NOT NULL. No row is touched, no default
-- changes, no grant or policy changes. Idempotent: DROP NOT NULL on a column
-- that is already nullable is a no-op.
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
-- `passport_postcards.media_url` is the postcard's cover: the public_url of the
-- first post_media file that counts (ready, and not flagged / limited /
-- rejected / removed / owner_deleted — routes/postcards.ts refreshMediaCounts
-- and isCountedPostcardFile). When a moderator holds, rejects or deletes that
-- file, or its owner deletes it, and NO other file of the post counts, there is
-- no file the cover may truthfully point at. With the column NOT NULL
-- (baseline/20260819_baseline_structure.sql, `media_url text NOT NULL`) the
-- only value it can keep is the held or removed file's URL, and the Postcards
-- tab renders that URL as its last fallback (PostcardsTab `card.mediaUrl`).
-- The fail-closed state is NULL: "this postcard has no cover".
--
-- ── EVERY READER OF THE COLUMN, AND HOW IT READS NULL (2026-09-27) ──────────
--   api-server routes/passport.ts mapPostcard (GET /users/:u/passport/postcards)
--     and the owner list (GET /me/passport/postcards): `r.media_url ?? null`.
--   api-server routes/passport.ts PATCH /passport/postcards/:id: returns the
--     row as stored; null passes through.
--   api-server routes/postcards.ts repointPassportCover: reads '' for null and
--     FILLS it once a file counts again.
--   client types/models.ts PassportPostcard.mediaUrl: already `string | null`.
--   client PostcardsTab: `card.mediaUrl` is the last fallback of displayUri,
--     which is already null for every video without a poster.
--   client utils/destinationGrouping.ts, app/destinations/[city].tsx and
--     services/profile.ts enrichPostcard: truthiness checks.
--   No SQL function, view or trigger in the baseline or the migration tree
--   reads the column (can_see_postcard reads status, visibility and the post;
--   2082 rewrote its values once; 2151/2152 grant and fence it by name).
--
-- ── WHAT APPLYING IT CHANGES, ON A DATABASE AS IT STANDS ────────────────────
-- Nothing until the server clears a cover. Before it is applied, that clear is
-- refused by the NOT NULL constraint; the server logs it and leaves the cover,
-- which is exactly today's behaviour.
-- Rollback: db/rollback/2026-09-27-3359-passport-postcard-cover-nullable-rollback.sql
-- NOT applied to any database by the lane that wrote it.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.passport_postcards') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.passport_postcards does not exist.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'passport_postcards' AND column_name = 'media_url'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.passport_postcards.media_url does not exist.';
  END IF;
END $$;

ALTER TABLE public.passport_postcards ALTER COLUMN media_url DROP NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'passport_postcards'
      AND column_name = 'media_url' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: public.passport_postcards.media_url is still NOT NULL.';
  END IF;
END $$;

COMMIT;
