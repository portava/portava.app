-- 2106_adopt_viewer_creator_fatigue.sql
--
-- STATUS: STAGED — NOT APPLIED. reconciliation-staging/, outside canonical.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- BLOCKED ON: Q1 (relation census), Q2 (column shape), Q3 (policies with
--             predicates)
--
-- Unlike most of this package, the DDL below is safe to RUN even before
-- these queries return, because `CREATE TABLE IF NOT EXISTS` against a
-- table that already exists live is a true no-op — it does not compare or
-- validate columns, it just checks the name. What Q1/Q2/Q3 gate here is
-- ACCURACY, not safety: whether the shape this file adopts into canonical
-- actually matches what is live. It is still listed as blocked, in
-- fairness to the packet's own rule that no forward migration ships ahead
-- of its query, but the risk profile is materially lower than every
-- policy-touching item in this package.
--
-- ROLLBACK: not needed for the CREATE-side (idempotent by construction);
-- the RLS/policy side follows the same additive-only reasoning as 2109 (a
-- deny-all policy on a table already row-level-secured can only be as
-- restrictive as before, never less).
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS RESOLVES
-- ==================
-- RECONCILIATION-PACKET.md §4.3, "One exception" under SPINE_UNDECLARED, and
-- §7 row 2106. `viewer_creator_fatigue` is created only in
-- `artifacts/api-server/supabase/migrations/20260801_ranking_discovery_foundation.sql`
-- (~line 114) — a frozen, non-canonical root (packet §2.3 root #5, replayable
-- by `supabase db push`, FREEZE — ruling 2). Canonical's own
-- `2058_viewer_creator_fatigue_expires_at.sql:19-20` does
-- `ALTER TABLE viewer_creator_fatigue ADD COLUMN IF NOT EXISTS expires_at ...`
-- against a table canonical never creates. Freezing the Supabase root
-- without adopting the table it created leaves 2058 permanently orphaned —
-- a canonical migration altering a table no live-writable file declares.
--
-- Shape adopted, verbatim from the frozen file:
--   viewer_id           uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE
--   creator_id          uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE
--   recent_impressions  int          NOT NULL DEFAULT 0
--   last_impression_at  timestamptz  NOT NULL DEFAULT now()
--   fatigue_score       numeric(5,2) NOT NULL DEFAULT 0
--   updated_at          timestamptz  NOT NULL DEFAULT now()
--   PRIMARY KEY (viewer_id, creator_id)
-- plus indexes on viewer_id and last_impression_at, RLS enabled with a
-- `vcf_deny_public` FOR ALL USING (false) policy — the same deny-all pattern
-- used elsewhere in that file for `content_distribution_stats`.
--
-- INTENDED FINAL STATE
-- =====================
-- `viewer_creator_fatigue` exists with this shape whether or not this file
-- ever runs against a live database that already has it (no-op) or is
-- creating it fresh in a clean-build context. RLS enabled, deny-all policy,
-- no client-facing access — this is an internal ranking signal table, not a
-- user-facing surface. `2058`'s `expires_at` ADD COLUMN now targets a table
-- canonical itself declares.

BEGIN;

-- ── Precondition ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.viewer_creator_fatigue') IS NOT NULL THEN
    -- Table already live. Confirm the columns 2058 depends on are present,
    -- since this file's whole point is to stop 2058 being orphaned.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'viewer_creator_fatigue'
        AND column_name IN ('viewer_id', 'creator_id')
    ) THEN
      RAISE EXCEPTION 'PRECONDITION FAILED: viewer_creator_fatigue exists live but lacks viewer_id/creator_id — the live shape does not match the frozen root file this migration adopts. Re-derive from Q2.';
    END IF;
  END IF;
END $$;

-- ── The change ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.viewer_creator_fatigue (
  viewer_id           uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  creator_id          uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recent_impressions  int          NOT NULL DEFAULT 0,
  last_impression_at  timestamptz  NOT NULL DEFAULT now(),
  fatigue_score       numeric(5,2) NOT NULL DEFAULT 0,
  updated_at          timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT viewer_creator_fatigue_pkey PRIMARY KEY (viewer_id, creator_id)
);

CREATE INDEX IF NOT EXISTS viewer_creator_fatigue_viewer_id_idx
  ON public.viewer_creator_fatigue (viewer_id);
CREATE INDEX IF NOT EXISTS viewer_creator_fatigue_last_impression_at_idx
  ON public.viewer_creator_fatigue (last_impression_at);

ALTER TABLE public.viewer_creator_fatigue ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'viewer_creator_fatigue' AND policyname = 'vcf_deny_public'
  ) THEN
    CREATE POLICY vcf_deny_public ON public.viewer_creator_fatigue FOR ALL USING (false);
  END IF;
END $$;

COMMENT ON TABLE public.viewer_creator_fatigue IS
  'Adopted into canonical 2106 — sole creator was the frozen artifacts/api-server/supabase/migrations root (ruling 2 freeze). Adopted so canonical 2058''s ALTER TABLE ... ADD COLUMN expires_at is no longer orphaned. DENY_ALL_BY_DESIGN: internal ranking signal, service_role only via BYPASSRLS.';

-- ── Postcondition ────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.viewer_creator_fatigue') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: viewer_creator_fatigue does not exist after this migration ran.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.viewer_creator_fatigue'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: viewer_creator_fatigue does not have RLS enabled.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'viewer_creator_fatigue' AND policyname = 'vcf_deny_public'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: vcf_deny_public policy is missing.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role no longer has BYPASSRLS — this table has zero policies for any other role and depends entirely on service_role bypassing RLS for the ranking pipeline to read/write it.';
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═══════════════════════════════════════════════════════════════════════════
-- DROP POLICY IF EXISTS vcf_deny_public ON public.viewer_creator_fatigue;
-- ALTER TABLE public.viewer_creator_fatigue DISABLE ROW LEVEL SECURITY;
-- -- The CREATE TABLE / indexes are not rolled back: if the table already
-- -- existed live before this file ran, this file created nothing to undo;
-- -- if it did not exist and this file created it in a clean-build context,
-- -- dropping it would be a data-destructive step outside this migration's
-- -- reviewed scope.

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run after apply)
-- ═══════════════════════════════════════════════════════════════════════════
-- SELECT relrowsecurity FROM pg_class WHERE oid = 'public.viewer_creator_fatigue'::regclass; -- expect true
-- SELECT policyname, qual FROM pg_policies
--  WHERE schemaname='public' AND tablename='viewer_creator_fatigue'; -- expect vcf_deny_public, qual = false
