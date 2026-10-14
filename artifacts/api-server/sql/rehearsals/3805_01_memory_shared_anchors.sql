-- Behavioural rehearsal for 3805 (memory_shared_anchors, memory_shared_anchor_members, their guard and dissolution
-- triggers, memory_shared_anchor_invite), after 3805 and 3805_00_seed.sql. Each DO block RAISES on a failed
-- expectation. See sql/rehearsals/README.md, section "3805". Never against production or the CI project.
-- Writes run as service_role, the role the API's service client holds; account deletions run as the harness owner.
CREATE OR REPLACE FUNCTION pg_temp.ck(cond boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'EXPECTATION FAILED: %', msg; END IF; END $$;
CREATE OR REPLACE FUNCTION pg_temp.st(a uuid, u uuid) RETURNS text LANGUAGE sql AS $$ SELECT status FROM public.memory_shared_anchor_members WHERE anchor_id = a AND user_id = u $$;
CREATE OR REPLACE FUNCTION pg_temp.lnk(a uuid, u uuid) RETURNS uuid LANGUAGE sql AS $$ SELECT memory_id FROM public.memory_shared_anchor_members WHERE anchor_id = a AND user_id = u $$;
CREATE OR REPLACE FUNCTION pg_temp.anchor_of(m uuid) RETURNS uuid LANGUAGE sql AS $$ SELECT anchor_id FROM public.memory_shared_anchor_members WHERE memory_id = m AND status = 'accepted' $$;
CREATE OR REPLACE FUNCTION pg_temp.inv(m uuid, h uuid, u uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT public.memory_shared_anchor_invite(m, h, u) $$;
CREATE OR REPLACE FUNCTION pg_temp.n_accepted(a uuid) RETURNS bigint LANGUAGE sql AS $$ SELECT count(*) FROM public.memory_shared_anchor_members WHERE anchor_id = a AND status = 'accepted' $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO service_role;

-- T1 no client role reads, writes or calls anything 3805 created.
SET ROLE authenticated;
DO $$ BEGIN
  BEGIN PERFORM 1 FROM public.memory_shared_anchors; RAISE EXCEPTION 'EXPECTATION FAILED: T1 authenticated read memory_shared_anchors'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM 1 FROM public.memory_shared_anchor_members; RAISE EXCEPTION 'EXPECTATION FAILED: T1 authenticated read memory_shared_anchor_members'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN INSERT INTO public.memory_shared_anchors (created_by) VALUES ('e5000000-0000-4000-8000-000000000001'); RAISE EXCEPTION 'EXPECTATION FAILED: T1 authenticated created an anchor'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.memory_shared_anchor_invite('c5000000-0000-4000-8000-0000000000a1', 'e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000002'); RAISE EXCEPTION 'EXPECTATION FAILED: T1 authenticated called the invite function'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SET ROLE anon;
DO $$ BEGIN
  BEGIN PERFORM 1 FROM public.memory_shared_anchor_members; RAISE EXCEPTION 'EXPECTATION FAILED: T1 anon read memory_shared_anchor_members'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.memory_shared_anchor_invite('c5000000-0000-4000-8000-0000000000a1', 'e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000002'); RAISE EXCEPTION 'EXPECTATION FAILED: T1 anon called the invite function'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;

SET ROLE service_role;
-- T2 every refusal writes nothing: a non-owner, a PENDING tag, a REMOVED tag, no tag, the host themself, a deleted
--    Memory, a moderator-removed Memory, a missing Memory.
DO $$ BEGIN
  PERFORM pg_temp.ck(pg_temp.inv('c5000000-0000-4000-8000-0000000000a1', 'e5000000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-000000000003')->>'outcome' = 'not_found', 'T2 a non-owner cannot invite from someone else''s Memory');
  PERFORM pg_temp.ck(pg_temp.inv('c5000000-0000-4000-8000-0000000000a1', 'e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000004')->>'outcome' = 'not_invitable', 'T2 a PENDING tag is not invitable (Q-H53-1)');
  PERFORM pg_temp.ck(pg_temp.inv('c5000000-0000-4000-8000-0000000000a1', 'e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000005')->>'outcome' = 'not_invitable', 'T2 a REMOVED tag is not invitable');
  PERFORM pg_temp.ck(pg_temp.inv('c5000000-0000-4000-8000-0000000000a1', 'e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000006')->>'outcome' = 'not_invitable', 'T2 no tag is not invitable');
  PERFORM pg_temp.ck(pg_temp.inv('c5000000-0000-4000-8000-0000000000a1', 'e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000001')->>'outcome' = 'not_invitable', 'T2 the host cannot invite themself');
  PERFORM pg_temp.ck(pg_temp.inv('c5000000-0000-4000-8000-0000000000c2', 'e5000000-0000-4000-8000-000000000003', 'e5000000-0000-4000-8000-000000000002')->>'outcome' = 'not_found', 'T2 a deleted Memory starts nothing');
  PERFORM pg_temp.ck(pg_temp.inv('c5000000-0000-4000-8000-0000000000a2', 'e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000002')->>'outcome' = 'not_found', 'T2 a moderator-removed Memory starts nothing');
  PERFORM pg_temp.ck(pg_temp.inv('c5000000-0000-4000-8000-00000000ffff', 'e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000002')->>'outcome' = 'not_found', 'T2 a missing Memory starts nothing');
  PERFORM pg_temp.ck((SELECT count(*) FROM public.memory_shared_anchors) = 0 AND (SELECT count(*) FROM public.memory_shared_anchor_members) = 0, 'T2 no refusal wrote a row');
END $$;

-- T3 the first invitation creates the anchor with the host accepted (MH linked) and B invited (nothing linked); a
--    repeat is already_invited; a second invitee joins the SAME anchor; the anchor is not shared yet.
DO $$ DECLARE v jsonb; a uuid; BEGIN
  v := pg_temp.inv('c5000000-0000-4000-8000-0000000000a1', 'e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000002');
  PERFORM pg_temp.ck(v->>'outcome' = 'invited' AND (v->>'created')::boolean, 'T3 the first invitation creates the anchor');
  a := (v->>'anchor_id')::uuid;
  PERFORM pg_temp.ck((SELECT created_by FROM public.memory_shared_anchors WHERE id = a) = 'e5000000-0000-4000-8000-000000000001', 'T3 the host is the Memory''s owner');
  PERFORM pg_temp.ck(pg_temp.st(a, 'e5000000-0000-4000-8000-000000000001') = 'accepted' AND pg_temp.lnk(a, 'e5000000-0000-4000-8000-000000000001') = 'c5000000-0000-4000-8000-0000000000a1', 'T3 the host is accepted with MH linked');
  PERFORM pg_temp.ck(pg_temp.st(a, 'e5000000-0000-4000-8000-000000000002') = 'invited' AND pg_temp.lnk(a, 'e5000000-0000-4000-8000-000000000002') IS NULL, 'T3 B is invited and links nothing');
  v := pg_temp.inv('c5000000-0000-4000-8000-0000000000a1', 'e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000002');
  PERFORM pg_temp.ck(v->>'outcome' = 'already_invited' AND (v->>'anchor_id')::uuid = a, 'T3 a repeat invitation is already_invited');
  v := pg_temp.inv('c5000000-0000-4000-8000-0000000000a1', 'e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000003');
  PERFORM pg_temp.ck(v->>'outcome' = 'invited' AND NOT (v->>'created')::boolean AND (v->>'anchor_id')::uuid = a, 'T3 C joins the same anchor');
  PERFORM pg_temp.ck((SELECT count(*) FROM public.memory_shared_anchors) = 1, 'T3 one anchor per Memory');
  PERFORM pg_temp.ck(pg_temp.n_accepted(a) = 1, 'T3 not shared until an invitee accepts');
END $$;

-- T4 the guard: no row is created declined/left; no transition outside invited -> accepted|declined, accepted -> left;
--    no move to another person; no Memory linked while invited; no accept without a consent stamp; no link to a Memory
--    the member does not own, or to a deleted one.
DO $$ DECLARE a uuid := pg_temp.anchor_of('c5000000-0000-4000-8000-0000000000a1'); BEGIN
  BEGIN INSERT INTO public.memory_shared_anchor_members (anchor_id, user_id, status, left_at) VALUES (a, 'e5000000-0000-4000-8000-000000000006', 'left', now()); RAISE EXCEPTION 'EXPECTATION FAILED: T4 a row was created as left'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.memory_shared_anchor_members SET status = 'left', left_at = now() WHERE anchor_id = a AND user_id = 'e5000000-0000-4000-8000-000000000002'; RAISE EXCEPTION 'EXPECTATION FAILED: T4 invited -> left'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.memory_shared_anchor_members SET user_id = 'e5000000-0000-4000-8000-000000000006' WHERE anchor_id = a AND user_id = 'e5000000-0000-4000-8000-000000000002'; RAISE EXCEPTION 'EXPECTATION FAILED: T4 a membership moved to another person'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.memory_shared_anchor_members SET memory_id = 'c5000000-0000-4000-8000-0000000000b1' WHERE anchor_id = a AND user_id = 'e5000000-0000-4000-8000-000000000002'; RAISE EXCEPTION 'EXPECTATION FAILED: T4 a Memory linked while invited'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.memory_shared_anchor_members SET status = 'accepted' WHERE anchor_id = a AND user_id = 'e5000000-0000-4000-8000-000000000002'; RAISE EXCEPTION 'EXPECTATION FAILED: T4 accepted without a consent stamp'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.memory_shared_anchor_members SET status = 'accepted', consented_at = now(), memory_id = 'c5000000-0000-4000-8000-0000000000d1' WHERE anchor_id = a AND user_id = 'e5000000-0000-4000-8000-000000000002'; RAISE EXCEPTION 'EXPECTATION FAILED: T4 B linked X''s Memory'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.memory_shared_anchor_members SET status = 'accepted', consented_at = now(), memory_id = 'c5000000-0000-4000-8000-0000000000c2' WHERE anchor_id = a AND user_id = 'e5000000-0000-4000-8000-000000000003'; RAISE EXCEPTION 'EXPECTATION FAILED: T4 C linked a deleted Memory'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.memory_shared_anchor_members SET status = 'maybe' WHERE anchor_id = a AND user_id = 'e5000000-0000-4000-8000-000000000003'; RAISE EXCEPTION 'EXPECTATION FAILED: T4 an unknown status'; EXCEPTION WHEN check_violation THEN NULL; END;
  PERFORM pg_temp.ck(pg_temp.st(a, 'e5000000-0000-4000-8000-000000000002') = 'invited' AND pg_temp.st(a, 'e5000000-0000-4000-8000-000000000003') = 'invited', 'T4 nothing changed');
END $$;

-- T5 B accepts, linking B's OWN Memory: shared (two accepted); accepted cannot go back to invited.
DO $$ DECLARE a uuid := pg_temp.anchor_of('c5000000-0000-4000-8000-0000000000a1'); BEGIN
  UPDATE public.memory_shared_anchor_members SET status = 'accepted', consented_at = now(), memory_id = 'c5000000-0000-4000-8000-0000000000b1'
   WHERE anchor_id = a AND user_id = 'e5000000-0000-4000-8000-000000000002' AND status = 'invited';
  PERFORM pg_temp.ck(pg_temp.st(a, 'e5000000-0000-4000-8000-000000000002') = 'accepted' AND pg_temp.lnk(a, 'e5000000-0000-4000-8000-000000000002') = 'c5000000-0000-4000-8000-0000000000b1', 'T5 B accepted with MB');
  PERFORM pg_temp.ck(pg_temp.n_accepted(a) = 2, 'T5 shared now: two accepted');
  BEGIN UPDATE public.memory_shared_anchor_members SET status = 'invited' WHERE anchor_id = a AND user_id = 'e5000000-0000-4000-8000-000000000002'; RAISE EXCEPTION 'EXPECTATION FAILED: T5 accepted -> invited'; EXCEPTION WHEN check_violation THEN NULL; END;
END $$;

-- T6 a Memory belongs to one anchor at most; a lone invitation that is declined dissolves and erases its anchor.
DO $$ DECLARE v jsonb; a2 uuid; BEGIN
  v := pg_temp.inv('c5000000-0000-4000-8000-0000000000d1', 'e5000000-0000-4000-8000-000000000006', 'e5000000-0000-4000-8000-000000000002');
  PERFORM pg_temp.ck(v->>'outcome' = 'invited' AND (v->>'created')::boolean, 'T6 X starts a second anchor from MX');
  a2 := (v->>'anchor_id')::uuid;
  BEGIN UPDATE public.memory_shared_anchor_members SET status = 'accepted', consented_at = now(), memory_id = 'c5000000-0000-4000-8000-0000000000b1' WHERE anchor_id = a2 AND user_id = 'e5000000-0000-4000-8000-000000000002'; RAISE EXCEPTION 'EXPECTATION FAILED: T6 MB linked to two anchors'; EXCEPTION WHEN unique_violation THEN NULL; END;
  UPDATE public.memory_shared_anchor_members SET status = 'declined' WHERE anchor_id = a2 AND user_id = 'e5000000-0000-4000-8000-000000000002';
  PERFORM pg_temp.ck(NOT EXISTS (SELECT 1 FROM public.memory_shared_anchors WHERE id = a2) AND NOT EXISTS (SELECT 1 FROM public.memory_shared_anchor_members WHERE anchor_id = a2), 'T6 the declined lone invitation dissolved: anchor and rows erased (Q-H53-4)');
END $$;

-- T7 only the host invites: B (accepted, MB linked to H's anchor) cannot invite X from MB.
DO $$ BEGIN
  PERFORM pg_temp.ck(pg_temp.inv('c5000000-0000-4000-8000-0000000000b1', 'e5000000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-000000000006')->>'outcome' = 'not_host', 'T7 a non-host member cannot invite into the anchor');
  PERFORM pg_temp.ck((SELECT count(*) FROM public.memory_shared_anchors) = 1, 'T7 and no new anchor was started from MB');
END $$;

-- T8 C declines: the anchor stays (H and B accepted); C's declined row is kept so C is not asked again.
DO $$ DECLARE a uuid := pg_temp.anchor_of('c5000000-0000-4000-8000-0000000000a1'); BEGIN
  UPDATE public.memory_shared_anchor_members SET status = 'declined' WHERE anchor_id = a AND user_id = 'e5000000-0000-4000-8000-000000000003' AND status = 'invited';
  PERFORM pg_temp.ck(pg_temp.st(a, 'e5000000-0000-4000-8000-000000000003') = 'declined', 'T8 C declined');
  PERFORM pg_temp.ck(pg_temp.n_accepted(a) = 2, 'T8 the anchor stays shared');
  PERFORM pg_temp.ck(pg_temp.inv('c5000000-0000-4000-8000-0000000000a1', 'e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000003')->>'outcome' = 'already_invited', 'T8 C is not re-invited into the same anchor');
  BEGIN UPDATE public.memory_shared_anchor_members SET status = 'accepted', consented_at = now() WHERE anchor_id = a AND user_id = 'e5000000-0000-4000-8000-000000000003'; RAISE EXCEPTION 'EXPECTATION FAILED: T8 declined -> accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
RESET ROLE;

-- T9 a linked Memory hard-deleted: the link is cut (SET NULL); the member stays accepted; nothing else moves.
DO $$ DECLARE a uuid := pg_temp.anchor_of('c5000000-0000-4000-8000-0000000000b1'); BEGIN
  DELETE FROM public.memories WHERE id = 'c5000000-0000-4000-8000-0000000000b1';
  PERFORM pg_temp.ck(pg_temp.st(a, 'e5000000-0000-4000-8000-000000000002') = 'accepted' AND pg_temp.lnk(a, 'e5000000-0000-4000-8000-000000000002') IS NULL, 'T9 the link is cut, the membership stays');
  PERFORM pg_temp.ck(pg_temp.n_accepted(a) = 2, 'T9 still shared');
END $$;

SET ROLE service_role;
-- T10 B leaves: H alone is left, so the anchor dissolves — erased with EVERY row, C's declined row included.
DO $$ DECLARE a uuid := pg_temp.anchor_of('c5000000-0000-4000-8000-0000000000a1'); BEGIN
  UPDATE public.memory_shared_anchor_members SET status = 'left', left_at = now(), memory_id = NULL
   WHERE anchor_id = a AND user_id = 'e5000000-0000-4000-8000-000000000002' AND status = 'accepted';
  PERFORM pg_temp.ck(NOT EXISTS (SELECT 1 FROM public.memory_shared_anchors WHERE id = a), 'T10 the anchor was erased');
  PERFORM pg_temp.ck(NOT EXISTS (SELECT 1 FROM public.memory_shared_anchor_members WHERE anchor_id = a), 'T10 every member row was erased, the declined one included');
END $$;

-- T11 a non-host leaving with two still accepted keeps the anchor; the left row is kept (stamped, unlinked) and that
--     person is not re-invited.
DO $$ DECLARE a uuid; BEGIN
  a := (pg_temp.inv('c5000000-0000-4000-8000-0000000000a1', 'e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000002')->>'anchor_id')::uuid;
  PERFORM pg_temp.inv('c5000000-0000-4000-8000-0000000000a1', 'e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000003');
  UPDATE public.memory_shared_anchor_members SET status = 'accepted', consented_at = now() WHERE anchor_id = a AND user_id = 'e5000000-0000-4000-8000-000000000002';
  UPDATE public.memory_shared_anchor_members SET status = 'accepted', consented_at = now(), memory_id = 'c5000000-0000-4000-8000-0000000000c1' WHERE anchor_id = a AND user_id = 'e5000000-0000-4000-8000-000000000003';
  PERFORM pg_temp.ck(pg_temp.n_accepted(a) = 3, 'T11 three accepted');
  UPDATE public.memory_shared_anchor_members SET status = 'left', left_at = now(), memory_id = NULL WHERE anchor_id = a AND user_id = 'e5000000-0000-4000-8000-000000000003';
  PERFORM pg_temp.ck(EXISTS (SELECT 1 FROM public.memory_shared_anchors WHERE id = a) AND pg_temp.n_accepted(a) = 2, 'T11 H and B keep the anchor');
  PERFORM pg_temp.ck(pg_temp.st(a, 'e5000000-0000-4000-8000-000000000003') = 'left' AND pg_temp.lnk(a, 'e5000000-0000-4000-8000-000000000003') IS NULL
                     AND (SELECT left_at FROM public.memory_shared_anchor_members WHERE anchor_id = a AND user_id = 'e5000000-0000-4000-8000-000000000003') IS NOT NULL, 'T11 C left: stamped and unlinked');
  PERFORM pg_temp.ck(pg_temp.inv('c5000000-0000-4000-8000-0000000000a1', 'e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000003')->>'outcome' = 'already_invited', 'T11 C is not re-invited');
  BEGIN UPDATE public.memory_shared_anchor_members SET status = 'accepted', consented_at = now() WHERE anchor_id = a AND user_id = 'e5000000-0000-4000-8000-000000000003'; RAISE EXCEPTION 'EXPECTATION FAILED: T11 left -> accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
END $$;

-- T12 the host leaving dissolves the anchor even though B is still accepted.
DO $$ DECLARE a uuid := pg_temp.anchor_of('c5000000-0000-4000-8000-0000000000a1'); BEGIN
  UPDATE public.memory_shared_anchor_members SET status = 'left', left_at = now(), memory_id = NULL WHERE anchor_id = a AND user_id = 'e5000000-0000-4000-8000-000000000001';
  PERFORM pg_temp.ck(NOT EXISTS (SELECT 1 FROM public.memory_shared_anchors WHERE id = a) AND NOT EXISTS (SELECT 1 FROM public.memory_shared_anchor_members WHERE anchor_id = a), 'T12 the host left: the anchor and every row erased');
END $$;
RESET ROLE;

-- T13 NEGATIVE CONTROL: with the dissolution trigger disabled, a lone declined invitation leaves its anchor behind —
--     so T6, T10 and T12 are the trigger's work, not the fixture's.
DO $$ DECLARE a uuid; BEGIN
  ALTER TABLE public.memory_shared_anchor_members DISABLE TRIGGER memory_shared_anchor_members_dissolve;
  a := (pg_temp.inv('c5000000-0000-4000-8000-0000000000d1', 'e5000000-0000-4000-8000-000000000006', 'e5000000-0000-4000-8000-000000000002')->>'anchor_id')::uuid;
  UPDATE public.memory_shared_anchor_members SET status = 'declined' WHERE anchor_id = a AND user_id = 'e5000000-0000-4000-8000-000000000002';
  PERFORM pg_temp.ck(EXISTS (SELECT 1 FROM public.memory_shared_anchors WHERE id = a), 'T13 without the trigger the anchor survives');
  ALTER TABLE public.memory_shared_anchor_members ENABLE TRIGGER memory_shared_anchor_members_dissolve;
  DELETE FROM public.memory_shared_anchors WHERE id = a;
END $$;

-- T14 account deletion (the harness owner, as GoTrue's deleteUser would): a member's account takes their row and the
--     rule re-runs — two left keep the anchor, one left alone erases it — and a linked Memory deleted in the same
--     cascade does not break it; the host's account takes the anchor with it.
DO $$ DECLARE a uuid; x uuid; BEGIN
  a := (pg_temp.inv('c5000000-0000-4000-8000-0000000000a1', 'e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000002')->>'anchor_id')::uuid;
  PERFORM pg_temp.inv('c5000000-0000-4000-8000-0000000000a1', 'e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000003');
  UPDATE public.memory_shared_anchor_members SET status = 'accepted', consented_at = now() WHERE anchor_id = a AND user_id = 'e5000000-0000-4000-8000-000000000002';
  UPDATE public.memory_shared_anchor_members SET status = 'accepted', consented_at = now(), memory_id = 'c5000000-0000-4000-8000-0000000000c1' WHERE anchor_id = a AND user_id = 'e5000000-0000-4000-8000-000000000003';
  DELETE FROM auth.users WHERE id = 'e5000000-0000-4000-8000-000000000003';
  PERFORM pg_temp.ck(pg_temp.st(a, 'e5000000-0000-4000-8000-000000000003') IS NULL AND pg_temp.n_accepted(a) = 2, 'T14 C''s account deletion took C''s row (and MC) and left H and B');
  DELETE FROM auth.users WHERE id = 'e5000000-0000-4000-8000-000000000002';
  PERFORM pg_temp.ck(NOT EXISTS (SELECT 1 FROM public.memory_shared_anchors WHERE id = a) AND NOT EXISTS (SELECT 1 FROM public.memory_shared_anchor_members WHERE anchor_id = a), 'T14 B''s account deletion left H alone: the anchor dissolved');
  x := (pg_temp.inv('c5000000-0000-4000-8000-0000000000d1', 'e5000000-0000-4000-8000-000000000006', 'e5000000-0000-4000-8000-000000000004')->>'anchor_id')::uuid;
  PERFORM pg_temp.ck(x IS NOT NULL AND pg_temp.st(x, 'e5000000-0000-4000-8000-000000000004') = 'invited', 'T14 X invited D');
  DELETE FROM auth.users WHERE id = 'e5000000-0000-4000-8000-000000000006';
  PERFORM pg_temp.ck(NOT EXISTS (SELECT 1 FROM public.memory_shared_anchors WHERE id = x) AND NOT EXISTS (SELECT 1 FROM public.memory_shared_anchor_members WHERE anchor_id = x), 'T14 the host''s account deletion erased the anchor and D''s invitation');
  PERFORM pg_temp.ck((SELECT count(*) FROM public.memory_shared_anchors) = 0 AND (SELECT count(*) FROM public.memory_shared_anchor_members) = 0, 'T14 nothing is left');
END $$;
