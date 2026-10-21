-- 3872_layover_crew_plans.sql
-- §14.1 "Unless an explicit split plan exists: member A leaves at T1, members B/C continue until T2.
--        Crew plan must be certified against every member branch."   (census-layover L134, L135)
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; LAYOVER 165, lane B2-CREW, range 3872 + 3875-3879).
-- APPLIED TO NO DATABASE by the lane that wrote it.
--
-- ── WHAT WAS MISSING ────────────────────────────────────────────────────────
-- The §14.1 solver has handled split plans for a year (services/airport/LayoverCrewService.ts `CrewBranch`,
-- `certifyCrewPlan`), and crews are live (2984, applied in production). What never existed is a crew ITINERARY:
-- the crew card certifies the EMPTY unsplit plan (routes/airport.ts `crewPayload`), because there was nowhere to
-- keep a proposed split. This is that place.
--
-- ── WHAT THIS CREATES ───────────────────────────────────────────────────────
-- layover_crew_plans           one PROPOSED plan per crew at a time (partial unique index); a new proposal
--                              supersedes the old one (status 'superseded', ended_at set), a member may withdraw
--                              it ('withdrawn'). A plan row is never edited in any other way (trigger).
-- layover_crew_plan_branches   the plan's branches: who (member_user_ids), when the branch is back at the airport
--                              (return_by — the spec's T1 / T2), and its stops (stops_json, the `layover_plan_stops` usable half:
--                              title, durationMin, travelMin, insideAirport). IMMUTABLE once written: a changed
--                              split is a new plan, so a certification can always name the exact plan it covered.
--
-- ── SERVER-AUTHORITATIVE, AS SCHEMA ─────────────────────────────────────────
--   * RLS on, REVOKE ALL from PUBLIC/anon/authenticated, service_role policy + grants only (the 2984/3996 posture:
--     who may see a crewmate is the route's answer — blocks, sharing preferences — never a client's direct read).
--   * BEFORE INSERT guard on plans: the proposer is a LIVE member (left_at IS NULL) of a LIVE crew (not disbanded,
--     not expired), proposing from the session they joined with.
--   * BEFORE INSERT guard on branches: the plan is still 'proposed'; every member is a live member of the plan's
--     crew; nobody is listed twice in a branch or in two branches of one plan (the solver's
--     `member_assigned_twice`, refused by the database too).
--   * BEFORE UPDATE guards: a branch never changes; a plan changes only proposed → superseded | withdrawn.
-- FEASIBILITY IS NOT STORED. Certification is a function of every member's CURRENT certified record and of the
-- clock, so it is computed on every read (the live path); a stored verdict would be a stale safety claim.
--
-- ── THE FLAG ────────────────────────────────────────────────────────────────
-- `layover_crew_split_plans_enabled`, seeded FALSE. OFF / absent / unreadable: nothing reads or writes these
-- tables; the crew card is exactly what it was (the empty unsplit plan). PREREQUISITE for ON: this file applied.
--
-- ── ORDER INDEPENDENCE (a gap number: applied at 3872 on a fresh replay, AFTER 3999 on portava-ci/production) ──
-- DEPENDS ON: 0127 (layover_sessions), 2984 (layover_crews, layover_crew_members, PK (crew_id, user_id)),
-- profiles, feature_flags. Nothing numbered above 3872. Measured (grep of src/migrations, 2026-10-18): no file
-- above 3872 names layover_crew_plans / layover_crew_plan_branches / layover_crew_split_plans_enabled; the only file
-- above 3872 that touches the crew tables is 3996, which adds AFTER triggers on layover_crew_members (left_at) and
-- layover_crews (status) and alters no column this file reads (crew_id, user_id, session_id, left_at, status,
-- expires_at). Applying 3996 before or after this file gives the same objects.
-- DELETION FATE: both tables hang off layover_crews / layover_sessions / profiles ON DELETE CASCADE; account
-- deletion's delete_layover_crew_memberships / delete_layover_sessions steps take them. A member named only inside
-- `member_user_ids` (an array no foreign key can follow) is covered by the AFTER UPDATE OF left_at OR DELETE trigger
-- this file puts on layover_crew_members: every plan naming a departed member is deleted. That trigger is the one
-- object 3872 places on a table it did not create; 3996's own AFTER UPDATE OF left_at trigger on the same table is
-- independent of it (each deletes only its own tables' rows), so their relative order does not matter.
-- Rollback: db/rollback/2026-10-18-3872-layover-crew-plans-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.layover_sessions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3872): public.layover_sessions does not exist (0127).';
  END IF;
  IF to_regclass('public.layover_crews') IS NULL OR to_regclass('public.layover_crew_members') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3872): the crew tables do not exist (2984).';
  END IF;
  IF to_regclass('public.profiles') IS NULL OR to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3872): public.profiles and public.feature_flags must exist.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.layover_crew_members'::regclass AND contype = 'p'
       AND pg_get_constraintdef(oid) = 'PRIMARY KEY (crew_id, user_id)'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3872): layover_crew_members must carry PRIMARY KEY (crew_id, user_id) (2984).';
  END IF;
END
$pre$;

-- ── The plan ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.layover_crew_plans (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  crew_id              UUID        NOT NULL REFERENCES public.layover_crews (id) ON DELETE CASCADE,
  proposed_by          UUID        NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  proposed_session_id  UUID        NOT NULL REFERENCES public.layover_sessions (id) ON DELETE CASCADE,
  status               TEXT        NOT NULL DEFAULT 'proposed',
  -- The §14.1 rules version the proposal was certified under (LAYOVER_CREW_VERSION).
  crew_version         TEXT        NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at             TIMESTAMPTZ,
  CONSTRAINT layover_crew_plans_status_check CHECK (status IN ('proposed', 'superseded', 'withdrawn')),
  CONSTRAINT layover_crew_plans_crew_version_check CHECK (char_length(crew_version) BETWEEN 1 AND 40),
  CONSTRAINT layover_crew_plans_ended_iff_not_proposed CHECK ((status = 'proposed') = (ended_at IS NULL))
);

-- ONE live plan per crew: two concurrent proposals cannot both be "the" plan.
CREATE UNIQUE INDEX IF NOT EXISTS layover_crew_plans_one_live_idx
  ON public.layover_crew_plans (crew_id) WHERE status = 'proposed';
CREATE INDEX IF NOT EXISTS layover_crew_plans_session_idx ON public.layover_crew_plans (proposed_session_id);
CREATE INDEX IF NOT EXISTS layover_crew_plans_proposer_idx ON public.layover_crew_plans (proposed_by);

-- ── Its branches ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.layover_crew_plan_branches (
  plan_id          UUID        NOT NULL REFERENCES public.layover_crew_plans (id) ON DELETE CASCADE,
  branch_key       TEXT        NOT NULL,
  position         SMALLINT    NOT NULL,
  member_user_ids  UUID[]      NOT NULL,
  -- When this branch is back at the airport: the spec's T1 / T2 ("member A leaves at T1, B/C continue until T2").
  -- Certification checks it against EVERY member of the branch's own hard return, never the crew's best, and checks
  -- that the branch's stops (their journeys included) fit before it.
  return_by        TIMESTAMPTZ NOT NULL,
  stops_json       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (plan_id, branch_key),
  CONSTRAINT layover_crew_plan_branches_position_unique UNIQUE (plan_id, position),
  CONSTRAINT layover_crew_plan_branches_key_check CHECK (branch_key ~ '^[a-z][a-z0-9_]{0,23}$'),
  CONSTRAINT layover_crew_plan_branches_position_check CHECK (position BETWEEN 0 AND 3),
  CONSTRAINT layover_crew_plan_branches_members_check
    CHECK (cardinality(member_user_ids) BETWEEN 1 AND 12 AND array_position(member_user_ids, NULL) IS NULL),
  CONSTRAINT layover_crew_plan_branches_stops_check
    CHECK (jsonb_typeof(stops_json) = 'array' AND jsonb_array_length(stops_json) <= 12)
);

COMMENT ON TABLE public.layover_crew_plans IS
  'Layover spec §14.1 explicit split plans (census-layover L134/L135). ONE proposed plan per crew; superseded or withdrawn, never edited. The proposer is a live member of a live crew (guard trigger). Feasibility is NOT stored: it is certified on every read against every member''s current record. Service role only; read only behind layover_crew_split_plans_enabled.';
COMMENT ON TABLE public.layover_crew_plan_branches IS
  'Layover spec §14.1 crew plan branches: members (live members of the plan''s crew, each in exactly one branch), return_by (the branch''s T: back at the airport by), stops. Immutable once written. Service role only.';

-- ── Guards ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.layover_crew_plan_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  m_session UUID;
  m_left    TIMESTAMPTZ;
  c_status  TEXT;
  c_expires TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.crew_id IS DISTINCT FROM OLD.crew_id
       OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by OR NEW.proposed_session_id IS DISTINCT FROM OLD.proposed_session_id
       OR NEW.crew_version IS DISTINCT FROM OLD.crew_version OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION '3872: a crew plan is never edited; propose a new one (it supersedes this one)'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status <> 'proposed' AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION '3872: a % crew plan is final', OLD.status USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status <> 'proposed' THEN
    RAISE EXCEPTION '3872: a crew plan is created proposed' USING ERRCODE = 'check_violation';
  END IF;
  SELECT session_id, left_at INTO m_session, m_left
    FROM public.layover_crew_members
   WHERE crew_id = NEW.crew_id AND user_id = NEW.proposed_by;
  IF NOT FOUND OR m_left IS NOT NULL THEN
    RAISE EXCEPTION '3872: only a LIVE member of the crew may propose its plan (crew %, user %)', NEW.crew_id, NEW.proposed_by
      USING ERRCODE = 'check_violation';
  END IF;
  IF m_session IS DISTINCT FROM NEW.proposed_session_id THEN
    RAISE EXCEPTION '3872: a crew plan must be proposed from the session the member joined with'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT status, expires_at INTO c_status, c_expires FROM public.layover_crews WHERE id = NEW.crew_id;
  IF NOT FOUND OR c_status = 'disbanded' OR c_expires <= now() THEN
    RAISE EXCEPTION '3872: the crew is not live, so it cannot be given a plan' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS layover_crew_plan_guard ON public.layover_crew_plans;
CREATE TRIGGER layover_crew_plan_guard
  BEFORE INSERT OR UPDATE ON public.layover_crew_plans
  FOR EACH ROW EXECUTE FUNCTION public.layover_crew_plan_guard();

CREATE OR REPLACE FUNCTION public.layover_crew_plan_branch_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  p_crew    UUID;
  p_status  TEXT;
  stranger  UUID;
  twice     UUID;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '3872: a crew plan branch is never edited; propose a new plan' USING ERRCODE = 'check_violation';
  END IF;
  SELECT crew_id, status INTO p_crew, p_status FROM public.layover_crew_plans WHERE id = NEW.plan_id;
  IF NOT FOUND OR p_status <> 'proposed' THEN
    RAISE EXCEPTION '3872: branches are added only to a proposed plan' USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(NEW.member_user_ids) <> (SELECT count(DISTINCT u) FROM unnest(NEW.member_user_ids) u) THEN
    RAISE EXCEPTION '3872: a member is listed twice in one branch' USING ERRCODE = 'check_violation';
  END IF;
  SELECT u INTO stranger FROM unnest(NEW.member_user_ids) u
   WHERE NOT EXISTS (
     SELECT 1 FROM public.layover_crew_members m
      WHERE m.crew_id = p_crew AND m.user_id = u AND m.left_at IS NULL)
   LIMIT 1;
  IF stranger IS NOT NULL THEN
    RAISE EXCEPTION '3872: % is not a live member of this crew, so no branch may include them', stranger
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT u INTO twice FROM unnest(NEW.member_user_ids) u
   WHERE EXISTS (
     SELECT 1 FROM public.layover_crew_plan_branches b
      WHERE b.plan_id = NEW.plan_id AND b.branch_key <> NEW.branch_key AND u = ANY (b.member_user_ids))
   LIMIT 1;
  IF twice IS NOT NULL THEN
    RAISE EXCEPTION '3872: % is already in another branch of this plan (a member is in exactly one branch)', twice
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS layover_crew_plan_branch_guard ON public.layover_crew_plan_branches;
CREATE TRIGGER layover_crew_plan_branch_guard
  BEFORE INSERT OR UPDATE ON public.layover_crew_plan_branches
  FOR EACH ROW EXECUTE FUNCTION public.layover_crew_plan_branch_guard();

-- ── A member who is gone takes the plans that name them ─────────────────────
-- `member_user_ids` is an array, so no foreign key can follow a person out of it. When a membership ends (left_at set)
-- or its row is deleted (account deletion's delete_layover_crew_memberships step), every plan of that crew whose
-- branches name that person is DELETED (its branches cascade): a plan without one of its members is no longer the
-- crew's plan, and a departed person's id must not outlive them in someone else's itinerary.
CREATE OR REPLACE FUNCTION public.layover_crew_plan_member_gone()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' AND NOT (NEW.left_at IS NOT NULL AND OLD.left_at IS NULL) THEN
    RETURN NEW;
  END IF;
  DELETE FROM public.layover_crew_plans p
   WHERE p.crew_id = OLD.crew_id
     AND EXISTS (SELECT 1 FROM public.layover_crew_plan_branches b WHERE b.plan_id = p.id AND OLD.user_id = ANY (b.member_user_ids));
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;

DROP TRIGGER IF EXISTS layover_crew_plan_member_gone ON public.layover_crew_members;
CREATE TRIGGER layover_crew_plan_member_gone
  AFTER UPDATE OF left_at OR DELETE ON public.layover_crew_members
  FOR EACH ROW EXECUTE FUNCTION public.layover_crew_plan_member_gone();

REVOKE ALL ON FUNCTION public.layover_crew_plan_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.layover_crew_plan_branch_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.layover_crew_plan_member_gone() FROM PUBLIC, anon, authenticated;

-- ── The one write: supersede + insert, in ONE transaction ───────────────────
-- A proposal is the plan row and all of its branches, or nothing. Two proposals racing for one crew cannot both
-- win: the second one's INSERT meets the first one's live plan in layover_crew_plans_one_live_idx (23505) and the
-- whole call is undone, so a split is never silently overwritten. SECURITY INVOKER: it runs with the caller's
-- privileges (the service role; no client may EXECUTE it), and every guard trigger above still fires.

CREATE OR REPLACE FUNCTION public.layover_propose_crew_plan(
  p_crew_id UUID, p_user_id UUID, p_session_id UUID, p_crew_version TEXT, p_branches JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_plan UUID;
  v_branch JSONB;
  v_pos INT := 0;
BEGIN
  IF jsonb_typeof(p_branches) IS DISTINCT FROM 'array' OR jsonb_array_length(p_branches) NOT BETWEEN 1 AND 4 THEN
    RAISE EXCEPTION '3872: a crew plan has 1 to 4 branches' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.layover_crew_plans SET status = 'superseded', ended_at = now()
   WHERE crew_id = p_crew_id AND status = 'proposed';
  INSERT INTO public.layover_crew_plans (crew_id, proposed_by, proposed_session_id, crew_version)
  VALUES (p_crew_id, p_user_id, p_session_id, p_crew_version)
  RETURNING id INTO v_plan;
  FOR v_branch IN SELECT value FROM jsonb_array_elements(p_branches) LOOP
    INSERT INTO public.layover_crew_plan_branches (plan_id, branch_key, position, member_user_ids, return_by, stops_json)
    VALUES (
      v_plan,
      v_branch->>'key',
      v_pos,
      ARRAY(SELECT jsonb_array_elements_text(v_branch->'memberUserIds'))::uuid[],
      (v_branch->>'returnBy')::timestamptz,
      COALESCE(v_branch->'stops', '[]'::jsonb)
    );
    v_pos := v_pos + 1;
  END LOOP;
  RETURN v_plan;
END
$fn$;

REVOKE ALL ON FUNCTION public.layover_propose_crew_plan(UUID, UUID, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.layover_propose_crew_plan(UUID, UUID, UUID, TEXT, JSONB) TO service_role;

-- ── Service role only ───────────────────────────────────────────────────────

ALTER TABLE public.layover_crew_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.layover_crew_plan_branches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.layover_crew_plans FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.layover_crew_plan_branches FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.layover_crew_plans TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.layover_crew_plan_branches TO service_role;
DROP POLICY IF EXISTS layover_crew_plans_service ON public.layover_crew_plans;
CREATE POLICY layover_crew_plans_service ON public.layover_crew_plans
  TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS layover_crew_plan_branches_service ON public.layover_crew_plan_branches;
CREATE POLICY layover_crew_plan_branches_service ON public.layover_crew_plan_branches
  TO service_role USING (true) WITH CHECK (true);

-- ── The flag, OFF ───────────────────────────────────────────────────────────

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'layover_crew_split_plans_enabled',
    false,
    'Layover crew split plans (census-layover L134/L135, spec §14.1). ON: a crew member may propose an explicit split (some members head back at T1, the rest continue until T2), and the crew card certifies the stored plan against EVERY member branch — each member''s own certified record, deadline and landside gate — on every read; an infeasible proposal is refused. REQUIRES 3872 applied. OFF / absent (the seed): nothing is read or written; the crew card certifies the empty unsplit plan as before.'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions (catalog only; re-runnable) ──────────────────────────────

DO $post$
DECLARE
  t TEXT;
  rls BOOLEAN;
  client_privs INT;
  policies INT;
  coord_cols TEXT;
  seeded BOOLEAN;
BEGIN
  FOREACH t IN ARRAY ARRAY['layover_crew_plans', 'layover_crew_plan_branches'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3872): % was not created', t;
    END IF;
    SELECT relrowsecurity INTO rls FROM pg_class WHERE oid = ('public.' || t)::regclass;
    IF NOT rls THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3872): RLS is not enabled on %', t;
    END IF;
    SELECT count(*) INTO client_privs FROM information_schema.table_privileges
     WHERE table_schema = 'public' AND table_name = t AND grantee IN ('anon', 'authenticated', 'PUBLIC');
    IF client_privs <> 0 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3872): anon/authenticated/PUBLIC hold % privilege(s) on %', client_privs, t;
    END IF;
    SELECT count(*) INTO policies FROM pg_policy p
     WHERE p.polrelid = ('public.' || t)::regclass
       AND NOT (p.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'service_role')]::oid[]);
    IF policies <> 0 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3872): % carries % polic(ies) for a role other than service_role', t, policies;
    END IF;
    SELECT string_agg(column_name, ', ') INTO coord_cols
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = t
       AND column_name ~* '(^|_)(lat|lng|lon|latitude|longitude|location|geom|geog|point)($|_)';
    IF coord_cols IS NOT NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3872): a coordinate column exists on %: % (a plan is labels and times, never a position)', t, coord_cols;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'layover_crew_plan_guard' AND tgrelid = 'public.layover_crew_plans'::regclass AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'layover_crew_plan_branch_guard' AND tgrelid = 'public.layover_crew_plan_branches'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3872): a guard trigger is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'layover_crew_plan_member_gone' AND tgrelid = 'public.layover_crew_members'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3872): the member-gone trigger is missing (a departed member would outlive them in a plan)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'layover_crew_plans_one_live_idx'
       AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%WHERE (status = ''proposed''::text)%'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3872): the one-live-plan-per-crew unique index is missing or changed';
  END IF;

  IF has_function_privilege('anon', 'public.layover_propose_crew_plan(uuid, uuid, uuid, text, jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.layover_propose_crew_plan(uuid, uuid, uuid, text, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3872): a client role may EXECUTE layover_propose_crew_plan (a plan is the server''s write)';
  END IF;

  SELECT enabled INTO seeded FROM public.feature_flags WHERE flag = 'layover_crew_split_plans_enabled';
  IF seeded IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3872): the flag row layover_crew_split_plans_enabled is missing';
  END IF;
END
$post$;

COMMIT;
