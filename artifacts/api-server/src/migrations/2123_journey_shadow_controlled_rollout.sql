-- 2123_journey_shadow_controlled_rollout.sql
--
-- Controlled-rollout scaffold for the Journey shadow-segmentation path
-- introduced by 2103. Nothing here enables a flag, grants user-facing access,
-- or creates a product consumer. Every table and RPC is internal/service-only.
--
-- Builds on: 2103, 2119, 2120, 2122 (must all be applied first).
-- Does NOT rewrite those migrations.
--
-- Hardening (in-file, no new file):
--   * Admin check requires profiles.role = 'admin'; fails closed on missing/other role.
--   * configure stage requires p_approved_by = p_actor and p_approved_at within 5 min of clock.
--   * Removed permanent UNIQUE(user_id,stage_id); partial unique index on active rows only.
--   * Revoked assignments are never reactivated; new audit row always created on re-assign.
--   * revoke_journey_shadow_cohort_v1 atomically revokes assignment + issuances, ends
--     issued sessions, deletes observations and segment revisions under per-user advisory lock.
--   * Trigger revocation sets revoked_by = v_user_id (owner/self) to satisfy NOT NULL
--     constraint; account-deletion path sets revoked_by = NULL under a relaxed nullable column.
--   * journey_shadow_session_issuances.assignment_id is ON DELETE CASCADE so profile/account
--     deletion cannot be blocked by FK.
--   * journey_shadow_ground_truth.assignment_id is ON DELETE CASCADE.
--   * Ground truth has expires_at NOT NULL bounded to 30 days; RPC sets expiry.
--   * Ground truth rejects coordinate/raw-id keys at any depth (deep, fail-closed) and caps size.
--   * QA report payload rejects personal/raw/exact-coordinate keys at any depth (deep, fail-closed).
--   * journey_segment_revisions gains timing_uncertainty, quality_summary, place_provenance
--     JSONB columns (object-or-null checks); v2 append whitelists and inserts them.
--   * Segment append rejects serialised coordinate/raw-id key names in all JSONB columns.
--   * ingest_journey_observation_v2 requires quality_version = 'journey-observation-quality-v1',
--     quality_score in [0,1], quality_class in {high,usable,degraded,unusable}; all four fields
--     mandatory. Unusable rows are persisted for QA/report distribution measurement; segmentation
--     excludes them at read time via .neq("quality_class","unusable").
--   * All flags remain default false; none are enabled.
--
-- Integration changes (A + B):
--   A) journey_shadow_ground_truth gains location_session_id uuid NOT NULL FK
--      location_sessions(id) ON DELETE CASCADE. record_journey_shadow_ground_truth_v1
--      gains p_location_session_id, verifies it belongs to the assignment/user via
--      journey_shadow_session_issuances, and inserts it. Enables direct QA comparison
--      of truth records to shadow revisions without storing session IDs inside JSON.
--   B) journey_retention_health gains nullable/default-zero breakdown columns
--      last_observation_deleted_count, last_segment_deleted_count,
--      last_ground_truth_deleted_count. finish_journey_retention_cycle_v2 preserves
--      all v1 lease-token/health-state/consecutive-failure semantics and stores the
--      per-purge breakdowns. v1 remains intact and callable. Central authority
--      continues reading the same HEALTHY row; the new columns prove all three purges ran.
--      Scorer version constant confirmed: 'journey-observation-quality-v1'.
--
-- Rollout-boundedness control:
--   * journey_shadow_stages gains max_accounts integer NOT NULL, bound exactly to the
--     stage by CHECK (internal=10, qa=25, consented=50). configure_journey_shadow_stage_v1
--     derives it from p_stage and never accepts it as caller input.
--   * assign_journey_shadow_cohort_v1 locks the stage row (FOR UPDATE), counts active
--     (revoked_at IS NULL) assignments for that stage, and fails before insert when
--     max_accounts is reached. An idempotent return of an already-active assignment does
--     not consume a slot. max_accounts is exposed to admins via existing SELECT access.

BEGIN;

-- ============================================================
-- PRECONDITIONS
-- ============================================================

DO $$
DECLARE
  v_missing_tables text[];
  v_flag_count     integer;
BEGIN
  SELECT array_agg(t ORDER BY t)
    INTO v_missing_tables
    FROM unnest(ARRAY[
      'public.journey_observations',
      'public.journey_segment_revisions',
      'public.journey_retention_health',
      'public.user_location_preferences',
      'public.location_sessions',
      'public.profiles',
      'public.feature_flags'
    ]) AS t
   WHERE to_regclass(t) IS NULL;

  IF v_missing_tables IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: required tables absent: %',
      array_to_string(v_missing_tables, ', ');
  END IF;

  SELECT count(*)
    INTO v_flag_count
    FROM public.feature_flags
   WHERE flag IN (
     'COMPASS_JOURNEY_ENGINE_ENABLED',
     'COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED',
     'COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED'
   );
  IF v_flag_count <> 3 THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: all three Journey capability flags must exist (got %)',
      v_flag_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'user_location_preferences'
       AND column_name  = 'journey_consent_scope'
  ) THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: user_location_preferences.journey_consent_scope missing; apply 2120';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'location_sessions'
       AND column_name  = 'journey_purpose'
  ) THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: location_sessions.journey_purpose missing; apply 2120';
  END IF;

  -- profiles.role must exist (established pre-2078)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'profiles'
       AND column_name  = 'role'
  ) THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: profiles.role missing; admin gate cannot be enforced in SQL';
  END IF;
END $$;

-- ============================================================
-- SECTION 1 – SCHEMA EXTENSIONS
-- ============================================================

-- 1a. journey_observations – quality columns (nullable; legacy v1 rows keep NULL)
ALTER TABLE public.journey_observations
  ADD COLUMN IF NOT EXISTS quality_version text,
  ADD COLUMN IF NOT EXISTS quality_score   numeric,
  ADD COLUMN IF NOT EXISTS quality_class   text,
  ADD COLUMN IF NOT EXISTS quality_reasons text[];

ALTER TABLE public.journey_observations
  DROP CONSTRAINT IF EXISTS journey_observations_quality_class_check;
ALTER TABLE public.journey_observations
  ADD CONSTRAINT journey_observations_quality_class_check
  CHECK (
    quality_class IS NULL
    OR quality_class IN ('high', 'usable', 'degraded', 'unusable')
  );

ALTER TABLE public.journey_observations
  DROP CONSTRAINT IF EXISTS journey_observations_quality_score_check;
ALTER TABLE public.journey_observations
  ADD CONSTRAINT journey_observations_quality_score_check
  CHECK (
    quality_score IS NULL
    OR (quality_score >= 0 AND quality_score <= 1)
  );

COMMENT ON COLUMN public.journey_observations.quality_version IS
  'Scorer algorithm version. Null for legacy v1 rows. v2 requires journey-observation-quality-v1.';
COMMENT ON COLUMN public.journey_observations.quality_score IS
  'Normalised [0,1] quality estimate. Null for legacy v1 rows.';
COMMENT ON COLUMN public.journey_observations.quality_class IS
  'Quality bucket: high|usable|degraded|unusable. All four classes are persisted by v2 so '
  'QA/report aggregate paths can measure stale/poor-accuracy/impossible-speed distributions. '
  'Segmentation excludes unusable rows at read time.';
COMMENT ON COLUMN public.journey_observations.quality_reasons IS
  'Machine-readable reason codes for the quality classification.';

-- 1b. journey_segment_revisions – quality, provenance, time-range, place, and structured columns
ALTER TABLE public.journey_segment_revisions
  ADD COLUMN IF NOT EXISTS quality_version     text,
  ADD COLUMN IF NOT EXISTS quality_score       numeric,
  ADD COLUMN IF NOT EXISTS quality_class       text,
  ADD COLUMN IF NOT EXISTS quality_reasons     text[],
  ADD COLUMN IF NOT EXISTS provenance_version  text,
  ADD COLUMN IF NOT EXISTS segment_started_at  timestamptz,
  ADD COLUMN IF NOT EXISTS segment_ended_at    timestamptz,
  ADD COLUMN IF NOT EXISTS place_category      text,
  ADD COLUMN IF NOT EXISTS place_subcategory   text,
  -- Structured JSONB columns (issue #5)
  ADD COLUMN IF NOT EXISTS timing_uncertainty  jsonb,
  ADD COLUMN IF NOT EXISTS quality_summary     jsonb,
  ADD COLUMN IF NOT EXISTS place_provenance    jsonb;

ALTER TABLE public.journey_segment_revisions
  DROP CONSTRAINT IF EXISTS journey_segment_revisions_quality_class_check;
ALTER TABLE public.journey_segment_revisions
  ADD CONSTRAINT journey_segment_revisions_quality_class_check
  CHECK (
    quality_class IS NULL
    OR quality_class IN ('high', 'usable', 'degraded', 'unusable')
  );

ALTER TABLE public.journey_segment_revisions
  DROP CONSTRAINT IF EXISTS journey_segment_revisions_quality_score_check;
ALTER TABLE public.journey_segment_revisions
  ADD CONSTRAINT journey_segment_revisions_quality_score_check
  CHECK (
    quality_score IS NULL
    OR (quality_score >= 0 AND quality_score <= 1)
  );

ALTER TABLE public.journey_segment_revisions
  DROP CONSTRAINT IF EXISTS journey_segment_revisions_time_range_check;
ALTER TABLE public.journey_segment_revisions
  ADD CONSTRAINT journey_segment_revisions_time_range_check
  CHECK (
    segment_started_at IS NULL
    OR segment_ended_at IS NULL
    OR segment_ended_at >= segment_started_at
  );

-- Structured JSONB columns must be objects or null
ALTER TABLE public.journey_segment_revisions
  DROP CONSTRAINT IF EXISTS journey_segment_revisions_jsonb_struct_check;
ALTER TABLE public.journey_segment_revisions
  ADD CONSTRAINT journey_segment_revisions_jsonb_struct_check
  CHECK (
    (timing_uncertainty IS NULL OR jsonb_typeof(timing_uncertainty) = 'object')
    AND (quality_summary IS NULL OR jsonb_typeof(quality_summary) = 'object')
    AND (place_provenance IS NULL OR jsonb_typeof(place_provenance) = 'object')
  );

COMMENT ON COLUMN public.journey_segment_revisions.quality_version IS
  'Scorer algorithm version for segment quality.';
COMMENT ON COLUMN public.journey_segment_revisions.quality_score IS
  'Normalised [0,1] quality estimate for this segment revision.';
COMMENT ON COLUMN public.journey_segment_revisions.quality_class IS
  'Coarse quality bucket for this segment revision.';
COMMENT ON COLUMN public.journey_segment_revisions.quality_reasons IS
  'Machine-readable reason codes for segment quality.';
COMMENT ON COLUMN public.journey_segment_revisions.provenance_version IS
  'Pipeline version tag for this derived segment revision.';
COMMENT ON COLUMN public.journey_segment_revisions.segment_started_at IS
  'Effective window start (may differ from started_at for partial revisions).';
COMMENT ON COLUMN public.journey_segment_revisions.segment_ended_at IS
  'Effective window end; null while open.';
COMMENT ON COLUMN public.journey_segment_revisions.place_category IS
  'Coarse place category without exact coordinates (e.g. transit_hub, retail).';
COMMENT ON COLUMN public.journey_segment_revisions.place_subcategory IS
  'Optional subcategory narrowing place_category.';
COMMENT ON COLUMN public.journey_segment_revisions.timing_uncertainty IS
  'Structured timing uncertainty object (object or null). No exact coordinates permitted.';
COMMENT ON COLUMN public.journey_segment_revisions.quality_summary IS
  'Structured quality summary object (object or null). Aggregate only.';
COMMENT ON COLUMN public.journey_segment_revisions.place_provenance IS
  'Structured place-provenance object (object or null). No exact coordinates permitted.';

-- ============================================================
-- SECTION 2 – ROLLOUT CONTROL TABLES (service-only, FORCE RLS)
-- ============================================================

-- 2a. journey_shadow_stages
-- max_accounts is a non-overridable, service-controlled rollout cap tied
-- exactly to the stage: internal=10, qa=25, consented=50. It is derived from
-- p_stage inside configure_journey_shadow_stage_v1 and is never caller input.
CREATE TABLE IF NOT EXISTS public.journey_shadow_stages (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  stage        text        NOT NULL,
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  approved_by  uuid        NOT NULL REFERENCES public.profiles(id),
  approved_at  timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  is_active    boolean     NOT NULL DEFAULT true,
  max_accounts integer     NOT NULL,

  CONSTRAINT journey_shadow_stages_stage_check
    CHECK (stage IN ('internal', 'qa', 'consented')),
  CONSTRAINT journey_shadow_stages_window_check
    CHECK (ends_at > starts_at),
  CONSTRAINT journey_shadow_stages_max_duration_check
    CHECK (ends_at <= starts_at + interval '30 days'),
  -- approved_at must be close to stage creation; enforced tightly in RPC
  CONSTRAINT journey_shadow_stages_approved_at_check
    CHECK (approved_at <= starts_at + interval '10 minutes'),
  -- max_accounts is bound exactly to the stage; no other pairing is valid.
  CONSTRAINT journey_shadow_stages_max_accounts_check
    CHECK (
      (stage = 'internal'  AND max_accounts = 10)
      OR (stage = 'qa'        AND max_accounts = 25)
      OR (stage = 'consented' AND max_accounts = 50)
    )
);

CREATE INDEX IF NOT EXISTS journey_shadow_stages_active_idx
  ON public.journey_shadow_stages (is_active, starts_at, ends_at)
  WHERE is_active = true;

COMMENT ON TABLE public.journey_shadow_stages IS
  'INTERNAL SHADOW ONLY. Time-limited controlled-rollout stage records (<= 30 days). '
  'Writes via configure_journey_shadow_stage_v1 only. No anon/authenticated access. '
  'max_accounts is a non-overridable service-controlled cap tied to the stage.';
COMMENT ON COLUMN public.journey_shadow_stages.max_accounts IS
  'Non-overridable rollout cap derived from stage: internal=10, qa=25, consented=50. '
  'Set by configure_journey_shadow_stage_v1 from p_stage; never accepted as caller input. '
  'Enforced by assign_journey_shadow_cohort_v1 against active (unrevoked) assignment count.';

ALTER TABLE public.journey_shadow_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journey_shadow_stages FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.journey_shadow_stages FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.journey_shadow_stages FROM service_role;
GRANT SELECT ON TABLE public.journey_shadow_stages TO service_role;

-- 2b. journey_shadow_cohort_assignments
-- No permanent UNIQUE(user_id, stage_id): a revoked assignment must never be
-- reactivated, so we use a partial unique index on unrevoked rows only.
-- A new assignment after revocation creates a new audit row with a new PK.
CREATE TABLE IF NOT EXISTS public.journey_shadow_cohort_assignments (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  stage_id         uuid        NOT NULL REFERENCES public.journey_shadow_stages(id),
  assigned_at      timestamptz NOT NULL DEFAULT now(),
  assigned_by      uuid        NOT NULL REFERENCES public.profiles(id),
  revoked_at       timestamptz,
  -- revoked_by: admin actor for explicit revocation; owner user_id for
  -- owner/consent revocation; NULL only permitted via account-deletion path
  -- where no actor UUID is meaningful (column intentionally nullable).
  revoked_by       uuid        REFERENCES public.profiles(id),
  cohort_starts_at timestamptz NOT NULL,
  cohort_ends_at   timestamptz NOT NULL,
  consent_scope    text        NOT NULL DEFAULT 'journey_observation_v1',
  consent_version  smallint    NOT NULL DEFAULT 1,

  CONSTRAINT journey_shadow_cohort_consent_scope_check
    CHECK (consent_scope = 'journey_observation_v1'),
  CONSTRAINT journey_shadow_cohort_window_check
    CHECK (cohort_ends_at > cohort_starts_at),
  CONSTRAINT journey_shadow_cohort_revocation_check
    CHECK (
      revoked_at IS NULL
      OR revoked_at >= assigned_at
    )
);

-- Partial unique: only one active (unrevoked) assignment per user per stage.
CREATE UNIQUE INDEX IF NOT EXISTS journey_shadow_cohort_active_unique_idx
  ON public.journey_shadow_cohort_assignments (user_id, stage_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS journey_shadow_cohort_user_idx
  ON public.journey_shadow_cohort_assignments (user_id, assigned_at DESC);

COMMENT ON TABLE public.journey_shadow_cohort_assignments IS
  'INTERNAL SHADOW ONLY. Per-user cohort assignments for the controlled rollout. '
  'One active (unrevoked) assignment per user per stage enforced by partial unique index. '
  'Revoked rows are never reactivated; re-assignment after revocation creates a new audit row. '
  'Writes via assign/revoke RPCs only. No anon/authenticated access.';

ALTER TABLE public.journey_shadow_cohort_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journey_shadow_cohort_assignments FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.journey_shadow_cohort_assignments FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.journey_shadow_cohort_assignments FROM service_role;
GRANT SELECT ON TABLE public.journey_shadow_cohort_assignments TO service_role;

-- 2c. journey_shadow_session_issuances
-- ON DELETE CASCADE on assignment_id so profile/account deletion cannot be blocked.
CREATE TABLE IF NOT EXISTS public.journey_shadow_session_issuances (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id       uuid        NOT NULL
    REFERENCES public.journey_shadow_cohort_assignments(id) ON DELETE CASCADE,
  user_id             uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  location_session_id uuid        NOT NULL
    REFERENCES public.location_sessions(id) ON DELETE CASCADE,
  issued_at           timestamptz NOT NULL DEFAULT now(),
  issued_by           uuid        NOT NULL REFERENCES public.profiles(id),
  session_type        text        NOT NULL,
  session_expires_at  timestamptz NOT NULL,
  revoked_at          timestamptz,

  CONSTRAINT journey_shadow_session_type_check
    CHECK (session_type IN ('live_share', 'trip_check_in')),
  CONSTRAINT journey_shadow_session_expires_check
    CHECK (session_expires_at > issued_at),
  CONSTRAINT journey_shadow_session_max_duration_check
    CHECK (session_expires_at <= issued_at + interval '24 hours'),
  CONSTRAINT journey_shadow_session_revoked_check
    CHECK (revoked_at IS NULL OR revoked_at >= issued_at),
  UNIQUE (location_session_id)
);

COMMENT ON TABLE public.journey_shadow_session_issuances IS
  'INTERNAL SHADOW ONLY. Tracks every location_sessions row issued for a shadow cohort member. '
  'ON DELETE CASCADE from assignment ensures account deletion is never blocked. '
  'Writes via issue_journey_shadow_session_v1 only. No anon/authenticated access.';

ALTER TABLE public.journey_shadow_session_issuances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journey_shadow_session_issuances FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.journey_shadow_session_issuances FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.journey_shadow_session_issuances FROM service_role;
GRANT SELECT ON TABLE public.journey_shadow_session_issuances TO service_role;

-- 2d. journey_shadow_ground_truth
-- ON DELETE CASCADE on assignment_id and location_session_id.
-- location_session_id FK enables direct QA comparison to shadow revisions without
-- putting session IDs inside the JSON payload.
-- expires_at NOT NULL; bounded to <= 30 days of submitted_at (enforced by CHECK + RPC).
CREATE TABLE IF NOT EXISTS public.journey_shadow_ground_truth (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id       uuid        NOT NULL
    REFERENCES public.journey_shadow_cohort_assignments(id) ON DELETE CASCADE,
  user_id             uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  location_session_id uuid        NOT NULL
    REFERENCES public.location_sessions(id) ON DELETE CASCADE,
  recorded_at         timestamptz NOT NULL,
  submitted_by        uuid        NOT NULL REFERENCES public.profiles(id),
  submitted_at        timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  ground_truth        jsonb       NOT NULL,
  notes               text,

  CONSTRAINT journey_shadow_ground_truth_payload_check
    CHECK (jsonb_typeof(ground_truth) = 'object'),
  CONSTRAINT journey_shadow_ground_truth_expiry_check
    CHECK (
      expires_at > submitted_at
      AND expires_at <= submitted_at + interval '30 days'
    )
);

CREATE INDEX IF NOT EXISTS journey_shadow_ground_truth_expires_idx
  ON public.journey_shadow_ground_truth (expires_at);
CREATE INDEX IF NOT EXISTS journey_shadow_ground_truth_session_idx
  ON public.journey_shadow_ground_truth (location_session_id);

COMMENT ON TABLE public.journey_shadow_ground_truth IS
  'INTERNAL SHADOW ONLY. Operator-submitted ground-truth records for QA analysis. '
  'location_session_id FK enables direct comparison to shadow revisions without session IDs in JSON. '
  'No exact coordinates stored. expires_at bounded to 30 days. '
  'Writes via record_journey_shadow_ground_truth_v1. ON DELETE CASCADE from assignment and session.';
COMMENT ON COLUMN public.journey_shadow_ground_truth.location_session_id IS
  'The issued shadow session this truth record corresponds to. FK to location_sessions ON DELETE CASCADE.';

ALTER TABLE public.journey_shadow_ground_truth ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journey_shadow_ground_truth FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.journey_shadow_ground_truth FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.journey_shadow_ground_truth FROM service_role;
GRANT SELECT ON TABLE public.journey_shadow_ground_truth TO service_role;

-- 2e. journey_shadow_qa_reports
CREATE TABLE IF NOT EXISTS public.journey_shadow_qa_reports (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_id         uuid        NOT NULL REFERENCES public.journey_shadow_stages(id),
  report_type      text        NOT NULL,
  period_starts_at timestamptz NOT NULL,
  period_ends_at   timestamptz NOT NULL,
  submitted_by     uuid        NOT NULL REFERENCES public.profiles(id),
  submitted_at     timestamptz NOT NULL DEFAULT now(),
  payload          jsonb       NOT NULL,
  notes            text,

  CONSTRAINT journey_shadow_qa_report_type_check
    CHECK (report_type IN ('segment_accuracy', 'retention_health', 'cohort_summary', 'custom')),
  CONSTRAINT journey_shadow_qa_report_period_check
    CHECK (period_ends_at > period_starts_at),
  CONSTRAINT journey_shadow_qa_report_payload_check
    CHECK (jsonb_typeof(payload) = 'object')
);

COMMENT ON TABLE public.journey_shadow_qa_reports IS
  'INTERNAL SHADOW ONLY. Aggregate QA reports for controlled-rollout analysis. '
  'No raw location or personal identifiers. Writes via persist_journey_shadow_qa_report_v1.';

ALTER TABLE public.journey_shadow_qa_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journey_shadow_qa_reports FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.journey_shadow_qa_reports FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.journey_shadow_qa_reports FROM service_role;
GRANT SELECT ON TABLE public.journey_shadow_qa_reports TO service_role;

-- ============================================================
-- SECTION 3 – FEATURE FLAG SEED
-- ============================================================

INSERT INTO public.feature_flags (flag, enabled, description, metadata) VALUES
  (
    'COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED',
    false,
    'Persist mechanical movement/stop/dwell revisions for aggregate shadow quality review only.',
    '{"default":"off","consumer_access":false,"rollout":"controlled","migration":"2123"}'::jsonb
  )
ON CONFLICT (flag) DO NOTHING;

-- ============================================================
-- SECTION 4 – FORBIDDEN KEY HELPERS
-- ============================================================

-- Returns true if the JSONB object (top-level only) contains any key that looks like
-- an exact coordinate field, a raw observation identifier, or a personal identifier.
-- Retained for backward compatibility; it NO LONGER guards the ground-truth or QA
-- payloads (those now use the deep, fail-closed helper below). Prefer the deep helper
-- for any new payload validation.
CREATE OR REPLACE FUNCTION public._journey_shadow_jsonb_has_forbidden_keys(p_val jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM jsonb_object_keys(p_val) AS k
     WHERE lower(k) = ANY (ARRAY[
       'lat', 'lng', 'latitude', 'longitude', 'coordinates',
       'observation_id', 'observation_ids', 'raw_ids', 'raw_id',
       'user_id', 'profile_id', 'account_id', 'device_id'
     ])
  );
$$;

REVOKE ALL ON FUNCTION public._journey_shadow_jsonb_has_forbidden_keys(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

-- Recursively walk a JSONB value and return true if any string key at any depth
-- matches the forbidden set. Depth cap: 8 levels, and it FAILS CLOSED — if a
-- value is still an object/array at depth >= 8 (i.e. there could be forbidden
-- keys hidden deeper, e.g. at depth 9), we return true (reject) rather than
-- false. Scalars at any depth are safe and return false. This both prevents
-- deeply-hidden forbidden keys and bounds recursion work.
CREATE OR REPLACE FUNCTION public._journey_shadow_jsonb_has_forbidden_keys_deep(
  p_val   jsonb,
  p_depth integer DEFAULT 0
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_key   text;
  v_child jsonb;
BEGIN
  IF p_val IS NULL OR jsonb_typeof(p_val) NOT IN ('object', 'array') THEN
    RETURN false;
  END IF;
  -- Fail closed: a container that survives to the depth cap is unreadable
  -- below this point, so we conservatively treat it as containing forbidden keys.
  IF p_depth >= 8 THEN
    RETURN true;
  END IF;

  IF jsonb_typeof(p_val) = 'object' THEN
    FOR v_key, v_child IN SELECT k, v FROM jsonb_each(p_val) AS e(k, v) LOOP
      IF lower(v_key) = ANY (ARRAY[
        'lat', 'lng', 'latitude', 'longitude', 'coordinates',
        'observation_id', 'observation_ids', 'raw_ids', 'raw_id',
        'user_id', 'profile_id', 'account_id', 'device_id'
      ]) THEN
        RETURN true;
      END IF;
      IF public._journey_shadow_jsonb_has_forbidden_keys_deep(v_child, p_depth + 1) THEN
        RETURN true;
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(p_val) = 'array' THEN
    FOR v_child IN SELECT e FROM jsonb_array_elements(p_val) AS e LOOP
      IF public._journey_shadow_jsonb_has_forbidden_keys_deep(v_child, p_depth + 1) THEN
        RETURN true;
      END IF;
    END LOOP;
  END IF;

  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public._journey_shadow_jsonb_has_forbidden_keys_deep(jsonb, integer)
  FROM PUBLIC, anon, authenticated, service_role;

-- ============================================================
-- SECTION 5 – ADMIN ACTOR HELPER
-- Requires profiles.role = 'admin'. Fails closed on missing/other role.
-- Revoked from everyone including service_role; called only from other
-- SECURITY DEFINER functions (which run as the function owner).
-- ============================================================

CREATE OR REPLACE FUNCTION public._journey_shadow_require_admin_actor(p_actor uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'admin actor required' USING ERRCODE = '42501';
  END IF;
  -- Fail closed: missing row or role <> 'admin' both deny.
  IF NOT EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE id = p_actor
       AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'actor % is not an admin' , p_actor USING ERRCODE = '42501';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public._journey_shadow_require_admin_actor(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ============================================================
-- SECTION 6 – STAGE CONFIGURATION RPC
-- p_approved_by must equal p_actor (self-attestation within the RPC);
-- p_approved_at must be within 5 minutes of clock_timestamp().
-- ============================================================

CREATE OR REPLACE FUNCTION public.configure_journey_shadow_stage_v1(
  p_actor       uuid,
  p_stage       text,
  p_starts_at   timestamptz,
  p_ends_at     timestamptz,
  p_approved_by uuid,
  p_approved_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now          timestamptz := clock_timestamp();
  v_id           uuid;
  v_max_accounts integer;
BEGIN
  PERFORM public._journey_shadow_require_admin_actor(p_actor);

  IF p_stage NOT IN ('internal', 'qa', 'consented') THEN
    RAISE EXCEPTION 'invalid stage: %', p_stage;
  END IF;

  -- max_accounts is service-controlled and derived exactly from the stage;
  -- it is never accepted as caller input.
  v_max_accounts := CASE p_stage
    WHEN 'internal'  THEN 10
    WHEN 'qa'        THEN 25
    WHEN 'consented' THEN 50
  END;
  IF p_starts_at IS NULL OR p_ends_at IS NULL THEN
    RAISE EXCEPTION 'starts_at and ends_at are required';
  END IF;
  IF p_ends_at <= p_starts_at THEN
    RAISE EXCEPTION 'ends_at must be after starts_at';
  END IF;
  IF p_ends_at > p_starts_at + interval '30 days' THEN
    RAISE EXCEPTION 'stage duration must not exceed 30 days';
  END IF;

  -- Anti-forgery: approved_by must be the calling admin actor.
  IF p_approved_by IS DISTINCT FROM p_actor THEN
    RAISE EXCEPTION 'approved_by must equal the calling actor' USING ERRCODE = '42501';
  END IF;
  IF p_approved_at IS NULL THEN
    RAISE EXCEPTION 'approved_at is required';
  END IF;
  -- approved_at must be within 5 minutes of clock time (no forged timestamps).
  IF p_approved_at < v_now - interval '5 minutes'
     OR p_approved_at > v_now + interval '5 minutes' THEN
    RAISE EXCEPTION 'approved_at must be within 5 minutes of server time' USING ERRCODE = '42501';
  END IF;

  -- Deactivate any currently-active stage
  UPDATE public.journey_shadow_stages
     SET is_active = false
   WHERE is_active = true;

  INSERT INTO public.journey_shadow_stages (
    stage, starts_at, ends_at, approved_by, approved_at, is_active, max_accounts
  ) VALUES (
    p_stage, p_starts_at, p_ends_at, p_approved_by, p_approved_at, true, v_max_accounts
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.configure_journey_shadow_stage_v1(uuid, text, timestamptz, timestamptz, uuid, timestamptz) IS
  'INTERNAL SHADOW ONLY. Admin-only. Sets the active rollout stage (<= 30 days). '
  'approved_by must equal the calling actor; approved_at must be within 5 min of server clock. '
  'max_accounts is derived from p_stage (internal=10, qa=25, consented=50), never caller input. '
  'Deactivates any prior stage before inserting the new one.';

REVOKE ALL ON FUNCTION public.configure_journey_shadow_stage_v1(uuid, text, timestamptz, timestamptz, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.configure_journey_shadow_stage_v1(uuid, text, timestamptz, timestamptz, uuid, timestamptz)
  TO service_role;

-- ============================================================
-- SECTION 7 – COHORT ASSIGN / REVOKE RPCs
-- assign: never reactivates a revoked row; returns active-id idempotently or
--         inserts a new audit row. Enforces the non-overridable per-stage
--         max_accounts cap (locks the stage, counts active assignments) and
--         fails before insert when the cap is reached; an idempotent return
--         does not consume a slot.
-- revoke: atomically revokes assignment + issuances, ends sessions, deletes
--         observations and segment revisions under per-user advisory lock.
-- ============================================================

CREATE OR REPLACE FUNCTION public.assign_journey_shadow_cohort_v1(
  p_actor            uuid,
  p_user_id          uuid,
  p_stage_id         uuid,
  p_cohort_starts_at timestamptz,
  p_cohort_ends_at   timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_stage        record;
  v_preferences  record;
  v_id           uuid;
  v_active_count integer;
  v_now          timestamptz := clock_timestamp();
BEGIN
  PERFORM public._journey_shadow_require_admin_actor(p_actor);

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id required';
  END IF;
  IF p_stage_id IS NULL THEN
    RAISE EXCEPTION 'stage_id required';
  END IF;
  IF p_cohort_starts_at IS NULL OR p_cohort_ends_at IS NULL THEN
    RAISE EXCEPTION 'cohort window required';
  END IF;
  IF p_cohort_ends_at <= p_cohort_starts_at THEN
    RAISE EXCEPTION 'cohort_ends_at must be after cohort_starts_at';
  END IF;

  -- Verify stage is active and currently within its window.
  -- FOR UPDATE serialises concurrent assigns against the same stage so the
  -- count-then-insert cap check below is race-free.
  SELECT id, stage, starts_at, ends_at, is_active, max_accounts
    INTO v_stage
    FROM public.journey_shadow_stages
   WHERE id = p_stage_id
   FOR UPDATE;

  IF NOT FOUND OR v_stage.is_active IS DISTINCT FROM true
     OR v_now < v_stage.starts_at OR v_now >= v_stage.ends_at THEN
    RAISE EXCEPTION 'stage is not currently active';
  END IF;

  -- Cohort window must fit inside stage window
  IF p_cohort_starts_at < v_stage.starts_at
     OR p_cohort_ends_at > v_stage.ends_at THEN
    RAISE EXCEPTION 'cohort window must be within stage window';
  END IF;

  -- Verify user has explicit, unrevoked, versioned Journey consent
  SELECT journey_observation_enabled,
         journey_consent_scope,
         journey_consent_version,
         journey_consent_granted_at,
         journey_consent_revoked_at
    INTO v_preferences
    FROM public.user_location_preferences
   WHERE user_id = p_user_id
   FOR SHARE;

  IF NOT FOUND
     OR v_preferences.journey_observation_enabled IS DISTINCT FROM true
     OR v_preferences.journey_consent_scope IS DISTINCT FROM 'journey_observation_v1'
     OR v_preferences.journey_consent_version IS DISTINCT FROM 1
     OR v_preferences.journey_consent_granted_at IS NULL
     OR v_preferences.journey_consent_revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'user does not have explicit unrevoked Journey consent'
      USING ERRCODE = '42501';
  END IF;

  -- Idempotent: if an active (unrevoked) assignment already exists, return it.
  -- Do NOT reactivate a revoked row. This check precedes the cap check so an
  -- already-active assignment never consumes a new slot.
  SELECT id INTO v_id
    FROM public.journey_shadow_cohort_assignments
   WHERE user_id = p_user_id
     AND stage_id = p_stage_id
     AND revoked_at IS NULL;

  IF FOUND THEN
    RETURN v_id;
  END IF;

  -- Non-overridable rollout cap: count active (unrevoked) assignments for this
  -- stage under the stage lock and fail before insert if the cap is reached.
  SELECT count(*)
    INTO v_active_count
    FROM public.journey_shadow_cohort_assignments
   WHERE stage_id = p_stage_id
     AND revoked_at IS NULL;

  IF v_active_count >= v_stage.max_accounts THEN
    RAISE EXCEPTION 'stage account cap reached (max_accounts = %)', v_stage.max_accounts
      USING ERRCODE = '42501';
  END IF;

  -- A revoked row may exist; always INSERT a fresh audit row.
  INSERT INTO public.journey_shadow_cohort_assignments (
    user_id, stage_id, assigned_by, cohort_starts_at, cohort_ends_at,
    consent_scope, consent_version
  ) VALUES (
    p_user_id, p_stage_id, p_actor, p_cohort_starts_at, p_cohort_ends_at,
    'journey_observation_v1', 1
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.assign_journey_shadow_cohort_v1(uuid, uuid, uuid, timestamptz, timestamptz) IS
  'INTERNAL SHADOW ONLY. Admin-only. Assigns a user to the shadow cohort for a given stage. '
  'Returns existing active assignment id idempotently (without consuming a cap slot). '
  'Locks the stage row and enforces the non-overridable max_accounts cap against the count '
  'of active (unrevoked) assignments, failing before insert when the cap is reached. '
  'Never reactivates a revoked row; re-assignment after revocation creates a new audit row. '
  'Requires explicit unrevoked versioned Journey consent.';

REVOKE ALL ON FUNCTION public.assign_journey_shadow_cohort_v1(uuid, uuid, uuid, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_journey_shadow_cohort_v1(uuid, uuid, uuid, timestamptz, timestamptz)
  TO service_role;

-- revoke_journey_shadow_cohort_v1
-- Atomically revokes assignment + all issuances, ends issued sessions,
-- deletes that user's raw observations and segment revisions, and deletes the
-- ground-truth rows belonging to this assignment, all under the per-user
-- advisory lock (same lock as append_journey_segment_revisions_v2).
-- The assignment history row itself remains (revoked, not deleted).
CREATE OR REPLACE FUNCTION public.revoke_journey_shadow_cohort_v1(
  p_actor         uuid,
  p_assignment_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_assignment record;
  v_now        timestamptz := clock_timestamp();
  v_updated_id uuid;
BEGIN
  PERFORM public._journey_shadow_require_admin_actor(p_actor);

  IF p_assignment_id IS NULL THEN
    RAISE EXCEPTION 'assignment_id required';
  END IF;

  -- Load assignment for user_id
  SELECT id, user_id INTO v_assignment
    FROM public.journey_shadow_cohort_assignments
   WHERE id = p_assignment_id
     AND revoked_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Per-user advisory lock: serialises with append_journey_segment_revisions_v2
  PERFORM pg_advisory_xact_lock(
    hashtextextended('journey-segments:' || v_assignment.user_id::text, 0)
  );

  -- Revoke the assignment (revoked_by = admin actor)
  UPDATE public.journey_shadow_cohort_assignments
     SET revoked_at = v_now,
         revoked_by = p_actor
   WHERE id = p_assignment_id
     AND revoked_at IS NULL
  RETURNING id INTO v_updated_id;

  IF v_updated_id IS NULL THEN
    RETURN false;
  END IF;

  -- Revoke all issuances belonging to this assignment
  UPDATE public.journey_shadow_session_issuances
     SET revoked_at = v_now
   WHERE assignment_id = p_assignment_id
     AND revoked_at IS NULL;

  -- End all open journey-purpose sessions issued via this assignment
  UPDATE public.location_sessions
     SET ended_at = COALESCE(ended_at, v_now)
   WHERE id IN (
     SELECT location_session_id
       FROM public.journey_shadow_session_issuances
      WHERE assignment_id = p_assignment_id
   )
     AND ended_at IS NULL;

  -- Delete ground-truth rows for this assignment (assignment history remains revoked)
  DELETE FROM public.journey_shadow_ground_truth
   WHERE assignment_id = p_assignment_id;

  -- Delete raw observations for this user
  DELETE FROM public.journey_observations
   WHERE user_id = v_assignment.user_id;

  -- Delete segment revisions for this user
  DELETE FROM public.journey_segment_revisions
   WHERE user_id = v_assignment.user_id;

  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.revoke_journey_shadow_cohort_v1(uuid, uuid) IS
  'INTERNAL SHADOW ONLY. Admin-only. Atomically revokes a cohort assignment and all its '
  'issuances, ends the issued location sessions, deletes raw observations and segment '
  'revisions for that user, and deletes the ground-truth rows for this assignment, all '
  'under the per-user advisory lock. The assignment history row remains (revoked, not deleted).';

REVOKE ALL ON FUNCTION public.revoke_journey_shadow_cohort_v1(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_journey_shadow_cohort_v1(uuid, uuid)
  TO service_role;

-- ============================================================
-- SECTION 8 – SESSION ISSUANCE RPC
-- ============================================================

CREATE OR REPLACE FUNCTION public.issue_journey_shadow_session_v1(
  p_actor         uuid,
  p_assignment_id uuid,
  p_session_type  text,
  p_expires_at    timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_assignment  record;
  v_stage       record;
  v_now         timestamptz := clock_timestamp();
  v_session_id  uuid := gen_random_uuid();
BEGIN
  PERFORM public._journey_shadow_require_admin_actor(p_actor);

  IF p_assignment_id IS NULL THEN
    RAISE EXCEPTION 'assignment_id required';
  END IF;
  IF p_session_type NOT IN ('live_share', 'trip_check_in') THEN
    RAISE EXCEPTION 'session_type must be live_share or trip_check_in';
  END IF;
  IF p_expires_at IS NULL THEN
    RAISE EXCEPTION 'expires_at required';
  END IF;
  IF p_expires_at <= v_now THEN
    RAISE EXCEPTION 'expires_at must be in the future';
  END IF;
  IF p_expires_at > v_now + interval '24 hours' THEN
    RAISE EXCEPTION 'session duration must not exceed 24 hours';
  END IF;

  -- Load and lock assignment
  SELECT a.id, a.user_id, a.stage_id, a.revoked_at,
         a.cohort_starts_at, a.cohort_ends_at
    INTO v_assignment
    FROM public.journey_shadow_cohort_assignments a
   WHERE a.id = p_assignment_id
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'assignment not found';
  END IF;
  IF v_assignment.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'assignment has been revoked' USING ERRCODE = '42501';
  END IF;
  IF v_now < v_assignment.cohort_starts_at OR v_now >= v_assignment.cohort_ends_at THEN
    RAISE EXCEPTION 'cohort window is not currently active';
  END IF;

  -- Load and lock stage
  SELECT s.id, s.is_active, s.starts_at, s.ends_at
    INTO v_stage
    FROM public.journey_shadow_stages s
   WHERE s.id = v_assignment.stage_id
   FOR SHARE;

  IF NOT FOUND OR v_stage.is_active IS DISTINCT FROM true
     OR v_now < v_stage.starts_at OR v_now >= v_stage.ends_at THEN
    RAISE EXCEPTION 'stage is not currently active';
  END IF;

  -- Session must not exceed cohort or stage end
  IF p_expires_at > v_assignment.cohort_ends_at THEN
    RAISE EXCEPTION 'session expires_at must not exceed cohort end';
  END IF;
  IF p_expires_at > v_stage.ends_at THEN
    RAISE EXCEPTION 'session expires_at must not exceed stage end';
  END IF;

  -- Create the location_sessions row
  INSERT INTO public.location_sessions (
    id, user_id, session_type, journey_purpose, started_at, expires_at
  ) VALUES (
    v_session_id,
    v_assignment.user_id,
    p_session_type,
    'journey_observation_v1',
    v_now,
    p_expires_at
  );

  -- Record the issuance
  INSERT INTO public.journey_shadow_session_issuances (
    assignment_id, user_id, location_session_id,
    issued_by, session_type, session_expires_at
  ) VALUES (
    p_assignment_id,
    v_assignment.user_id,
    v_session_id,
    p_actor,
    p_session_type,
    p_expires_at
  );

  RETURN v_session_id;
END;
$$;

COMMENT ON FUNCTION public.issue_journey_shadow_session_v1(uuid, uuid, text, timestamptz) IS
  'INTERNAL SHADOW ONLY. Admin-only. Issues a finite journey_observation_v1 location_sessions '
  'row and records the issuance. Expires at most 24h and no later than cohort/stage end.';

REVOKE ALL ON FUNCTION public.issue_journey_shadow_session_v1(uuid, uuid, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.issue_journey_shadow_session_v1(uuid, uuid, text, timestamptz)
  TO service_role;

-- ============================================================
-- SECTION 9 – GLOBAL STOP RPC
-- ============================================================

CREATE OR REPLACE FUNCTION public.global_journey_shadow_stop_v1(
  p_actor uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now                 timestamptz := clock_timestamp();
  v_flags_disabled      integer := 0;
  v_stages_stopped      integer := 0;
  v_assignments_revoked integer := 0;
  v_sessions_ended      integer := 0;
  v_observations_deleted integer := 0;
  v_segments_deleted    integer := 0;
  v_ground_truth_deleted integer := 0;
BEGIN
  PERFORM public._journey_shadow_require_admin_actor(p_actor);

  -- Disable all Journey feature flags
  UPDATE public.feature_flags
     SET enabled = false
   WHERE flag IN (
     'COMPASS_JOURNEY_ENGINE_ENABLED',
     'COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED',
     'COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED'
   )
     AND enabled = true;
  GET DIAGNOSTICS v_flags_disabled = ROW_COUNT;

  -- Deactivate all active stages
  UPDATE public.journey_shadow_stages
     SET is_active = false
   WHERE is_active = true;
  GET DIAGNOSTICS v_stages_stopped = ROW_COUNT;

  -- Revoke all active cohort assignments (actor = admin for audit)
  UPDATE public.journey_shadow_cohort_assignments
     SET revoked_at = v_now,
         revoked_by = p_actor
   WHERE revoked_at IS NULL;
  GET DIAGNOSTICS v_assignments_revoked = ROW_COUNT;

  -- Revoke all active session issuances
  UPDATE public.journey_shadow_session_issuances
     SET revoked_at = v_now
   WHERE revoked_at IS NULL;

  -- Delete all ground-truth rows associated with the revoked assignments.
  -- (Assignment history rows remain revoked; truth references them but is erased.)
  DELETE FROM public.journey_shadow_ground_truth;
  GET DIAGNOSTICS v_ground_truth_deleted = ROW_COUNT;

  -- Delete all journey observations
  DELETE FROM public.journey_observations;
  GET DIAGNOSTICS v_observations_deleted = ROW_COUNT;

  -- Delete all shadow segment revisions
  DELETE FROM public.journey_segment_revisions;
  GET DIAGNOSTICS v_segments_deleted = ROW_COUNT;

  -- End sessions only after counting synchronous erasure above. The normal
  -- session-end trigger also erases raw/derived rows; doing that first would
  -- make this emergency-stop audit incorrectly report zero deletions.
  UPDATE public.location_sessions
     SET ended_at = COALESCE(ended_at, v_now)
   WHERE journey_purpose = 'journey_observation_v1'
     AND ended_at IS NULL;
  GET DIAGNOSTICS v_sessions_ended = ROW_COUNT;

  RETURN jsonb_build_object(
    'flags_disabled',        v_flags_disabled,
    'stages_stopped',        v_stages_stopped,
    'assignments_revoked',   v_assignments_revoked,
    'sessions_ended',        v_sessions_ended,
    'observations_deleted',  v_observations_deleted,
    'segments_deleted',      v_segments_deleted,
    'ground_truth_deleted',  v_ground_truth_deleted,
    'stopped_at',            v_now
  );
END;
$$;

COMMENT ON FUNCTION public.global_journey_shadow_stop_v1(uuid) IS
  'INTERNAL SHADOW ONLY. Admin-only. Immediate global stop: disables all Journey flags, '
  'deactivates stages, revokes assignments (with admin as revoked_by), revokes issuances, '
  'ends issued sessions, deletes all observations, segment revisions, and ground-truth rows.';

REVOKE ALL ON FUNCTION public.global_journey_shadow_stop_v1(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.global_journey_shadow_stop_v1(uuid)
  TO service_role;

-- ============================================================
-- SECTION 10 – GROUND TRUTH RECORD RPC
-- Includes p_location_session_id; verified against journey_shadow_session_issuances
-- to confirm it belongs to the assignment and user.
-- Rejects coordinate/raw-id keys at ANY depth via the deep, fail-closed helper.
-- Caps notes (<= 2000 chars) and payload serialised size (<= 32 KB).
-- Sets expires_at = submitted_at + 30 days.
-- ============================================================

CREATE OR REPLACE FUNCTION public.record_journey_shadow_ground_truth_v1(
  p_actor               uuid,
  p_assignment_id       uuid,
  p_location_session_id uuid,
  p_recorded_at         timestamptz,
  p_ground_truth        jsonb,
  p_notes               text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_assignment record;
  v_now        timestamptz := clock_timestamp();
  v_id         uuid;
BEGIN
  PERFORM public._journey_shadow_require_admin_actor(p_actor);

  IF p_assignment_id IS NULL THEN
    RAISE EXCEPTION 'assignment_id required';
  END IF;
  IF p_location_session_id IS NULL THEN
    RAISE EXCEPTION 'location_session_id required';
  END IF;
  IF p_recorded_at IS NULL THEN
    RAISE EXCEPTION 'recorded_at required';
  END IF;
  IF p_ground_truth IS NULL OR jsonb_typeof(p_ground_truth) <> 'object' THEN
    RAISE EXCEPTION 'ground_truth must be a JSON object';
  END IF;

  -- Reject coordinate/raw-id keys at ANY depth (deep, fail-closed at depth cap)
  IF public._journey_shadow_jsonb_has_forbidden_keys_deep(p_ground_truth, 0) THEN
    RAISE EXCEPTION 'ground_truth must not contain coordinate or raw identifier keys (deep check)'
      USING ERRCODE = '42501';
  END IF;

  -- Cap payload size: serialised length must not exceed 32 KB
  IF length(p_ground_truth::text) > 32768 THEN
    RAISE EXCEPTION 'ground_truth payload exceeds 32 KB limit';
  END IF;

  -- Cap notes length
  IF p_notes IS NOT NULL AND length(p_notes) > 2000 THEN
    RAISE EXCEPTION 'notes must not exceed 2000 characters';
  END IF;

  -- Load and verify the assignment exists
  SELECT id, user_id INTO v_assignment
    FROM public.journey_shadow_cohort_assignments
   WHERE id = p_assignment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'assignment not found';
  END IF;

  -- Verify the session belongs to this assignment and user via issuances.
  -- The issuance may be revoked (truth recording is retrospective); we only
  -- require that the session was genuinely issued for this assignment.
  IF NOT EXISTS (
    SELECT 1
      FROM public.journey_shadow_session_issuances iss
      JOIN public.location_sessions ls ON ls.id = iss.location_session_id
     WHERE iss.assignment_id       = p_assignment_id
       AND iss.user_id             = v_assignment.user_id
       AND iss.location_session_id = p_location_session_id
  ) THEN
    RAISE EXCEPTION 'location_session_id does not belong to this assignment and user'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.journey_shadow_ground_truth (
    assignment_id, user_id, location_session_id,
    recorded_at, submitted_by, submitted_at,
    expires_at, ground_truth, notes
  ) VALUES (
    p_assignment_id,
    v_assignment.user_id,
    p_location_session_id,
    p_recorded_at,
    p_actor,
    v_now,
    v_now + interval '30 days',
    p_ground_truth,
    p_notes
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.record_journey_shadow_ground_truth_v1(uuid, uuid, uuid, timestamptz, jsonb, text) IS
  'INTERNAL SHADOW ONLY. Admin-only. Records an operator ground-truth sample. '
  'p_location_session_id verified via journey_shadow_session_issuances to belong to '
  'the assignment and user; issuance may be revoked (recording is retrospective). '
  'Rejects coordinate/raw-id keys at any depth (deep, fail-closed at depth cap). '
  'Caps payload at 32 KB, notes at 2000 chars. '
  'expires_at set to 30 days from submission.';

REVOKE ALL ON FUNCTION public.record_journey_shadow_ground_truth_v1(uuid, uuid, uuid, timestamptz, jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_journey_shadow_ground_truth_v1(uuid, uuid, uuid, timestamptz, jsonb, text)
  TO service_role;

-- ============================================================
-- SECTION 11 – QA REPORT RPC
-- Rejects personal/raw/coordinate keys at ANY depth via the deep, fail-closed helper.
-- Caps payload serialised size (<= 128 KB) and notes (<= 2000 chars).
-- ============================================================

CREATE OR REPLACE FUNCTION public.persist_journey_shadow_qa_report_v1(
  p_actor            uuid,
  p_stage_id         uuid,
  p_report_type      text,
  p_period_starts_at timestamptz,
  p_period_ends_at   timestamptz,
  p_payload          jsonb,
  p_notes            text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM public._journey_shadow_require_admin_actor(p_actor);

  IF p_stage_id IS NULL THEN
    RAISE EXCEPTION 'stage_id required';
  END IF;
  IF p_report_type NOT IN (
    'segment_accuracy', 'retention_health', 'cohort_summary', 'custom'
  ) THEN
    RAISE EXCEPTION 'invalid report_type: %', p_report_type;
  END IF;
  IF p_period_starts_at IS NULL OR p_period_ends_at IS NULL THEN
    RAISE EXCEPTION 'period required';
  END IF;
  IF p_period_ends_at <= p_period_starts_at THEN
    RAISE EXCEPTION 'period_ends_at must be after period_starts_at';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'payload must be a JSON object';
  END IF;

  -- Reject personal/raw/coordinate keys at ANY depth (deep, fail-closed at cap)
  IF public._journey_shadow_jsonb_has_forbidden_keys_deep(p_payload, 0) THEN
    RAISE EXCEPTION 'QA report payload must not contain personal, raw, or coordinate keys (deep check)'
      USING ERRCODE = '42501';
  END IF;

  -- Cap serialised payload size: 128 KB for aggregate reports
  IF length(p_payload::text) > 131072 THEN
    RAISE EXCEPTION 'QA payload exceeds 128 KB limit';
  END IF;

  -- Cap notes length
  IF p_notes IS NOT NULL AND length(p_notes) > 2000 THEN
    RAISE EXCEPTION 'notes must not exceed 2000 characters';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.journey_shadow_stages WHERE id = p_stage_id) THEN
    RAISE EXCEPTION 'stage not found';
  END IF;

  INSERT INTO public.journey_shadow_qa_reports (
    stage_id, report_type, period_starts_at, period_ends_at,
    submitted_by, payload, notes
  ) VALUES (
    p_stage_id, p_report_type, p_period_starts_at, p_period_ends_at,
    p_actor, p_payload, p_notes
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.persist_journey_shadow_qa_report_v1(uuid, uuid, text, timestamptz, timestamptz, jsonb, text) IS
  'INTERNAL SHADOW ONLY. Admin-only. Persists an aggregate QA report. '
  'Rejects personal/raw/coordinate keys at any depth (deep, fail-closed at depth cap). '
  'Caps payload at 128 KB, notes at 2000 chars.';

REVOKE ALL ON FUNCTION public.persist_journey_shadow_qa_report_v1(uuid, uuid, text, timestamptz, timestamptz, jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_journey_shadow_qa_report_v1(uuid, uuid, text, timestamptz, timestamptz, jsonb, text)
  TO service_role;

-- ============================================================
-- SECTION 12 – CENTRAL AUTHORIZATION AUTHORITY
-- journey_shadow_authorize_v1(user, session, operation, observed_at, source)
-- Returns: authorized | feature_disabled | not_authorized | temporarily_unavailable
-- ============================================================

CREATE OR REPLACE FUNCTION public.journey_shadow_authorize_v1(
  p_user_id             uuid,
  p_location_session_id uuid,
  p_operation           text,
  p_observed_at         timestamptz,
  p_source              text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_engine_enabled boolean;
  v_ingest_enabled boolean;
  v_shadow_enabled boolean;
  v_global_stop    boolean;
  v_preferences    record;
  v_session        record;
  v_assignment     record;
  v_retention      record;
  v_now            timestamptz := clock_timestamp();
BEGIN
  IF p_operation NOT IN ('ingest', 'raw_read', 'derived_write') THEN
    RAISE EXCEPTION 'invalid operation: must be ingest, raw_read, or derived_write';
  END IF;

  -- Lock and re-read all three Journey capability flags + global stop.
  -- FOR SHARE serialises authorization against admin flag writes.
  SELECT enabled INTO v_engine_enabled
    FROM public.feature_flags
   WHERE flag = 'COMPASS_JOURNEY_ENGINE_ENABLED'
   FOR SHARE;

  SELECT enabled INTO v_ingest_enabled
    FROM public.feature_flags
   WHERE flag = 'COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED'
   FOR SHARE;

  SELECT enabled INTO v_shadow_enabled
    FROM public.feature_flags
   WHERE flag = 'COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED'
   FOR SHARE;

  SELECT enabled INTO v_global_stop
    FROM public.feature_flags
   WHERE flag = 'disable_location_sharing'
   FOR SHARE;

  IF v_engine_enabled IS DISTINCT FROM true
     OR v_ingest_enabled IS DISTINCT FROM true
     OR v_shadow_enabled IS DISTINCT FROM true
     OR v_global_stop IS DISTINCT FROM false THEN
    RETURN 'feature_disabled';
  END IF;

  -- Active stage window must contain now (fail closed if none found)
  IF NOT EXISTS (
    SELECT 1 FROM public.journey_shadow_stages
     WHERE is_active = true
       AND v_now >= starts_at
       AND v_now < ends_at
  ) THEN
    RETURN 'feature_disabled';
  END IF;

  -- Explicit versioned unrevoked consent + unpaused live mode
  SELECT journey_observation_enabled,
         journey_consent_scope,
         journey_consent_version,
         journey_consent_granted_at,
         journey_consent_revoked_at,
         sharing_paused,
         location_mode
    INTO v_preferences
    FROM public.user_location_preferences
   WHERE user_id = p_user_id
   FOR SHARE;

  IF NOT FOUND
     OR v_preferences.journey_observation_enabled IS DISTINCT FROM true
     OR v_preferences.journey_consent_scope IS DISTINCT FROM 'journey_observation_v1'
     OR v_preferences.journey_consent_version IS DISTINCT FROM 1
     OR v_preferences.journey_consent_granted_at IS NULL
     OR v_preferences.journey_consent_revoked_at IS NOT NULL
     OR v_preferences.sharing_paused IS DISTINCT FROM false
     OR v_preferences.location_mode NOT IN (
       'live_during_activity', 'trusted_circle_live'
     ) THEN
    RETURN 'not_authorized';
  END IF;

  -- Active cohort window (also verifies stage is still active)
  SELECT a.id, a.cohort_starts_at, a.cohort_ends_at
    INTO v_assignment
    FROM public.journey_shadow_cohort_assignments a
    JOIN public.journey_shadow_stages s ON s.id = a.stage_id
   WHERE a.user_id = p_user_id
     AND a.revoked_at IS NULL
     AND v_now >= a.cohort_starts_at
     AND v_now < a.cohort_ends_at
     AND s.is_active = true
     AND v_now >= s.starts_at
     AND v_now < s.ends_at
   FOR SHARE;

  IF NOT FOUND THEN
    RETURN 'not_authorized';
  END IF;

  -- Owned finite active Journey-purpose session with matching unrevoked issuance
  SELECT ls.id, ls.user_id, ls.session_type, ls.journey_purpose,
         ls.started_at, ls.ended_at, ls.expires_at
    INTO v_session
    FROM public.location_sessions ls
    JOIN public.journey_shadow_session_issuances iss
      ON iss.location_session_id = ls.id
   WHERE ls.id = p_location_session_id
     AND ls.user_id = p_user_id
     AND ls.journey_purpose = 'journey_observation_v1'
     AND ls.ended_at IS NULL
     AND ls.expires_at IS NOT NULL
     AND ls.expires_at > v_now
     AND iss.revoked_at IS NULL
     AND iss.assignment_id = v_assignment.id
   FOR SHARE;

  IF NOT FOUND THEN
    RETURN 'not_authorized';
  END IF;

  -- Fresh, exactly HEALTHY retention: no retry/backlog/lag/consecutive_failures
  SELECT last_status, last_success_at, pending_retry_count,
         oldest_expired_age_ms, deletion_lag_ms, consecutive_failures
    INTO v_retention
    FROM public.journey_retention_health
   WHERE job = 'journey_observation_retention'
   FOR SHARE;

  IF NOT FOUND
     OR v_retention.last_status IS DISTINCT FROM 'HEALTHY'
     OR v_retention.last_success_at IS NULL
     OR v_retention.last_success_at < v_now - interval '10 minutes'
     OR v_retention.pending_retry_count IS DISTINCT FROM 0
     OR COALESCE(v_retention.oldest_expired_age_ms, 0) > 0
     OR COALESCE(v_retention.deletion_lag_ms, 0) > 0
     OR COALESCE(v_retention.consecutive_failures, 0) > 0 THEN
    RETURN 'temporarily_unavailable';
  END IF;

  -- Operation-specific ingest checks
  IF p_operation = 'ingest' THEN
    -- observed_at must not be before consent/session/cohort start
    IF p_observed_at IS NULL THEN
      RETURN 'not_authorized';
    END IF;
    IF p_observed_at < v_preferences.journey_consent_granted_at THEN
      RETURN 'not_authorized';
    END IF;
    IF p_observed_at < v_session.started_at THEN
      RETURN 'not_authorized';
    END IF;
    IF p_observed_at < v_assignment.cohort_starts_at THEN
      RETURN 'not_authorized';
    END IF;
    -- Timestamp freshness: 24h back, 5 min forward
    IF p_observed_at < v_now - interval '24 hours'
       OR p_observed_at > v_now + interval '5 minutes' THEN
      RETURN 'not_authorized';
    END IF;
    -- Must not be beyond session expiry
    IF p_observed_at > v_session.expires_at THEN
      RETURN 'not_authorized';
    END IF;
    -- Source / session-type compatibility
    IF p_source NOT IN ('foreground_gps', 'background_gps', 'plan_checkin', 'manual') THEN
      RETURN 'not_authorized';
    END IF;
    IF p_source IN ('foreground_gps', 'background_gps') THEN
      IF v_preferences.location_mode NOT IN (
        'live_during_activity', 'trusted_circle_live'
      ) THEN
        RETURN 'not_authorized';
      END IF;
      IF p_source = 'foreground_gps'
         AND v_session.session_type NOT IN ('live_share', 'trip_check_in') THEN
        RETURN 'not_authorized';
      END IF;
      IF p_source = 'background_gps'
         AND v_session.session_type <> 'live_share' THEN
        RETURN 'not_authorized';
      END IF;
    ELSIF p_source IN ('plan_checkin', 'manual') THEN
      IF v_session.session_type <> 'trip_check_in' THEN
        RETURN 'not_authorized';
      END IF;
    END IF;
  END IF;

  RETURN 'authorized';
END;
$$;

COMMENT ON FUNCTION public.journey_shadow_authorize_v1(uuid, uuid, text, timestamptz, text) IS
  'INTERNAL SHADOW ONLY. Central authorization authority for all Journey shadow operations. '
  'Locks and re-reads all 3 capability flags plus disable_location_sharing. '
  'Checks active stage window, versioned unrevoked consent, unpaused live mode, '
  'active cohort window, owned finite session + matching unrevoked issuance, '
  'and exactly HEALTHY retention (no retry/backlog/lag/consecutive_failures). '
  'For ingest: validates observed_at not before consent/session/cohort, '
  'freshness within 24h/5m, and source/session-type compatibility. '
  'Returns: authorized | feature_disabled | not_authorized | temporarily_unavailable.';

REVOKE ALL ON FUNCTION public.journey_shadow_authorize_v1(uuid, uuid, text, timestamptz, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.journey_shadow_authorize_v1(uuid, uuid, text, timestamptz, text)
  TO service_role;

-- ============================================================
-- SECTION 13 – ingest_journey_observation_v2
-- Mandatory quality fields: version must be 'journey-observation-quality-v1',
-- score must be [0,1], class must be high|usable|degraded|unusable.
-- Unusable rows ARE accepted and persisted so retention/QA/report aggregate
-- paths can measure stale/poor-accuracy/impossible-speed input distributions.
-- Segmentation excludes unusable rows at read time (the authorizing raw-read
-- RPC path filters .neq("quality_class", "unusable") before segmentation).
-- ============================================================

CREATE OR REPLACE FUNCTION public.ingest_journey_observation_v2(
  p_user_id             uuid,
  p_location_session_id uuid,
  p_event_version       smallint,
  p_observed_at         timestamptz,
  p_source              text,
  p_lat                 double precision,
  p_lng                 double precision,
  p_accuracy_m          double precision,
  p_speed_mps           double precision,
  p_heading_deg         double precision,
  p_world_ref           jsonb,
  p_consent_scope       text,
  p_idempotency_key     text,
  p_trust_class         text,
  p_quality_version     text,
  p_quality_score       numeric,
  p_quality_class       text,
  p_quality_reasons     text[]
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_auth        text;
  v_received_at timestamptz := clock_timestamp();
  v_inserted_id uuid;
BEGIN
  -- Mandatory quality fields: all four must be present
  IF p_quality_version IS NULL OR p_quality_score IS NULL
     OR p_quality_class IS NULL OR p_quality_reasons IS NULL THEN
    RETURN 'not_authorized';
  END IF;

  -- Exact scorer version required
  IF p_quality_version <> 'journey-observation-quality-v1' THEN
    RETURN 'not_authorized';
  END IF;

  -- Score must be in [0,1]
  IF p_quality_score < 0 OR p_quality_score > 1 THEN
    RETURN 'not_authorized';
  END IF;

  -- Reject any unknown class before auth; unusable IS accepted so that
  -- retention/QA/report aggregate paths can measure stale/poor-accuracy/
  -- impossible-speed distributions. Segmentation excludes unusable at read time.
  IF p_quality_class NOT IN ('high', 'usable', 'degraded', 'unusable') THEN
    RETURN 'not_authorized';
  END IF;

  -- Call central authority for ingest
  v_auth := public.journey_shadow_authorize_v1(
    p_user_id,
    p_location_session_id,
    'ingest',
    p_observed_at,
    p_source
  );

  IF v_auth <> 'authorized' THEN
    RETURN v_auth;
  END IF;

  -- Consent scope must match
  IF p_consent_scope IS DISTINCT FROM 'journey_observation_v1' THEN
    RETURN 'not_authorized';
  END IF;

  INSERT INTO public.journey_observations (
    user_id,
    location_session_id,
    event_version,
    observed_at,
    received_at,
    source,
    lat,
    lng,
    accuracy_m,
    speed_mps,
    heading_deg,
    world_ref,
    consent_scope,
    idempotency_key,
    trust_class,
    expires_at,
    quality_version,
    quality_score,
    quality_class,
    quality_reasons
  ) VALUES (
    p_user_id,
    p_location_session_id,
    p_event_version,
    p_observed_at,
    v_received_at,
    p_source,
    p_lat,
    p_lng,
    p_accuracy_m,
    p_speed_mps,
    p_heading_deg,
    p_world_ref,
    p_consent_scope,
    p_idempotency_key,
    p_trust_class,
    v_received_at + interval '24 hours',
    p_quality_version,
    p_quality_score,
    p_quality_class,
    p_quality_reasons
  )
  ON CONFLICT (user_id, location_session_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_inserted_id;

  IF v_inserted_id IS NULL THEN
    RETURN 'deduplicated';
  END IF;
  RETURN 'accepted';
END;
$$;

COMMENT ON FUNCTION public.ingest_journey_observation_v2(uuid, uuid, smallint, timestamptz, text, double precision, double precision, double precision, double precision, double precision, jsonb, text, text, text, text, numeric, text, text[]) IS
  'INTERNAL SHADOW ONLY. Only executable observation writer for the controlled rollout. '
  'All four quality fields mandatory. quality_version must be journey-observation-quality-v1. '
  'quality_score in [0,1]. quality_class in {high,usable,degraded,unusable}; unknown class rejected. '
  'Unusable rows are persisted so QA/report paths can measure stale/poor-accuracy/impossible-speed distributions. '
  'Segmentation excludes unusable rows at read time. Calls journey_shadow_authorize_v1(ingest). 24h TTL.';

REVOKE ALL ON FUNCTION public.ingest_journey_observation_v2(
  uuid, uuid, smallint, timestamptz, text,
  double precision, double precision, double precision, double precision,
  double precision, jsonb, text, text, text, text, numeric, text, text[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_journey_observation_v2(
  uuid, uuid, smallint, timestamptz, text,
  double precision, double precision, double precision, double precision,
  double precision, jsonb, text, text, text, text, numeric, text, text[]
) TO service_role;

-- Revoke service_role EXECUTE on v1 (v2 is the only executable observation writer)
REVOKE EXECUTE ON FUNCTION public.ingest_journey_observation_v1(
  uuid, uuid, smallint, timestamptz, text,
  double precision, double precision, double precision, double precision,
  double precision, jsonb, text, text, text
) FROM service_role;

-- Re-assert: direct INSERT on journey_observations must remain revoked
REVOKE INSERT ON TABLE public.journey_observations FROM service_role;

-- Revoke service_role direct SELECT and DELETE on journey_observations.
-- All raw reads must go through read_journey_shadow_observations_v1 or
-- aggregate_journey_shadow_observations_v1 which call journey_shadow_authorize_v1
-- inside the same SQL transaction (no TOCTOU gap). All erasure must go through
-- the lifecycle/maintenance RPCs below.
REVOKE SELECT, DELETE ON TABLE public.journey_observations FROM service_role;

-- Revoke service_role direct SELECT/INSERT/UPDATE/DELETE on
-- journey_segment_revisions. 2103 granted service_role SELECT,DELETE for private
-- shadow analysis and retention/erasure; that direct access is a TOCTOU/consent
-- gap (the row can be read without re-checking consent inside the same
-- transaction). After 2123, derived-segment reads MUST go through the
-- SECURITY DEFINER RPCs below (read_journey_shadow_qa_segment_revisions_v1 for
-- QA, aggregate_journey_shadow_segment_revisions_v1 for report counts) which run
-- journey_shadow_authorize_v1 in-transaction. Erasure MUST go through the sealed
-- RPCs (delete_journey_shadow_rows_v1, purge_expired_journey_shadow_table_v1
-- ('segment'), delete_journey_segments_for_user). append_journey_segment_revisions_v2
-- (SECURITY DEFINER) remains the sole writer. Explicit REVOKE of each privilege
-- (not "ALL") so it is unambiguous which grants are removed.
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.journey_segment_revisions FROM service_role;

-- ============================================================
-- SECTION 13b – read_journey_shadow_observations_v1
-- Authorising raw-read RPC for segmentation.
-- Calls journey_shadow_authorize_v1(raw_read) inside the same transaction
-- before returning any rows. Excludes unusable rows so they never enter
-- GPS segmentation. Hard row limit 10001. Fails closed on any denial.
-- ============================================================

CREATE OR REPLACE FUNCTION public.read_journey_shadow_observations_v1(
  p_user_id             uuid,
  p_location_session_id uuid,
  p_period_starts_at    timestamptz DEFAULT NULL,
  p_period_ends_at      timestamptz DEFAULT NULL
)
RETURNS TABLE (
  id              uuid,
  observed_at     timestamptz,
  source          text,
  lat             double precision,
  lng             double precision,
  accuracy_m      double precision,
  speed_mps       double precision,
  quality_version text,
  quality_score   numeric,
  quality_class   text,
  quality_reasons text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_auth text;
BEGIN
  -- Authorise first, inside this transaction — no TOCTOU gap.
  v_auth := public.journey_shadow_authorize_v1(
    p_user_id,
    p_location_session_id,
    'raw_read',
    NULL,
    NULL
  );

  IF v_auth <> 'authorized' THEN
    -- Fail closed: return zero rows, never raise (callers detect empty result).
    RETURN;
  END IF;

  RETURN QUERY
    SELECT
      jo.id,
      jo.observed_at,
      jo.source,
      jo.lat,
      jo.lng,
      jo.accuracy_m,
      jo.speed_mps,
      jo.quality_version,
      jo.quality_score,
      jo.quality_class,
      jo.quality_reasons
    FROM public.journey_observations jo
    WHERE jo.user_id             = p_user_id
      AND jo.location_session_id = p_location_session_id
      AND jo.source IN ('foreground_gps', 'background_gps')
      -- Segmentation must never process unusable rows; enforce at SQL boundary.
      AND jo.quality_class <> 'unusable'
      AND jo.expires_at > clock_timestamp()
      AND (p_period_starts_at IS NULL OR jo.observed_at >= p_period_starts_at)
      AND (p_period_ends_at   IS NULL OR jo.observed_at <= p_period_ends_at)
    ORDER BY jo.observed_at ASC
    LIMIT 10001;  -- Hard row cap; caller must check for > 10000 and abort.
END;
$$;

COMMENT ON FUNCTION public.read_journey_shadow_observations_v1(uuid, uuid, timestamptz, timestamptz) IS
  'INTERNAL SHADOW ONLY. Authorising raw-read RPC for GPS segmentation. '
  'Calls journey_shadow_authorize_v1(raw_read) inside the same SQL transaction '
  'before returning any rows (eliminates TOCTOU gap of separate authorize-then-select). '
  'Excludes unusable rows so they never enter GPS segmentation. '
  'Hard row limit 10001. Returns zero rows on any denial (fails closed). '
  'QA/report aggregate reads use aggregate_journey_shadow_observations_v1 instead.';

REVOKE ALL ON FUNCTION public.read_journey_shadow_observations_v1(uuid, uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_journey_shadow_observations_v1(uuid, uuid, timestamptz, timestamptz) TO service_role;

-- ============================================================
-- SECTION 13b-qa – read_journey_shadow_qa_observations_v1
-- Admin-only authorising raw-read RPC for QA failure-mode measurement.
-- Unlike read_journey_shadow_observations_v1 (segmentation), this INCLUDES
-- rows of ALL quality classes (including 'unusable') so QA can measure
-- stale/poor-accuracy/impossible-speed distributions and quality reasons.
-- Runs _journey_shadow_require_admin_actor AND journey_shadow_authorize_v1
-- (raw_read) inside the same transaction. On denial it RAISEs a generic
-- 42501 (no user/session ID in the message). Authorised-empty returns [].
-- Hard row limit 10001. Period is validated: end>start and <=30 days.
-- ============================================================

CREATE OR REPLACE FUNCTION public.read_journey_shadow_qa_observations_v1(
  p_actor               uuid,
  p_user_id             uuid,
  p_location_session_id uuid,
  p_period_starts_at    timestamptz,
  p_period_ends_at      timestamptz
)
RETURNS TABLE (
  id              uuid,
  observed_at     timestamptz,
  source          text,
  lat             double precision,
  lng             double precision,
  accuracy_m      double precision,
  speed_mps       double precision,
  quality_version text,
  quality_score   numeric,
  quality_class   text,
  quality_reasons text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_auth text;
BEGIN
  -- Admin gate (generic 42501 on failure — no IDs in message).
  PERFORM public._journey_shadow_require_admin_actor(p_actor);

  -- Validate period bounds. Generic error text, no IDs.
  IF p_period_starts_at IS NULL OR p_period_ends_at IS NULL THEN
    RAISE EXCEPTION 'qa read: period bounds required' USING ERRCODE = '22023';
  END IF;
  IF p_period_ends_at <= p_period_starts_at THEN
    RAISE EXCEPTION 'qa read: period end must be after start' USING ERRCODE = '22023';
  END IF;
  IF p_period_ends_at - p_period_starts_at > interval '30 days' THEN
    RAISE EXCEPTION 'qa read: period must not exceed 30 days' USING ERRCODE = '22023';
  END IF;

  -- Authorise this exact user+session inside the same transaction — no TOCTOU.
  v_auth := public.journey_shadow_authorize_v1(
    p_user_id,
    p_location_session_id,
    'raw_read',
    NULL,
    NULL
  );

  -- Fail closed on denial: RAISE a generic 42501 so callers distinguish
  -- denial (error) from authorised-but-empty (returns zero rows). The
  -- message contains no user/session ID.
  IF v_auth <> 'authorized' THEN
    RAISE EXCEPTION 'qa read: not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT
      jo.id,
      jo.observed_at,
      jo.source,
      jo.lat,
      jo.lng,
      jo.accuracy_m,
      jo.speed_mps,
      jo.quality_version,
      jo.quality_score,
      jo.quality_class,
      jo.quality_reasons
    FROM public.journey_observations jo
    WHERE jo.user_id             = p_user_id
      AND jo.location_session_id = p_location_session_id
      AND jo.source IN ('foreground_gps', 'background_gps')
      -- QA includes ALL quality classes (including 'unusable') to measure
      -- failure-mode distributions. Segmentation uses the non-QA RPC instead.
      AND jo.expires_at > clock_timestamp()
      AND jo.observed_at >= p_period_starts_at
      AND jo.observed_at <= p_period_ends_at
    ORDER BY jo.observed_at ASC
    LIMIT 10001;  -- Hard row cap; caller must check for > 10000 and abort.
END;
$$;

COMMENT ON FUNCTION public.read_journey_shadow_qa_observations_v1(uuid, uuid, uuid, timestamptz, timestamptz) IS
  'INTERNAL SHADOW ONLY. Admin-only authorising raw-read RPC for QA failure-mode measurement. '
  'Runs _journey_shadow_require_admin_actor and journey_shadow_authorize_v1(raw_read) inside the '
  'same SQL transaction. INCLUDES all quality classes (including unusable) so QA can measure '
  'stale/poor-accuracy/impossible-speed distributions. RAISEs generic 42501 on denial (no IDs in '
  'message); authorised-but-empty returns zero rows. Validates period end>start and <=30 days. '
  'Hard row limit 10001. Segmentation uses read_journey_shadow_observations_v1 (excludes unusable) instead.';

REVOKE ALL ON FUNCTION public.read_journey_shadow_qa_observations_v1(uuid, uuid, uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_journey_shadow_qa_observations_v1(uuid, uuid, uuid, timestamptz, timestamptz) TO service_role;

-- ============================================================
-- SECTION 13c – aggregate_journey_shadow_observations_v1
-- Admin-only aggregate RPC for QA / report reads.
-- Authorises every issued session before aggregating. Returns only
-- counts + quality class/reason distributions; never coordinates,
-- IDs, or raw timestamps. Fails closed if any session is denied.
-- Unusable rows are deliberately included to measure failure-mode
-- distributions (stale/poor-accuracy/impossible-speed).
-- ============================================================

CREATE OR REPLACE FUNCTION public.aggregate_journey_shadow_observations_v1(
  p_actor             uuid,
  p_stage_id          uuid,
  p_period_starts_at  timestamptz,
  p_period_ends_at    timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_session_id      uuid;
  v_session_user_id uuid;
  v_auth            text;
  v_total_count     bigint := 0;
  v_class_dist      jsonb  := '{}'::jsonb;
  v_reason_dist     jsonb  := '{}'::jsonb;
  v_session_ids     uuid[];
  v_quality_class   text;
  v_quality_reasons text[];
  v_reason          text;
BEGIN
  -- Admin gate: only admin profiles may call this function. Generic 42501,
  -- no actor/session/user ID in the message.
  PERFORM public._journey_shadow_require_admin_actor(p_actor);

  -- Validate period bounds (generic error text, no IDs).
  IF p_period_starts_at IS NULL OR p_period_ends_at IS NULL THEN
    RAISE EXCEPTION 'aggregate: period bounds required' USING ERRCODE = '22023';
  END IF;
  IF p_period_ends_at <= p_period_starts_at THEN
    RAISE EXCEPTION 'aggregate: period end must be after start' USING ERRCODE = '22023';
  END IF;
  IF p_period_ends_at - p_period_starts_at > interval '30 days' THEN
    RAISE EXCEPTION 'aggregate: period must not exceed 30 days' USING ERRCODE = '22023';
  END IF;

  -- Collect all issued, non-revoked session IDs for the stage whose underlying
  -- location_session overlaps the period window. Overlap (not issued_at-only):
  -- session started on/before period end AND effective-end (ended_at or
  -- expires_at) on/after period start. This catches sessions issued before the
  -- window but still active within it, and excludes sessions that ended before.
  SELECT ARRAY(
    SELECT DISTINCT jsi.location_session_id
      FROM public.journey_shadow_session_issuances jsi
      JOIN public.journey_shadow_cohort_assignments jca
        ON jca.id = jsi.assignment_id
      JOIN public.location_sessions ls
        ON ls.id = jsi.location_session_id
     WHERE jca.stage_id     = p_stage_id
       AND jca.revoked_at   IS NULL
       AND jsi.revoked_at   IS NULL
       AND ls.started_at <= p_period_ends_at
       AND COALESCE(ls.ended_at, ls.expires_at, jsi.session_expires_at) >= p_period_starts_at
  ) INTO v_session_ids;

  IF array_length(v_session_ids, 1) IS NULL THEN
    -- No sessions in period — return empty aggregate.
    RETURN jsonb_build_object(
      'totalObservationCount', 0,
      'qualityClassDistribution', '{}'::jsonb,
      'qualityReasonDistribution', '{}'::jsonb
    );
  END IF;

  -- Authorise every session before aggregating. Any denial blocks the whole
  -- call with a GENERIC error (no session/user ID in the message).
  FOREACH v_session_id IN ARRAY v_session_ids LOOP
    -- Resolve user_id from the session issuance record.
    SELECT jsi.user_id INTO v_session_user_id
      FROM public.journey_shadow_session_issuances jsi
     WHERE jsi.location_session_id = v_session_id
     LIMIT 1;

    IF v_session_user_id IS NULL THEN
      RAISE EXCEPTION 'aggregate: issuance not found for a session' USING ERRCODE = '42501';
    END IF;

    v_auth := public.journey_shadow_authorize_v1(
      v_session_user_id,
      v_session_id,
      'raw_read',
      NULL,
      NULL
    );

    IF v_auth <> 'authorized' THEN
      RAISE EXCEPTION 'aggregate: a session was not authorized' USING ERRCODE = '42501';
    END IF;
  END LOOP;

  -- Aggregate quality class and reason distributions across all authorized sessions.
  -- Unusable rows are intentionally included to measure failure-mode distributions.
  -- No coordinates, IDs, or raw timestamps are returned.
  FOR v_quality_class, v_quality_reasons IN
    SELECT jo.quality_class, jo.quality_reasons
      FROM public.journey_observations jo
     WHERE jo.location_session_id = ANY(v_session_ids)
       AND jo.observed_at >= p_period_starts_at
       AND jo.observed_at <= p_period_ends_at
       AND jo.quality_class IS NOT NULL
  LOOP
    v_total_count := v_total_count + 1;

    -- Increment quality class bucket.
    v_class_dist := jsonb_set(
      v_class_dist,
      ARRAY[v_quality_class],
      to_jsonb(COALESCE((v_class_dist ->> v_quality_class)::bigint, 0) + 1)
    );

    -- Increment each reason code bucket.
    IF v_quality_reasons IS NOT NULL THEN
      FOREACH v_reason IN ARRAY v_quality_reasons LOOP
        v_reason_dist := jsonb_set(
          v_reason_dist,
          ARRAY[v_reason],
          to_jsonb(COALESCE((v_reason_dist ->> v_reason)::bigint, 0) + 1)
        );
      END LOOP;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'totalObservationCount',    v_total_count,
    'qualityClassDistribution', v_class_dist,
    'qualityReasonDistribution', v_reason_dist
  );
END;
$$;

COMMENT ON FUNCTION public.aggregate_journey_shadow_observations_v1(uuid, uuid, timestamptz, timestamptz) IS
  'INTERNAL SHADOW ONLY. Admin-only aggregate read for QA / report. '
  'Admin gate via _journey_shadow_require_admin_actor (generic 42501, no IDs). '
  'Validates period end>start and <=30 days. Scopes issued non-revoked sessions by '
  'location_session overlap with the period (started_at <= end AND COALESCE(ended_at,expires_at) >= start), '
  'not issued_at alone. Authorises every session inside the same transaction before aggregating. '
  'Returns only counts + quality class/reason distributions — never coordinates, IDs, or raw timestamps. '
  'Fails closed with a GENERIC error (no session/user ID in message) if any session is denied. '
  'Unusable rows are deliberately included to measure stale/poor-accuracy/impossible-speed distributions.';

REVOKE ALL ON FUNCTION public.aggregate_journey_shadow_observations_v1(uuid, uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aggregate_journey_shadow_observations_v1(uuid, uuid, timestamptz, timestamptz) TO service_role;

-- ============================================================
-- SECTION 13c-seg – SEGMENT-REVISION AUTHORISED READ RPCs
-- After service_role loses direct SELECT on journey_segment_revisions, derived
-- segments can only be read through these SECURITY DEFINER functions, which run
-- the SAME central journey_shadow_authorize_v1(raw_read) in-transaction that the
-- observation readers use (no TOCTOU gap). Errors are generic (no user/session
-- ID leaked). Period is validated (end>start, <=30 days). The QA reader is
-- admin-gated and row-capped; the aggregate returns only a count.
-- ============================================================

-- 13c-seg.1 – aggregate_journey_shadow_segment_revisions_v1
-- Admin-only. Returns ONLY {revisionCount} for the report card. Scopes issued,
-- non-revoked sessions for the stage by location_session overlap with the period
-- (identical to aggregate_journey_shadow_observations_v1) and authorises every
-- session before counting. Never returns rows, IDs, coordinates, or timestamps.
CREATE OR REPLACE FUNCTION public.aggregate_journey_shadow_segment_revisions_v1(
  p_actor             uuid,
  p_stage_id          uuid,
  p_period_starts_at  timestamptz,
  p_period_ends_at    timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_session_id      uuid;
  v_session_user_id uuid;
  v_auth            text;
  v_session_ids     uuid[];
  v_count           bigint := 0;
BEGIN
  -- Admin gate (generic 42501, no IDs).
  PERFORM public._journey_shadow_require_admin_actor(p_actor);

  -- Validate period bounds (generic error text, no IDs).
  IF p_period_starts_at IS NULL OR p_period_ends_at IS NULL THEN
    RAISE EXCEPTION 'segment aggregate: period bounds required' USING ERRCODE = '22023';
  END IF;
  IF p_period_ends_at <= p_period_starts_at THEN
    RAISE EXCEPTION 'segment aggregate: period end must be after start' USING ERRCODE = '22023';
  END IF;
  IF p_period_ends_at - p_period_starts_at > interval '30 days' THEN
    RAISE EXCEPTION 'segment aggregate: period must not exceed 30 days' USING ERRCODE = '22023';
  END IF;

  -- Issued, non-revoked sessions for the stage overlapping the period window.
  SELECT ARRAY(
    SELECT DISTINCT jsi.location_session_id
      FROM public.journey_shadow_session_issuances jsi
      JOIN public.journey_shadow_cohort_assignments jca
        ON jca.id = jsi.assignment_id
      JOIN public.location_sessions ls
        ON ls.id = jsi.location_session_id
     WHERE jca.stage_id     = p_stage_id
       AND jca.revoked_at   IS NULL
       AND jsi.revoked_at   IS NULL
       AND ls.started_at <= p_period_ends_at
       AND COALESCE(ls.ended_at, ls.expires_at, jsi.session_expires_at) >= p_period_starts_at
  ) INTO v_session_ids;

  IF array_length(v_session_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('revisionCount', 0);
  END IF;

  -- Authorise every session before counting; any denial blocks the whole call
  -- with a GENERIC error (no session/user ID in the message).
  FOREACH v_session_id IN ARRAY v_session_ids LOOP
    SELECT jsi.user_id INTO v_session_user_id
      FROM public.journey_shadow_session_issuances jsi
     WHERE jsi.location_session_id = v_session_id
     LIMIT 1;

    IF v_session_user_id IS NULL THEN
      RAISE EXCEPTION 'segment aggregate: issuance not found for a session' USING ERRCODE = '42501';
    END IF;

    v_auth := public.journey_shadow_authorize_v1(
      v_session_user_id, v_session_id, 'raw_read', NULL, NULL
    );

    IF v_auth <> 'authorized' THEN
      RAISE EXCEPTION 'segment aggregate: a session was not authorized' USING ERRCODE = '42501';
    END IF;
  END LOOP;

  SELECT count(*) INTO v_count
    FROM public.journey_segment_revisions jsr
   WHERE jsr.location_session_id = ANY(v_session_ids)
     AND jsr.started_at >= p_period_starts_at
     AND jsr.started_at <= p_period_ends_at;

  RETURN jsonb_build_object('revisionCount', v_count);
END;
$$;

COMMENT ON FUNCTION public.aggregate_journey_shadow_segment_revisions_v1(uuid, uuid, timestamptz, timestamptz) IS
  'INTERNAL SHADOW ONLY. Admin-only aggregate count of derived segment revisions for the report card. '
  'Admin gate via _journey_shadow_require_admin_actor (generic 42501, no IDs). Validates period end>start '
  'and <=30 days. Scopes issued non-revoked sessions by location_session overlap with the period and '
  'authorises every session (journey_shadow_authorize_v1 raw_read) inside the same transaction before '
  'counting. Returns ONLY {revisionCount} — never rows, IDs, coordinates, or timestamps. Fails closed with '
  'a GENERIC error (no session/user ID) if any session is denied.';

REVOKE ALL ON FUNCTION public.aggregate_journey_shadow_segment_revisions_v1(uuid, uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aggregate_journey_shadow_segment_revisions_v1(uuid, uuid, timestamptz, timestamptz) TO service_role;

-- 13c-seg.2 – read_journey_shadow_qa_segment_revisions_v1
-- Admin-only authorising reader for QA. Returns the derived-segment revision
-- fields the QA evaluator needs for one exact user+session. Runs
-- _journey_shadow_require_admin_actor AND journey_shadow_authorize_v1(raw_read)
-- inside the same transaction. On denial RAISEs a generic 42501 (no IDs).
-- Authorised-but-empty returns zero rows. Hard row cap 10001. No exact
-- coordinates exist in this schema, so no coordinate fields are exposed.
CREATE OR REPLACE FUNCTION public.read_journey_shadow_qa_segment_revisions_v1(
  p_actor               uuid,
  p_user_id             uuid,
  p_location_session_id uuid,
  p_period_starts_at    timestamptz,
  p_period_ends_at      timestamptz
)
RETURNS TABLE (
  location_session_id   uuid,
  id                    uuid,
  segment_key           uuid,
  supersedes_id         uuid,
  revision_index        integer,
  state                 text,
  started_at            timestamptz,
  ended_at              timestamptz,
  duration_s            integer,
  world_ref             jsonb,
  movement_class        text,
  uncertainty_score     numeric,
  uncertainty_tier      text,
  reason_codes          text[],
  median_accuracy_m     numeric,
  max_gap_seconds       numeric,
  stop_radius_m         numeric,
  uncertainty_computed_at timestamptz,
  algorithm_version     text,
  observation_count     integer,
  expires_at            timestamptz,
  quality_version       text,
  quality_score         numeric,
  quality_class         text,
  quality_reasons       text[],
  provenance_version    text,
  timing_uncertainty    jsonb,
  quality_summary       jsonb,
  place_provenance      jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_auth text;
BEGIN
  -- Admin gate (generic 42501, no IDs).
  PERFORM public._journey_shadow_require_admin_actor(p_actor);

  -- Validate period bounds (generic error text, no IDs).
  IF p_period_starts_at IS NULL OR p_period_ends_at IS NULL THEN
    RAISE EXCEPTION 'segment qa read: period bounds required' USING ERRCODE = '22023';
  END IF;
  IF p_period_ends_at <= p_period_starts_at THEN
    RAISE EXCEPTION 'segment qa read: period end must be after start' USING ERRCODE = '22023';
  END IF;
  IF p_period_ends_at - p_period_starts_at > interval '30 days' THEN
    RAISE EXCEPTION 'segment qa read: period must not exceed 30 days' USING ERRCODE = '22023';
  END IF;

  -- Authorise this exact user+session in the same transaction — no TOCTOU.
  v_auth := public.journey_shadow_authorize_v1(
    p_user_id, p_location_session_id, 'raw_read', NULL, NULL
  );

  IF v_auth <> 'authorized' THEN
    RAISE EXCEPTION 'segment qa read: not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT
      jsr.location_session_id,
      jsr.id,
      jsr.segment_key,
      jsr.supersedes_id,
      jsr.revision_index,
      jsr.state,
      jsr.started_at,
      jsr.ended_at,
      jsr.duration_s,
      jsr.world_ref,
      jsr.movement_class,
      jsr.uncertainty_score,
      jsr.uncertainty_tier,
      jsr.reason_codes,
      jsr.median_accuracy_m,
      jsr.max_gap_seconds,
      jsr.stop_radius_m,
      jsr.uncertainty_computed_at,
      jsr.algorithm_version,
      jsr.observation_count,
      jsr.expires_at,
      jsr.quality_version,
      jsr.quality_score,
      jsr.quality_class,
      jsr.quality_reasons,
      jsr.provenance_version,
      jsr.timing_uncertainty,
      jsr.quality_summary,
      jsr.place_provenance
    FROM public.journey_segment_revisions jsr
    WHERE jsr.user_id             = p_user_id
      AND jsr.location_session_id = p_location_session_id
      AND jsr.started_at >= p_period_starts_at
      AND jsr.started_at <= p_period_ends_at
    ORDER BY jsr.started_at ASC, jsr.revision_index ASC
    LIMIT 10001;  -- Hard row cap; caller must check for > 10000 and abort.
END;
$$;

COMMENT ON FUNCTION public.read_journey_shadow_qa_segment_revisions_v1(uuid, uuid, uuid, timestamptz, timestamptz) IS
  'INTERNAL SHADOW ONLY. Admin-only authorising reader for QA derived-segment revisions of one exact '
  'user+session. Runs _journey_shadow_require_admin_actor and journey_shadow_authorize_v1(raw_read) inside '
  'the same SQL transaction. RAISEs generic 42501 on denial (no IDs in message); authorised-but-empty '
  'returns zero rows. Validates period end>start and <=30 days. Hard row limit 10001. No exact coordinates '
  'exist in this schema.';

REVOKE ALL ON FUNCTION public.read_journey_shadow_qa_segment_revisions_v1(uuid, uuid, uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_journey_shadow_qa_segment_revisions_v1(uuid, uuid, uuid, timestamptz, timestamptz) TO service_role;

-- ============================================================
-- SECTION 13d – MAINTENANCE RPCs (retention + account deletion)
-- REVOKE SELECT/INSERT/DELETE on journey_observations from service_role means the
-- retention scheduler and account-deletion job can no longer directly
-- SELECT/DELETE the table (Postgres requires SELECT on WHERE-clause columns
-- for a filtered DELETE). These SECURITY DEFINER RPCs run as the function
-- owner and are the ONLY service-role-callable maintenance surface. They
-- return aggregate counts / ages only — never rows, coordinates, or IDs.
-- ============================================================

-- 13d.1 – delete_journey_shadow_rows_v1
-- Atomically deletes raw observations + derived segments for a user, optionally
-- scoped to a single location_session. Used by the revocation retry cleanup.
-- Returns the total number of rows deleted across both tables.
CREATE OR REPLACE FUNCTION public.delete_journey_shadow_rows_v1(
  p_user_id             uuid,
  p_location_session_id uuid DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_obs_deleted bigint := 0;
  v_seg_deleted bigint := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'delete_journey_shadow_rows_v1: user required' USING ERRCODE = '22023';
  END IF;

  -- Serialise with other per-user Journey deletions to avoid interleaving.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('journey-segments:' || p_user_id::text, 0)
  );

  DELETE FROM public.journey_observations jo
   WHERE jo.user_id = p_user_id
     AND (p_location_session_id IS NULL OR jo.location_session_id = p_location_session_id);
  GET DIAGNOSTICS v_obs_deleted = ROW_COUNT;

  IF to_regclass('public.journey_segment_revisions') IS NOT NULL THEN
    DELETE FROM public.journey_segment_revisions jsr
     WHERE jsr.user_id = p_user_id
       AND (p_location_session_id IS NULL OR jsr.location_session_id = p_location_session_id);
    GET DIAGNOSTICS v_seg_deleted = ROW_COUNT;
  END IF;

  RETURN v_obs_deleted + v_seg_deleted;
END;
$$;

COMMENT ON FUNCTION public.delete_journey_shadow_rows_v1(uuid, uuid) IS
  'INTERNAL SHADOW ONLY. Atomically deletes raw observations + derived segments for a user, '
  'optionally scoped to one location_session. SECURITY DEFINER so it runs after service_role '
  'lost direct SELECT/DELETE on journey_observations. Under the per-user advisory lock. '
  'Returns the total deleted row count across both tables. Used by revocation retry cleanup.';

REVOKE ALL ON FUNCTION public.delete_journey_shadow_rows_v1(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_journey_shadow_rows_v1(uuid, uuid) TO service_role;

-- 13d.2 – purge_expired_journey_shadow_table_v1
-- Deletes expired rows from one of the three Journey retention tables and
-- returns ONLY {deletedCount, oldestBeforeAgeMs, oldestAfterAgeMs}. Never
-- returns rows, IDs, coordinates, or timestamps. p_kind selects the table.
CREATE OR REPLACE FUNCTION public.purge_expired_journey_shadow_table_v1(
  p_kind text,
  p_now  timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_deleted        bigint := 0;
  v_oldest_before  timestamptz;
  v_oldest_after   timestamptz;
  v_before_age_ms  bigint;
  v_after_age_ms   bigint;
BEGIN
  IF p_now IS NULL THEN
    RAISE EXCEPTION 'purge: now required' USING ERRCODE = '22023';
  END IF;
  IF p_kind NOT IN ('observation', 'segment', 'ground_truth') THEN
    RAISE EXCEPTION 'purge: kind must be observation|segment|ground_truth' USING ERRCODE = '22023';
  END IF;

  IF p_kind = 'observation' THEN
    SELECT min(jo.expires_at) INTO v_oldest_before
      FROM public.journey_observations jo
     WHERE jo.expires_at < p_now;
    DELETE FROM public.journey_observations jo WHERE jo.expires_at < p_now;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    SELECT min(jo.expires_at) INTO v_oldest_after
      FROM public.journey_observations jo
     WHERE jo.expires_at < p_now;

  ELSIF p_kind = 'segment' THEN
    IF to_regclass('public.journey_segment_revisions') IS NOT NULL THEN
      SELECT min(jsr.expires_at) INTO v_oldest_before
        FROM public.journey_segment_revisions jsr
       WHERE jsr.expires_at < p_now;
      DELETE FROM public.journey_segment_revisions jsr WHERE jsr.expires_at < p_now;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
      SELECT min(jsr.expires_at) INTO v_oldest_after
        FROM public.journey_segment_revisions jsr
       WHERE jsr.expires_at < p_now;
    END IF;

  ELSE -- ground_truth
    IF to_regclass('public.journey_shadow_ground_truth') IS NOT NULL THEN
      SELECT min(gt.expires_at) INTO v_oldest_before
        FROM public.journey_shadow_ground_truth gt
       WHERE gt.expires_at < p_now;
      DELETE FROM public.journey_shadow_ground_truth gt WHERE gt.expires_at < p_now;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
      SELECT min(gt.expires_at) INTO v_oldest_after
        FROM public.journey_shadow_ground_truth gt
       WHERE gt.expires_at < p_now;
    END IF;
  END IF;

  v_before_age_ms := CASE WHEN v_oldest_before IS NULL THEN NULL
    ELSE GREATEST(0, (EXTRACT(EPOCH FROM (p_now - v_oldest_before)) * 1000)::bigint) END;
  v_after_age_ms  := CASE WHEN v_oldest_after IS NULL THEN NULL
    ELSE GREATEST(0, (EXTRACT(EPOCH FROM (p_now - v_oldest_after)) * 1000)::bigint) END;

  RETURN jsonb_build_object(
    'deletedCount',       v_deleted,
    'oldestBeforeAgeMs',  v_before_age_ms,
    'oldestAfterAgeMs',   v_after_age_ms
  );
END;
$$;

COMMENT ON FUNCTION public.purge_expired_journey_shadow_table_v1(text, timestamptz) IS
  'INTERNAL SHADOW ONLY. Deletes expired rows from one Journey retention table '
  '(observation|segment|ground_truth). SECURITY DEFINER so it runs after service_role lost '
  'direct SELECT/DELETE on journey_observations. Returns ONLY {deletedCount, oldestBeforeAgeMs, '
  'oldestAfterAgeMs} — never rows, IDs, coordinates, or timestamps.';

REVOKE ALL ON FUNCTION public.purge_expired_journey_shadow_table_v1(text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_journey_shadow_table_v1(text, timestamptz) TO service_role;

-- 13d.3 – delete_journey_observations_for_user_v1
-- Content-only account deletion: erases raw observations for a user without
-- touching consent/preferences/segments. Used by the contentOnly deletion path
-- (segments are erased separately by delete_journey_segments_for_user).
CREATE OR REPLACE FUNCTION public.delete_journey_observations_for_user_v1(
  p_user_id uuid
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_deleted bigint := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'delete_journey_observations_for_user_v1: user required' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('journey-segments:' || p_user_id::text, 0)
  );

  DELETE FROM public.journey_observations jo WHERE jo.user_id = p_user_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION public.delete_journey_observations_for_user_v1(uuid) IS
  'INTERNAL SHADOW ONLY. Content-only account deletion: erases raw observations for a user '
  'without touching consent/preferences/segments. SECURITY DEFINER so it runs after service_role '
  'lost direct DELETE on journey_observations. Under the per-user advisory lock. Returns deleted count.';

REVOKE ALL ON FUNCTION public.delete_journey_observations_for_user_v1(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_journey_observations_for_user_v1(uuid) TO service_role;

-- ============================================================
-- SECTION 14 – append_journey_segment_revisions_v2
-- Only executable derived writer.
-- Calls central authority for derived_write.
-- Whitelist includes timing_uncertainty, quality_summary, place_provenance.
-- Rejects forbidden coordinate/raw-id key names serialised inside all JSONB cols.
-- ============================================================

CREATE OR REPLACE FUNCTION public.append_journey_segment_revisions_v2(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_auth           text;
  v_row_user_id    uuid;
  v_row_session_id uuid;
  v_inserted_count integer := 0;
  v_row            jsonb;
BEGIN
  IF jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'p_rows must be a JSON array';
  END IF;
  IF jsonb_array_length(p_rows) = 0 THEN
    RETURN 0;
  END IF;

  -- All elements must be objects
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rows) AS r
     WHERE jsonb_typeof(r) <> 'object'
  ) THEN
    RAISE EXCEPTION 'every journey segment row must be an object';
  END IF;

  -- One batch = one user + one session
  SELECT (r->>'user_id')::uuid, (r->>'location_session_id')::uuid
    INTO v_row_user_id, v_row_session_id
    FROM jsonb_array_elements(p_rows) AS r
   LIMIT 1;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rows) AS r
     WHERE (r->>'user_id')::uuid <> v_row_user_id
        OR (r->>'location_session_id')::uuid <> v_row_session_id
  ) THEN
    RAISE EXCEPTION 'one append batch must belong to one user and session';
  END IF;

  -- Whitelist check: reject any field not in the allowed set
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rows) AS r
     WHERE (
       r - ARRAY[
         'id', 'user_id', 'location_session_id', 'segment_key',
         'supersedes_id', 'revision_index', 'state', 'started_at',
         'ended_at', 'duration_s', 'world_ref', 'movement_class',
         'uncertainty_score', 'uncertainty_tier', 'reason_codes',
         'median_accuracy_m', 'max_gap_seconds', 'stop_radius_m',
         'uncertainty_computed_at', 'algorithm_version',
         'observation_count', 'expires_at',
         'quality_version', 'quality_score', 'quality_class', 'quality_reasons',
         'provenance_version', 'segment_started_at', 'segment_ended_at',
         'place_category', 'place_subcategory',
         'timing_uncertainty', 'quality_summary', 'place_provenance'
       ]::text[]
     ) <> '{}'::jsonb
  ) THEN
    RAISE EXCEPTION 'unsupported journey segment field';
  END IF;

  -- Reject forbidden coordinate/raw-id keys deeply inside all JSONB columns
  FOR v_row IN SELECT r FROM jsonb_array_elements(p_rows) AS r LOOP
    IF public._journey_shadow_jsonb_has_forbidden_keys_deep(v_row->'world_ref', 0) THEN
      RAISE EXCEPTION 'world_ref contains forbidden coordinate or raw-id keys'
        USING ERRCODE = '42501';
    END IF;
    IF public._journey_shadow_jsonb_has_forbidden_keys_deep(v_row->'timing_uncertainty', 0) THEN
      RAISE EXCEPTION 'timing_uncertainty contains forbidden coordinate or raw-id keys'
        USING ERRCODE = '42501';
    END IF;
    IF public._journey_shadow_jsonb_has_forbidden_keys_deep(v_row->'quality_summary', 0) THEN
      RAISE EXCEPTION 'quality_summary contains forbidden coordinate or raw-id keys'
        USING ERRCODE = '42501';
    END IF;
    IF public._journey_shadow_jsonb_has_forbidden_keys_deep(v_row->'place_provenance', 0) THEN
      RAISE EXCEPTION 'place_provenance contains forbidden coordinate or raw-id keys'
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  -- Call central authority for derived_write (no observed_at/source needed)
  v_auth := public.journey_shadow_authorize_v1(
    v_row_user_id,
    v_row_session_id,
    'derived_write',
    NULL,
    NULL
  );

  IF v_auth <> 'authorized' THEN
    RAISE EXCEPTION 'journey shadow derived write denied: %', v_auth
      USING ERRCODE = '42501';
  END IF;

  -- Serialize appends against consent revocation / account deletion
  PERFORM pg_advisory_xact_lock(
    hashtextextended('journey-segments:' || v_row_user_id::text, 0)
  );

  WITH inserted AS (
    INSERT INTO public.journey_segment_revisions (
      id,
      user_id,
      location_session_id,
      segment_key,
      supersedes_id,
      revision_index,
      state,
      started_at,
      ended_at,
      duration_s,
      world_ref,
      movement_class,
      uncertainty_score,
      uncertainty_tier,
      reason_codes,
      median_accuracy_m,
      max_gap_seconds,
      stop_radius_m,
      uncertainty_computed_at,
      algorithm_version,
      observation_count,
      expires_at,
      quality_version,
      quality_score,
      quality_class,
      quality_reasons,
      provenance_version,
      segment_started_at,
      segment_ended_at,
      place_category,
      place_subcategory,
      timing_uncertainty,
      quality_summary,
      place_provenance
    )
    SELECT
      (r->>'id')::uuid,
      (r->>'user_id')::uuid,
      (r->>'location_session_id')::uuid,
      (r->>'segment_key')::uuid,
      NULLIF(r->>'supersedes_id', '')::uuid,
      (r->>'revision_index')::integer,
      r->>'state',
      (r->>'started_at')::timestamptz,
      NULLIF(r->>'ended_at', '')::timestamptz,
      NULLIF(r->>'duration_s', '')::integer,
      COALESCE(r->'world_ref', '{}'::jsonb),
      r->>'movement_class',
      (r->>'uncertainty_score')::numeric,
      r->>'uncertainty_tier',
      ARRAY(
        SELECT jsonb_array_elements_text(COALESCE(r->'reason_codes', '[]'::jsonb))
      ),
      NULLIF(r->>'median_accuracy_m', '')::numeric,
      NULLIF(r->>'max_gap_seconds', '')::numeric,
      (r->>'stop_radius_m')::numeric,
      (r->>'uncertainty_computed_at')::timestamptz,
      r->>'algorithm_version',
      (r->>'observation_count')::integer,
      (r->>'expires_at')::timestamptz,
      NULLIF(r->>'quality_version', ''),
      NULLIF(r->>'quality_score', '')::numeric,
      NULLIF(r->>'quality_class', ''),
      CASE
        WHEN r->'quality_reasons' IS NOT NULL
             AND r->'quality_reasons' <> 'null'::jsonb
          THEN ARRAY(SELECT jsonb_array_elements_text(r->'quality_reasons'))
        ELSE NULL
      END,
      NULLIF(r->>'provenance_version', ''),
      NULLIF(r->>'segment_started_at', '')::timestamptz,
      NULLIF(r->>'segment_ended_at', '')::timestamptz,
      NULLIF(r->>'place_category', ''),
      NULLIF(r->>'place_subcategory', ''),
      CASE WHEN r->'timing_uncertainty' IS NOT NULL
                AND r->'timing_uncertainty' <> 'null'::jsonb
           THEN r->'timing_uncertainty' ELSE NULL END,
      CASE WHEN r->'quality_summary' IS NOT NULL
                AND r->'quality_summary' <> 'null'::jsonb
           THEN r->'quality_summary' ELSE NULL END,
      CASE WHEN r->'place_provenance' IS NOT NULL
                AND r->'place_provenance' <> 'null'::jsonb
           THEN r->'place_provenance' ELSE NULL END
    FROM jsonb_array_elements(p_rows) AS r
    ON CONFLICT (id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted_count FROM inserted;

  RETURN v_inserted_count;
END;
$$;

COMMENT ON FUNCTION public.append_journey_segment_revisions_v2(jsonb) IS
  'INTERNAL SHADOW ONLY. Only executable derived writer for the controlled rollout. '
  'Calls journey_shadow_authorize_v1(derived_write). '
  'Whitelists all fields including timing_uncertainty/quality_summary/place_provenance. '
  'Recursively rejects forbidden coordinate/raw-id keys in all JSONB columns. '
  'Idempotent on id. Advisory lock serialises with revocation.';

REVOKE ALL ON FUNCTION public.append_journey_segment_revisions_v2(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_journey_segment_revisions_v2(jsonb)
  TO service_role;

-- Revoke service_role EXECUTE on old v1 appender
REVOKE EXECUTE ON FUNCTION public.append_journey_segment_revisions(jsonb)
  FROM service_role;

-- ============================================================
-- SECTION 15 – SESSION REVOCATION CLEANUP
-- Updates purge_journey_observations_on_consent_revocation and
-- purge_journey_observations_on_session_revocation so issued
-- sessions/cohorts cannot remain authorizing after revocation.
--
-- Both triggers acquire the per-user journey advisory lock before mutating.
-- The consent trigger deletes ground truth for all the user's assignments
-- (in addition to raw + segments). The session trigger is an atomic erasure
-- boundary: it synchronously deletes raw + derived data for that exact session
-- and then enqueues a durable retry/audit job; it does NOT delete ground truth
-- (which has an independent finite QA retention lifecycle).
--
-- revoked_by for owner/trigger revocation = v_user_id (the owner's UUID),
-- satisfying the column comment ("owner user_id for owner/consent revocation").
-- This is intentional: the trigger has no separate admin actor to record, so the
-- user being revoked is the most meaningful audit value. The account-deletion path
-- (revoke_journey_consent_and_delete_segments) sets revoked_by = NULL because no
-- meaningful UUID exists at that point; the column is nullable for exactly this case.
-- ============================================================

CREATE OR REPLACE FUNCTION public.purge_journey_observations_on_consent_revocation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_reason  text;
  v_revoked boolean := false;
  v_now     timestamptz := clock_timestamp();
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_user_id := OLD.user_id;
    v_reason  := 'preference_deleted';
    v_revoked := true;
  ELSE
    v_user_id := NEW.user_id;
    IF OLD.sharing_paused IS DISTINCT FROM true
       AND NEW.sharing_paused IS TRUE THEN
      v_reason  := 'sharing_paused';
      v_revoked := true;
    ELSIF OLD.location_mode IN ('live_during_activity', 'trusted_circle_live')
       AND NEW.location_mode NOT IN ('live_during_activity', 'trusted_circle_live') THEN
      v_reason := CASE
        WHEN NEW.location_mode = 'off' THEN 'location_mode_off'
        ELSE 'location_mode_non_authorizing'
      END;
      v_revoked := true;
    ELSIF OLD.journey_observation_enabled = true
       AND NEW.journey_observation_enabled IS DISTINCT FROM true THEN
      v_reason  := 'consent_revoked';
      v_revoked := true;
    END IF;
  END IF;

  IF v_revoked THEN
    IF TG_OP = 'UPDATE' THEN
      NEW.journey_observation_enabled := false;
      IF NEW.journey_consent_granted_at IS NOT NULL THEN
        NEW.journey_consent_revoked_at :=
          COALESCE(NEW.journey_consent_revoked_at, v_now);
      END IF;
    END IF;

    -- Per-user advisory lock: serialises with append_journey_segment_revisions_v2
    -- and the other lifecycle boundaries before any mutation.
    PERFORM pg_advisory_xact_lock(
      hashtextextended('journey-segments:' || v_user_id::text, 0)
    );

    -- Revoke shadow cohort assignments; revoked_by = owner UUID (trigger context)
    UPDATE public.journey_shadow_cohort_assignments
       SET revoked_at = v_now,
           revoked_by = v_user_id
     WHERE user_id = v_user_id
       AND revoked_at IS NULL;

    -- Revoke shadow session issuances
    UPDATE public.journey_shadow_session_issuances
       SET revoked_at = v_now
     WHERE user_id = v_user_id
       AND revoked_at IS NULL;

    -- End open journey-purpose sessions
    UPDATE public.location_sessions
       SET ended_at = COALESCE(ended_at, v_now)
     WHERE user_id = v_user_id
       AND journey_purpose = 'journey_observation_v1'
       AND ended_at IS NULL;

    -- Delete ground truth for all this user's assignments (FK references
    -- assignments, which remain as revoked rows). Delete before observations.
    DELETE FROM public.journey_shadow_ground_truth
     WHERE user_id = v_user_id;

    -- Delete raw observations
    DELETE FROM public.journey_observations
     WHERE user_id = v_user_id;

    -- Delete segment revisions (table may be optional; guard for re-applicability)
    IF to_regclass('public.journey_segment_revisions') IS NOT NULL THEN
      EXECUTE
        'DELETE FROM public.journey_segment_revisions WHERE user_id = $1'
        USING v_user_id;
    END IF;

    -- Durable revocation job (atomic, restart-safe)
    INSERT INTO public.journey_revocation_jobs (
      user_id,
      reason,
      idempotency_key,
      requested_at,
      available_at,
      updated_at
    ) VALUES (
      v_user_id,
      v_reason,
      format('user:%s:%s', v_user_id, txid_current()),
      v_now,
      v_now,
      v_now
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_journey_observations_on_consent_revocation()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS user_location_preferences_purge_journey_on_revocation
  ON public.user_location_preferences;
CREATE TRIGGER user_location_preferences_purge_journey_on_revocation
  BEFORE UPDATE OF journey_observation_enabled, sharing_paused, location_mode
     OR DELETE ON public.user_location_preferences
  FOR EACH ROW EXECUTE FUNCTION public.purge_journey_observations_on_consent_revocation();

CREATE OR REPLACE FUNCTION public.purge_journey_observations_on_session_revocation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_session_id uuid;
  v_user_id    uuid;
  v_reason     text;
  v_revoked    boolean := false;
  v_now        timestamptz := clock_timestamp();
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_session_id := OLD.id;
    v_user_id    := OLD.user_id;
    IF OLD.journey_purpose = 'journey_observation_v1' THEN
      v_reason  := 'session_deleted';
      v_revoked := true;
    END IF;
  ELSE
    v_session_id := NEW.id;
    v_user_id    := NEW.user_id;
    IF OLD.journey_purpose = 'journey_observation_v1' THEN
      IF NEW.journey_purpose IS DISTINCT FROM 'journey_observation_v1' THEN
        v_reason  := 'session_purpose_changed';
        v_revoked := true;
      ELSIF OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL THEN
        v_reason := CASE
          WHEN NEW.expires_at IS NOT NULL AND NEW.expires_at <= v_now
            THEN 'session_expired'
          ELSE 'session_ended'
        END;
        v_revoked := true;
      ELSIF NEW.expires_at IS NOT NULL
         AND NEW.expires_at <= v_now
         AND (OLD.expires_at IS NULL OR OLD.expires_at > v_now) THEN
        v_reason  := 'session_expired';
        v_revoked := true;
      END IF;
    END IF;
  END IF;

  IF v_revoked THEN
    -- Per-user advisory lock: serialises with append_journey_segment_revisions_v2
    -- so the synchronous erasure below cannot race a concurrent derived write.
    PERFORM pg_advisory_xact_lock(
      hashtextextended('journey-segments:' || v_user_id::text, 0)
    );

    -- Mark the matching issuance revoked so it cannot continue authorizing
    UPDATE public.journey_shadow_session_issuances
       SET revoked_at = v_now
     WHERE location_session_id = v_session_id
       AND revoked_at IS NULL;

    -- Atomic erasure boundary (not queue-only): synchronously delete raw
    -- observations and derived segment revisions for THIS exact session, so
    -- natural session end makes raw/derived unavailable immediately.
    -- Ground truth is intentionally NOT deleted here: it has an independent
    -- finite QA retention lifecycle (expires_at) and its own purge path.
    DELETE FROM public.journey_observations
     WHERE location_session_id = v_session_id;

    IF to_regclass('public.journey_segment_revisions') IS NOT NULL THEN
      EXECUTE
        'DELETE FROM public.journey_segment_revisions WHERE location_session_id = $1'
        USING v_session_id;
    END IF;

    -- Durable revocation job record (retry/audit after synchronous erasure)
    INSERT INTO public.journey_revocation_jobs (
      user_id,
      location_session_id,
      reason,
      idempotency_key,
      requested_at,
      available_at,
      updated_at
    ) VALUES (
      v_user_id,
      v_session_id,
      v_reason,
      format('session:%s:%s', v_session_id, txid_current()),
      v_now,
      v_now,
      v_now
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_journey_observations_on_session_revocation()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS location_sessions_purge_journey_on_revocation
  ON public.location_sessions;
CREATE TRIGGER location_sessions_purge_journey_on_revocation
  AFTER UPDATE OF ended_at, expires_at, journey_purpose
     OR DELETE ON public.location_sessions
  FOR EACH ROW EXECUTE FUNCTION public.purge_journey_observations_on_session_revocation();

-- ============================================================
-- SECTION 16 – REVOKE_JOURNEY_CONSENT_AND_DELETE_SEGMENTS update
-- Account-deletion atomic boundary. Because this path keeps a profile
-- tombstone, merely revoking rows is insufficient: under the per-user
-- advisory lock it ends all issued open sessions, deletes raw observations
-- and segments for the user, deletes all ground-truth rows for the user's
-- assignments, then DELETEs the cohort assignment rows themselves (cascading
-- issuances and any residual ground truth via ON DELETE CASCADE). All of this
-- precedes the preference patch. Return value stays the segment deleted count.
-- ============================================================

CREATE OR REPLACE FUNCTION public.revoke_journey_consent_and_delete_segments(
  p_user_id     uuid,
  p_preferences jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  deleted_count integer := 0;
  v_now         timestamptz := clock_timestamp();
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;
  IF p_preferences IS NULL OR jsonb_typeof(p_preferences) <> 'object' THEN
    RAISE EXCEPTION 'p_preferences must be a JSON object';
  END IF;
  IF (
    p_preferences - ARRAY[
      'location_mode', 'sharing_paused', 'pulse_visibility',
      'discovery_visibility', 'safe_return_enabled', 'trusted_circle_share',
      'hotel_blur_enabled', 'journey_observation_enabled'
    ]::text[]
  ) <> '{}'::jsonb THEN
    RAISE EXCEPTION 'unsupported location preference field';
  END IF;

  IF p_preferences ? 'location_mode' AND (
    jsonb_typeof(p_preferences->'location_mode') <> 'string'
    OR p_preferences->>'location_mode' NOT IN (
      'off', 'city_only', 'nearby', 'live_during_activity', 'trusted_circle_live'
    )
  ) THEN
    RAISE EXCEPTION 'invalid location_mode';
  END IF;
  IF p_preferences ? 'sharing_paused'
     AND jsonb_typeof(p_preferences->'sharing_paused') <> 'boolean' THEN
    RAISE EXCEPTION 'invalid sharing_paused';
  END IF;
  IF p_preferences ? 'safe_return_enabled'
     AND jsonb_typeof(p_preferences->'safe_return_enabled') <> 'boolean' THEN
    RAISE EXCEPTION 'invalid safe_return_enabled';
  END IF;
  IF p_preferences ? 'trusted_circle_share'
     AND jsonb_typeof(p_preferences->'trusted_circle_share') <> 'boolean' THEN
    RAISE EXCEPTION 'invalid trusted_circle_share';
  END IF;
  IF p_preferences ? 'hotel_blur_enabled'
     AND jsonb_typeof(p_preferences->'hotel_blur_enabled') <> 'boolean' THEN
    RAISE EXCEPTION 'invalid hotel_blur_enabled';
  END IF;
  IF p_preferences ? 'journey_observation_enabled'
     AND jsonb_typeof(p_preferences->'journey_observation_enabled') <> 'boolean' THEN
    RAISE EXCEPTION 'invalid journey_observation_enabled';
  END IF;
  IF p_preferences ? 'pulse_visibility'
     AND p_preferences->'pulse_visibility' <> 'null'::jsonb
     AND (
       jsonb_typeof(p_preferences->'pulse_visibility') <> 'string'
       OR p_preferences->>'pulse_visibility' NOT IN (
         'city_only', 'neighborhood', 'venue_tagged', 'exact_hidden', 'no_location'
       )
     ) THEN
    RAISE EXCEPTION 'invalid pulse_visibility';
  END IF;
  IF p_preferences ? 'discovery_visibility'
     AND p_preferences->'discovery_visibility' <> 'null'::jsonb
     AND (
       jsonb_typeof(p_preferences->'discovery_visibility') <> 'string'
       OR p_preferences->>'discovery_visibility' NOT IN (
         'city_only', 'neighborhood', 'venue_tagged', 'exact_hidden', 'no_location'
       )
     ) THEN
    RAISE EXCEPTION 'invalid discovery_visibility';
  END IF;

  IF COALESCE(p_preferences->>'location_mode', '') NOT IN ('off', 'city_only', 'nearby')
     AND COALESCE((p_preferences->>'sharing_paused')::boolean, false) = false
     AND COALESCE(
       (p_preferences->>'journey_observation_enabled')::boolean, true
     ) = true THEN
    RAISE EXCEPTION 'preference patch must revoke Journey consent'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('journey-segments:' || p_user_id::text, 0)
  );

  -- Account deletion keeps a profile tombstone, so shadow rows must be
  -- physically erased, not merely marked revoked. FK-safe ordering:
  -- (1) end open sessions, (2) delete child data (observations, segments,
  -- ground truth), then (3) delete the assignment rows (cascades issuances
  -- and any residual ground truth). Everything is under the advisory lock and
  -- precedes the preference patch.

  -- End all open journey-purpose sessions issued to this user
  UPDATE public.location_sessions
     SET ended_at = COALESCE(ended_at, v_now)
   WHERE user_id = p_user_id
     AND journey_purpose = 'journey_observation_v1'
     AND ended_at IS NULL;

  -- Delete ground truth for all this user's assignments (before assignments)
  DELETE FROM public.journey_shadow_ground_truth
   WHERE user_id = p_user_id;

  -- Delete raw observations for the user
  DELETE FROM public.journey_observations
   WHERE user_id = p_user_id;

  -- Delete segment revisions; ROW_COUNT is the returned deleted_count
  IF to_regclass('public.journey_segment_revisions') IS NOT NULL THEN
    EXECUTE
      'DELETE FROM public.journey_segment_revisions WHERE user_id = $1'
      USING p_user_id;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
  END IF;

  -- Delete the cohort assignment rows themselves. ON DELETE CASCADE on
  -- journey_shadow_session_issuances.assignment_id and
  -- journey_shadow_ground_truth.assignment_id removes any residual children.
  DELETE FROM public.journey_shadow_cohort_assignments
   WHERE user_id = p_user_id;

  INSERT INTO public.user_location_preferences AS current_preferences (
    user_id, location_mode, sharing_paused, pulse_visibility,
    discovery_visibility, safe_return_enabled, trusted_circle_share,
    hotel_blur_enabled, journey_observation_enabled, updated_at
  )
  VALUES (
    p_user_id,
    COALESCE(p_preferences->>'location_mode', 'city_only'),
    COALESCE((p_preferences->>'sharing_paused')::boolean, false),
    CASE WHEN p_preferences ? 'pulse_visibility'
      THEN p_preferences->>'pulse_visibility' ELSE NULL END,
    CASE WHEN p_preferences ? 'discovery_visibility'
      THEN p_preferences->>'discovery_visibility' ELSE NULL END,
    COALESCE((p_preferences->>'safe_return_enabled')::boolean, true),
    COALESCE((p_preferences->>'trusted_circle_share')::boolean, false),
    COALESCE((p_preferences->>'hotel_blur_enabled')::boolean, true),
    COALESCE((p_preferences->>'journey_observation_enabled')::boolean, false),
    now()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    location_mode = CASE
      WHEN p_preferences ? 'location_mode' THEN EXCLUDED.location_mode
      ELSE current_preferences.location_mode END,
    sharing_paused = CASE
      WHEN p_preferences ? 'sharing_paused' THEN EXCLUDED.sharing_paused
      ELSE current_preferences.sharing_paused END,
    pulse_visibility = CASE
      WHEN p_preferences ? 'pulse_visibility' THEN EXCLUDED.pulse_visibility
      ELSE current_preferences.pulse_visibility END,
    discovery_visibility = CASE
      WHEN p_preferences ? 'discovery_visibility' THEN EXCLUDED.discovery_visibility
      ELSE current_preferences.discovery_visibility END,
    safe_return_enabled = CASE
      WHEN p_preferences ? 'safe_return_enabled' THEN EXCLUDED.safe_return_enabled
      ELSE current_preferences.safe_return_enabled END,
    trusted_circle_share = CASE
      WHEN p_preferences ? 'trusted_circle_share' THEN EXCLUDED.trusted_circle_share
      ELSE current_preferences.trusted_circle_share END,
    hotel_blur_enabled = CASE
      WHEN p_preferences ? 'hotel_blur_enabled' THEN EXCLUDED.hotel_blur_enabled
      ELSE current_preferences.hotel_blur_enabled END,
    journey_observation_enabled = CASE
      WHEN p_preferences ? 'journey_observation_enabled'
        THEN EXCLUDED.journey_observation_enabled
      ELSE current_preferences.journey_observation_enabled END,
    updated_at = now();

  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_journey_consent_and_delete_segments(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_journey_consent_and_delete_segments(uuid, jsonb)
  TO service_role;

COMMENT ON FUNCTION public.revoke_journey_consent_and_delete_segments(uuid, jsonb) IS
  'Account-deletion atomic boundary (profile tombstone remains, so rows are erased not '
  'just revoked). Under the per-user advisory lock: ends open issued sessions, deletes '
  'ground truth, raw observations, and segments for the user, then DELETEs the cohort '
  'assignment rows (cascading issuances and residual ground truth), all before patching '
  'preferences. Returns the segment deleted count.';

-- ============================================================
-- SECTION 17 – RETENTION HEALTH BREAKDOWN COLUMNS +
--              finish_journey_retention_cycle_v2
--
-- Adds three nullable/default-zero count columns to journey_retention_health
-- so the unified retention runtime can record per-purge breakdowns:
--   last_observation_deleted_count  – rows deleted from journey_observations
--   last_segment_deleted_count      – rows deleted from journey_segment_revisions
--   last_ground_truth_deleted_count – rows deleted from journey_shadow_ground_truth
--
-- finish_journey_retention_cycle_v2 preserves the exact v1 lease-token,
-- health-state, and consecutive-failure semantics while also writing these
-- three breakdown columns. v1 remains callable (last_deleted_count continues
-- to hold the aggregate total for callers that have not yet migrated).
--
-- The central authority (journey_shadow_authorize_v1) continues to read the
-- same HEALTHY row without change; the new breakdown columns are informational
-- and do not alter the authorization gate.
-- ============================================================

-- Add nullable breakdown columns (safe on any Postgres version; zero default
-- means existing HEALTHY rows do not become stale).
ALTER TABLE public.journey_retention_health
  ADD COLUMN IF NOT EXISTS last_observation_deleted_count  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_segment_deleted_count      integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_ground_truth_deleted_count integer NOT NULL DEFAULT 0;

-- Extend the existing counts check to cover the new columns.
ALTER TABLE public.journey_retention_health
  DROP CONSTRAINT IF EXISTS journey_retention_health_counts_check;
ALTER TABLE public.journey_retention_health
  ADD CONSTRAINT journey_retention_health_counts_check
  CHECK (
    last_deleted_count >= 0
    AND last_failed_count >= 0
    AND pending_retry_count >= 0
    AND consecutive_failures >= 0
    AND last_observation_deleted_count >= 0
    AND last_segment_deleted_count >= 0
    AND last_ground_truth_deleted_count >= 0
    AND (oldest_expired_age_ms IS NULL OR oldest_expired_age_ms >= 0)
    AND (deletion_lag_ms IS NULL OR deletion_lag_ms >= 0)
  );

COMMENT ON COLUMN public.journey_retention_health.last_observation_deleted_count IS
  'Count of journey_observations rows deleted in the last completed retention cycle.';
COMMENT ON COLUMN public.journey_retention_health.last_segment_deleted_count IS
  'Count of journey_segment_revisions rows deleted in the last completed retention cycle.';
COMMENT ON COLUMN public.journey_retention_health.last_ground_truth_deleted_count IS
  'Count of journey_shadow_ground_truth rows deleted in the last completed retention cycle.';

-- finish_journey_retention_cycle_v2
-- Identical to v1 in all lease-token, health-state, and consecutive-failure logic.
-- Extra args: p_observation_deleted_count, p_segment_deleted_count,
--             p_ground_truth_deleted_count.
-- last_deleted_count continues to be the caller-supplied aggregate total.
CREATE OR REPLACE FUNCTION public.finish_journey_retention_cycle_v2(
  p_cycle_token                uuid,
  p_now                        timestamptz,
  p_status                     text,
  p_deleted_count              integer,
  p_failed_count               integer,
  p_oldest_expired_age_ms      bigint,
  p_deletion_lag_ms            bigint,
  p_pending_retry_count        integer,
  p_error                      text,
  p_observation_deleted_count  integer,
  p_segment_deleted_count      integer,
  p_ground_truth_deleted_count integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_updated_job text;
BEGIN
  -- All the same validations as v1
  IF p_cycle_token IS NULL
     OR p_status NOT IN ('HEALTHY', 'DEGRADED', 'FAILED')
     OR p_deleted_count IS NULL
     OR p_deleted_count < 0
     OR p_failed_count IS NULL
     OR p_failed_count < 0
     OR p_pending_retry_count IS NULL
     OR p_pending_retry_count < 0
     OR (p_oldest_expired_age_ms IS NOT NULL AND p_oldest_expired_age_ms < 0)
     OR (p_deletion_lag_ms IS NOT NULL AND p_deletion_lag_ms < 0) THEN
    RAISE EXCEPTION 'invalid cycle result';
  END IF;

  -- Validate breakdown counts
  IF p_observation_deleted_count IS NULL OR p_observation_deleted_count < 0 THEN
    RAISE EXCEPTION 'invalid observation_deleted_count';
  END IF;
  IF p_segment_deleted_count IS NULL OR p_segment_deleted_count < 0 THEN
    RAISE EXCEPTION 'invalid segment_deleted_count';
  END IF;
  IF p_ground_truth_deleted_count IS NULL OR p_ground_truth_deleted_count < 0 THEN
    RAISE EXCEPTION 'invalid ground_truth_deleted_count';
  END IF;

  UPDATE public.journey_retention_health health
     SET last_status = p_status,
         last_run_at = p_now,
         last_success_at = CASE
           WHEN p_status IN ('HEALTHY', 'DEGRADED') THEN p_now
           ELSE health.last_success_at
         END,
         last_failed_at = CASE
           WHEN p_status = 'FAILED' THEN p_now
           ELSE health.last_failed_at
         END,
         last_deleted_count = p_deleted_count,
         last_failed_count = p_failed_count,
         oldest_expired_age_ms = p_oldest_expired_age_ms,
         deletion_lag_ms = p_deletion_lag_ms,
         pending_retry_count = p_pending_retry_count,
         consecutive_failures = CASE
           WHEN p_status = 'FAILED' THEN health.consecutive_failures + 1
           ELSE 0
         END,
         last_error = CASE
           WHEN p_error IS NULL THEN NULL
           ELSE left(p_error, 500)
         END,
         last_observation_deleted_count  = p_observation_deleted_count,
         last_segment_deleted_count      = p_segment_deleted_count,
         last_ground_truth_deleted_count = p_ground_truth_deleted_count,
         cycle_token = NULL,
         cycle_leased_by = NULL,
         cycle_lease_expires_at = NULL,
         updated_at = p_now
   WHERE health.job = 'journey_observation_retention'
     AND health.cycle_token = p_cycle_token
     AND health.cycle_lease_expires_at > p_now
  RETURNING health.job INTO v_updated_job;

  RETURN v_updated_job IS NOT NULL;
END;
$$;

COMMENT ON FUNCTION public.finish_journey_retention_cycle_v2(uuid, timestamptz, text, integer, integer, bigint, bigint, integer, text, integer, integer, integer) IS
  'INTERNAL SHADOW ONLY. Completes a retention cycle with per-purge breakdown counts '
  '(observations, segment revisions, ground-truth rows). Preserves exact v1 semantics: '
  'lease-token guard, health-state transitions, consecutive-failure counter. '
  'last_deleted_count remains the caller-supplied aggregate total. '
  'v1 remains callable for backward compatibility. '
  'Central authority reads the same HEALTHY row; breakdown columns are informational.';

REVOKE ALL ON FUNCTION public.finish_journey_retention_cycle_v2(
  uuid, timestamptz, text, integer, integer, bigint, bigint, integer, text,
  integer, integer, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_journey_retention_cycle_v2(
  uuid, timestamptz, text, integer, integer, bigint, bigint, integer, text,
  integer, integer, integer
) TO service_role;

COMMIT;
