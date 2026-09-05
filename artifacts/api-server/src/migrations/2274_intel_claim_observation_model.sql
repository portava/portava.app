-- 2274_intel_claim_observation_model.sql
-- Intelligence Gathering unit I1 — claim/observation model (spec §3 Table 3,
-- Table 4 observation lifecycle, §4 Table 5 common claim fields, §11 Table 17
-- input_claim_versions, Appendix B "every write is idempotent").
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). IG band 2274.
--
-- ── THE DEFECTS THIS CLOSES ──────────────────────────────────────────────────
--   1. proposeClaim was NOT idempotent. Every call inserted another
--      status='candidate' row for the same observation (routes/intel.ts header:
--      "every press left another duplicate"). 2174's partial unique index covers
--      only live (active/conflicting) claims, so candidates were unconstrained.
--      Nothing recorded WHICH observation a claim was proposed from, so the
--      duplicate could not even be detected after the fact.
--   2. Table 17's input_claim_versions needs a claim VERSION to cite. intel_claims
--      had no updated_at and no version counter; the projection's lineage array
--      (2273) writes null for both until this migration lands.
--   3. Table 5 names qualifiers_json, asserted_confidence, source_label and
--      lineage as common claim fields. None existed.
--   4. Table 3: actor_id is "null only for signed official/system sources". The
--      column was NOT NULL, so an official or system-generated observation could
--      not be represented at all; Table 4's lifecycle_state did not exist.
--
-- ── WHAT THIS ADDS ───────────────────────────────────────────────────────────
--   intel_claims (all additive; existing rows stay valid):
--     observation_id      uuid NULL  FK → intel_observations ON DELETE SET NULL.
--                                    The observation a claim was proposed from
--                                    (lineage root). SET NULL, not CASCADE: a
--                                    claim is an aggregate belief about a place
--                                    (2130: erase_intel_for_actor leaves claims
--                                    alone); erasing the contributor's row must
--                                    not delete other people's consensus.
--     qualifiers_json     jsonb NULL Table 5: access type, floor, group, mode.
--     asserted_confidence numeric    Table 5: optional 0–1 contributor confidence.
--                                    NEVER an input to system_confidence (§8:
--                                    confidence is computed from evidence; a
--                                    contributor's self-rating is recorded, not
--                                    trusted).
--     source_label        text NULL  Table 5 registry: official, verified_firsthand,
--                                    consensus, historical, prediction, sponsored,
--                                    unverified.
--     lineage             jsonb NULL Table 5: observation, evidence, confirmations,
--                                    algorithm and correction ancestry.
--     updated_at          timestamptz NOT NULL DEFAULT now()
--     version             integer NOT NULL DEFAULT 1
--                                    Both bumped by a BEFORE UPDATE trigger on
--                                    every row update — the exact version the
--                                    projection cites in input_claim_versions.
--     + partial UNIQUE (observation_id, claim_type) WHERE observation_id IS NOT NULL
--       — the idempotency backbone for proposeClaim: a replay hits 23505 and
--       the service returns the stored candidate.
--
--   intel_observations:
--     lifecycle_state     text NOT NULL DEFAULT 'submitted', CHECK over the
--                                    Table-4 vocabulary. The table is APPEND-ONLY
--                                    (2130 trigger refuses UPDATE), so this
--                                    records the state the envelope was written
--                                    in; later states (expired, corrected,
--                                    reconfirmed) are DERIVED — expires_at,
--                                    a superseding claim, a later observation —
--                                    never written back. 'deleted' is not a row
--                                    state: a deleted draft never reaches the
--                                    server and erasure is a DELETE, not a state.
--     actor_id            DROP NOT NULL, with
--       CHECK (actor_id IS NOT NULL OR source_class IN ('official_signed',
--              'portava_prediction','historical_pattern'))
--                                    — null ONLY for a signed official or a
--                                    system-generated source (Table 3). sponsored,
--                                    imported_owned, hearsay and both firsthand
--                                    classes still require an actor.
--     + partial UNIQUE (source_class, idempotency_key) WHERE actor_id IS NULL
--       — the existing (actor_id, idempotency_key) unique index cannot dedupe
--       actor-less rows (NULLs are distinct), so system/official replays get
--       their own key.
--
-- ── RLS: NOTHING WIDENS ──────────────────────────────────────────────────────
-- No policy is added or changed. The only client-facing policy on
-- intel_observations is intel_observations_select_own USING (actor_id = auth.uid())
-- (2130). For a NULL actor that predicate is NULL, which RLS treats as false —
-- an official/system row is visible to NO authenticated user, which is the
-- fail-closed answer (published live state reaches clients through the server
-- projection, never by reading rows). The postcondition below re-reads the
-- policy expression from pg_policy and refuses to commit if it has drifted to
-- anything that could admit a NULL actor. No grant is added; the new trigger
-- function is REVOKEd from PUBLIC/anon/authenticated (not callable over REST).
--
-- RUNTIME EFFECT: NONE until the paired code lands (proposeClaim writes
-- observation_id/source_label/lineage; the projection cites updated_at/version).
-- No flag is seeded or changed here. Nothing writes lifecycle_state or a NULL
-- actor_id yet; both are schema capacity for the official/system source path.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.intel_claims') IS NULL OR to_regclass('public.intel_observations') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2130_intel_storage.sql first (intel_claims / intel_observations missing).';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'intel_observations_select_own') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: intel_observations_select_own (2130) is missing — the NULL-actor fail-closed postcondition has nothing to check.';
  END IF;
END $$;

-- ── 1. intel_claims: Table-5 fields, lineage root, version counter ───────────
ALTER TABLE public.intel_claims
  ADD COLUMN IF NOT EXISTS observation_id      uuid REFERENCES public.intel_observations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS qualifiers_json     jsonb,
  ADD COLUMN IF NOT EXISTS asserted_confidence numeric,
  ADD COLUMN IF NOT EXISTS source_label        text,
  ADD COLUMN IF NOT EXISTS lineage             jsonb,
  ADD COLUMN IF NOT EXISTS updated_at          timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS version             integer NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'intel_claims_qualifiers_json_object') THEN
    ALTER TABLE public.intel_claims ADD CONSTRAINT intel_claims_qualifiers_json_object
      CHECK (qualifiers_json IS NULL OR jsonb_typeof(qualifiers_json) = 'object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'intel_claims_asserted_confidence_range') THEN
    ALTER TABLE public.intel_claims ADD CONSTRAINT intel_claims_asserted_confidence_range
      CHECK (asserted_confidence IS NULL OR (asserted_confidence >= 0 AND asserted_confidence <= 1));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'intel_claims_source_label_check') THEN
    ALTER TABLE public.intel_claims ADD CONSTRAINT intel_claims_source_label_check
      CHECK (source_label IS NULL OR source_label IN
        ('official','verified_firsthand','consensus','historical','prediction','sponsored','unverified'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'intel_claims_lineage_object') THEN
    ALTER TABLE public.intel_claims ADD CONSTRAINT intel_claims_lineage_object
      CHECK (lineage IS NULL OR jsonb_typeof(lineage) = 'object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'intel_claims_version_positive') THEN
    ALTER TABLE public.intel_claims ADD CONSTRAINT intel_claims_version_positive
      CHECK (version >= 1);
  END IF;
END $$;

-- Idempotency backbone: ONE claim per (observation, claim_type). Partial so the
-- rows written before this migration (observation_id NULL) are unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS intel_claims_one_per_observation_type
  ON public.intel_claims (observation_id, claim_type)
  WHERE observation_id IS NOT NULL;

-- Reverse lookup for lineage / erasure set-null.
CREATE INDEX IF NOT EXISTS intel_claims_observation_id
  ON public.intel_claims (observation_id)
  WHERE observation_id IS NOT NULL;

-- Version counter: every UPDATE bumps version and stamps updated_at. Table 17's
-- input_claim_versions cites exactly this pair.
CREATE OR REPLACE FUNCTION public.intel_claims_bump_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  NEW.version := COALESCE(OLD.version, 0) + 1;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.intel_claims_bump_version() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intel_claims_bump_version() FROM anon;
REVOKE ALL ON FUNCTION public.intel_claims_bump_version() FROM authenticated;

DROP TRIGGER IF EXISTS intel_claims_bump_version ON public.intel_claims;
CREATE TRIGGER intel_claims_bump_version
  BEFORE UPDATE ON public.intel_claims
  FOR EACH ROW EXECUTE FUNCTION public.intel_claims_bump_version();

COMMENT ON COLUMN public.intel_claims.observation_id IS
  'I1 / Table 5 lineage root: the observation this claim was proposed from. Unique per (observation_id, claim_type) — proposeClaim is idempotent on it. SET NULL on erasure: a claim is an aggregate, not the contributor''s row.';
COMMENT ON COLUMN public.intel_claims.qualifiers_json IS
  'Table 5: access type, floor, group, traveler mode or other context the value is qualified by. Object or NULL.';
COMMENT ON COLUMN public.intel_claims.asserted_confidence IS
  'Table 5: optional 0–1 contributor self-confidence. Recorded only — never an input to system_confidence (§8).';
COMMENT ON COLUMN public.intel_claims.source_label IS
  'Table 5 registry label: official | verified_firsthand | consensus | historical | prediction | sponsored | unverified.';
COMMENT ON COLUMN public.intel_claims.lineage IS
  'Table 5: observation, evidence, confirmations, algorithm and correction ancestry. Internal; never redistributed.';
COMMENT ON COLUMN public.intel_claims.updated_at IS
  'Stamped by intel_claims_bump_version on every UPDATE. Cited by intel_state_snapshots.input_claim_versions (Table 17).';
COMMENT ON COLUMN public.intel_claims.version IS
  'Monotonic per-row version, bumped by intel_claims_bump_version on every UPDATE. Cited by intel_state_snapshots.input_claim_versions (Table 17).';

-- ── 2. intel_observations: Table-4 lifecycle, Table-3 nullable actor ─────────
ALTER TABLE public.intel_observations
  ADD COLUMN IF NOT EXISTS lifecycle_state text NOT NULL DEFAULT 'submitted';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'intel_observations_lifecycle_state_check') THEN
    ALTER TABLE public.intel_observations ADD CONSTRAINT intel_observations_lifecycle_state_check
      CHECK (lifecycle_state IN
        ('draft','submitted','processing','published','corrected','expired','rejected','restricted','removed','reconfirmed'));
  END IF;
END $$;

ALTER TABLE public.intel_observations ALTER COLUMN actor_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'intel_observations_actor_required_unless_official_system') THEN
    ALTER TABLE public.intel_observations ADD CONSTRAINT intel_observations_actor_required_unless_official_system
      CHECK (actor_id IS NOT NULL OR source_class IN ('official_signed','portava_prediction','historical_pattern'));
  END IF;
END $$;

-- Idempotency for actor-less rows: (actor_id, idempotency_key) cannot dedupe
-- them (NULLs are distinct in a unique index), so they key on source class.
CREATE UNIQUE INDEX IF NOT EXISTS intel_observations_system_idempotency
  ON public.intel_observations (source_class, idempotency_key)
  WHERE actor_id IS NULL;

COMMENT ON COLUMN public.intel_observations.lifecycle_state IS
  'Table 4 state the envelope was written in (default submitted). The table is append-only; expired/corrected/reconfirmed are derived from expires_at, superseding claims and later observations, never written back.';
COMMENT ON COLUMN public.intel_observations.actor_id IS
  'Contributor. NULL only for a signed official or system-generated source (CHECK intel_observations_actor_required_unless_official_system). A NULL actor matches no own-row policy: such rows are invisible to every client role.';

-- ── Postconditions (conditional RAISE only) ──────────────────────────────────
DO $$
DECLARE
  missing_cols int;
  actor_nullable text;
  policy_expr text;
  client_grants int;
  obs_owner text;
  obs_write_grants text;
BEGIN
  SELECT 7 - count(*) INTO missing_cols FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'intel_claims'
     AND column_name IN ('observation_id','qualifiers_json','asserted_confidence','source_label','lineage','updated_at','version');
  IF missing_cols <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % Table-5 column(s) missing from intel_claims', missing_cols;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'intel_claims_one_per_observation_type') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_claims_one_per_observation_type (proposeClaim idempotency) missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'intel_claims_bump_version') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_claims_bump_version trigger missing';
  END IF;

  SELECT is_nullable INTO actor_nullable FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'intel_observations' AND column_name = 'actor_id';
  IF actor_nullable IS DISTINCT FROM 'YES' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_observations.actor_id is still NOT NULL';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'intel_observations_actor_required_unless_official_system') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the NULL-actor CHECK is missing — a NULL actor would be admissible for any source class';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'intel_observations' AND column_name = 'lifecycle_state') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_observations.lifecycle_state missing';
  END IF;

  -- The own-row policy must still be the bare equality, which a NULL actor can
  -- never satisfy. Anything else (IS NULL, coalesce, OR) could admit an
  -- actor-less row to a client and is refused.
  SELECT pg_get_expr(polqual, polrelid) INTO policy_expr
    FROM pg_policy WHERE polname = 'intel_observations_select_own';
  IF policy_expr IS NULL OR policy_expr !~ '^\(?actor_id = auth\.uid\(\)\)?$' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_observations_select_own is "%" — must be exactly (actor_id = auth.uid()) so a NULL actor fails closed', policy_expr;
  END IF;

  -- No client role gained anything on intel_claims; nobody may UPDATE the
  -- append-only observation table.
  SELECT count(*) INTO client_grants FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'intel_claims' AND grantee IN ('anon','authenticated');
  IF client_grants > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: anon/authenticated hold % privilege(s) on intel_claims', client_grants;
  END IF;
  -- Nobody GRANTABLE may UPDATE/DELETE/TRUNCATE the append-only observation
  -- table. Asserted per role, excluding the table's OWNER: an owner holds ALL on
  -- its own table inherently, cannot be meaningfully revoked (it re-grants
  -- itself at will), and 2093 already ruled on precisely this for
  -- discovery_shadow_serves — whose certified live grant set is
  -- `postgres: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE` plus
  -- `service_role: INSERT,SELECT`. A grantee-blind count here would report 3
  -- (postgres.UPDATE/DELETE/TRUNCATE) on every correctly-configured database and
  -- could never pass; the append-only enforcement against the owner is the
  -- intel_append_only() trigger from 2130, which binds it.
  SELECT pg_get_userbyid(relowner) INTO obs_owner
    FROM pg_class WHERE oid = 'public.intel_observations'::regclass;
  SELECT COALESCE(string_agg(DISTINCT grantee::text || '.' || privilege_type::text, ', ' ORDER BY grantee::text || '.' || privilege_type::text), '(none)')
    INTO obs_write_grants FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'intel_observations'
     AND privilege_type IN ('UPDATE','DELETE','TRUNCATE')
     AND grantee <> obs_owner;
  IF obs_write_grants <> '(none)' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: non-owner UPDATE/DELETE/TRUNCATE grant(s) on append-only intel_observations: % (owner % is exempt by construction)', obs_write_grants, obs_owner;
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   DROP TRIGGER IF EXISTS intel_claims_bump_version ON public.intel_claims;
--   DROP FUNCTION IF EXISTS public.intel_claims_bump_version();
--   DROP INDEX IF EXISTS public.intel_claims_one_per_observation_type;
--   DROP INDEX IF EXISTS public.intel_claims_observation_id;
--   DROP INDEX IF EXISTS public.intel_observations_system_idempotency;
--   ALTER TABLE public.intel_claims
--     DROP CONSTRAINT IF EXISTS intel_claims_qualifiers_json_object,
--     DROP CONSTRAINT IF EXISTS intel_claims_asserted_confidence_range,
--     DROP CONSTRAINT IF EXISTS intel_claims_source_label_check,
--     DROP CONSTRAINT IF EXISTS intel_claims_lineage_object,
--     DROP CONSTRAINT IF EXISTS intel_claims_version_positive,
--     DROP COLUMN IF EXISTS observation_id, DROP COLUMN IF EXISTS qualifiers_json,
--     DROP COLUMN IF EXISTS asserted_confidence, DROP COLUMN IF EXISTS source_label,
--     DROP COLUMN IF EXISTS lineage, DROP COLUMN IF EXISTS updated_at, DROP COLUMN IF EXISTS version;
--   ALTER TABLE public.intel_observations
--     DROP CONSTRAINT IF EXISTS intel_observations_actor_required_unless_official_system,
--     DROP CONSTRAINT IF EXISTS intel_observations_lifecycle_state_check,
--     DROP COLUMN IF EXISTS lifecycle_state;
--   -- actor_id SET NOT NULL only after verifying no NULL-actor rows exist.
-- (Reverse alongside the paired IntelCaptureService/intelProjectionScheduler change.)
