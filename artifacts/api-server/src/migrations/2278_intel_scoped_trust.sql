-- 2278_intel_scoped_trust.sql
-- Intelligence Gathering unit I4a — closed loop A, part 2:
--   §15 SCOPED TRUST storage, the §21 domain-event idempotency indexes, and the
--   erasure function widened to the two I4a ledgers.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). IG lane 2277/2278.
-- Additive + idempotent. Safe to re-run. No new flag: the closed loop has ONE
-- switch, intel_outcome_attribution_enabled (2277, seeded OFF), and everything
-- here is written only by the pass that flag gates.
--
-- ── RECONCILIATION WITH THE 2130 RULING ─────────────────────────────────────
-- 2130's header declines intel_expertise_scopes: "would be the sixth
-- verification ladder. Scope the existing Trust services instead." This
-- migration RESPECTS the ruling's intent and states where it cannot host the
-- spec literally:
--
--   * The existing engine (services/trust, trust_profiles) holds NINE category
--     scores per user, one row per user. A §15 scope key is
--       geography × claim_family × time_band × traveler_mode × season
--     — five dimensions, thousands of cells per user. trust_profiles has no
--     column to put a per-scope number in, and adding thousands of columns is
--     not "scoping the existing services"; it is breaking them.
--
--   * So the per-scope STATE lives in public.intel_scoped_trust — a DERIVED
--     calibration fold keyed (actor, scope), recomputable from
--     intel_attributions (2277). It is NOT a ladder: it has no levels, no
--     restrictions, no appeals path, no public numeric read (the public read
--     is scoped BADGES, derived read-only in src/lib/intelScopedTrust.ts —
--     "Public UI shows scoped badges and evidence portfolio, not a universal
--     numeric Trust score"). It carries no verification tier and no
--     public_level; it cannot become a sixth ladder because nothing in it is
--     a rung.
--
--   * AND every graded outcome is ALSO bridged into the existing engine as a
--     trust_events row under the existing `guide_accuracy` category (Table 23
--     'outcome success' / 'materially incorrect confident claim'), so
--     trust_profiles — the ONE user-level trust — keeps being the consumer,
--     with its own caps, dedup and review queue untouched. The scoped table
--     FEEDS the existing services; it does not compete with them. That is the
--     ruling, applied to a key the ruling's target table cannot hold.
--
-- ── WHAT THIS CREATES ───────────────────────────────────────────────────────
--   1. public.intel_scoped_trust — one row per (actor_id, scope_key); trust in
--      [0,100]; graded-outcome tallies; a running calibration error; and the
--      application CURSOR (last_attribution_at, last_attribution_id) that
--      makes the fold replayable and at-most-once per attribution row without
--      touching the append-only ledger. Mutable by design (a derived fold, like
--      intel_claims/intel_state_snapshots — 2130 §"leaves derived tables
--      updatable"). Deny-default RLS, service_role only. NOT client-readable:
--      the internal number is purpose-limited; clients get badges via the API
--      layer, never the row.
--   2. Two partial UNIQUE indexes on canonical_events making the §21 domain
--      events idempotent at the database:
--        intel.observation.recorded  once per observation_id
--        intel.claim.promoted        once per claim_id
--      (intel.state.changed legitimately repeats per snapshot and is not
--      constrained; the projection pass emits it only on a real diff.)
--   3. erase_intel_for_actor (2130) re-created as a SUPERSET: the same three
--      deletes, plus intel_attributions (2277) and intel_scoped_trust rows for
--      the actor, inside the same declared-erasure transaction. Still the ONE
--      erasure entry point, still service_role only. The profiles cascade never
--      fires under the tombstone (the 2172/2187 lesson), so the explicit delete
--      is what actually removes a departed contributor's derived trust.
--
-- RUNTIME EFFECT: NONE until intel_outcome_attribution_enabled is pressed.
-- Nothing reads or writes intel_scoped_trust while it is off; the indexes only
-- constrain rows no writer produces yet (the domain-event emitters ship in the
-- same unit, gated on intel_claim_projection_crowd like the passes they ride).
--
-- RLS DISPOSITION (recorded here because rlsDispositions.ts is baseline-generated
-- and its staleness test rejects post-baseline tables until recapture):
--   intel_scoped_trust — DENY_ALL_BY_DESIGN: RLS enabled, zero policies;
--   service_role only. Registered in deletionDispositions.ts as
--   ERASED_BY_CASCADE (via erase_intel_for_actor) + POST_BASELINE_TABLES.

BEGIN;

-- ── Preconditions ───────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.intel_attributions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.intel_attributions does not exist. Apply 2277 first.';
  END IF;
  IF to_regclass('public.canonical_events') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.canonical_events does not exist. Apply 2120 first.';
  END IF;
  IF to_regprocedure('public.erase_intel_for_actor(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: erase_intel_for_actor(uuid) missing (2130).';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.canonical_events'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%intel.observation.recorded%'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: canonical_events verb CHECK lacks the intel domain verbs. Apply 2277 first.';
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. intel_scoped_trust — §15 per-scope calibration fold (derived, mutable)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.intel_scoped_trust (
  -- The CONTRIBUTOR whose scoped reliability this is (intel_attributions.actor_id).
  actor_id            uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- src/lib/intelScopedTrust.ts buildScopeKey():
  --   geo=<cc:city>|fam=<claim_family>|band=<time_band>|mode=<traveler_mode>|season=<season>
  scope_key           text NOT NULL,
  -- trust_next = clamp(trust_prev + learning_rate*(outcome_score - expected_accuracy)*evidence_weight, 0, 100)
  trust               numeric NOT NULL DEFAULT 50,
  -- Graded outcomes folded so far (did_not_go carries no grade and is not counted).
  outcomes            integer NOT NULL DEFAULT 0,
  successes           integer NOT NULL DEFAULT 0,
  contradictions      integer NOT NULL DEFAULT 0,
  -- Running mean of |outcome_score - expected_accuracy| over the rows that had
  -- both (calibration_samples is that denominator). NULL until one such row.
  calibration_error   numeric,
  calibration_samples integer NOT NULL DEFAULT 0,
  -- Application cursor: the last intel_attributions row folded, ordered by
  -- (computed_at, id). Rows at or before the cursor are never folded twice; an
  -- optimistic UPDATE keyed on the cursor makes a concurrent pass lose cleanly.
  last_attribution_id uuid REFERENCES public.intel_attributions(id) ON DELETE SET NULL,
  last_attribution_at timestamptz,
  algorithm_version   text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_updated_at     timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (actor_id, scope_key),
  CONSTRAINT intel_scoped_trust_trust_range CHECK (trust >= 0 AND trust <= 100),
  CONSTRAINT intel_scoped_trust_counts_nonneg
    CHECK (outcomes >= 0 AND successes >= 0 AND contradictions >= 0 AND calibration_samples >= 0),
  CONSTRAINT intel_scoped_trust_calibration_range
    CHECK (calibration_error IS NULL OR (calibration_error >= 0 AND calibration_error <= 1)),
  CONSTRAINT intel_scoped_trust_scope_key_check CHECK (length(scope_key) BETWEEN 1 AND 200)
);

CREATE INDEX IF NOT EXISTS intel_scoped_trust_scope
  ON public.intel_scoped_trust (scope_key, trust DESC);

-- RLS deny-default; REVOKE-first (Supabase default-grants ALL to service_role).
-- DELETE is granted because the erasure function below (SECURITY DEFINER, but
-- the grant is what the deletion worker's role needs for a direct clean-up if
-- the function is ever bypassed) must be able to remove a departed actor's rows.
ALTER TABLE public.intel_scoped_trust ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_scoped_trust FROM PUBLIC;
REVOKE ALL ON public.intel_scoped_trust FROM anon;
REVOKE ALL ON public.intel_scoped_trust FROM authenticated;
REVOKE ALL ON public.intel_scoped_trust FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.intel_scoped_trust TO service_role;

COMMENT ON TABLE public.intel_scoped_trust IS
  'I4a §15 scoped trust: a DERIVED per-(actor, scope) calibration fold over intel_attributions, replayable via the (last_attribution_at, last_attribution_id) cursor. Not a verification ladder (2130 ruling): no levels, no restrictions, no public numeric read — clients get read-only badges. Every graded outcome is also bridged to trust_events (guide_accuracy) so trust_profiles stays the one user-level trust. service_role only.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. §21 domain events — idempotent at the database
-- ═══════════════════════════════════════════════════════════════════════════
-- Scoped to exactly the rows src/lib/intelDomainEvents.ts writes. The emitters
-- treat 23505 as "already recorded", so an at-least-once pass never duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS canonical_events_intel_observation_recorded_once
  ON public.canonical_events (((payload->'intel'->>'observation_id')))
  WHERE verb = 'intel.observation.recorded'
    AND (payload->'intel'->>'observation_id') IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS canonical_events_intel_claim_promoted_once
  ON public.canonical_events (((payload->'intel'->>'claim_id')))
  WHERE verb = 'intel.claim.promoted'
    AND (payload->'intel'->>'claim_id') IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. erase_intel_for_actor — the same entry point, widened to the I4a ledgers
-- ═══════════════════════════════════════════════════════════════════════════
-- SUPERSET of 2130's body (same three deletes, same order, same declaration),
-- plus the two I4a tables. CREATE OR REPLACE keeps the function's owner and
-- the 2130 grants (service_role EXECUTE only). Still no filter the caller can
-- widen, still no "erase everything" variant.
--
--   intel_attributions rows for the actor already cascade from their
--   observations (observation_id ON DELETE CASCADE, permitted by the 2277
--   append-only trigger because the erasure is declared); the explicit delete
--   makes the fate visible in the returned rows and covers any row whose
--   observation was itself deleted earlier.
--   intel_scoped_trust is not append-only; its profiles cascade never fires
--   under the tombstone, so this delete is the one that removes it.
CREATE OR REPLACE FUNCTION public.erase_intel_for_actor(p_actor_id uuid)
RETURNS TABLE (table_name text, deleted_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  n bigint;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'erase_intel_for_actor: actor id is required';
  END IF;

  -- Scoped to this transaction only.
  PERFORM set_config('portava.erasure_in_progress', 'on', true);

  -- I4a derived state first: it references intel_attributions (cursor FK) and
  -- intel_attributions references intel_observations.
  DELETE FROM public.intel_scoped_trust WHERE actor_id = p_actor_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'intel_scoped_trust'; deleted_count := n; RETURN NEXT;

  DELETE FROM public.intel_attributions WHERE actor_id = p_actor_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'intel_attributions'; deleted_count := n; RETURN NEXT;

  DELETE FROM public.intel_evidence WHERE actor_id = p_actor_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'intel_evidence'; deleted_count := n; RETURN NEXT;

  DELETE FROM public.intel_confirmations WHERE actor_id = p_actor_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'intel_confirmations'; deleted_count := n; RETURN NEXT;

  DELETE FROM public.intel_observations WHERE actor_id = p_actor_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'intel_observations'; deleted_count := n; RETURN NEXT;

  -- Claims and snapshots are DERIVED and carry no actor column: they are
  -- aggregate beliefs about a place, not personal data, and are recomputed from
  -- the surviving observations. Deleting them here would destroy other people's
  -- contributions. Recomputation after erasure is IG-04's responsibility.
  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.erase_intel_for_actor(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erase_intel_for_actor(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.erase_intel_for_actor(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.erase_intel_for_actor(uuid) TO service_role;

COMMENT ON FUNCTION public.erase_intel_for_actor(uuid) IS
  'The ONE intel erasure entry point (2130, widened by 2278): deletes one actor''s rows from intel_scoped_trust, intel_attributions, intel_evidence, intel_confirmations and intel_observations inside a declared erasure (portava.erasure_in_progress, transaction-scoped). Derived claims/snapshots are not deleted. service_role only.';

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $$
DECLARE has_table int; rls_off int; has_idx int; body text; client_grants int;
BEGIN
  SELECT count(*) INTO has_table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = 'intel_scoped_trust';
  IF has_table <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_scoped_trust not created';
  END IF;

  SELECT count(*) INTO rls_off FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'intel_scoped_trust' AND NOT c.relrowsecurity;
  IF rls_off > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_scoped_trust has RLS disabled';
  END IF;

  SELECT count(*) INTO client_grants FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'intel_scoped_trust'
     AND grantee IN ('anon', 'authenticated', 'PUBLIC');
  IF client_grants <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_scoped_trust carries % client grant(s); it must be service_role only', client_grants;
  END IF;

  SELECT count(*) INTO has_idx FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'canonical_events'
     AND indexname IN ('canonical_events_intel_observation_recorded_once', 'canonical_events_intel_claim_promoted_once');
  IF has_idx <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: domain-event idempotency indexes missing (found %)', has_idx;
  END IF;

  SELECT pg_get_functiondef('public.erase_intel_for_actor(uuid)'::regprocedure) INTO body;
  IF body NOT LIKE '%intel_scoped_trust%' OR body NOT LIKE '%intel_attributions%'
     OR body NOT LIKE '%intel_observations%' OR body NOT LIKE '%erasure_in_progress%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: erase_intel_for_actor does not cover the I4a ledgers inside a declared erasure';
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- REVERSAL (manual)
-- ═══════════════════════════════════════════════════════════════════════════
--   -- the scoped fold is derived: dropping it loses nothing that cannot be
--   -- recomputed from intel_attributions.
--   DROP TABLE IF EXISTS public.intel_scoped_trust;
--   DROP INDEX IF EXISTS public.canonical_events_intel_observation_recorded_once;
--   DROP INDEX IF EXISTS public.canonical_events_intel_claim_promoted_once;
--   -- erase_intel_for_actor: re-run 2130's CREATE OR REPLACE to narrow it again
--   -- (only after the two tables above are gone).
