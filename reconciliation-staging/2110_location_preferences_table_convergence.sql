-- 2110_location_preferences_table_convergence.sql
--
-- STATUS: STAGED — NOT APPLIED. reconciliation-staging/, outside canonical.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- BLOCKED ON: Q1 (relation census), Q2 (column shape)
--
-- Q1 must confirm whether ONE or BOTH of `location_preferences` and
-- `user_location_preferences` exist live. `0131_location_mode_check_update.sql`
-- (canonical) proves `location_preferences.location_mode` is live as `text`
-- — a text-column CHECK constraint operation only works against root's
-- `0032` shape, not canonical's invalid-enum shape — so `location_preferences`
-- existing live, in root's shape, is strong evidence rather than a guess.
-- Whether `user_location_preferences` (legacy's separate table) ALSO exists
-- is unconfirmed and is exactly what Q1 resolves; this file's precondition
-- treats its absence as a clean no-op, not an error.
--
-- ROLLBACK: derivable (§8 item 9c — backfill + comment, no drop, no
-- NOT NULL relaxed since neither table's columns are being tightened here).
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS RESOLVES
-- ==================
-- RECONCILIATION-PACKET.md §4.3 (MERGED_LIVE_SHAPE) and §7 row 2110. Two
-- tables with overlapping purpose, both from the same nominal migration
-- number (0032) across trees but never unified:
--
--   location_preferences        (root 0032, patched live by canonical 0131)
--     user_id uuid PK REFERENCES profiles(id)
--     location_mode text (vocabulary widened by 0131 to a superset covering
--       both trees' values: off, city_only, nearby, live_during_activity,
--       trusted_circle_live, precise, city)
--     sharing_paused, safe_return_enabled, trusted_circle_share,
--       hotel_blur_enabled boolean
--     pulse_visibility, discovery_visibility text, CHECK'd to
--       {everyone, circle, trip_members, nobody} — a WHO-CAN-SEE vocabulary
--     updated_at timestamptz
--
--   user_location_preferences   (legacy 0032, a wholly separate table)
--     user_id uuid PK REFERENCES auth.users(id)
--     location_mode text, uncontrolled (comment-only vocabulary, a subset of
--       the union above)
--     sharing_paused, safe_return_enabled, trusted_circle_share,
--       hotel_blur_enabled boolean
--     pulse_visibility, discovery_visibility text, uncontrolled — a
--       GRANULARITY vocabulary: city_only, neighborhood, venue_tagged,
--       exact_hidden, no_location, or NULL (inherit from location_mode)
--     updated_at, created_at timestamptz
--
-- WHY THIS FILE DOES NOT BACKFILL pulse_visibility / discovery_visibility
-- ==========================================================================
-- Same column names, INCOMPATIBLE MEANINGS. `location_preferences`'s
-- vocabulary answers "who can see this" (circle / everyone / nobody);
-- `user_location_preferences`'s vocabulary answers "how precisely is this
-- shown" (city_only / exact_hidden / neighborhood) and additionally permits
-- NULL to mean "inherit from location_mode." Copying a value like
-- 'exact_hidden' into a column whose CHECK expects 'circle' would either
-- violate the constraint outright or silently store a nonsense value that
-- reads as a real WHO-can-see decision nobody made. This migration
-- deliberately leaves these two columns at `location_preferences`'s own
-- DEFAULT for any backfilled row rather than translating a value across an
-- incompatible domain — that translation is a product decision, not a
-- schema merge, and is explicitly NOT done here.
--
-- Designating `location_preferences` as canonical (not `user_location_preferences`)
-- because canonical's OWN 0131 already actively depends on and patches it
-- under this exact name — the live app has a demonstrated dependency on
-- `location_preferences`, not on the legacy table.
--
-- INTENDED FINAL STATE
-- =====================
-- Every `user_location_preferences` row without a matching
-- `location_preferences` row gets one inserted, carrying `location_mode`
-- and the four boolean columns across as-is (all confirmed compatible
-- domains), `pulse_visibility`/`discovery_visibility` left at
-- `location_preferences`'s own default, and `updated_at` carried across.
-- `user_location_preferences` is commented deprecated. No DROP of either
-- table or any column.

BEGIN;

-- ── Precondition ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.location_preferences') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.location_preferences does not exist live. This migration designates it canonical; re-derive from Q1 if it is actually absent while user_location_preferences is present.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'location_preferences' AND column_name = 'location_mode'
      AND data_type IN ('text', 'character varying')
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: location_preferences.location_mode is not text live — this migration assumes root''s text shape (proven by 0131''s live CHECK patch), not canonical''s invalid enum shape. Re-derive from Q2.';
  END IF;
END $$;

-- ── The change ───────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.user_location_preferences') IS NULL THEN
    RAISE NOTICE '2110: user_location_preferences does not exist live — nothing to converge, no-op.';
    RETURN;
  END IF;

  INSERT INTO public.location_preferences (
    user_id, location_mode, sharing_paused, safe_return_enabled,
    trusted_circle_share, hotel_blur_enabled, updated_at
  )
  SELECT
    ulp.user_id, ulp.location_mode, ulp.sharing_paused, ulp.safe_return_enabled,
    ulp.trusted_circle_share, ulp.hotel_blur_enabled, ulp.updated_at
  FROM public.user_location_preferences ulp
  WHERE NOT EXISTS (
    SELECT 1 FROM public.location_preferences lp WHERE lp.user_id = ulp.user_id
  )
  ON CONFLICT (user_id) DO NOTHING;

  EXECUTE $c$COMMENT ON TABLE public.user_location_preferences IS
    'Deprecated 2110 — superseded by location_preferences (canonical 0131 actively depends on that name). Rows without a matching location_preferences user_id were backfilled across; pulse_visibility/discovery_visibility were NOT carried across (incompatible vocabularies — see 2110''s header). Not dropped.'$c$;
END $$;

-- ── Postcondition ────────────────────────────────────────────────────────
DO $$
DECLARE
  missing int;
BEGIN
  IF to_regclass('public.user_location_preferences') IS NOT NULL THEN
    SELECT count(*) INTO missing
      FROM public.user_location_preferences ulp
     WHERE NOT EXISTS (
       SELECT 1 FROM public.location_preferences lp WHERE lp.user_id = ulp.user_id
     );
    IF missing > 0 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: % user_location_preferences rows still have no matching location_preferences row after backfill.', missing;
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role no longer has BYPASSRLS.';
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═══════════════════════════════════════════════════════════════════════════
-- No column was dropped or tightened, so there is nothing to structurally
-- reverse. If the backfilled rows in location_preferences need to be
-- removed (e.g. because the merge direction turns out to be wrong), they
-- are identifiable as any location_preferences row whose user_id has a
-- corresponding user_location_preferences row and whose pulse_visibility /
-- discovery_visibility are still at the table default (meaning this
-- migration, not a user, created them):
--   DELETE FROM public.location_preferences lp
--    WHERE EXISTS (SELECT 1 FROM public.user_location_preferences ulp WHERE ulp.user_id = lp.user_id)
--      AND lp.updated_at = (SELECT ulp.updated_at FROM public.user_location_preferences ulp WHERE ulp.user_id = lp.user_id);
-- -- Review this query's matches by hand before running it — it is a
-- -- heuristic, not an exact inverse of the INSERT above.

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run after apply)
-- ═══════════════════════════════════════════════════════════════════════════
-- SELECT count(*) FROM public.user_location_preferences ulp
--  WHERE NOT EXISTS (SELECT 1 FROM public.location_preferences lp WHERE lp.user_id = ulp.user_id);
-- -- expect 0
