-- 2411_layover_recommendation_rec_key_backfill.sql
--
-- Give the legacy `layover_recommendations` rows the identity 2410 added, so
-- their moderation state survives the cutover to the stable-identity path.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2410.
-- NOT APPLIED ANYWHERE. Written 2026-09-08 for the owner to run by hand, and
-- only in the window described under WHEN TO RUN THIS. Idempotent (it only ever
-- writes rows whose rec_key IS NULL). Drops nothing, deletes nothing, flips no
-- flag. Rollback: db/rollback/2026-09-08-2411-layover-rec-key-backfill-rollback.sql
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THIS FILE EXISTS
-- ══════════════════════════════════════════════════════════════════════════════
-- 2410 added `rec_key` but backfilled nothing, so every pre-existing row has
-- rec_key NULL. When `layover_stable_recommendation_ids_enabled` is flipped ON,
-- LayoverRecommendationService.generateRecommendations upserts the freshly
-- generated cards on (session_id, rec_key) and then DELETES every row for the
-- session that does not carry a live key — which is every legacy row, because
-- NULL is not a live key and NULLs are distinct in the unique index.
--
-- That sweep is correct: a NULL-keyed row has no identity, so nothing can say
-- which generated card it is. But it means a legacy row's `status` — 'hidden'
-- or 'flagged' set by POST /admin/airport/reports/:id/resolve — is discarded at
-- the moment of cutover, and the card returns as 'active'. An upheld report
-- would silently un-uphold itself.
--
-- This migration closes that window by deriving each legacy row's key from the
-- row's OWN columns using exactly the rule the service uses
-- (LayoverRecommendationService.recommendationKey):
--
--     place_id IS NOT NULL   ->  'place:' || place_id
--     inside_airport         ->  'inside:' || rec_type || ':' || slug(title)
--     otherwise              ->  rec_type || ':' || slug(city) || ':' || slug(title)
--     slug(x) = left(trim(both '-' from regexp_replace(lower(x),'[^a-z0-9]+','-','g')), 80)
--
-- This is RE-DERIVATION, not text matching. It recomputes a deterministic
-- function of the row's stored fields; it never compares one row's text to
-- another row's text to decide they are "the same card". Two rows that merely
-- read alike (two different discovery places with the same name) carry
-- different place_id and therefore different keys.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- MEASURED BEFORE WRITING (production ajrurzioarfkagpuxfnb, 2026-09-08)
-- ══════════════════════════════════════════════════════════════════════════════
--   layover_recommendations                        30 rows
--   ... with rec_key NULL                          30
--   ... with status <> 'active'                     0   <-- nothing to preserve TODAY
--   layover_plan_stops                              0
--   layover_stable_recommendation_ids_enabled   FALSE
--   derived keys, grouped by (session_id, derived): 30 groups of 1 -- NO COLLISION
--
-- So as of 2026-09-08 this migration is a no-op for moderation: it would set 30
-- keys and preserve 0 hides. It is written and left UNAPPLIED deliberately —
-- the count that matters is the one at cutover time, not today's. Run the
-- PRECONDITION QUERY below immediately before flipping the flag; if it reports
-- any legacy row with status <> 'active', this migration must run first.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHEN TO RUN THIS
-- ══════════════════════════════════════════════════════════════════════════════
--   BEFORE `layover_stable_recommendation_ids_enabled` is flipped ON, and after
--   2410 is applied. The guard below REFUSES to run while the flag is already
--   TRUE: past the flip, a concurrent dashboard GET may already have swept the
--   legacy rows, and racing an in-flight regeneration with a key-assigning
--   UPDATE could make the sweep and the upsert disagree about the same row.
--
-- PRECONDITION QUERY (read-only; run by hand first):
--
--   SELECT count(*) FILTER (WHERE rec_key IS NULL)                          AS legacy_rows,
--          count(*) FILTER (WHERE rec_key IS NULL AND status <> 'active')   AS legacy_moderated
--   FROM public.layover_recommendations;
--
--   legacy_moderated = 0  ->  running this changes no user-visible outcome.
--   legacy_moderated > 0  ->  running this is what keeps those hides upheld.
--
-- POSTCONDITION QUERY (read-only; run by hand after):
--
--   SELECT count(*) AS colliding FROM (
--     SELECT session_id, rec_key FROM public.layover_recommendations
--     WHERE rec_key IS NOT NULL GROUP BY 1,2 HAVING count(*) > 1) c;   -- expect 0
--
--   SELECT count(*) FILTER (WHERE rec_key IS NULL AND status <> 'active')
--   FROM public.layover_recommendations;                                -- expect 0
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── PRECONDITIONS ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.layover_recommendations') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.layover_recommendations missing.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='layover_recommendations' AND column_name='rec_key'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: rec_key missing -- apply 2410 first.';
  END IF;
  IF to_regclass('public.layover_recs_session_key_uidx') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: layover_recs_session_key_uidx missing -- apply 2410 first.';
  END IF;
  -- The gate. Backfilling after the cutover races the live sweep.
  IF EXISTS (
    SELECT 1 FROM public.feature_flags
    WHERE flag = 'layover_stable_recommendation_ids_enabled' AND enabled = TRUE
  ) THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: layover_stable_recommendation_ids_enabled is already TRUE. '
      'This backfill must run BEFORE the cutover; past it, a dashboard GET may already '
      'have swept the legacy rows and an UPDATE here would race an in-flight regeneration.';
  END IF;
END $$;

-- ── THE BACKFILL ─────────────────────────────────────────────────────────────
-- Only rows whose derived key is unambiguous get one:
--   * exactly one legacy row in the session derives that key, AND
--   * no already-keyed row in the session holds it.
-- Anything else keeps rec_key NULL, stays distinct under the unique index (NULLs
-- are distinct), and is swept at cutover exactly as it would have been. Leaving
-- a key off is the safe direction; guessing which of two rows owns it is not.
WITH derived AS (
  SELECT
    r.id,
    r.session_id,
    CASE
      WHEN r.place_id IS NOT NULL THEN 'place:' || r.place_id::text
      WHEN r.inside_airport THEN
        'inside:' || r.rec_type || ':' ||
        left(trim(both '-' from regexp_replace(lower(r.title), '[^a-z0-9]+', '-', 'g')), 80)
      ELSE
        r.rec_type || ':' ||
        left(trim(both '-' from regexp_replace(lower(coalesce(r.city, '')), '[^a-z0-9]+', '-', 'g')), 80) || ':' ||
        left(trim(both '-' from regexp_replace(lower(r.title), '[^a-z0-9]+', '-', 'g')), 80)
    END AS rec_key
  FROM public.layover_recommendations r
  WHERE r.rec_key IS NULL
),
unambiguous AS (
  SELECT d.id, d.session_id, d.rec_key
  FROM derived d
  WHERE d.rec_key IS NOT NULL
    AND 1 = (SELECT count(*) FROM derived d2
              WHERE d2.session_id = d.session_id AND d2.rec_key = d.rec_key)
    AND NOT EXISTS (SELECT 1 FROM public.layover_recommendations x
                     WHERE x.session_id = d.session_id AND x.rec_key = d.rec_key)
)
UPDATE public.layover_recommendations r
   SET rec_key = u.rec_key
  FROM unambiguous u
 WHERE r.id = u.id
   AND r.rec_key IS NULL;   -- idempotent: a re-run matches nothing

-- ── POSTCONDITIONS ───────────────────────────────────────────────────────────
DO $$
DECLARE
  colliding INTEGER;
  still_null INTEGER;
  still_null_moderated INTEGER;
BEGIN
  SELECT count(*) INTO colliding FROM (
    SELECT session_id, rec_key FROM public.layover_recommendations
    WHERE rec_key IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1
  ) c;
  IF colliding <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % duplicate (session_id, rec_key) pairs', colliding;
  END IF;

  SELECT count(*) FILTER (WHERE rec_key IS NULL),
         count(*) FILTER (WHERE rec_key IS NULL AND status <> 'active')
    INTO still_null, still_null_moderated
    FROM public.layover_recommendations;

  -- Not an exception: a row whose derived key was ambiguous is SUPPOSED to keep
  -- rec_key NULL. It is raised as a NOTICE so the operator sees it and can
  -- decide, rather than discovering it after the sweep.
  IF still_null > 0 THEN
    RAISE NOTICE 'BACKFILL NOTICE: % row(s) keep rec_key NULL (ambiguous derivation); % of them carry a non-active status and WILL lose it at cutover.',
      still_null, still_null_moderated;
  END IF;
END $$;

COMMIT;
