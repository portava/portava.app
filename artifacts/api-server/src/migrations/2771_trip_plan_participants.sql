-- 2771_trip_plan_participants.sql
--
-- Trips v4 §5.1 `trip_plan_participants` and §9.1 Attendance — the relation
-- census-trips TR83 is about: "A plan belongs to a trip and to nobody in
-- particular; there is no way to record who is going."
--
-- §5.1: plan_id, user_id, attendance_state, role
-- §9.1: Attendance: INTERESTED | GOING | MAYBE | CANT_GO | LEFT
--       "Group Trips should not assume every plan applies to every participant.
--        Attendance is an explicit relation so downstream transport,
--        reservation, meeting-point, and budget calculations use the actual
--        party."
--
-- THE PLAN IT KEYS ON
-- ===================
-- `plan_id` REFERENCES public.trip_plan_items(id). That table IS §5.1's
-- `trip_plans` — see 2770's header for why there is one plan aggregate and not
-- two, and census-trips TR82, which recorded the same reading before either
-- migration existed. census-trips §27 claimed TR83 was "blocked on trip_plans
-- not existing"; that contradicted TR82 in the same document and was wrong.
--
-- ON DELETE CASCADE, unlike every other stage/plan reference in 2760-2763,
-- which are SET NULL. The difference is not an inconsistency: those columns are
-- OPTIONAL attachments on rows that mean something without them — a commitment
-- with no stage is still a commitment. An attendance row is a statement ABOUT a
-- plan and means nothing without one. There is no such thing as "going to
-- nothing".
--
-- WHY `role` IS NULLABLE AND HAS NO VOCABULARY
-- ============================================
-- §5.1 lists a `role` and the spec never says what its values are. §9.1 defines
-- PlanScope and Attendance and is silent on role; §6.1's roles are trip-level
-- (host, co-host, member, guest) and re-using those here would be inventing a
-- second, plan-scoped meaning for words that already have one. So the column
-- exists, carries no CHECK, and is documented as unconstrained ON PURPOSE. A
-- vocabulary invented here would be harder to remove than to add, and a CHECK
-- is one migration away once the spec says what it should hold.
--
-- RLS: crew SELECT only. No client may write — the kernel writes as
-- service_role, which bypasses RLS. Same posture as 2760-2763.
--
-- NO WRITER YET. 2772 adds JOIN_PLAN / LEAVE_PLAN / SET_PLAN_ATTENDANCE, which
-- are §4.1's own command names. Until then this table satisfies nothing, by
-- this census's rule 2, and TR83 stays open.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2771 (Trips).

BEGIN;

DO $pre$
DECLARE n int;
BEGIN
  IF to_regclass('public.trip_plan_items') IS NULL THEN
    RAISE EXCEPTION '2771: requires public.trip_plan_items (0010)';
  END IF;
  IF to_regclass('public.trip_plan_participants') IS NOT NULL THEN
    RAISE EXCEPTION '2771: trip_plan_participants already exists';
  END IF;
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
   WHERE ns.nspname='authz' AND p.proname='is_trip_crew';
  IF n < 1 THEN RAISE EXCEPTION '2771: authz.is_trip_crew is required for the RLS policy (2334)'; END IF;
  -- The policy reaches the trip through the plan, so the plan must carry one.
  SELECT count(*) INTO n FROM pg_attribute
   WHERE attrelid='public.trip_plan_items'::regclass AND attname='trip_id' AND NOT attisdropped;
  IF n <> 1 THEN RAISE EXCEPTION '2771: trip_plan_items has no trip_id; the RLS policy cannot reach a trip'; END IF;
END
$pre$;

CREATE TABLE public.trip_plan_participants (
  plan_id          uuid        NOT NULL REFERENCES public.trip_plan_items(id) ON DELETE CASCADE,
  user_id          uuid        NOT NULL REFERENCES public.profiles(id)        ON DELETE CASCADE,
  attendance_state text        NOT NULL DEFAULT 'interested',
  -- §5.1 lists this and the spec never says what it may hold. Unconstrained on
  -- purpose; see the header.
  role             text        NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id, user_id),
  CONSTRAINT trip_plan_participants_attendance_known
    CHECK (attendance_state IN ('interested','going','maybe','cant_go','left'))
);

COMMENT ON TABLE public.trip_plan_participants IS
  'Trips spec §5.1 trip_plan_participants / §9.1 Attendance. plan_id references trip_plan_items, which IS §5.1''s trip_plans (see migration 2770). ON DELETE CASCADE because an attendance row is a statement ABOUT a plan and means nothing without one, unlike the SET NULL stage attachments in 2760-2763. Written only by public.trip_kernel_execute (2772); RLS: crew SELECT only, no client grants.';
COMMENT ON COLUMN public.trip_plan_participants.attendance_state IS
  'Trips spec §9.1 Attendance, lowercased: interested | going | maybe | cant_go | left. The party for downstream transport, reservation, meeting-point and budget calculations is the set of rows in state ''going''.';
COMMENT ON COLUMN public.trip_plan_participants.role IS
  'Trips spec §5.1 trip_plan_participants.role. DELIBERATELY UNCONSTRAINED: the spec names the column and never says what it holds. §6.1''s roles are trip-level and re-using those words here would invent a second plan-scoped meaning for them. A CHECK is one migration away once the spec says what this should be; an invented vocabulary would be harder to remove than to add.';

CREATE INDEX idx_trip_plan_participants_user  ON public.trip_plan_participants (user_id);
CREATE INDEX idx_trip_plan_participants_going ON public.trip_plan_participants (plan_id) WHERE attendance_state = 'going';

ALTER TABLE public.trip_plan_participants ENABLE ROW LEVEL SECURITY;

-- Crew may read attendance for their own trip's plans. Nobody writes from a
-- client: the kernel writes as service_role, which bypasses RLS.
CREATE POLICY trip_plan_participants_crew_select ON public.trip_plan_participants
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.trip_plan_items i
                  WHERE i.id = trip_plan_participants.plan_id
                    AND authz.is_trip_crew(i.trip_id)));

REVOKE ALL ON public.trip_plan_participants FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.trip_plan_participants TO authenticated;

DO $post$
DECLARE n int; r record;
BEGIN
  IF to_regclass('public.trip_plan_participants') IS NULL THEN
    RAISE EXCEPTION '2771: table absent after create';
  END IF;

  SELECT relrowsecurity INTO r FROM pg_class WHERE oid='public.trip_plan_participants'::regclass;
  IF NOT r.relrowsecurity THEN RAISE EXCEPTION '2771: RLS not enabled'; END IF;

  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname='public' AND tablename='trip_plan_participants';
  IF n <> 1 THEN RAISE EXCEPTION '2771: expected exactly 1 policy, found %', n; END IF;
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname='public' AND tablename='trip_plan_participants' AND cmd <> 'SELECT';
  IF n <> 0 THEN RAISE EXCEPTION '2771: a non-SELECT policy exists; this table has no client writer'; END IF;

  IF has_table_privilege('authenticated','public.trip_plan_participants','INSERT')
     OR has_table_privilege('authenticated','public.trip_plan_participants','UPDATE')
     OR has_table_privilege('authenticated','public.trip_plan_participants','DELETE') THEN
    RAISE EXCEPTION '2771: authenticated holds a write privilege';
  END IF;
  IF NOT has_table_privilege('authenticated','public.trip_plan_participants','SELECT') THEN
    RAISE EXCEPTION '2771: authenticated cannot SELECT';
  END IF;

  -- The §9.1 vocabulary, by name.
  IF (SELECT count(*) FROM (SELECT unnest(ARRAY['interested','going','maybe','cant_go','left']) v) s
       WHERE position('''' || s.v || '''' in
             (SELECT pg_get_constraintdef(oid) FROM pg_constraint
               WHERE conrelid='public.trip_plan_participants'::regclass
                 AND conname='trip_plan_participants_attendance_known')) = 0) <> 0 THEN
    RAISE EXCEPTION '2771: an §9.1 attendance state is not accepted';
  END IF;

  -- CASCADE, not SET NULL: 'n' here would leave attendance rows pointing at a
  -- deleted plan, and the primary key would not permit the null anyway.
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid='public.trip_plan_participants'::regclass AND contype='f'
     AND confrelid='public.trip_plan_items'::regclass AND confdeltype='c';
  IF n <> 1 THEN RAISE EXCEPTION '2771: the plan_id foreign key is missing or is not ON DELETE CASCADE'; END IF;

  -- EXACTLY two foreign keys: the plan and the person. A third would mean this
  -- table had grown a dependency nobody described.
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid='public.trip_plan_participants'::regclass AND contype='f';
  IF n <> 2 THEN RAISE EXCEPTION '2771: expected exactly 2 foreign keys, found %', n; END IF;

  -- And it has no writer yet. Saying so in the migration keeps TR83 honest
  -- until 2772 lands.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
              WHERE ns.nspname='public' AND p.proname='trip_kernel_execute'
                AND position('trip_plan_participants' in p.prosrc) > 0) THEN
    RAISE NOTICE '2771: the kernel already writes trip_plan_participants — 2772 is applied, so TR83 has its writer.';
  ELSE
    RAISE NOTICE '2771: trip_plan_participants has NO writer yet. By census rule 2 it satisfies nothing until 2772 (JOIN_PLAN / LEAVE_PLAN / SET_PLAN_ATTENDANCE) lands.';
  END IF;
END
$post$;

COMMIT;
