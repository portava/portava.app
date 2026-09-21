-- 2430_intel_live_scope_promotion_writer.sql
-- The ONE writer for intel_live_promoted_scopes: provenance, idempotency,
-- expiry and withdrawal for the IG-09 per-scope Live allowlist.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2430.
-- Rollback: db/rollback/2026-09-07-2430-intel-live-scope-promotion-writer-rollback.sql
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THIS EXISTS
-- ══════════════════════════════════════════════════════════════════════════════
-- 2179 created intel_live_promoted_scopes as the per-scope allowlist that
-- lib/liveClaimRead.ts requires before ANY live claim is served, and said
-- "promote a scope by inserting a row". Nothing ever did: no route, scheduler,
-- script, trigger or SQL function writes the table (src/scripts/
-- checkWriterlessReads.ts recorded it as a human-curated allowlist, and
-- docs/architecture/intel-spine-liveness.md confirmed "no writer anywhere").
-- Measured 2026-09-07 on production: intel_limited_live = TRUE,
-- intel_live_label_crowd = TRUE, intel_claim_projection_crowd = TRUE, and
-- intel_live_promoted_scopes holds 0 rows — the whole live-claim path is
-- switched on and starved at this one table. Every reader of readLiveClaims
-- (placeLiving, Wall Live-For-You / WallMoment, Map ExperienceState,
-- worldMomentProducer, Compass live constraints, Media, Trail, intel read
-- models) returns [] because of it.
--
-- WHAT THE UPSTREAM SOURCE OF TRUTH IS — READ, NOT GUESSED
-- ------------------------------------------------------------------------------
-- 2179's header: Live is exposed per scope "only after that SCOPE clears the
-- density gate + human review". lib/intelLiveScope.ts: "Promotion is a
-- human-review decision (spec §24)". lib/intelCalibrationScheduler.ts: "It
-- writes nothing and promotes nothing — promotion stays a human decision".
-- lib/intelFunnelReport.assessDensityGate is the evidence assembler and its
-- `certifiable` verdict is FALSE by construction while two §26 inputs
-- (crowdCalibrationAccuracy, expiryCorrectness) are UNINSTRUMENTED. So the
-- input to a promotion is the §26 density-gate ASSESSMENT (derived from
-- observations, claims, snapshots and outcomes), and the TRIGGER is a human.
-- This migration therefore does NOT invent a promotion policy and does NOT
-- auto-promote anything. It builds the canonical write path a human decision
-- goes through, so that when the owner promotes a scope the row carries
-- provenance, evidence, an explicit review horizon, and can be withdrawn.
--
-- WHAT THIS ADDS
-- ------------------------------------------------------------------------------
--   Columns on intel_live_promoted_scopes (all additive, existing rows valid):
--     expires_at       review horizon; NULL only on a legacy hand-inserted row.
--                      The read path treats an expired row as NOT promoted.
--     withdrawn_at     set by withdrawal or expiry sweep; the read path treats a
--     withdrawn_by       withdrawn row as NOT promoted. The row is KEPT — the
--     withdrawn_reason   allowlist is also the audit trail of what was live.
--     promoted_via     'manual' (a hand INSERT, 2179's original path — the
--                      column default so legacy rows stay valid) or 'service'
--                      (this migration's function).
--     evidence         the density-gate assessment (or whatever the promoter
--                      supplies) recorded AT promotion time — provenance for the
--                      "why is this scope live?" question.
--     updated_at       last state change.
--
--   Functions (SECURITY DEFINER, search_path pinned, service_role ONLY —
--   the same posture as system_promote_admissible_intel_claims in 2174):
--     system_promote_intel_live_scope    idempotent promote / re-promote / renew
--     system_withdraw_intel_live_scope   idempotent withdraw (keeps the row)
--     system_expire_intel_live_scopes    sweep: expired ⇒ withdrawn('expired')
--
--   Flag (CAPABILITY, seeded FALSE): intel_live_scope_promotion_enabled.
--   Read by lib/intelLiveScopePromotion.ts, which is the ONLY caller of the
--   three functions. With the flag off the service performs NO write (it returns
--   {skipped:true, reason:'disabled'} before any RPC), the table stays exactly
--   as it is, and the read path's answer is byte-identical to today.
--
-- IDEMPOTENCY (system_promote_intel_live_scope)
-- ------------------------------------------------------------------------------
--   no row                            → INSERT                        'promoted'
--   row withdrawn or expired          → reset in place, clear withdrawal
--                                                                     'repromoted'
--   row active, later expires_at      → extend horizon, refresh evidence
--                                                                     'renewed'
--   row active, otherwise             → NO WRITE                      'already_active'
-- scope_key is the primary key, so two concurrent promotions of one scope
-- serialise on the row lock (SELECT … FOR UPDATE) and the second sees the
-- first's row. Re-running any call with the same inputs changes nothing.
--
-- WHAT THIS DOES NOT DO
-- ------------------------------------------------------------------------------
--   * It does not promote any scope. The table is still empty after this runs.
--   * It does not read or write intel_state_snapshots, privacy_eligible or any
--     confidence band — those are serving decisions owned by lib/intelProjection
--     and lib/liveClaimRead (the same boundary 2174's contract test pins).
--   * It does not widen access: anon/authenticated get nothing; service_role's
--     table grant is unchanged from 2333.
--
-- RUNTIME EFFECT: NONE until intel_live_scope_promotion_enabled is flipped AND
-- an operator invokes the promotion service for a specific scope. Both are
-- owner decisions and neither is made here.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.intel_live_promoted_scopes') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.intel_live_promoted_scopes does not exist (apply 2179 first).';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist.';
  END IF;
END $$;

-- ── Columns (additive; every existing row remains valid) ────────────────────
ALTER TABLE public.intel_live_promoted_scopes
  ADD COLUMN IF NOT EXISTS expires_at       timestamptz,
  ADD COLUMN IF NOT EXISTS withdrawn_at     timestamptz,
  ADD COLUMN IF NOT EXISTS withdrawn_by     uuid,
  ADD COLUMN IF NOT EXISTS withdrawn_reason text,
  ADD COLUMN IF NOT EXISTS promoted_via     text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS evidence         jsonb,
  ADD COLUMN IF NOT EXISTS updated_at       timestamptz NOT NULL DEFAULT now();

-- Provenance vocabulary is closed: a row is either a hand insert (2179's path)
-- or came through the service function below. Nothing else may claim a source.
ALTER TABLE public.intel_live_promoted_scopes
  DROP CONSTRAINT IF EXISTS intel_live_scope_promoted_via_check;
ALTER TABLE public.intel_live_promoted_scopes
  ADD CONSTRAINT intel_live_scope_promoted_via_check
  CHECK (promoted_via IN ('manual', 'service'));

-- A withdrawal always says why; an expiry horizon is always after the promotion.
ALTER TABLE public.intel_live_promoted_scopes
  DROP CONSTRAINT IF EXISTS intel_live_scope_withdrawal_reason_check;
ALTER TABLE public.intel_live_promoted_scopes
  ADD CONSTRAINT intel_live_scope_withdrawal_reason_check
  CHECK (withdrawn_at IS NULL OR (withdrawn_reason IS NOT NULL AND length(withdrawn_reason) > 0));

ALTER TABLE public.intel_live_promoted_scopes
  DROP CONSTRAINT IF EXISTS intel_live_scope_expiry_after_promotion_check;
ALTER TABLE public.intel_live_promoted_scopes
  ADD CONSTRAINT intel_live_scope_expiry_after_promotion_check
  CHECK (expires_at IS NULL OR expires_at > promoted_at);

-- The expiry sweep's predicate. Partial: only rows that can still expire.
CREATE INDEX IF NOT EXISTS intel_live_promoted_scopes_expiring_idx
  ON public.intel_live_promoted_scopes (expires_at)
  WHERE withdrawn_at IS NULL AND expires_at IS NOT NULL;

COMMENT ON COLUMN public.intel_live_promoted_scopes.expires_at IS
  'Review horizon. At or past this instant the scope is NOT promoted (lib/liveClaimRead ignores it; system_expire_intel_live_scopes marks it withdrawn(''expired'')). NULL only on a legacy hand-inserted row.';
COMMENT ON COLUMN public.intel_live_promoted_scopes.withdrawn_at IS
  'When set, the scope is NOT promoted regardless of expires_at. Row is kept as the audit trail; re-promotion clears it.';
COMMENT ON COLUMN public.intel_live_promoted_scopes.promoted_via IS
  'Provenance: ''manual'' = hand INSERT (2179''s path), ''service'' = system_promote_intel_live_scope (2430).';
COMMENT ON COLUMN public.intel_live_promoted_scopes.evidence IS
  'What the promoter looked at — e.g. the §26 density-gate assessment (lib/intelFunnelReport.assessDensityGate) at promotion time. Provenance only; never read by the serve path.';

-- ── system_promote_intel_live_scope ──────────────────────────────────────────
-- SECURITY DEFINER + granted to service_role ONLY. Returns a jsonb receipt so
-- the caller can log exactly what happened without re-reading the row.
CREATE OR REPLACE FUNCTION public.system_promote_intel_live_scope(
  p_zone_id     text,
  p_claim_type  text,
  p_expires_at  timestamptz,
  p_promoted_by uuid    DEFAULT NULL,
  p_note        text    DEFAULT NULL,
  p_evidence    jsonb   DEFAULT NULL,
  p_now         timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_scope_key text;
  v_row       public.intel_live_promoted_scopes%ROWTYPE;
  v_action    text;
BEGIN
  IF p_claim_type IS NULL OR length(p_claim_type) = 0 THEN
    RAISE EXCEPTION 'system_promote_intel_live_scope: claim_type is required';
  END IF;
  IF p_expires_at IS NULL THEN
    -- A promotion through the service ALWAYS carries a review horizon. A row
    -- with no horizon is the 2179 hand-insert shape, deliberately not this one.
    RAISE EXCEPTION 'system_promote_intel_live_scope: expires_at is required';
  END IF;
  IF p_expires_at <= p_now THEN
    RAISE EXCEPTION 'system_promote_intel_live_scope: expires_at must be after now';
  END IF;

  -- The canonical composition 2179's CHECK enforces and liveClaimRead looks up.
  v_scope_key := coalesce(p_zone_id, '') || '|' || p_claim_type;

  SELECT * INTO v_row
    FROM public.intel_live_promoted_scopes
   WHERE scope_key = v_scope_key
   FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.intel_live_promoted_scopes
      (scope_key, zone_id, claim_type, promoted_at, promoted_by, note,
       expires_at, promoted_via, evidence, updated_at)
    VALUES
      (v_scope_key, p_zone_id, p_claim_type, p_now, p_promoted_by, p_note,
       p_expires_at, 'service', p_evidence, p_now)
    RETURNING * INTO v_row;
    v_action := 'promoted';

  ELSIF v_row.withdrawn_at IS NOT NULL
     OR (v_row.expires_at IS NOT NULL AND v_row.expires_at <= p_now) THEN
    -- A withdrawn or lapsed scope is re-promoted in place: fresh promotion
    -- timestamp, fresh evidence, withdrawal cleared. The old state is gone from
    -- the row but the receipt names the transition.
    UPDATE public.intel_live_promoted_scopes
       SET promoted_at = p_now,
           promoted_by = p_promoted_by,
           note = p_note,
           expires_at = p_expires_at,
           promoted_via = 'service',
           evidence = p_evidence,
           withdrawn_at = NULL,
           withdrawn_by = NULL,
           withdrawn_reason = NULL,
           updated_at = p_now
     WHERE scope_key = v_scope_key
    RETURNING * INTO v_row;
    v_action := 'repromoted';

  ELSIF v_row.expires_at IS NULL OR p_expires_at > v_row.expires_at THEN
    -- Active and the caller extends the horizon: renew. A legacy row with no
    -- horizon gains one here (it becomes a service-governed row).
    UPDATE public.intel_live_promoted_scopes
       SET expires_at = p_expires_at,
           evidence = coalesce(p_evidence, evidence),
           note = coalesce(p_note, note),
           promoted_via = 'service',
           updated_at = p_now
     WHERE scope_key = v_scope_key
    RETURNING * INTO v_row;
    v_action := 'renewed';

  ELSE
    -- Active with an equal-or-later horizon already: idempotent, NO write.
    v_action := 'already_active';
  END IF;

  RETURN jsonb_build_object(
    'scope_key',   v_row.scope_key,
    'action',      v_action,
    'promoted_at', v_row.promoted_at,
    'expires_at',  v_row.expires_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.system_promote_intel_live_scope(text, text, timestamptz, uuid, text, jsonb, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.system_promote_intel_live_scope(text, text, timestamptz, uuid, text, jsonb, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.system_promote_intel_live_scope(text, text, timestamptz, uuid, text, jsonb, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.system_promote_intel_live_scope(text, text, timestamptz, uuid, text, jsonb, timestamptz) TO service_role;

COMMENT ON FUNCTION public.system_promote_intel_live_scope(text, text, timestamptz, uuid, text, jsonb, timestamptz) IS
  'IG-09 (2430): the ONE writer that promotes a (zone, claim_type) scope for Live. Idempotent per scope_key: promoted / repromoted / renewed / already_active. Requires a review horizon. service_role only; called by lib/intelLiveScopePromotion.ts behind intel_live_scope_promotion_enabled. Does not decide policy — the caller supplies the evidence and a human decides.';

-- ── system_withdraw_intel_live_scope ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.system_withdraw_intel_live_scope(
  p_zone_id      text,
  p_claim_type   text,
  p_reason       text,
  p_withdrawn_by uuid    DEFAULT NULL,
  p_now          timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_scope_key text;
  v_row       public.intel_live_promoted_scopes%ROWTYPE;
BEGIN
  IF p_claim_type IS NULL OR length(p_claim_type) = 0 THEN
    RAISE EXCEPTION 'system_withdraw_intel_live_scope: claim_type is required';
  END IF;
  IF p_reason IS NULL OR length(p_reason) = 0 THEN
    RAISE EXCEPTION 'system_withdraw_intel_live_scope: reason is required';
  END IF;
  v_scope_key := coalesce(p_zone_id, '') || '|' || p_claim_type;

  SELECT * INTO v_row
    FROM public.intel_live_promoted_scopes
   WHERE scope_key = v_scope_key
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('scope_key', v_scope_key, 'action', 'not_found');
  END IF;
  IF v_row.withdrawn_at IS NOT NULL THEN
    -- Already withdrawn: idempotent, NO write, the original reason stands.
    RETURN jsonb_build_object('scope_key', v_scope_key, 'action', 'already_withdrawn',
                              'withdrawn_at', v_row.withdrawn_at);
  END IF;

  UPDATE public.intel_live_promoted_scopes
     SET withdrawn_at = p_now,
         withdrawn_by = p_withdrawn_by,
         withdrawn_reason = p_reason,
         updated_at = p_now
   WHERE scope_key = v_scope_key;

  RETURN jsonb_build_object('scope_key', v_scope_key, 'action', 'withdrawn', 'withdrawn_at', p_now);
END;
$$;

REVOKE ALL ON FUNCTION public.system_withdraw_intel_live_scope(text, text, text, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.system_withdraw_intel_live_scope(text, text, text, uuid, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.system_withdraw_intel_live_scope(text, text, text, uuid, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.system_withdraw_intel_live_scope(text, text, text, uuid, timestamptz) TO service_role;

COMMENT ON FUNCTION public.system_withdraw_intel_live_scope(text, text, text, uuid, timestamptz) IS
  'IG-09 (2430): withdraw a promoted scope. Keeps the row (audit), sets withdrawn_at/by/reason. Idempotent: withdrawn / already_withdrawn / not_found. service_role only.';

-- ── system_expire_intel_live_scopes ──────────────────────────────────────────
-- The sweep. A row past its horizon is already invisible to the read path; this
-- makes the state explicit (withdrawn_reason = 'expired') so the table reads as
-- the truth of what is live without every reader re-deriving it.
CREATE OR REPLACE FUNCTION public.system_expire_intel_live_scopes(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.intel_live_promoted_scopes
     SET withdrawn_at = p_now,
         withdrawn_reason = 'expired',
         updated_at = p_now
   WHERE withdrawn_at IS NULL
     AND expires_at IS NOT NULL
     AND expires_at <= p_now;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.system_expire_intel_live_scopes(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.system_expire_intel_live_scopes(timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.system_expire_intel_live_scopes(timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.system_expire_intel_live_scopes(timestamptz) TO service_role;

COMMENT ON FUNCTION public.system_expire_intel_live_scopes(timestamptz) IS
  'IG-09 (2430): marks every promoted scope whose expires_at has passed as withdrawn(''expired''). Idempotent. Run by lib/intelPromotionScheduler via lib/intelLiveScopePromotion.runLiveScopeExpiryPass behind intel_live_scope_promotion_enabled.';

-- ── Flag (CAPABILITY, seeded OFF) ────────────────────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'intel_live_scope_promotion_enabled',
    false,
    'CAPABILITY. IG-09 (2430): lets lib/intelLiveScopePromotion.ts write intel_live_promoted_scopes through system_promote/withdraw/expire_intel_live_scope. OFF (the seed): the service performs no write at all and the allowlist stays exactly as it is, so the live read path answers byte-identically to before 2430. ON: the expiry sweep runs with the promotion scheduler, and an operator-initiated promotion/withdrawal is written with provenance. Flipping it promotes NOTHING by itself. Fail-closed (isFlagEnabled). Enabling is an owner decision.'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions ───────────────────────────────────────────────────────────
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'intel_live_promoted_scopes'
     AND column_name IN ('expires_at','withdrawn_at','withdrawn_by','withdrawn_reason','promoted_via','evidence','updated_at');
  IF n <> 7 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected 7 new columns on intel_live_promoted_scopes, found %', n;
  END IF;
  IF to_regprocedure('public.system_promote_intel_live_scope(text, text, timestamptz, uuid, text, jsonb, timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: system_promote_intel_live_scope missing';
  END IF;
  IF to_regprocedure('public.system_withdraw_intel_live_scope(text, text, text, uuid, timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: system_withdraw_intel_live_scope missing';
  END IF;
  IF to_regprocedure('public.system_expire_intel_live_scopes(timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: system_expire_intel_live_scopes missing';
  END IF;
  SELECT count(*) INTO n FROM public.feature_flags WHERE flag = 'intel_live_scope_promotion_enabled';
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_live_scope_promotion_enabled not seeded (found %)', n;
  END IF;
  SELECT count(*) INTO n FROM public.feature_flags WHERE flag = 'intel_live_scope_promotion_enabled' AND enabled = TRUE;
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_live_scope_promotion_enabled seeded ON — must ship OFF';
  END IF;
  -- This migration promotes nothing: every pre-existing row is untouched and no
  -- row is added. (Counted against 'service' provenance, which only the function
  -- above can write.)
  SELECT count(*) INTO n FROM public.intel_live_promoted_scopes WHERE promoted_via = 'service';
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: 2430 must not promote any scope, found % service rows', n;
  END IF;
END $$;

COMMIT;
