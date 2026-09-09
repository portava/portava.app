-- 2332_money_grant_boundary.sql
--
-- The money tables and portava_featured stop resting on Supabase's default
-- privileges and start resting on an explicit grant set.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2332.
--
-- Closes M14 (docs/architecture/12_Claude_Code_Implementation.md §3.1) and the
-- grant half of B-1 (§3.4). Privilege-only. It creates nothing, drops nothing,
-- writes no row, flips no flag, and does not add, alter or drop a single RLS
-- policy. Idempotent: REVOKE-then-GRANT, so re-running it is a no-op.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE LIVE GRANT SET, MEASURED — NOT INFERRED FROM THE BASELINE
-- ══════════════════════════════════════════════════════════════════════════════
-- Read on 2026-09-07 from BOTH databases via aclexplode(pg_class.relacl), which
-- is the query that sees every privilege. (Both are PostgreSQL 17.6.)
--
--   travel-buddy   ajrurzioarfkagpuxfnb   (production)
--   portava-ci     hwokxgbmezheskbzskfr   (the sanctioned CI project)
--
-- PRODUCTION — all four tables, identical, for anon AND authenticated AND
-- service_role AND postgres:
--
--   DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
--
-- i.e. the full ALL set on every one of them. That is not something a migration
-- asked for. It is what Supabase's `public` schema hands out at CREATE TABLE
-- time through ALTER DEFAULT PRIVILEGES, and it has simply never been taken
-- back.
--
-- PORTAVA-CI — the three rent_buddy tables are identical to production. The one
-- difference in the whole set is portava_featured, where anon and authenticated
-- hold SELECT and nothing else, because 2160_portava_featured_write_boundary.sql
-- WAS applied here and was NOT applied to production.
--
-- ── STATE THIS CORRECTLY: IT IS DEBT, NOT A LIVE BREACH ──────────────────────
--
-- On production, portava_featured has RLS ENABLED with ZERO policies. RLS on
-- with no policy denies every role that does not hold BYPASSRLS, so the
-- INSERT/UPDATE/DELETE grants anon and authenticated hold there are not
-- currently reachable, and the self-feature exploit 2160 documented is not
-- currently open. This migration is NOT closing an exploitable hole on that
-- table. What it closes is the distance to one: the grants are a single added
-- permissive policy — or a single `ALTER TABLE … DISABLE ROW LEVEL SECURITY` —
-- away from being live again, and the record would show nothing wrong until
-- somebody made that one change for an unrelated reason. Defence in depth is
-- the entire claim being made here; no more than that, and no less.
--
-- The three rent_buddy tables are the case 10 §8 describes plainly: RLS is
-- enabled and each carries two policies, so they are protected by RLS ALONE
-- while table-level ALL sits underneath. Same shape, same repair.
--
--   rent_buddy_earnings_ledger  rb_ledger_buddy      SELECT  auth.uid() = buddy_user_id
--                               rb_ledger_svc        ALL     auth.role() = 'service_role'
--   rent_buddy_payouts          rb_payout_buddy_read SELECT  buddy_id IN (own rent_buddy_profiles)
--                               rb_payout_svc        ALL     auth.role() = 'service_role'
--   rent_buddy_tips             rb_tips_own          ALL     auth.uid() IN (traveler_id, buddy_user_id)
--                               rb_tips_svc          ALL     auth.role() = 'service_role'
--
-- All six are declared TO PUBLIC (pg_policy.polroles = {0}), verified live.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY service_role IS REVOKED FIRST, UNCONDITIONALLY
-- ══════════════════════════════════════════════════════════════════════════════
-- This is the line people omit, and 2092 -> 2093 is the worked failure in this
-- repository. 2092_discovery_shadow_serves.sql revoked from PUBLIC, anon and
-- authenticated, then wrote `GRANT INSERT, SELECT … TO service_role` and a
-- header claiming service_role held "INSERT and SELECT and nothing else". The
-- live catalog said DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE,
-- UPDATE (2093:5-22) — because ALTER DEFAULT PRIVILEGES had already granted ALL
-- the instant CREATE TABLE ran, so the GRANT added nothing that was not already
-- held and established no limit at all. Every gate stayed green, because
-- audit:schema models grants as a PRESENCE check: both claimed grants WERE
-- present, and excess privilege is outside anything its claim model can express
-- (2093:24-45). A stated limit that is a silent no-op is worse than no
-- statement, so the revoke comes first and names service_role explicitly.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT IS GRANTED BACK, AND WHY EXACTLY THAT
-- ══════════════════════════════════════════════════════════════════════════════
-- service_role: SELECT, INSERT, UPDATE, DELETE — the canonical 2217 set
-- (2217_protected_locations.sql:156-161), and on the three rent_buddy tables it
-- is also precisely what their own service policies already imply: rb_ledger_svc,
-- rb_payout_svc and rb_tips_svc are each FOR ALL, which is the four DML verbs.
-- Every legitimate writer in the tree runs as service_role — lib/supabase.ts
-- constructs its one client from SUPABASE_SERVICE_ROLE_KEY and there is no
-- anon-key client in any api-server route.
--
-- What that DROPS, on all four tables, from every role including service_role:
--
--   TRUNCATE   the sharpest one. It empties a money ledger in one statement
--              without firing a row trigger and without producing a DELETE.
--              2093 kept a BEFORE TRUNCATE trigger on top of the revoke for
--              exactly this reason; none is added here, because that would be a
--              behaviour change and this file is privilege-only.
--   REFERENCES the right to point a foreign key at these tables.
--   TRIGGER    the right to attach a trigger to them.
--   MAINTAIN   PostgreSQL 17's VACUUM/ANALYZE/REINDEX/CLUSTER/REFRESH right.
--              Note it is INVISIBLE to information_schema.role_table_grants,
--              which is why the postcondition below reads pg_class.relacl
--              instead — see "THE POSTCONDITION" .
--
-- anon and authenticated: NOTHING, on all four tables. Justified per table:
--
--   the three rent_buddy tables — no client-side code reads them. Verified by
--     grep across the whole tree: the only non-type, non-test references to
--     rent_buddy_earnings_ledger, rent_buddy_payouts and rent_buddy_tips are in
--     artifacts/api-server (lib/rentBuddyEarningsLedger.ts, routes/rentABuddy*),
--     every one of them through the service client, and travel-buddy-standalone
--     contains zero references to any of the three. rb_ledger_buddy,
--     rb_payout_buddy_read and rb_tips_own are therefore LATENT policies, not
--     live read paths: nothing today evaluates them.
--
--     THEY ARE DELIBERATELY LEFT IN PLACE. Dropping a policy is not this file's
--     business, and a policy that stops binding because the grant beneath it
--     was removed is recoverable in one line; a dropped policy is not. If a
--     direct-from-client buddy earnings read is ever built, the grant it needs
--     is `GRANT SELECT ON <table> TO authenticated`, added deliberately, in its
--     own migration, next to the code that needs it.
--
--   portava_featured — the client never reaches this table over PostgREST. It
--     reads GET /api/featured (travel-buddy-standalone/src/services/featured.ts
--     is a fetch wrapper, and `from('portava_featured')` appears nowhere in
--     travel-buddy-standalone), and that route serves it from the service
--     client (routes/featured.ts:113). The same is true of every other reader:
--     routes/mediaFeed.ts, routes/pulse.ts, routes/posts.ts, routes/adminFeatured.ts.
--
--     THIS GOES FURTHER THAN 2160 DID, AND THAT IS THE POINT. 2160 granted
--     SELECT back to anon and authenticated on the reasoning that "Featured is
--     public". Public it is — but public THROUGH THE API, not through
--     PostgREST, and on production that SELECT grant is already inert anyway
--     because RLS is on with zero policies. A grant no code uses is not a read
--     path; it is surface.
--
--     ⚠ ONE KNOWN CONSEQUENCE, STATED RATHER THAN DISCOVERED LATER.
--     src/test/portavaFeaturedWriteBoundary.test.ts:114-119 ("anon cannot
--     write, but the public read still works") asserts that an anon client gets
--     exactly one row back. That assertion encodes 2160's belief and it goes
--     RED against any database this migration is applied to. It is ALREADY red
--     against production today, for the RLS reason above — it passes on
--     portava-ci only because the two environments diverged. That test is
--     updated in the same change as this file. No other test, and no
--     application code path, asserts an anon or authenticated privilege on any
--     of these four tables.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT IS DELIBERATELY NOT CHANGED
-- ══════════════════════════════════════════════════════════════════════════════
-- * `postgres` keeps ALL. It owns these tables and an owner can re-grant itself
--   at will, so revoking from it buys the appearance of a constraint and not
--   the constraint. 2093 made the same call for the same reason.
-- * No RLS enablement is touched. portava_featured has RLS ON in production and
--   OFF in portava-ci; converging that is a separate, deliberate act with a
--   named owner (2160:29-32 deferred it). With anon and authenticated holding
--   no privilege at all, PostgREST denies them before RLS is ever consulted, so
--   the boundary here does not depend on which side of that divergence a
--   database sits.
-- * No policy is created, altered or dropped.
-- * DELETE by foreign-key cascade is unaffected. Referential actions execute as
--   the referencing table's owner with permission checks skipped, so an
--   auth.users cascade still reaches these rows without any role holding DELETE.
-- * rent_buddy_bookings and rent_buddy_fee_rules ALSO carry the full ALL set to
--   anon and authenticated in production (measured in the same read). They are
--   NOT touched here: both are read directly by live booking and pricing paths
--   that this file has not traced end to end, and revoking a grant that a real
--   read depends on would be a behaviour change. They are reported as remaining
--   M14 surface, not silently absorbed.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE POSTCONDITION
-- ══════════════════════════════════════════════════════════════════════════════
-- It reads aclexplode(pg_class.relacl) and pg_attribute.attacl, NOT
-- information_schema.role_table_grants. That is a correction to the shape 2160
-- used. information_schema does not report MAINTAIN at all, so a postcondition
-- written against it would have declared a table clean while a MAINTAIN grant
-- sat on it — the 2092 failure mode reproduced inside the check meant to catch
-- it. attacl covers the other blind spot: a column-level grant is invisible in
-- relacl, so revoking the table-level grant while a column grant survived would
-- read as success.
--
-- It asserts, for each of the four tables:
--   1. anon holds NO privilege        (table-level or column-level)
--   2. authenticated holds NO privilege (table-level or column-level)
--   3. PUBLIC (grantee OID 0) holds NO privilege
--   4. service_role holds EXACTLY DELETE, INSERT, SELECT, UPDATE — an equality
--      check, not a presence check, which is the whole lesson of 2093.
-- Any of the four failing RAISEs and rolls the transaction back.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- BEHAVIOUR
-- ══════════════════════════════════════════════════════════════════════════════
-- None. Every reader and writer of these four tables in this repository runs as
-- service_role and keeps every privilege it uses. What changes is what a role
-- is PERMITTED to do, not what any code does.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ROLLBACK — restores the exact prior grant set. The two environments differ,
-- so pick the block that matches the database you are rolling back. Both were
-- captured live on 2026-09-07 (aclexplode, PostgreSQL 17.6).
--
-- This restores PRIVILEGE, not safety: after either block, anon and
-- authenticated again hold the full ALL set (or, on portava-ci's
-- portava_featured, SELECT), and the boundary rests on RLS alone again.
--
-- ── travel-buddy / ajrurzioarfkagpuxfnb (PRODUCTION) ─────────────────────────
--   BEGIN;
--   GRANT ALL ON TABLE public.rent_buddy_earnings_ledger TO anon, authenticated, service_role;
--   GRANT ALL ON TABLE public.rent_buddy_payouts         TO anon, authenticated, service_role;
--   GRANT ALL ON TABLE public.rent_buddy_tips            TO anon, authenticated, service_role;
--   GRANT ALL ON TABLE public.portava_featured           TO anon, authenticated, service_role;
--   COMMIT;
--
-- ── portava-ci / hwokxgbmezheskbzskfr (the sanctioned CI project) ────────────
--   -- Identical except portava_featured, where 2160 had already reduced anon
--   -- and authenticated to SELECT.
--   BEGIN;
--   GRANT ALL ON TABLE public.rent_buddy_earnings_ledger TO anon, authenticated, service_role;
--   GRANT ALL ON TABLE public.rent_buddy_payouts         TO anon, authenticated, service_role;
--   GRANT ALL ON TABLE public.rent_buddy_tips            TO anon, authenticated, service_role;
--   GRANT ALL    ON TABLE public.portava_featured TO service_role;
--   GRANT SELECT ON TABLE public.portava_featured TO anon, authenticated;
--   COMMIT;
--
-- Neither block re-grants to PUBLIC, because PUBLIC held nothing on any of the
-- four tables in either database before this migration — verified, not assumed.
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── PRECONDITIONS ───────────────────────────────────────────────────────────
-- Existence only. Deliberately NOT asserting RLS state: portava_featured has
-- RLS ON in production and OFF in portava-ci, and this file is correct on both.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'public.rent_buddy_earnings_ledger',
    'public.rent_buddy_payouts',
    'public.rent_buddy_tips',
    'public.portava_featured'
  ] LOOP
    IF to_regclass(t) IS NULL THEN
      RAISE EXCEPTION 'PRECONDITION FAILED: % must exist before its grants can be bounded.', t;
    END IF;
  END LOOP;
END $$;

-- ── rent_buddy_earnings_ledger ──────────────────────────────────────────────
-- Writer: lib/rentBuddyEarningsLedger.ts:127 (upsert, service client).
-- Readers: routes/rentABuddyMarketplace.ts:1905, :2156, :2279 (service client).
-- rb_ledger_svc is FOR ALL; rb_ledger_buddy (SELECT, own rows) is latent — no
-- client code reads this table.
REVOKE ALL ON TABLE public.rent_buddy_earnings_ledger FROM PUBLIC;
REVOKE ALL ON TABLE public.rent_buddy_earnings_ledger FROM anon;
REVOKE ALL ON TABLE public.rent_buddy_earnings_ledger FROM authenticated;
REVOKE ALL ON TABLE public.rent_buddy_earnings_ledger FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rent_buddy_earnings_ledger TO service_role;

-- ── rent_buddy_payouts ──────────────────────────────────────────────────────
-- Only two references in the tree, both UPDATEs through the service client:
-- routes/rentABuddySpec.ts:2170 (hold) and :2208 (release). M2 records that the
-- table has no INSERT anywhere; INSERT is granted regardless, because
-- rb_payout_svc is FOR ALL and narrowing to the current call sites would encode
-- a defect (an empty table) as a permission.
REVOKE ALL ON TABLE public.rent_buddy_payouts FROM PUBLIC;
REVOKE ALL ON TABLE public.rent_buddy_payouts FROM anon;
REVOKE ALL ON TABLE public.rent_buddy_payouts FROM authenticated;
REVOKE ALL ON TABLE public.rent_buddy_payouts FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rent_buddy_payouts TO service_role;

-- ── rent_buddy_tips ─────────────────────────────────────────────────────────
-- routes/rentABuddyMarketplace.ts:1892 (upsert) and :2153 (read), service client.
-- rb_tips_own is FOR ALL with a null WITH CHECK, so its USING clause governs
-- writes too — a latent client write path that no client code exercises.
REVOKE ALL ON TABLE public.rent_buddy_tips FROM PUBLIC;
REVOKE ALL ON TABLE public.rent_buddy_tips FROM anon;
REVOKE ALL ON TABLE public.rent_buddy_tips FROM authenticated;
REVOKE ALL ON TABLE public.rent_buddy_tips FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rent_buddy_tips TO service_role;

-- ── portava_featured ────────────────────────────────────────────────────────
-- B-1. This is what 2160 was for, pressed properly: revoke from service_role
-- too, and do not grant a client SELECT that no client uses. Readers and
-- writers are routes/featured.ts:113, routes/mediaFeed.ts:1334, :1573,
-- routes/pulse.ts:311, routes/posts.ts:1893 and routes/adminFeatured.ts —
-- every one of them on the service client.
REVOKE ALL ON TABLE public.portava_featured FROM PUBLIC;
REVOKE ALL ON TABLE public.portava_featured FROM anon;
REVOKE ALL ON TABLE public.portava_featured FROM authenticated;
REVOKE ALL ON TABLE public.portava_featured FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.portava_featured TO service_role;

-- ── POSTCONDITIONS ──────────────────────────────────────────────────────────
-- Read from the catalog, not from the statements above. A claim about
-- privileges that is not checked against the catalog is a comment (2093).
DO $$
DECLARE
  t              text;
  rel            oid;
  client_privs   text;
  col_grants     int;
  public_privs   text;
  svc_privs      text;
  expected_svc   CONSTANT text := 'DELETE,INSERT,SELECT,UPDATE';
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'rent_buddy_earnings_ledger',
    'rent_buddy_payouts',
    'rent_buddy_tips',
    'portava_featured'
  ] LOOP
    rel := to_regclass('public.' || t);

    -- 1 + 2. anon and authenticated must hold NOTHING at table level.
    --        aclexplode sees MAINTAIN; information_schema does not.
    SELECT COALESCE(string_agg(DISTINCT pg_get_userbyid(ax.grantee) || ':' || ax.privilege_type,
                               ',' ORDER BY pg_get_userbyid(ax.grantee) || ':' || ax.privilege_type),
                    '')
      INTO client_privs
      FROM pg_class c, LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) ax
     WHERE c.oid = rel
       AND ax.grantee <> 0
       AND pg_get_userbyid(ax.grantee) IN ('anon', 'authenticated');

    IF client_privs <> '' THEN
      RAISE EXCEPTION
        'POSTCONDITION FAILED: public.% still grants the client roles: %. The revoke did not land.',
        t, client_privs;
    END IF;

    -- ...and nothing at COLUMN level either. A surviving column grant is
    -- invisible in relacl, so a table-level-only check would read as clean.
    SELECT count(*)
      INTO col_grants
      FROM pg_attribute a, LATERAL aclexplode(a.attacl) ax
     WHERE a.attrelid = rel
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND ax.grantee <> 0
       AND pg_get_userbyid(ax.grantee) IN ('anon', 'authenticated');

    IF col_grants <> 0 THEN
      RAISE EXCEPTION
        'POSTCONDITION FAILED: public.% retains % column-level grant(s) to anon/authenticated.',
        t, col_grants;
    END IF;

    -- 3. PUBLIC (grantee OID 0) must hold nothing — anon and authenticated
    --    inherit whatever PUBLIC holds, so a PUBLIC grant would silently undo
    --    checks 1 and 2.
    SELECT COALESCE(string_agg(DISTINCT ax.privilege_type, ',' ORDER BY ax.privilege_type), '')
      INTO public_privs
      FROM pg_class c, LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) ax
     WHERE c.oid = rel AND ax.grantee = 0;

    IF public_privs <> '' THEN
      RAISE EXCEPTION
        'POSTCONDITION FAILED: public.% still grants PUBLIC: %. anon and authenticated inherit it.',
        t, public_privs;
    END IF;

    -- 4. service_role must hold EXACTLY the four DML verbs. An EQUALITY check:
    --    presence checking is what let 2092 ship a limit it never established.
    SELECT COALESCE(string_agg(DISTINCT ax.privilege_type, ',' ORDER BY ax.privilege_type), '(none)')
      INTO svc_privs
      FROM pg_class c, LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) ax
     WHERE c.oid = rel
       AND ax.grantee <> 0
       AND pg_get_userbyid(ax.grantee) = 'service_role';

    IF svc_privs <> expected_svc THEN
      RAISE EXCEPTION
        'POSTCONDITION FAILED: public.% grants service_role [%], expected exactly [%]. TRUNCATE/REFERENCES/TRIGGER/MAINTAIN must not survive.',
        t, svc_privs, expected_svc;
    END IF;
  END LOOP;

  RAISE NOTICE
    'OK: 4 tables bounded — anon/authenticated/PUBLIC hold nothing, service_role holds exactly %.',
    expected_svc;
END $$;

COMMIT;
