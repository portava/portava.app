-- 2762_trip_goals_decisions_risks.sql
--
-- Trips v4 §5.1 `trip_goals`, `trip_decision_tasks`, `trip_risks`
-- (census-trips TR84, TR85, TR86 — each "Does not exist"). These are §8's
-- storage: Goals, Decisions, Readiness and Risk. Verified absent on both
-- databases 2026-09-09.
--
-- Spec column sets, verbatim:
--   trip_goals          id, trip_id, type, priority, status, evidence_json
--   trip_decision_tasks id, trip_id, type, deadline_at, consequence,
--                       assigned_user_id, status
--   trip_risks          id, trip_id, likelihood, impact, trigger_json,
--                       mitigation_json, status
--
-- §8.4's risk row — "tight arrival (flight ETA shifts beyond threshold) →
-- move/cancel downstream plan, alert affected participants" (TR144) — is NOT
-- built by this file. TR144 needs flight ETA ingestion and downstream
-- propagation, neither of which exists. What this gives it is the register to
-- write a risk INTO, which the census names as the first of the three missing
-- pieces.
--
-- `likelihood` and `impact` are graded vocabularies, not free integers. A 1-5
-- scale invites two readers to disagree about whether 3 is "medium", and §8's
-- consequence language is qualitative.
--
-- assigned_user_id is ON DELETE SET NULL, not CASCADE: a decision task outlives
-- the account that was assigned it, or the trip loses the record that a decision
-- was ever owed.
--
-- No writer yet — same reason as 2760/2761, and the same consequence: these
-- census rows do NOT close here. RLS on, crew SELECT only, no client writes.

BEGIN;

DO $pre$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema='public'
     AND table_name IN ('trip_goals','trip_decision_tasks','trip_risks');
  IF n <> 0 THEN RAISE EXCEPTION '2762: a target table already exists (found %)', n; END IF;
END
$pre$;

CREATE TABLE public.trip_goals (
  id            uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id       uuid  NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  type          text  NOT NULL,
  priority      text  NOT NULL DEFAULT 'normal',
  status        text  NOT NULL DEFAULT 'open',
  evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_goals_type_known
    CHECK (type IN ('rest','budget','experience','social','logistics','safety','other')),
  CONSTRAINT trip_goals_priority_known CHECK (priority IN ('low','normal','high')),
  CONSTRAINT trip_goals_status_known   CHECK (status IN ('open','met','abandoned')),
  CONSTRAINT trip_goals_evidence_object CHECK (jsonb_typeof(evidence_json) = 'object')
);
COMMENT ON TABLE public.trip_goals IS
  'Trips spec §5.1/§8 trip_goals. No writer yet (§4 command path pending); RLS crew SELECT only.';
CREATE INDEX idx_trip_goals_trip_status ON public.trip_goals (trip_id, status);

CREATE TABLE public.trip_decision_tasks (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id          uuid        NOT NULL REFERENCES public.trips(id)    ON DELETE CASCADE,
  type             text        NOT NULL,
  deadline_at      timestamptz NULL,
  consequence      text        NULL,
  assigned_user_id uuid        NULL REFERENCES public.profiles(id)     ON DELETE SET NULL,
  status           text        NOT NULL DEFAULT 'pending',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_decision_tasks_type_known
    CHECK (type IN ('booking','transport','lodging','document','payment','logistics','other')),
  CONSTRAINT trip_decision_tasks_status_known
    CHECK (status IN ('pending','done','expired','waived'))
);
COMMENT ON TABLE public.trip_decision_tasks IS
  'Trips spec §5.1/§8 trip_decision_tasks — a decision the trip is waiting on. assigned_user_id is SET NULL on account deletion: the task outlives the assignee. No writer yet; RLS crew SELECT only.';
CREATE INDEX idx_trip_decision_tasks_trip_status ON public.trip_decision_tasks (trip_id, status);
CREATE INDEX idx_trip_decision_tasks_deadline    ON public.trip_decision_tasks (trip_id, deadline_at);

CREATE TABLE public.trip_risks (
  id              uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id         uuid  NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  likelihood      text  NOT NULL,
  impact          text  NOT NULL,
  trigger_json    jsonb NOT NULL DEFAULT '{}'::jsonb,
  mitigation_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text  NOT NULL DEFAULT 'open',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_risks_likelihood_known CHECK (likelihood IN ('low','medium','high')),
  CONSTRAINT trip_risks_impact_known     CHECK (impact     IN ('low','medium','high')),
  CONSTRAINT trip_risks_status_known     CHECK (status IN ('open','mitigated','realised','closed')),
  CONSTRAINT trip_risks_trigger_object    CHECK (jsonb_typeof(trigger_json)    = 'object'),
  CONSTRAINT trip_risks_mitigation_object CHECK (jsonb_typeof(mitigation_json) = 'object')
);
COMMENT ON TABLE public.trip_risks IS
  'Trips spec §5.1/§8.4 trip_risks — the risk register §8.4 propagation (TR144) needs and does not have. No writer yet; RLS crew SELECT only.';
CREATE INDEX idx_trip_risks_trip_status ON public.trip_risks (trip_id, status);

DO $grants$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['trip_goals','trip_decision_tasks','trip_risks'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT USING (authz.is_trip_crew(trip_id))',
      t || '_select_crew', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END
$grants$;

DO $post$
DECLARE n int; sec boolean; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['trip_goals','trip_decision_tasks','trip_risks'] LOOP
    SELECT count(*) INTO n FROM information_schema.tables
     WHERE table_schema='public' AND table_name=t;
    IF n <> 1 THEN RAISE EXCEPTION '2762: % absent after create', t; END IF;

    EXECUTE format('SELECT relrowsecurity FROM pg_class WHERE oid=%L::regclass', 'public.'||t) INTO sec;
    IF NOT sec THEN RAISE EXCEPTION '2762: RLS not enabled on %', t; END IF;

    SELECT count(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename=t;
    IF n <> 1 THEN RAISE EXCEPTION '2762: % expected 1 policy, found %', t, n; END IF;
    SELECT count(*) INTO n FROM pg_policies
     WHERE schemaname='public' AND tablename=t AND cmd <> 'SELECT';
    IF n <> 0 THEN RAISE EXCEPTION '2762: % has a non-SELECT policy', t; END IF;

    IF has_table_privilege('authenticated','public.'||t,'INSERT')
       OR has_table_privilege('authenticated','public.'||t,'UPDATE')
       OR has_table_privilege('authenticated','public.'||t,'DELETE')
    THEN RAISE EXCEPTION '2762: authenticated holds a write privilege on %', t; END IF;
    IF NOT has_table_privilege('authenticated','public.'||t,'SELECT')
    THEN RAISE EXCEPTION '2762: authenticated cannot SELECT %', t; END IF;
  END LOOP;

  -- The assignee FK must be SET NULL, not CASCADE. Checked because the two are
  -- one keyword apart and the wrong one silently deletes the record that a
  -- decision was owed.
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid='public.trip_decision_tasks'::regclass AND contype='f' AND confdeltype='n';
  IF n <> 1 THEN RAISE EXCEPTION '2762: assigned_user_id must be ON DELETE SET NULL (found % such FK)', n; END IF;
END
$post$;

COMMIT;
