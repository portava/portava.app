-- Behavioural rehearsal for 3806 (memory_convergence_proposals and its guard trigger), after 3806 and
-- 3806_00_seed.sql. Each DO block RAISES on a failed expectation. See sql/rehearsals/README.md, section "3806".
-- Never against production or the CI project. Writes run as service_role, the role the API's service client holds;
-- deletions of Memories, photos and accounts run as the harness owner (as account deletion does).
CREATE OR REPLACE FUNCTION pg_temp.ck(cond boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'EXPECTATION FAILED: %', msg; END IF; END $$;
CREATE OR REPLACE FUNCTION pg_temp.st(m uuid, p uuid) RETURNS text LANGUAGE sql AS $$ SELECT state FROM public.memory_convergence_proposals WHERE memory_id = m AND media_asset_id = p $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO service_role;

-- T1 no client role reads or writes the table.
SET ROLE authenticated;
DO $$ BEGIN
  BEGIN PERFORM 1 FROM public.memory_convergence_proposals; RAISE EXCEPTION 'EXPECTATION FAILED: T1 authenticated read'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN INSERT INTO public.memory_convergence_proposals (owner_id, memory_id, media_asset_id, basis) VALUES ('e6000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-0000000000a1', 'f6000000-0000-4000-8000-0000000000a1', 'memory_window'); RAISE EXCEPTION 'EXPECTATION FAILED: T1 authenticated wrote'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SET ROLE anon;
DO $$ BEGIN
  BEGIN PERFORM 1 FROM public.memory_convergence_proposals; RAISE EXCEPTION 'EXPECTATION FAILED: T1 anon read'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;

SET ROLE service_role;
-- T2 the owner-only guard: another person's Memory, or another person's photo, is refused; nothing is written.
DO $$ BEGIN
  BEGIN INSERT INTO public.memory_convergence_proposals (owner_id, memory_id, media_asset_id, basis) VALUES ('e6000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-0000000000b1', 'f6000000-0000-4000-8000-0000000000a1', 'memory_window'); RAISE EXCEPTION 'EXPECTATION FAILED: T2 a proposal onto B''s Memory'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO public.memory_convergence_proposals (owner_id, memory_id, media_asset_id, basis) VALUES ('e6000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-0000000000a1', 'f6000000-0000-4000-8000-0000000000b1', 'memory_window'); RAISE EXCEPTION 'EXPECTATION FAILED: T2 B''s photo offered to A'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO public.memory_convergence_proposals (owner_id, memory_id, media_asset_id, basis) VALUES ('e6000000-0000-4000-8000-000000000002', 'c6000000-0000-4000-8000-0000000000a1', 'f6000000-0000-4000-8000-0000000000a1', 'memory_window'); RAISE EXCEPTION 'EXPECTATION FAILED: T2 B owning a proposal about A''s Memory and photo'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO public.memory_convergence_proposals (owner_id, memory_id, media_asset_id, basis) VALUES ('e6000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-0000000000a1', 'f6000000-0000-4000-8000-0000000000a1', 'a_hunch'); RAISE EXCEPTION 'EXPECTATION FAILED: T2 an unknown basis'; EXCEPTION WHEN check_violation THEN NULL; END;
  PERFORM pg_temp.ck((SELECT count(*) FROM public.memory_convergence_proposals) = 0, 'T2 no refusal wrote a row');
END $$;

-- T3 proposals: proposed with no decision; the detector's insert (ON CONFLICT DO NOTHING) is a no-op on a re-run.
DO $$ BEGIN
  INSERT INTO public.memory_convergence_proposals (owner_id, memory_id, media_asset_id, basis) VALUES
    ('e6000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-0000000000a1', 'f6000000-0000-4000-8000-0000000000a1', 'memory_window'),
    ('e6000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-0000000000a1', 'f6000000-0000-4000-8000-0000000000a2', 'memory_window'),
    ('e6000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-0000000000a2', 'f6000000-0000-4000-8000-0000000000a2', 'confirmed_episode'),
    ('e6000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-0000000000a1', 'f6000000-0000-4000-8000-0000000000a3', 'memory_window')
  ON CONFLICT (owner_id, memory_id, media_asset_id) DO NOTHING;
  PERFORM pg_temp.ck((SELECT count(*) FROM public.memory_convergence_proposals WHERE state = 'proposed' AND decided_at IS NULL) = 4, 'T3 four open proposals');
  INSERT INTO public.memory_convergence_proposals (owner_id, memory_id, media_asset_id, basis) VALUES
    ('e6000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-0000000000a1', 'f6000000-0000-4000-8000-0000000000a1', 'memory_window')
  ON CONFLICT (owner_id, memory_id, media_asset_id) DO NOTHING;
  PERFORM pg_temp.ck((SELECT count(*) FROM public.memory_convergence_proposals) = 4, 'T3 a re-run adds nothing');
END $$;

-- T4 decisions: unstamped refused; a stamped dismissal holds; it is final (no reopen, no flip to kept), and the
--    detector's insert never reopens it; a keep is final too; nothing but the decision may change.
DO $$ BEGIN
  BEGIN UPDATE public.memory_convergence_proposals SET state = 'dismissed' WHERE memory_id = 'c6000000-0000-4000-8000-0000000000a1' AND media_asset_id = 'f6000000-0000-4000-8000-0000000000a1'; RAISE EXCEPTION 'EXPECTATION FAILED: T4 an unstamped dismissal'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO public.memory_convergence_proposals (owner_id, memory_id, media_asset_id, basis, state) VALUES ('e6000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-0000000000a2', 'f6000000-0000-4000-8000-0000000000a3', 'memory_window', 'kept'); RAISE EXCEPTION 'EXPECTATION FAILED: T4 a row born decided without a stamp'; EXCEPTION WHEN check_violation THEN NULL; END;
  UPDATE public.memory_convergence_proposals SET state = 'dismissed', decided_at = now() WHERE memory_id = 'c6000000-0000-4000-8000-0000000000a1' AND media_asset_id = 'f6000000-0000-4000-8000-0000000000a1' AND state = 'proposed';
  PERFORM pg_temp.ck(pg_temp.st('c6000000-0000-4000-8000-0000000000a1', 'f6000000-0000-4000-8000-0000000000a1') = 'dismissed', 'T4 the dismissal holds');
  BEGIN UPDATE public.memory_convergence_proposals SET state = 'proposed', decided_at = NULL WHERE memory_id = 'c6000000-0000-4000-8000-0000000000a1' AND media_asset_id = 'f6000000-0000-4000-8000-0000000000a1'; RAISE EXCEPTION 'EXPECTATION FAILED: T4 a dismissal reopened'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.memory_convergence_proposals SET state = 'kept' WHERE memory_id = 'c6000000-0000-4000-8000-0000000000a1' AND media_asset_id = 'f6000000-0000-4000-8000-0000000000a1'; RAISE EXCEPTION 'EXPECTATION FAILED: T4 a dismissal flipped to kept'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.memory_convergence_proposals SET decided_at = now() + interval '1 day' WHERE memory_id = 'c6000000-0000-4000-8000-0000000000a1' AND media_asset_id = 'f6000000-0000-4000-8000-0000000000a1'; RAISE EXCEPTION 'EXPECTATION FAILED: T4 a decision re-dated'; EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO public.memory_convergence_proposals (owner_id, memory_id, media_asset_id, basis) VALUES ('e6000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-0000000000a1', 'f6000000-0000-4000-8000-0000000000a1', 'memory_window') ON CONFLICT (owner_id, memory_id, media_asset_id) DO NOTHING;
  PERFORM pg_temp.ck(pg_temp.st('c6000000-0000-4000-8000-0000000000a1', 'f6000000-0000-4000-8000-0000000000a1') = 'dismissed', 'T4 the detector''s insert never reopens a dismissal');
  UPDATE public.memory_convergence_proposals SET state = 'kept', decided_at = now() WHERE memory_id = 'c6000000-0000-4000-8000-0000000000a1' AND media_asset_id = 'f6000000-0000-4000-8000-0000000000a2' AND state = 'proposed';
  BEGIN UPDATE public.memory_convergence_proposals SET state = 'dismissed', decided_at = now() WHERE memory_id = 'c6000000-0000-4000-8000-0000000000a1' AND media_asset_id = 'f6000000-0000-4000-8000-0000000000a2'; RAISE EXCEPTION 'EXPECTATION FAILED: T4 a kept photo dismissed'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.memory_convergence_proposals SET basis = 'confirmed_episode' WHERE memory_id = 'c6000000-0000-4000-8000-0000000000a1' AND media_asset_id = 'f6000000-0000-4000-8000-0000000000a3'; RAISE EXCEPTION 'EXPECTATION FAILED: T4 a basis rewritten'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.memory_convergence_proposals SET memory_id = 'c6000000-0000-4000-8000-0000000000a2' WHERE memory_id = 'c6000000-0000-4000-8000-0000000000a1' AND media_asset_id = 'f6000000-0000-4000-8000-0000000000a3'; RAISE EXCEPTION 'EXPECTATION FAILED: T4 a proposal moved to another Memory'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.memory_convergence_proposals SET owner_id = 'e6000000-0000-4000-8000-000000000002' WHERE memory_id = 'c6000000-0000-4000-8000-0000000000a1' AND media_asset_id = 'f6000000-0000-4000-8000-0000000000a3'; RAISE EXCEPTION 'EXPECTATION FAILED: T4 a proposal moved to another owner'; EXCEPTION WHEN check_violation THEN NULL; END;
  PERFORM pg_temp.ck(pg_temp.st('c6000000-0000-4000-8000-0000000000a1', 'f6000000-0000-4000-8000-0000000000a2') = 'kept' AND pg_temp.st('c6000000-0000-4000-8000-0000000000a1', 'f6000000-0000-4000-8000-0000000000a3') = 'proposed', 'T4 nothing else changed');
END $$;
RESET ROLE;

-- T5 erasure: a Memory hard-deleted takes its rows; a photo deleted takes its rows; a deleted account takes its rows.
DO $$ BEGIN
  INSERT INTO public.memory_convergence_proposals (owner_id, memory_id, media_asset_id, basis) VALUES ('e6000000-0000-4000-8000-000000000003', 'c6000000-0000-4000-8000-0000000000c1', 'f6000000-0000-4000-8000-0000000000c1', 'memory_window');
  DELETE FROM public.memories WHERE id = 'c6000000-0000-4000-8000-0000000000a2';
  PERFORM pg_temp.ck((SELECT count(*) FROM public.memory_convergence_proposals WHERE memory_id = 'c6000000-0000-4000-8000-0000000000a2') = 0, 'T5 a deleted Memory takes its proposals');
  DELETE FROM public.media_assets WHERE id = 'f6000000-0000-4000-8000-0000000000a3';
  PERFORM pg_temp.ck((SELECT count(*) FROM public.memory_convergence_proposals WHERE media_asset_id = 'f6000000-0000-4000-8000-0000000000a3') = 0, 'T5 a deleted photo takes its proposals');
  DELETE FROM auth.users WHERE id = 'e6000000-0000-4000-8000-000000000003';
  PERFORM pg_temp.ck((SELECT count(*) FROM public.memory_convergence_proposals WHERE owner_id = 'e6000000-0000-4000-8000-000000000003') = 0, 'T5 a deleted account takes its proposals');
  PERFORM pg_temp.ck((SELECT count(*) FROM public.memory_convergence_proposals) = 2, 'T5 A''s two remaining rows (a dismissal and a keep) are untouched');
END $$;
