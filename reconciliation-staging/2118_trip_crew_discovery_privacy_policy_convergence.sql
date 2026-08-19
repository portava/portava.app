-- 2118_trip_crew_discovery_privacy_policy_convergence.sql
--
-- STATUS: STAGED — NOT APPLIED. reconciliation-staging/, outside canonical.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- BLOCKED ON: Q3 (policies with predicates)
--
-- ROLLBACK NOT DERIVABLE FROM THIS REPOSITORY for any of the DROPs below
-- (§8 item 9d) — Q3's captured live text per table is the rollback. §8's
-- own instruction for this group applies literally: "Do not batch 2118's
-- four tables into one transaction." This file covers three of the four —
-- see the SPLIT note below for why the fourth (passport_stamps) is
-- separate. Apply each of THIS file's three tables in its own reviewed
-- step even though they are in one file; do not treat the shared file as
-- license to batch them.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- SPLIT FROM THE PACKET'S ORIGINAL GROUPING
-- ============================================
-- RECONCILIATION-PACKET.md §7 row 2118 groups four tables — passport_stamps,
-- trip_crew_location_sessions, discovery_places, user_privacy_settings —
-- under one corrective, with its own caveat: "If Q3 shows any one is
-- materially riskier, split it out — this packet should not group a
-- security change with a cosmetic one." Direct-read verification found
-- exactly that: `passport_stamps`'s legacy policy family
-- (`passport_stamps_public_read`) reads `USING (visibility = 'public')`
-- against a `visibility` column that CANONICAL'S OWN `CREATE TABLE
-- passport_stamps` does not declare at all. Recreating or dropping that
-- policy without knowing whether `visibility` exists live is a materially
-- different risk (a column-existence hazard, not just a permission
-- question) from the other three tables, none of which has this problem.
-- `passport_stamps` is therefore split into its own file,
-- `2118b_passport_stamps_policy_convergence.sql`. This file covers the
-- other three.
--
-- WHAT THIS RESOLVES
-- ==================
-- Three tables, each with 2-3 disjoint or partially-disjoint policy
-- families across canonical/legacy/root, all from RECONCILIATION-PACKET.md
-- §4.3 DISJOINT_POLICY_FAMILY / §7 row 2118.
--
-- ── trip_crew_location_sessions ──────────────────────────────────────────
--   canonical (0041, src/migrations): crew_session_owner_select (SELECT,
--     auth.uid()=user_id OR auth.uid()=ANY(allowed_member_ids) —
--     allowed_member_ids is uuid[] in this tree), crew_session_owner_insert
--     (INSERT, auth.uid()=user_id), crew_session_owner_update (UPDATE,
--     auth.uid()=user_id). No DELETE, no service_role.
--   legacy: crew_sessions_self (FOR ALL, auth.uid()=user_id),
--     crew_sessions_recipients_read (SELECT, status='active' AND
--     expires_at>now() AND auth.uid()::text = ANY(allowed_member_ids) AND
--     trip-owner-or-member check) — this tree's OWN allowed_member_ids is
--     `text[]`, so the `::text` cast is correct FOR THIS TREE'S SHAPE. Per
--     `.agents/memory/legacy-migration-reconciliation.md`: "
--     trip_crew_location_sessions.allowed_member_ids is uuid[] (drop ::text
--     casts in policies)" — i.e. live is confirmed uuid[], so a policy using
--     the `::text` form against it is exactly the kind of type mismatch that
--     memory entry warns against. This file's converged policy branches on
--     the LIVE column type rather than assuming which tree's shape is live.
--   root: crew_loc_sessions_own (FOR ALL, auth.uid()=user_id),
--     crew_loc_sessions_trip_member_read (SELECT, EXISTS trip_members join —
--     ANY trip member, not just allowed_member_ids recipients — a wider
--     grant than canonical or legacy intended), crew_loc_sessions_service
--     (FOR ALL TO service_role, true).
--   Converged target: one SELECT (owner OR allowed-member, canonical's
--   narrower and more correct predicate — NOT root's any-trip-member
--   version, which is broader than what the table's own purpose, a
--   per-recipient live-share grant, calls for), one INSERT/UPDATE/DELETE set
--   for the owner. No service_role policy recreated (redundant with
--   BYPASSRLS, consistent with this package's convention — see 2100/2106).
--
-- ── discovery_places ──────────────────────────────────────────────────────
--   Two NEW findings, distinct from a simple name mismatch:
--   (1) canonical's `discovery_places_public_read` is `USING (status =
--   'active')`; legacy's AND root's SAME-NAMED policy is `USING (true)` —
--   unfiltered. Same name, different predicate — exactly the "name-only
--   hole" RECONCILIATION-PACKET.md §3.3 describes for the forward auditor,
--   found here directly. Only one of these three ever successfully applied
--   (a second `CREATE POLICY` under an existing name errors, it does not
--   silently no-op), so whichever ran first is what is live today — Q3
--   settles which. This migration's target predicate is canonical's
--   `status = 'active'` (the stricter of the two) — if live is currently
--   the unfiltered version, applying this IS a real behavior change
--   (provisional/non-active places stop being publicly visible), not a
--   cosmetic rename, and should be reviewed as such rather than assumed
--   equivalent to what runs today.
--   (2) canonical's `discovery_places_auth_insert` WITH CHECK is only
--   `auth.uid() IS NOT NULL` — it does NOT require `submitted_by =
--   auth.uid()`, so as declared, any authenticated user could insert a row
--   attributing it to someone else's profile id. Legacy's and root's INSERT
--   checks both require `submitted_by = auth.uid()` (legacy: `auth.uid() IS
--   NOT NULL AND submitted_by = auth.uid()`; root: `auth.uid() =
--   submitted_by`). This migration adopts the STRICTER legacy/root
--   predicate, not canonical's own looser one — canonical's own policy is
--   the gap here, not the fix.
--   Converged target: `discovery_places_public_read` (status='active'),
--   `discovery_places_auth_insert` (auth.uid() IS NOT NULL AND submitted_by
--   = auth.uid()), `discovery_places_owner_update` /
--   `discovery_places_owner_delete` (submitted_by = auth.uid()). Root's
--   `discovery_places_service` not recreated (redundant with BYPASSRLS).
--
-- ── user_privacy_settings ─────────────────────────────────────────────────
--   canonical (0063): "Users can manage their own privacy settings" FOR ALL
--   USING (auth.uid() = user_id) — one policy, all commands.
--   docs/sql (0062, a DIFFERENT table shape entirely — enum-typed columns,
--   user_id as the PK rather than a surrogate id — a MERGED_LIVE_SHAPE
--   concern this file does not attempt to resolve, policy-layer only):
--   privacy_settings_select_own (SELECT), privacy_settings_update_own
--   (UPDATE), privacy_settings_insert_own (INSERT) — no DELETE policy at
--   all. Both families are owner-scoped and security-equivalent except
--   that canonical's FOR ALL additionally grants DELETE, which docs/sql's
--   three-policy family never granted. Converging onto canonical's simpler
--   FOR ALL is a real (small) widening if docs/sql's family is what is
--   live — noted, not hidden.
--   Converged target: canonical's single FOR ALL policy; docs/sql's three
--   names dropped.

BEGIN;

-- ── Precondition ─────────────────────────────────────────────────────────
DO $$
DECLARE
  allowed_member_ids_type text;
BEGIN
  IF to_regclass('public.trip_crew_location_sessions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.trip_crew_location_sessions does not exist live.';
  END IF;
  IF to_regclass('public.discovery_places') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.discovery_places does not exist live.';
  END IF;
  IF to_regclass('public.user_privacy_settings') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.user_privacy_settings does not exist live.';
  END IF;

  SELECT data_type INTO allowed_member_ids_type
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'trip_crew_location_sessions'
     AND column_name = 'allowed_member_ids';

  IF allowed_member_ids_type IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: trip_crew_location_sessions.allowed_member_ids does not exist live.';
  END IF;
  IF allowed_member_ids_type NOT IN ('ARRAY') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: trip_crew_location_sessions.allowed_member_ids is not an array type live (found %). Re-derive from Q2.', allowed_member_ids_type;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user_privacy_settings' AND column_name = 'user_id'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: user_privacy_settings.user_id does not exist live.';
  END IF;
END $$;

-- ── The change ───────────────────────────────────────────────────────────

-- trip_crew_location_sessions — branch policy predicate on the LIVE element
-- type of allowed_member_ids so this file never reintroduces the ::text
-- cast the repo's own memory flags as wrong for a uuid[] column.
DO $$
DECLARE
  element_type text;
  select_predicate text;
BEGIN
  SELECT udt_name INTO element_type
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'trip_crew_location_sessions'
     AND column_name = 'allowed_member_ids';
  -- udt_name for a uuid[] column is '_uuid'; for text[] it is '_text'.

  DROP POLICY IF EXISTS crew_session_owner_select     ON public.trip_crew_location_sessions;
  DROP POLICY IF EXISTS crew_session_owner_insert     ON public.trip_crew_location_sessions;
  DROP POLICY IF EXISTS crew_session_owner_update     ON public.trip_crew_location_sessions;
  DROP POLICY IF EXISTS crew_sessions_self            ON public.trip_crew_location_sessions;
  DROP POLICY IF EXISTS crew_sessions_recipients_read ON public.trip_crew_location_sessions;
  DROP POLICY IF EXISTS crew_loc_sessions_own          ON public.trip_crew_location_sessions;
  DROP POLICY IF EXISTS crew_loc_sessions_trip_member_read ON public.trip_crew_location_sessions;
  DROP POLICY IF EXISTS crew_loc_sessions_service      ON public.trip_crew_location_sessions;

  IF element_type = '_uuid' THEN
    select_predicate := 'auth.uid() = user_id OR auth.uid() = ANY(allowed_member_ids)';
  ELSIF element_type = '_text' THEN
    select_predicate := 'auth.uid() = user_id OR auth.uid()::text = ANY(allowed_member_ids)';
  ELSE
    RAISE EXCEPTION 'trip_crew_location_sessions.allowed_member_ids has unexpected element type % — refusing to guess a cast.', element_type;
  END IF;

  EXECUTE format(
    'CREATE POLICY trip_crew_location_sessions_select ON public.trip_crew_location_sessions FOR SELECT USING (%s)',
    select_predicate
  );
  CREATE POLICY trip_crew_location_sessions_insert ON public.trip_crew_location_sessions
    FOR INSERT WITH CHECK (auth.uid() = user_id);
  CREATE POLICY trip_crew_location_sessions_update ON public.trip_crew_location_sessions
    FOR UPDATE USING (auth.uid() = user_id);
  CREATE POLICY trip_crew_location_sessions_delete ON public.trip_crew_location_sessions
    FOR DELETE USING (auth.uid() = user_id);
END $$;

-- discovery_places
DROP POLICY IF EXISTS discovery_places_public_read  ON public.discovery_places;
DROP POLICY IF EXISTS discovery_places_auth_insert  ON public.discovery_places;
DROP POLICY IF EXISTS discovery_places_owner_update ON public.discovery_places;
DROP POLICY IF EXISTS discovery_places_owner_delete ON public.discovery_places;
DROP POLICY IF EXISTS discovery_places_own_update   ON public.discovery_places;
DROP POLICY IF EXISTS discovery_places_own_delete   ON public.discovery_places;
DROP POLICY IF EXISTS discovery_places_service      ON public.discovery_places;

CREATE POLICY discovery_places_public_read ON public.discovery_places
  FOR SELECT USING (status = 'active');
CREATE POLICY discovery_places_auth_insert ON public.discovery_places
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL AND submitted_by = auth.uid());
CREATE POLICY discovery_places_owner_update ON public.discovery_places
  FOR UPDATE USING (auth.uid() = submitted_by);
CREATE POLICY discovery_places_owner_delete ON public.discovery_places
  FOR DELETE USING (auth.uid() = submitted_by);

-- user_privacy_settings
DROP POLICY IF EXISTS "Users can manage their own privacy settings" ON public.user_privacy_settings;
DROP POLICY IF EXISTS privacy_settings_select_own ON public.user_privacy_settings;
DROP POLICY IF EXISTS privacy_settings_update_own ON public.user_privacy_settings;
DROP POLICY IF EXISTS privacy_settings_insert_own ON public.user_privacy_settings;

CREATE POLICY "Users can manage their own privacy settings" ON public.user_privacy_settings
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ── Postcondition ────────────────────────────────────────────────────────
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='trip_crew_location_sessions') <> 4 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected exactly 4 policies on trip_crew_location_sessions.';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='discovery_places') <> 4 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected exactly 4 policies on discovery_places.';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='user_privacy_settings') <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected exactly 1 policy on user_privacy_settings.';
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
-- Cannot be written here for any of the DROPs — see BLOCKED ON banner. Once
-- Q3's pre-apply capture exists per table, the rollback is CREATE POLICY of
-- each captured name/predicate, verbatim, plus dropping this file's four
-- new names per table. Apply/roll back one table at a time, per §8's
-- explicit instruction not to batch this corrective's tables into one
-- transaction — even though they share a file here for review convenience.

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run after apply)
-- ═══════════════════════════════════════════════════════════════════════════
-- SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies
--  WHERE schemaname = 'public'
--    AND tablename IN ('trip_crew_location_sessions','discovery_places','user_privacy_settings')
--  ORDER BY tablename, policyname;
