-- 3467_cross_architecture_flags.sql
-- Two cross-architecture capability flags, seeded OFF, and the corrected
-- description of the abandoned-upload sweep's flag (census-discovery A10, A21,
-- DV-77, §81; register D-W10S2-4, D-W10S2-5, D-W10S2-6).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane W10-S2,
-- 3465-3469). APPLIED TO NO SHARED DATABASE; rehearsed on the local
-- PostgreSQL 16 harness only.
--
-- Additive + idempotent. `*_enabled` ⇒ CAPABILITY convention.
--
-- ── WHAT EACH GATES ─────────────────────────────────────────────────────────
-- `discovery_trip_viewer_projections_enabled` — lib/discoveryTripViewerConsumer.ts.
--   ON: Discovery's plan-item search reads Trips' plan-item projection (the
--   same predicate, stated by Trips), and `?context=going_soon` reads Trips'
--   viewer next-trip projection, which counts `upcoming` trips and trips the
--   viewer joined (§57.10 Q3). OFF / absent / unreadable: the two direct reads,
--   byte-identical.
-- `telegraph_discovery_actions_enabled` — services/telegraph/actionRegistry.ts.
--   ON: POST /api/telegraph/commands/discovery-card proposes the registered
--   `discovery_save_place` action, and its confirmation saves the place through
--   Discovery's own save path. OFF / absent / unreadable: the command answers
--   `feature_disabled` and authorize refuses.
-- `media_pending_upload_sweep_enabled` (3400) — DESCRIPTION ONLY. Its text said
--   "an hour after its slot was reserved"; the rule is now "no activity for
--   2 h 30" (D-W10S2-6). The row's `enabled` is not touched: the UPDATE is
--   guarded to rows whose description still carries 3400's text.
--
-- ── RUNTIME EFFECT OF SEEDING: NONE, AND THAT IS CHECKED ───────────────────
-- Both new flags FALSE; the postcondition refuses either ON.
--
-- Rollback: db/rollback/2026-09-28-3467-cross-architecture-flags-rollback.sql

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3467): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'discovery_trip_viewer_projections_enabled',
    false,
    'Discovery reads Trips'' plan-item and viewer next-trip projections (census-discovery A10, §81, D-W10S2-4). ON: plan-item search through the Trips projection (same predicate); ?context=going_soon counts upcoming and joined trips. OFF / absent (the seed): the direct trips/trip_plan_items reads. Turning it ON in production is an owner decision.'
  ),
  (
    'telegraph_discovery_actions_enabled',
    false,
    'Telegraph executable action on a Discovery object (census-discovery A21, §81, D-W10S2-5): discovery_save_place, proposed by POST /api/telegraph/commands/discovery-card and executed through Discovery''s own save. OFF / absent (the seed): the command is feature_disabled and authorize refuses. Turning it ON in production is an owner decision.'
  )
ON CONFLICT (flag) DO NOTHING;

UPDATE public.feature_flags
   SET description = 'Abandoned-upload sweep (census-discovery DV-77, §56, §81 D-W10S2-6): Phase 0.4, no unstripped original persists because a completion handler never ran. ON: hourly, every post_media row still pending whose latest activity (reservation, a resumable session''s renewal, or its newest part) is older than 2 h 30 — a signed upload URL''s 2 h lifetime plus 30 min for a PUT still in flight — has its original, feed variant, resumable parts and poster removed, then the row deleted (oldest first, 200 a pass; a failed removal keeps the row). An owner still sending is never swept. OFF / absent (the seed): nothing runs. Unreadable: nothing runs and the pass records a failure. Turning it ON deletes never-completed uploads; that is an owner decision.'
 WHERE flag = 'media_pending_upload_sweep_enabled'
   AND description LIKE '%an hour after its slot was reserved%';

COMMIT;

DO $post$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag IN ('discovery_trip_viewer_projections_enabled', 'telegraph_discovery_actions_enabled');
  IF present <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3467): expected both flags present, found %', present;
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag IN ('discovery_trip_viewer_projections_enabled', 'telegraph_discovery_actions_enabled') AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3467): a W10-S2 capability flag is ON — production activation is an owner decision and these must ship OFF';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'media_pending_upload_sweep_enabled'
              AND description LIKE '%an hour after its slot was reserved%') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3467): media_pending_upload_sweep_enabled still describes the one-hour rule.';
  END IF;
END $post$;
