-- 2335_layover_recommendation_write_boundary.sql
--
-- `layover_recommendations` stops being writable by the traveller it describes.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2335.
--
-- Idempotent (DROP POLICY IF EXISTS / CREATE, REVOKE-then-GRANT). Creates no
-- table, drops no column, writes no row, flips no flag.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE DEFECT, MEASURED — NOT INFERRED
-- ══════════════════════════════════════════════════════════════════════════════
-- Read 2026-09-07 from BOTH databases (pg_policies + information_schema
-- .role_table_grants). The two are IDENTICAL on every fact below:
--
--   travel-buddy   ajrurzioarfkagpuxfnb   (production — 3,206 airport profiles,
--                                          live sessions, all six Layover flags TRUE)
--   portava-ci     hwokxgbmezheskbzskfr   (the sanctioned CI project)
--
-- The policy, as it stands (migrations/0127_layover_system.sql:142-151):
--
--   CREATE POLICY "layover_recs_owner"
--     ON layover_recommendations FOR ALL TO authenticated
--     USING (session_id IN (SELECT id FROM layover_sessions WHERE user_id = auth.uid()));
--
-- `pg_policies.with_check` is NULL. **A FOR ALL policy with no WITH CHECK reuses
-- its USING expression as the write check.** The predicate only asks "is this row
-- attached to one of your own sessions", so for a session owner it is TRUE on
-- every INSERT and UPDATE they could want to make.
--
-- And the grant is real, not theoretical. `authenticated` holds the full
-- privilege set on this table — DELETE, INSERT, REFERENCES, SELECT, TRIGGER,
-- TRUNCATE, UPDATE — the blanket set Supabase's ALTER DEFAULT PRIVILEGES hands
-- out at CREATE TABLE time and which 0127 never took back. RLS is ENABLED, so
-- the policy is the only thing standing between an end-user key and this table.
-- It stands aside.
--
-- ── WHAT THAT BUYS AN ATTACKER ───────────────────────────────────────────────
-- Demonstrated on portava-ci on 2026-09-07 inside a transaction that was rolled
-- back: acting as role `authenticated` with request.jwt.claims.sub set to the
-- session's owner — i.e. exactly what PostgREST does with a normal end-user
-- token, no privilege escalation of any kind —
--
--   UPDATE layover_recommendations
--      SET safety_rating = 'safe', return_buffer_min = 0,
--          hard_return_time = now() + interval '7 hours'
--    WHERE id = <the server-authored row>;          -->  ALLOWED, 1 row rewritten
--
--   INSERT INTO layover_recommendations (session_id, ..., safety_rating,
--          return_buffer_min, hard_return_time, source)
--   VALUES (<own session>, ..., 'safe', 0, now() + interval '7 hours', 'user');
--                                                   -->  ALLOWED
--
-- `safety_rating`, `return_buffer_min` and `hard_return_time` are not opinions.
-- They are the output of LayoverSafetyEngine — the numbers that tell a traveller
-- standing in a foreign city when they must start heading back to make their
-- flight. They are server-authoritative by construction and must not be
-- settable by the subject of the advice.
--
-- The sibling table created in the SAME migration file
-- (`layover_plan_stops`, 0127:177-190) carries both USING and WITH CHECK. This
-- table's missing clause is an omission, not a design.
--
-- ── WHY THE FIX IS "READ ONLY", NOT "ADD A WITH CHECK" ───────────────────────
-- A WITH CHECK cannot help here. Postgres row policies are row-scoped, not
-- column-scoped: any predicate strong enough to admit the row admits every
-- column value in it. The question is therefore not "which writes are valid"
-- but "does the end user write this table at all", and the answer, read from
-- the tree, is no. Every access path is server-side under the service key:
--
--   services/airport/LayoverRecommendationService.ts:311,315,359   delete / insert / select
--   routes/airport.ts:1175, 1838, 1872                             select / admin select / admin update
--
-- All six sit behind `getServiceClient()` (routes/airport.ts:28). service_role
-- has BYPASSRLS, so none of them is governed by this policy and none of them
-- changes behaviour here. A tree-wide grep for `layover_recommendations` across
-- every .ts and .tsx file finds no client-side writer — the mobile app reads
-- recommendations through the API and never touches the table directly.
--
-- Production bears that out: all 30 recommendation rows carry source = 'ai'.
-- Zero rows have ever been written with source 'user' or 'admin'.
--
-- So the correct boundary is the one this migration installs: authenticated may
-- SELECT its own rows and may do nothing else.
--
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════════
-- SECTION 1 — the defect: layover_recommendations becomes read-only to users
-- ═════════════════════════════════════════════════════════════════════════════

-- The FOR ALL policy goes. Its USING predicate is preserved verbatim as the
-- read rule — visibility is unchanged, only the write door closes.
DROP POLICY IF EXISTS "layover_recs_owner" ON public.layover_recommendations;

CREATE POLICY "layover_recs_owner"
  ON public.layover_recommendations FOR SELECT TO authenticated
  USING (
    session_id IN (
      SELECT id FROM public.layover_sessions WHERE user_id = auth.uid()
    )
  );

-- With one FOR SELECT policy and no other policy on the table, RLS denies every
-- INSERT, UPDATE and DELETE to every non-BYPASSRLS role. The grants below are
-- defence in depth on top of that — and they are NOT decorative: a GRANT with no
-- preceding REVOKE cannot narrow Supabase's default ALL, so the REVOKEs are what
-- does the work. Pattern per migrations/2217_protected_locations.sql:156-161.
REVOKE ALL ON public.layover_recommendations FROM PUBLIC;
REVOKE ALL ON public.layover_recommendations FROM anon;
REVOKE ALL ON public.layover_recommendations FROM authenticated;
REVOKE ALL ON public.layover_recommendations FROM service_role;

-- authenticated: reads only, and RLS still restricts those reads to own sessions.
GRANT SELECT ON public.layover_recommendations TO authenticated;

-- service_role: the only writer. It is what every route and the recommendation
-- service authenticate as. TRUNCATE is deliberately NOT re-granted — nothing in
-- the tree truncates this table, and TRUNCATE is the one verb RLS does not police.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.layover_recommendations TO service_role;

-- anon (the UNAUTHENTICATED public role) is granted nothing at all. It never had
-- a policy on this table, so RLS already denied it every row; this removes the
-- inert grant so the table no longer *looks* reachable to a future reader.

-- ═════════════════════════════════════════════════════════════════════════════
-- SECTION 2 — the same hazard class on the sibling layover tables: TRUNCATE
-- ═════════════════════════════════════════════════════════════════════════════
-- Independent of section 1; either may be rolled back without the other.
--
-- The other four Layover tables have RLS policies that are correct for the
-- verbs RLS governs, so their DML grants are left EXACTLY as they are — this
-- section changes no INSERT, UPDATE, DELETE or SELECT privilege anywhere.
--
-- TRUNCATE is the exception, and it is the reason this section exists.
-- PostgreSQL does not apply row-level security to TRUNCATE: a role holding it
-- empties the table whatever the policies say. `anon` and `authenticated` hold
-- TRUNCATE on all four by the same ALTER DEFAULT PRIVILEGES accident. Today the
-- only thing preventing an instant wipe of every live layover session, every
-- audit event and all 3,206 airport profiles is that PostgREST exposes no
-- TRUNCATE verb — an absent verb, not a permission. Same finding, same
-- reasoning, as 2333's FINDING 1.
--
-- Nothing in the tree truncates any of these tables.
REVOKE TRUNCATE ON public.layover_sessions   FROM anon, authenticated;
REVOKE TRUNCATE ON public.layover_events     FROM anon, authenticated;
REVOKE TRUNCATE ON public.layover_plan_stops FROM anon, authenticated;
REVOKE TRUNCATE ON public.airport_profiles   FROM anon, authenticated;

COMMIT;
