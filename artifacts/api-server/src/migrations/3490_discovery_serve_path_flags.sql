-- 3490_discovery_serve_path_flags.sql
-- census-discovery §94 (lane W11-X2, serve path): TWO capability flags, seeded
-- OFF. Two flags in one file because both are serve-path changes from the same
-- lane and range; each has its own switch and its own reader, so either can be
-- turned on or rolled back alone.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane W11-X2,
-- range 3490-3494). APPLIED TO NO DATABASE by the lane that wrote it other than
-- the local PostgreSQL 16 harness.
--
-- Additive + idempotent. Safe to re-run. `*_enabled` ⇒ CAPABILITY convention:
-- read fail-closed through lib/featureFlags.isFlagEnabled, as a literal at the
-- read site, so an absent row, a resolved error and a thrown client all read OFF.
--
-- ── WHAT EACH GATES ─────────────────────────────────────────────────────────
-- `discovery_community_byline_canonical_enabled` (C19, register D-W11X2-3).
--   ON:  GET /discovery/community emits `submittedBy.name` in the canonical
--        display-name shape: the real name iff the submitter is the viewer or
--        opted in (profile_privacy_settings.show_real_name), else NULL — never
--        the literal `@username`. The handle keeps travelling in `handle`.
--   OFF / absent / unreadable (the seed): the legacy `name`, byte for byte
--        (src/test/discoveryCommunityBylineCanonical.test.ts G0/G1).
--   Turning it on changes what shipped app builds that still render `name` raw
--   print, so it waits on the oldest supported build carrying
--   features/discovery/communityByline.ts (census §60.8 Q2): production
--   activation, register entry AR-W11X2-1 (APPROVAL REQUIRED).
-- `discovery_platform_graph_provenance_enabled` (DC-17, register D-W11X2-4).
--   ON:  where the platform's coverage store answers the city reading
--        (CPV2-12), the served graph reading records its own four `10` §5 facts
--        (lib/discoveryPlatformGraphProvenance.ts), read only under 3484 with
--        the ranking modifiers on. Provenance only: no score or order moves.
--   OFF / absent / unreadable (the seed): `{ status: "platform_producer" }`, as
--        before, and no coverage snapshot is re-read.
--
-- ── RUNTIME EFFECT OF SEEDING: NONE, AND THAT IS CHECKED ───────────────────
-- Seeded FALSE; the postcondition refuses a seed that finds either ON. Absent
-- and FALSE read the same, so an unapplied 3490 and an applied one behave alike.
--
-- Rollback: db/rollback/2026-09-28-3490-discovery-serve-path-flags-rollback.sql
-- (deletes each row while it is still FALSE, and this file's ledger row).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3490): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'discovery_community_byline_canonical_enabled',
    false,
    'census-discovery §94 (C19): ON makes GET /discovery/community emit submittedBy.name in the canonical shape — the real name iff the submitter is the viewer or opted in, else null, never @username. OFF / absent / unreadable (the seed): the legacy name, byte for byte. Shipped builds that render name raw would print nothing for a withheld name, so turning it on waits on the oldest supported build carrying communityByline.ts (register AR-W11X2-1).'
  ),
  (
    'discovery_platform_graph_provenance_enabled',
    false,
    'census-discovery §94 (DC-17): ON records the platform coverage reading''s own model version, feature version, source window and computation time on served rows (lib/discoveryPlatformGraphProvenance.ts), under 3484 with the ranking modifiers on. Provenance only; nothing ranks on it. OFF / absent / unreadable (the seed): platform_producer with no facts, as before.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag IN ('discovery_community_byline_canonical_enabled', 'discovery_platform_graph_provenance_enabled');
  IF present <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3490): expected both flags present, found %', present;
  END IF;

  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag IN ('discovery_community_byline_canonical_enabled', 'discovery_platform_graph_provenance_enabled') AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3490): % of the two §94 flags is ON — enabling either is production activation (register AR-W11X2-1 for the byline), and this must ship OFF', on_count;
  END IF;
END $post$;
