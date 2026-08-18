-- 2107_enable_rls_class_c_internal_caches.sql
--
-- STATUS: STAGED — NOT APPLIED. reconciliation-staging/, outside canonical.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- BLOCKED ON: Q1 (relation census + RLS flag), Q3 (policies with predicates)
--             — the read-path-audit precondition below is RESOLVED, not
--             pending. See "READ-PATH AUDIT" section.
--
-- Q1 must confirm these 11 tables exist live with RLS currently disabled
-- (the packet's own measurement: created in canonical, neither RLS nor
-- policy anywhere in canonical). Q3 must confirm none of them carries a
-- policy declared in some OTHER tree that is currently dormant because RLS
-- is off — enabling RLS would suddenly activate such a policy, which this
-- file's postcondition checks for (zero policies expected) but cannot
-- prevent if one exists at apply time from a source this repo cannot see.
--
-- ROLLBACK: derivable and instant (§8 item 9e) — DISABLE ROW LEVEL SECURITY
-- per table, listed below.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS RESOLVES
-- ==================
-- RECONCILIATION-PACKET.md §5.4 RLS_UNDISPOSED Class C (12 tables) and §7
-- row 2107. Twelve tables are created in canonical with neither
-- `ENABLE ROW LEVEL SECURITY` nor any policy declared anywhere in canonical.
--
-- SCOPE CORRECTION FROM THE PACKET'S OWN CLASS-C LIST: 11, not 12
-- ==================================================================
-- The packet's §5.4 table lists 12 Class-C tables including
-- `compass_memories`. That entry is stale: `compass_memories` already has
-- RLS from an EARLIER migration (confirmed live via direct catalog check —
-- `SELECT relrowsecurity FROM pg_class` for `compass_memories` returned
-- true), so it no longer belongs in a "neither RLS nor policy anywhere"
-- class. This file covers the remaining eleven:
--   geofence_admin_settings, media_dedup_groups, media_dedup_memberships,
--   place_ai_summaries, place_best_of, place_cache_invalidation_queue,
--   place_coverage_buckets, place_living_cache, place_merge_log,
--   place_top_contributors, post_bucket_ledger
-- `compass_memories` is deliberately absent from every list below — this is
-- not an oversight, it is the correction.
--
-- READ-PATH AUDIT — RESOLVED
-- ============================
-- §7's original text required "a read-path audit first — if any client
-- queries these with the anon key this is an outage, not a hardening." That
-- audit has been performed: all client `.from()`/embedding/`.rpc()` call
-- sites were checked against all 23 RLS-candidate tables across this
-- packet's Class C/D/A-user-facing groups, and the client queries only 10
-- tables, none of which are in any of those three classes. None of these 11
-- tables has a client read path. §8's "highest-risk group in the packet"
-- warning (enabling RLS on a table read with the anon key silently empties
-- every such read) does not apply here on that evidence.
--
-- WHY THIS IS SAFE TO WRITE (BUT NOT YET SAFE TO RUN)
-- =====================================================
-- Enabling RLS with zero policies denies anon/authenticated while
-- service_role bypasses via BYPASSRLS — a pure hardening with a confirmed-
-- absent client read path. The remaining risk is not client breakage but
-- whether some untracked source declared a policy on one of these tables
-- that is dormant today (RLS off makes any policy inert) and would become
-- live the moment RLS is enabled — that risk is real and is exactly what
-- Q3 resolves, which is why this file is still gated despite the read-path
-- finding.
--
-- INTENDED FINAL STATE
-- =====================
-- RLS enabled on all 11 tables, zero policies, DENY_ALL_BY_DESIGN per
-- RECONCILIATION-PACKET.md §5.4's disposition model. service_role continues
-- to read/write via BYPASSRLS, unaffected.

BEGIN;

-- ── Precondition ─────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'geofence_admin_settings', 'media_dedup_groups', 'media_dedup_memberships',
    'place_ai_summaries', 'place_best_of', 'place_cache_invalidation_queue',
    'place_coverage_buckets', 'place_living_cache', 'place_merge_log',
    'place_top_contributors', 'post_bucket_ledger'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION 'PRECONDITION FAILED: public.% does not exist live. Re-derive Class C from Q1.', t;
    END IF;
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION 'PRECONDITION FAILED: public.% already has RLS enabled live — this file assumes it is currently disabled (Class C). Re-derive its class from Q1 before proceeding.', t;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t) THEN
      RAISE EXCEPTION 'PRECONDITION FAILED: public.% already carries a policy while RLS is disabled — enabling RLS would activate an untracked policy this file did not expect. This is exactly the Q3 risk the header describes; do not proceed without reviewing it.', t;
    END IF;
  END LOOP;
END $$;

-- ── The change ───────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'geofence_admin_settings', 'media_dedup_groups', 'media_dedup_memberships',
    'place_ai_summaries', 'place_best_of', 'place_cache_invalidation_queue',
    'place_coverage_buckets', 'place_living_cache', 'place_merge_log',
    'place_top_contributors', 'post_bucket_ledger'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      $c$COMMENT ON TABLE public.%I IS 'DENY_ALL_BY_DESIGN (2107) — RLS enabled, zero policies, service_role via BYPASSRLS only. Internal cache/support table with a confirmed-absent client read path (read-path audit, see this file''s header). No client access is intended.'$c$,
      t
    );
    RAISE NOTICE '2107: RLS enabled on public.%', t;
  END LOOP;
END $$;

-- ── Postcondition ────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'geofence_admin_settings', 'media_dedup_groups', 'media_dedup_memberships',
    'place_ai_summaries', 'place_best_of', 'place_cache_invalidation_queue',
    'place_coverage_buckets', 'place_living_cache', 'place_merge_log',
    'place_top_contributors', 'post_bucket_ledger'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: public.% does not have RLS enabled after this migration ran.', t;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: public.% has a policy — DENY_ALL_BY_DESIGN expects zero.', t;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role no longer has BYPASSRLS — every one of these 11 tables is now unreadable/unwritable by anything, including the service that maintains them.';
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK — instant and complete (§8 item 9e)
-- ═══════════════════════════════════════════════════════════════════════════
-- ALTER TABLE public.geofence_admin_settings        DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.media_dedup_groups              DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.media_dedup_memberships         DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.place_ai_summaries              DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.place_best_of                   DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.place_cache_invalidation_queue  DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.place_coverage_buckets          DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.place_living_cache              DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.place_merge_log                 DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.place_top_contributors          DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.post_bucket_ledger              DISABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run after apply)
-- ═══════════════════════════════════════════════════════════════════════════
-- SELECT relname, relrowsecurity FROM pg_class
--  WHERE relname IN ('geofence_admin_settings','media_dedup_groups',
--    'media_dedup_memberships','place_ai_summaries','place_best_of',
--    'place_cache_invalidation_queue','place_coverage_buckets',
--    'place_living_cache','place_merge_log','place_top_contributors',
--    'post_bucket_ledger');
-- -- expect relrowsecurity = true for all 11, and compass_memories NOT in
-- -- this list (it was already true before this file existed).
