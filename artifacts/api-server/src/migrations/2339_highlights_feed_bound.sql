-- 2339_highlights_feed_bound.sql
--
-- One control row, seeded FALSE. No DDL, no table, no column, no policy,
-- no grant, no function.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2339.
--
-- Highlights/Memories Development Architecture Spec v1 §12:
--   "Highlights should remain finite and contextual. Do not turn the surface
--    into an endless feed."
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE DEFECT THIS FLAG GATES THE FIX FOR
-- ══════════════════════════════════════════════════════════════════════════════
-- GET /highlights/following-feed (routes/highlights.ts) has NO `.limit()` and
-- no pagination. It selects every unexpired, undeleted, non-private highlight
-- belonging to every user the viewer follows, in one query, and returns them
-- all. Its only bound is the 24-hour expiry: for an account following a few
-- thousand active posters the response size is whatever those accounts posted
-- today. Every SIBLING highlight read is bounded — /highlights/active caps at
-- 100 (`limit * 5` over-fetch then `.slice(0, limit)`), and the memories
-- discovery feed caps at 100 — so this is an omission, not a design.
--
-- Measured 2026-09-07: production (ajrurzioarfkagpuxfnb) holds 23 highlight
-- rows in total, so nothing is unbounded in practice TODAY. That is a fact
-- about the current row count, not a property of the code.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THE FIX IS GATED RATHER THAN SHIPPED ON
-- ══════════════════════════════════════════════════════════════════════════════
-- Capping a feed that is currently uncapped can only ever REMOVE highlights
-- from somebody's screen. With 23 rows live no viewer would notice, but "no
-- viewer would notice" is a statement about today's data and the cap is
-- permanent. The size of a finite Highlights surface is a product decision
-- (§12 says finite; it does not say how many), so the code carries both
-- behaviours and an operator chooses.
--
-- OFF (the seed): the route is byte-for-byte what it is today — unbounded,
-- every followed user's active highlights, no cursor.
-- ON: the per-request cap and cursor take effect and the response carries a
-- nextCursor.
--
-- `*_enabled` (lowercase) is the CAPABILITY convention in
-- scripts/check-flag-polarity.mjs; read through lib/featureFlags.isFlagEnabled,
-- which is false-on-error, so an unreadable flag leaves the feed unbounded —
-- i.e. leaves it exactly as it is now, rather than silently truncating.
--
-- ROLLBACK: db/rollback/2026-09-07-2339-highlights-feed-bound-rollback.sql

BEGIN;

INSERT INTO public.feature_flags (flag, enabled, description)
VALUES
  ('highlights_feed_bounded_enabled', false,
   'CAPABILITY gate for the spec §12 finiteness rule on GET /highlights/following-feed. OFF (the seed): the feed is unbounded — every active highlight of every followed user, no limit, no cursor, exactly as before 2339. ON: the feed is capped per request (default 60, max 200) and paginates by a created_at cursor, and the response gains nextCursor. Read fail-closed (isFlagEnabled), so an unreadable flag leaves the feed unbounded rather than silently truncating it.')
ON CONFLICT (flag) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.feature_flags WHERE flag = 'highlights_feed_bounded_enabled'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: highlights_feed_bounded_enabled row missing';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.feature_flags
     WHERE flag = 'highlights_feed_bounded_enabled' AND enabled IS TRUE
  ) THEN
    RAISE WARNING 'highlights_feed_bounded_enabled is ON in this database — not set by this migration (ON CONFLICT DO NOTHING); confirm it was deliberate';
  END IF;
END $$;

COMMIT;
