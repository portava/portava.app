-- 3812_place_split_memory_reresolution.sql
-- Highlights/Memories spec §9 "Entity Resolution and Historical Identity":
-- "Entity splits trigger re-resolution from retained evidence" (spec:317).
-- Census-highlights-memories H72 (census :418, restated :8178: "The place
-- catalog has no entity-split operation to trigger re-resolution").
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; B58 memories band
-- 3802-3819, cluster MEM-PLACE-SPLIT). APPLIED TO NO DATABASE by the lane that
-- wrote it. ADDITIVE: one CHECK widened, one table, three functions, two
-- triggers, one flag seeded FALSE. NO EXISTING ROW IS WRITTEN.
--
-- ── WHAT A SPLIT IS ────────────────────────────────────────────────────────
-- 2028's catalog has an admin MERGE (one venue recorded twice becomes one) and
-- its lossless UNMERGE (routes/placesCanonical.ts). Unmerge already re-resolves
-- by construction: a Memory keeps its own place_id. A SPLIT is the other case:
-- ONE catalog row turns out to be TWO venues. public.place_split() keeps the
-- row (P) and creates the second one (P2) from the admin's name and position,
-- optionally moves the provider references that belong to P2, and logs
-- action = 'split' (survivor_place_id = P, affected_place_id = P2) in
-- place_merge_log — atomically, under a row lock on P, and only while both
-- `external_places_enabled` and `memory_place_split_reresolution_enabled` are
-- ON. A merged-away row (merged_into_place_id set, or status 'duplicate') is
-- not split: split its survivor.
--
-- ── WHAT RE-RESOLUTION IS, AND WHAT IT NEVER DOES ──────────────────────────
-- Every Memory whose stored place_id is P may now belong to P or to P2. The
-- API's job (services/memory/memoryPlaceSplitReresolution.ts) reads only the
-- evidence the Memory RETAINED — its occurrence coordinates (location_lat/lng)
-- and the place's name as it was when the Memory recorded it
-- (place_display_name_at_occurrence, 3804) — and writes ONE PROPOSAL per Memory
-- into public.memory_place_reresolution_proposals. It suggests a row only when
-- exactly one of P and P2 is within 75 m AND that row's name matches the
-- occurrence name once both are normalized; otherwise suggested_place_id is
-- NULL (unresolved: §28.3 and H74 forbid guessing). Owner question Q-H72 holds
-- the bound and the name rule. A Memory with any owner place correction (3673)
-- gets no proposal at all (H73: a correction beats automatic resolution).
--   * Nothing here, and nothing in the job, writes public.memories or
--     public.memory_corrections. The OWNER accepts by changing the Memory's
--     place through the existing PATCH /memories/:id (one writer, lead ruling
--     H-10); the proposal only records the decision, and the guard below
--     refuses an 'accepted' that the Memory itself does not already show.
--   * No coordinate, distance or name is stored in a proposal. `evidence`
--     holds the rule version, the bound, the reason and, per candidate, two
--     booleans (within the bound, name matches) — enforced by CHECKs.
--
-- ── ERASURE ────────────────────────────────────────────────────────────────
-- A proposal is derived from the Memory's location, so it goes with it:
--   * the Memory's soft delete (§21, state -> 'deleted'): the AFTER UPDATE OF
--     state trigger memory_place_reresolution_purge deletes its proposals in
--     the same transaction (SECURITY DEFINER: whoever deletes the Memory need
--     hold no privilege on this table);
--   * a hard delete of the Memory, or the account: memory_id and owner_id
--     CASCADE (AccountDeletionService hard-deletes every Memory, then the
--     auth user). A proposal can never be written for a deleted Memory: the
--     guard locks the Memory FOR SHARE and refuses one.
--
-- ── ACCESS ─────────────────────────────────────────────────────────────────
-- RLS ON with NO policy; every client privilege revoked in this file
-- (check:client-privilege-boundary rule 4; rule 7 lists the table);
-- service_role holds SELECT, INSERT, UPDATE (no DELETE: only the purge
-- trigger and the cascades delete). No client role can execute any function
-- here; place_split is SECURITY INVOKER and EXECUTE-able by service_role only.
--
-- ── THE FLAG ───────────────────────────────────────────────────────────────
-- memory_place_split_reresolution_enabled, seeded FALSE here, so the row exists
-- exactly where the table does. FALSE or absent: the admin split is refused
-- (by the route AND by place_split itself), the job reads nothing past the
-- flags and writes nothing, and the owner's proposal routes answer as if they
-- did not exist. Turning it on is the owner's call (Q-H72 first).
--
-- Rollback: db/rollback/2026-10-14-3812-place-split-memory-reresolution-rollback.sql

BEGIN;

DO $pre$
DECLARE
  v_other text;
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3812): auth.users is missing — the erasure cascade cannot be created.';
  END IF;
  IF to_regclass('public.memories') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3812): public.memories does not exist.';
  END IF;
  IF to_regclass('public.places') IS NULL OR to_regclass('public.external_place_references') IS NULL
     OR to_regclass('public.place_merge_log') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3812): the 2028 catalog (places, external_place_references, place_merge_log) does not exist.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3812): public.feature_flags does not exist.';
  END IF;
  -- Any OTHER CHECK on place_merge_log.action would still refuse 'split' after
  -- this file widens place_merge_log_action_check. Nobody wrote such a state
  -- down, so it is refused rather than guessed around.
  SELECT string_agg(c.conname, ', ') INTO v_other
    FROM pg_constraint c
   WHERE c.conrelid = 'public.place_merge_log'::regclass AND c.contype = 'c'
     AND c.conname <> 'place_merge_log_action_check'
     AND pg_get_constraintdef(c.oid) ~ '\maction\M';
  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3812): place_merge_log carries another CHECK on action (%); widening place_merge_log_action_check would not admit split.', v_other;
  END IF;
END $pre$;

-- ── 1. place_merge_log admits 'split' ───────────────────────────────────────
ALTER TABLE public.place_merge_log DROP CONSTRAINT IF EXISTS place_merge_log_action_check;
ALTER TABLE public.place_merge_log ADD CONSTRAINT place_merge_log_action_check
  CHECK (action IN ('merge', 'unmerge', 'split'));

-- ── 2. The split: one atomic writer ─────────────────────────────────────────
-- p_new: { name, normalized_name, latitude, longitude, primary_category?,
-- address?, city?, neighborhood?, country_code?, canonical_location_id? }.
-- Optional descriptive fields not given are copied from P (the two venues were
-- recorded as one, so they share them unless the admin says otherwise). The
-- name and the position are the admin's and are required. normalized_name is
-- computed by the API with the catalog resolver's own normalizer.
CREATE OR REPLACE FUNCTION public.place_split(p_place_id uuid, p_new jsonb, p_reference_ids uuid[], p_admin_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO pg_catalog, pg_temp
AS $fn$
DECLARE
  v_src     public.places%ROWTYPE;
  v_name    text;
  v_norm    text;
  v_lat     double precision;
  v_lng     double precision;
  v_refs    uuid[] := coalesce(p_reference_ids, '{}'::uuid[]);
  v_wanted  integer;
  v_owned   integer;
  v_new     uuid;
  v_split   uuid;
  v_moved   integer := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'memory_place_split_reresolution_enabled' AND enabled)
     OR NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'external_places_enabled' AND enabled) THEN
    RETURN jsonb_build_object('outcome', 'disabled');
  END IF;
  IF p_place_id IS NULL OR p_new IS NULL OR jsonb_typeof(p_new) <> 'object'
     OR jsonb_typeof(p_new -> 'latitude') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_new -> 'longitude') IS DISTINCT FROM 'number' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'detail', 'a place id, a name and a numeric position are required');
  END IF;
  v_name := btrim(coalesce(p_new ->> 'name', ''));
  v_norm := coalesce(p_new ->> 'normalized_name', '');
  v_lat  := (p_new ->> 'latitude')::double precision;
  v_lng  := (p_new ->> 'longitude')::double precision;
  IF char_length(v_name) NOT BETWEEN 1 AND 300 OR v_lat NOT BETWEEN -90 AND 90 OR v_lng NOT BETWEEN -180 AND 180
     OR cardinality(v_refs) > 500 THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'detail', 'name 1-300 characters, latitude -90..90, longitude -180..180, at most 500 references');
  END IF;

  SELECT * INTO v_src FROM public.places WHERE id = p_place_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF v_src.merged_into_place_id IS NOT NULL OR v_src.status = 'duplicate' THEN
    RETURN jsonb_build_object('outcome', 'merged');
  END IF;

  -- Every reference named must belong to P now: all of them move, or none.
  SELECT count(DISTINCT x) INTO v_wanted FROM unnest(v_refs) AS x;
  SELECT count(*) INTO v_owned FROM public.external_place_references r
   WHERE r.id = ANY (v_refs) AND r.place_id = p_place_id;
  IF v_owned <> v_wanted THEN
    RETURN jsonb_build_object('outcome', 'reference_not_on_place');
  END IF;

  INSERT INTO public.places (name, normalized_name, primary_category, latitude, longitude, address, city, neighborhood,
                             country_code, canonical_location_id, status, field_freshness)
  VALUES (v_name, v_norm,
          coalesce(NULLIF(btrim(p_new ->> 'primary_category'), ''), v_src.primary_category),
          v_lat, v_lng,
          coalesce(NULLIF(btrim(p_new ->> 'address'), ''), v_src.address),
          coalesce(NULLIF(btrim(p_new ->> 'city'), ''), v_src.city),
          coalesce(NULLIF(btrim(p_new ->> 'neighborhood'), ''), v_src.neighborhood),
          coalesce(NULLIF(btrim(p_new ->> 'country_code'), ''), v_src.country_code),
          coalesce(NULLIF(p_new ->> 'canonical_location_id', '')::uuid, v_src.canonical_location_id),
          'active',
          jsonb_build_object('name', now(), 'coordinates', now()))
  RETURNING id INTO v_new;

  UPDATE public.external_place_references SET place_id = v_new
   WHERE id = ANY (v_refs) AND place_id = p_place_id;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  INSERT INTO public.place_merge_log (action, survivor_place_id, affected_place_id, admin_id, ref_count)
  VALUES ('split', p_place_id, v_new, p_admin_id, v_moved)
  RETURNING id INTO v_split;

  RETURN jsonb_build_object('outcome', 'split', 'split_id', v_split, 'new_place_id', v_new, 'references_moved', v_moved);
END
$fn$;

-- ── 3. The proposals ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.memory_place_reresolution_proposals (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id           uuid        NOT NULL REFERENCES public.memories (id) ON DELETE CASCADE,
  owner_id            uuid        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  split_id            uuid        NOT NULL REFERENCES public.place_merge_log (id) ON DELETE CASCADE,
  split_from_place_id uuid        NOT NULL REFERENCES public.places (id) ON DELETE CASCADE,
  candidate_place_ids uuid[]      NOT NULL,
  suggested_place_id  uuid        NULL,
  evidence            jsonb       NOT NULL,
  state               text        NOT NULL DEFAULT 'pending',
  accepted_place_id   uuid        NULL,
  decided_at          timestamptz NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_place_reresolution_proposals_once UNIQUE (memory_id, split_id),
  CONSTRAINT memory_place_reresolution_proposals_state_check CHECK (state IN ('pending', 'accepted', 'dismissed')),
  CONSTRAINT memory_place_reresolution_proposals_candidates CHECK (
    cardinality(candidate_place_ids) BETWEEN 2 AND 10 AND split_from_place_id = ANY (candidate_place_ids)
    AND array_position(candidate_place_ids, NULL) IS NULL),
  CONSTRAINT memory_place_reresolution_proposals_suggestion CHECK (
    suggested_place_id IS NULL OR suggested_place_id = ANY (candidate_place_ids)),
  -- A suggestion exists exactly when the rule concluded one; every other
  -- reason is unresolved (§28.3 / H74: never a guess). coalesce: a CHECK that
  -- evaluates to NULL passes, so a missing key must read as false.
  CONSTRAINT memory_place_reresolution_proposals_suggested_iff_resolved CHECK (
    (suggested_place_id IS NOT NULL) = (coalesce(evidence ->> 'reason', '') = 'unique_within_bound_name_match')),
  -- No coordinate, distance or name: four top-level keys, a known reason, and
  -- per candidate only its id and two booleans.
  CONSTRAINT memory_place_reresolution_proposals_evidence_shape CHECK (
    coalesce(jsonb_typeof(evidence), '') = 'object'
    AND (evidence - ARRAY['rule', 'bound_m', 'reason', 'candidates']) = '{}'::jsonb
    AND coalesce(jsonb_typeof(evidence -> 'rule'), '') = 'string'
    AND coalesce(jsonb_typeof(evidence -> 'bound_m'), '') = 'number'
    AND coalesce(evidence ->> 'reason', '') IN ('unique_within_bound_name_match', 'no_coordinates', 'candidate_without_coordinates',
                                                'none_within_bound', 'several_within_bound', 'no_occurrence_name', 'name_mismatch')
    AND coalesce(jsonb_typeof(evidence -> 'candidates'), '') = 'array'
    AND NOT jsonb_path_exists(evidence, '$.candidates[*] ? (@.type() != "object")')
    AND NOT jsonb_path_exists(evidence, '$.candidates[*].keyvalue() ? (@.key != "place_id" && @.key != "within_bound" && @.key != "name_match")', '{}', true)
    AND NOT jsonb_path_exists(evidence, '$.candidates[*].* ? (@.type() == "number" || @.type() == "object" || @.type() == "array")', '{}', true)),
  CONSTRAINT memory_place_reresolution_proposals_decided CHECK ((state = 'pending') = (decided_at IS NULL)),
  CONSTRAINT memory_place_reresolution_proposals_accepted CHECK (
    (state = 'accepted') = (accepted_place_id IS NOT NULL)
    AND (accepted_place_id IS NULL OR accepted_place_id = ANY (candidate_place_ids)))
);

CREATE INDEX IF NOT EXISTS memory_place_reresolution_proposals_owner_idx
  ON public.memory_place_reresolution_proposals (owner_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS memory_place_reresolution_proposals_split_idx
  ON public.memory_place_reresolution_proposals (split_id);

COMMENT ON TABLE public.memory_place_reresolution_proposals IS
  'Spec §9 / census H72 (migration 3812): after an admin place split, one proposal per Memory that stored the split place, from the Memory''s RETAINED evidence only. Suggests a row only when exactly one candidate is within 75 m and name-compatible (Q-H72); otherwise unresolved. Never writes memories: the owner accepts through PATCH /memories/:id. Purged with the Memory''s soft delete (trigger) and by cascade.';

-- ── 4. The guard: born pending for a live Memory at the split place; only the
--      owner's decision changes afterwards, once, and 'accepted' only when the
--      Memory already shows the chosen place ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.memory_place_reresolution_proposals_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $fn$
DECLARE
  v_owner  uuid;
  v_state  text;
  v_place  text;
  v_action text;
  v_from   uuid;
  v_to     uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- FOR SHARE: a soft delete racing this insert waits for it, and its purge
    -- trigger then removes the row; one that committed first is seen here.
    SELECT m.owner_id, m.state, m.place_id INTO v_owner, v_state, v_place
      FROM public.memories m WHERE m.id = NEW.memory_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'memory_place_reresolution_proposals: the Memory does not exist' USING ERRCODE = '23503';
    END IF;
    IF v_owner IS DISTINCT FROM NEW.owner_id THEN
      RAISE EXCEPTION 'memory_place_reresolution_proposals: owner_id is not the Memory''s owner' USING ERRCODE = '23514';
    END IF;
    IF v_state = 'deleted' THEN
      RAISE EXCEPTION 'memory_place_reresolution_proposals: the Memory is deleted' USING ERRCODE = '23514';
    END IF;
    IF v_place IS DISTINCT FROM NEW.split_from_place_id::text THEN
      RAISE EXCEPTION 'memory_place_reresolution_proposals: the Memory no longer stores the split place' USING ERRCODE = '23514';
    END IF;
    SELECT l.action, l.survivor_place_id, l.affected_place_id INTO v_action, v_from, v_to
      FROM public.place_merge_log l WHERE l.id = NEW.split_id;
    IF v_action IS DISTINCT FROM 'split' OR v_from IS DISTINCT FROM NEW.split_from_place_id
       OR NOT (v_to = ANY (NEW.candidate_place_ids)) THEN
      RAISE EXCEPTION 'memory_place_reresolution_proposals: split_id is not a split of split_from_place_id into a candidate' USING ERRCODE = '23514';
    END IF;
    IF NEW.state <> 'pending' OR NEW.decided_at IS NOT NULL OR NEW.accepted_place_id IS NOT NULL THEN
      RAISE EXCEPTION 'memory_place_reresolution_proposals: a proposal is written pending' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: the owner's decision, once.
  IF OLD.state <> 'pending' THEN
    RAISE EXCEPTION 'memory_place_reresolution_proposals: a decided proposal is final' USING ERRCODE = '23514';
  END IF;
  IF NEW.state NOT IN ('accepted', 'dismissed') THEN
    RAISE EXCEPTION 'memory_place_reresolution_proposals: a pending proposal may only be accepted or dismissed' USING ERRCODE = '23514';
  END IF;
  IF (NEW.id, NEW.memory_id, NEW.owner_id, NEW.split_id, NEW.split_from_place_id, NEW.candidate_place_ids,
      NEW.suggested_place_id, NEW.evidence, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.memory_id, OLD.owner_id, OLD.split_id, OLD.split_from_place_id, OLD.candidate_place_ids,
      OLD.suggested_place_id, OLD.evidence, OLD.created_at) THEN
    RAISE EXCEPTION 'memory_place_reresolution_proposals: only the decision may change' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'accepted' THEN
    -- The place change itself went through PATCH /memories/:id (H-10); the
    -- proposal only records it.
    SELECT m.place_id INTO v_place FROM public.memories m WHERE m.id = NEW.memory_id;
    IF v_place IS DISTINCT FROM NEW.accepted_place_id::text THEN
      RAISE EXCEPTION 'memory_place_reresolution_proposals: the Memory does not store the accepted place' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS memory_place_reresolution_proposals_guard ON public.memory_place_reresolution_proposals;
CREATE TRIGGER memory_place_reresolution_proposals_guard
  BEFORE INSERT OR UPDATE ON public.memory_place_reresolution_proposals
  FOR EACH ROW EXECUTE FUNCTION public.memory_place_reresolution_proposals_guard();

-- ── 5. The purge: a Memory's soft delete takes its proposals ────────────────
CREATE OR REPLACE FUNCTION public.memory_place_reresolution_purge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $fn$
BEGIN
  DELETE FROM public.memory_place_reresolution_proposals WHERE memory_id = NEW.id;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS memory_place_reresolution_purge ON public.memories;
CREATE TRIGGER memory_place_reresolution_purge
  AFTER UPDATE OF state ON public.memories
  FOR EACH ROW
  WHEN (NEW.state = 'deleted' AND OLD.state IS DISTINCT FROM 'deleted')
  EXECUTE FUNCTION public.memory_place_reresolution_purge();

-- ── 6. Access: RLS on, no policy, no client privilege ───────────────────────
ALTER TABLE public.memory_place_reresolution_proposals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.memory_place_reresolution_proposals FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.memory_place_reresolution_proposals TO service_role;
REVOKE ALL ON FUNCTION public.place_split(uuid, jsonb, uuid[], uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.place_split(uuid, jsonb, uuid[], uuid) TO service_role;
REVOKE ALL ON FUNCTION public.memory_place_reresolution_proposals_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.memory_place_reresolution_purge() FROM PUBLIC, anon, authenticated;

-- ── 7. The flag, FALSE ──────────────────────────────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('memory_place_split_reresolution_enabled', false,
   'Spec §9 entity split re-resolution (migration 3812, census H72): an admin may split one catalog place into two (POST /admin/places/:id/split, also behind external_places_enabled), and every Memory that stored it gets an owner-only proposal from its retained evidence (75 m + normalized-name match, else unresolved; Q-H72). The owner accepts through PATCH /memories/:id. FALSE / absent = the split is refused, the job writes nothing and the proposal routes answer as if they did not exist.')
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions (recomputed from the catalog; no session state) ─────────
DO $post$
DECLARE
  t  constant text := 'public.memory_place_reresolution_proposals';
  r  text;
  p  text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.place_merge_log'::regclass
                   AND conname = 'place_merge_log_action_check' AND contype = 'c'
                   AND pg_get_constraintdef(oid) LIKE '%''merge''%' AND pg_get_constraintdef(oid) LIKE '%''unmerge''%'
                   AND pg_get_constraintdef(oid) LIKE '%''split''%') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3812): place_merge_log_action_check does not admit merge, unmerge and split';
  END IF;
  IF to_regclass(t) IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3812): % was not created', t;
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass(t)) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3812): row level security is off on %', t;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = to_regclass(t)) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3812): % carries a policy — it must have none (service role only)', t;
  END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(r, t, p) THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED (3812): % holds % on % — service role only', r, p, t;
      END IF;
    END LOOP;
  END LOOP;
  FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE'] LOOP
    IF NOT has_table_privilege('service_role', t, p) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3812): service_role lacks % on %', p, t;
    END IF;
  END LOOP;
  IF has_table_privilege('service_role', t, 'DELETE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3812): service_role holds DELETE on % — only the purge trigger and the cascades delete', t;
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = to_regclass(t) AND contype = 'f' AND confdeltype = 'c'
        AND confrelid IN ('public.memories'::regclass, 'auth.users'::regclass, 'public.place_merge_log'::regclass, 'public.places'::regclass)) <> 4 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3812): an erasure cascade (memories, auth.users, place_merge_log, places) is missing';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = to_regclass(t) AND conname IN (
        'memory_place_reresolution_proposals_once', 'memory_place_reresolution_proposals_state_check',
        'memory_place_reresolution_proposals_candidates', 'memory_place_reresolution_proposals_suggestion',
        'memory_place_reresolution_proposals_suggested_iff_resolved', 'memory_place_reresolution_proposals_evidence_shape',
        'memory_place_reresolution_proposals_decided', 'memory_place_reresolution_proposals_accepted')) <> 8 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3812): a proposals constraint (once, state, candidates, suggestion, suggested-iff-resolved, evidence shape, decided, accepted) is missing';
  END IF;
  -- tgtype bits: 1 ROW, 2 BEFORE, 4 INSERT, 16 UPDATE.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg.tgrelid = to_regclass(t) AND NOT tg.tgisinternal
                   AND tg.tgname = 'memory_place_reresolution_proposals_guard' AND tg.tgenabled <> 'D'
                   AND (tg.tgtype & 1) = 1 AND (tg.tgtype & 2) = 2 AND (tg.tgtype & 4) = 4 AND (tg.tgtype & 16) = 16
                   AND tg.tgfoid = 'public.memory_place_reresolution_proposals_guard()'::regprocedure) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3812): the proposals guard is missing, disabled, or not BEFORE INSERT OR UPDATE FOR EACH ROW';
  END IF;
  -- AFTER (bit 2 clear) UPDATE OF state, conditional on the soft delete.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg.tgrelid = 'public.memories'::regclass AND NOT tg.tgisinternal
                   AND tg.tgname = 'memory_place_reresolution_purge' AND tg.tgenabled <> 'D'
                   AND (tg.tgtype & 1) = 1 AND (tg.tgtype & 2) = 0 AND (tg.tgtype & 16) = 16 AND tg.tgqual IS NOT NULL
                   AND tg.tgfoid = 'public.memory_place_reresolution_purge()'::regprocedure
                   AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
                          FROM unnest(tg.tgattr::int2[]) k JOIN pg_attribute a ON a.attrelid = tg.tgrelid AND a.attnum = k)
                       = ARRAY['state']) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3812): the purge trigger on memories is missing, disabled, unconditional, or not AFTER UPDATE OF state FOR EACH ROW';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.memory_place_reresolution_purge()'::regprocedure
                   AND prosecdef AND coalesce(proconfig, '{}') @> ARRAY['search_path=pg_catalog, pg_temp'])
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.memory_place_reresolution_proposals_guard()'::regprocedure
                   AND prosecdef AND coalesce(proconfig, '{}') @> ARRAY['search_path=pg_catalog, pg_temp']) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3812): the purge and guard functions must be SECURITY DEFINER with a pinned search_path';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.place_split(uuid,jsonb,uuid[],uuid)'::regprocedure
                   AND NOT prosecdef AND coalesce(proconfig, '{}') @> ARRAY['search_path=pg_catalog, pg_temp']) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3812): place_split must exist, be SECURITY INVOKER and pin its search_path';
  END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_function_privilege(r, 'public.place_split(uuid,jsonb,uuid[],uuid)', 'EXECUTE')
       OR has_function_privilege(r, 'public.memory_place_reresolution_proposals_guard()', 'EXECUTE')
       OR has_function_privilege(r, 'public.memory_place_reresolution_purge()', 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3812): % may execute a 3812 function — service role only', r;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.place_split(uuid,jsonb,uuid[],uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3812): service_role cannot execute place_split';
  END IF;
  -- place_split is SECURITY INVOKER: what it reads and writes, the service role
  -- must hold, each privilege on its own (a comma list asks for ANY of them).
  FOREACH p IN ARRAY ARRAY['public.places:SELECT', 'public.places:INSERT', 'public.places:UPDATE',
                           'public.external_place_references:SELECT', 'public.external_place_references:UPDATE',
                           'public.place_merge_log:SELECT', 'public.place_merge_log:INSERT', 'public.feature_flags:SELECT'] LOOP
    IF NOT has_table_privilege('service_role', split_part(p, ':', 1), split_part(p, ':', 2)) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3812): service_role lacks % on %, which place_split (SECURITY INVOKER) needs', split_part(p, ':', 2), split_part(p, ':', 1);
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'memory_place_split_reresolution_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3812): memory_place_split_reresolution_enabled was not seeded';
  END IF;
END $post$;

COMMIT;
