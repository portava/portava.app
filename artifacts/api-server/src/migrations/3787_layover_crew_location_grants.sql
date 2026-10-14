-- 3787_layover_crew_location_grants.sql
--
-- THE §14 L4 GRANT STORE: `layover_crew_location_grants`, and the flag that
-- keeps it dark: `layover_crew_location_sharing_enabled`, seeded FALSE.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band). Layover band
-- 3784-3799 (B58 lane LAY-C1; census-layover L166, L203). Creates ONE new table
-- and seeds ONE flag row. Alters nothing that exists. Moves no row. ADDS NO
-- COORDINATE COLUMN ANYWHERE — see THIS FILE STORES PERMISSION, NOT POSITION.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHERE THIS CAME FROM
-- ══════════════════════════════════════════════════════════════════════════════
-- PORTED BY CONTENT from open PR #569's `3516_layover_crew_location_grants.sql`
-- (another session's branch `claude/crew-itinerary-location-grants-4ikowf`,
-- stale since 2026-10-03), under lead ruling LR-B58-1. Renumbered into the
-- layover band. The table, its CHECKs, its index, its four RESTRICTIVE client
-- denials and its catalog postconditions are #569's, re-read against current
-- main and re-tested here (src/test/db/layoverCrewLocationGrants.db.test.ts).
-- What is NEW in this file: `public.` on the CREATE (#569 omitted it), the
-- feature-flag seed and its postcondition, and the APPLY ORDER section's
-- dependency on 2992 for the airport re-entry terminator.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY
-- ══════════════════════════════════════════════════════════════════════════════
-- §14's visibility ladder ends at "L4 temporary location — explicit, scoped,
-- auto-expiring", §17 at "Precise crew sharing: separate explicit control, off
-- by default" (census L166) and "Crew membership/location rows require
-- membership and explicit permission" (L203). The code that enforces the
-- ladder is pure and already on main: `services/airport/LayoverCrewService.ts`
-- has `CrewLocationGrant`, `evaluateCrewLocationShare` and
-- `locationPrecisionFor`, with a sweep asserting there is no argument
-- combination that yields `precise` without a grant. It has had nowhere to
-- read a grant from. This is that place.
--
-- 2984 says why the store comes FIRST: "Adding a lat/lng column now would
-- create a place to put a coordinate BEFORE the thing that decides whether it
-- may be shown, which is the order that produces a leak." This is the thing
-- that decides, applied before any column that could hold a position exists.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THIS FILE STORES PERMISSION, NOT POSITION
-- ══════════════════════════════════════════════════════════════════════════════
-- The table holds who said yes, to which crew, from which of their sessions,
-- from when, until when, and whether they have since revoked. It holds NO
-- coordinate, and 2984's postcondition asserting the crew tables have none is
-- left standing and re-checked below.
--
-- A grant is the only thing that can be stored safely on its own: a stale
-- grant grants nothing, because the share is evaluated against the clock at
-- read time and an expired row is inert. A stale POSITION is a traveller's
-- whereabouts, published for as long as nothing deletes it. Where a position is
-- eventually held is a separate decision with a separate retention answer
-- (census-layover LAY-C2, its own migration), and this file does not pre-empt it.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- A GRANT WITH NO EXPIRY IS NOT EXPRESSIBLE
-- ══════════════════════════════════════════════════════════════════════════════
--   * `expires_at TIMESTAMPTZ NOT NULL` with NO DEFAULT. Not nullable, because
--     NULL would be the "forever" this ladder has no word for. No default,
--     because a default is a duration, and an INSERT that omits the column must
--     fail rather than silently acquire whichever TTL a migration once guessed.
--   * `CHECK (expires_at > granted_at)`. A grant that expires at or before the
--     instant it was given authorises nothing and would be reported as
--     `ttl_elapsed`, blaming the TTL for a write that was never valid.
--
-- THERE IS NO MAXIMUM TTL IN THIS FILE, AND THAT IS DELIBERATE (owner question
-- OQ-2 stays open). §14 says "temporary" and names no duration. What bounds a
-- grant instead is DERIVED and lives in the route
-- (`LayoverCrewLocationGrantStore.boundedGrantWindow`): the crew's own
-- `expires_at` and the granter's certified hard return. A grant also ends at
-- the earliest §14.1 terminator — crew dissolved, airport re-entry, boarding,
-- session expired, revoked — evaluated at read time.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- REVOCATION IS A COLUMN, AND IT IS NOT THE SAME AS EXPIRY
-- ══════════════════════════════════════════════════════════════════════════════
-- `revoked_at` is set rather than deleting the row, so "they took it back at
-- 14:02" (`user_revoked`) stays distinguishable from "they never said yes"
-- (`never_granted`). A revoked row is a record that this person shared their
-- location with this crew at this hour, and it survives revocation. It is NOT
-- kept indefinitely: `crew_id` and `session_id` both cascade, the crew expiry
-- sweep deletes expired crews, and account deletion deletes the traveller's
-- sessions (lib/deletionDispositions.ts, ERASED_BY_CASCADE), so every grant row
-- goes with its crew or its session.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- NO UNIQUE INDEX ON (crew_id, granted_by_user_id), AND WHY NOT
-- ══════════════════════════════════════════════════════════════════════════════
-- Unqualified, it forbids re-granting after a revocation. Partial (`WHERE
-- revoked_at IS NULL`), it forbids re-granting after an EXPIRY, the common case.
-- So grants accumulate, one row per act of consent, and the store reads the
-- NEWEST one per person, revoked or not. Revocation revokes EVERY unrevoked row
-- the person holds, so "I revoked" never depends on a reader's sort order.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WRITE BOUNDARY — NOT CLIENT-READABLE OR CLIENT-WRITABLE
-- ══════════════════════════════════════════════════════════════════════════════
-- RLS enabled; every privilege revoked from PUBLIC/anon/authenticated
-- (check:client-privilege-boundary rule 4); the four operations GRANTed to
-- `service_role` explicitly; four RESTRICTIVE client-deny policies. A
-- RESTRICTIVE policy ANDs with every permissive one, so the denial survives a
-- later permissive policy. The postcondition asserts `0 permissive AND exactly
-- 4 restrictive`.
--
-- The obvious policy — "a traveller may read and write their own grants",
-- `granted_by_user_id = auth.uid()` — is precisely the wrong one: a client that
-- can INSERT its own grant chooses its own `expires_at`, and the bound that
-- keeps a grant temporary is server-side arithmetic. A SELECT-only policy is
-- declined too: who may learn that A shares their location with a crew is the
-- composed question (same crew, blocks both ways, mutual follow, the sharing
-- gate) that the server answers, and a membership-scoped policy would be a
-- weaker second answer underneath it.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE FLAG
-- ══════════════════════════════════════════════════════════════════════════════
-- `layover_crew_location_sharing_enabled`, seeded FALSE. OFF (and absent, which
-- `isFlagEnabled` reads as OFF): no grant can be created, no share is reported
-- active, the crew card does not show the control. Turning it on is an owner
-- decision (OQ-1, OQ-2) and is pointless before:
--   * this file is applied (the store), AND
--   * 2992 is applied and `layover_decision_persistence_enabled` is ON — the
--     AIRPORT_REENTRY terminator reads 2992's `layover_checkpoints`, and an
--     unreadable or absent checkpoint store means the share is NOT active
--     (fail-closed), AND
--   * a position store exists (census-layover LAY-C2). Until then a grant is a
--     permission nothing reads.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- APPLY ORDER
-- ══════════════════════════════════════════════════════════════════════════════
-- Depends on 2984 (`layover_crews`), 0127 (`layover_sessions`), `profiles` and
-- `feature_flags`. Safe to apply at any time: an empty table is read as
-- `never_granted`, and the flag row is FALSE.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- REVERSIBLE BY
-- ══════════════════════════════════════════════════════════════════════════════
-- db/rollback/2026-10-14-3787-layover-crew-location-grants-rollback.sql. It
-- refuses while the flag is TRUE, reports the row count before dropping, drops
-- the table and deletes the FALSE flag row.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHERE THE REAL-RLS EVIDENCE LIVES
-- ══════════════════════════════════════════════════════════════════════════════
-- Not in this file. A probe inside the migration's own transaction can only
-- undo itself by aborting, which rolls back the DDL batched with it while the
-- migration still reports success (2195's defect, forbidden by
-- src/test/migrationDeployability.test.ts). So this file INSERTS NOTHING into
-- the new table and assumes no role; its postcondition block runs AFTER
-- `COMMIT` as catalog assertions only; and the probe lives in
-- src/test/db/layoverCrewLocationGrants.db.test.ts.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.layover_crews') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3787): public.layover_crews does not exist. Apply 2984_layover_crews.sql first.';
  END IF;
  IF to_regclass('public.layover_sessions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3787): public.layover_sessions does not exist. Apply 0127_layover_system.sql first.';
  END IF;
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3787): public.profiles does not exist.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3787): public.feature_flags does not exist.';
  END IF;
END $$;

-- ── §14 L4: the temporary location grant ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.layover_crew_location_grants (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- SCOPED, the first of §14 L4's three words. `locationPrecisionFor` refuses
  -- to widen a grant beyond the crew it names (`grant_scoped_to_another_crew`).
  crew_id              UUID        NOT NULL REFERENCES public.layover_crews(id) ON DELETE CASCADE,

  -- EXPLICIT, the second. The person whose position this authorises, and the
  -- only person who can have authorised it (`grant_not_from_target`).
  granted_by_user_id   UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

  -- The granter's own layover, the one they are in this crew with. §17:
  -- "Precise crew/live location — session scoped; expire automatically".
  -- `session_expired`, boarding and airport re-entry are all facts about THIS
  -- session, so it is stored rather than guessed.
  session_id           UUID        NOT NULL REFERENCES public.layover_sessions(id) ON DELETE CASCADE,

  granted_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- AUTO-EXPIRING, the third. NOT NULL and NO DEFAULT.
  expires_at           TIMESTAMPTZ NOT NULL,

  -- Set on revocation rather than deleting the row.
  revoked_at           TIMESTAMPTZ,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT layover_crew_location_grants_positive_window
    CHECK (expires_at > granted_at),

  CONSTRAINT layover_crew_location_grants_revocation_after_grant
    CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);

-- The read the store makes: the NEWEST grant per person per crew. DELIBERATELY
-- NOT PARTIAL on `revoked_at IS NULL`: a reader that skipped revoked rows could
-- not see a revocation and would report `never_granted` for a traveller who
-- said yes and took it back.
CREATE INDEX IF NOT EXISTS layover_crew_location_grants_newest_idx
  ON public.layover_crew_location_grants(crew_id, granted_by_user_id, granted_at DESC);

COMMENT ON TABLE public.layover_crew_location_grants IS
  'spec §14 L4 / §17 / census-layover L166, L203 (3787, ported from PR #569''s 3516): the explicit, scoped, auto-expiring permission CrewLocationGrant describes — who said yes, to which crew, from which session, from when, until when, and whether they revoked. Holds PERMISSION, not position: no coordinate column, here or on 2984''s tables. Service role only; read and written only behind layover_crew_location_sharing_enabled (seeded FALSE here).';

ALTER TABLE public.layover_crew_location_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.layover_crew_location_grants FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.layover_crew_location_grants TO service_role;

-- ── The four restrictive client denials ──────────────────────────────────────
DO $policies$
DECLARE v_op TEXT;
BEGIN
  FOREACH v_op IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.layover_crew_location_grants',
      format('layover_crew_location_grants_deny_%s_clients', lower(v_op)));
    EXECUTE format(
      'CREATE POLICY %I ON public.layover_crew_location_grants AS RESTRICTIVE FOR %s TO anon, authenticated %s',
      format('layover_crew_location_grants_deny_%s_clients', lower(v_op)), v_op,
      CASE v_op
        WHEN 'INSERT' THEN 'WITH CHECK (false)'
        WHEN 'UPDATE' THEN 'USING (false) WITH CHECK (false)'
        ELSE 'USING (false)'
      END);
  END LOOP;
END
$policies$;

-- ── The flag, seeded OFF ─────────────────────────────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'layover_crew_location_sharing_enabled',
    false,
    'Layover L166/L203 (3787): the precise crew location-sharing control. ON: a crew member may explicitly grant this crew permission to see their precise location (POST/DELETE /api/airport/sessions/:id/crew/location-grant), bounded by the crew''s life and their certified hard return and ended by the first §14.1 terminator; GET /crew reports yourShare. Visible only to current members of the same crew who follow each other (D-103 mutual), with no block either way. OFF / absent (the seed): no grant can be created, no share is reported active, the control is not shown. Enabling is an owner decision (OQ-1, OQ-2) and is inert before 3787 and 2992 are applied, layover_decision_persistence_enabled is ON (airport re-entry is unverifiable otherwise) and a position store exists (LAY-C2).'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions ───────────────────────────────────────────────────────────
-- AFTER `COMMIT`, deliberately. Catalog state and the flag row only, no temp
-- table, no before/after comparison, no row written and no role assumed — so
-- the block can be re-run standalone and a failing assertion cannot roll back
-- the DDL it is asserting about.
DO $post$
DECLARE
  permissive_count INTEGER;
  restrictive_count INTEGER;
  client_cols INTEGER;
  client_tables INTEGER;
  expires_nullable TEXT;
  expires_default TEXT;
  coord_cols INTEGER;
  window_check INTEGER;
BEGIN
  IF to_regclass('public.layover_crew_location_grants') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3787): layover_crew_location_grants missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'layover_crew_location_grants' AND c.relrowsecurity = TRUE
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3787): RLS not enabled on layover_crew_location_grants';
  END IF;

  -- NO PERMISSIVE POLICY: even an own-rows policy lets a client choose its own
  -- expires_at, and the bound on a grant's life exists only in the route.
  SELECT count(*) INTO permissive_count
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'layover_crew_location_grants'
     AND permissive = 'PERMISSIVE';
  IF permissive_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3787): % permissive policy/policies on layover_crew_location_grants, expected 0. The write must be server-mediated or a grant is not bounded at all.', permissive_count;
  END IF;

  SELECT count(*) INTO restrictive_count
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'layover_crew_location_grants'
     AND permissive = 'RESTRICTIVE';
  IF restrictive_count <> 4 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3787): % restrictive client-deny policy/policies on layover_crew_location_grants, expected 4 (SELECT/INSERT/UPDATE/DELETE)', restrictive_count;
  END IF;

  IF NOT (
    has_table_privilege('service_role', 'public.layover_crew_location_grants', 'SELECT')
    AND has_table_privilege('service_role', 'public.layover_crew_location_grants', 'INSERT')
    AND has_table_privilege('service_role', 'public.layover_crew_location_grants', 'UPDATE')
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3787): service_role lacks SELECT/INSERT/UPDATE on layover_crew_location_grants; granting and revoking would both refuse.';
  END IF;

  -- No client grant of ANY kind, table or column, read included.
  SELECT count(*) INTO client_tables
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND table_name = 'layover_crew_location_grants'
     AND grantee IN ('anon','authenticated','PUBLIC');
  IF client_tables <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3787): % client table grant(s) on layover_crew_location_grants, expected 0', client_tables;
  END IF;
  SELECT count(*) INTO client_cols
    FROM information_schema.column_privileges
   WHERE table_schema = 'public'
     AND table_name = 'layover_crew_location_grants'
     AND grantee IN ('anon','authenticated');
  IF client_cols <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3787): % client column grant(s) on layover_crew_location_grants, expected 0', client_cols;
  END IF;

  -- "AUTO-EXPIRING" AS A SCHEMA FACT: not nullable AND no default.
  SELECT is_nullable, column_default INTO expires_nullable, expires_default
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'layover_crew_location_grants'
     AND column_name = 'expires_at';
  IF expires_nullable IS DISTINCT FROM 'NO' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3787): layover_crew_location_grants.expires_at is nullable. NULL would be a grant that never expires.';
  END IF;
  IF expires_default IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3787): layover_crew_location_grants.expires_at has default %, expected none. No duration has been chosen for a §14 L4 grant (OQ-2).', expires_default;
  END IF;

  SELECT count(*) INTO window_check
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public' AND t.relname = 'layover_crew_location_grants'
     AND c.contype = 'c'
     AND c.conname IN ('layover_crew_location_grants_positive_window',
                       'layover_crew_location_grants_revocation_after_grant');
  IF window_check <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3787): % of the two named CHECKs (positive window, revocation after grant) present, expected 2.', window_check;
  END IF;

  -- NO COORDINATE, HERE OF ALL PLACES, and none next door on 2984's tables.
  SELECT count(*) INTO coord_cols
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name IN ('layover_crew_location_grants','layover_crews','layover_crew_members')
     AND column_name IN ('lat','lng','latitude','longitude','location','geog','geom','point','coords');
  IF coord_cols <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3787): % coordinate column(s) on the grant store or 2984''s crew tables. This table stores PERMISSION, not position.', coord_cols;
  END IF;

  -- The flag row exists. Its value is not asserted: an operator may turn it
  -- on later, and a re-run of this block must not fail for that.
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_crew_location_sharing_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3787): layover_crew_location_sharing_enabled has no feature_flags row';
  END IF;
END
$post$;
