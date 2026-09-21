-- 2963_memory_projector_place_lane_union.sql
-- Repoint the memory projector's PLACE lane at the tables saves actually land in.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2963.
-- Idempotent: CREATE OR REPLACE FUNCTION only. No table created, altered or
-- dropped; no row written; no flag flipped. Re-running is a no-op.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY (census-map M42, and M123 downstream of it)
-- ══════════════════════════════════════════════════════════════════════════════
-- The PLACE lane read a table with ZERO writers: no INSERT, no upsert, no RPC,
-- no trigger, in server TS, client TS or SQL. Every save a user has ever made
-- went to one of two OTHER tables. So the lane produced nothing, forever, while
-- the projector reported success with `collected: 0` — an empty table and an
-- empty result being the same observation.
--
-- That one writerless table explains two dead surfaces: the Map `saved` layer
-- (fixed in TypeScript by PR #446) and the Map `memory` layer, which filters on
-- subject_type='place' and has therefore never had an eligible subject.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THIS FILE AND NOT PR #451
-- ══════════════════════════════════════════════════════════════════════════════
-- PR #451 diagnosed this correctly and its union SQL is right. Its DELIVERY had
-- three defects, each verified against portava-ci before this file was written:
--
--   1. SIGNATURE. It declares `project_user_memory(p_user_id uuid)`. The live
--      function is `project_user_memory(p_user_id uuid, p_enforce_flag boolean
--      DEFAULT true)`. PostgreSQL overloads on the argument list, so CREATE OR
--      REPLACE with one argument ADDS a function rather than replacing one. The
--      only caller, project_user_memory_with_retraction, passes two arguments
--      and would still reach the old body. M42 would stay broken while the
--      migration reported success.
--   2. LANES. Its body is PLACE-only. The live function carries FOUR lanes.
--      Correcting the signature without restoring the other three turns a
--      no-op into a silent deletion of episodic, semantic and social memory.
--   3. VOLATILITY/PRIVILEGE. It declares SECURITY DEFINER. The live function is
--      SECURITY INVOKER — `pg_get_functiondef` prints no SECURITY DEFINER for
--      it. Switching a function that reads user data to DEFINER is a privilege
--      change, and is not part of fixing a writerless read.
--
-- THIS FILE takes the live body verbatim and changes ONLY the PLACE lane. The
-- signature, the flag gate, the search_path, the INVOKER privilege, and the
-- episodic / semantic / social lanes are byte-identical to what is live.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE CANONICAL SOURCE, AND WHY IT IS A UNION
-- ══════════════════════════════════════════════════════════════════════════════
--   public.wishlist_places        routes/wishlist.ts POST /api/wishlist — every
--                                 TripWishlistPicker save, including the Map's
--                                 own long-press save.
--   public.discovery_place_saves  routes/discovery.ts POST
--                                 /api/discovery/community/:id/save — the
--                                 DiscoveryWall bookmark. Writes nothing to the
--                                 other table.
-- Neither is a superset, so reading either alone silently under-counts.
--
-- SUBJECT IDENTITY IS PRESERVED. The lane has always written subject_id as a
-- discovery_places.id cast to text, so that IS the memory subject space and it
-- stays. wishlist_places.place_id is TEXT with no FK spanning four id-spaces:
--   'db/<uuid>'              -> discovery_places.id, else .canonical_location_id
--   'node|way|relation/<id>' -> discovery_places.osm_id
--   bare uuid                -> a gem / event / city in an unnamed space. It
--                               bridges to nothing and is DELIBERATELY excluded:
--                               inventing a row would fabricate a place.
--
-- DEDUPE on the resolved venue, not the row: one OSM save writes both tables,
-- and the wishlist table is UNIQUE(user_id, place_id, list_id) so one venue
-- saved to three trips is three rows. occurred_at takes MIN(saved_at) — the
-- FIRST save. A re-save to another list is the same memory, and MAX would let
-- a re-save rewrite history.
--
-- TWO STATEMENTS, NOT ONE. The events insert and the projections insert are
-- kept separate because the projections statement's source_event_ids subquery
-- must SEE the rows the events statement just wrote. Data-modifying CTEs read
-- the pre-statement snapshot, so folding them into one statement would leave
-- source_event_ids empty on a first pass. That is how the live function is
-- shaped and this preserves it.

CREATE OR REPLACE FUNCTION public.project_user_memory(p_user_id uuid, p_enforce_flag boolean DEFAULT true)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_enabled boolean; v_uid_text text := p_user_id::text; v_total integer := 0; v_sub integer;
  v_now timestamptz := clock_timestamp(); v_pref_ttl interval := interval '180 days';
BEGIN
  IF p_enforce_flag THEN
    SELECT enabled INTO v_enabled FROM public.feature_flags WHERE flag='memory_projection';
    IF v_enabled IS DISTINCT FROM true THEN RETURN 0; END IF;
  END IF;

  INSERT INTO public.memory_events (user_id,event_type,occurred_at,subject_type,subject_id,source,visibility,source_ref,metadata)
  SELECT p_user_id,'visited',coalesce(max(e.last_seen),min(e.first_seen),v_now),'city',initcap(lower(e.dst_key)),'inferred','private',
         jsonb_build_object('table','compass_graph_edges'),jsonb_build_object('returned',bool_or(e.edge_type='returned_to'))
  FROM public.compass_graph_edges e
  WHERE e.src_type='person' AND e.src_key=v_uid_text AND e.dst_type='city'
    AND e.edge_type IN ('visited','returned_to') AND e.dst_key IS NOT NULL AND btrim(e.dst_key)<>''
  GROUP BY lower(e.dst_key), initcap(lower(e.dst_key))
  ON CONFLICT (user_id,event_type,subject_type,subject_id,occurred_at) DO NOTHING;

  WITH ev AS (
    SELECT initcap(lower(e.dst_key)) AS city, sum(coalesce(e.observed_count,1)) AS obs,
           bool_or(e.edge_type='returned_to') AS returned,
           coalesce(max(e.last_seen),min(e.first_seen),v_now) AS occurred_at
    FROM public.compass_graph_edges e
    WHERE e.src_type='person' AND e.src_key=v_uid_text AND e.dst_type='city'
      AND e.edge_type IN ('visited','returned_to') AND e.dst_key IS NOT NULL AND btrim(e.dst_key)<>''
    GROUP BY lower(e.dst_key), initcap(lower(e.dst_key))
  ), ins AS (
    INSERT INTO public.memory_projections (user_id,memory_type,subject_type,subject_id,content,confidence,provenance,retention_class,last_supported_at,valid_from,last_projected_at,visibility,source_event_ids)
    SELECT p_user_id,'episodic','city',ev.city,'Visited '||ev.city||CASE WHEN ev.returned THEN ' (has returned)' ELSE '' END,
           least(0.95,0.60+0.08*ev.obs+CASE WHEN ev.returned THEN 0.05 ELSE 0 END)::real,
           jsonb_build_object('derivation','compass_graph_edges:visited','support',jsonb_build_object('observations',ev.obs,'returned',ev.returned)),
           'durable_fact',ev.occurred_at,ev.occurred_at,v_now,'private',
           coalesce((SELECT array_agg(me.id) FROM public.memory_events me WHERE me.user_id=p_user_id AND me.subject_type='city' AND me.subject_id=ev.city),'{}'::uuid[])
    FROM ev
    ON CONFLICT (user_id,memory_type,subject_type,subject_id) DO UPDATE SET
      confidence=EXCLUDED.confidence,content=EXCLUDED.content,provenance=EXCLUDED.provenance,
      last_supported_at=GREATEST(public.memory_projections.last_supported_at,EXCLUDED.last_supported_at),
      last_projected_at=EXCLUDED.last_projected_at,source_event_ids=EXCLUDED.source_event_ids,visibility=EXCLUDED.visibility,
      state=CASE WHEN public.memory_projections.state='retracted' THEN 'active' ELSE public.memory_projections.state END
    RETURNING 1) SELECT count(*) INTO v_sub FROM ins; v_total:=v_total+v_sub;

  WITH prefs AS (
    SELECT unnest(coalesce(cup.interests,'{}'::text[])) AS val,'interest'::text AS styp FROM public.compass_user_preferences cup WHERE cup.user_id=p_user_id
    UNION ALL SELECT unnest(coalesce(cup.travel_styles,'{}'::text[])),'travel_style' FROM public.compass_user_preferences cup WHERE cup.user_id=p_user_id
  ), ins AS (
    INSERT INTO public.memory_projections (user_id,memory_type,subject_type,subject_id,content,confidence,provenance,retention_class,last_supported_at,valid_to,last_projected_at,visibility)
    SELECT p_user_id,'semantic',prefs.styp,prefs.val,CASE prefs.styp WHEN 'interest' THEN 'Interested in ' ELSE 'Travel style: ' END||prefs.val,0.90::real,
           jsonb_build_object('derivation','compass_user_preferences','support',jsonb_build_object('field',prefs.styp)),
           'derived_preference',v_now,v_now+v_pref_ttl,v_now,'private'
    FROM prefs WHERE prefs.val IS NOT NULL AND btrim(prefs.val)<>''
    ON CONFLICT (user_id,memory_type,subject_type,subject_id) DO UPDATE SET
      confidence=EXCLUDED.confidence,content=EXCLUDED.content,provenance=EXCLUDED.provenance,
      last_supported_at=EXCLUDED.last_supported_at,valid_to=EXCLUDED.valid_to,
      last_projected_at=EXCLUDED.last_projected_at,visibility=EXCLUDED.visibility,
      state=CASE WHEN public.memory_projections.state IN ('retracted','decayed') THEN 'active' ELSE public.memory_projections.state END
    RETURNING 1) SELECT count(*) INTO v_sub FROM ins; v_total:=v_total+v_sub;

  INSERT INTO public.memory_events (user_id,event_type,occurred_at,subject_type,subject_id,source,visibility,source_ref)
  SELECT p_user_id,'followed',uf.created_at,'user',uf.following_id::text,'explicit','private',jsonb_build_object('table','user_follows')
  FROM public.user_follows uf WHERE uf.follower_id=p_user_id
    AND NOT EXISTS (SELECT 1 FROM public.blocks b WHERE (b.blocker_id=p_user_id AND b.blocked_id=uf.following_id) OR (b.blocker_id=uf.following_id AND b.blocked_id=p_user_id))
  ON CONFLICT (user_id,event_type,subject_type,subject_id,occurred_at) DO NOTHING;

  WITH f AS (
    SELECT uf.following_id,uf.created_at,coalesce(nullif(btrim(pr.name),''),nullif(btrim(pr.handle),''),'a traveler') AS who
    FROM public.user_follows uf LEFT JOIN public.profiles pr ON pr.id=uf.following_id
    WHERE uf.follower_id=p_user_id
      AND NOT EXISTS (SELECT 1 FROM public.blocks b WHERE (b.blocker_id=p_user_id AND b.blocked_id=uf.following_id) OR (b.blocker_id=uf.following_id AND b.blocked_id=p_user_id))
  ), ins AS (
    INSERT INTO public.memory_projections (user_id,memory_type,subject_type,subject_id,content,confidence,sensitivity,provenance,retention_class,last_supported_at,valid_from,last_projected_at,visibility,source_event_ids)
    SELECT p_user_id,'social','user',f.following_id::text,'Follows '||f.who,0.85::real,'sensitive',
           jsonb_build_object('derivation','user_follows','support',jsonb_build_object('followed_at',f.created_at)),
           'durable_fact',f.created_at,f.created_at,v_now,'private',
           coalesce((SELECT array_agg(me.id) FROM public.memory_events me WHERE me.user_id=p_user_id AND me.subject_type='user' AND me.subject_id=f.following_id::text),'{}'::uuid[])
    FROM f
    ON CONFLICT (user_id,memory_type,subject_type,subject_id) DO UPDATE SET
      content=EXCLUDED.content,provenance=EXCLUDED.provenance,
      last_supported_at=GREATEST(public.memory_projections.last_supported_at,EXCLUDED.last_supported_at),
      last_projected_at=EXCLUDED.last_projected_at,source_event_ids=EXCLUDED.source_event_ids,visibility=EXCLUDED.visibility,
      state=CASE WHEN public.memory_projections.state='retracted' THEN 'active' ELSE public.memory_projections.state END
    RETURNING 1) SELECT count(*) INTO v_sub FROM ins; v_total:=v_total+v_sub;

  CREATE TEMP TABLE IF NOT EXISTS _canon_saves (
    place_id uuid PRIMARY KEY,
    saved_at timestamptz NOT NULL
  ) ON COMMIT DROP;
  DELETE FROM _canon_saves;

  INSERT INTO _canon_saves (place_id, saved_at)
  SELECT resolved_id, MIN(saved_at)
  FROM (
    SELECT dps.place_id AS resolved_id, dps.saved_at
    FROM public.discovery_place_saves dps
    WHERE dps.user_id = p_user_id
    UNION ALL
    SELECT dp.id AS resolved_id, wp.saved_at
    FROM public.wishlist_places wp
    JOIN public.discovery_places dp ON dp.id = substring(wp.place_id from 4)::uuid
    WHERE wp.user_id = p_user_id AND wp.place_id LIKE 'db/%'
      AND substring(wp.place_id from 4) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    UNION ALL
    SELECT dp.id AS resolved_id, wp.saved_at
    FROM public.wishlist_places wp
    JOIN public.discovery_places dp ON dp.canonical_location_id = substring(wp.place_id from 4)::uuid
    WHERE wp.user_id = p_user_id AND wp.place_id LIKE 'db/%'
      AND substring(wp.place_id from 4) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    UNION ALL
    SELECT dp.id AS resolved_id, wp.saved_at
    FROM public.wishlist_places wp
    JOIN public.discovery_places dp ON dp.osm_id = wp.place_id
    WHERE wp.user_id = p_user_id
      AND (wp.place_id LIKE 'node/%' OR wp.place_id LIKE 'way/%' OR wp.place_id LIKE 'relation/%')
  ) AS unioned
  GROUP BY resolved_id;

  INSERT INTO public.memory_events (user_id,event_type,occurred_at,subject_type,subject_id,source,visibility,source_ref)
  SELECT p_user_id,'saved_place',cs.saved_at,'place',cs.place_id::text,'explicit','private',
         jsonb_build_object('table','wishlist_places+discovery_place_saves')
  FROM _canon_saves cs
  ON CONFLICT (user_id,event_type,subject_type,subject_id,occurred_at) DO NOTHING;

  WITH sp AS (
    SELECT cs.place_id,cs.saved_at,coalesce(nullif(btrim(dp.name),''),'a place') AS place_name,nullif(btrim(dp.city),'') AS place_city
    FROM _canon_saves cs LEFT JOIN public.discovery_places dp ON dp.id=cs.place_id
  ), ins AS (
    INSERT INTO public.memory_projections (user_id,memory_type,subject_type,subject_id,content,confidence,provenance,retention_class,last_supported_at,valid_from,last_projected_at,visibility,source_event_ids)
    SELECT p_user_id,'place','place',sp.place_id::text,'Saved '||sp.place_name||coalesce(' in '||sp.place_city,''),0.90::real,
           jsonb_build_object('derivation','wishlist_places+discovery_place_saves','support',jsonb_build_object('saved_at',sp.saved_at)),
           'durable_fact',sp.saved_at,sp.saved_at,v_now,'private',
           coalesce((SELECT array_agg(me.id) FROM public.memory_events me WHERE me.user_id=p_user_id AND me.subject_type='place' AND me.subject_id=sp.place_id::text),'{}'::uuid[])
    FROM sp
    ON CONFLICT (user_id,memory_type,subject_type,subject_id) DO UPDATE SET
      content=EXCLUDED.content,provenance=EXCLUDED.provenance,
      last_supported_at=GREATEST(public.memory_projections.last_supported_at,EXCLUDED.last_supported_at),
      last_projected_at=EXCLUDED.last_projected_at,source_event_ids=EXCLUDED.source_event_ids,visibility=EXCLUDED.visibility,
      state=CASE WHEN public.memory_projections.state='retracted' THEN 'active' ELSE public.memory_projections.state END
    RETURNING 1) SELECT count(*) INTO v_sub FROM ins; v_total:=v_total+v_sub;

  RETURN v_total;
END $function$;

-- ══════════════════════════════════════════════════════════════════════════════
-- POSTCONDITIONS
-- ══════════════════════════════════════════════════════════════════════════════
-- Three things PR #451's block could not do, each of which it needed to:
--
--   * IT NAMES THE SIGNATURE. #451 matched on proname alone and selected INTO a
--     scalar. In plpgsql, SELECT ... INTO over several rows assigns one without
--     raising, so with an accidental overload present the guard can inspect the
--     NEW function and certify a change that never took effect.
--   * IT COUNTS THE OVERLOADS. Exactly one must exist. An overload is the
--     failure mode here, so it fails the apply rather than hiding inside it.
--   * IT STRIPS COMMENTS BEFORE MATCHING. pg_get_functiondef returns comments,
--     so a `LIKE` can be satisfied by prose. #451's own test was bitten by this
--     once, on the token osm_id; this is the same trap one level up.
DO $$
DECLARE
  v_src   text;
  v_code  text;
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'project_user_memory';

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % overloads of project_user_memory exist; exactly 1 is required. An extra overload means a CREATE OR REPLACE declared a different parameter list and did not replace anything.', v_count;
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.oid::regprocedure::text = 'project_user_memory(uuid,boolean)';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: project_user_memory(uuid,boolean) is absent. The live caller passes two arguments; a one-argument function is not it.';
  END IF;

  -- Code only. Prose cannot satisfy anything below.
  v_code := regexp_replace(v_src, '--[^' || chr(10) || ']*', '', 'g');

  IF v_code LIKE '%public.saved_places%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the PLACE lane still reads public.saved_places, which has no writer anywhere.';
  END IF;

  IF v_code NOT LIKE '%wishlist_places%' OR v_code NOT LIKE '%discovery_place_saves%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the PLACE lane must read BOTH canonical save tables; neither alone is a superset of the other.';
  END IF;

  IF v_code NOT LIKE '%canonical_location_id%' OR v_code NOT LIKE '%osm_id%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the id-space bridge is incomplete — canonical or OSM saves would be silently dropped, which looks exactly like "that user saved nothing".';
  END IF;

  -- ALL FOUR LANES SURVIVE. This is the assertion whose absence would have let
  -- a corrected-signature version of PR #451 delete three memory types.
  IF v_code NOT LIKE '%''episodic''%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the episodic lane (city visits) is gone.';
  END IF;
  IF v_code NOT LIKE '%''semantic''%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the semantic lane (interests / travel styles) is gone.';
  END IF;
  IF v_code NOT LIKE '%''social''%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the social lane (follows) is gone.';
  END IF;
  IF v_code NOT LIKE '%''place''%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the place lane is gone.';
  END IF;

  -- The flag gate is the caller's contract: project_user_memory_with_retraction
  -- passes false deliberately. Losing the parameter silently re-enables the gate
  -- for a caller that asked to bypass it.
  IF v_code NOT LIKE '%p_enforce_flag%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the p_enforce_flag gate is gone.';
  END IF;

  -- The live function is SECURITY INVOKER. Turning it into a DEFINER is a
  -- privilege change and is not part of repointing a read.
  IF v_src ILIKE '%SECURITY DEFINER%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: project_user_memory became SECURITY DEFINER. It is INVOKER live, and a privilege change is not part of this migration.';
  END IF;
END $$;

COMMENT ON FUNCTION public.project_user_memory(uuid, boolean) IS
  'Projects a user''s memory events and projections across four lanes: episodic (city visits), semantic (preferences), social (follows) and place. The PLACE lane reads the UNION of the two tables saves actually land in, bridged into the discovery_places id-space and deduped per venue on MIN(saved_at). It previously read a table with no writer, so the lane produced nothing while reporting success. See migration 2963 and census-map M42.';
