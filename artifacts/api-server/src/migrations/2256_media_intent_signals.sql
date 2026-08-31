-- 2256_media_intent_signals.sql
--
-- Media v2 — Phase 6 (Discovery + Compass, §15.1 "I Want This"). Adds the
-- intent-signal store: a row records that a traveller WANTS the experience a
-- media item represents. It is deliberately NOT a like / save / stamp — those
-- are social engagement (posts_likes, post_saves, content_stamps,
-- media_stamp_reactions) and drive social counts. A want-signal drives DISCOVERY
-- and COMPASS: "what does this traveller want to do", keyed to the media's
-- resolved entity (place / gem / trip). Keeping it in its own table is the whole
-- point — a want is never conflated with an engagement count.
--
-- ADDITIVE + IDEMPOTENT. New table only; no change to posts, hidden_gems, or any
-- engagement table, their columns, policies, grants, or enums.
--
-- GRANT POSTURE: RLS on; authenticated may read ONLY its own rows; anon nothing.
-- No client INSERT/UPDATE/DELETE grant — the signal is written and removed only
-- through the service-role endpoints (POST/DELETE /api/media/:id/intent), which
-- resolve the media's entity server-side and bypass RLS. This mirrors the
-- client-write-grants posture of the sibling observation tables (a want is not a
-- column a client may self-set through PostgREST).
--
-- SAFE TO RE-RUN.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.posts') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.posts missing.';
  END IF;
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.profiles missing.';
  END IF;
END $$;

-- ── media_intent_signals ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS media_intent_signals (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  media_id    UUID        NOT NULL REFERENCES posts(id)    ON DELETE CASCADE,
  -- Coarse entity the intent is about — never a coordinate. entity_id is an
  -- opaque canonical id in the entity_type's own id-space.
  entity_type TEXT        NOT NULL CHECK (entity_type IN ('place','gem','trip','media')),
  entity_id   UUID        NOT NULL,
  intent      TEXT        NOT NULL DEFAULT 'want_to_go'
                          CHECK (intent IN ('want_to_go','want_to_do','want_similar')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One standing intent per (user, media): re-signalling updates it, not stacks.
  UNIQUE (user_id, media_id)
);

CREATE INDEX IF NOT EXISTS media_intent_signals_user_idx
  ON media_intent_signals (user_id);
CREATE INDEX IF NOT EXISTS media_intent_signals_media_idx
  ON media_intent_signals (media_id);
CREATE INDEX IF NOT EXISTS media_intent_signals_entity_idx
  ON media_intent_signals (entity_type, entity_id);

ALTER TABLE media_intent_signals ENABLE ROW LEVEL SECURITY;

-- A want-signal is private to its owner: the caller reads only its own rows.
-- Writes are service-role only (no client INSERT/UPDATE/DELETE grant below).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='media_intent_signals'
      AND policyname='media_intent_own_read'
  ) THEN
    CREATE POLICY media_intent_own_read ON media_intent_signals
      FOR SELECT USING (user_id = auth.uid());
  END IF;
END $$;

-- Client grants: authenticated may read (RLS scopes to own rows); anon nothing.
-- No write grant — signal write/removal is service-role (the intent endpoints).
REVOKE ALL ON TABLE public.media_intent_signals FROM anon;
REVOKE ALL ON TABLE public.media_intent_signals FROM authenticated;
GRANT SELECT ON TABLE public.media_intent_signals TO authenticated;

COMMENT ON TABLE public.media_intent_signals IS
  '§15.1 "I Want This" intent SIGNALS — distinct from likes/saves/stamps. One '
  'standing want per (user, media), keyed to the media''s resolved entity, read '
  'by discovery/Compass as a want-signal. authenticated reads own rows only '
  '(RLS); anon none; writes are service-role via the intent endpoints.';

-- ── Postcondition — prove the table, constraint, and grant posture ───────────
DO $$
DECLARE anon_privs text; auth_privs text;
BEGIN
  IF to_regclass('public.media_intent_signals') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_intent_signals was not created';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.media_intent_signals'::regclass AND contype='u'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: unique (user_id,media_id) missing';
  END IF;

  SELECT COALESCE(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '(none)')
    INTO anon_privs FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='media_intent_signals' AND grantee='anon';
  IF anon_privs <> '(none)' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: anon holds "%", expected no grants', anon_privs;
  END IF;

  SELECT COALESCE(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '(none)')
    INTO auth_privs FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='media_intent_signals' AND grantee='authenticated';
  IF auth_privs <> 'SELECT' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: authenticated holds "%", expected SELECT', auth_privs;
  END IF;
END $$;

COMMIT;

-- REVERSAL (manual):
--   DROP TABLE IF EXISTS public.media_intent_signals;
