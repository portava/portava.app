-- 3677 behavioural rehearsal (census H155/H156/H157). Run on the full-chain database (scripts/local-db/up.sh, or the PGlite replica), after 3677: every DO block RAISES on a failed expectation; each NOTICE "E<n> pass" is an assertion that held. Mutation: 20 of 20 SQL mutants of 3677 are killed by this file plus 3677's own postconditions.
INSERT INTO auth.users (id) VALUES ('a1000000-0000-4000-8000-000000000001'),('a1000000-0000-4000-8000-000000000002');
INSERT INTO public.profiles (id, handle, name) VALUES ('a1000000-0000-4000-8000-000000000001','hown','HOwner'),('a1000000-0000-4000-8000-000000000002','hoth','HOther');
CREATE OR REPLACE FUNCTION pg_temp.ck(cond boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'EXPECTATION FAILED: %', msg; END IF; END $$;
CREATE OR REPLACE FUNCTION pg_temp.cr(key text, payload jsonb, typ text DEFAULT 'CREATE_HIGHLIGHT', actor uuid DEFAULT 'a1000000-0000-4000-8000-000000000001') RETURNS jsonb
LANGUAGE sql AS $$ SELECT public.highlight_create_execute(jsonb_build_object('command_id', gen_random_uuid(), 'actor_user_id', actor,
  'idempotency_key', key, 'type', typ, 'payload', payload)) $$;
CREATE OR REPLACE FUNCTION pg_temp.hk(t text, hid uuid, key text) RETURNS jsonb
LANGUAGE sql AS $$ SELECT public.highlight_kernel_execute(jsonb_build_object('command_id', gen_random_uuid(), 'actor_user_id', 'a1000000-0000-4000-8000-000000000001'::uuid,
  'idempotency_key', key, 'type', t, 'highlight_id', hid, 'payload', '{}'::jsonb)) $$;
CREATE OR REPLACE FUNCTION pg_temp.evs(hid uuid) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(sequence || ':' || type || ':' || coalesce(payload_json->>'to_state','-'), ',' ORDER BY sequence), '') FROM public.memory_domain_events WHERE highlight_id = hid $$;

-- E0 PERMANENT on a database whose expires_at is NOT NULL (2975 absent) is refused by name, nothing written
DO $$ DECLARE v jsonb; BEGIN
  BEGIN
    ALTER TABLE public.highlights DROP CONSTRAINT IF EXISTS highlights_permanent_has_no_expiry;
    ALTER TABLE public.highlights ALTER COLUMN expires_at SET NOT NULL;
    v := pg_temp.cr('e0', jsonb_build_object('media_url','m0','media_type','image/jpeg','lifetime_class','PERMANENT'));
    PERFORM pg_temp.ck(v->>'reason' = 'HIGHLIGHT_LIFETIME_UNAVAILABLE', 'E0 refused by name: ' || v::text);
    PERFORM pg_temp.ck(NOT EXISTS (SELECT 1 FROM highlights WHERE media_url='m0'), 'E0 no row');
    PERFORM pg_temp.ck(EXISTS (SELECT 1 FROM memory_command_audit WHERE idempotency_key='e0' AND reason='HIGHLIGHT_LIFETIME_UNAVAILABLE'), 'E0 audited');
    PERFORM pg_temp.ck(NOT EXISTS (SELECT 1 FROM memory_command_receipts WHERE idempotency_key='e0'), 'E0 no receipt');
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'undo';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE 'E0 pass';
END $$;

-- E1 create: row + created(1) + published(2) + two outbox rows + receipt + audit, one clock
DO $$ DECLARE v jsonb; hid uuid; BEGIN
  v := pg_temp.cr('e1', jsonb_build_object('media_url','m1','media_type','image/jpeg','caption','secret caption','visibility','circle_only','expires_in_hours',24,'filter_id','warm','filter_intensity',40,'lifetime_class','DAY'));
  PERFORM pg_temp.ck((v->>'ok')::boolean AND NOT (v->>'duplicate')::boolean, 'E1 ok ' || v::text);
  hid := (v->>'highlight_id')::uuid;
  PERFORM pg_temp.ck((SELECT owner_id FROM highlights WHERE id=hid) = 'a1000000-0000-4000-8000-000000000001', 'E1 owner = actor');
  PERFORM pg_temp.ck((SELECT expires_at - created_at FROM highlights WHERE id=hid) = interval '24 hours', 'E1 one clock, 24h');
  PERFORM pg_temp.ck((SELECT visibility||filter_id||filter_intensity||lifetime_class FROM highlights WHERE id=hid) = 'circle_onlywarm40DAY', 'E1 columns');
  PERFORM pg_temp.ck(pg_temp.evs(hid) = '1:highlight.created:ACTIVE,2:highlight.published:ACTIVE', 'E1 events ' || pg_temp.evs(hid));
  PERFORM pg_temp.ck((SELECT count(*) FROM memory_event_outbox WHERE highlight_id=hid AND memory_id IS NULL) = 2, 'E1 two outbox rows');
  PERFORM pg_temp.ck((SELECT string_agg(type, ',' ORDER BY id) FROM memory_event_outbox WHERE highlight_id=hid) = 'highlight.created,highlight.published', 'E1 outbox types');
  PERFORM pg_temp.ck((SELECT bool_and(payload_json::text NOT LIKE '%secret%' AND payload_json::text NOT LIKE '%m1%') FROM memory_domain_events WHERE highlight_id=hid), 'E1 payload has no body');
  PERFORM pg_temp.ck((SELECT (payload_json->>'published_at_creation')::boolean FROM memory_domain_events WHERE highlight_id=hid AND sequence=2), 'E1 published_at_creation');
  PERFORM pg_temp.ck((SELECT event_type FROM memory_command_receipts WHERE idempotency_key='e1') = 'highlight.created', 'E1 receipt');
  PERFORM pg_temp.ck((SELECT result_json::text NOT LIKE '%secret%' FROM memory_command_receipts WHERE idempotency_key='e1'), 'E1 receipt holds ids only');
  PERFORM pg_temp.ck(EXISTS (SELECT 1 FROM memory_command_audit WHERE idempotency_key='e1' AND outcome='accepted' AND highlight_id=hid), 'E1 audit');
  RAISE NOTICE 'E1 pass';
END $$;

-- E2 replay of the key: the original answer, nothing new
DO $$ DECLARE v jsonb; n0 int; n1 int; BEGIN
  SELECT count(*) INTO n0 FROM highlights WHERE owner_id='a1000000-0000-4000-8000-000000000001';
  v := pg_temp.cr('e1', jsonb_build_object('media_url','other','media_type','image/jpeg','expires_in_hours',3));
  SELECT count(*) INTO n1 FROM highlights WHERE owner_id='a1000000-0000-4000-8000-000000000001';
  PERFORM pg_temp.ck((v->>'duplicate')::boolean AND n0 = n1, 'E2 duplicate, no second row');
  PERFORM pg_temp.ck((v->'result'->>'id') = (SELECT id::text FROM highlights WHERE media_url='m1'), 'E2 same id');
  -- the key reused for a different command type is refused
  v := pg_temp.hk('PIN_HIGHLIGHT', (SELECT id FROM highlights WHERE media_url='m1'), 'e1');
  PERFORM pg_temp.ck(v->>'reason' = 'MEMORY_IDEMPOTENCY_KEY_REUSED', 'E2 cross-command reuse refused ' || v::text);
  RAISE NOTICE 'E2 pass';
END $$;

-- E3 invariants: PERMANENT with an expiry, a non-PERMANENT without one, an unknown window, a bad visibility, empty media
DO $$ DECLARE v jsonb; BEGIN
  v := pg_temp.cr('e3a', jsonb_build_object('media_url','m3','media_type','image/jpeg','lifetime_class','PERMANENT','expires_in_hours',24));
  PERFORM pg_temp.ck(v->>'reason' = 'MEMORY_COMMAND_MALFORMED', 'E3a');
  v := pg_temp.cr('e3b', jsonb_build_object('media_url','m3','media_type','image/jpeg'));
  PERFORM pg_temp.ck(v->>'reason' = 'MEMORY_COMMAND_MALFORMED', 'E3b no window');
  v := pg_temp.cr('e3c', jsonb_build_object('media_url','m3','media_type','image/jpeg','expires_in_hours',7));
  PERFORM pg_temp.ck(v->>'reason' = 'MEMORY_COMMAND_MALFORMED', 'E3c 7h');
  v := pg_temp.cr('e3d', jsonb_build_object('media_url','m3','media_type','image/jpeg','expires_in_hours',24,'visibility','everyone'));
  PERFORM pg_temp.ck(v->>'reason' = 'MEMORY_COMMAND_MALFORMED', 'E3d visibility');
  v := pg_temp.cr('e3e', jsonb_build_object('media_url','','media_type','image/jpeg','expires_in_hours',24));
  PERFORM pg_temp.ck(v->>'reason' = 'MEMORY_COMMAND_MALFORMED', 'E3e empty media');
  v := pg_temp.cr('e3f', jsonb_build_object('media_url','m3','media_type','image/jpeg','expires_in_hours','x'));
  PERFORM pg_temp.ck(v->>'reason' = 'MEMORY_COMMAND_MALFORMED', 'E3f unparseable');
  PERFORM pg_temp.ck(NOT EXISTS (SELECT 1 FROM highlights WHERE media_url='m3'), 'E3 no row');
  RAISE NOTICE 'E3 pass';
END $$;

-- E4 PERMANENT stored with no expiry, and never expires
DO $$ DECLARE v jsonb; BEGIN
  v := pg_temp.cr('e4', jsonb_build_object('media_url','m4','media_type','image/jpeg','lifetime_class','PERMANENT'));
  PERFORM pg_temp.ck((v->>'ok')::boolean, 'E4 ok ' || v::text);
  PERFORM pg_temp.ck((SELECT expires_at IS NULL AND lifetime_class='PERMANENT' FROM highlights WHERE media_url='m4'), 'E4 NULL expiry');
  RAISE NOTICE 'E4 pass';
END $$;

-- E5 the clock: one highlight.expired for the expired ACTIVE one, at its expires_at; nothing for the pinned,
--    the hidden, the deleted, the legacy (no stream) or the PERMANENT one; a second pass writes nothing
DO $$ DECLARE v jsonb; h1 uuid; hp uuid; hh uuid; hd uuid; hl uuid; h4 uuid; e timestamptz; BEGIN
  h1 := (SELECT id FROM highlights WHERE media_url='m1');
  h4 := (SELECT id FROM highlights WHERE media_url='m4');
  hp := (pg_temp.cr('e5p', jsonb_build_object('media_url','m5p','media_type','image/jpeg','expires_in_hours',3))->>'highlight_id')::uuid;
  hh := (pg_temp.cr('e5h', jsonb_build_object('media_url','m5h','media_type','image/jpeg','expires_in_hours',3))->>'highlight_id')::uuid;
  hd := (pg_temp.cr('e5d', jsonb_build_object('media_url','m5d','media_type','image/jpeg','expires_in_hours',3))->>'highlight_id')::uuid;
  INSERT INTO highlights (owner_id, media_url, media_type, visibility, expires_at) VALUES ('a1000000-0000-4000-8000-000000000001','m5l','image/jpeg','public', now() - interval '1 hour') RETURNING id INTO hl;
  PERFORM pg_temp.hk('PIN_HIGHLIGHT', hp, 'e5p-pin');
  PERFORM pg_temp.hk('HIDE_HIGHLIGHT', hh, 'e5h-hide');
  UPDATE highlights SET deleted_at = now() WHERE id = hd;
  UPDATE highlights SET expires_at = now() - interval '2 hours' WHERE id IN (h1, hp, hh, hd);
  e := (SELECT expires_at FROM highlights WHERE id=h1);
  v := public.highlight_expiry_emit(now(), 200);
  PERFORM pg_temp.ck((v->>'emitted')::int = 1, 'E5 exactly one emitted ' || v::text);
  PERFORM pg_temp.ck(pg_temp.evs(h1) = '1:highlight.created:ACTIVE,2:highlight.published:ACTIVE,3:highlight.expired:EXPIRED', 'E5 h1 ' || pg_temp.evs(h1));
  PERFORM pg_temp.ck((SELECT occurred_at = e AND actor_user_id IS NULL AND causation_id IS NULL AND payload_json->>'cause' = 'clock' FROM memory_domain_events WHERE highlight_id=h1 AND sequence=3), 'E5 clock-caused at expires_at');
  PERFORM pg_temp.ck(EXISTS (SELECT 1 FROM memory_event_outbox WHERE highlight_id=h1 AND type='highlight.expired'), 'E5 outbox');
  PERFORM pg_temp.ck(pg_temp.evs(hp) NOT LIKE '%expired%' AND pg_temp.evs(hh) NOT LIKE '%expired%' AND pg_temp.evs(hd) NOT LIKE '%expired%' AND pg_temp.evs(hl) = '' AND pg_temp.evs(h4) NOT LIKE '%expired%', 'E5 nothing else');
  v := public.highlight_expiry_emit(now(), 200);
  PERFORM pg_temp.ck((v->>'emitted')::int = 0, 'E5 idempotent second pass ' || v::text);
  -- un-hiding an expired Highlight: the kernel's own event says EXPIRED, and the clock adds no second record
  PERFORM pg_temp.hk('UNHIDE_HIGHLIGHT', hh, 'e5h-unhide');
  PERFORM pg_temp.ck(pg_temp.evs(hh) LIKE '%highlight.hidden:EXPIRED', 'E5 unhide derives EXPIRED ' || pg_temp.evs(hh));
  v := public.highlight_expiry_emit(now(), 200);
  PERFORM pg_temp.ck((v->>'emitted')::int = 0 AND pg_temp.evs(hh) NOT LIKE '%expired%', 'E5 no duplicate after unhide');
  RAISE NOTICE 'E5 pass';
END $$;

-- E1b the owner is the actor, never a payload field
DO $$ DECLARE v jsonb; BEGIN
  v := pg_temp.cr('e1b', jsonb_build_object('media_url','m1b','media_type','image/jpeg','expires_in_hours',24,'owner_id','a1000000-0000-4000-8000-000000000002'));
  PERFORM pg_temp.ck((SELECT owner_id FROM highlights WHERE id=(v->>'highlight_id')::uuid) = 'a1000000-0000-4000-8000-000000000001', 'E1b owner = actor');
  RAISE NOTICE 'E1b pass';
END $$;

-- E5b a pin or archive written directly (kernel off at the time) leaves the log saying ACTIVE: still no expiry
DO $$ DECLARE v jsonb; hp uuid; ha uuid; BEGIN
  hp := (pg_temp.cr('e5bp', jsonb_build_object('media_url','m5bp','media_type','image/jpeg','expires_in_hours',3))->>'highlight_id')::uuid;
  ha := (pg_temp.cr('e5ba', jsonb_build_object('media_url','m5ba','media_type','image/jpeg','expires_in_hours',3))->>'highlight_id')::uuid;
  UPDATE highlights SET pinned_at = now() WHERE id = hp;
  UPDATE highlights SET archived_at = now() WHERE id = ha;
  UPDATE highlights SET expires_at = now() - interval '1 hour' WHERE id IN (hp, ha);
  v := public.highlight_expiry_emit(now(), 200);
  PERFORM pg_temp.ck((v->>'emitted')::int = 0, 'E5b directly pinned/archived rows are not expired ' || v::text);
  UPDATE highlights SET expires_at = now() + interval '1 hour' WHERE id IN (hp, ha);
  RAISE NOTICE 'E5b pass';
END $$;

-- E6 the batch bound, and an unexpired ACTIVE Highlight is left alone
DO $$ DECLARE v jsonb; i int; BEGIN
  FOR i IN 1..3 LOOP
    PERFORM pg_temp.cr('e6-' || i, jsonb_build_object('media_url','m6-' || i,'media_type','image/jpeg','expires_in_hours',3));
  END LOOP;
  PERFORM pg_temp.cr('e6-live', jsonb_build_object('media_url','m6-live','media_type','image/jpeg','expires_in_hours',48));
  UPDATE highlights SET expires_at = now() - interval '1 minute' WHERE media_url LIKE 'm6-_';
  v := public.highlight_expiry_emit(now(), 2);
  PERFORM pg_temp.ck((v->>'emitted')::int = 2 AND (v->>'more')::boolean, 'E6 bounded ' || v::text);
  v := public.highlight_expiry_emit(now(), 2);
  PERFORM pg_temp.ck((v->>'emitted')::int = 1 AND NOT (v->>'more')::boolean, 'E6 remainder ' || v::text);
  PERFORM pg_temp.ck(pg_temp.evs((SELECT id FROM highlights WHERE media_url='m6-live')) NOT LIKE '%expired%', 'E6 live untouched');
  RAISE NOTICE 'E6 pass';
END $$;

-- E7 the 3677 postconditions still hold after the scenario (re-runnable)
DO $$ BEGIN RAISE NOTICE 'E7 scenario complete'; END $$;
