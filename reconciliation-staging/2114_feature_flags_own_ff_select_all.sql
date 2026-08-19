-- 2114_feature_flags_own_ff_select_all.sql
--
-- STATUS: STAGED — NOT APPLIED. reconciliation-staging/, outside canonical.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- BLOCKED ON: Q3 (policies with predicates)
--
-- ROLLBACK NOT DERIVABLE FROM THIS REPOSITORY for the DROP side (§8 item
-- 9d) — Q3's captured live text for `ff_select_all` is the rollback. This
-- file's own header quotes the text verbatim from the frozen root, for
-- cross-reference only, not as a substitute for a live capture.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS RESOLVES
-- ==================
-- RECONCILIATION-PACKET.md §4.3 DISJOINT_POLICY_FAMILY and §7 row 2114.
-- Canonical's `2071_feature_flags_deny_anon.sql` already drops
-- `feature_flags_public_read` (the policy migration.sql's own audit trail
-- shows was actually exposing all 177 flag rows to the anon key) and its own
-- header (lines 38-40) explicitly REASONS ABOUT a second policy it does not
-- own:
--
--   "0037 also shipped a service_role ALL policy. It is harmless
--   (service_role bypasses RLS regardless) but redundant; leave it in place
--   so that any environment relying on it explicitly keeps working."
--
-- That comment is imprecise about what 0037 actually shipped. The frozen
-- root `artifacts/api-server/migrations/0037_feature_flags.sql:26-27`
-- creates:
--   CREATE POLICY ff_select_all ON feature_flags FOR SELECT USING (TRUE);
-- — a SELECT policy open to every role, not a service_role-scoped ALL
-- policy. Canonical's 2071 never names or drops `ff_select_all` at all. So
-- 2071's belief that it left something "harmless" in place is describing a
-- policy that does not exist under that description; the policy that DOES
-- exist under the name `ff_select_all`, if live, reopens exactly the
-- anon-key read hole 2071 was written to close — 2071's own DROP of
-- `feature_flags_public_read` cannot have touched a differently-named
-- policy.
--
-- INTENDED FINAL STATE
-- =====================
-- `ff_select_all` dropped. Canonical declares its own service-role-only
-- policy in its place (`feature_flags_service_only`), so canonical fully
-- owns the table's access model instead of reasoning about a frozen root's
-- policy as though it were its own. `feature_flags_public_read`, `ff_select_all`
-- gone; no anon/authenticated SELECT policy of any kind remains.

BEGIN;

-- ── Precondition ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist live.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.feature_flags'::regclass) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: feature_flags does not have RLS enabled live.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'feature_flags' AND policyname = 'feature_flags_public_read'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: feature_flags_public_read is still live — 2071 was supposed to have dropped this already. Investigate before proceeding; this migration assumes 2071 already ran.';
  END IF;
END $$;

-- ── The change ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS ff_select_all ON public.feature_flags;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'feature_flags' AND policyname = 'feature_flags_service_only'
  ) THEN
    CREATE POLICY feature_flags_service_only ON public.feature_flags
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMENT ON TABLE public.feature_flags IS
  '2114: ff_select_all (frozen root artifacts/api-server/migrations/0037_feature_flags.sql:27, USING TRUE, open to every role) dropped. Canonical now declares feature_flags_service_only directly rather than reasoning about a frozen root policy as its own (see 2071''s header, which described this policy incorrectly). No anon/authenticated read policy remains — matches 2071''s intent for this table.';

-- ── Postcondition ────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'feature_flags' AND policyname = 'ff_select_all'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: ff_select_all is still present.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'feature_flags'
      AND cmd IN ('SELECT', 'ALL') AND NOT ('service_role' = ANY(roles::text[]))
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a non-service_role read policy still exists on feature_flags.';
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
-- Cannot be written here for the DROP — see BLOCKED ON banner. Once Q3's
-- pre-apply capture exists for `ff_select_all`, the rollback is CREATE
-- POLICY of that captured text, plus:
--   DROP POLICY IF EXISTS feature_flags_service_only ON public.feature_flags;

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run after apply)
-- ═══════════════════════════════════════════════════════════════════════════
-- SELECT policyname, roles, cmd, qual FROM pg_policies
--  WHERE schemaname = 'public' AND tablename = 'feature_flags';
-- -- expect exactly one row: feature_flags_service_only, {service_role}, ALL
