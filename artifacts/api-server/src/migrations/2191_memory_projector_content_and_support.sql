-- 2191_memory_projector_content_and_support.sql
--
-- Memory — projector correctness: real content, support stamping, real retention.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- MUST BE APPLIED WITH 2190. 2190 adds retraction, which retracts any row the
-- projector did not re-affirm by stamping last_projected_at. This migration is
-- what does the stamping. Applying 2190 WITHOUT this one would retract every
-- derived memory on the second pass. They are one logical change, split only so
-- each file stays reviewable.
--
-- FIXES
-- -----
-- P0-4  Rediscovery prompt pollution. 2186 wrote constant placeholder content —
--       every saved place became the literal string 'Saved a place' and every
--       follow 'Follows a traveler'. Rediscovery returns those first, so the
--       Compass prompt budget filled with rows carrying no information and the
--       genuinely useful memory never made it in. Now each projection carries the
--       real subject: the place's name, the traveller's display name, the city.
--
-- P0-3  Real retention. The projector never set valid_to, so the sweep could
--       never expire a projected row. Now SEMANTIC memory (retention_class
--       'derived_preference', which §18 defines as "recompute/decay") gets a
--       rolling TTL that is refreshed on every pass while the preference remains
--       in the source. Episodic/place/social remain 'durable_fact' with valid_to
--       NULL BY DESIGN — §18 gives that class "canonical lifecycle/user deletion",
--       so a TTL would be wrong; their lifecycle is retraction on loss of support
--       (2190), which is the correct mechanism for a fact backed by canonical data.
--
-- P1-5/6 Support accounting. Every re-affirmed row is stamped last_projected_at =
--       the pass clock, which is what lets 2190 retract what lost support (block
--       after projection, unfollow, unsave, removed interest).
--
-- Also fixed: episodic city grouping was CASE-SENSITIVE, so the Experience Graph's
-- 'Lisbon' and 'lisbon' edges produced two contradictory memories for one city.
-- Now grouped by lower(city) with a stable display form.
--
-- PRIVACY: social memory names a traveller the user themselves follows, and is
-- readable only by that user (service_role-only functions + RLS deny-default), so
-- no new information is exposed. Blocked pairs are still excluded at projection
-- time AND retracted afterwards if a block lands later.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='memory_projections' AND column_name='last_projected_at') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2190 first (last_projected_at is required for support accounting).';
  END IF;
END $$;

-- How long a derived preference survives without being re-observed in the source.
-- Refreshed on every pass, so it only lapses if the preference actually leaves the
-- source and the retraction pass somehow does not see it.
-- (Kept as a literal here rather than a config table: one number, one meaning.)

CREATE OR REPLACE FUNCTION public.project_user_memory(
  p_user_id      uuid,
  p_enforce_flag boolean DEFAULT true
)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_enabled     boolean;
  v_uid_text    text := p_user_id::text;
  v_total       integer := 0;
  v_sub         integer;
  v_now         timestamptz := clock_timestamp();
  v_pref_ttl    interval := interval '180 days';
BEGIN
  IF p_enforce_flag THEN
    SELECT enabled INTO v_enabled FROM public.feature_flags WHERE flag = 'memory_projection';
    IF v_enabled IS DISTINCT FROM true THEN RETURN 0; END IF;
  END IF;

  -- ── EPISODIC: person→city visits, grouped case-insensitively ───────────────
  WITH ev AS (
    SELECT
      -- deterministic display form: the graph carries both 'Lisbon' and 'lisbon',
      -- and min()/max() would pick by collation rather than by legibility.
      initcap(lower(e.dst_key))             AS city_display,
      lower(e.dst_key)                      AS city_key,
      sum(coalesce(e.observed_count,1))     AS obs,
      bool_or(e.edge_type='returned_to')    AS returned,
      coalesce(max(e.last_seen), min(e.first_seen), v_now) AS occurred_at
    FROM public.compass_graph_edges e
    WHERE e.src_type='person' AND e.src_key=v_uid_text AND e.dst_type='city'
      AND e.edge_type IN ('visited','returned_to') AND e.dst_key IS NOT NULL
      AND btrim(e.dst_key) <> ''
    GROUP BY lower(e.dst_key)
  ), ins AS (
    INSERT INTO public.memory_projections
      (user_id, memory_type, subject_type, subject_id, content, confidence, provenance,
       retention_class, last_supported_at, valid_from, last_projected_at)
    SELECT p_user_id, 'episodic', 'city', ev.city_display,
           'Visited ' || ev.city_display || CASE WHEN ev.returned THEN ' (has returned)' ELSE '' END,
           least(0.95, 0.60 + 0.08*ev.obs + CASE WHEN ev.returned THEN 0.05 ELSE 0 END)::real,
           jsonb_build_object('derivation','compass_graph_edges:visited',
                              'support', jsonb_build_object('observations', ev.obs, 'returned', ev.returned)),
           'durable_fact', ev.occurred_at, ev.occurred_at, v_now
    FROM ev
    ON CONFLICT (user_id, memory_type, subject_type, subject_id) DO UPDATE SET
      confidence=EXCLUDED.confidence, content=EXCLUDED.content, provenance=EXCLUDED.provenance,
      last_supported_at=GREATEST(public.memory_projections.last_supported_at, EXCLUDED.last_supported_at),
      last_projected_at=EXCLUDED.last_projected_at,
      state=CASE WHEN public.memory_projections.state='retracted' THEN 'active'
                 ELSE public.memory_projections.state END
    RETURNING 1
  ) SELECT count(*) INTO v_sub FROM ins;
  v_total := v_total + v_sub;

  -- ── SEMANTIC: explicit interests + travel styles, WITH a decay window ──────
  WITH prefs AS (
    SELECT unnest(coalesce(cup.interests,'{}'::text[])) AS val, 'interest'::text AS styp
      FROM public.compass_user_preferences cup WHERE cup.user_id=p_user_id
    UNION ALL
    SELECT unnest(coalesce(cup.travel_styles,'{}'::text[])), 'travel_style'
      FROM public.compass_user_preferences cup WHERE cup.user_id=p_user_id
  ), ins AS (
    INSERT INTO public.memory_projections
      (user_id, memory_type, subject_type, subject_id, content, confidence, provenance,
       retention_class, last_supported_at, valid_to, last_projected_at)
    SELECT p_user_id, 'semantic', prefs.styp, prefs.val,
           CASE prefs.styp WHEN 'interest' THEN 'Interested in ' ELSE 'Travel style: ' END || prefs.val,
           0.90::real,
           jsonb_build_object('derivation','compass_user_preferences',
                              'support', jsonb_build_object('field', prefs.styp)),
           'derived_preference', v_now, v_now + v_pref_ttl, v_now
    FROM prefs WHERE prefs.val IS NOT NULL AND btrim(prefs.val) <> ''
    ON CONFLICT (user_id, memory_type, subject_type, subject_id) DO UPDATE SET
      confidence=EXCLUDED.confidence, content=EXCLUDED.content, provenance=EXCLUDED.provenance,
      last_supported_at=EXCLUDED.last_supported_at,
      valid_to=EXCLUDED.valid_to,               -- rolling refresh while still supported
      last_projected_at=EXCLUDED.last_projected_at,
      state=CASE WHEN public.memory_projections.state IN ('retracted','decayed') THEN 'active'
                 ELSE public.memory_projections.state END
    RETURNING 1
  ) SELECT count(*) INTO v_sub FROM ins;
  v_total := v_total + v_sub;

  -- ── SOCIAL: follows minus blocked pairs, naming the traveller ──────────────
  WITH f AS (
    SELECT uf.following_id, uf.created_at,
           coalesce(nullif(btrim(pr.name),''), nullif(btrim(pr.handle),''), 'a traveler') AS who
    FROM public.user_follows uf
    LEFT JOIN public.profiles pr ON pr.id = uf.following_id
    WHERE uf.follower_id = p_user_id
      AND NOT EXISTS (SELECT 1 FROM public.blocks b
                      WHERE (b.blocker_id=p_user_id AND b.blocked_id=uf.following_id)
                         OR (b.blocker_id=uf.following_id AND b.blocked_id=p_user_id))
  ), ins AS (
    INSERT INTO public.memory_projections
      (user_id, memory_type, subject_type, subject_id, content, confidence, sensitivity,
       provenance, retention_class, last_supported_at, valid_from, last_projected_at)
    SELECT p_user_id, 'social', 'user', f.following_id::text,
           'Follows ' || f.who, 0.85::real, 'sensitive',
           jsonb_build_object('derivation','user_follows',
                              'support', jsonb_build_object('followed_at', f.created_at)),
           'durable_fact', f.created_at, f.created_at, v_now
    FROM f
    ON CONFLICT (user_id, memory_type, subject_type, subject_id) DO UPDATE SET
      content=EXCLUDED.content, provenance=EXCLUDED.provenance,
      last_supported_at=GREATEST(public.memory_projections.last_supported_at, EXCLUDED.last_supported_at),
      last_projected_at=EXCLUDED.last_projected_at,
      state=CASE WHEN public.memory_projections.state='retracted' THEN 'active'
                 ELSE public.memory_projections.state END
    RETURNING 1
  ) SELECT count(*) INTO v_sub FROM ins;
  v_total := v_total + v_sub;

  -- ── PLACE: saved places, naming the place and its city ────────────────────
  WITH sp AS (
    SELECT s.place_id, s.saved_at,
           coalesce(nullif(btrim(dp.name),''), 'a place') AS place_name,
           nullif(btrim(dp.city),'')                      AS place_city
    FROM public.saved_places s
    LEFT JOIN public.discovery_places dp ON dp.id = s.place_id
    WHERE s.user_id = p_user_id
  ), ins AS (
    INSERT INTO public.memory_projections
      (user_id, memory_type, subject_type, subject_id, content, confidence, provenance,
       retention_class, last_supported_at, valid_from, last_projected_at)
    SELECT p_user_id, 'place', 'place', sp.place_id::text,
           'Saved ' || sp.place_name || coalesce(' in ' || sp.place_city, ''),
           0.90::real,
           jsonb_build_object('derivation','saved_places',
                              'support', jsonb_build_object('saved_at', sp.saved_at)),
           'durable_fact', sp.saved_at, sp.saved_at, v_now
    FROM sp
    ON CONFLICT (user_id, memory_type, subject_type, subject_id) DO UPDATE SET
      content=EXCLUDED.content, provenance=EXCLUDED.provenance,
      last_supported_at=GREATEST(public.memory_projections.last_supported_at, EXCLUDED.last_supported_at),
      last_projected_at=EXCLUDED.last_projected_at,
      state=CASE WHEN public.memory_projections.state='retracted' THEN 'active'
                 ELSE public.memory_projections.state END
    RETURNING 1
  ) SELECT count(*) INTO v_sub FROM ins;
  v_total := v_total + v_sub;

  RETURN v_total;
END
$fn$;

REVOKE ALL ON FUNCTION public.project_user_memory(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.project_user_memory(uuid, boolean) TO service_role;

DO $$
BEGIN
  IF has_function_privilege('anon','public.project_user_memory(uuid, boolean)','EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: projector reachable by anon';
  END IF;
  IF (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='project_user_memory') NOT LIKE '%last_projected_at%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: projector does not stamp last_projected_at — 2190 retraction would retract everything';
  END IF;
END $$;

COMMIT;

-- REVERSAL: re-apply 2186's project_user_memory body.
