-- 2370_trust_tables_privileges.sql
--
-- Make the seven trust tables reachable ONLY through the API's service role.
-- No new table, column, policy or flag. Grants only. RLS stays enabled; the
-- five own-row SELECT policies 0043 created are left in place (see below).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2370.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE STATE THIS MIGRATION IS WRITTEN AGAINST — MEASURED, NOT INFERRED
-- ══════════════════════════════════════════════════════════════════════════════
-- Read 2026-09-07 from BOTH databases (information_schema.role_table_grants,
-- pg_policies, pg_class.relrowsecurity):
--
--   travel-buddy   ajrurzioarfkagpuxfnb   (production)
--   portava-ci     hwokxgbmezheskbzskfr   (the sanctioned CI project)
--
-- Identical in both:
--
--   table                 RLS   policies                          anon/authenticated grants
--   trust_admin_actions   on    0                                 ALL (incl. TRUNCATE)
--   trust_caps            on    tc_select_own   (SELECT, own)     ALL (incl. TRUNCATE)
--   trust_events          on    te_select_own   (SELECT, own)     ALL (incl. TRUNCATE)
--   trust_profiles        on    tp_select_own   (SELECT, own)     ALL (incl. TRUNCATE)
--   trust_restrictions    on    tr_select_own   (SELECT, own)     ALL (incl. TRUNCATE)
--   trust_reviews         on    0                                 ALL (incl. TRUNCATE)
--   trust_settings        on    ts_select_all   (SELECT, true)    ALL (incl. TRUNCATE)
--
-- "ALL" is DELETE/INSERT/REFERENCES/SELECT/TRIGGER/TRUNCATE/UPDATE — the
-- Supabase ALTER DEFAULT PRIVILEGES grant that every CREATE TABLE receives.
-- 0043 enabled RLS and wrote SELECT-only policies; it never revoked anything.
--
-- WHY THE MEASURED STATE IS WRONG
-- ================================
-- 1. RLS does not police TRUNCATE. `anon` and `authenticated` hold TRUNCATE on
--    the safety ledger (trust_events), on the scores (trust_profiles) and on the
--    admin audit trail (trust_admin_actions). RLS-on with no write policy denies
--    INSERT/UPDATE/DELETE for those roles; it says nothing about TRUNCATE.
--
-- 2. `ts_select_all USING (true)` on trust_settings lets `anon` — no session at
--    all — read the gaming-detection thresholds (gaming_checkin_cluster_limit,
--    gaming_rapid_jump_points, gaming_mutual_rate_threshold) and every scoring
--    weight. The detector's thresholds are readable by the population it is
--    meant to detect.
--
-- 3. `te_select_own` lets the SUBJECT of a trust event read the whole row:
--    `delta`, `reviewed_by` (the adjudicating admin's id) and `metadata`
--    (which carries `counterparty_user_id`, the other person in a mutual
--    review). services/trust/TrustPrivacyGuard.ts:1-16 states the surface's own
--    rules — reporter identity NEVER exposed, raw deltas NOT returned — and
--    `isEventLlmSafe` strips exactly `reviewed_by`. The API honours the rule;
--    the table's own policy does not. Likewise `tr_select_own` exposes the
--    admin's free-text `reason` on a restriction.
--
-- WHY REVOKING IS INERT FOR THE PRODUCT
-- =====================================
-- Every server path that touches a trust table runs on the service role:
--   - lib/http.ts:177 `requireUser` hands routes `getServiceClient()`;
--   - lib/requireAdmin.ts:125 does the same, falling back to the user client
--     only when there is no service client — and lib/envValidation.ts:9-12
--     lists SUPABASE_SERVICE_ROLE_KEY as REQUIRED (process.exit(1) without it),
--     so that fallback cannot occur in a running deployment;
--   - services/trust/* take the caller's client and are only ever handed one
--     of the above.
-- The mobile tree contains ZERO references to any trust_* table (grep over
-- every .ts/.tsx/.js outside artifacts/api-server, 2026-09-07). Nothing reads
-- these tables through PostgREST as anon or authenticated. Revoking their
-- grants changes what those roles COULD do and nothing that anything DOES.
--
-- WHY THE POLICIES STAY
-- =====================
-- With no grant, a policy is inert — but it is inert in the SAFE direction.
-- If a future migration (or the default-privileges grant on a rebuilt table)
-- hands `authenticated` SELECT back by accident, the own-row policies still
-- confine that read to the subject's own rows instead of the whole table.
-- Dropping them would also invalidate five `rls:` claims 0043 makes, which
-- scripts/auditMigrationsVsLive.ts would report as drift, and would move five
-- entries in scripts/rlsDispositions.ts. None of that buys anything here. The
-- canonical shape this migration copies is 2217_protected_locations.sql:156-161
-- (RLS on, REVOKE ALL from every role, one explicit grant to service_role).
--
-- service_role keeps SELECT/INSERT/UPDATE/DELETE. It loses TRUNCATE (nothing
-- in the tree truncates a trust table; scripts/verify-approval-and-reconcile.ts
-- uses DELETE) and REFERENCES/TRIGGER, which an application role has no use
-- for. service_role bypasses RLS, so its behaviour is unchanged.
--
-- POSTCONDITION
-- =============
-- The DO block at the end RAISES if any of the seven tables is missing (a
-- check that examined nothing must fail, not pass), if anon/authenticated
-- retain any privilege on any of them, or if service_role retains TRUNCATE.
--
-- ROLLBACK: db/rollback/2026-09-07-2370-trust-tables-privileges-rollback.sql
-- restores the measured pre-state (ALL to the three roles), idempotently.

BEGIN;

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'trust_admin_actions', 'trust_caps', 'trust_events', 'trust_profiles',
    'trust_restrictions', 'trust_reviews', 'trust_settings'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION '2370: expected table public.% to exist; refusing to run against a tree where the trust engine was never migrated', t;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM service_role', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', t);
  END LOOP;
END $$;

-- ── Postcondition ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  n_tables   int;
  n_leaks    int;
  n_truncate int;
BEGIN
  SELECT count(*) INTO n_tables
    FROM information_schema.tables
   WHERE table_schema = 'public'
     AND table_name IN ('trust_admin_actions','trust_caps','trust_events','trust_profiles',
                        'trust_restrictions','trust_reviews','trust_settings');
  IF n_tables <> 7 THEN
    RAISE EXCEPTION '2370 postcondition: expected 7 trust tables, found % — check examined the wrong thing', n_tables;
  END IF;

  SELECT count(*) INTO n_leaks
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND table_name LIKE 'trust\_%'
     AND grantee IN ('anon', 'authenticated', 'PUBLIC');
  IF n_leaks <> 0 THEN
    RAISE EXCEPTION '2370 postcondition: % privilege(s) remain for anon/authenticated on trust tables', n_leaks;
  END IF;

  SELECT count(*) INTO n_truncate
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND table_name LIKE 'trust\_%'
     AND grantee = 'service_role'
     AND privilege_type = 'TRUNCATE';
  IF n_truncate <> 0 THEN
    RAISE EXCEPTION '2370 postcondition: service_role still holds TRUNCATE on % trust table(s)', n_truncate;
  END IF;
END $$;

COMMIT;
