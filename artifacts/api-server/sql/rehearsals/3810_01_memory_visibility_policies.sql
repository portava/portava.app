-- Behavioural rehearsal for 3810 (public.memory_visibility_policies, the owner's per-Memory §10 person ceiling, and the
-- security_invoker view public.memory_visibility_policy_effective), after 3810_00_seed.sql and 3810. Each DO block
-- RAISES on a failed expectation. See sql/rehearsals/README.md, section "3810". Never against production or the CI project.
-- Leaves the table EMPTY at the end except for one row (T9), so the runner can show the rollback refusing.
CREATE OR REPLACE FUNCTION pg_temp.ck(cond boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'EXPECTATION FAILED: %', msg; END IF; END $$;

-- T1 the Memories that existed before 3810 are in the view, untouched, with no ceiling.
DO $$ BEGIN
  PERFORM pg_temp.ck((SELECT count(*) FROM public.memory_visibility_policy_effective WHERE memory_id::text LIKE 'c3810000-%' AND person_visibility_ceiling IS NULL) = 3, 'T1 pre-existing Memories read no ceiling');
  PERFORM pg_temp.ck((SELECT count(*) FROM public.memories WHERE id::text LIKE 'c3810000-%' AND updated_at = '2026-01-01T00:00:00Z') = 3, 'T1 3810 rewrote no Memory');
  PERFORM pg_temp.ck((SELECT count(*) FROM public.memory_visibility_policies) = 0, 'T1 3810 wrote no policy row');
END $$;

-- T2 one ceiling per Memory, from the §10 ladder only, never NULL, only for a Memory that exists; an upsert replaces it.
DO $$ BEGIN
  INSERT INTO public.memory_visibility_policies (memory_id, owner_id, person_visibility_ceiling)
  VALUES ('c3810000-0000-4000-8000-000000000001', 'e3810000-0000-4000-8000-000000000001', 'ANONYMOUS_COUNT');
  BEGIN
    INSERT INTO public.memory_visibility_policies (memory_id, owner_id, person_visibility_ceiling)
    VALUES ('c3810000-0000-4000-8000-000000000001', 'e3810000-0000-4000-8000-000000000001', 'HIDDEN');
    RAISE EXCEPTION 'EXPECTATION FAILED: T2 a second policy row for one Memory was stored';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.memory_visibility_policies (memory_id, owner_id, person_visibility_ceiling)
    VALUES ('c3810000-0000-4000-8000-000000000002', 'e3810000-0000-4000-8000-000000000001', 'SECRET');
    RAISE EXCEPTION 'EXPECTATION FAILED: T2 an off-ladder ceiling was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.memory_visibility_policies (memory_id, owner_id, person_visibility_ceiling)
    VALUES ('c3810000-0000-4000-8000-000000000002', 'e3810000-0000-4000-8000-000000000001', 'named');
    RAISE EXCEPTION 'EXPECTATION FAILED: T2 a lower-case rung was stored (the reader would read it as HIDDEN)';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.memory_visibility_policies (memory_id, owner_id, person_visibility_ceiling)
    VALUES ('c3810000-0000-4000-8000-000000000002', 'e3810000-0000-4000-8000-000000000001', NULL);
    RAISE EXCEPTION 'EXPECTATION FAILED: T2 a NULL ceiling was stored (clearing deletes the row)';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.memory_visibility_policies (memory_id, owner_id, person_visibility_ceiling)
    VALUES ('c3810000-0000-4000-8000-0000000000ff', 'e3810000-0000-4000-8000-000000000001', 'HIDDEN');
    RAISE EXCEPTION 'EXPECTATION FAILED: T2 a policy for a Memory that does not exist was stored';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  INSERT INTO public.memory_visibility_policies (memory_id, owner_id, person_visibility_ceiling)
  VALUES ('c3810000-0000-4000-8000-000000000001', 'e3810000-0000-4000-8000-000000000001', 'HIDDEN')
  ON CONFLICT (memory_id) DO UPDATE SET person_visibility_ceiling = EXCLUDED.person_visibility_ceiling, updated_at = now();
  PERFORM pg_temp.ck((SELECT person_visibility_ceiling FROM public.memory_visibility_policies WHERE memory_id = 'c3810000-0000-4000-8000-000000000001') = 'HIDDEN', 'T2 the upsert replaced the ceiling');
  PERFORM pg_temp.ck((SELECT count(*) FROM public.memory_visibility_policies) = 1, 'T2 exactly one row');
END $$;

-- T3 the view is a JOIN, not a copy: the audience and the precision are read from memories as they are NOW.
DO $$ BEGIN
  PERFORM pg_temp.ck((SELECT person_visibility_ceiling FROM public.memory_visibility_policy_effective WHERE memory_id = 'c3810000-0000-4000-8000-000000000001') = 'HIDDEN', 'T3 the view carries the ceiling');
  PERFORM pg_temp.ck((SELECT person_visibility_ceiling FROM public.memory_visibility_policy_effective WHERE memory_id = 'c3810000-0000-4000-8000-000000000002') IS NULL, 'T3 the same owner''s other Memory does not inherit the ceiling');
  PERFORM pg_temp.ck((SELECT count(*) FROM public.memory_visibility_policy_effective) = (SELECT count(*) FROM public.memories), 'T3 one view row per Memory');
  PERFORM pg_temp.ck((SELECT visibility || '/' || location_precision || '/' || cardinality(hidden_user_ids) FROM public.memory_visibility_policy_effective WHERE memory_id = 'c3810000-0000-4000-8000-000000000001') = 'public/city/1', 'T3 the view carries the audience and the rung');
  UPDATE public.memories SET visibility = 'only_me', location_precision = 'country', hidden_user_ids = '{}' WHERE id = 'c3810000-0000-4000-8000-000000000001';
  PERFORM pg_temp.ck((SELECT visibility || '/' || location_precision || '/' || cardinality(hidden_user_ids) FROM public.memory_visibility_policy_effective WHERE memory_id = 'c3810000-0000-4000-8000-000000000001') = 'only_me/country/0', 'T3 a change on memories is the view''s change (single source)');
  UPDATE public.memories SET visibility = 'public', location_precision = 'city', hidden_user_ids = '{e3810000-0000-4000-8000-000000000002}', updated_at = '2026-01-01T00:00:00Z' WHERE id = 'c3810000-0000-4000-8000-000000000001';
  PERFORM pg_temp.ck(NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'memory_visibility_policies'
                                   AND column_name IN ('visibility', 'allowed_user_ids', 'hidden_user_ids', 'location_precision')), 'T3 the table copies no audience or precision column (Q-H33)');
END $$;

-- T4 erasure: the policy goes with its Memory, and with its owner's account.
DO $$ BEGIN
  INSERT INTO public.memory_visibility_policies (memory_id, owner_id, person_visibility_ceiling)
  VALUES ('c3810000-0000-4000-8000-000000000003', 'e3810000-0000-4000-8000-000000000002', 'CREW_ONLY');
  DELETE FROM public.memories WHERE id = 'c3810000-0000-4000-8000-000000000001';
  PERFORM pg_temp.ck(NOT EXISTS (SELECT 1 FROM public.memory_visibility_policies WHERE memory_id = 'c3810000-0000-4000-8000-000000000001'), 'T4 a hard-deleted Memory takes its policy');
  DELETE FROM auth.users WHERE id = 'e3810000-0000-4000-8000-000000000002';
  PERFORM pg_temp.ck(NOT EXISTS (SELECT 1 FROM public.memory_visibility_policies WHERE owner_id = 'e3810000-0000-4000-8000-000000000002'), 'T4 a deleted account takes its policies');
  PERFORM pg_temp.ck((SELECT count(*) FROM public.memory_visibility_policies) = 0, 'T4 nothing left');
END $$;

-- T5 no client role reaches either relation (Supabase's default privileges hand both a new table and a new view).
SET ROLE anon;
DO $$ BEGIN
  BEGIN PERFORM 1 FROM public.memory_visibility_policies; RAISE EXCEPTION 'EXPECTATION FAILED: T5 anon read the table'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM 1 FROM public.memory_visibility_policy_effective; RAISE EXCEPTION 'EXPECTATION FAILED: T5 anon read the view'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN INSERT INTO public.memory_visibility_policies (memory_id, owner_id, person_visibility_ceiling) VALUES ('c3810000-0000-4000-8000-000000000002', 'e3810000-0000-4000-8000-000000000001', 'NAMED');
        RAISE EXCEPTION 'EXPECTATION FAILED: T5 anon wrote a ceiling'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SET ROLE authenticated;
DO $$ BEGIN
  BEGIN PERFORM 1 FROM public.memory_visibility_policies; RAISE EXCEPTION 'EXPECTATION FAILED: T5 authenticated read the table'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM 1 FROM public.memory_visibility_policy_effective; RAISE EXCEPTION 'EXPECTATION FAILED: T5 authenticated read the view'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN DELETE FROM public.memory_visibility_policies; RAISE EXCEPTION 'EXPECTATION FAILED: T5 authenticated deleted ceilings'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;

-- T6 the API's role sets, changes and clears a ceiling, and reads the view; the view itself is not writable.
SET ROLE service_role;
DO $$ BEGIN
  INSERT INTO public.memory_visibility_policies (memory_id, owner_id, person_visibility_ceiling)
  VALUES ('c3810000-0000-4000-8000-000000000002', 'e3810000-0000-4000-8000-000000000001', 'PROFILE_LINKED');
  UPDATE public.memory_visibility_policies SET person_visibility_ceiling = 'ANONYMOUS_COUNT' WHERE memory_id = 'c3810000-0000-4000-8000-000000000002';
  PERFORM pg_temp.ck((SELECT person_visibility_ceiling FROM public.memory_visibility_policy_effective WHERE memory_id = 'c3810000-0000-4000-8000-000000000002') = 'ANONYMOUS_COUNT', 'T6 service_role reads the ceiling through the view');
  DELETE FROM public.memory_visibility_policies WHERE memory_id = 'c3810000-0000-4000-8000-000000000002';
  PERFORM pg_temp.ck((SELECT person_visibility_ceiling FROM public.memory_visibility_policy_effective WHERE memory_id = 'c3810000-0000-4000-8000-000000000002') IS NULL, 'T6 clearing deletes the row; the view reads no ceiling');
  BEGIN UPDATE public.memory_visibility_policy_effective SET person_visibility_ceiling = 'NAMED'; RAISE EXCEPTION 'EXPECTATION FAILED: T6 the view was written'; EXCEPTION WHEN insufficient_privilege OR object_not_in_prerequisite_state OR feature_not_supported THEN NULL; END;
END $$;
RESET ROLE;

-- T7 the view is security_invoker: a reader granted the view but not memories is refused by memories' own privileges.
-- NEGATIVE CONTROL in the same step: with security_invoker off, the same reader reads straight past them.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rehearsal_3810_reader') THEN CREATE ROLE rehearsal_3810_reader NOLOGIN; END IF;
  GRANT USAGE ON SCHEMA public TO rehearsal_3810_reader;
  GRANT SELECT ON public.memory_visibility_policy_effective TO rehearsal_3810_reader;
END $$;
SET ROLE rehearsal_3810_reader;
DO $$ BEGIN
  BEGIN PERFORM 1 FROM public.memory_visibility_policy_effective; RAISE EXCEPTION 'EXPECTATION FAILED: T7 the view read memories with its owner''s rights'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
ALTER VIEW public.memory_visibility_policy_effective SET (security_invoker = false);
SET ROLE rehearsal_3810_reader;
DO $$ BEGIN
  PERFORM pg_temp.ck((SELECT count(*) FROM public.memory_visibility_policy_effective) > 0, 'T7 negative control: a definer view does read past memories');
END $$;
RESET ROLE;
ALTER VIEW public.memory_visibility_policy_effective SET (security_invoker = true);
DO $$ BEGIN
  REVOKE ALL ON public.memory_visibility_policy_effective FROM rehearsal_3810_reader;
  REVOKE ALL ON SCHEMA public FROM rehearsal_3810_reader;
  DROP ROLE rehearsal_3810_reader;
END $$;

-- T8 3813's refusal (PR #726): "a view over public.memories is readable by a client role". This view is not.
-- NEGATIVE CONTROL: grant it to anon and the same query names it.
DO $$
DECLARE v text;
BEGIN
  SELECT string_agg(DISTINCT format('%s (%s)', c.oid::regclass, r.rolname), ', ') INTO v
    FROM pg_depend d JOIN pg_rewrite w ON d.classid = 'pg_rewrite'::regclass AND d.objid = w.oid
    JOIN pg_class c ON c.oid = w.ev_class CROSS JOIN (VALUES ('anon'), ('authenticated')) r(rolname)
   WHERE d.refclassid = 'pg_class'::regclass AND d.refobjid = 'public.memories'::regclass
     AND w.ev_class <> 'public.memories'::regclass AND has_any_column_privilege(r.rolname, c.oid, 'SELECT');
  PERFORM pg_temp.ck(v IS NULL, 'T8 3813 would find a client-readable view over memories: ' || coalesce(v, ''));
  GRANT SELECT ON public.memory_visibility_policy_effective TO anon;
  SELECT string_agg(DISTINCT format('%s (%s)', c.oid::regclass, r.rolname), ', ') INTO v
    FROM pg_depend d JOIN pg_rewrite w ON d.classid = 'pg_rewrite'::regclass AND d.objid = w.oid
    JOIN pg_class c ON c.oid = w.ev_class CROSS JOIN (VALUES ('anon'), ('authenticated')) r(rolname)
   WHERE d.refclassid = 'pg_class'::regclass AND d.refobjid = 'public.memories'::regclass
     AND w.ev_class <> 'public.memories'::regclass AND has_any_column_privilege(r.rolname, c.oid, 'SELECT');
  PERFORM pg_temp.ck(v LIKE '%memory_visibility_policy_effective (anon)%', 'T8 negative control: a client grant on the view is what 3813 refuses');
  REVOKE ALL ON public.memory_visibility_policy_effective FROM anon;
END $$;

-- T9 leave one owner's choice behind, so the rollback has something it must refuse to destroy.
DO $$ BEGIN
  INSERT INTO public.memory_visibility_policies (memory_id, owner_id, person_visibility_ceiling)
  VALUES ('c3810000-0000-4000-8000-000000000002', 'e3810000-0000-4000-8000-000000000001', 'HIDDEN');
  PERFORM pg_temp.ck((SELECT count(*) FROM public.memory_visibility_policies) = 1, 'T9 one ceiling stands');
END $$;
