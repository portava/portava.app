-- Rollback for 3312_sensing_anon_contribution_features.sql
--
-- Drops the fifteen feature columns and their three CHECKs. The writer
-- (lib/sensingAnonStore.buildSensingContributionRow) only includes feature
-- columns it was given, so after this rollback a client that sends features
-- fails the insert with an unknown-column error — and routes/sensingIngest
-- answers db_error, a NAMED refusal (§4.3), not a silent drop. Roll the code
-- back with it, or keep the columns. Idempotent.

ALTER TABLE public.sensing_anon_contributions
  DROP CONSTRAINT IF EXISTS sensing_anon_features_acoustic_pair,
  DROP CONSTRAINT IF EXISTS sensing_anon_features_enums,
  DROP CONSTRAINT IF EXISTS sensing_anon_features_ranges;
ALTER TABLE public.sensing_anon_contributions
  DROP COLUMN IF EXISTS zone_precision,
  DROP COLUMN IF EXISTS place_candidate,
  DROP COLUMN IF EXISTS movement_class,
  DROP COLUMN IF EXISTS motion_energy_centi,
  DROP COLUMN IF EXISTS periodicity_centi,
  DROP COLUMN IF EXISTS dwell_bucket,
  DROP COLUMN IF EXISTS transition_kind,
  DROP COLUMN IF EXISTS transport_mode,
  DROP COLUMN IF EXISTS transport_mode_centi,
  DROP COLUMN IF EXISTS density_bucket,
  DROP COLUMN IF EXISTS bounded_movement,
  DROP COLUMN IF EXISTS sensor_health_centi,
  DROP COLUMN IF EXISTS acoustic_energy_bucket,
  DROP COLUMN IF EXISTS acoustic_rhythm,
  DROP COLUMN IF EXISTS acoustic_health_centi;
