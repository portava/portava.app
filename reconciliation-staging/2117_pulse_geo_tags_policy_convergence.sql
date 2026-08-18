-- 2117_pulse_geo_tags_policy_convergence.sql
--
-- STATUS: STAGED — NOT APPLIED. reconciliation-staging/, outside canonical.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- BLOCKED ON: Q3 (policies with predicates)
--
-- ROLLBACK NOT DERIVABLE FROM THIS REPOSITORY for the DROP of legacy's four
-- owner-scoped policies (§8 item 9d) — Q3's captured live text is the
-- rollback.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS RESOLVES
-- ==================
-- RECONCILIATION-PACKET.md §4.3 DISJOINT_POLICY_FAMILY ("pulse_geo_tags
-- (four families)") and §7 row 2117. Four `CREATE POLICY` sites across four
-- files/trees for `pulse_geo_tags`, direct-read verified:
--
--   canonical  (0036_pulse_geo_tags.sql:27-28)  — `pulse_geo_tags_public_read`
--     FOR SELECT USING (true). One policy only, no write policy at all.
--   legacy     (artifacts/api-server/migrations/0036) — `pgt_select_all`
--     (SELECT, true), `pgt_insert_own`/`pgt_update_own`/`pgt_delete_own`
--     (all `auth.uid() = user_id`). An owner-write model — this tree's own
--     CREATE TABLE is also the only one with a `user_id` column at all.
--   docs/sql   (docs/sql/0036_pulse_geo_tags.sql:68-82) — `pulse_geo_tags_public_read`
--     (SELECT, true — same name AND predicate as canonical's) plus
--     `pulse_geo_tags_service_write` (FOR ALL TO service_role USING true).
--   root       (migrations/0036_pulse_geo_tags.sql:22-26) — same two names
--     and predicates as docs/sql's family, verbatim.
--
-- CORRECTION: NOT FOUR DISJOINT FAMILIES — THREE, ONE DUPLICATED TWICE.
-- ========================================================================
-- docs/sql's and root's families are IDENTICAL by name and predicate (not
-- merely similar) — `pulse_geo_tags_public_read` and
-- `pulse_geo_tags_service_write`, same USING clauses, in both files. That
-- is one distinct policy identity declared redundantly in two files, not
-- two disjoint families. The packet's "four disjoint... families" count is
-- corrected here to: three distinct identities across four declaration
-- sites — (A) the public-read name shared by canonical/docs-sql/root, (B)
-- the service-write name shared by docs-sql/root (canonical never declares
-- it at all), and (C) legacy's four-policy owner-write family. This
-- correction does not change what this migration does — it still needs to
-- reconcile every name that exists — but it changes how the discrepancy
-- should be described.
--
-- NO CLIENT WRITE PATH BEHIND LEGACY'S OWNER MODEL
-- ===================================================
-- Grepped `travel-buddy-standalone/src` for `pulse_geo_tags`: two hits, both
-- comments/type references to `location_visibility` for display purposes —
-- zero `.from('pulse_geo_tags')` calls. All server-side access is via
-- `artifacts/api-server/src/routes/pulse.ts` and
-- `.../services/location/PulseGeoTagService.ts`, both service-role-mediated
-- per docs/sql's own comment ("the API server inserts via service role key,
-- fire-and-forget from POST /posts"). Converging onto the server-only model
-- (drop legacy's direct-write policies) removes a capability nothing in the
-- shipped client exercises.
--
-- INTENDED FINAL STATE
-- =====================
-- `pulse_geo_tags_public_read` (SELECT, true) and `pulse_geo_tags_service_write`
-- (ALL, service_role) are the only two policies. Legacy's four
-- `pgt_*` names dropped.

BEGIN;

-- ── Precondition ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.pulse_geo_tags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.pulse_geo_tags does not exist live.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.pulse_geo_tags'::regclass) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: pulse_geo_tags does not have RLS enabled live.';
  END IF;
END $$;

-- ── The change ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS pgt_select_all ON public.pulse_geo_tags;
DROP POLICY IF EXISTS pgt_insert_own ON public.pulse_geo_tags;
DROP POLICY IF EXISTS pgt_update_own ON public.pulse_geo_tags;
DROP POLICY IF EXISTS pgt_delete_own ON public.pulse_geo_tags;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'pulse_geo_tags' AND policyname = 'pulse_geo_tags_public_read'
  ) THEN
    CREATE POLICY "pulse_geo_tags_public_read" ON public.pulse_geo_tags
      FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'pulse_geo_tags' AND policyname = 'pulse_geo_tags_service_write'
  ) THEN
    CREATE POLICY "pulse_geo_tags_service_write" ON public.pulse_geo_tags
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMENT ON TABLE public.pulse_geo_tags IS
  '2117: converged onto canonical''s server-only model — pulse_geo_tags_public_read (SELECT, true) + pulse_geo_tags_service_write (service_role). Legacy''s owner-write family (pgt_select_all/insert_own/update_own/delete_own) dropped; no client code path used direct owner writes on this table.';

-- ── Postcondition ────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'pulse_geo_tags'
      AND policyname IN ('pgt_select_all', 'pgt_insert_own', 'pgt_update_own', 'pgt_delete_own')
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a legacy pgt_* policy is still present.';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'pulse_geo_tags') <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected exactly 2 policies on pulse_geo_tags after convergence.';
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
-- Cannot be written here for legacy's four DROPs — see BLOCKED ON banner.
-- Once Q3's pre-apply capture exists for pgt_select_all/insert_own/
-- update_own/delete_own, the rollback is CREATE POLICY of each, verbatim,
-- plus:
--   DROP POLICY IF EXISTS pulse_geo_tags_service_write ON public.pulse_geo_tags;
--   -- (pulse_geo_tags_public_read predates this migration under the same
--   -- name/predicate in three trees — leave it in place on rollback.)

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run after apply)
-- ═══════════════════════════════════════════════════════════════════════════
-- SELECT policyname, roles, cmd, qual FROM pg_policies
--  WHERE schemaname = 'public' AND tablename = 'pulse_geo_tags';
-- -- expect exactly 2 rows.
