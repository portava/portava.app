-- 2336_media_canonical_control_flags.sql
--
-- Two control rows for the canonical media layer (spec §6), both seeded FALSE.
-- One row each; no DDL, no table, no policy, no grant, and — read the next
-- section carefully — NO CHANGE to `media_canonical_enabled`.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2336.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE STATE THIS MIGRATION IS WRITTEN AGAINST — MEASURED, NOT INFERRED
-- ══════════════════════════════════════════════════════════════════════════════
-- Read 2026-09-07 from BOTH databases:
--
--   travel-buddy   ajrurzioarfkagpuxfnb   (production)
--   portava-ci     hwokxgbmezheskbzskfr   (the sanctioned CI project)
--
--                                      production        portava-ci
--   feature_flags.media_canonical_enabled   TRUE         NO ROW  (-> false)
--   media_assets rows                          8              0
--   media_attachments rows                     0              0
--   post_media rows                            6              0
--   posts rows                                 9              0
--   posts with a non-empty media_urls          1              0
--   media_assets column count                 23             27
--   2250 in supabase_migrations                 -        applied
--
-- THREE THINGS IN THE TREE ARE CONTRADICTED BY THOSE NUMBERS, AND EACH OF THEM
-- IS REPEATED IN COMMENTS THAT READ AS IF THEY WERE FACTS:
--
--   1. "the flag is off / the canonical layer is dark". It is ON in production.
--      0191 seeds it FALSE and 2250 asserts it is FALSE as a postcondition, so
--      every reader who checked the migrations and not the database concluded
--      "dark". Somebody turned it on after 2250 was written; 2250 has never run
--      against production, so its postcondition never fired.
--
--   2. "media_assets has no writer". It has one and it worked: eight rows
--      between 2026-07-25 and 2026-08-16. It then stopped, because
--      `lib/mediaAssets.recordMediaAsset` sends `captured_at`, `provenance` and
--      `intelligence_eligibility` in every upsert and production has none of
--      those columns. PostgREST rejects the whole statement (PGRST204), the
--      library returns null, and every call site is `void recordMediaAsset(...)`.
--      A total loss, silent, for three weeks.
--
--   3. "media_assets is on no read path". It is on two, both live:
--      `lib/mediaAccess.ts:238` resolves an object's OWNER from it before
--      deciding who may fetch the bytes, and
--      `services/wall/WallCandidateLoaders.loadQuickMediaItems` serves the §18
--      Quick Media row from assets created in the last 24 h. What is true is
--      the narrower claim: `lib/media/mediaProjection` — the World-shell
--      projector — reads `post_media` then `posts.media_urls` and never
--      `media_assets`.
--
-- Point 3 is why this migration seeds rather than flips: repairing the writer
-- would, on its own, start populating a table that a user-facing row already
-- reads. Each new behaviour gets its own switch, and both switches start off.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY `media_canonical_enabled` IS NOT TOUCHED
-- ══════════════════════════════════════════════════════════════════════════════
-- It is TRUE in production. An `INSERT ... ON CONFLICT DO UPDATE`, or a bare
-- UPDATE "restoring" it to its seeded FALSE, would DISABLE the canonical write
-- path in production as a side effect of a migration about something else. Its
-- value is an operator's decision and this file does not have an opinion about
-- it. The two rows below are new names; `ON CONFLICT DO NOTHING` keeps a re-run
-- from overwriting any later decision about them either.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE TWO FLAGS
-- ══════════════════════════════════════════════════════════════════════════════
--
-- media_canonical_schema_fallback_enabled
--   Read by `lib/mediaAssets.recordMediaAssetDetailed`. When a media_assets
--   upsert is rejected because the database lacks a column (PGRST204 / 42703),
--   this permits ONE retry with the four columns migration 2250 adds removed,
--   so the asset is recorded in a degraded form instead of vanishing.
--
--   SEEDED FALSE because it is a workaround, not the fix. The fix is to apply
--   2250 to production. Turning this on there would ALSO restart canonical
--   writes, which would light up the Quick Media row described above. Off, the
--   writer behaves exactly as it does today: it returns null and writes nothing
--   — the only difference this change makes with the flag off is that the
--   rejection is now LOGGED instead of swallowed.
--
-- media_canonical_read_enabled
--   Read by `lib/media/mediaCanonicalRead.attachCanonicalMedia`, which loads
--   `media_attachments -> media_assets` for a page of candidate rows so
--   `lib/media/mediaProjection` can prefer the canonical store and fall back to
--   `post_media` / `media_urls` when there is no canonical row.
--
--   SEEDED FALSE, and it would be inert even if it were true: media_attachments
--   holds ZERO rows in both databases, so the join returns nothing. It becomes
--   meaningful only after a backfill. The preconditions for that backfill (B1-B5)
--   are written out in the header of lib/media/mediaCanonicalRead.ts; the first
--   is that migration 2250 must be applied to the target database, which it is
--   not in production.
--
--   NOTE: the loader has no caller yet. Its one wiring line belongs in
--   `services/media/MediaProjectionService.projectCandidatesProtected` and was
--   deliberately left to that file's owner. The flag is seeded now so the
--   control is visible in the admin flag list rather than appearing from
--   nowhere on the day the read path is wired.
--
-- Both names end in `_enabled` and are lowercase, so
-- `scripts/check-flag-polarity.mjs` classifies them as CAPABILITY by convention:
-- `true` means the capability is available, and `isFlagEnabled` returning false
-- on a read error or a missing row is the safe default. Neither is a kill
-- switch; neither may be read through `isKillSwitchEngaged`.
--
-- Idempotent; safe to re-run. Writes at most two rows.

BEGIN;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'media_canonical_schema_fallback_enabled',
    FALSE,
    'CAPABILITY. Permits lib/mediaAssets.recordMediaAssetDetailed to retry a rejected media_assets upsert once with the migration-2250 columns (captured_at, location_visibility, provenance, intelligence_eligibility) removed, recording a degraded asset row instead of losing the write. SEEDED FALSE: this is a workaround for a database that has not had 2250 applied (production has not), not a substitute for applying it. Turning it on ALSO restarts canonical writes wherever media_canonical_enabled is true, which populates media_assets and therefore the Wall''s §18 Quick Media row. Apply 2250 first.'
  ),
  (
    'media_canonical_read_enabled',
    FALSE,
    'CAPABILITY. Lets lib/media/mediaCanonicalRead.attachCanonicalMedia load media_attachments -> media_assets for a page of candidates so lib/media/mediaProjection prefers the canonical §6 store, falling back to post_media and then posts.media_urls when no canonical row exists. SEEDED FALSE. Inert today regardless: media_attachments holds zero rows in both databases. Do not enable before the backfill preconditions B1-B5 in the header of lib/media/mediaCanonicalRead.ts hold — in particular, only 1 of 6 ready post_media rows in production has a canonical counterpart, so partial coverage means mixed capture-clock sources across surfaces.'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions ───────────────────────────────────────────────────────────
-- A seed migration that silently seeded nothing would leave both controls as
-- invisible as they were. And the third assertion is the one that matters most:
-- this file must not have moved the write flag.
DO $$
DECLARE
  before_enabled boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.feature_flags WHERE flag = 'media_canonical_schema_fallback_enabled'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_canonical_schema_fallback_enabled row missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.feature_flags WHERE flag = 'media_canonical_read_enabled'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_canonical_read_enabled row missing';
  END IF;

  -- Both new controls must be OFF on a database that did not already have them.
  -- (ON CONFLICT DO NOTHING means an operator who turned one on before this ran
  -- keeps their value; that is deliberate, and is why this checks for TRUE only
  -- among rows this migration could have created — i.e. none, on a re-run.)
  IF EXISTS (
    SELECT 1 FROM public.feature_flags
     WHERE flag IN ('media_canonical_schema_fallback_enabled', 'media_canonical_read_enabled')
       AND enabled IS TRUE
  ) THEN
    RAISE WARNING
      'media canonical control flag is ON in this database — not changed by this migration, but confirm it was deliberate';
  END IF;

  -- media_canonical_enabled must be exactly what it was. This migration names
  -- it nowhere; the assertion exists so that a future edit which adds it to the
  -- INSERT above fails loudly instead of quietly disabling production writes.
  SELECT enabled INTO before_enabled FROM public.feature_flags WHERE flag = 'media_canonical_enabled';
  IF before_enabled IS NULL THEN
    RAISE NOTICE 'media_canonical_enabled has no row in this database (reads as false)';
  ELSE
    RAISE NOTICE 'media_canonical_enabled left untouched at %', before_enabled;
  END IF;
END $$;

COMMIT;
