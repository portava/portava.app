-- 2108_enable_rls_class_d_uncovered_tables.sql
--
-- STATUS: STAGED — NOT APPLIED. reconciliation-staging/, outside canonical.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- BLOCKED ON: Q1 (relation census + RLS flag), Q3 (policies with predicates)
--             — the read-path-audit precondition is RESOLVED, see below.
--
-- One ALTER TABLE per table below, deliberately not batched, so that if one
-- table's precondition fails the other three are unaffected and rollback is
-- per-table (RECONCILIATION-PACKET.md §7 row 2108: "One statement per table
-- so rollback is per-table").
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS RESOLVES
-- ==================
-- RECONCILIATION-PACKET.md §5.4 RLS_UNDISPOSED Class D and §7 row 2108 —
-- "highest residual exposure in the packet" per the packet's own words: four
-- tables created OUTSIDE canonical with NO `ENABLE ROW LEVEL SECURITY` in
-- ANY tree at all (not just canonical) — `content_translations`,
-- `portava_featured`, `post_impressions`, `weather_cache` — on a project
-- whose mobile app ships the anon key.
--
-- READ-PATH AUDIT — RESOLVED, AND THE PACKET'S ORIGINAL WORRY DID NOT HOLD
-- ============================================================================
-- §7's original text flagged these as "read-through caches the client may
-- query directly" and said "Do not apply blind." A read-path audit has
-- since been performed across all 23 RLS-candidate tables in this packet
-- (Class C + Class D + Class A-user-facing-7): the client queries only 10
-- tables, and none of the 23 candidates — including these four — is among
-- them. The read-through-cache worry does not hold for any of the four.
--
-- WHY DENY_ALL_BY_DESIGN, NOT "MINIMAL POLICIES"
-- =================================================
-- The packet's original §7 text said "RLS + minimal policies," written
-- before the read-path evidence existed and hedging against the possibility
-- of a real client read path. With that path confirmed absent, the
-- RLS-disposition model's own definition applies directly:
-- DENY_ALL_BY_DESIGN = relrowsecurity = true AND 0 policies, service_role
-- bypasses, written reason required (§5.4). Inventing owner-scoped policies
-- for tables nothing reads would be adding surface area the evidence does
-- not call for — service_role already reaches all four via BYPASSRLS for
-- whatever server-side maintenance each requires.
--
-- INTENDED FINAL STATE
-- =====================
-- RLS enabled on all four tables, zero policies, DENY_ALL_BY_DESIGN.

BEGIN;

-- ── Precondition ─────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['content_translations', 'portava_featured', 'post_impressions', 'weather_cache'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION 'PRECONDITION FAILED: public.% does not exist live. Re-derive Class D from Q1.', t;
    END IF;
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION 'PRECONDITION FAILED: public.% already has RLS enabled live — this file assumes it does not, in any tree. Re-derive from Q1.', t;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t) THEN
      RAISE EXCEPTION 'PRECONDITION FAILED: public.% already carries a policy while RLS is disabled — enabling RLS would activate an untracked policy. Review before proceeding.', t;
    END IF;
  END LOOP;
END $$;

-- ── The change — one statement per table, per §7's own instruction ───────
ALTER TABLE public.content_translations ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.content_translations IS
  'DENY_ALL_BY_DESIGN (2108) — RLS enabled, zero policies, service_role via BYPASSRLS only. Created outside canonical with no ENABLE in any tree; read-path audit confirms no client reads this table. Highest residual exposure in the packet before this file, per RECONCILIATION-PACKET.md §5.4.';

ALTER TABLE public.portava_featured ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.portava_featured IS
  'DENY_ALL_BY_DESIGN (2108) — RLS enabled, zero policies, service_role via BYPASSRLS only. Read-path audit confirms no client reads this table.';

ALTER TABLE public.post_impressions ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.post_impressions IS
  'DENY_ALL_BY_DESIGN (2108) — RLS enabled, zero policies, service_role via BYPASSRLS only. Read-path audit confirms no client reads this table. Note: created by docs/migrations/0070_profile_views.sql, a file referenced by no script/workflow in this repo (open question 4, RECONCILIATION-PACKET.md §10) — this migration does not resolve that provenance question, only the RLS gap.';

ALTER TABLE public.weather_cache ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.weather_cache IS
  'DENY_ALL_BY_DESIGN (2108) — RLS enabled, zero policies, service_role via BYPASSRLS only. Read-path audit confirms no client reads this table.';

-- ── Postcondition ────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['content_translations', 'portava_featured', 'post_impressions', 'weather_cache'];
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
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role no longer has BYPASSRLS.';
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK — instant and complete, per table (§8 item 9e)
-- ═══════════════════════════════════════════════════════════════════════════
-- ALTER TABLE public.content_translations DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.portava_featured     DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.post_impressions     DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.weather_cache        DISABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run after apply)
-- ═══════════════════════════════════════════════════════════════════════════
-- SELECT relname, relrowsecurity FROM pg_class
--  WHERE relname IN ('content_translations','portava_featured',
--                     'post_impressions','weather_cache');
-- -- expect relrowsecurity = true for all four.
