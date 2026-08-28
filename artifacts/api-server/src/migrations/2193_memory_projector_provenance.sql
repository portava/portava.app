-- 2193_memory_projector_provenance.sql
--
-- Memory — the projector populates provenance and visibility.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- 2192 added `source_event_ids` and `visibility` to memory_projections. Columns
-- without a writer are worse than no columns: they look like a control while
-- answering nothing. This makes the projector fill them.
--
--  * source_event_ids (§16) — each projection now names the memory_events rows
--    that support it, so "what source event(s) produced this memory?" resolves to
--    actual ids rather than a derivation string. Populated by matching the events
--    the same pass wrote for the same (user, subject).
--
--  * visibility (§19) — set EXPLICITLY per class rather than left to the column
--    default, so the inherit-or-narrow rule is a decision in the code and not an
--    accident of DDL. Every class is 'private': derived memory is an INFERENCE
--    about a user, and an inference is not as public as the fact it came from —
--    a public follow does not make "Portava thinks you know Ana" public. Narrower
--    than the source in every case, which is the direction §19 permits.
--
-- MUST BE APPLIED AFTER 2192.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='memory_projections' AND column_name='source_event_ids') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2192 first.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.project_user_memory(
  p_user_id uuid, p_enforce_flag boolean DEFAULT true
)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_enabled boolean; v_uid_text text := p_user_id::text; v_total integer := 0; v_sub integer;
  v_now timestamptz := clock_timestamp(); v_pref_ttl interval := interval '180 days';
BEGIN
  IF p_enforce_flag THEN
    SELECT enabled INTO v_enabled FROM public.feature_flags WHERE flag='memory_projection';
    IF v_enabled IS DISTINCT FROM true THEN RETURN 0; END IF;
  END IF;

  -- ── EPISODIC ───────────────────────────────────────────────────────────────
  INSERT INTO public.memory_events (user_id, event_type, occurred_at, subject_type, subject_id, source, visibility, source_ref, metadata)
  SELECT p_user_id, 'visited', coalesce(max(e.last_seen), min(e.first_seen), v_now), 'city', initcap(lower(e.dst_key)), 'inferred', 'private',
         jsonb_build_object('table','compass_graph_edges'), jsonb_build_object('returned', bool_or(e.edge_type='returned_to'))
  FROM public.compass_graph_edges e
  WHERE e.src_type='person' AND e.src_key=v_uid_text AND e.dst_type='city'
    AND e.edge_type IN ('visited','returned_to') AND e.dst_key IS NOT NULL AND btrim(e.dst_key) <> ''
  GROUP BY lower(e.dst_key), initcap(lower(e.dst_key))
  ON CONFLICT (user_id, event_type, subject_type, subject_id, occurred_at) DO NOTHING;

  WITH ev AS (
    SELECT initcap(lower(e.dst_key)) AS city, sum(coalesce(e.observed_count,1)) AS obs,
           bool_or(e.edge_type='returned_to') AS returned,
           coalesce(max(e.last_seen), min(e.first_seen), v_now) AS occurred_at
    FROM public.compass_graph_edges e
    WHERE e.src_type='person' AND e.src_key=v_uid_text AND e.dst_type='city'
      AND e.edge_type IN ('visited','returned_to') AND e.dst_key IS NOT NULL AND btrim(e.dst_key) <> ''
    GROUP BY lower(e.dst_key), initcap(lower(e.dst_key))
  ), ins AS (
    INSERT INTO public.memory_projections
      (user_id,memory_type,subject_type,subject_id,content,confidence,provenance,retention_class,
       last_supported_at,valid_from,last_projected_at,visibility,source_event_ids)
    SELECT p_user_id,'episodic','city',ev.city,
           'Visited '||ev.city||CASE WHEN ev.returned THEN ' (has returned)' ELSE '' END,
           least(0.95,0.60+0.08*ev.obs+CASE WHEN ev.returned THEN 0.05 ELSE 0 END)::real,
           jsonb_build_object('derivation','compass_graph_edges:visited','support',jsonb_build_object('observations',ev.obs,'returned',ev.returned)),
           'durable_fact', ev.occurred_at, ev.occurred_at, v_now, 'private',
           coalesce((SELECT array_agg(me.id) FROM public.memory_events me
                     WHERE me.user_id=p_user_id AND me.subject_type='city' AND me.subject_id=ev.city), '{}'::uuid[])
    FROM ev
    ON CONFLICT (user_id,memory_type,subject_type,subject_id) DO UPDATE SET
      confidence=EXCLUDED.confidence, content=EXCLUDED.content, provenance=EXCLUDED.provenance,
      last_supported_at=GREATEST(public.memory_projections.last_supported_at, EXCLUDED.last_supported_at),
      last_projected_at=EXCLUDED.last_projected_at,
      source_event_ids=EXCLUDED.source_event_ids,
      visibility=EXCLUDED.visibility,
      state=CASE WHEN public.memory_projections.state='retracted' THEN 'active' ELSE public.memory_projections.state END
    RETURNING 1) SELECT count(*) INTO v_sub FROM ins;
  v_total := v_total + v_sub;

  -- ── SEMANTIC ───────────────────────────────────────────────────────────────
  WITH prefs AS (
    SELECT unnest(coalesce(cup.interests,'{}'::text[])) AS val,'interest'::text AS styp FROM public.compass_user_preferences cup WHERE cup.user_id=p_user_id
    UNION ALL SELECT unnest(coalesce(cup.travel_styles,'{}'::text[])),'travel_style' FROM public.compass_user_preferences cup WHERE cup.user_id=p_user_id
  ), ins AS (
    INSERT INTO public.memory_projections
      (user_id,memory_type,subject_type,subject_id,content,confidence,provenance,retention_class,
       last_supported_at,valid_to,last_projected_at,visibility)
    SELECT p_user_id,'semantic',prefs.styp,prefs.val,
           CASE prefs.styp WHEN 'interest' THEN 'Interested in ' ELSE 'Travel style: ' END||prefs.val, 0.90::real,
           jsonb_build_object('derivation','compass_user_preferences','support',jsonb_build_object('field',prefs.styp)),
           'derived_preference', v_now, v_now + v_pref_ttl, v_now, 'private'
    FROM prefs WHERE prefs.val IS NOT NULL AND btrim(prefs.val) <> ''
    ON CONFLICT (user_id,memory_type,subject_type,subject_id) DO UPDATE SET
      confidence=EXCLUDED.confidence, content=EXCLUDED.content, provenance=EXCLUDED.provenance,
      last_supported_at=EXCLUDED.last_supported_at, valid_to=EXCLUDED.valid_to,
      last_projected_at=EXCLUDED.last_projected_at, visibility=EXCLUDED.visibility,
      state=CASE WHEN public.memory_projections.state IN ('retracted','decayed') THEN 'active' ELSE public.memory_projections.state END
    RETURNING 1) SELECT count(*) INTO v_sub FROM ins;
  v_total := v_total + v_sub;

  -- ── SOCIAL (blocked pairs excluded; sensitive; private) ────────────────────
  INSERT INTO public.memory_events (user_id,event_type,occurred_at,subject_type,subject_id,source,visibility,source_ref)
  SELECT p_user_id,'followed',uf.created_at,'user',uf.following_id::text,'explicit','private',jsonb_build_object('table','user_follows')
  FROM public.user_follows uf
  WHERE uf.follower_id=p_user_id
    AND NOT EXISTS (SELECT 1 FROM public.blocks b WHERE (b.blocker_id=p_user_id AND b.blocked_id=uf.following_id) OR (b.blocker_id=uf.following_id AND b.blocked_id=p_user_id))
  ON CONFLICT (user_id,event_type,subject_type,subject_id,occurred_at) DO NOTHING;

  WITH f AS (
    SELECT uf.following_id, uf.created_at, coalesce(nullif(btrim(pr.name),''),nullif(btrim(pr.handle),''),'a traveler') AS who
    FROM public.user_follows uf LEFT JOIN public.profiles pr ON pr.id=uf.following_id
    WHERE uf.follower_id=p_user_id
      AND NOT EXISTS (SELECT 1 FROM public.blocks b WHERE (b.blocker_id=p_user_id AND b.blocked_id=uf.following_id) OR (b.blocker_id=uf.following_id AND b.blocked_id=p_user_id))
  ), ins AS (
    INSERT INTO public.memory_projections
      (user_id,memory_type,subject_type,subject_id,content,confidence,sensitivity,provenance,retention_class,
       last_supported_at,valid_from,last_projected_at,visibility,source_event_ids)
    SELECT p_user_id,'social','user',f.following_id::text,'Follows '||f.who,0.85::real,'sensitive',
           jsonb_build_object('derivation','user_follows','support',jsonb_build_object('followed_at',f.created_at)),
           'durable_fact', f.created_at, f.created_at, v_now, 'private',
           coalesce((SELECT array_agg(me.id) FROM public.memory_events me
                     WHERE me.user_id=p_user_id AND me.subject_type='user' AND me.subject_id=f.following_id::text), '{}'::uuid[])
    FROM f
    ON CONFLICT (user_id,memory_type,subject_type,subject_id) DO UPDATE SET
      content=EXCLUDED.content, provenance=EXCLUDED.provenance,
      last_supported_at=GREATEST(public.memory_projections.last_supported_at, EXCLUDED.last_supported_at),
      last_projected_at=EXCLUDED.last_projected_at, source_event_ids=EXCLUDED.source_event_ids,
      visibility=EXCLUDED.visibility,
      state=CASE WHEN public.memory_projections.state='retracted' THEN 'active' ELSE public.memory_projections.state END
    RETURNING 1) SELECT count(*) INTO v_sub FROM ins;
  v_total := v_total + v_sub;

  -- ── PLACE ──────────────────────────────────────────────────────────────────
  INSERT INTO public.memory_events (user_id,event_type,occurred_at,subject_type,subject_id,source,visibility,source_ref)
  SELECT p_user_id,'saved_place',sp.saved_at,'place',sp.place_id::text,'explicit','private',jsonb_build_object('table','saved_places')
  FROM public.saved_places sp WHERE sp.user_id=p_user_id
  ON CONFLICT (user_id,event_type,subject_type,subject_id,occurred_at) DO NOTHING;

  WITH sp AS (
    SELECT s.place_id,s.saved_at,coalesce(nullif(btrim(dp.name),''),'a place') AS place_name,nullif(btrim(dp.city),'') AS place_city
    FROM public.saved_places s LEFT JOIN public.discovery_places dp ON dp.id=s.place_id WHERE s.user_id=p_user_id
  ), ins AS (
    INSERT INTO public.memory_projections
      (user_id,memory_type,subject_type,subject_id,content,confidence,provenance,retention_class,
       last_supported_at,valid_from,last_projected_at,visibility,source_event_ids)
    SELECT p_user_id,'place','place',sp.place_id::text,
           'Saved '||sp.place_name||coalesce(' in '||sp.place_city,''),0.90::real,
           jsonb_build_object('derivation','saved_places','support',jsonb_build_object('saved_at',sp.saved_at)),
           'durable_fact', sp.saved_at, sp.saved_at, v_now, 'private',
           coalesce((SELECT array_agg(me.id) FROM public.memory_events me
                     WHERE me.user_id=p_user_id AND me.subject_type='place' AND me.subject_id=sp.place_id::text), '{}'::uuid[])
    FROM sp
    ON CONFLICT (user_id,memory_type,subject_type,subject_id) DO UPDATE SET
      content=EXCLUDED.content, provenance=EXCLUDED.provenance,
      last_supported_at=GREATEST(public.memory_projections.last_supported_at, EXCLUDED.last_supported_at),
      last_projected_at=EXCLUDED.last_projected_at, source_event_ids=EXCLUDED.source_event_ids,
      visibility=EXCLUDED.visibility,
      state=CASE WHEN public.memory_projections.state='retracted' THEN 'active' ELSE public.memory_projections.state END
    RETURNING 1) SELECT count(*) INTO v_sub FROM ins;
  v_total := v_total + v_sub;

  RETURN v_total;
END
$fn$;

REVOKE ALL ON FUNCTION public.project_user_memory(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.project_user_memory(uuid, boolean) TO service_role;

DO $$
BEGIN
  IF (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='project_user_memory') NOT LIKE '%source_event_ids%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: projector does not populate source_event_ids';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND (p.proname LIKE 'memory\_%' OR p.proname LIKE 'project\_%memory%')
      AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE'))) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a memory/projector function is anon/authenticated executable';
  END IF;
END $$;

COMMIT;

-- REVERSAL: re-apply 2191's project_user_memory body.
