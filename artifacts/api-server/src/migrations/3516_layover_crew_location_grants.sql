-- 3516_layover_crew_location_grants.sql
--
-- THE §14 L4 GRANT STORE: `layover_crew_location_grants`.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band). Lane 3516 (layover).
-- Creates ONE new table. Alters nothing that exists. Moves no row. Seeds no
-- feature flag. ADDS NO COORDINATE COLUMN ANYWHERE — see THIS FILE STORES
-- PERMISSION, NOT POSITION.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY
-- ══════════════════════════════════════════════════════════════════════════════
-- §14's visibility ladder ends at "L4 temporary location — explicit, scoped,
-- auto-expiring", and §13's map table gates the "Crew member" element on "only
-- with explicit temporary location permission" (census L124). The code that
-- enforces all of it is already written and is pure:
-- `services/airport/LayoverCrewService.ts` has `LOCATION_PRECISIONS`,
-- `CrewLocationGrant`, `CrewShareSignals`, `evaluateCrewLocationShare` and
-- `locationPrecisionFor`, with a test sweep asserting there is no argument
-- combination that yields `precise` without a grant.
--
-- It has nowhere to read a grant from. Every caller would have to pass `null`,
-- which the ladder reads as `never_granted` — so the ladder's only reachable
-- answers today are `none` and `meeting_point`, and L124/L132 stay N.
--
-- 2984 says why the store comes FIRST, and this file is the other half of that
-- sentence: "Adding a lat/lng column now would create a place to put a
-- coordinate BEFORE the thing that decides whether it may be shown, which is
-- the order that produces a leak." This is the thing that decides. It is
-- deliberately applied before any column that could hold a position exists.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THIS FILE STORES PERMISSION, NOT POSITION
-- ══════════════════════════════════════════════════════════════════════════════
-- The table holds who said yes, to which crew, from when, until when, and
-- whether they have since revoked. It holds NO coordinate, and 2984's
-- postcondition asserting the crew tables have none is left standing and
-- untouched.
--
-- That is not an oversight to be tidied up by whoever ships the map pin. A
-- grant is the only thing that can be stored safely on its own: a stale grant
-- grants nothing, because `evaluateCrewLocationShare` is evaluated against the
-- clock at read time and an expired row is inert. A stale POSITION is a
-- traveller's whereabouts, published for as long as nothing deletes it. So
-- permission is durable state and position is not, and the two do not belong in
-- one migration. Where a position is eventually held — a short-lived row, a
-- cache, the request itself — is a separate decision with a separate retention
-- answer, and this file deliberately does not pre-empt it.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- A GRANT WITH NO EXPIRY IS NOT EXPRESSIBLE
-- ══════════════════════════════════════════════════════════════════════════════
-- `CrewLocationGrant`'s own comment: "Every field is required on purpose: a
-- grant with no expiry is not expressible, which is how 'auto-expiring' (§14,
-- L132) is enforced by the type rather than by remembering to set it." The
-- schema says it the same way, and this is the whole reason the column shapes
-- are worth reading:
--
--   * `expires_at TIMESTAMPTZ NOT NULL` with NO DEFAULT. Not nullable, because
--     NULL would be the "forever" this ladder has no word for. No default,
--     because a default is a duration, and an INSERT that omits the column must
--     fail rather than silently acquire whichever TTL a migration once guessed.
--   * `CHECK (expires_at > granted_at)`. A grant that expires at or before the
--     instant it was given is not a short grant, it is a row that reads as a
--     grant and authorises nothing — and `locationPrecisionFor` would report
--     `no_live_grant:ttl_elapsed`, blaming the TTL for a write that was never
--     valid.
--
-- THERE IS NO MAXIMUM TTL IN THIS FILE, AND THAT IS DELIBERATE. A ceiling would
-- be a number nobody has chosen; §14 says "temporary" and names no duration,
-- and inventing one here would put it beyond argument in a CHECK constraint.
-- What bounds a grant instead is DERIVED and lives in the route: the crew's own
-- `expires_at` and the granter's certified hard return, both already computed
-- by `crewExpiryFor`. A grant cannot usefully outlive either — `crew_dissolved`
-- and `session_expired` are two of the five terminators §14.1 names, so a
-- longer grant would be inert the moment it passed them. Deriving the bound
-- from facts the product already holds is not the same as choosing a policy,
-- which is why it is done there and not here.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- REVOCATION IS A COLUMN, AND IT IS NOT THE SAME AS EXPIRY
-- ══════════════════════════════════════════════════════════════════════════════
-- `revoked_at` is nullable and is set rather than deleting the row. The five
-- terminators §14.1 lists are distinguishable on purpose —
-- `evaluateCrewLocationShare` reports the FIRST thing that happened, so "they
-- took it back at 14:02" and "it ran out at 14:40" are different answers and
-- only one of them is a decision the traveller made. Deleting the row on
-- revocation would collapse `user_revoked` into `never_granted`, which is the
-- one distinction that file's comment singles out: "An absent grant is
-- `never_granted`, never 'expired' — the two are different answers and only one
-- of them means a traveller once said yes."
--
-- WHAT THAT COSTS, STATED RATHER THAN HIDDEN: a revoked grant is a row saying
-- this person shared their location with this crew at this hour, and it
-- survives revocation. It is NOT retained indefinitely — 2984 cascades
-- `crew_id`, and `layoverCrewExpiryScheduler` deletes expired crews, so every
-- grant row goes with its crew. There is no separate sweep here and must not
-- be one: a second DELETE against this table could orphan nothing and would be
-- a weaker second answer to a retention question the crew sweep already
-- settles.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- NO UNIQUE INDEX ON (crew_id, granted_by_user_id), AND WHY NOT
-- ══════════════════════════════════════════════════════════════════════════════
-- The obvious constraint is "one live grant per person per crew", and it is
-- wrong in both available forms:
--
--   * Unqualified, it forbids re-granting. A traveller whose grant expired, or
--     who revoked and changed their mind, cannot say yes again without the row
--     they already have being deleted — and deleting it is exactly what the
--     paragraph above refuses.
--   * Partial, `WHERE revoked_at IS NULL`, it forbids re-granting after an
--     EXPIRY, because an expired-but-unrevoked row is still a row and would
--     block the new one. Expiry is the common case, so this is the form that
--     breaks the feature in ordinary use.
--
-- So grants accumulate, one row per act of consent, and the store reads the
-- NEWEST one — revoked or not, for the reason the index comment below gives.
-- Several rows for one person are not a conflict: the newest is the one in
-- force, and an older one with a later expiry would only ever extend a
-- permission its owner has since re-stated, which the store resolves by reading
-- newest-first rather than by taking a maximum over expiries. Taking the
-- maximum would be the bug: it would let a revoked long grant outlive the short
-- one that replaced it.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WRITE BOUNDARY — NOT CLIENT-READABLE OR CLIENT-WRITABLE
-- ══════════════════════════════════════════════════════════════════════════════
-- 2984's stance, in 3390's shape as 3466 writes it: RLS enabled, grants revoked
-- from `PUBLIC`/`anon`/`authenticated`, the four operations GRANTed to
-- `service_role` explicitly, and four RESTRICTIVE client-deny policies. A
-- RESTRICTIVE policy ANDs with every permissive one, so the denial survives a
-- later permissive policy; "no policy at all" denies by absence and stops
-- denying the moment the absence ends. The postcondition asserts `0 permissive
-- AND exactly 4 restrictive`, which keeps 2984's actual rule — no weaker
-- second answer to "who may see a crewmate" — and now enforces it.
--
-- HERE THE ARGUMENT IS STRONGER THAN IT WAS FOR THE CREW TABLES, and it is the
-- reason this is not the one table to make an exception for. The obvious policy
-- is "a traveller may read and write their own grants", `granted_by_user_id =
-- auth.uid()`, which looks unimpeachable. It is not: a client that can INSERT
-- its own grant row can choose its own `expires_at`, and the derived bound in
-- the previous section — the crew's life and the granter's certified hard
-- return — exists only in the route. Under such a policy a client could write a
-- grant lasting a week, and `locationPrecisionFor` would honour it, because the
-- ladder trusts the row. The constraint that keeps a grant temporary is
-- server-side arithmetic, so the write has to be server-mediated or it is not
-- bounded at all.
--
-- A SELECT-only policy was considered separately and also declined: who may
-- learn that A shares their location with a crew is the same composed question
-- (`blocks` both ways, `publishableUserIds`, ghost mode) that `crewMemberCards`
-- answers in the route layer, and a membership-scoped policy would be the
-- weaker second answer underneath it. Same shape, same reason as 2984.
--
-- Re-checked rather than inherited: `travel-buddy-standalone/src/services/layover.ts`
-- opens with "All calls go through the API server (no direct Supabase from
-- client for layover data)", and this table's name appears nowhere under
-- `travel-buddy-standalone/`.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- APPLY ORDER
-- ══════════════════════════════════════════════════════════════════════════════
-- Depends on 2984 (`layover_crews`), 0127 (`layover_sessions`) and `profiles`.
-- INDEPENDENT of 3515 (the crew itinerary) and of everything in the 35xx band.
-- Safe to apply at any time. Applying it alone changes nothing a traveller sees
-- and grants nothing: an empty table is read as `never_granted`, which is what
-- every caller already gets today.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- REVERSIBLE BY
-- ══════════════════════════════════════════════════════════════════════════════
-- Rollback: db/rollback/2026-10-03-3516-layover-crew-location-grants-rollback.sql
--   DROP TABLE IF EXISTS public.layover_crew_location_grants;
-- Nothing else is touched. Dropping it returns the precision ladder to the
-- state this file found it in: `none` and `meeting_point` only. The rollback
-- reports the row count first: each row is a recorded act of consent, and
-- dropping them silently would destroy the only record that a traveller once
-- said yes.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHERE THE REAL-RLS EVIDENCE LIVES
-- ══════════════════════════════════════════════════════════════════════════════
-- Not in this file. A probe with real rows and real roles is the strongest
-- evidence there is, and inside the migration's own transaction it can only
-- undo itself by aborting — which rolls back the DDL batched with it while the
-- migration still reports success. That is how 2195 silently failed, and
-- `src/test/migrationDeployability.test.ts` forbids the shape. So this file
-- INSERTS NOTHING and assumes no role, its postcondition block runs AFTER
-- `COMMIT` as catalog assertions only, and the probe lives in
-- `src/test/db/layoverCrewLocationGrants.db.test.ts`, which observes from a
-- separate connection and covers what matters most here: that a client role
-- cannot write itself a grant, and that the CHECK constraints refuse a grant
-- with no window.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.layover_crews') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3516): public.layover_crews does not exist. Apply 2984_layover_crews.sql first.';
  END IF;
  IF to_regclass('public.layover_sessions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3516): public.layover_sessions does not exist. Apply 0127_layover_system.sql first.';
  END IF;
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3516): public.profiles does not exist.';
  END IF;
END $$;

-- ── §14 L4: the temporary location grant ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS layover_crew_location_grants (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- SCOPED, which is one of §14 L4's three words. `locationPrecisionFor`
  -- refuses to widen a grant beyond the crew it names
  -- (`grant_scoped_to_another_crew`), and this column is what it compares.
  crew_id              UUID        NOT NULL REFERENCES layover_crews(id) ON DELETE CASCADE,

  -- EXPLICIT, the second of the three. The person whose position this
  -- authorises, and the only person who can have authorised it:
  -- `locationPrecisionFor` refuses a grant whose granter is not the viewing
  -- target (`grant_not_from_target`).
  granted_by_user_id   UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  -- The granter's own layover. §17: "Precise crew/live location — session
  -- scoped; expire automatically". `session_expired` is one of §14.1's five
  -- terminators, and this is the column that makes it derivable rather than
  -- guessed: without it the reader would have to assume which of the granter's
  -- sessions was meant.
  session_id           UUID        NOT NULL REFERENCES layover_sessions(id) ON DELETE CASCADE,

  granted_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- AUTO-EXPIRING, the third. NOT NULL and NO DEFAULT: see A GRANT WITH NO
  -- EXPIRY IS NOT EXPRESSIBLE. The bound is derived in the route from the
  -- crew's life and the granter's certified hard return; no duration is chosen
  -- here.
  expires_at           TIMESTAMPTZ NOT NULL,

  -- Set on revocation rather than deleting the row, so `user_revoked` stays
  -- distinguishable from `never_granted`. See REVOCATION IS A COLUMN.
  revoked_at           TIMESTAMPTZ,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A grant that expires when it was given authorises nothing and would be
  -- reported as `ttl_elapsed`, blaming the TTL for a write that was never valid.
  CONSTRAINT layover_crew_location_grants_positive_window
    CHECK (expires_at > granted_at),

  -- A revocation before the grant is not a shorter grant, it is an impossible
  -- row; `evaluateCrewLocationShare` takes the EARLIEST terminator at or before
  -- now, so such a row would report `user_revoked` at an instant preceding the
  -- consent it claims to withdraw.
  CONSTRAINT layover_crew_location_grants_revocation_after_grant
    CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);

-- The read the ladder makes: the NEWEST grant per person per crew.
--
-- DELIBERATELY NOT PARTIAL ON `revoked_at IS NULL`, and the reason is the whole
-- point of keeping revocation as a column. A partial index would be the index
-- for a read that skipped revoked rows — and a reader that skips them cannot
-- see a revocation at all, so it reports `never_granted` for a traveller who
-- said yes and then took it back. `locationPrecisionFor`'s own comment singles
-- that confusion out as the one it must not make. The store therefore reads the
-- newest grant WHATEVER its revocation state and passes `revoked_at` on as the
-- `user_revoked` signal, which is what makes `evaluateCrewLocationShare` able
-- to name the cause. One index serves both that read and revocation's write.
CREATE INDEX IF NOT EXISTS layover_crew_location_grants_newest_idx
  ON layover_crew_location_grants(crew_id, granted_by_user_id, granted_at DESC);

COMMENT ON TABLE public.layover_crew_location_grants IS
  'spec §14 L4 / census-layover L124, L132 (3516): the explicit, scoped, auto-expiring permission CrewLocationGrant describes — who said yes, to which crew, from when, until when, and whether they revoked. Holds PERMISSION, not position: no coordinate column, here or on 2984''s tables. Service role only; the bound on a grant''s life is derived in the route from the crew''s life and the granter''s certified hard return.';

ALTER TABLE public.layover_crew_location_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.layover_crew_location_grants FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.layover_crew_location_grants TO service_role;

-- ── The four restrictive client denials ──────────────────────────────────────
-- 3390's pattern, as 3466 writes it. See WRITE BOUNDARY: the reason these are
-- written down rather than left to RLS's bare denial is that a grant's bound is
-- route-side arithmetic, so the one policy somebody would plausibly add later
-- ("a traveller may write their own grants") is precisely the one that would
-- let a client choose how long its own location stays visible.
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

COMMIT;

-- ── Postconditions ───────────────────────────────────────────────────────────
-- AFTER `COMMIT`, deliberately. Catalog state only, no temp table, no
-- before/after comparison, no row written and no role assumed — so
-- `certify:migrations` can re-run this block standalone, and so a failing
-- assertion cannot roll back the DDL it is asserting about (2195's defect, which
-- `src/test/migrationDeployability.test.ts` now forbids).
DO $post$
DECLARE
  permissive_count INTEGER;
  restrictive_count INTEGER;
  client_cols INTEGER;
  expires_nullable TEXT;
  expires_default TEXT;
  coord_cols INTEGER;
  window_check INTEGER;
BEGIN
  IF to_regclass('public.layover_crew_location_grants') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3516): layover_crew_location_grants missing';
  END IF;

  -- RLS on, or every revoke below is decoration and the service role's bypass
  -- stops being the only way in.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'layover_crew_location_grants' AND c.relrowsecurity = TRUE
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3516): RLS not enabled on layover_crew_location_grants';
  END IF;

  -- NO PERMISSIVE POLICY. The argument is stronger here than on 2984's tables:
  -- a client that can insert its own grant chooses its own expires_at, and the
  -- bound that keeps a grant temporary is route-side arithmetic over the crew's
  -- life and the granter's certified hard return. A permissive policy would
  -- make "temporary" the client's word.
  SELECT count(*) INTO permissive_count
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'layover_crew_location_grants'
     AND permissive = 'PERMISSIVE';
  IF permissive_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3516): % permissive policy/policies on layover_crew_location_grants, expected 0. Even an own-rows policy lets a client choose its own expires_at, and the derived bound on a grant''s life exists only in the route; the write must be server-mediated or a grant is not bounded at all.', permissive_count;
  END IF;

  -- AND THE DENIALS ARE WRITTEN DOWN, one per operation.
  SELECT count(*) INTO restrictive_count
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'layover_crew_location_grants'
     AND permissive = 'RESTRICTIVE';
  IF restrictive_count <> 4 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3516): % restrictive client-deny policy/policies on layover_crew_location_grants, expected 4 (SELECT/INSERT/UPDATE/DELETE)', restrictive_count;
  END IF;

  -- The service role must actually be able to work, or the ladder loses its row
  -- source again and silently returns to `never_granted` for everybody.
  IF NOT (
    has_table_privilege('service_role', 'public.layover_crew_location_grants', 'SELECT')
    AND has_table_privilege('service_role', 'public.layover_crew_location_grants', 'INSERT')
    AND has_table_privilege('service_role', 'public.layover_crew_location_grants', 'UPDATE')
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3516): service_role lacks SELECT/INSERT/UPDATE on layover_crew_location_grants; granting and revoking would both refuse, and the ladder would read every traveller as never_granted.';
  END IF;

  -- No client grant of ANY kind, read included.
  SELECT count(*) INTO client_cols
    FROM information_schema.column_privileges
   WHERE table_schema = 'public'
     AND table_name = 'layover_crew_location_grants'
     AND grantee IN ('anon','authenticated');
  IF client_cols <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3516): % client column grant(s) on layover_crew_location_grants, expected 0', client_cols;
  END IF;

  -- "AUTO-EXPIRING" AS A SCHEMA FACT. Both halves are asserted because either
  -- one alone is defeatable: a nullable column admits the "forever" the ladder
  -- has no word for, and a default admits a duration nobody chose.
  SELECT is_nullable, column_default INTO expires_nullable, expires_default
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'layover_crew_location_grants'
     AND column_name = 'expires_at';
  IF expires_nullable IS DISTINCT FROM 'NO' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3516): layover_crew_location_grants.expires_at is nullable. NULL would be a grant that never expires, which §14 L4 ("auto-expiring") has no word for and CrewLocationGrant''s type cannot express.';
  END IF;
  IF expires_default IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3516): layover_crew_location_grants.expires_at has default %, expected none. A default is a duration, and no duration has been chosen for a §14 L4 grant; the bound is derived per grant in the route.', expires_default;
  END IF;

  -- The positive-window CHECK, asserted by name so dropping it is a visible
  -- act rather than a quiet widening.
  SELECT count(*) INTO window_check
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public' AND t.relname = 'layover_crew_location_grants'
     AND c.contype = 'c'
     AND c.conname = 'layover_crew_location_grants_positive_window';
  IF window_check <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3516): the positive-window CHECK (expires_at > granted_at) is absent. Without it a row can read as a grant while authorising nothing, reported as ttl_elapsed.';
  END IF;

  -- NO COORDINATE, HERE OF ALL PLACES. This table is the thing that decides
  -- whether a position may be shown; a column to hold one on the deciding table
  -- is the exact ordering 2984 refused.
  SELECT count(*) INTO coord_cols
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'layover_crew_location_grants'
     AND column_name IN ('lat','lng','latitude','longitude','location','geog','geom','point','coords');
  IF coord_cols <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3516): % coordinate column(s) on layover_crew_location_grants. This table stores PERMISSION, not position: a stale grant grants nothing, a stale position is someone''s whereabouts.', coord_cols;
  END IF;

  -- 2984's assertion is left standing, and re-checked from here so that
  -- applying this file cannot be read as licence to add one next door.
  SELECT count(*) INTO coord_cols
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name IN ('layover_crews','layover_crew_members')
     AND column_name IN ('lat','lng','latitude','longitude','location','geog','geom','point','coords');
  IF coord_cols <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3516): % coordinate column(s) appeared on 2984''s crew tables. The grant store existing is not licence to add one; where a position is held is a separate decision with its own retention answer.', coord_cols;
  END IF;
END
$post$;
