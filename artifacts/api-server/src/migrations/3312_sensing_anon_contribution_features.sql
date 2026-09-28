-- 3312_sensing_anon_contribution_features.sql
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE NINE §4.1 FEATURES REACH THE ANONYMOUS STORE (census-sensing S21, S28,
-- S42, S51, S52; §26)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT
--   Nullable, bucketed feature columns on sensing_anon_contributions, one per
--   thing the device's on-device reduction (travel-buddy-standalone/src/lib/
--   sensing/normalizedFeatures.ts) produces and the wire contract
--   (docs/contracts/sensing-contribution-wire-v1.json) carries. Every value is
--   an ordinal, a centi (0..100 integer), a boolean or a closed enum — the
--   CHECKs make anything finer unrepresentable. No coordinate, no sample, no
--   instant, no identifier: the row's shape still cannot hold one.
--
-- WHY
--   Until now the store carried ONE reduced feature (signal_bucket, an ordinal
--   whose meaning no one had pinned) and the vibe producer
--   (lib/sensingWindowAggregate) left motionEnergy, periodicity, density and
--   acousticEnergy NULL for want of input. The device now produces all of
--   them; this is where they land, so the aggregate can read them under the
--   same k-anonymity gate that already protects the count.
--
-- THE 2315 RULING, RE-CHECKED HERE
--   "The anonymous store may only own privacy-reduced sensor contributions,
--   rotating IDs, TTL, cohort/coverage aggregation and revocation." These are
--   privacy-reduced sensor contributions. The store still has no foreign key,
--   no account/device handle, and no claim/review/status/conflict/snapshot
--   column — the postcondition below re-runs 2315's two name checks over the
--   widened table, so a future column cannot slip past them either.
--   `movement_class` is deliberately not `movement_state`: it is a motion
--   class, not a lifecycle state, and the name says so.
--
-- Additive and idempotent. Nullable everywhere: a contribution from a client
-- that sends only the legacy shape still inserts. Rollback:
--   db/rollback/2026-09-26-3312-sensing-anon-contribution-features-rollback.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.sensing_anon_contributions
  ADD COLUMN IF NOT EXISTS zone_precision        smallint,
  ADD COLUMN IF NOT EXISTS place_candidate       text,
  ADD COLUMN IF NOT EXISTS movement_class        text,
  ADD COLUMN IF NOT EXISTS motion_energy_centi   smallint,
  ADD COLUMN IF NOT EXISTS periodicity_centi     smallint,
  ADD COLUMN IF NOT EXISTS dwell_bucket          smallint,
  ADD COLUMN IF NOT EXISTS transition_kind       text,
  ADD COLUMN IF NOT EXISTS transport_mode        text,
  ADD COLUMN IF NOT EXISTS transport_mode_centi  smallint,
  ADD COLUMN IF NOT EXISTS density_bucket        text,
  ADD COLUMN IF NOT EXISTS bounded_movement      boolean,
  ADD COLUMN IF NOT EXISTS sensor_health_centi   smallint,
  ADD COLUMN IF NOT EXISTS acoustic_energy_bucket smallint,
  ADD COLUMN IF NOT EXISTS acoustic_rhythm       text,
  ADD COLUMN IF NOT EXISTS acoustic_health_centi smallint;

DO $$
BEGIN
  -- Each CHECK is added once; ADD CONSTRAINT has no IF NOT EXISTS.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sensing_anon_features_ranges') THEN
    ALTER TABLE public.sensing_anon_contributions ADD CONSTRAINT sensing_anon_features_ranges CHECK (
      (zone_precision IS NULL OR zone_precision BETWEEN 1 AND 12)
      AND (place_candidate IS NULL OR length(place_candidate) BETWEEN 1 AND 128)
      AND (motion_energy_centi IS NULL OR motion_energy_centi BETWEEN 0 AND 100)
      AND (periodicity_centi IS NULL OR periodicity_centi BETWEEN 0 AND 100)
      AND (dwell_bucket IS NULL OR dwell_bucket BETWEEN 0 AND 4)
      AND (transport_mode_centi IS NULL OR transport_mode_centi BETWEEN 0 AND 100)
      AND (sensor_health_centi IS NULL OR sensor_health_centi BETWEEN 0 AND 100)
      AND (acoustic_energy_bucket IS NULL OR acoustic_energy_bucket BETWEEN 0 AND 4)
      AND (acoustic_health_centi IS NULL OR acoustic_health_centi BETWEEN 0 AND 100)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sensing_anon_features_enums') THEN
    ALTER TABLE public.sensing_anon_contributions ADD CONSTRAINT sensing_anon_features_enums CHECK (
      (movement_class IS NULL OR movement_class IN ('stationary','pedestrian','vehicular','unknown'))
      AND (transition_kind IS NULL OR transition_kind IN ('arrival','departure','none','unknown'))
      AND (transport_mode IS NULL OR transport_mode IN ('stationary','pedestrian','cycling','vehicular'))
      AND (density_bucket IS NULL OR density_bucket IN ('unknown','sparse','moderate','busy','packed'))
      AND (acoustic_rhythm IS NULL OR acoustic_rhythm IN ('none','irregular','steady','strong'))
    );
  END IF;
  -- The acoustic pair travels together or not at all: energy without the
  -- separate permission's rhythm/health is a half-record nobody can read.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sensing_anon_features_acoustic_pair') THEN
    ALTER TABLE public.sensing_anon_contributions ADD CONSTRAINT sensing_anon_features_acoustic_pair CHECK (
      (acoustic_energy_bucket IS NULL) = (acoustic_rhythm IS NULL)
    );
  END IF;
END $$;

COMMENT ON COLUMN public.sensing_anon_contributions.motion_energy_centi IS
  'Device-reduced normalised motion energy, 0..100 (a centi of the device''s 0..1). The vibe producer reads THIS for motionEnergy; signal_bucket stays the legacy 0..4 companion whose ordinal meaning is pinned by reduction_version.';
COMMENT ON COLUMN public.sensing_anon_contributions.acoustic_energy_bucket IS
  'Present ONLY when the device held the separate, explicit acoustic permission (sensing.acoustic.energy); 0..4 loudness ordinal, never a recording. The aggregate reports acousticPermissionGranted from the cohort''s presence of this column.';
COMMENT ON COLUMN public.sensing_anon_contributions.place_candidate IS
  'The canonical-place candidate the app already held for the window, if any. Text, no foreign key: the anonymous store references nothing.';

-- ── Postconditions: 2315''s rulings hold over the widened table ─────────────
DO $$
DECLARE
  v_col text;
  v_bad text;
  v_fks int;
BEGIN
  FOREACH v_col IN ARRAY ARRAY[
    'user_id','actor_id','profile_id','account_id','auth_id','owner_id',
    'created_by','contributor_id','device_id','session_id','installation_id'
  ] LOOP
    PERFORM 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sensing_anon_contributions' AND column_name = v_col;
    IF FOUND THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_anon_contributions has a column named %.', v_col;
    END IF;
  END LOOP;
  FOREACH v_bad IN ARRAY ARRAY[
    'status','state','claim_type','claim_id','claim_family','value',
    'conflict','conflict_state','snapshot','snapshot_id','review','review_id',
    'reviewer_id','verdict','moderation_state','visibility','confidence',
    'superseded_by','promotion_source','prior_status','new_status','source_class'
  ] LOOP
    PERFORM 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sensing_anon_contributions' AND column_name = v_bad;
    IF FOUND THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_anon_contributions has a lifecycle column named %.', v_bad;
    END IF;
  END LOOP;
  SELECT count(*) INTO v_fks FROM pg_constraint
   WHERE conrelid = 'public.sensing_anon_contributions'::regclass AND contype = 'f';
  IF v_fks > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_anon_contributions has % foreign key(s).', v_fks;
  END IF;
  FOREACH v_col IN ARRAY ARRAY[
    'zone_precision','place_candidate','movement_class','motion_energy_centi','periodicity_centi',
    'dwell_bucket','transition_kind','transport_mode','transport_mode_centi','density_bucket',
    'bounded_movement','sensor_health_centi','acoustic_energy_bucket','acoustic_rhythm','acoustic_health_centi'
  ] LOOP
    PERFORM 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sensing_anon_contributions' AND column_name = v_col AND is_nullable = 'YES';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_anon_contributions.% is absent or NOT NULL; every feature must be optional so a legacy-shape contribution still inserts.', v_col;
    END IF;
  END LOOP;
  FOREACH v_col IN ARRAY ARRAY['sensing_anon_features_ranges','sensing_anon_features_enums','sensing_anon_features_acoustic_pair'] LOOP
    PERFORM 1 FROM pg_constraint WHERE conname = v_col;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: CHECK % is absent; an unbucketed value would be representable.', v_col;
    END IF;
  END LOOP;
END $$;
