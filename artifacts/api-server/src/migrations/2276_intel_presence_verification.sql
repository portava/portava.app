-- 2276_intel_presence_verification.sql
-- Intelligence Gathering — unit I3, presence verification P2/P3/P4 (spec §7
-- Tables 12–13, §16 missions, §22 integrity, §29 Phase-1 cut, §30 Table 38
-- "presence method: session-based coarse geofence + dwell/interaction; OFF by
-- default").
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). IG band 2276.
--
-- Additive + idempotent. Safe to re-run. Three things, all dark until the owner
-- presses the flag:
--
--   1. feature flag `intel_presence_verification_enabled` (CAPABILITY, seeded
--      FALSE). Its ONE reader is services/intel/IntelCaptureService
--      (resolvePresenceForCapture → services/intel/PresenceVerifier), which lands
--      in this same change, so check-flag-polarity's "a flag arrives with the
--      unit that reads it" rule holds. OFF ⇒ the capture path is BYTE-IDENTICAL
--      to pre-2276 main: every live-grade presence claim (P2+) is clamped to the
--      unverified ceiling (P1) exactly as before, and nothing is read or written
--      here. ON ⇒ the verifier may CONFIRM a live-grade level from server-held
--      evidence (geofence + dwell/interaction ⇒ P2; + receipt ⇒ P3; + mission
--      nonce ⇒ P4). Verification only ever lowers a claimed level, never raises
--      it above the evidence matrix (Table 13); any verifier error, missing
--      coordinates or stale snapshot fails closed to P1.
--
--   2. intel_mission_candidates.nonce / nonce_consumed_at — the P4 "mission
--      nonce" (Table 13: P4 = P2/P3 plus mission nonce and contract). On accept
--      (services/intel/CoverageService.acceptMission) the server mints a random
--      token, hands the PLAINTEXT to the contributor once, and stores ONLY its
--      HMAC-SHA256 digest (keyed from INTEL_GROUP_KEY_SECRET / SESSION_SECRET,
--      the lib/intelGroupKey.ts pattern, folded over mission id + accepting actor
--      id). A DB read therefore cannot forge a capture. nonce_consumed_at makes
--      the nonce SINGLE-USE: the capture path claims it with a compare-and-set
--      (UPDATE … WHERE nonce_consumed_at IS NULL) so a replayed nonce fails
--      closed to P1. Both columns are nullable; every pre-existing row is
--      untouched (no nonce ⇒ that mission can never reach P4).
--
--   3. intel_presence_verifications — the APPEND-ONLY audit record of each
--      verification attempt: observation, decisive method, level reached, and a
--      COARSE evidence summary (distance bucket, dwell bucket, which methods
--      held — never a raw coordinate; the verifier strips them before the row is
--      built, and the table comment states the invariant). Same shape as the
--      2130 intel_* family: append-only triggers (DELETE only inside a declared
--      erasure), deny-default RLS, REVOKE-first grants, service_role INSERT/
--      SELECT, authenticated own-row SELECT only. ON DELETE CASCADE from BOTH
--      intel_observations (erased with the observation — erase_intel_for_actor
--      deletes the actor's observations inside the erasure declaration, so the
--      cascade is permitted by the trigger) and profiles.
--
-- RUNTIME EFFECT: NONE. Flag seeded false ⇒ the capture path never consults the
-- verifier, never reads location_snapshots / media_assets / missions for
-- presence, and never writes this table. acceptMission starts storing a nonce
-- digest for newly accepted missions regardless of the flag (a digest of a
-- random token is not user data and gates nothing on its own); the P4 path that
-- consumes it is behind the flag.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist.';
  END IF;
  IF to_regclass('public.intel_observations') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.intel_observations does not exist (apply 2130 first).';
  END IF;
  IF to_regclass('public.intel_mission_candidates') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.intel_mission_candidates does not exist (apply 2167 first).';
  END IF;
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.profiles does not exist.';
  END IF;
  IF to_regproc('public.intel_append_only') IS NULL OR to_regproc('public.intel_append_only_stmt') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: 2130 append-only trigger functions are missing.';
  END IF;
END $$;

-- ── 1. Flag (CAPABILITY, seeded OFF) ─────────────────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'intel_presence_verification_enabled',
    false,
    'IG unit I3 (spec §7 Tables 12-13, §30 Table 38 "presence off by default"). OFF (the seed): capture behaviour is byte-identical to before — every live-grade presence claim (P2+) is clamped to P1; no location_snapshots, media_assets or mission rows are read for presence and intel_presence_verifications is never written. ON: services/intel/PresenceVerifier (via IntelCaptureService.resolvePresenceForCapture) may CONFIRM a level from server-held evidence only: device geofence + dwell/interaction => P2; P2 + eligible receipt media => P3; P2/P3 + single-use mission nonce => P4. Never raises a level above the evidence matrix; any error / missing coordinates / stale snapshot fails closed to P1. Fail-closed (isFlagEnabled).'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── 2. Mission nonce columns (P4) ────────────────────────────────────────────
ALTER TABLE public.intel_mission_candidates
  ADD COLUMN IF NOT EXISTS nonce text,
  ADD COLUMN IF NOT EXISTS nonce_consumed_at timestamptz;

COMMENT ON COLUMN public.intel_mission_candidates.nonce IS
  'I3 / P4: HMAC-SHA256 DIGEST of the single-use mission nonce minted at accept (lib/intelMissionNonce.ts; keyed from INTEL_GROUP_KEY_SECRET / SESSION_SECRET over mission id + accepting actor). The plaintext is handed to the contributor once and never stored. NULL = no nonce issued; the mission can never back a P4 capture.';
COMMENT ON COLUMN public.intel_mission_candidates.nonce_consumed_at IS
  'I3 / P4: set by the capture path with a compare-and-set when the nonce is spent. Non-NULL = replayed nonces fail closed to P1.';

-- ── 3. intel_presence_verifications — append-only audit record ───────────────
CREATE TABLE IF NOT EXISTS public.intel_presence_verifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id  uuid NOT NULL REFERENCES public.intel_observations(id) ON DELETE CASCADE,
  actor_id        uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- The DECISIVE method — the strongest one that established level_reached.
  -- NULL = the attempt ran but no method held (the claim was clamped to P1);
  -- the attempt is still recorded so shadow calibration can see the miss.
  method          text,
  level_reached   text NOT NULL,
  -- COARSE summary only: distance bucket, dwell bucket, satisfied methods,
  -- refusal reasons, evidence references (media asset id / mission id). NEVER a
  -- raw coordinate — services/intel/PresenceVerifier strips them before the
  -- row is built.
  evidence        jsonb NOT NULL DEFAULT '{}'::jsonb,
  verified_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT intel_presence_verifications_method_check
    CHECK (method IS NULL OR method IN ('geofence','dwell','interaction','receipt','mission_nonce')),
  CONSTRAINT intel_presence_verifications_level_check
    CHECK (level_reached IN ('P0','P1','P2','P3','P4'))
);

CREATE INDEX IF NOT EXISTS intel_presence_verifications_observation
  ON public.intel_presence_verifications (observation_id);
CREATE INDEX IF NOT EXISTS intel_presence_verifications_actor
  ON public.intel_presence_verifications (actor_id, verified_at DESC);

COMMENT ON TABLE public.intel_presence_verifications IS
  'I3: append-only record of each presence-verification attempt for an intel observation (method, level reached, coarse evidence summary). Contains NO raw coordinates — only distance/dwell buckets and evidence references. Erased with the observation (ON DELETE CASCADE) inside erase_intel_for_actor''s erasure declaration.';

-- Append-only, exactly as 2130 attached to the intel_* family.
DO $$
DECLARE t text := 'intel_presence_verifications';
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_no_update_delete', t);
  EXECUTE format(
    'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.intel_append_only()', t || '_no_update_delete', t);
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_no_update_delete_stmt', t);
  EXECUTE format(
    'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.intel_append_only_stmt()', t || '_no_update_delete_stmt', t);
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_no_truncate', t);
  EXECUTE format(
    'CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.intel_append_only()', t || '_no_truncate', t);
END $$;

-- RLS + grants (2130 shape: deny-default, REVOKE ALL first — Supabase's default
-- privileges grant ALL to service_role at CREATE TABLE time, and a bare GRANT
-- establishes no limit).
ALTER TABLE public.intel_presence_verifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_presence_verifications FROM PUBLIC;
REVOKE ALL ON public.intel_presence_verifications FROM anon;
REVOKE ALL ON public.intel_presence_verifications FROM authenticated;
REVOKE ALL ON public.intel_presence_verifications FROM service_role;
GRANT INSERT, SELECT ON public.intel_presence_verifications TO service_role;
-- authenticated: own rows only (the contributor may see how their own capture
-- was graded). No policy for anon; no client INSERT/UPDATE/DELETE.
GRANT SELECT ON public.intel_presence_verifications TO authenticated;
DROP POLICY IF EXISTS intel_presence_verifications_select_own ON public.intel_presence_verifications;
CREATE POLICY intel_presence_verifications_select_own ON public.intel_presence_verifications
  FOR SELECT TO authenticated USING (actor_id = auth.uid());

-- ── Postconditions ───────────────────────────────────────────────────────────
DO $$
DECLARE present int; on_count int; policies int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'intel_presence_verification_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_presence_verification_enabled flag not present after seed';
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'intel_presence_verification_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_presence_verification_enabled seeded ON — it must ship OFF';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'intel_mission_candidates' AND column_name = 'nonce'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_mission_candidates.nonce missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'intel_mission_candidates' AND column_name = 'nonce_consumed_at'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_mission_candidates.nonce_consumed_at missing';
  END IF;

  IF to_regclass('public.intel_presence_verifications') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_presence_verifications not created';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE oid = 'public.intel_presence_verifications'::regclass AND relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: RLS not enabled on intel_presence_verifications';
  END IF;
  SELECT count(*) INTO policies FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'intel_presence_verifications';
  IF policies <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected exactly 1 policy on intel_presence_verifications, found %', policies;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.intel_presence_verifications'::regclass
      AND tgname = 'intel_presence_verifications_no_update_delete'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: append-only trigger missing on intel_presence_verifications';
  END IF;
  IF has_table_privilege('anon', 'public.intel_presence_verifications', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: anon can SELECT intel_presence_verifications';
  END IF;
  IF has_table_privilege('authenticated', 'public.intel_presence_verifications', 'INSERT')
     OR has_table_privilege('authenticated', 'public.intel_presence_verifications', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.intel_presence_verifications', 'DELETE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: authenticated holds a write privilege on intel_presence_verifications';
  END IF;
END $$;

COMMIT;

-- REVERSAL (manual):
--   UPDATE public.feature_flags SET enabled = false WHERE flag = 'intel_presence_verification_enabled';
--   (only if truly abandoning the unit:)
--   DELETE FROM public.feature_flags WHERE flag = 'intel_presence_verification_enabled';
--   DROP TABLE IF EXISTS public.intel_presence_verifications;
--   ALTER TABLE public.intel_mission_candidates DROP COLUMN IF EXISTS nonce_consumed_at, DROP COLUMN IF EXISTS nonce;
