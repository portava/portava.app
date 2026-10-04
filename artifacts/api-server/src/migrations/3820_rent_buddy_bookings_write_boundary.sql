-- 3820_rent_buddy_bookings_write_boundary.sql
--
-- Only the API, as service_role, writes a Rent-a-Buddy booking or offer.
-- `anon` and `authenticated` lose every write privilege on rent_buddy_bookings
-- and rent_buddy_offers, the traveller INSERT policy is dropped, and the nine
-- buddy_* compatibility views stop running with their owner's rights.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; payments 3820-3859).
-- APPLIED TO NO DATABASE by the lane that wrote it. It changes what the public
-- anon key can do to live tables, so its production apply is the owner's; CI
-- applies it to portava-ci when it reaches main, as it does every migration.
--
-- Requirement PAY-002. docs/architecture/09_Payment_Architecture.md §11 states
-- the defect: "A traveller can still INSERT a booking row directly with a client
-- key under that policy, which is why the rule that prices are server-computed
-- must eventually be a database CHECK or a `SECURITY DEFINER` entry point".
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE DEFECT, AS THE REPOSITORY RECORDS IT — AND A SECOND DOOR IT DID NOT
-- ══════════════════════════════════════════════════════════════════════════════
-- Read from baseline/20260819_baseline_structure.sql (production's structure on
-- 2026-08-19) and every later file in this directory. No file here revokes any
-- of it: 2332_money_grant_boundary.sql names rent_buddy_bookings as "remaining
-- M14 surface" and leaves it alone.
--
-- 1. THE TABLE (PAY-002).
--      GRANT ALL ON TABLE public.rent_buddy_bookings TO anon, authenticated   (:35040-35041)
--      POLICY rb_booking_traveler_ins FOR INSERT WITH CHECK (auth.uid() = traveler_id)   (:30753)
--    A signed-in user may therefore INSERT a booking for themselves through
--    PostgREST with any total_usd, deposit_usd, status and payment_status. The
--    price rule (hourly_rate_usd x duration, computed in the route), the master
--    flag, the identity gate (requireBookingKyc), the kill switches, the launch
--    controls and the policy scanner all live in the route, and a direct insert
--    passes none of them.
--
-- 2. THE VIEWS — NOT IN THE FINDING, AND WORSE THAN IT.
--    The baseline carries nine compatibility views, each a plain column subset
--    of one rent_buddy_* table (:3706-4179):
--
--      buddy_bookings, buddy_booking_requests   -> rent_buddy_bookings
--      buddy_profiles -> rent_buddy_profiles     buddy_reviews -> rent_buddy_reviews
--      buddy_disputes -> rent_buddy_disputes     buddy_favorites -> rent_buddy_saved
--      buddy_availability -> rent_buddy_availability
--      buddy_change_requests  -> rent_buddy_route_change_requests
--      buddy_booking_checkins -> rent_buddy_safety_checkins
--
--    Each is owned by the table's owner, none is security_invoker, each is
--    auto-updatable, and each is granted ALL to anon and authenticated
--    (:35049-35060 for the two over bookings). A view without security_invoker
--    reaches its table with the OWNER's rights, and a table's owner is not
--    subject to its row-level security. So through a view a client reaches the
--    table past BOTH its grants and its policies.
--
--    Executed on a private PostgreSQL 16 carrying the baseline and the chain to
--    3510 (it has no PostGIS, so the files that need it did not replay there;
--    every Rent-a-Buddy boundary file — 2145, 2156, 2157, 2330, 2332 — did),
--    each as the role named, in a transaction that was rolled back:
--
--      authenticated INSERT rent_buddy_bookings (own row, total_usd 0.01,
--                    status 'confirmed') ........................ PERMITTED  <- PAY-002
--      anon INSERT  buddy_bookings, for ANOTHER user's id ....... PERMITTED
--      anon SELECT  buddy_bookings .............................. EVERY ROW
--      anon SELECT  rent_buddy_bookings (the table, under RLS) .. 0 rows
--      anon UPDATE  buddy_booking_requests SET total_usd, status  PERMITTED
--      anon DELETE  buddy_bookings .............................. PERMITTED
--      anon UPDATE  buddy_profiles SET verified = true,
--                   buddy_level = 'elite' ....................... PERMITTED
--
--    The last line passes straight through 2145_rent_buddy_profiles_write_
--    boundary.sql, which revoked exactly that write on the TABLE. Revoking on
--    rent_buddy_bookings alone would have closed the door the finding names and
--    left the one beside it open to callers with no account at all.
--
--    Whether the hosted databases still carry these views and grants cannot be
--    read from the repository. The baseline is production's own dump and no
--    later file changes them; a read-only catalog query settles it (handoff).
--
-- 3. THE SIBLING: rent_buddy_offers.
--      POLICY rb_offers_buddy FOR ALL USING (auth.uid() = buddy_user_id)   + GRANT ALL
--    A buddy may INSERT or UPDATE an offer directly, with any proposed_price_usd
--    and any status. Accepting an offer creates a booking priced from the offer
--    (routes/rentABuddyMarketplace.ts), so this is the same defect one step
--    upstream of the booking.
--
-- WHAT 2332 AND ITS NEIGHBOURS ALREADY COVER, so that this file adds only what
-- they do not:
--   2332  rent_buddy_earnings_ledger, rent_buddy_payouts, rent_buddy_tips,
--         portava_featured: client roles hold nothing; service_role holds
--         exactly SELECT, INSERT, UPDATE, DELETE.
--   2901, 2920, 2921, 2930, 3385, 3387  the newer ledgers (rent_buddy_earnings_
--         entries, creator_attributions, creator_rule_versions, creator_earning_
--         entries, creator_ledger_audit_events, creator_share_ledger): client
--         roles hold nothing.
--   2145, 2156, 2157  rent_buddy_profiles, rent_buddy_addons, rent_buddy_
--         packages: client roles hold SELECT plus column-level writes on the
--         fields a buddy may edit. (The buddy_profiles view walked round 2145;
--         section 2 above.)
--   NOT covered by any of them, and closed here: rent_buddy_bookings,
--         rent_buddy_offers, the nine views.
--   NOT covered, and NOT changed here: rent_buddy_fee_rules, rent_buddy_pricing_
--         rules, rent_buddy_booking_addons, rent_buddy_booking_extensions and
--         rent_buddy_disputes still grant client roles INSERT/UPDATE/DELETE, but
--         their only write policy is the service one, so RLS refuses every
--         client write today. That is standing privilege, not a reachable
--         write; it is reported, not absorbed into a file about a live hole.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHO WRITES THESE TABLES — every one of them the service client
-- ══════════════════════════════════════════════════════════════════════════════
-- lib/supabase.ts builds its one client from SUPABASE_SERVICE_ROLE_KEY, which is
-- in envValidation.ts REQUIRED_KEYS; requireUser's `client` is that same client
-- (lib/http.ts). The API never builds a user-scoped client.
--
--   rent_buddy_bookings INSERT, the five booking paths:
--     routes/rentABuddy.ts             POST /rent-a-buddy/bookings
--     routes/rentABuddy.ts             the rebook path
--     routes/rentABuddyMarketplace.ts  offer accept
--     routes/rentABuddyMarketplace.ts  package book
--     routes/rentABuddySpec.ts         the spec booking path
--   and every UPDATE, in the same three files plus lib/rentBuddyRequestSweeper.ts
--   and the 2330 functions (EXECUTE granted to service_role only).
--   rent_buddy_offers: routes/rentABuddyMarketplace.ts and the sweeper.
--   The views: routes/pulse.ts reads buddy_bookings and compass/
--   CompassFrontLoadEngine.ts reads buddy_profiles, both on the service client.
--
-- The app (travel-buddy-standalone) names none of these relations. Its only
-- direct table reads through supabase-js are trips, profiles,
-- message_thread_members, rent_buddy_packages and rent_buddy_fee_rules, all
-- SELECTs. src/test/rentBuddyBookingWriters.test.ts pins that the app names
-- none of the relations bounded here, and that the five INSERTs above are the
-- only ones and are the service client's.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS FILE DOES
-- ══════════════════════════════════════════════════════════════════════════════
--   * rent_buddy_bookings and rent_buddy_offers: REVOKE INSERT, UPDATE, DELETE,
--     TRUNCATE, REFERENCES, TRIGGER (and MAINTAIN on PostgreSQL 17) FROM anon,
--     authenticated and PUBLIC.
--   * DROP POLICY rb_booking_traveler_ins. With the grant gone it could admit
--     nothing; it is dropped so that the first GRANT anyone adds for an
--     unrelated reason does not silently re-open the insert. rb_booking_svc
--     (FOR ALL, service_role) is the write policy that remains.
--   * The nine views, and any other view that reaches rent_buddy_bookings or
--     rent_buddy_offers: SET (security_invoker = true). The view then reaches
--     its table with the CALLER's rights, so the table's grants and policies
--     decide, as they do for the table itself. buddy_bookings and
--     buddy_booking_requests additionally lose the client write privileges.
--
-- WHAT IT DOES NOT DO
--   * SELECT is untouched everywhere. rb_booking_parties (the traveller and the
--     buddy read their own bookings) is not altered, and it is why client SELECT
--     must stay: seven policies on sibling tables (bbe_parties, bk_chg_req_read,
--     rb_bk_addons_parties, rb_dispute_parties, rb_ext_parties,
--     rb_route_chg_parties, rb_stops_parties) subquery rent_buddy_bookings with
--     the caller's rights, so revoking SELECT would turn every one of those
--     reads into an error.
--   * rb_offers_buddy stays. It is FOR ALL, which is also how a buddy READS
--     their own offers; without the write privileges it governs the read only.
--   * service_role is untouched.
--   * No other grant on the seven views not over bookings changes. Under
--     invoker rights each is exactly as writable as its table: buddy_favorites
--     follows rb_saved_own, buddy_profiles follows 2145's column grants.
--
-- BEHAVIOUR FOR A LEGITIMATE CALLER: none. Every reader and writer above is the
-- service client, which holds every privilege on the tables and bypasses RLS.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- IDEMPOTENT, AND THE ROLLBACK RESTORES WHAT WAS THERE
-- ══════════════════════════════════════════════════════════════════════════════
-- Client roles hold different things on different databases: the full default
-- set where 2490 is not applied (the baseline, the local harness), the four DML
-- verbs where it is. So the state this file is about to change is RECORDED, as
-- it was, at the end of the comment on rent_buddy_bookings: each client write
-- privilege removed, whether the policy existed, and which views were switched.
-- The record is written once; a second apply finds it, changes nothing more and
-- passes the same postconditions.
--
-- Rollback: db/rollback/2026-10-04-3820-rent-buddy-bookings-write-boundary-rollback.sql
-- restores exactly that record, removes it, and deletes this file's ledger row.
-- It re-opens every door listed above.
--
-- THE POSTCONDITION reads the catalog, not the statements: aclexplode over
-- pg_class.relacl (which sees MAINTAIN; information_schema does not) and
-- pg_attribute.attacl (a column-level grant survives in a place relacl does not
-- show), pg_policy for a write policy that is not the service one, and
-- pg_depend/pg_rewrite for a view that still reaches either table with its
-- owner's rights.
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
-- About SAFETY, not about the defect being present: this file converges from
-- whatever state it finds, and refuses only a state it cannot leave correct.
DO $pre$
DECLARE
  bk   regclass := to_regclass('public.rent_buddy_bookings');
  bad  text;
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3820): PostgreSQL % has no security_invoker views; this file needs 15 or later.', current_setting('server_version');
  END IF;
  IF bk IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3820): public.rent_buddy_bookings does not exist.';
  END IF;

  -- SELECT stays granted to the client roles, so RLS must already be deciding
  -- which rows they see.
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO bad
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
     AND c.relname IN ('rent_buddy_bookings', 'rent_buddy_offers')
     AND NOT c.relrowsecurity;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3820): row level security is not enabled on %. This file leaves client SELECT in place and will not do that on a table whose rows nothing filters.', bad;
  END IF;

  -- The writer must be able to write before the client paths are closed.
  SELECT string_agg(c.relname || ':' || p, ', ' ORDER BY c.relname, p) INTO bad
    FROM pg_class c, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
     AND c.relname IN ('rent_buddy_bookings', 'rent_buddy_offers')
     AND NOT has_table_privilege('service_role', c.oid, p);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3820): service_role lacks % — closing the client paths would leave no writer.', bad;
  END IF;

  -- A column-level client write privilege is somebody's deliberate design (2145
  -- made one on rent_buddy_profiles). A table-level REVOKE would remove it and
  -- the rollback could not put it back, so it is refused, not absorbed.
  SELECT string_agg(c.relname || '.' || a.attname || ':' || x.privilege_type, ', ' ORDER BY c.relname, a.attnum) INTO bad
    FROM pg_class c
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    CROSS JOIN LATERAL aclexplode(a.attacl) x
   WHERE c.relnamespace = 'public'::regnamespace
     AND ((c.relkind IN ('r', 'p') AND c.relname IN ('rent_buddy_bookings', 'rent_buddy_offers'))
       OR (c.relkind = 'v' AND c.relname IN ('buddy_bookings', 'buddy_booking_requests')))
     AND (x.grantee = 0 OR pg_get_userbyid(x.grantee) IN ('anon', 'authenticated'))
     AND x.privilege_type <> 'SELECT';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3820): column-level client write privileges exist (%). That is a designed client write path this file was not written against; decide it by hand.', bad;
  END IF;

  -- The policy this file drops must be the one the rollback knows how to
  -- recreate: FOR INSERT, permissive, to PUBLIC, WITH CHECK (auth.uid() = traveler_id).
  SELECT p.polname INTO bad
    FROM pg_policy p
   WHERE p.polrelid = bk AND p.polname = 'rb_booking_traveler_ins'
     AND NOT (p.polcmd = 'a' AND p.polpermissive AND p.polroles = ARRAY[0]::oid[] AND p.polqual IS NULL
              AND regexp_replace(pg_get_expr(p.polwithcheck, p.polrelid), '[()[:space:]]', '', 'g') = 'auth.uid=traveler_id');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3820): policy % on rent_buddy_bookings is not the baseline''s (FOR INSERT WITH CHECK (auth.uid() = traveler_id)); this file will not drop a policy its rollback cannot recreate.', bad;
  END IF;
END
$pre$;

-- ── Record the state about to change (once), and switch the views ────────────
DO $record$
DECLARE
  bk     regclass := 'public.rent_buddy_bookings'::regclass;
  prior  text := obj_description('public.rent_buddy_bookings'::regclass, 'pg_class');
  state  jsonb;
  note   text;
  v      record;
BEGIN
  -- What must NOT change, handed to the block after the REVOKEs (transaction-
  -- local): every privilege on the four relations other than the client roles'
  -- write privileges, every column ACL, every policy but the one dropped, and
  -- the RLS flags.
  PERFORM set_config('pay_3820.kept_before', (
    SELECT jsonb_build_object(
      'acl', (SELECT COALESCE(jsonb_agg(jsonb_build_array(c.relname, x.grantor, x.grantee, x.privilege_type, x.is_grantable)
                                         ORDER BY c.relname, x.grantee, x.privilege_type, x.grantor), '[]'::jsonb)
                FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
               WHERE c.relnamespace = 'public'::regnamespace
                 AND ((c.relkind IN ('r', 'p') AND c.relname IN ('rent_buddy_bookings', 'rent_buddy_offers'))
                   OR (c.relkind = 'v' AND c.relname IN ('buddy_bookings', 'buddy_booking_requests')))
                 AND NOT ((x.grantee = 0 OR pg_get_userbyid(x.grantee) IN ('anon', 'authenticated')) AND x.privilege_type <> 'SELECT')),
      'attacl', (SELECT COALESCE(jsonb_agg(jsonb_build_array(c.relname, a.attname, a.attacl::text) ORDER BY c.relname, a.attnum), '[]'::jsonb)
                   FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                  WHERE c.relnamespace = 'public'::regnamespace AND a.attacl IS NOT NULL
                    AND c.relname IN ('rent_buddy_bookings', 'rent_buddy_offers', 'buddy_bookings', 'buddy_booking_requests')),
      'policies', (SELECT COALESCE(jsonb_agg(jsonb_build_array(c.relname, p.polname, p.polcmd, p.polpermissive, p.polroles::text,
                                                                pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid))
                                             ORDER BY c.relname, p.polname), '[]'::jsonb)
                     FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
                    WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('rent_buddy_bookings', 'rent_buddy_offers')
                      AND NOT (c.relname = 'rent_buddy_bookings' AND p.polname = 'rb_booking_traveler_ins')),
      'rls', (SELECT COALESCE(jsonb_agg(jsonb_build_array(c.relname, c.relrowsecurity, c.relforcerowsecurity) ORDER BY c.relname), '[]'::jsonb)
                FROM pg_class c
               WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('rent_buddy_bookings', 'rent_buddy_offers'))
    )::text), true);

  -- The record the rollback restores from. Written ONCE: a second apply finds
  -- it and must not replace the state before 3820 with the state after it.
  IF prior IS NULL OR position('3820 (PAY-002):' IN prior) = 0 THEN
    state := jsonb_build_object(
      -- One entry per relation and role: the write privileges it held, and
      -- which of them (normally none) it held with grant option.
      'privileges', (SELECT COALESCE(jsonb_agg(e ORDER BY e ->> 'rel', e ->> 'grantee'), '[]'::jsonb)
                       FROM (SELECT jsonb_build_object(
                                      'rel', c.relname,
                                      'grantee', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
                                      'held', jsonb_agg(x.privilege_type ORDER BY x.privilege_type),
                                      'grantable', COALESCE(jsonb_agg(x.privilege_type ORDER BY x.privilege_type) FILTER (WHERE x.is_grantable), '[]'::jsonb)) AS e
                               FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
                              WHERE c.relnamespace = 'public'::regnamespace
                                AND ((c.relkind IN ('r', 'p') AND c.relname IN ('rent_buddy_bookings', 'rent_buddy_offers'))
                                  OR (c.relkind = 'v' AND c.relname IN ('buddy_bookings', 'buddy_booking_requests')))
                                AND (x.grantee = 0 OR pg_get_userbyid(x.grantee) IN ('anon', 'authenticated'))
                                AND x.privilege_type <> 'SELECT'
                              GROUP BY c.relname, x.grantee) g),
      'policy', EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = bk AND p.polname = 'rb_booking_traveler_ins'),
      'invoker', (
        WITH RECURSIVE reach(oid) AS (
          SELECT c.oid FROM pg_class c
           WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
             AND c.relname IN ('rent_buddy_bookings', 'rent_buddy_offers')
          UNION
          SELECT r.ev_class
            FROM reach
            JOIN pg_depend d ON d.refobjid = reach.oid AND d.refclassid = 'pg_class'::regclass AND d.classid = 'pg_rewrite'::regclass
            JOIN pg_rewrite r ON r.oid = d.objid
        )
        SELECT COALESCE(jsonb_agg(jsonb_build_array(n.nspname, c.relname) ORDER BY n.nspname, c.relname), '[]'::jsonb)
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind = 'v'
           AND (c.oid IN (SELECT oid FROM reach)
             OR (n.nspname = 'public' AND c.relname IN (
                   'buddy_availability', 'buddy_booking_checkins', 'buddy_booking_requests', 'buddy_bookings',
                   'buddy_change_requests', 'buddy_disputes', 'buddy_favorites', 'buddy_profiles', 'buddy_reviews')))
           AND NOT COALESCE((SELECT lower(o.option_value) IN ('true', 'on', '1', 'yes')
                               FROM pg_options_to_table(c.reloptions) o WHERE o.option_name = 'security_invoker'), false)
      )
    );
    note := '3820 (PAY-002): anon, authenticated and PUBLIC hold no write privilege on this table, on rent_buddy_offers '
         || 'or on the buddy_bookings and buddy_booking_requests views, and the buddy_* compatibility views run with the '
         || 'caller''s rights; every writer is the API as service_role. State before 3820, which its rollback restores: '
         || state::text;
    EXECUTE format('COMMENT ON TABLE public.rent_buddy_bookings IS %L',
                   CASE WHEN prior IS NULL THEN note ELSE prior || E'\n\n' || note END);
  END IF;

  -- Every view that reaches either table, and the nine compatibility views by
  -- name, wherever one exists as a view: the caller's rights, not the owner's.
  -- (A legacy buddy_bookings TABLE, where 0147 found one, is not a view of
  -- anything and is left alone.)
  FOR v IN
    WITH RECURSIVE reach(oid) AS (
      SELECT c.oid FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
         AND c.relname IN ('rent_buddy_bookings', 'rent_buddy_offers')
      UNION
      SELECT r.ev_class
        FROM reach
        JOIN pg_depend d ON d.refobjid = reach.oid AND d.refclassid = 'pg_class'::regclass AND d.classid = 'pg_rewrite'::regclass
        JOIN pg_rewrite r ON r.oid = d.objid
    )
    SELECT n.nspname, c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'v'
       AND (c.oid IN (SELECT oid FROM reach)
         OR (n.nspname = 'public' AND c.relname IN (
               'buddy_availability', 'buddy_booking_checkins', 'buddy_booking_requests', 'buddy_bookings',
               'buddy_change_requests', 'buddy_disputes', 'buddy_favorites', 'buddy_profiles', 'buddy_reviews')))
     ORDER BY n.nspname, c.relname
  LOOP
    EXECUTE format('ALTER VIEW %I.%I SET (security_invoker = true)', v.nspname, v.relname);
  END LOOP;
END
$record$;

-- ── The boundary ─────────────────────────────────────────────────────────────
-- TRUNCATE, REFERENCES and TRIGGER are named because Supabase's default grant
-- carries them and 2490, which removes them database-wide, is not applied
-- everywhere this file runs. MAINTAIN is PostgreSQL 17's and is handled below.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.rent_buddy_bookings
  FROM anon, authenticated, PUBLIC;

DROP POLICY IF EXISTS rb_booking_traveler_ins ON public.rent_buddy_bookings;

DO $narrow$
DECLARE
  r     record;
  kept  text;
BEGIN
  -- rent_buddy_offers where it exists, and the two views over bookings where
  -- they are views.
  FOR r IN
    SELECT c.relname
      FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace
       AND ((c.relkind IN ('r', 'p') AND c.relname = 'rent_buddy_offers')
         OR (c.relkind = 'v' AND c.relname IN ('buddy_bookings', 'buddy_booking_requests')))
     ORDER BY c.relname
  LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.%I FROM anon, authenticated, PUBLIC', r.relname);
  END LOOP;

  -- MAINTAIN exists from PostgreSQL 17 and 16 cannot parse it, so it is issued
  -- only where the server knows it, on all four relations (the default grant
  -- puts it on views too). Where 2490 ran it is already gone.
  IF current_setting('server_version_num')::int >= 170000 THEN
    FOR r IN
      SELECT c.relname
        FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace
         AND ((c.relkind IN ('r', 'p') AND c.relname IN ('rent_buddy_bookings', 'rent_buddy_offers'))
           OR (c.relkind = 'v' AND c.relname IN ('buddy_bookings', 'buddy_booking_requests')))
       ORDER BY c.relname
    LOOP
      EXECUTE format('REVOKE MAINTAIN ON public.%I FROM anon, authenticated, PUBLIC', r.relname);
    END LOOP;
  END IF;

  -- In-transaction assertion: nothing this file did not mean to change moved.
  -- Reads, the service role, every other policy and the RLS flags are as they
  -- were — a REVOKE that took SELECT with it, or a DROP that reached the party
  -- read policy, would satisfy every postcondition below and empty the screens.
  SELECT jsonb_build_object(
      'acl', (SELECT COALESCE(jsonb_agg(jsonb_build_array(c.relname, x.grantor, x.grantee, x.privilege_type, x.is_grantable)
                                         ORDER BY c.relname, x.grantee, x.privilege_type, x.grantor), '[]'::jsonb)
                FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
               WHERE c.relnamespace = 'public'::regnamespace
                 AND ((c.relkind IN ('r', 'p') AND c.relname IN ('rent_buddy_bookings', 'rent_buddy_offers'))
                   OR (c.relkind = 'v' AND c.relname IN ('buddy_bookings', 'buddy_booking_requests')))
                 AND NOT ((x.grantee = 0 OR pg_get_userbyid(x.grantee) IN ('anon', 'authenticated')) AND x.privilege_type <> 'SELECT')),
      'attacl', (SELECT COALESCE(jsonb_agg(jsonb_build_array(c.relname, a.attname, a.attacl::text) ORDER BY c.relname, a.attnum), '[]'::jsonb)
                   FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                  WHERE c.relnamespace = 'public'::regnamespace AND a.attacl IS NOT NULL
                    AND c.relname IN ('rent_buddy_bookings', 'rent_buddy_offers', 'buddy_bookings', 'buddy_booking_requests')),
      'policies', (SELECT COALESCE(jsonb_agg(jsonb_build_array(c.relname, p.polname, p.polcmd, p.polpermissive, p.polroles::text,
                                                                pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid))
                                             ORDER BY c.relname, p.polname), '[]'::jsonb)
                     FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
                    WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('rent_buddy_bookings', 'rent_buddy_offers')
                      AND NOT (c.relname = 'rent_buddy_bookings' AND p.polname = 'rb_booking_traveler_ins')),
      'rls', (SELECT COALESCE(jsonb_agg(jsonb_build_array(c.relname, c.relrowsecurity, c.relforcerowsecurity) ORDER BY c.relname), '[]'::jsonb)
                FROM pg_class c
               WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('rent_buddy_bookings', 'rent_buddy_offers'))
    )::text INTO kept;
  IF kept IS DISTINCT FROM current_setting('pay_3820.kept_before') THEN
    RAISE EXCEPTION 'ASSERTION FAILED (3820): something other than the client write privileges and rb_booking_traveler_ins changed. Before: %  After: %',
      current_setting('pay_3820.kept_before'), kept;
  END IF;
END
$narrow$;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ────────
DO $post$
DECLARE
  bk      regclass := 'public.rent_buddy_bookings'::regclass;
  leak    text;
  descr   text := obj_description('public.rent_buddy_bookings'::regclass, 'pg_class');
  n_rel   integer;
  n_view  integer;
BEGIN
  -- 1. No client role, directly or through PUBLIC, holds anything but SELECT on
  --    the two tables or the two views over bookings. Read from relacl, so
  --    MAINTAIN is seen where the server has it.
  SELECT count(DISTINCT c.oid),
         string_agg(DISTINCT c.relname || ':' || CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END || ':' || x.privilege_type, ', ')
           FILTER (WHERE (x.grantee = 0 OR pg_get_userbyid(x.grantee) IN ('anon', 'authenticated')) AND x.privilege_type <> 'SELECT')
    INTO n_rel, leak
    FROM pg_class c
    LEFT JOIN LATERAL aclexplode(c.relacl) x ON true
   WHERE c.relnamespace = 'public'::regnamespace
     AND ((c.relkind IN ('r', 'p') AND c.relname IN ('rent_buddy_bookings', 'rent_buddy_offers'))
       OR (c.relkind = 'v' AND c.relname IN ('buddy_bookings', 'buddy_booking_requests')));
  IF n_rel < 1 THEN
    RAISE EXCEPTION 'POSTCONDITION VACUOUS (3820): no relation was examined.';
  END IF;
  IF leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3820): a client role still holds a write privilege: %.', leak;
  END IF;

  -- 2. ...and none at column level, which relacl does not show.
  SELECT string_agg(c.relname || '.' || a.attname || ':' || x.privilege_type, ', ') INTO leak
    FROM pg_class c
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    CROSS JOIN LATERAL aclexplode(a.attacl) x
   WHERE c.relnamespace = 'public'::regnamespace
     AND ((c.relkind IN ('r', 'p') AND c.relname IN ('rent_buddy_bookings', 'rent_buddy_offers'))
       OR (c.relkind = 'v' AND c.relname IN ('buddy_bookings', 'buddy_booking_requests')))
     AND (x.grantee = 0 OR pg_get_userbyid(x.grantee) IN ('anon', 'authenticated'))
     AND x.privilege_type <> 'SELECT';
  IF leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3820): a client role still holds a column-level write privilege: %.', leak;
  END IF;

  -- 3. No policy on rent_buddy_bookings admits a client write: every policy
  --    that covers a write command is the service one, by its role list or by
  --    its predicate.
  SELECT string_agg(p.polname, ', ' ORDER BY p.polname) INTO leak
    FROM pg_policy p
   WHERE p.polrelid = bk
     AND p.polcmd <> 'r'
     AND NOT (
       p.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'service_role')]::oid[]
       OR (COALESCE(regexp_replace(pg_get_expr(p.polqual, p.polrelid), '[()[:space:]]', '', 'g'), 'auth.role=''service_role''::text') = 'auth.role=''service_role''::text'
           AND COALESCE(regexp_replace(pg_get_expr(p.polwithcheck, p.polrelid), '[()[:space:]]', '', 'g'), 'auth.role=''service_role''::text') = 'auth.role=''service_role''::text'
           AND (p.polqual IS NOT NULL OR p.polwithcheck IS NOT NULL))
     );
  IF leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3820): rent_buddy_bookings still carries a client write policy: %.', leak;
  END IF;

  -- 4. The writer still writes.
  SELECT string_agg(c.relname || ':' || p, ', ' ORDER BY c.relname, p) INTO leak
    FROM pg_class c, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
     AND c.relname IN ('rent_buddy_bookings', 'rent_buddy_offers')
     AND NOT has_table_privilege('service_role', c.oid, p);
  IF leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3820): service_role lost % — the API would break.', leak;
  END IF;

  -- 5. No view reaches either table, or stands among the nine compatibility
  --    views, with its owner's rights.
  WITH RECURSIVE reach(oid) AS (
    SELECT c.oid FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
       AND c.relname IN ('rent_buddy_bookings', 'rent_buddy_offers')
    UNION
    SELECT r.ev_class
      FROM reach
      JOIN pg_depend d ON d.refobjid = reach.oid AND d.refclassid = 'pg_class'::regclass AND d.classid = 'pg_rewrite'::regclass
      JOIN pg_rewrite r ON r.oid = d.objid
  )
  SELECT count(*),
         string_agg(n.nspname || '.' || c.relname, ', ' ORDER BY n.nspname, c.relname)
           FILTER (WHERE NOT COALESCE((SELECT lower(o.option_value) IN ('true', 'on', '1', 'yes')
                                         FROM pg_options_to_table(c.reloptions) o WHERE o.option_name = 'security_invoker'), false))
    INTO n_view, leak
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind = 'v'
     AND (c.oid IN (SELECT oid FROM reach)
       OR (n.nspname = 'public' AND c.relname IN (
             'buddy_availability', 'buddy_booking_checkins', 'buddy_booking_requests', 'buddy_bookings',
             'buddy_change_requests', 'buddy_disputes', 'buddy_favorites', 'buddy_profiles', 'buddy_reviews')));
  IF leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3820): view(s) still run with their owner''s rights and so walk past the table''s privileges and policies: %.', leak;
  END IF;

  -- 6. The record the rollback restores from is there and parses.
  IF descr IS NULL OR position('3820 (PAY-002):' IN descr) = 0
     OR (substring(descr FROM 'State before 3820, which its rollback restores: (\{.*\})$')::jsonb -> 'privileges') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3820): the record the rollback restores from is missing from the comment on rent_buddy_bookings.';
  END IF;

  RAISE NOTICE '3820 OK: % relation(s) hold no client write privilege; rent_buddy_bookings has no client write policy; service_role writes; % view(s) run with the caller''s rights.', n_rel, n_view;
END
$post$;
