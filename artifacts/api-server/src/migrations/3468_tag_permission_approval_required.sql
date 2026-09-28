-- 3468_tag_permission_approval_required.sql
-- `approval_required` ("Ask me first") becomes a value a user can choose, and
-- two tagging capability flags, seeded OFF (census-discovery DV-76, §62.7 Q3,
-- §63.7 Q5, §81; register D-W10S2-8, D-W10S2-9).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane W10-S2,
-- 3465-3469). APPLIED TO NO SHARED DATABASE; rehearsed on the local
-- PostgreSQL 16 harness only.
--
-- ── WHAT ────────────────────────────────────────────────────────────────────
--   tag_permission_level gains 'approval_required'. Nothing is written with it
--   here: every existing profile keeps exactly the setting its user chose. The
--   engine already maps the value to a PENDING tag (canTagPending),
--   TaggingService already writes `pending` for it, and enrichSpans already
--   renders only `approved` tags.
--   `tag_permission_approval_required_enabled` — routes/tags.ts. ON: PATCH
--   /api/me/tag-permission accepts 'approval_required', and POST
--   /api/tags/:id/approve lets the tagged user approve a pending tag. OFF /
--   absent (the seed): the PATCH refuses the value with its old body and the
--   approve route answers feature_disabled.
--   `tag_permission_consent_copy_enabled` — routes/tags.ts → the permission
--   engine's `tagDefinitions: "consent_copy"`. ON: POST /api/tags reads
--   `interacted` and `friends_only` as the settings copy words them, on the
--   arms the engine observes. This is a CONSENT question (APPROVAL REQUIRED,
--   D-W10S2-9): it changes who may tag a user who already chose a setting, so
--   it ships OFF and only the owner turns it on.
--
-- ALTER TYPE … ADD VALUE is not reversible by ALTER TYPE; the rollback rebuilds
-- the type without the value, and REFUSES while any profile holds it.
--
-- Rollback: db/rollback/2026-09-28-3468-tag-permission-approval-required-rollback.sql

DO $pre$
BEGIN
  IF to_regtype('public.tag_permission_level') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3468): public.tag_permission_level does not exist.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3468): public.feature_flags does not exist.';
  END IF;
END
$pre$;

-- Outside a transaction block, so the value is committed before anything reads it.
ALTER TYPE public.tag_permission_level ADD VALUE IF NOT EXISTS 'approval_required';

BEGIN;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'tag_permission_approval_required_enabled',
    false,
    'Tagging: "Ask me first" (census-discovery DV-76, §81, D-W10S2-8). ON: PATCH /api/me/tag-permission accepts approval_required and POST /api/tags/:id/approve lets the tagged user approve a pending tag. OFF / absent (the seed): neither. Turning it ON in production is an owner decision.'
  ),
  (
    'tag_permission_consent_copy_enabled',
    false,
    'Tagging: POST /api/tags reads interacted and friends_only as the settings copy words them (census-discovery DV-76, §63.7 Q5, §81, D-W10S2-9). A CONSENT decision: it changes who may tag a user who already chose a setting. OFF / absent (the seed): the engine''s own reading. Only the owner turns it ON.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

DO $post$
DECLARE on_count int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                  WHERE t.typname = 'tag_permission_level' AND e.enumlabel = 'approval_required') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3468): tag_permission_level lacks approval_required.';
  END IF;
  IF (SELECT count(*) FROM public.feature_flags
       WHERE flag IN ('tag_permission_approval_required_enabled', 'tag_permission_consent_copy_enabled')) <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3468): expected both flags present.';
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag IN ('tag_permission_approval_required_enabled', 'tag_permission_consent_copy_enabled') AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3468): a tagging flag is ON — these must ship OFF';
  END IF;
END $post$;
