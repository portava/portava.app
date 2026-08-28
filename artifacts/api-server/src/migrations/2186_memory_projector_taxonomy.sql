-- 2186_memory_projector_taxonomy.sql
--
-- Memory + Experience Intelligence Architecture — full §5 memory taxonomy.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- 2184 projected only EPISODIC city memory. This replaces project_user_memory
-- with the full spec §5 taxonomy, all from canonical sources (§24 — no new
-- source of truth), and widens project_all_memory to every user with any signal:
--
--   EPISODIC  ← compass_graph_edges person→city visited/returned_to  (as 2184)
--   SEMANTIC  ← compass_user_preferences.interests / travel_styles    (explicit)
--   SOCIAL    ← user_follows, EXCLUDING blocked pairs (§19)           (explicit, sensitive)
--   PLACE     ← saved_places                                          (explicit)
--
-- §19 is enforced structurally: SOCIAL memory omits any followee the user has
-- blocked or been blocked by, so a blocked relationship can never leak into a
-- memory-derived recommendation. SOCIAL rows are marked sensitivity='sensitive'.
-- Idempotent, flag-gated, service_role-only — unchanged from 2184.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.memory_projections') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2183 first.';
  END IF;
  IF to_regprocedure('public.project_user_memory(uuid, boolean)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2184 first (this replaces its function).';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.project_user_memory(
  p_user_id      uuid,
  p_enforce_flag boolean DEFAULT true
)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_enabled  boolean;
  v_uid_text text := p_user_id::text;
  v_total    integer := 0;
  v_sub      integer;
BEGIN
  IF p_enforce_flag THEN
    SELECT enabled INTO v_enabled FROM public.feature_flags WHERE flag = 'memory_projection';
    IF v_enabled IS DISTINCT FROM true THEN RETURN 0; END IF;
  END IF;

  -- ── EPISODIC: person→city visited/returned_to from the Experience Graph ─────
  INSERT INTO public.memory_events (user_id, event_type, occurred_at, subject_type, subject_id, source, visibility, source_ref, metadata)
  SELECT p_user_id, 'visited', coalesce(max(e.last_seen), min(e.first_seen), now()), 'city', e.dst_key, 'inferred', 'private',
         jsonb_build_object('table','compass_graph_edges'), jsonb_build_object('returned', bool_or(e.edge_type='returned_to'))
  FROM public.compass_graph_edges e
  WHERE e.src_type='person' AND e.src_key=v_uid_text AND e.dst_type='city'
    AND e.edge_type IN ('visited','returned_to') AND e.dst_key IS NOT NULL
  GROUP BY e.dst_key
  ON CONFLICT (user_id, event_type, subject_type, subject_id, occurred_at) DO NOTHING;

  WITH ev AS (
    SELECT e.dst_key AS city, sum(coalesce(e.observed_count,1)) AS obs,
           bool_or(e.edge_type='returned_to') AS returned,
           coalesce(max(e.last_seen), min(e.first_seen), now()) AS occurred_at
    FROM public.compass_graph_edges e
    WHERE e.src_type='person' AND e.src_key=v_uid_text AND e.dst_type='city'
      AND e.edge_type IN ('visited','returned_to') AND e.dst_key IS NOT NULL
    GROUP BY e.dst_key
  ), ins AS (
    INSERT INTO public.memory_projections
      (user_id, memory_type, subject_type, subject_id, content, confidence, provenance, retention_class, last_supported_at, valid_from)
    SELECT p_user_id, 'episodic', 'city', ev.city,
           'Visited ' || ev.city || CASE WHEN ev.returned THEN ' (returned)' ELSE '' END,
           least(0.95, 0.60 + 0.08*ev.obs + CASE WHEN ev.returned THEN 0.05 ELSE 0 END)::real,
           jsonb_build_object('derivation','compass_graph_edges:visited','returned',ev.returned),
           'durable_fact', ev.occurred_at, ev.occurred_at
    FROM ev
    ON CONFLICT (user_id, memory_type, subject_type, subject_id) DO UPDATE SET
      confidence=EXCLUDED.confidence, content=EXCLUDED.content, provenance=EXCLUDED.provenance,
      last_supported_at=GREATEST(public.memory_projections.last_supported_at, EXCLUDED.last_supported_at)
    RETURNING 1
  ) SELECT count(*) INTO v_sub FROM ins;
  v_total := v_total + v_sub;

  -- ── SEMANTIC: explicit interests + travel styles (a state, not an action) ───
  WITH prefs AS (
    SELECT unnest(coalesce(cup.interests, '{}'::text[]))     AS val, 'interest'::text     AS styp FROM public.compass_user_preferences cup WHERE cup.user_id=p_user_id
    UNION ALL
    SELECT unnest(coalesce(cup.travel_styles, '{}'::text[])), 'travel_style'              FROM public.compass_user_preferences cup WHERE cup.user_id=p_user_id
  ), ins AS (
    INSERT INTO public.memory_projections
      (user_id, memory_type, subject_type, subject_id, content, confidence, provenance, retention_class)
    SELECT p_user_id, 'semantic', prefs.styp, prefs.val,
           CASE prefs.styp WHEN 'interest' THEN 'Interested in ' ELSE 'Travel style: ' END || prefs.val,
           0.90::real, jsonb_build_object('derivation','compass_user_preferences'), 'derived_preference'
    FROM prefs WHERE prefs.val IS NOT NULL AND prefs.val <> ''
    ON CONFLICT (user_id, memory_type, subject_type, subject_id) DO UPDATE SET
      confidence=EXCLUDED.confidence, last_supported_at=now()
    RETURNING 1
  ) SELECT count(*) INTO v_sub FROM ins;
  v_total := v_total + v_sub;

  -- ── SOCIAL: follows, EXCLUDING blocked pairs (§19) — sensitive ──────────────
  INSERT INTO public.memory_events (user_id, event_type, occurred_at, subject_type, subject_id, source, visibility, source_ref)
  SELECT p_user_id, 'followed', uf.created_at, 'user', uf.following_id::text, 'explicit', 'private',
         jsonb_build_object('table','user_follows')
  FROM public.user_follows uf
  WHERE uf.follower_id = p_user_id
    AND NOT EXISTS (SELECT 1 FROM public.blocks b
                    WHERE (b.blocker_id=p_user_id AND b.blocked_id=uf.following_id)
                       OR (b.blocker_id=uf.following_id AND b.blocked_id=p_user_id))
  ON CONFLICT (user_id, event_type, subject_type, subject_id, occurred_at) DO NOTHING;

  WITH f AS (
    SELECT uf.following_id, uf.created_at
    FROM public.user_follows uf
    WHERE uf.follower_id = p_user_id
      AND NOT EXISTS (SELECT 1 FROM public.blocks b
                      WHERE (b.blocker_id=p_user_id AND b.blocked_id=uf.following_id)
                         OR (b.blocker_id=uf.following_id AND b.blocked_id=p_user_id))
  ), ins AS (
    INSERT INTO public.memory_projections
      (user_id, memory_type, subject_type, subject_id, content, confidence, sensitivity, provenance, retention_class, last_supported_at, valid_from)
    SELECT p_user_id, 'social', 'user', f.following_id::text, 'Follows a traveler', 0.85::real, 'sensitive',
           jsonb_build_object('derivation','user_follows'), 'durable_fact', f.created_at, f.created_at
    FROM f
    ON CONFLICT (user_id, memory_type, subject_type, subject_id) DO UPDATE SET
      last_supported_at=GREATEST(public.memory_projections.last_supported_at, EXCLUDED.last_supported_at)
    RETURNING 1
  ) SELECT count(*) INTO v_sub FROM ins;
  v_total := v_total + v_sub;

  -- ── PLACE: explicit saved places ────────────────────────────────────────────
  INSERT INTO public.memory_events (user_id, event_type, occurred_at, subject_type, subject_id, source, visibility, source_ref)
  SELECT p_user_id, 'saved_place', sp.saved_at, 'place', sp.place_id::text, 'explicit', 'private',
         jsonb_build_object('table','saved_places')
  FROM public.saved_places sp WHERE sp.user_id = p_user_id
  ON CONFLICT (user_id, event_type, subject_type, subject_id, occurred_at) DO NOTHING;

  WITH sp AS (SELECT place_id, saved_at FROM public.saved_places WHERE user_id=p_user_id),
  ins AS (
    INSERT INTO public.memory_projections
      (user_id, memory_type, subject_type, subject_id, content, confidence, provenance, retention_class, last_supported_at, valid_from)
    SELECT p_user_id, 'place', 'place', sp.place_id::text, 'Saved a place', 0.90::real,
           jsonb_build_object('derivation','saved_places'), 'durable_fact', sp.saved_at, sp.saved_at
    FROM sp
    ON CONFLICT (user_id, memory_type, subject_type, subject_id) DO UPDATE SET
      last_supported_at=GREATEST(public.memory_projections.last_supported_at, EXCLUDED.last_supported_at)
    RETURNING 1
  ) SELECT count(*) INTO v_sub FROM ins;
  v_total := v_total + v_sub;

  RETURN v_total;
END
$fn$;

-- Widen the fleet loop to every user with ANY projectable signal.
CREATE OR REPLACE FUNCTION public.project_all_memory(p_enforce_flag boolean DEFAULT true)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_enabled boolean;
  v_total   integer := 0;
  r         record;
BEGIN
  IF p_enforce_flag THEN
    SELECT enabled INTO v_enabled FROM public.feature_flags WHERE flag = 'memory_projection';
    IF v_enabled IS DISTINCT FROM true THEN RETURN 0; END IF;
  END IF;

  FOR r IN
    SELECT src_key::uuid AS uid FROM public.compass_graph_edges
      WHERE src_type='person' AND dst_type='city' AND edge_type IN ('visited','returned_to')
        AND src_key ~ '^[0-9a-fA-F-]{36}$'
    UNION
    SELECT follower_id FROM public.user_follows
    UNION
    SELECT user_id FROM public.saved_places
    UNION
    SELECT user_id FROM public.compass_user_preferences
      WHERE coalesce(array_length(interests,1),0) > 0 OR coalesce(array_length(travel_styles,1),0) > 0
  LOOP
    v_total := v_total + public.project_user_memory(r.uid, false);
  END LOOP;

  RETURN v_total;
END
$fn$;

-- Re-assert least-privilege (CREATE OR REPLACE preserves grants, but be explicit).
REVOKE ALL ON FUNCTION public.project_user_memory(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.project_all_memory(boolean)        FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.project_user_memory(uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.project_all_memory(boolean)        TO service_role;

DO $$
BEGIN
  IF has_function_privilege('anon','public.project_user_memory(uuid, boolean)','EXECUTE')
     OR has_function_privilege('authenticated','public.project_all_memory(boolean)','EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: projector reachable by anon/authenticated';
  END IF;
END $$;

COMMIT;

-- REVERSAL: re-apply 2184's project_user_memory / project_all_memory bodies.
