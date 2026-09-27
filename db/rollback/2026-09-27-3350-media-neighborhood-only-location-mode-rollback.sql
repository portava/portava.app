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

DELETE FROM public.feature_flags
  WHERE flag = 'media_neighborhood_only_mode_enabled' AND enabled = FALSE;

DO $$
DECLARE present int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'media_neighborhood_only_mode_enabled';
  IF present <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_neighborhood_only_mode_enabled still present after rollback (% row(s))', present;
  END IF;
END $$;

COMMIT;
