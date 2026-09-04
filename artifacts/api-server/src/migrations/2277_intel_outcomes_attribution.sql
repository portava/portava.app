-- 2277_intel_outcomes_attribution.sql
-- Intelligence Gathering unit I4a — closed loop A, part 1:
--   outcome EVENTS on the canonical spine, the append-only ATTRIBUTION ledger,
--   the §21 intel domain verbs, and the attribution job's flag (OFF).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). IG lane 2277/2278.
-- Additive + idempotent. Safe to re-run.
--
-- ── RECONCILIATION WITH THE 2130 RULING ─────────────────────────────────────
-- 2130's header declines four spec tables "in favour of canonical_events",
-- including intel_outcomes ("canonical_events already carries arrival,
-- completion, rejection and satisfaction, and 2123 already files them as
-- family='outcome'. Record outcomes there."). This migration RESPECTS that:
--
--   * An intel OUTCOME is a canonical_events row (verb ∈ arrival / completion /
--     rejection — the existing 'outcome' family) whose payload carries
--       intel: { snapshot_id, claim_id, subject_id, outcome, experience_rating?, served_at }
--     — the shape shared with unit I4b, which reads it. No intel_outcomes table.
--     The Appendix-A outcome enum (better / slightly_better / same / worse /
--     did_not_go / could_not_enter) is EXPRESSIBLE on the existing verbs
--     (completion for the four "went" outcomes, rejection for did_not_go,
--     arrival for could_not_enter), so the outcome enum is NOT added to the verb
--     CHECK — it lives in payload.intel.outcome, validated by
--     src/lib/intelOutcomes.ts before insert.
--
--   * What IS added to the verb CHECK are the three §21 DOMAIN verbs
--     (intel.observation.recorded / intel.claim.promoted / intel.state.changed).
--     They are pipeline transitions, not traveler interactions, and cannot be
--     expressed on any existing verb without lying about what happened. They
--     ride the same spine so lineage stays in one table — the ruling's intent.
--
--   * intel_attributions is DERIVED state (Table 22 weights joining an outcome
--     event to the served claim's input observations), which the ruling does
--     not preclude: it is not a truth store, not a second outcome store, and it
--     is recomputable from canonical_events + intel_*. The spec's own name for
--     it is intel_attribution_entries ("Claim-to-commercial/outcome lineage").
--     It is append-only because an attribution is a computed FACT about a
--     finalized outcome at a stated algorithm version; a re-computation is a
--     new row under a new algorithm_version, never a rewrite.
--
-- ── WHAT THIS CREATES ───────────────────────────────────────────────────────
--   1. canonical_events.verb CHECK widened with the three domain verbs.
--   2. A partial UNIQUE index making (actor, snapshot) outcomes idempotent at
--      the database — the route dedups, the index makes the dedup race-safe.
--   3. canonical_event_families view (2123) re-created with a fifth family,
--      'domain', mirroring src/lib/eventFamilies.ts VERB_FAMILY exactly.
--   4. public.intel_attributions — append-only, deny-default RLS, service_role
--      INSERT+SELECT only. FKs: profiles (contributor), intel_claims,
--      intel_observations, canonical_events. The contributor's rows are erased
--      with their observations: intel_observations ON DELETE CASCADE, fired
--      inside erase_intel_for_actor's declared-erasure transaction, which the
--      2130 append-only trigger (reused here) permits. The OUTCOME REPORTER is
--      not named on this table at all — their identity stays on the spine row.
--   5. Flag intel_outcome_attribution_enabled, seeded OFF. Read by
--      src/lib/intelAttributionScheduler.ts (isFlagEnabled, fail-closed) and by
--      src/lib/intelRewardScheduler.ts to switch the reward oracle from
--      "served snapshot exists" to "finalized attribution row exists".
--
-- RUNTIME EFFECT: NONE until the flag is pressed. POST /v1/intel/outcomes writes
-- spine rows (gated on intel_claim_projection_crowd — no snapshot can have been
-- served without it); nothing reads intel_attributions while the flag is off.
--
-- RLS DISPOSITION (recorded here because rlsDispositions.ts is baseline-generated
-- and its staleness test rejects post-baseline tables until recapture):
--   intel_attributions — DENY_ALL_BY_DESIGN: RLS enabled, zero policies;
--   service_role only. Registered in deletionDispositions.ts as
--   ERASED_BY_CASCADE + POST_BASELINE_TABLES.

BEGIN;

-- ── Preconditions ───────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.canonical_events') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.canonical_events does not exist. Apply 2120 first.';
  END IF;
  IF to_regclass('public.canonical_event_families') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.canonical_event_families does not exist. Apply 2123 first.';
  END IF;
  IF to_regclass('public.intel_claims') IS NULL OR to_regclass('public.intel_observations') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: intel_claims / intel_observations missing. Apply 2130 first.';
  END IF;
  IF to_regprocedure('public.intel_append_only()') IS NULL
     OR to_regprocedure('public.intel_append_only_stmt()') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: intel_append_only trigger functions missing (2130).';
  END IF;
  IF to_regclass('public.profiles') IS NULL OR to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: profiles / feature_flags missing.';
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Widen the verb CHECK with the §21 domain verbs
-- ═══════════════════════════════════════════════════════════════════════════
-- The 2120 CHECK is an inline column constraint (auto-named). Drop whichever
-- CHECK constrains `verb`, then add the widened one under a stable name, so a
-- re-run is a no-op in effect. ADD CONSTRAINT validates existing rows; every
-- existing row satisfies the superset.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.canonical_events'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%verb%'
  LOOP
    EXECUTE format('ALTER TABLE public.canonical_events DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.canonical_events
  ADD CONSTRAINT canonical_events_verb_check CHECK (verb IN (
    'impression','open','save','join','direction',
    'arrival','completion','rejection','satisfaction',
    'intel.observation.recorded','intel.claim.promoted','intel.state.changed'));

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. One outcome per (reporter, served snapshot) — race-safe idempotency
-- ═══════════════════════════════════════════════════════════════════════════
-- Scoped to exactly the rows lib/intelOutcomes.ts writes: an outcome-family
-- verb carrying payload.intel.snapshot_id. No other writer produces that shape,
-- so no other event is constrained. The route treats 23505 as a replay.
CREATE UNIQUE INDEX IF NOT EXISTS canonical_events_intel_outcome_once
  ON public.canonical_events (actor_id, ((payload->'intel'->>'snapshot_id')))
  WHERE verb IN ('arrival','completion','rejection')
    AND (payload->'intel'->>'snapshot_id') IS NOT NULL;

-- Outcome/domain readers (the attribution job, I4b) slice by verb + occurred_at,
-- which 2120's canonical_events_verb_occurred_at already serves.

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. canonical_event_families — fifth family 'domain'
-- ═══════════════════════════════════════════════════════════════════════════
-- Mirrors src/lib/eventFamilies.ts VERB_FAMILY exactly (pinned by
-- eventFamilies.test.ts + intelDomainEvents.test.ts). security_invoker stays
-- load-bearing: the view must evaluate canonical_events RLS as the caller.
CREATE OR REPLACE VIEW public.canonical_event_families
  WITH (security_invoker = true) AS
SELECT
  ce.*,
  CASE ce.verb
    WHEN 'impression'                 THEN 'exposure'
    WHEN 'open'                       THEN 'action'
    WHEN 'save'                       THEN 'action'
    WHEN 'join'                       THEN 'action'
    WHEN 'direction'                  THEN 'action'
    WHEN 'arrival'                    THEN 'outcome'
    WHEN 'completion'                  THEN 'outcome'
    WHEN 'rejection'                  THEN 'outcome'
    WHEN 'satisfaction'               THEN 'satisfaction'
    WHEN 'intel.observation.recorded' THEN 'domain'
    WHEN 'intel.claim.promoted'       THEN 'domain'
    WHEN 'intel.state.changed'        THEN 'domain'
  END AS family
FROM public.canonical_events ce;

COMMENT ON VIEW public.canonical_event_families IS
  'Read model over canonical_events tagging each event with its family (exposure/action/outcome/satisfaction/domain). security_invoker=true so canonical_events RLS is enforced for the querying role. verb->family mirrors src/lib/eventFamilies.ts VERB_FAMILY (2123 + 2277).';

REVOKE ALL ON public.canonical_event_families FROM PUBLIC;
REVOKE ALL ON public.canonical_event_families FROM anon;
REVOKE ALL ON public.canonical_event_families FROM authenticated;
REVOKE ALL ON public.canonical_event_families FROM service_role;
GRANT SELECT ON public.canonical_event_families TO authenticated;
GRANT SELECT ON public.canonical_event_families TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. intel_attributions — Table 22 lineage, append-only
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.intel_attributions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The outcome this attribution is derived from (a canonical_events row whose
  -- payload.intel is the shared outcome envelope). Plain FK: spine rows are
  -- never deleted (2120 blocks DELETE), so no cascade action is ever exercised.
  outcome_event_id  uuid NOT NULL REFERENCES public.canonical_events(id),
  claim_id          uuid NOT NULL REFERENCES public.intel_claims(id) ON DELETE CASCADE,
  observation_id    uuid NOT NULL REFERENCES public.intel_observations(id) ON DELETE CASCADE,
  -- The CONTRIBUTOR credited (intel_observations.actor_id). Never the reporter.
  actor_id          uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- Table 22 touch and its normalized weight (Σ per outcome ≤ 1.0).
  touch             text NOT NULL,
  weight            numeric NOT NULL,
  -- Appendix-A outcome copied from the event for scope/trust reads without a
  -- JSON join; outcome_score is the v1 accuracy grade (null for did_not_go).
  outcome           text NOT NULL,
  outcome_score     numeric,
  -- Expected accuracy = the served confidence recorded on the outcome event's
  -- envelope (canonical_events.confidence), the §15 calibration target.
  expected_accuracy numeric,
  -- Table 22 counterfactual feedback ("would you have made the same choice
  -- without this?") — TRUE discounts the weight to the pre-committed band.
  counterfactual    boolean NOT NULL DEFAULT false,
  -- The outcome CONTRADICTS the served state (worse / could_not_enter). Recorded
  -- for the correction path; claims are never mutated by this unit.
  contradiction     boolean NOT NULL DEFAULT false,
  -- §15 scope key (geography × claim_family × time_band × traveler_mode × season)
  -- at attribution time, so scoped trust is replayable from this ledger.
  scope_key         text NOT NULL,
  algorithm_version text NOT NULL,
  computed_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT intel_attributions_touch_check
    CHECK (touch IN ('direct_paid_answer','go_tap','compass_explanation','impression','pre_committed')),
  CONSTRAINT intel_attributions_weight_range CHECK (weight >= 0 AND weight <= 1),
  CONSTRAINT intel_attributions_outcome_check
    CHECK (outcome IN ('better','slightly_better','same','worse','did_not_go','could_not_enter')),
  CONSTRAINT intel_attributions_outcome_score_range
    CHECK (outcome_score IS NULL OR (outcome_score >= 0 AND outcome_score <= 1)),
  CONSTRAINT intel_attributions_expected_accuracy_range
    CHECK (expected_accuracy IS NULL OR (expected_accuracy >= 0 AND expected_accuracy <= 1)),
  CONSTRAINT intel_attributions_scope_key_check CHECK (length(scope_key) BETWEEN 1 AND 200)
);

-- One attribution per (outcome, contributing observation) per algorithm version:
-- the job's anti-join key, and the at-most-once guarantee under replay.
CREATE UNIQUE INDEX IF NOT EXISTS intel_attributions_once
  ON public.intel_attributions (outcome_event_id, observation_id, algorithm_version);
CREATE INDEX IF NOT EXISTS intel_attributions_actor_computed
  ON public.intel_attributions (actor_id, computed_at DESC);
CREATE INDEX IF NOT EXISTS intel_attributions_claim
  ON public.intel_attributions (claim_id);
CREATE INDEX IF NOT EXISTS intel_attributions_observation
  ON public.intel_attributions (observation_id);
CREATE INDEX IF NOT EXISTS intel_attributions_scope
  ON public.intel_attributions (actor_id, scope_key, computed_at DESC);

-- Append-only, 2130 shape: UPDATE never; DELETE only inside a declared erasure
-- (the intel_observations cascade inside erase_intel_for_actor); TRUNCATE never.
DROP TRIGGER IF EXISTS intel_attributions_no_update_delete ON public.intel_attributions;
CREATE TRIGGER intel_attributions_no_update_delete
  BEFORE UPDATE OR DELETE ON public.intel_attributions
  FOR EACH ROW EXECUTE FUNCTION public.intel_append_only();
DROP TRIGGER IF EXISTS intel_attributions_no_update_delete_stmt ON public.intel_attributions;
CREATE TRIGGER intel_attributions_no_update_delete_stmt
  BEFORE UPDATE OR DELETE ON public.intel_attributions
  FOR EACH STATEMENT EXECUTE FUNCTION public.intel_append_only_stmt();
DROP TRIGGER IF EXISTS intel_attributions_no_truncate ON public.intel_attributions;
CREATE TRIGGER intel_attributions_no_truncate
  BEFORE TRUNCATE ON public.intel_attributions
  FOR EACH STATEMENT EXECUTE FUNCTION public.intel_append_only();

-- RLS deny-default; REVOKE-first (Supabase default-grants ALL to service_role).
ALTER TABLE public.intel_attributions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_attributions FROM PUBLIC;
REVOKE ALL ON public.intel_attributions FROM anon;
REVOKE ALL ON public.intel_attributions FROM authenticated;
REVOKE ALL ON public.intel_attributions FROM service_role;
GRANT INSERT, SELECT ON public.intel_attributions TO service_role;

COMMENT ON TABLE public.intel_attributions IS
  'I4a: append-only Table-22 attribution ledger joining an outcome event (canonical_events, payload.intel) to the served claim''s input observations. Derived, replayable, algorithm-versioned. Contributor rows erase with their observations (declared-erasure cascade). No client grant.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Flag — the attribution job, OFF
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'intel_outcome_attribution_enabled',
    false,
    'I4a closed loop. OFF (the seed): lib/intelAttributionScheduler.ts writes nothing and lib/intelRewardScheduler.ts keeps its pre-I4a oracle (a served snapshot counts as a finalized outcome). ON: outcome events are joined to the served claim''s input observations and written to intel_attributions (Table 22 weights, counterfactual + contradiction flags), scoped trust (2278) is updated from those rows, and the reward oracle REQUIRES a finalized non-contradicting attribution row before booking. Fail-closed via isFlagEnabled.'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $$
DECLARE has_verb int; has_table int; rls_off int; has_family int; on_count int; present int;
BEGIN
  SELECT count(*) INTO has_verb FROM pg_constraint
   WHERE conrelid = 'public.canonical_events'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%intel.state.changed%';
  IF has_verb <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: canonical_events verb CHECK does not carry the intel domain verbs (found % matching constraints)', has_verb;
  END IF;

  SELECT count(*) INTO has_table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = 'intel_attributions';
  IF has_table <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_attributions not created';
  END IF;

  SELECT count(*) INTO rls_off FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'intel_attributions' AND NOT c.relrowsecurity;
  IF rls_off > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_attributions has RLS disabled';
  END IF;

  SELECT count(*) INTO has_family FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'canonical_event_families' AND column_name = 'family';
  IF has_family <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: canonical_event_families lost its family column';
  END IF;

  SELECT count(*) INTO present FROM public.feature_flags WHERE flag = 'intel_outcome_attribution_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_outcome_attribution_enabled flag not present after seed';
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags
   WHERE flag = 'intel_outcome_attribution_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_outcome_attribution_enabled seeded ON — the attribution job must ship OFF';
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- REVERSAL (manual)
-- ═══════════════════════════════════════════════════════════════════════════
--   UPDATE public.feature_flags SET enabled = false WHERE flag = 'intel_outcome_attribution_enabled';
--   -- only if abandoning the unit:
--   DROP TABLE IF EXISTS public.intel_attributions;
--   DROP INDEX IF EXISTS public.canonical_events_intel_outcome_once;
--   -- the widened verb CHECK and the 'domain' family are harmless to leave;
--   -- narrowing the CHECK again requires that no domain-verb rows exist.
