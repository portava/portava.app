-- 2154_hidden_gem_visits_write_boundary.sql
--
-- ⚠ STAGED. Apply to portava-ci ONLY. DO NOT APPLY TO PRODUCTION without the
--   owner's explicit approval — live authorization change (Hidden Gems enabled).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── WHAT IS WRONG, PROVEN BY EXECUTION (portava-ci, self-rolling-back) ───────
-- hidden_gem_visits.trust_level is the platform's per-visit verification level.
-- HiddenGemVerificationService sets trust_level='gps_verified' ONLY after a real
-- GPS-proximity check (else 'pending_review'); COMMUNITY_CONFIRMATIONS_NEEDED=5
-- such visits upgrade a gem. But anon+authenticated hold TABLE-LEVEL INSERT, so a
-- direct PostgREST INSERT can forge it:
--   INSERT INTO hidden_gem_visits (gem_id, user_id, trust_level)
--     VALUES (<gem>, auth.uid(), 'gps_verified');   => 1 row, NO GPS check.
-- (Cross-user is already blocked by RLS hgvis_insert WITH CHECK user_id=auth.uid().)
--
-- ── EFFECTIVE BOUNDARY FOUND ────────────────────────────────────────────────
-- anon+authenticated held a TABLE-LEVEL grant (DELETE,INSERT,REFERENCES,SELECT,
-- TRIGGER,TRUNCATE,UPDATE) — so a column-level REVOKE (trust_level) would NOT
-- work against the table-level grant. This migration therefore REVOKEs ALL and
-- re-GRANTs the minimum: authenticated SELECT (own visits via hgvis_own_read) and
-- column-level INSERT on the client content columns ONLY. There is NO UPDATE
-- policy on the table, so the "INSERT a manual visit then UPDATE trust_level to
-- gps_verified" escalation was already RLS-blocked; removing the UPDATE grant
-- closes it at the privilege level too. anon gets nothing (no read policy for anon;
-- anon cannot satisfy user_id=auth.uid()).
--
-- CLASS A — client content (granted INSERT): gem_id, user_id (RLS pins to self),
--   latitude, longitude, visited_at. A client visit therefore defaults to
--   trust_level='manual', is_suspicious=false — a legitimate manual self-visit.
-- CLASS B — server-owned verification (NOT granted): trust_level (mandate),
--   is_suspicious (the GPS-check verdict), distance_m (server-computed proximity).
-- CLASS C — system: id (default gen_random_uuid).
--
-- ── WHAT THIS DOES NOT CHANGE ───────────────────────────────────────────────
-- No RLS/enum/policy/default change. The service-role GPS path still writes
-- gps_verified (service_role bypasses grants+RLS), so the 5-confirmation gem
-- promotion still works when fed legitimately-verified visits. Generated types
-- untouched.
--
-- SAFE TO RE-RUN.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.hidden_gem_visits') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.hidden_gem_visits does not exist.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.hidden_gem_visits'::regclass) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: RLS is not enabled on hidden_gem_visits.';
  END IF;
  -- The self-insert RLS policy must remain (user_id=auth.uid()) so legit self-visits work.
  IF NOT EXISTS (SELECT 1 FROM pg_policies
     WHERE schemaname='public' AND tablename='hidden_gem_visits' AND cmd='INSERT') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: no INSERT policy on hidden_gem_visits.';
  END IF;
  -- trust_level must have a safe default so a client INSERT omitting it is 'manual'.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='hidden_gem_visits' AND column_name='trust_level'
       AND column_default = '''manual''::text') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: trust_level default is not ''manual''; a client INSERT omitting it could be unsafe.';
  END IF;
END $$;

-- Table-level grant must be removed before a column-level INSERT grant has effect.
REVOKE ALL ON TABLE public.hidden_gem_visits FROM anon;
REVOKE ALL ON TABLE public.hidden_gem_visits FROM authenticated;

-- Reads: owner reads own visits (hgvis_own_read); anon has no read policy → no grant.
GRANT SELECT ON TABLE public.hidden_gem_visits TO authenticated;

-- Client content only; trust_level / is_suspicious / distance_m are server-owned.
GRANT INSERT (gem_id, user_id, latitude, longitude, visited_at)
  ON TABLE public.hidden_gem_visits TO authenticated;
-- No UPDATE/DELETE grant for clients (visits are immutable from the client; the
-- server owns verification transitions). Combined with the absence of an UPDATE
-- policy this blocks the INSERT-then-UPDATE-to-gps_verified escalation.

COMMENT ON TABLE public.hidden_gem_visits IS
  'Hidden-gem check-in visit. trust_level (verification level), is_suspicious and '
  'distance_m are set by the GPS-verification service (service-role) and are NOT '
  'client-writable (2154): authenticated may INSERT a manual self-visit '
  '(gem_id, user_id=self, latitude, longitude, visited_at) which defaults to '
  'trust_level=manual, and may SELECT own visits; no client UPDATE/DELETE. A '
  'direct PostgREST write cannot forge gps_verified.';

DO $$
DECLARE anon_privs text; auth_privs text; ins_cols text; bad text;
BEGIN
  SELECT COALESCE(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '(none)')
    INTO anon_privs FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='hidden_gem_visits' AND grantee='anon';
  IF anon_privs <> '(none)' THEN RAISE EXCEPTION 'POSTCONDITION FAILED: anon holds "%", expected none', anon_privs; END IF;

  SELECT COALESCE(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '(none)')
    INTO auth_privs FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='hidden_gem_visits' AND grantee='authenticated';
  IF auth_privs <> 'SELECT' THEN RAISE EXCEPTION 'POSTCONDITION FAILED: authenticated table-level "%", expected SELECT only', auth_privs; END IF;

  -- server-owned columns must NOT be client-INSERTable, and there must be NO client UPDATE at all.
  SELECT string_agg(DISTINCT grantee||'/'||privilege_type||'/'||column_name, ', ' ORDER BY grantee||'/'||privilege_type||'/'||column_name)
    INTO bad FROM information_schema.column_privileges
   WHERE table_schema='public' AND table_name='hidden_gem_visits'
     AND grantee IN ('anon','authenticated')
     AND ( (privilege_type='INSERT' AND column_name IN ('trust_level','is_suspicious','distance_m','id'))
        OR privilege_type='UPDATE' );
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'POSTCONDITION FAILED: server-owned column writable / client UPDATE remains: %', bad; END IF;

  -- exactly the 5 content columns are INSERTable by authenticated.
  SELECT string_agg(column_name, ',' ORDER BY column_name) INTO ins_cols
    FROM information_schema.column_privileges
   WHERE table_schema='public' AND table_name='hidden_gem_visits' AND grantee='authenticated' AND privilege_type='INSERT';
  IF ins_cols IS DISTINCT FROM 'gem_id,latitude,longitude,user_id,visited_at' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: authenticated INSERT columns = "%", expected the 5 content columns', COALESCE(ins_cols,'(none)');
  END IF;
END $$;

COMMIT;
