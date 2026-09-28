-- Rollback for 3468_tag_permission_approval_required.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3468 DID: added 'approval_required' to public.tag_permission_level, and
-- inserted two FALSE flags.
-- WHAT THIS ROLLBACK DOES:
--   * REFUSES while either flag is TRUE, and while ANY profile holds
--     'approval_required' — that value is a setting a user chose, and removing
--     it would have to rewrite their consent to something they did not choose.
--     The operator decides what those users' setting becomes, deliberately,
--     before this runs.
--   * rebuilds the enum without the value (PostgreSQL cannot DROP an enum
--     value): rename, create the four-value type, move profiles.tag_permission
--     across with its NOT NULL DEFAULT 'anyone', drop the old type.
--   * deletes the two flag rows and 3468's ledger row.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag IN ('tag_permission_approval_required_enabled', 'tag_permission_consent_copy_enabled') AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3468): a tagging flag seeded by 3468 is TRUE. Turn it off deliberately first.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE tag_permission::text = 'approval_required') THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3468): a profile holds approval_required, a setting its user chose. Decide those users'' setting deliberately first.';
  END IF;
END $$;

ALTER TABLE public.profiles ALTER COLUMN tag_permission DROP DEFAULT;
ALTER TYPE public.tag_permission_level RENAME TO tag_permission_level_3468;
CREATE TYPE public.tag_permission_level AS ENUM ('anyone', 'interacted', 'friends_only', 'nobody');
ALTER TABLE public.profiles
  ALTER COLUMN tag_permission TYPE public.tag_permission_level USING tag_permission::text::public.tag_permission_level;
ALTER TABLE public.profiles ALTER COLUMN tag_permission SET DEFAULT 'anyone'::public.tag_permission_level;
DROP TYPE public.tag_permission_level_3468;

DELETE FROM public.feature_flags
 WHERE flag IN ('tag_permission_approval_required_enabled', 'tag_permission_consent_copy_enabled') AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3468_tag_permission_approval_required.sql';

COMMIT;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
              WHERE t.typname = 'tag_permission_level' AND e.enumlabel = 'approval_required') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3468 rollback): approval_required is still a value.';
  END IF;
END $post$;
