-- 3355_media_vision_provider_flag.sql
-- Media — ONE capability flag for the VISION stage (census-media §37: MD63
-- evidence extraction, MD289 "looks social", MD293 "look like this"), seeded OFF.
--
-- Additive + idempotent. Safe to re-run. `*_enabled` ⇒ CAPABILITY convention:
-- read fail-closed via isFlagEnabled.
--
-- ── WHAT THIS GATES ─────────────────────────────────────────────────────────
-- lib/media/vendors/mediaVisionProvider is the vision seam: a typed adapter
-- interface, a REFUSING default, and no implemented adapter (choosing a vision
-- vendor is the owner's decision). This flag gates the two callers:
--   • GET /media/search with `looksSocial=true` or `lookLike=<media id>`
--     (MediaSearchService.searchMediaVisual). OFF: an empty result whose
--     `visual.state` is `stage_off` — never results that ignore the criterion.
--     ON with no adapter: `visual.state = no_provider`, empty.
--   • POST /media/upload's ingestion stage (lib/media/vendors/mediaVendorStages
--     runMediaVendorIngest) hands the stored file to the provider's index.
--     OFF: no call. ON with no adapter: `not_configured`, logged, nothing sent.
--
-- ── WHAT FLIPPING IT ON DOES, ON A DATABASE AS IT STANDS ────────────────────
-- With no adapter configured (MEDIA_VISION_PROVIDER unset or naming nothing
-- implemented), turning this ON changes only the refusal a visual search names
-- (`no_provider` instead of `stage_off`). With an adapter, it sends every new
-- upload's storage reference to that vendor: a data-protection decision about
-- users' photographs, made by the owner, not by this migration.
--
-- ── RUNTIME EFFECT OF SEEDING: NONE, AND THAT IS CHECKED ───────────────────
-- Seeded FALSE; the postcondition refuses a seed that finds it ON. Absent and
-- FALSE read the same, so an unapplied 3355 and an applied one behave alike.
-- Reader: lib/media/vendors/mediaVendorStages.isMediaVisionStageEnabled.
-- Rollback: db/rollback/2026-09-27-3355-media-vision-provider-flag-rollback.sql
-- NOT applied to any database by the lane that wrote it.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'media_vision_provider_enabled',
    false,
    'Media (census-media §37: MD63, MD289, MD293): the vision stage. ON: GET /media/search answers looksSocial / lookLike through the configured vision provider (MEDIA_VISION_PROVIDER), every proposal re-gated by the shared candidate loader; POST /media/upload hands the stored file to the provider''s index. Every provider answer is a candidate (basis visual_inference, verified false) and is never written as an observation. OFF / absent / unreadable (the seed): a visual search is refused by name (visual.state stage_off) with an empty result, and no upload is sent anywhere.'
  )
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'media_vision_provider_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected media_vision_provider_enabled present, found %', present;
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'media_vision_provider_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_vision_provider_enabled is ON — sending users'' photographs to a vision provider is an owner decision and this must ship OFF';
  END IF;
END $$;

COMMIT;
