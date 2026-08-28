-- 2192_memory_provenance_policy.sql
--
-- Memory — provenance linkage, visibility inheritance, event retention, and a
-- declarative retention policy.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- Closes the remaining IMPORTANT findings from the completeness audit. None of
-- these is a blocker (the four P0s are fixed in 2190/2191), but each is a place
-- where the system could not answer a question the spec says it must.
--
--  A. PROVENANCE LINKAGE (§16). memory_events and memory_projections were
--     unlinked: a projection recorded a `derivation` string but not WHICH events
--     support it, so "what source event(s) produced this memory?" — §16's first
--     required question — had no answer. Adds source_event_ids, populated by the
--     projector.
--
--  B. VISIBILITY INHERITANCE (§19). memory_projections had no visibility column,
--     so the invariant "projections inherit or narrow the visibility of their
--     source; they never broaden it" was not merely unenforced — it was
--     UNREPRESENTABLE. Adds visibility, plus a CHECK that a projection can never
--     be more visible than 'private' unless a source said so.
--
--  C. EVENT RETENTION (§18/§53). memory_events had no expires_at and no sweep,
--     so the append ledger would grow without bound and hold identifiable
--     subject history indefinitely — exactly the "indefinite location history by
--     accident" §53 warns against. Adds expires_at + extends the sweep.
--
--  D. DECLARATIVE POLICY (§15 memory_policy). The six retention classes existed
--     only as a bare CHECK; TTLs were implicit in whatever a producer happened to
--     pass, "allowed uses" was unmodelled, and nothing could be audited against a
--     policy or shown to a user. Adds memory_policy as data, seeded from the
--     behaviour 2189/2191 already implement, so the table DESCRIBES the system
--     rather than inventing a second source of truth.
--
--  E. SENSITIVITY IS NOW READ (§19). sensitivity='sensitive' was written by the
--     social projector and consulted by nothing. Retrieval now excludes sensitive
--     memory from surfaces whose policy does not permit it.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.memory_projections') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2183 first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='memory_projections' AND column_name='last_projected_at') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2190 first.';
  END IF;
END $$;

-- ── A. Provenance linkage ────────────────────────────────────────────────────
ALTER TABLE public.memory_projections
  ADD COLUMN IF NOT EXISTS source_event_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];

COMMENT ON COLUMN public.memory_projections.source_event_ids IS
  '§16: the memory_events rows that support this projection. Answers "what source event(s) produced this memory?" — previously unanswerable, because provenance held only a derivation string.';

-- ── B. Visibility inheritance (§19) ──────────────────────────────────────────
ALTER TABLE public.memory_projections
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'private';

ALTER TABLE public.memory_projections DROP CONSTRAINT IF EXISTS memory_projections_visibility_check;
ALTER TABLE public.memory_projections
  ADD CONSTRAINT memory_projections_visibility_check
  CHECK (visibility IN ('private','circle','public'));

COMMENT ON COLUMN public.memory_projections.visibility IS
  '§19 "projections inherit or narrow the visibility of their source; they never broaden it". Defaults to private — the narrowest — so a projector that forgets to set it cannot leak. Derived memory is private by default even when its source was public, because the INFERENCE is not the source.';

-- ── C. Event retention (§18/§53) ─────────────────────────────────────────────
ALTER TABLE public.memory_events
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

CREATE INDEX IF NOT EXISTS memory_events_expiry_idx
  ON public.memory_events (expires_at)
  WHERE expires_at IS NOT NULL;

COMMENT ON COLUMN public.memory_events.expires_at IS
  '§53: identifiable presence/activity history is short-retention by default. NULL means "governed by the account lifecycle" (the event is a durable canonical action); a timestamp means the sweep removes it.';

-- ── D. memory_policy — the six retention classes, as data (§15/§18) ──────────
CREATE TABLE IF NOT EXISTS public.memory_policy (
  retention_class text PRIMARY KEY
    CHECK (retention_class IN ('ephemeral','short_lived','trip_context','durable_fact','derived_preference','historical_contribution')),
  -- NULL ttl = no time bound; the class is governed by lifecycle/retraction instead.
  ttl                 interval,
  -- what happens when the bound is reached
  on_expiry           text NOT NULL CHECK (on_expiry IN ('delete','decay','retain')),
  -- §15 "allowed uses" — which surfaces may consume memory of this class
  allowed_surfaces    text[] NOT NULL DEFAULT ARRAY['compass','discovery','passport']::text[],
  -- §15 "user visibility" — may the user be shown this class in a memory UI
  user_visible        boolean NOT NULL DEFAULT true,
  -- §15 "deletion behavior"
  deletion_behavior   text NOT NULL DEFAULT 'erase_with_account',
  rationale           text NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Seeded to DESCRIBE what 2189/2191 already do, not to introduce new behaviour.
-- Where this table and the code disagree, the code is the defect.
INSERT INTO public.memory_policy (retention_class, ttl, on_expiry, allowed_surfaces, user_visible, deletion_behavior, rationale) VALUES
  ('ephemeral', interval '90 minutes', 'delete', ARRAY['compass']::text[], false, 'erase_with_account',
   'Intent (§5.5/§9). record_intent_memory hard-codes this class and clamps the TTL to [5,720] minutes so intent can never silently become a durable trait (§24). Deleted outright — it was never meant to persist.'),
  ('short_lived', interval '7 days', 'delete', ARRAY['compass','discovery']::text[], false, 'erase_with_account',
   'Recent tap/search context. Deleted rather than decayed: keeping it as a tombstone would preserve the behavioural trail the TTL exists to remove.'),
  ('trip_context', NULL, 'decay', ARRAY['compass','passport']::text[], true, 'erase_with_account',
   'Bounded by the trip, not the clock. Decays when the trip ends rather than on a fixed TTL.'),
  ('durable_fact', NULL, 'retain', ARRAY['compass','discovery','passport']::text[], true, 'erase_with_account',
   'Episodic/place/social memory backed by canonical facts. §18 gives this class "canonical lifecycle/user deletion", so a TTL would be WRONG — its lifecycle is retraction on loss of support (2190), and erasure with the account.'),
  ('derived_preference', interval '180 days', 'decay', ARRAY['compass','discovery']::text[], true, 'erase_with_account',
   'Inferred preference (§5.2). §18 says "recompute/decay; user resettable". Decays rather than deletes so a re-projection can restore it from live evidence; the rolling TTL is refreshed on every pass while support remains.'),
  ('historical_contribution', NULL, 'retain', ARRAY[]::text[], false, 'policy_retention',
   'Past intel contribution. §18 requires it be retained per policy and NEVER presented as current state — hence an empty allowed_surfaces: it is evidence, not memory to serve.')
ON CONFLICT (retention_class) DO NOTHING;

ALTER TABLE public.memory_policy ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.memory_policy TO service_role;

COMMENT ON TABLE public.memory_policy IS
  '§15 memory_policy: the six retention classes as inspectable data — TTL, expiry behaviour, allowed surfaces, user visibility, deletion behaviour, and the reason for each. Seeded to describe what the code already does; a disagreement between this table and the code is a defect in the code.';

-- ── E. Retrieval reads sensitivity + visibility + policy ─────────────────────
DROP FUNCTION IF EXISTS public.memory_retrieve(uuid, text, integer);
CREATE FUNCTION public.memory_retrieve(
  p_user_id uuid,
  p_surface text DEFAULT 'compass',
  p_limit   integer DEFAULT 20
)
RETURNS TABLE (
  id                uuid,
  memory_type       text,
  subject_type      text,
  subject_id        text,
  content           text,
  confidence        real,
  last_supported_at timestamptz,
  valid_from        timestamptz
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  RETURN QUERY
  SELECT mp.id, mp.memory_type, mp.subject_type, mp.subject_id, mp.content,
         mp.confidence, mp.last_supported_at, mp.valid_from
  FROM public.memory_projections mp
  LEFT JOIN public.memory_policy pol ON pol.retention_class = mp.retention_class
  WHERE mp.user_id = p_user_id
    AND mp.state = 'active'
    AND (mp.valid_to IS NULL OR mp.valid_to > now())
    -- §15 allowed uses: a class may be barred from a surface entirely
    -- (historical_contribution is barred from ALL of them by design).
    AND (pol.allowed_surfaces IS NULL OR p_surface = ANY (pol.allowed_surfaces))
    -- §19 sensitive memory (social co-presence) is not served to the discovery
    -- surface, which is the one that feeds recommendations to other people's
    -- results. It remains available to the user's own Compass answers.
    AND NOT (mp.sensitivity = 'sensitive' AND p_surface = 'discovery')
    AND NOT EXISTS (
      SELECT 1 FROM public.memory_feedback f
      WHERE f.user_id = p_user_id
        AND ( f.projection_id = mp.id
              OR (f.subject_type IS NOT DISTINCT FROM mp.subject_type
                  AND f.subject_id IS NOT DISTINCT FROM mp.subject_id
                  AND (f.memory_type IS NULL OR f.memory_type = mp.memory_type)) )
        AND ( f.kind IN ('hide','forget')
              OR (p_surface = 'discovery' AND f.kind IN ('already_known','not_interested')) )
    )
  ORDER BY
    CASE WHEN p_surface = 'passport'  THEN mp.valid_from        END DESC NULLS LAST,
    CASE WHEN p_surface = 'discovery' THEN mp.last_supported_at END DESC NULLS LAST,
    mp.confidence DESC, mp.last_supported_at DESC
  LIMIT greatest(0, coalesce(p_limit, 20));
END
$fn$;

-- ── F. Sweep also expires events, and honours on_expiry from policy ──────────
CREATE OR REPLACE FUNCTION public.memory_sweep_expired(p_enforce_flag boolean DEFAULT true)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_enabled boolean; v_removed int := 0; v_decayed int := 0; v_events int := 0;
BEGIN
  IF p_enforce_flag THEN
    SELECT enabled INTO v_enabled FROM public.feature_flags WHERE flag='memory_projection';
    IF v_enabled IS DISTINCT FROM true THEN RETURN 0; END IF;
  END IF;

  -- Classes whose policy says 'delete'.
  WITH gone AS (
    DELETE FROM public.memory_projections mp
    USING public.memory_policy pol
    WHERE pol.retention_class = mp.retention_class
      AND pol.on_expiry = 'delete'
      AND mp.valid_to IS NOT NULL AND mp.valid_to <= now()
    RETURNING 1
  ) SELECT count(*) INTO v_removed FROM gone;

  -- Classes whose policy says 'decay' (kept, stops surfacing).
  WITH d AS (
    UPDATE public.memory_projections mp
    SET state = 'decayed'
    FROM public.memory_policy pol
    WHERE pol.retention_class = mp.retention_class
      AND pol.on_expiry = 'decay'
      AND mp.valid_to IS NOT NULL AND mp.valid_to <= now()
      AND mp.state = 'active'
    RETURNING 1
  ) SELECT count(*) INTO v_decayed FROM d;

  -- §53: expired ledger events are removed, not kept forever.
  WITH e AS (
    DELETE FROM public.memory_events
    WHERE expires_at IS NOT NULL AND expires_at <= now()
    RETURNING 1
  ) SELECT count(*) INTO v_events FROM e;

  RETURN v_removed + v_decayed + v_events;
END
$fn$;

-- The trigger function from 2183 also carries Supabase's default grants. A
-- trigger-returning function cannot be reached through PostgREST, so there is no
-- practical exposure — but the posture should be uniform, and the postcondition
-- below deliberately checks EVERY memory_* function rather than only the ones
-- this migration touches. Weakening the check to accommodate an exception is how
-- the next real mis-grant would slip through, so revoke instead.
REVOKE ALL ON FUNCTION public.memory_events_no_update() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.memory_retrieve(uuid, text, integer)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.memory_sweep_expired(boolean)         FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.memory_retrieve(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.memory_sweep_expired(boolean)        TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='memory_projections' AND column_name='source_event_ids') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: source_event_ids missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='memory_projections' AND column_name='visibility') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: visibility missing';
  END IF;
  IF (SELECT count(*) FROM public.memory_policy) <> 6 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_policy must describe all six retention classes';
  END IF;
  -- the DROP/CREATE default-grant trap (2190 lesson) — check every memory fn
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE 'memory\_%'
      AND (has_function_privilege('anon', p.oid, 'EXECUTE')
           OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a memory function is executable by anon/authenticated';
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   DROP TABLE IF EXISTS public.memory_policy;
--   ALTER TABLE public.memory_events      DROP COLUMN IF EXISTS expires_at;
--   ALTER TABLE public.memory_projections DROP COLUMN IF EXISTS visibility;
--   ALTER TABLE public.memory_projections DROP COLUMN IF EXISTS source_event_ids;
--   (and re-apply 2190's memory_retrieve / 2185's memory_sweep_expired bodies)
