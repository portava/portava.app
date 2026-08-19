-- 2109_class_a_deny_all_dispositions.sql
--
-- STATUS: STAGED — NOT APPLIED. reconciliation-staging/, outside canonical.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- BLOCKED ON: Q3 (policies with predicates) — the read-path-audit
--             precondition is RESOLVED, see below. Q1 is not needed: RLS is
--             already enabled on every table this file touches, in
--             canonical, today.
--
-- ROLLBACK: none needed. This file is comment-only — it records a written
-- disposition reason, per RECONCILIATION-PACKET.md §5.4's requirement that
-- DENY_ALL_BY_DESIGN "requires a written reason." It changes no access.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS RESOLVES
-- ==================
-- RECONCILIATION-PACKET.md §5.4 RLS_UNDISPOSED Class A, the seven
-- user-facing tables the packet singled out for an explicit reviewed
-- disposition rather than inherited silence: `devices`, `key_packages`,
-- `comment_likes`, `post_reactions`, `post_shares`, `circle_invites`,
-- `safe_return_contacts`. §7 row 2109's original text: "Owner-scoped
-- policies on whichever of the 7 ... a read-path audit shows a client
-- queries ... Tables that prove service-role-only get DENY_ALL_BY_DESIGN
-- instead and are not touched."
--
-- READ-PATH AUDIT — RESOLVED: ALL SEVEN ARE SERVICE-ROLE-ONLY
-- ================================================================
-- The read-path audit (same one resolving 2107/2108) found the client
-- queries only 10 tables total, none of which are in this group of seven.
-- Per §7's own conditional, that means every one of the seven "proves
-- service-role-only" and — per the packet's own text — is "not touched."
--
-- SCOPE CORRECTION: SIX TABLES, NOT SEVEN — safe_return_contacts EXCLUDED
-- ==========================================================================
-- `safe_return_contacts` does not belong in this migration. Direct
-- verification of canonical contradicts the packet's Class-A classification
-- for this one table: `0167_safety_ddl_reconcile.sql:70-79` both enables RLS
-- AND creates a surviving policy, `src_session_owner`:
--   CREATE POLICY src_session_owner ON safe_return_contacts FOR SELECT USING (
--     EXISTS (SELECT 1 FROM safe_return_sessions s
--             WHERE s.id = session_id AND s.user_id = auth.uid())
--     OR contact_user_id = auth.uid()
--   );
-- No DROP POLICY of this name exists anywhere in canonical — it survives.
-- This table already has ≥1 live policy, so it is not "RLS enabled, zero
-- policies" (the packet's own definition of Class A, §5.4) at all; it is
-- RLS_REQUIRED and already compliant. Declaring DENY_ALL_BY_DESIGN for it
-- here — as an instruction mid-task asked for — would misrecord a table
-- that already has real, correct, owner-scoped protection as though it had
-- none, and this file does not do that. It is a correction to both the
-- packet's §5.4 table and to that instruction, not a silent omission.
--
-- INTENDED FINAL STATE
-- =====================
-- `devices`, `key_packages`, `comment_likes`, `post_reactions`,
-- `post_shares`, `circle_invites` each carry a COMMENT recording
-- DENY_ALL_BY_DESIGN with its reason. No ALTER TABLE, no CREATE POLICY —
-- RLS is already enabled and zero policies already exist on all six in
-- canonical (`2070_rls_hardening.sql` for the first five,
-- `2069_circle_invites.sql:59` for the sixth); this file only supplies the
-- written reason the disposition model requires. `safe_return_contacts` is
-- untouched by this file entirely.

BEGIN;

-- ── Precondition ─────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['devices', 'key_packages', 'comment_likes', 'post_reactions', 'post_shares', 'circle_invites'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION 'PRECONDITION FAILED: public.% does not exist live.', t;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION 'PRECONDITION FAILED: public.% does not have RLS enabled live — this file assumes canonical''s existing ENABLE already took effect. Re-derive from Q1 before treating this as Class A.', t;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t) THEN
      RAISE EXCEPTION 'PRECONDITION FAILED: public.% already carries a live policy — it is not Class A (zero policies) and should not receive a DENY_ALL_BY_DESIGN disposition. This is exactly the discrepancy already found for safe_return_contacts; re-derive this table''s class from Q3 before proceeding.', t;
    END IF;
  END LOOP;

  -- Explicit guard: safe_return_contacts must never be touched by this file.
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'safe_return_contacts' AND policyname = 'src_session_owner'
  ) IS NOT TRUE THEN
    RAISE NOTICE '2109: src_session_owner not found on safe_return_contacts at apply time — the exclusion reasoning in this file''s header should be re-checked against current live state before relying on it, though this file makes no change to that table either way.';
  END IF;
END $$;

-- ── The change — written-reason comments only, no access change ─────────
COMMENT ON TABLE public.devices IS
  'DENY_ALL_BY_DESIGN (2109) — RLS enabled since 2070_rls_hardening.sql, zero policies, service_role via BYPASSRLS only. Read-path audit confirms no client reads this table.';
COMMENT ON TABLE public.key_packages IS
  'DENY_ALL_BY_DESIGN (2109) — RLS enabled since 2070_rls_hardening.sql, zero policies, service_role via BYPASSRLS only. Read-path audit confirms no client reads this table.';
COMMENT ON TABLE public.comment_likes IS
  'DENY_ALL_BY_DESIGN (2109) — RLS enabled since 2070_rls_hardening.sql, zero policies, service_role via BYPASSRLS only. Read-path audit confirms no client reads this table.';
COMMENT ON TABLE public.post_reactions IS
  'DENY_ALL_BY_DESIGN (2109) — RLS enabled since 2070_rls_hardening.sql, zero policies, service_role via BYPASSRLS only. Read-path audit confirms no client reads this table.';
COMMENT ON TABLE public.post_shares IS
  'DENY_ALL_BY_DESIGN (2109) — RLS enabled since 2070_rls_hardening.sql, zero policies, service_role via BYPASSRLS only. Read-path audit confirms no client reads this table.';
COMMENT ON TABLE public.circle_invites IS
  'DENY_ALL_BY_DESIGN (2109) — RLS enabled since 2069_circle_invites.sql:59, zero policies, service_role via BYPASSRLS only. Read-path audit confirms no client reads this table.';

-- ── Postcondition ────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['devices', 'key_packages', 'comment_likes', 'post_reactions', 'post_shares', 'circle_invites'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: public.% has a policy after a comment-only migration ran — something else changed it concurrently.', t;
    END IF;
  END LOOP;

  -- safe_return_contacts must be unchanged: still exactly one policy.
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'safe_return_contacts') <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: safe_return_contacts policy count changed — this file must not have touched it.';
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
-- Comment-only; no rollback needed (§8 item 9a treatment applies here even
-- though this item isn't originally listed there — same reasoning: nothing
-- executable changed).

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run after apply)
-- ═══════════════════════════════════════════════════════════════════════════
-- SELECT relname, obj_description(oid, 'pg_class') FROM pg_class
--  WHERE relname IN ('devices','key_packages','comment_likes',
--                     'post_reactions','post_shares','circle_invites');
-- SELECT count(*) FROM pg_policies
--  WHERE schemaname='public' AND tablename='safe_return_contacts'; -- expect 1, unchanged
