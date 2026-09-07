-- 2320_memory_episode_provenance_spine.sql
--
-- Highlights/Memories spec §6-§9 — the PROVENANCE SPINE. The one object that can
-- answer "what happened, and how do we know".
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Additive,
-- idempotent, forward-only. Enables nothing; wired into no live path.
--
-- WHY A NEW OBJECT AND NOT AN EXTENSION OF AN EXISTING ONE
-- --------------------------------------------------------
-- Five tables already carry "memory" in the name. None of them is an episode,
-- and the census that motivated this work (CONSTRUCTED 26.4%, CORRECT 1.1%)
-- found that every provenance primitive §6-§9 needs is absent. What exists:
--
--   public.memories          — a user-facing media ALBUM (owner_id, title,
--                              visibility, trip/event/place, state
--                              draft|published|archived|deleted|removed). A
--                              scrapbook, authored by the user. Not derived,
--                              carries no detection, no evidence.
--   public.memory_items      — that album's media SLIDES (memory_id, media_url,
--                              caption, position). 2183:24-31 explicitly REFUSED
--                              this name for the derived contract because of this
--                              collision. That refusal still binds; this migration
--                              does not revisit it.
--   public.passport_memories — a Passport SUGGESTION FEED
--                              (status suggested|active|dismissed). A queue of
--                              things to offer the user, not a record of events.
--   public.memory_events     — 2183 L2: an append-only ledger of point ACTIONS,
--                              deduped UNIQUE (user_id, event_type, subject_type,
--                              subject_id, occurred_at). No duration, no lifecycle,
--                              no detection reason, no version, no significance.
--                              A signal, deliberately.
--   public.memory_projections— 2183 L3: a derived FACT about a person ("prefers
--                              walkable areas"), UPSERTED one row per
--                              (user_id, memory_type, subject_type, subject_id),
--                              lifecycle active|decayed|hidden|forgotten|
--                              retracted|disputed (2196). A standing belief, not
--                              an occurrence.
--   public.compass_memories  — a Compass chat store (scope session|trip|long_term|
--                              circle), owned by the assistant layer.
--
-- An EPISODE is none of these. It is a BOUNDED OCCURRENCE — it has a start and an
-- end, it happened once, and the same person can have many of them at the same
-- place. That last property alone rules out memory_projections, whose uniqueness
-- key permits exactly one row per (user, type, subject); it rules out
-- memory_events, whose dedupe key is a point in time and whose append-only
-- guarantee forbids the lifecycle an episode must walk. Overloading either would
-- destroy the invariant that makes it correct. So: two new tables, and heavy
-- reuse of everything around them — public.memory_policy (2192) by FOREIGN KEY,
-- the profiles ON DELETE CASCADE posture of 2187, the least-privilege function
-- posture of 2190/2213, and the source_ref { table, id } convention of 2183.
--
-- RAW SENSING MUST NOT AUTOMATICALLY BECOME MEMORY
-- ------------------------------------------------
-- This is enforced STRUCTURALLY, not by convention. memory_episodes.state
-- defaults to 'candidate', and memory_episodes_eligibility_check makes it
-- IMPOSSIBLE for a row to sit in 'confirmed' / 'active' / 'archived' / 'merged'
-- without BOTH a significance score and a significance_basis. A detector may
-- therefore write candidates all day; nothing it writes can become Memory until
-- something has assessed outcome/significance. The gate is a CHECK constraint,
-- so it holds against every writer, including a future buggy one.
--
-- REPLAYABLE DETECTION
-- --------------------
-- detection_reason (a code) + detector_version (an integer) + detection_digest
-- (a caller-computed digest of the detector's inputs) make detection auditable
-- and re-runnable: the same detector, at the same version, over the same inputs,
-- yields exactly one episode — enforced by memory_episodes_replay_key. Bumping
-- detector_version deliberately produces a NEW episode rather than silently
-- mutating the old one, so a detector change is visible rather than retroactive.
--
-- INERT BY CONSTRUCTION
-- ---------------------
-- No policy is created (RLS on, deny-default — the 2183 posture), grants go to
-- service_role only, no trigger writes to these tables, no scheduler touches
-- them, no route reads them, and NO FEATURE FLAG IS FLIPPED. In particular
-- `memory_projection` is left exactly as 2183 seeded it: false. These tables can
-- only be reached by a future writer that does not yet exist.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.profiles missing.';
  END IF;
  IF to_regclass('public.memory_policy') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.memory_policy missing — apply 2192 first (the retention classes are referenced by FK, not restated).';
  END IF;
  IF to_regprocedure('public.erase_memory_for_user(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.erase_memory_for_user(uuid) missing — apply 2190 first (this migration extends it).';
  END IF;
  IF to_regprocedure('public.set_updated_at()') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.set_updated_at() missing — expected from 0001_spine.sql.';
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. memory_episodes — a bounded occurrence: what happened, when, where, for
--    whom, on what deterministic detection, at what version.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.memory_episodes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- WHOSE. FK CASCADE mirrors 2187: auth.users → profiles → episode. Belt is the
  -- cascade, braces is erase_memory_for_user below; 2190's comment explains why
  -- both exist (production keeps an anonymised tombstone profile).
  user_id            uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

  -- WHAT happened. A closed vocabulary, deliberately small: an episode kind that
  -- is not listed is a schema change and a decision, not a free-text string.
  episode_kind       text NOT NULL
                       CHECK (episode_kind IN ('visit','stay','meal','activity','journey','gathering','milestone')),
  -- Human-readable, and NULLABLE on purpose: a candidate detected from signals
  -- has no title until something decides what to call it. A NOT NULL here would
  -- force detectors to fabricate one.
  summary            text,

  -- WHEN. Bounded: an occurrence has an extent, which is exactly what separates
  -- it from memory_events' point-in-time action.
  started_at         timestamptz NOT NULL,
  ended_at           timestamptz,
  CONSTRAINT memory_episodes_bounds_check
    CHECK (ended_at IS NULL OR ended_at >= started_at),

  -- WHERE. Text keys, matching memory_events.subject_id: the Experience Graph
  -- keys places and cities by name as well as by uuid.
  place_id           text,
  city               text,
  country            text,

  -- HOW DO WE KNOW — deterministic, replayable detection.
  -- A CODE, not prose: the reason a detector concluded this episode exists.
  detection_reason   text NOT NULL
                       CHECK (detection_reason IN (
                         'user_declared',        -- the person said so
                         'dwell_cluster',        -- co-located signals clustered in time
                         'checkin_sequence',     -- ordered check-ins bounded an occurrence
                         'media_cluster',        -- captured media clustered in time+place
                         'plan_completion',      -- a plan the person attended concluded
                         'contribution_outcome', -- an intel contribution resolved
                         'manual_curation'       -- a human operator asserted it
                       )),
  -- Bump to re-detect rather than to rewrite: a new version yields a NEW episode
  -- under memory_episodes_replay_key, so a detector change is auditable.
  detector_version   integer NOT NULL CHECK (detector_version >= 1),
  -- Caller-computed digest of the detector's INPUTS. Replay identity lives here,
  -- so replay is provable without this table knowing what the inputs were.
  detection_digest   text,

  -- SIGNIFICANCE — the eligibility gate. Raw sensing stops here unless something
  -- assessed why this matters. See memory_episodes_eligibility_check below.
  significance       real CHECK (significance IS NULL OR (significance >= 0 AND significance <= 1)),
  significance_basis text
                       CHECK (significance_basis IS NULL OR significance_basis IN (
                         'user_affirmed',      -- the person confirmed it matters
                         'outcome_recorded',   -- something concluded (a plan attended, a claim resolved)
                         'rarity',             -- first/only occurrence of its kind for this person
                         'corroborated',       -- independent evidence agreed
                         'sustained_duration', -- the occurrence itself was substantial
                         'social_shared'       -- it was shared with, or involved, others
                       )),

  -- LIFECYCLE. The spec's state machine. The vocabulary lives here; the legality
  -- of a TRANSITION lives in the typed TS contract (memoryEpisodeLifecycle.ts) as
  -- a transition table, not as conditionals.
  state              text NOT NULL DEFAULT 'candidate'
                       CHECK (state IN ('candidate','confirmed','active','archived','merged','rejected','deleted')),
  state_changed_at   timestamptz NOT NULL DEFAULT now(),
  -- Entity resolution (§8): the survivor an episode was merged into.
  merged_into_id     uuid REFERENCES public.memory_episodes(id) ON DELETE SET NULL,

  -- PRIVACY POSTURE — the same axes the derived kernel already uses (2183/2192),
  -- restated so an episode is governed the same way a projection is.
  sensitivity        text NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('normal','sensitive')),
  visibility         text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','circle','public')),
  -- REUSE, not restatement: the six classes are memory_policy's data (2192).
  retention_class    text NOT NULL DEFAULT 'trip_context'
                       REFERENCES public.memory_policy(retention_class),

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- ── THE ELIGIBILITY GATE ────────────────────────────────────────────────
  -- A signal may become a CANDIDATE freely. It may not become Memory without a
  -- significance assessment. 'rejected' and 'deleted' are exits, not promotions,
  -- so they are exempt — an episode must be discardable without first being
  -- scored.
  CONSTRAINT memory_episodes_eligibility_check CHECK (
    state IN ('candidate','rejected','deleted')
    OR (significance IS NOT NULL AND significance_basis IS NOT NULL)
  ),
  -- A merge must name its survivor, and only a merge may.
  CONSTRAINT memory_episodes_merge_check CHECK (
    (state = 'merged' AND merged_into_id IS NOT NULL)
    OR (state <> 'merged' AND merged_into_id IS NULL)
  ),
  -- An episode cannot be merged into itself.
  CONSTRAINT memory_episodes_no_self_merge_check CHECK (merged_into_id IS DISTINCT FROM id)
);

-- Replay identity: same person + same detector + same version + same inputs ⇒ one
-- episode. Partial, because a user_declared episode legitimately has no digest.
CREATE UNIQUE INDEX IF NOT EXISTS memory_episodes_replay_key
  ON public.memory_episodes (user_id, detection_reason, detector_version, detection_digest)
  WHERE detection_digest IS NOT NULL;

CREATE INDEX IF NOT EXISTS memory_episodes_user_time_idx
  ON public.memory_episodes (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS memory_episodes_user_state_idx
  ON public.memory_episodes (user_id, state);
CREATE INDEX IF NOT EXISTS memory_episodes_place_idx
  ON public.memory_episodes (place_id)
  WHERE place_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS memory_episodes_merged_into_idx
  ON public.memory_episodes (merged_into_id)
  WHERE merged_into_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_memory_episodes_updated_at ON public.memory_episodes;
CREATE TRIGGER trg_memory_episodes_updated_at
  BEFORE UPDATE ON public.memory_episodes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. memory_evidence — what the episode rests on. Append-only.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.memory_evidence (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id    uuid NOT NULL REFERENCES public.memory_episodes(id) ON DELETE CASCADE,
  -- Denormalised owner. Deliberate: erasure must be able to find evidence by user
  -- in ONE statement without traversing episodes, so a partial failure can never
  -- leave evidence behind after the episode is gone.
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

  -- HOW WELL DO WE KNOW IT. An ordering of certainty — the axis §6 needs and that
  -- nothing in the existing kernel carries.
  truth_level   text NOT NULL
                  CHECK (truth_level IN ('asserted','observed','corroborated','inferred')),
  -- WHAT CLASS OF SOURCE. The EXISTING vocabulary, verbatim from
  -- memory_events.source (2183) — a second, competing provenance vocabulary would
  -- be exactly the duplication §24 forbids.
  source_class  text NOT NULL CHECK (source_class IN ('explicit','system','inferred','live')),

  -- WHERE IT CAME FROM. Text, matching the memory_events source_ref convention:
  -- evidence may cite any canonical row, so a typed FK is impossible by design.
  source_table  text NOT NULL,
  source_id     text NOT NULL,
  source_ref    jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- WHEN THE EVIDENCE ITSELF IS ABOUT. Distinct from recorded_at: evidence about
  -- last Tuesday can be recorded today.
  observed_at   timestamptz,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  weight        real NOT NULL DEFAULT 1.0 CHECK (weight >= 0 AND weight <= 1)
);

-- Append idempotency: one row per (episode, source, truth level). A replayed
-- detector re-citing the same source is a no-op, not a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS memory_evidence_dedupe_idx
  ON public.memory_evidence (episode_id, source_table, source_id, truth_level);
CREATE INDEX IF NOT EXISTS memory_evidence_episode_idx
  ON public.memory_evidence (episode_id);
CREATE INDEX IF NOT EXISTS memory_evidence_user_idx
  ON public.memory_evidence (user_id);

-- Append-only, the 2183 way: block UPDATE, leave DELETE free. DELETE must stay
-- open or the profiles cascade and erase_memory_for_user below cannot purge it —
-- the shared intel_append_only() blocks both and would strand evidence forever.
CREATE OR REPLACE FUNCTION public.memory_evidence_no_update()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  RAISE EXCEPTION 'memory_evidence is append-only: UPDATE is not permitted. A correction is a new evidence row at its own truth_level.';
END
$fn$;

-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE on every NEW public function
-- to anon AND authenticated — trigger functions included (2183's note; the trap
-- that produced a wrong prod replay on 2026-08-28). Revoke at the point of
-- creation or the revoke does not really exist.
REVOKE ALL ON FUNCTION public.memory_evidence_no_update() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_memory_evidence_no_update ON public.memory_evidence;
CREATE TRIGGER trg_memory_evidence_no_update
  BEFORE UPDATE ON public.memory_evidence
  FOR EACH ROW EXECUTE FUNCTION public.memory_evidence_no_update();

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. RLS — on, deny-default, service_role only. The 2183 posture exactly.
-- ═══════════════════════════════════════════════════════════════════════════
-- NO POLICY is created. RLS with zero policies denies every role that is not
-- BYPASSRLS; service_role is, so only the server reaches these rows. anon and
-- authenticated get no grant at all, so a policy added later cannot silently
-- become a reader.
ALTER TABLE public.memory_episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_evidence ENABLE ROW LEVEL SECURITY;

-- service_role IS IN THE REVOKE LIST, and that is the load-bearing part.
-- Supabase ships `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES
-- TO postgres, anon, authenticated, service_role`, so a table created here
-- arrives with ALL granted to all four — service_role included, and that
-- includes UPDATE on memory_evidence. Revoking only anon/authenticated (the
-- 2183 posture) would leave append-only resting on the trigger alone, and the
-- postcondition below would then correctly refuse to let this migration
-- through. So every privilege is revoked first and only the intended set is
-- granted back: the grants below are the WHOLE truth about who may do what,
-- rather than a subset layered over an invisible default.
REVOKE ALL ON public.memory_episodes FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.memory_evidence FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT, SELECT, UPDATE, DELETE ON public.memory_episodes TO service_role;
-- No UPDATE for evidence: append-only is a grant, not only a trigger.
GRANT INSERT, SELECT, DELETE         ON public.memory_evidence TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. ERASURE LINEAGE — extend erase_memory_for_user (2190) to reach the spine.
-- ═══════════════════════════════════════════════════════════════════════════
-- 2190's contract: "one idempotent, atomic purge of every memory artefact a user
-- owns … deliberately NOT dependent on any FK cascade", because production keeps
-- an anonymised tombstone profile and has no profiles→auth.users FK. If the spine
-- relied only on its CASCADE, a forgotten memory would survive in evidence on
-- exactly the production path that matters. So the function is extended.
--
-- The return type gains two columns, which Postgres cannot do in place — hence
-- DROP + CREATE. Nothing reads the returned columns today (AccountDeletionService
-- calls it through must() for the error only), so widening is safe.
DROP FUNCTION IF EXISTS public.erase_memory_for_user(uuid);

CREATE FUNCTION public.erase_memory_for_user(p_user_id uuid)
RETURNS TABLE (
  projections_deleted integer,
  events_deleted      integer,
  feedback_deleted    integer,
  episodes_deleted    integer,
  evidence_deleted    integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  p_del  integer := 0;
  e_del  integer := 0;
  f_del  integer := 0;
  ep_del integer := 0;
  ev_del integer := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN QUERY SELECT 0, 0, 0, 0, 0; RETURN;
  END IF;

  -- feedback first: it references projections (ON DELETE SET NULL would orphan it)
  WITH d AS (DELETE FROM public.memory_feedback WHERE user_id = p_user_id RETURNING 1)
  SELECT count(*)::int INTO f_del FROM d;

  WITH d AS (DELETE FROM public.memory_projections WHERE user_id = p_user_id RETURNING 1)
  SELECT count(*)::int INTO p_del FROM d;

  -- memory_events blocks UPDATE only (2183's trg_memory_events_no_update), so a
  -- DELETE needs no erasure declaration — unlike the intel tables.
  WITH d AS (DELETE FROM public.memory_events WHERE user_id = p_user_id RETURNING 1)
  SELECT count(*)::int INTO e_del FROM d;

  -- ── The provenance spine (2320) ──────────────────────────────────────────
  -- EVIDENCE FIRST, explicitly, by user_id — not by traversing episodes and not
  -- by leaning on the episode CASCADE. Evidence is the thing that must not
  -- outlive a forgotten memory, so it is deleted directly and first: if the
  -- episode delete below ever failed, the evidence would already be gone rather
  -- than orphaned. It also catches evidence whose episode was already removed.
  WITH d AS (DELETE FROM public.memory_evidence WHERE user_id = p_user_id RETURNING 1)
  SELECT count(*)::int INTO ev_del FROM d;

  -- Break inbound merge references before deleting, so a merged-into episode
  -- cannot block the purge. merged_into_id is ON DELETE SET NULL, but the
  -- resulting row would then violate memory_episodes_merge_check, so the state
  -- is settled first. Scoped to this user: a cross-user merge is not possible
  -- today and must not be silently repaired here if it ever becomes so.
  UPDATE public.memory_episodes
     SET state = 'rejected', merged_into_id = NULL, state_changed_at = now()
   WHERE user_id = p_user_id
     AND state = 'merged'
     AND merged_into_id IN (SELECT id FROM public.memory_episodes WHERE user_id = p_user_id);

  WITH d AS (DELETE FROM public.memory_episodes WHERE user_id = p_user_id RETURNING 1)
  SELECT count(*)::int INTO ep_del FROM d;

  RETURN QUERY SELECT p_del, e_del, f_del, ep_del, ev_del;
END
$fn$;

-- 2190: "ANY future migration that DROP/CREATEs one of these MUST repeat this
-- block." Repeating it.
REVOKE ALL ON FUNCTION public.erase_memory_for_user(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.erase_memory_for_user(uuid) TO service_role;

COMMENT ON FUNCTION public.erase_memory_for_user(uuid) IS
  'Idempotent, atomic purge of all memory state for a user: projections, events, feedback (2190) AND the provenance spine — episodes and evidence (2320). Called by AccountDeletionService; deliberately independent of any FK cascade, because production keeps an anonymised tombstone profile and has no profiles->auth.users FK. Evidence is deleted first and by user_id directly, so a memory the user forgets cannot survive in evidence.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Documentation
-- ═══════════════════════════════════════════════════════════════════════════
COMMENT ON TABLE public.memory_episodes IS
  'Highlights/Memories spec §6-§9 provenance spine: a BOUNDED OCCURRENCE — what happened, when, where, for whom — with a deterministic detection reason code and detector version so detection is replayable. Distinct from memory_events (point actions), memory_projections (standing beliefs), memories/memory_items (a user-authored media album), passport_memories (a suggestion feed) and compass_memories (a chat store). Inert: no writer exists.';
COMMENT ON COLUMN public.memory_episodes.state IS
  'Lifecycle: candidate -> confirmed -> active -> archived, with merged/rejected/deleted as exits. This CHECK owns the vocabulary; transition LEGALITY is data in src/memory/memoryEpisodeLifecycle.ts, not conditionals.';
COMMENT ON COLUMN public.memory_episodes.detection_reason IS
  'Deterministic reason CODE for why a detector concluded this episode exists. With detector_version and detection_digest it makes detection replayable and auditable.';
COMMENT ON COLUMN public.memory_episodes.detector_version IS
  'Bumped when detection logic changes. A new version yields a NEW episode under memory_episodes_replay_key rather than silently rewriting the old one, so detector changes are visible rather than retroactive.';
COMMENT ON COLUMN public.memory_episodes.significance IS
  'The eligibility gate. memory_episodes_eligibility_check makes it impossible to leave the candidate state without BOTH significance and significance_basis: raw sensing may become a candidate, never Memory, without an outcome/significance assessment.';
COMMENT ON COLUMN public.memory_episodes.merged_into_id IS
  'Entity resolution (§8): the surviving episode this one was merged into. Required exactly when state = merged.';
COMMENT ON COLUMN public.memory_episodes.retention_class IS
  'FK to memory_policy (2192). The six retention classes are referenced, never restated — a second copy would be a second source of truth.';
COMMENT ON TABLE public.memory_evidence IS
  'Highlights/Memories spec §6: what an episode rests on. Append-only (UPDATE blocked by trigger AND withheld by grant); a correction is a new row at its own truth_level. Deleted directly by user_id in erase_memory_for_user, so a forgotten memory cannot survive in evidence.';
COMMENT ON COLUMN public.memory_evidence.truth_level IS
  'Certainty ordering: asserted < observed < corroborated, with inferred as the weakest. The axis the existing kernel lacks.';
COMMENT ON COLUMN public.memory_evidence.source_class IS
  'The EXISTING provenance source vocabulary, verbatim from memory_events.source (2183). Not a competing second vocabulary.';
COMMENT ON COLUMN public.memory_evidence.user_id IS
  'Denormalised from the episode on purpose: erasure finds evidence by user in one statement, so a partial failure can never leave evidence behind after the episode is gone.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Postconditions — prove the migration did what it claims
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_src text;
BEGIN
  IF to_regclass('public.memory_episodes') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_episodes not created';
  END IF;
  IF to_regclass('public.memory_evidence') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_evidence not created';
  END IF;

  -- RLS on, and NO policy — deny-default is the whole access story here.
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.memory_episodes'::regclass AND relrowsecurity)
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.memory_evidence'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: RLS not enabled on the provenance spine';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid IN ('public.memory_episodes'::regclass, 'public.memory_evidence'::regclass)) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a policy exists on the provenance spine — it must be deny-default until a reader is designed';
  END IF;

  -- Not reachable by anon/authenticated at all.
  IF has_table_privilege('anon', 'public.memory_episodes', 'SELECT')
     OR has_table_privilege('authenticated', 'public.memory_episodes', 'SELECT')
     OR has_table_privilege('anon', 'public.memory_evidence', 'SELECT')
     OR has_table_privilege('authenticated', 'public.memory_evidence', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: provenance spine readable by anon/authenticated';
  END IF;

  -- Evidence must not be UPDATE-able even by service_role.
  IF has_table_privilege('service_role', 'public.memory_evidence', 'UPDATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_evidence is UPDATE-able — append-only must hold at the grant, not only the trigger';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.memory_evidence'::regclass
                   AND tgname = 'trg_memory_evidence_no_update' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_evidence append-only trigger missing';
  END IF;

  -- The eligibility gate must exist, or raw sensing becomes Memory.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_episodes'::regclass
                   AND conname = 'memory_episodes_eligibility_check') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_episodes_eligibility_check missing — a signal could become Memory without a significance assessment';
  END IF;

  -- Retention classes are referenced, not restated.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_episodes'::regclass
                   AND contype = 'f' AND confrelid = 'public.memory_policy'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_episodes.retention_class does not reference memory_policy';
  END IF;

  -- Erasure actually reaches the spine (prove by reading the installed body, so a
  -- future edit that drops these lines fails here rather than in production).
  v_src := pg_get_functiondef(to_regprocedure('public.erase_memory_for_user(uuid)'));
  IF v_src NOT LIKE '%public.memory_evidence%' OR v_src NOT LIKE '%public.memory_episodes%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: erase_memory_for_user does not purge the provenance spine';
  END IF;

  -- The 2190 least-privilege trap, re-checked for EVERY memory function.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND (p.proname LIKE 'memory\_%' OR p.proname LIKE 'project\_%memory%')
      AND (has_function_privilege('anon', p.oid, 'EXECUTE')
           OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a memory function is executable by anon/authenticated (Supabase default grants after DROP/CREATE — re-REVOKE it)';
  END IF;

  -- Inert: the projection flag must be exactly as 2183 left it.
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'memory_projection' AND enabled) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_projection is enabled — this migration must not flip it';
  END IF;
END $$;

COMMIT;

-- ROLLBACK (manual, not run):
--   DROP TABLE IF EXISTS public.memory_evidence;
--   DROP TABLE IF EXISTS public.memory_episodes;
--   DROP FUNCTION IF EXISTS public.memory_evidence_no_update();
--   -- then re-apply 2190's erase_memory_for_user definition verbatim.
