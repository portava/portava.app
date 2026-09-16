-- Additive World Experience storage. Rows are derived/recomputable and contain
-- no contributor IDs, coordinates, or raw sensing. The table is inert until
-- the world-intelligence rollout flag is explicitly enabled.
CREATE TABLE IF NOT EXISTS world_experience_projections (
  id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL,
  subject_id UUID NOT NULL,
  zone_id TEXT,
  zone_key TEXT NOT NULL DEFAULT '',
  projection_kind TEXT NOT NULL CHECK (projection_kind IN ('vibe','experience_state','world_moment','forecast','opportunity')),
  truth_class TEXT NOT NULL CHECK (truth_class IN ('observation','inference','prediction','constraint')),
  state TEXT NOT NULL CHECK (state IN ('known','unknown','conflicting','stale')),
  confidence NUMERIC NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  coverage TEXT NOT NULL CHECK (coverage IN ('covered','partial','no_coverage')),
  value JSONB,
  observed_at TIMESTAMPTZ,
  valid_until TIMESTAMPTZ,
  temporal_kind TEXT NOT NULL CHECK (temporal_kind IN ('current','historical','forecast','window')),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  lineage JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.world_experience_projections
  DROP CONSTRAINT IF EXISTS world_experience_subject_kind_check;
ALTER TABLE public.world_experience_projections
  ADD CONSTRAINT world_experience_subject_kind_check
  CHECK (subject_kind IN ('place','locality','experience','zone','neighborhood','route','event','service'));
ALTER TABLE public.world_experience_projections
  ADD COLUMN IF NOT EXISTS zone_key TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS world_experience_subject_idx
  ON world_experience_projections (subject_kind, subject_id, zone_id, projection_kind);
CREATE INDEX IF NOT EXISTS world_experience_valid_idx
  ON world_experience_projections (valid_until);
DROP INDEX IF EXISTS world_experience_upsert_key;
CREATE UNIQUE INDEX IF NOT EXISTS world_experience_upsert_key
  ON world_experience_projections (subject_kind, subject_id, zone_key, projection_kind);

ALTER TABLE public.world_experience_projections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.world_experience_projections FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.world_experience_projections TO service_role;
DROP POLICY IF EXISTS "world experience service only" ON public.world_experience_projections;
CREATE POLICY "world experience service only"
  ON public.world_experience_projections FOR ALL TO service_role
  USING (true) WITH CHECK (true);

INSERT INTO public.feature_flags (flag, enabled, description)
VALUES
  ('intel_world_experience', false, 'Build privacy-safe World Experience projections'),
  ('intel_world_experience_live', false, 'Surface predictive World Experience projections; off means shadow mode')
ON CONFLICT (flag) DO NOTHING;

INSERT INTO public.freshness_policies (claim_type, ttl_seconds, hard_expiry_seconds, note)
VALUES ('safety.constraint', 900, 3600, 'Authoritative place safety constraint or clearance.')
ON CONFLICT (claim_type) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.world_safety_constraints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id UUID NOT NULL REFERENCES public.places(id) ON DELETE CASCADE,
  zone_id TEXT,
  zone_key TEXT NOT NULL DEFAULT '',
  constrained BOOLEAN NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL,
  provenance JSONB NOT NULL,
  created_by UUID NOT NULL REFERENCES auth.users(id),
  updated_by UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT world_safety_valid_until_check CHECK (valid_until > created_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS world_safety_constraints_subject_zone
  ON public.world_safety_constraints (place_id, zone_key);
ALTER TABLE public.world_safety_constraints ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.world_safety_constraints FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.world_safety_constraints TO service_role;
DROP POLICY IF EXISTS "world safety service only" ON public.world_safety_constraints;
CREATE POLICY "world safety service only" ON public.world_safety_constraints
  FOR ALL TO service_role USING (true) WITH CHECK (true);