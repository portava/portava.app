-- Rollback for 3350_media_neighborhood_only_location_mode.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3350 DID
-- =============
--   * ALTER TYPE public.post_location_privacy_mode ADD VALUE 'neighborhood_only'.
--   * INSERT ONE ROW into public.feature_flags:
--       ('media_neighborhood_only_mode_enabled', false, '<description>')
--     ON CONFLICT DO NOTHING.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
--   1. REFUSES while the flag reads TRUE. The owner has offered the choice since
--      3350 was applied; deleting the row would silently withdraw it from
--      everyone mid-compose. Turn it off deliberately first.
--   2. REFUSES while any post carries location_privacy_mode = 'neighborhood_only'.
--      The code that shipped with 3350 holds such a post at neighborhood. Code
--      from BEFORE it does not know the value: lib/postSchemas.mapPublicPost then
--      fell through to its delayed-publish branch and served the venue name of
--      any published row, and the Watch feed read no mode at all. Rolling the
--      schema back under those posts would publish the place their authors
--      chose to hide. The operator decides what they become. The tier the
--      product offered before 3350 for "hide the exact place" is city, which
--      discloses LESS than neighborhood:
--        UPDATE public.posts SET location_privacy_mode = 'city_only'
--          WHERE location_privacy_mode = 'neighborhood_only';
--      That is a change to users' own choices and this script does not make it.
--   3. Deletes the flag row (only while FALSE).
--
-- WHAT IT DOES NOT DO, AND WHY
-- ============================
-- It does not remove the enum LABEL. PostgreSQL has no ALTER TYPE … DROP VALUE;
-- removing one means creating a new type and rewriting public.posts under an
-- ACCESS EXCLUSIVE lock to cast the column across, which is not a rollback step
-- to run casually against the posts table. After steps 1–3 the label is inert:
-- no row carries it (step 2), and no writer can set it — the routes refuse it
-- while the flag is absent, and code from before 3350 does not accept it at all.

BEGIN;

DO $$
DECLARE on_count int; using_value bigint;
BEGIN
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'media_neighborhood_only_mode_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION
      'ROLLBACK REFUSED: media_neighborhood_only_mode_enabled is TRUE. The owner has offered "Show neighborhood only" since 3350 was applied. Turn it off deliberately first, then re-run this file.';
  END IF;

  SELECT count(*) INTO using_value FROM public.posts
    WHERE location_privacy_mode = 'neighborhood_only';
  IF using_value <> 0 THEN
    RAISE EXCEPTION
      'ROLLBACK REFUSED: % post(s) carry location_privacy_mode = neighborhood_only. Code from before 3350 would serve their venue names. Decide what they become (see this file''s header) before rolling back.', using_value;
  END IF;
END $$;

-- Only the row 3350 wrote (W10-F, census-discovery §87). 3350 inserts ON
-- CONFLICT (flag) DO NOTHING, so a row that existed before it kept its own
-- description. A row whose description is not 3350's seed text byte for
-- byte (the md5 below) was not written by 3350, and is kept.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag = 'media_neighborhood_only_mode_enabled' AND md5(coalesce(description, '')) <> '087a5481d6b5f93a2b40d2e499e166f9') THEN
    RAISE NOTICE '3350 rollback: media_neighborhood_only_mode_enabled was not written by 3350 (its description is not 3350''s seed), so it is kept.';
  ELSE
    DELETE FROM public.feature_flags
      WHERE flag = 'media_neighborhood_only_mode_enabled' AND enabled = FALSE;
  END IF;
END $$;

DO $$
DECLARE present int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'media_neighborhood_only_mode_enabled' AND md5(coalesce(description, '')) = '087a5481d6b5f93a2b40d2e499e166f9';
  IF present <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_neighborhood_only_mode_enabled (the row 3350 wrote) still present after rollback (% row(s))', present;
  END IF;
END $$;

-- The applier wrote 3350's ledger row in 3350's own transaction; without
-- this delete it would take 3350 as still applied and never re-apply it.
DELETE FROM public.schema_migration_ledger
 WHERE filename = '3350_media_neighborhood_only_location_mode.sql';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3350_media_neighborhood_only_location_mode.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the ledger still records 3350 as applied after rollback.';
  END IF;
END $$;

COMMIT;
