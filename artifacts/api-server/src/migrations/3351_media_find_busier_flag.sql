-- 3351_media_find_busier_flag.sql
-- Media — spec §15 "Find Similar / Cheaper / Quieter / Busier": the Busier half
-- (census-media §36, MD101). ONE capability flag, seeded OFF.
--
-- Additive + idempotent. Safe to re-run. `*_enabled` ⇒ CAPABILITY convention:
-- read fail-closed via isFlagEnabled.
--
-- ── WHAT THIS GATES ─────────────────────────────────────────────────────────
-- `media_find_busier_enabled`. ON:
--   * GET /media/:id/actions offers `find_busier` ("Find somewhere busier")
--     next to Find Quieter / Find Cheaper, under the SAME conditions they have:
--     Compass on, and a canonical place the location/gem choke point lets this
--     viewer be told about. It targets POST /api/compass/ask with the
--     server-written prompt and comparator: 'busier'.
--   * The §32 Compass media context reports a `busier` comparator axis. It is
--     grounded on the SAME claim type as `quieter` — `crowd.level` — because
--     "busier" and "quieter" are the two directions of one reading. Like every
--     axis it carries provenance only (band, source class, observed time, the
--     conflict state), never a value, and an ungrounded axis is printed as
--     "cannot compare".
-- OFF / absent / unreadable (the seed): the action is not offered and the
-- context carries §32's two axes exactly as before.
--
-- ── RUNTIME EFFECT OF SEEDING: NONE, AND THAT IS CHECKED ───────────────────
-- Seeded FALSE; the postcondition refuses a seed that finds it ON. Absent and
-- FALSE read the same, so an unapplied 3351 and an applied one behave alike.
-- Reader: services/media/MediaActionResolver.isFindBusierEnabled (the action
-- rail and the Compass context both ask it).
-- Rollback: db/rollback/2026-09-27-3351-media-find-busier-flag-rollback.sql
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
    'media_find_busier_enabled',
    false,
    'Media (census-media §36, MD101): §15 "Find … Busier". ON: the media action rail offers find_busier beside Find Quieter / Cheaper (Compass on, and only for a place the viewer may be told about), and the §32 Compass media context reports a busier comparator axis grounded on crowd.level, provenance only. OFF / absent / unreadable (the seed): no find_busier action, and the context carries quieter and cheaper only, exactly as before.'
  )
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'media_find_busier_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected media_find_busier_enabled present, found %', present;
  END IF;

  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'media_find_busier_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_find_busier_enabled is ON — offering Find Busier is an owner decision and this must ship OFF';
  END IF;
END $$;

COMMIT;
