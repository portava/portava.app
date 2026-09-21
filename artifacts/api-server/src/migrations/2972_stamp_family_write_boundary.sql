-- 2972_stamp_family_write_boundary.sql
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Closes the finding
-- certify:migrations STAGE 3 raised the first time 0081 entered its scope.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT, AND WHY IT WAS INVISIBLE UNTIL NOW
-- ══════════════════════════════════════════════════════════════════════════════
-- Supabase grants ALL on schema `public` to `anon` and `authenticated` at CREATE
-- TABLE time. 0081_stamp_system_v2.sql creates seven tables and never REVOKEs, so
-- both client roles have held INSERT, UPDATE and DELETE on all seven ever since:
--
--   stamp_definitions  user_stamps  stamp_award_events  stamp_progress
--   stamp_collections  stamp_collection_items  stamp_campaigns
--
-- Every presence check stayed green throughout, because a grant is not an object
-- and nothing was looking at grants. certify's STAGE 3 looks, but its scope is
-- "migrations applied by THIS run", and 0081 carried only a 2254 backfill row —
-- never an apply — so it had never been in scope. Replaying it on 2026-09-15
-- (run 35004957171) put it in scope and the finding surfaced immediately.
--
-- THE SAME GRANTS ARE PRESENT ON PRODUCTION (ajrurzioarfkagpuxfnb), verified by
-- reading information_schema.role_table_grants there. This is not CI drift.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT IS ACTUALLY REACHABLE TODAY — MEASURED, NOT ASSUMED
-- ══════════════════════════════════════════════════════════════════════════════
-- Executed against portava-ci inside a transaction that was rolled back, using
-- SET LOCAL ROLE and a synthetic request.jwt.claims, one profile promoted to
-- admin for the duration:
--
--   anon INSERT stamp_definitions .................... DENIED (42501)
--   ordinary authenticated INSERT .................... DENIED (42501)
--   AUTHENTICATED ADMIN INSERT ....................... PERMITTED
--   service_role INSERT .............................. PERMITTED
--   ordinary user UPDATE profiles SET role='admin' ... DENIED (42501)
--
-- SO THE HONEST STATEMENT IS NOT "RLS DENIES CLIENT WRITES". An authenticated
-- administrator IS a client, and the admin_all policies on stamp_definitions and
-- stamp_campaigns (cmd=ALL, roles={public}, USING = caller is an admin, WITH
-- CHECK omitted so Postgres reuses USING) admit exactly that write. What RLS
-- denies is ANONYMOUS and ORDINARY-USER writes. The admin client path is real.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY REVOKING THE ADMIN PATH BREAKS NOTHING: IT IS ALREADY SERVER-MEDIATED
-- ══════════════════════════════════════════════════════════════════════════════
-- Three facts, each checked rather than assumed:
--
--   1. EVERY server-side write to all seven tables goes through `sc`, the
--      service-role client — 23 write sites across routes/adminStamps.ts,
--      services/passport/StampAwardEngine.ts, routes/stamps.ts,
--      routes/stampCatalog.ts, lib/stamps/reconcileStampCatalog.ts and
--      lib/stamps/xxCatalogRepair.ts. NOT ONE uses the caller's RLS-scoped
--      client.
--   2. `requireAdmin` (lib/requireAdmin.ts) returns `sc` as "service-role client
--      where available, else the caller's user client". The fallback is
--      unreachable in any booted server: SUPABASE_SERVICE_ROLE_KEY is in
--      envValidation.ts REQUIRED_KEYS and the process exit(1)s without it.
--   3. The client application never touches these tables at all — zero
--      references to any of the seven across travel-buddy-standalone/src.
--
-- Admin stamp management is routes/adminStamps.ts: requireAdmin gates it, the
-- service client performs it. Revoking the client grants removes a path that no
-- intended caller uses.
--
-- ORDINARY USERS CANNOT BECOME ADMINS, which is what makes an admin-gated policy
-- meaningful in the first place. 2078_profiles_role_not_self_writable.sql
-- installs caller_may_write_profile_role() (service_role, postgres or
-- supabase_admin only) and the enforce_profile_role_privileged() trigger. Both
-- the function and the trigger are present on portava-ci AND on production, and
-- the escalation attempt above was refused.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- REHEARSED AGAINST portava-ci AND ROLLED BACK — the AFTER state, measured
-- ══════════════════════════════════════════════════════════════════════════════
-- The preconditions, the REVOKE and the postconditions below were executed in a
-- transaction that ended in a deliberate RAISE, with the same five probes re-run
-- afterwards inside it:
--
--   postconditions: 0 client write grants remain, 8 client SELECT grants kept,
--                   21 service_role write grants intact
--   1 anon INSERT ...................... DENIED (42501)
--   2 ordinary authenticated INSERT .... DENIED (42501)
--   3 AUTHENTICATED ADMIN INSERT ....... DENIED (42501)   <- was PERMITTED
--   4 service_role INSERT .............. PERMITTED
--   5 admin SELECT ..................... PERMITTED
--
-- Line 3 is the behaviour change and it is the intended one: the administrator
-- keeps every capability, through routes/adminStamps.ts, which is line 4. Line 5
-- is here because a REVOKE that took SELECT with it would have satisfied every
-- other assertion while emptying the Passport.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS FILE DOES NOT DO
-- ══════════════════════════════════════════════════════════════════════════════
--   * It does not touch SELECT. The public-read policies on stamp_definitions,
--     stamp_collections, stamp_collection_items and user_stamps are how the
--     Passport renders; removing read would break the product.
--   * It does not DROP the admin_all policies on stamp_definitions and
--     stamp_campaigns. Without the grant they are unreachable, and deleting them
--     would erase the recorded intent that admins are the privileged writers.
--     They stay as documentation, and as the correct predicate if a future
--     change deliberately re-grants.
--   * It does not touch service_role, which is BYPASSRLS and is the writer.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- REVERSAL (exact)
-- ══════════════════════════════════════════════════════════════════════════════
--   BEGIN;
--   GRANT INSERT, UPDATE, DELETE ON public.stamp_definitions, public.user_stamps,
--     public.stamp_award_events, public.stamp_progress, public.stamp_collections,
--     public.stamp_collection_items, public.stamp_campaigns
--     TO anon, authenticated;
--   COMMIT;
-- Reversing restores the unintended path; it does not restore any behaviour the
-- product uses, because nothing uses it.
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $pre$
DECLARE
  missing TEXT[] := ARRAY[]::TEXT[];
  t TEXT;
  n_rls INTEGER;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'stamp_definitions','user_stamps','stamp_award_events','stamp_progress',
    'stamp_collections','stamp_collection_items','stamp_campaigns'
  ] LOOP
    IF to_regclass('public.' || t) IS NULL THEN missing := missing || t; END IF;
  END LOOP;

  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2972): table(s) % are absent. 0081_stamp_system_v2.sql must be applied before its grants can be narrowed.', array_to_string(missing, ', ');
  END IF;

  -- RLS must already be on, everywhere. This migration removes the OUTER gate;
  -- if the inner one were missing, removing the outer one would still be right,
  -- but the state would be one nobody has described and this file will not
  -- proceed into it silently.
  SELECT count(*) INTO n_rls
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relrowsecurity
    AND c.relname IN ('stamp_definitions','user_stamps','stamp_award_events',
                      'stamp_progress','stamp_collections','stamp_collection_items',
                      'stamp_campaigns');
  IF n_rls <> 7 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2972): row level security is enabled on only % of the 7 stamp tables. Narrowing grants while RLS is off on one of them leaves a table whose protection this file cannot describe.', n_rls;
  END IF;

  RAISE NOTICE '2972 precondition: 7 tables present, RLS enabled on all 7.';
END
$pre$;

-- ── The boundary ─────────────────────────────────────────────────────────────
-- TRUNCATE is included because it is a write and Supabase's default grant covers
-- it; it is not otherwise reachable through PostgREST, and revoking it costs
-- nothing.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
  public.stamp_definitions,
  public.user_stamps,
  public.stamp_award_events,
  public.stamp_progress,
  public.stamp_collections,
  public.stamp_collection_items,
  public.stamp_campaigns
FROM anon, authenticated;

-- ── Postconditions ───────────────────────────────────────────────────────────
DO $post$
DECLARE
  leftover TEXT;
  n_select INTEGER;
  n_service INTEGER;
BEGIN
  SELECT string_agg(format('%s/%s/%s', table_name, grantee, privilege_type), ', ' ORDER BY table_name, grantee, privilege_type)
    INTO leftover
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND grantee IN ('anon','authenticated')
    AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
    AND table_name IN ('stamp_definitions','user_stamps','stamp_award_events',
                       'stamp_progress','stamp_collections','stamp_collection_items',
                       'stamp_campaigns');

  IF leftover IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2972): client roles still hold write privileges after the REVOKE: %. This is the exact condition certify STAGE 3 refuses.', leftover;
  END IF;

  -- READ MUST SURVIVE. The Passport is a read surface; if SELECT went with the
  -- writes, every stamp screen would empty out and the postcondition above would
  -- still have passed.
  SELECT count(*) INTO n_select
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND privilege_type = 'SELECT'
    AND grantee IN ('anon','authenticated')
    AND table_name IN ('stamp_definitions','user_stamps','stamp_collections',
                       'stamp_collection_items');
  IF n_select = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2972): no client SELECT grant remains on the stamp read surface. The REVOKE took read with it.';
  END IF;

  -- THE WRITER MUST STILL WRITE. service_role is how every one of the 23 server
  -- write sites reaches these tables.
  SELECT count(*) INTO n_service
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND grantee = 'service_role'
    AND privilege_type IN ('INSERT','UPDATE','DELETE')
    AND table_name IN ('stamp_definitions','user_stamps','stamp_award_events',
                       'stamp_progress','stamp_collections','stamp_collection_items',
                       'stamp_campaigns');
  IF n_service = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2972): service_role holds no write privilege on any stamp table. The award pipeline and the admin routes would both be dead.';
  END IF;

  RAISE NOTICE '2972 postconditions: 0 client write grants remain; % client SELECT grant(s) preserved; % service_role write grant(s) intact.', n_select, n_service;
END
$post$;

COMMIT;
