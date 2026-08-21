-- 2120_journey_privacy_foundation.sql
--
-- Privacy lifecycle for the restricted Journey observation boundary introduced
-- by 2119. This migration does not enable either Journey feature flag, create a
-- collector, or add any Journey product consumer.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.journey_observations') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.journey_observations is missing; apply 2119 first';
  END IF;
  IF to_regclass('public.user_location_preferences') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.user_location_preferences is missing';
  END IF;
  IF to_regclass('public.location_sessions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.location_sessions is missing';
  END IF;
END $$;

-- Existing generic location-sharing sessions remain valid for their current
-- products, but are explicitly ineligible for Journey. A future Journey session
-- creator must opt into the purpose and must provide a finite expires_at.
ALTER TABLE public.location_sessions
  ADD COLUMN IF NOT EXISTS journey_purpose text NOT NULL DEFAULT 'legacy_location_share';

ALTER TABLE public.location_sessions
  DROP CONSTRAINT IF EXISTS location_sessions_journey_purpose_check;
ALTER TABLE public.location_sessions
  ADD CONSTRAINT location_sessions_journey_purpose_check
  CHECK (
    journey_purpose IN ('legacy_location_share', 'journey_observation_v1')
    AND (
      journey_purpose <> 'journey_observation_v1'
      OR expires_at IS NOT NULL
    )
  );

COMMENT ON COLUMN public.location_sessions.journey_purpose IS
  'Explicit purpose boundary. Existing and generic sessions are legacy_location_share and cannot authorize Journey writes.';

-- Versioned, auditable purpose consent. Do not silently upgrade a boolean opt-in
-- created before this privacy contract: any such row is reset to disabled and
-- must be granted again through the versioned consent function below.
ALTER TABLE public.user_location_preferences
  ADD COLUMN IF NOT EXISTS journey_consent_scope text,
  ADD COLUMN IF NOT EXISTS journey_consent_version smallint,
  ADD COLUMN IF NOT EXISTS journey_consent_granted_at timestamptz,
  ADD COLUMN IF NOT EXISTS journey_consent_revoked_at timestamptz;

UPDATE public.user_location_preferences
   SET journey_observation_enabled = false,
       journey_consent_revoked_at = CASE
         WHEN journey_consent_granted_at IS NOT NULL
           THEN COALESCE(journey_consent_revoked_at, clock_timestamp())
         ELSE NULL
       END
 WHERE journey_observation_enabled = true
   AND (
     journey_consent_scope IS DISTINCT FROM 'journey_observation_v1'
     OR journey_consent_version IS DISTINCT FROM 1
     OR journey_consent_granted_at IS NULL
     OR journey_consent_revoked_at IS NOT NULL
   );

ALTER TABLE public.user_location_preferences
  DROP CONSTRAINT IF EXISTS user_location_preferences_journey_consent_check;
ALTER TABLE public.user_location_preferences
  ADD CONSTRAINT user_location_preferences_journey_consent_check
  CHECK (
    (
      journey_observation_enabled = false
      OR (
        journey_consent_scope = 'journey_observation_v1'
        AND journey_consent_version = 1
        AND journey_consent_granted_at IS NOT NULL
        AND journey_consent_revoked_at IS NULL
      )
    )
    AND (
      journey_consent_revoked_at IS NULL
      OR (
        journey_consent_granted_at IS NOT NULL
        AND journey_consent_revoked_at >= journey_consent_granted_at
      )
    )
  );

COMMENT ON COLUMN public.user_location_preferences.journey_consent_scope IS
  'Versioned purpose scope for explicit Journey observation consent.';
COMMENT ON COLUMN public.user_location_preferences.journey_consent_granted_at IS
  'Server-recorded grant time; observations predating this instant are rejected.';
COMMENT ON COLUMN public.user_location_preferences.journey_consent_revoked_at IS
  'Server-recorded revocation time. A non-null value is never eligible for writes.';

-- Owners retain their legacy RLS access for ordinary location preferences and
-- may still opt out directly, but only server-side SECURITY DEFINER boundaries
-- may grant or rewrite the versioned Journey consent evidence. Prefixing this
-- trigger with "a_" makes it run before the revocation trigger for direct
-- opt-outs; that later trigger can then stamp revoked_at safely.
CREATE OR REPLACE FUNCTION public.guard_journey_consent_server_authority()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF current_user::text IN ('anon', 'authenticated') THEN
    IF TG_OP = 'INSERT' AND (
      NEW.journey_observation_enabled IS DISTINCT FROM false
      OR NEW.journey_consent_scope IS NOT NULL
      OR NEW.journey_consent_version IS NOT NULL
      OR NEW.journey_consent_granted_at IS NOT NULL
      OR NEW.journey_consent_revoked_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Journey consent grants are server-managed'
        USING ERRCODE = '42501';
    END IF;

    IF TG_OP = 'UPDATE' AND (
      (
        NEW.journey_observation_enabled IS DISTINCT FROM
          OLD.journey_observation_enabled
        AND NEW.journey_observation_enabled IS TRUE
      )
      OR NEW.journey_consent_scope IS DISTINCT FROM OLD.journey_consent_scope
      OR NEW.journey_consent_version IS DISTINCT FROM OLD.journey_consent_version
      OR NEW.journey_consent_granted_at IS DISTINCT FROM OLD.journey_consent_granted_at
      OR NEW.journey_consent_revoked_at IS DISTINCT FROM OLD.journey_consent_revoked_at
    ) THEN
      RAISE EXCEPTION 'Journey consent grants are server-managed'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_journey_consent_server_authority() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_journey_consent_server_authority() FROM anon;
REVOKE ALL ON FUNCTION public.guard_journey_consent_server_authority() FROM authenticated;

DROP TRIGGER IF EXISTS a_journey_consent_server_authority
  ON public.user_location_preferences;
CREATE TRIGGER a_journey_consent_server_authority
  BEFORE INSERT
     OR UPDATE OF journey_observation_enabled,
                  journey_consent_scope,
                  journey_consent_version,
                  journey_consent_granted_at,
                  journey_consent_revoked_at
  ON public.user_location_preferences
  FOR EACH ROW EXECUTE FUNCTION public.guard_journey_consent_server_authority();

-- Durable revocation work survives process restarts. The observation/session id
-- is intentionally not an FK: a parent deletion may finish before a crashed
-- worker records completion, and the durable job must still be observable.
CREATE TABLE IF NOT EXISTS public.journey_revocation_jobs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL,
  location_session_id  uuid,
  consent_scope        text NOT NULL DEFAULT 'journey_observation_v1',
  reason               text NOT NULL,
  idempotency_key      text NOT NULL UNIQUE,
  status               text NOT NULL DEFAULT 'pending',
  requested_at         timestamptz NOT NULL DEFAULT now(),
  available_at         timestamptz NOT NULL DEFAULT now(),
  leased_by            text,
  lease_token          uuid,
  lease_expires_at     timestamptz,
  attempt_count        integer NOT NULL DEFAULT 0,
  last_attempt_at      timestamptz,
  completed_at         timestamptz,
  deleted_count        integer NOT NULL DEFAULT 0,
  failed_count         integer NOT NULL DEFAULT 0,
  last_error           text,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT journey_revocation_jobs_scope_check
    CHECK (consent_scope = 'journey_observation_v1'),
  CONSTRAINT journey_revocation_jobs_reason_check
    CHECK (reason IN (
      'consent_revoked',
      'sharing_paused',
      'location_mode_off',
      'location_mode_non_authorizing',
      'preference_deleted',
      'session_ended',
      'session_expired',
      'session_deleted',
      'session_purpose_changed',
      'account_deletion'
    )),
  CONSTRAINT journey_revocation_jobs_status_check
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  CONSTRAINT journey_revocation_jobs_counts_check
    CHECK (
      attempt_count >= 0
      AND deleted_count >= 0
      AND failed_count >= 0
    ),
  CONSTRAINT journey_revocation_jobs_completion_check
    CHECK (
      (status = 'completed' AND completed_at IS NOT NULL)
      OR (status <> 'completed' AND completed_at IS NULL)
    )
);

ALTER TABLE public.journey_revocation_jobs
  ADD COLUMN IF NOT EXISTS lease_token uuid;

-- Rebuild the reason constraint so re-applying this idempotent migration to an
-- already-created queue permits the non-authorizing coarse-mode transition.
ALTER TABLE public.journey_revocation_jobs
  DROP CONSTRAINT IF EXISTS journey_revocation_jobs_reason_check;
ALTER TABLE public.journey_revocation_jobs
  ADD CONSTRAINT journey_revocation_jobs_reason_check
  CHECK (reason IN (
    'consent_revoked',
    'sharing_paused',
    'location_mode_off',
    'location_mode_non_authorizing',
    'preference_deleted',
    'session_ended',
    'session_expired',
    'session_deleted',
    'session_purpose_changed',
    'account_deletion'
  ));

CREATE INDEX IF NOT EXISTS journey_revocation_jobs_due_idx
  ON public.journey_revocation_jobs (status, available_at, requested_at)
  WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS journey_revocation_jobs_user_idx
  ON public.journey_revocation_jobs (user_id, requested_at DESC);

COMMENT ON TABLE public.journey_revocation_jobs IS
  'Durable, restart-safe physical deletion work for Journey consent/session revocation. Service-only; no raw location is stored.';

ALTER TABLE public.journey_revocation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journey_revocation_jobs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.journey_revocation_jobs FROM PUBLIC;
REVOKE ALL ON TABLE public.journey_revocation_jobs FROM anon;
REVOKE ALL ON TABLE public.journey_revocation_jobs FROM authenticated;
REVOKE INSERT, UPDATE ON TABLE public.journey_revocation_jobs FROM service_role;
GRANT SELECT, DELETE ON TABLE public.journey_revocation_jobs TO service_role;

-- One durable operator row. last_run_at means an attempted cycle; authorization
-- is based on last_success_at and the effective state, so a failed run cannot
-- advance the healthy heartbeat.
CREATE TABLE IF NOT EXISTS public.journey_retention_health (
  job                    text PRIMARY KEY,
  last_status            text NOT NULL DEFAULT 'STALE',
  last_run_at            timestamptz,
  last_success_at        timestamptz,
  last_failed_at         timestamptz,
  last_deleted_count     integer NOT NULL DEFAULT 0,
  last_failed_count      integer NOT NULL DEFAULT 0,
  oldest_expired_age_ms  bigint,
  deletion_lag_ms        bigint,
  pending_retry_count    integer NOT NULL DEFAULT 0,
  consecutive_failures   integer NOT NULL DEFAULT 0,
  last_error             text,
  cycle_token            uuid,
  cycle_leased_by        text,
  cycle_lease_expires_at timestamptz,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT journey_retention_health_job_check
    CHECK (job = 'journey_observation_retention'),
  CONSTRAINT journey_retention_health_status_check
    CHECK (last_status IN ('HEALTHY', 'DEGRADED', 'FAILED', 'STALE')),
  CONSTRAINT journey_retention_health_counts_check
    CHECK (
      last_deleted_count >= 0
      AND last_failed_count >= 0
      AND pending_retry_count >= 0
      AND consecutive_failures >= 0
      AND (oldest_expired_age_ms IS NULL OR oldest_expired_age_ms >= 0)
      AND (deletion_lag_ms IS NULL OR deletion_lag_ms >= 0)
    ),
  CONSTRAINT journey_retention_health_cycle_lease_check
    CHECK (
      (
        cycle_token IS NULL
        AND cycle_leased_by IS NULL
        AND cycle_lease_expires_at IS NULL
      )
      OR (
        cycle_token IS NOT NULL
        AND cycle_leased_by IS NOT NULL
        AND cycle_lease_expires_at IS NOT NULL
      )
    )
);

ALTER TABLE public.journey_retention_health
  ADD COLUMN IF NOT EXISTS cycle_token uuid,
  ADD COLUMN IF NOT EXISTS cycle_leased_by text,
  ADD COLUMN IF NOT EXISTS cycle_lease_expires_at timestamptz;
ALTER TABLE public.journey_retention_health
  DROP CONSTRAINT IF EXISTS journey_retention_health_cycle_lease_check;
ALTER TABLE public.journey_retention_health
  ADD CONSTRAINT journey_retention_health_cycle_lease_check
  CHECK (
    (
      cycle_token IS NULL
      AND cycle_leased_by IS NULL
      AND cycle_lease_expires_at IS NULL
    )
    OR (
      cycle_token IS NOT NULL
      AND cycle_leased_by IS NOT NULL
      AND cycle_lease_expires_at IS NOT NULL
    )
  );

INSERT INTO public.journey_retention_health (job, last_status)
VALUES ('journey_observation_retention', 'STALE')
ON CONFLICT (job) DO NOTHING;

COMMENT ON TABLE public.journey_retention_health IS
  'Durable Journey retention/revocation monitoring. Missing, failed, degraded, or older-than-two-interval health denies new writes.';

ALTER TABLE public.journey_retention_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journey_retention_health FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.journey_retention_health FROM PUBLIC;
REVOKE ALL ON TABLE public.journey_retention_health FROM anon;
REVOKE ALL ON TABLE public.journey_retention_health FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.journey_retention_health FROM service_role;
GRANT SELECT ON TABLE public.journey_retention_health TO service_role;

-- Serialize the global retention cycle across API instances. A crashed cycle
-- remains non-healthy and can be reclaimed after a bounded lease.
CREATE OR REPLACE FUNCTION public.begin_journey_retention_cycle_v1(
  p_worker_id text,
  p_now timestamptz,
  p_lease_seconds integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cycle_token uuid := gen_random_uuid();
  v_claimed_token uuid;
BEGIN
  IF p_worker_id IS NULL OR length(p_worker_id) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'invalid worker id';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 900 THEN
    RAISE EXCEPTION 'invalid cycle lease';
  END IF;

  UPDATE public.journey_retention_health health
     SET last_status = 'DEGRADED',
         last_run_at = p_now,
         last_error = 'retention cycle in progress',
         cycle_token = v_cycle_token,
         cycle_leased_by = p_worker_id,
         cycle_lease_expires_at = p_now + make_interval(secs => p_lease_seconds),
         updated_at = p_now
   WHERE health.job = 'journey_observation_retention'
     AND (
       health.cycle_token IS NULL
       OR health.cycle_lease_expires_at <= p_now
     )
  RETURNING health.cycle_token INTO v_claimed_token;

  RETURN v_claimed_token;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_journey_retention_cycle_v1(
  p_cycle_token uuid,
  p_now timestamptz,
  p_status text,
  p_deleted_count integer,
  p_failed_count integer,
  p_oldest_expired_age_ms bigint,
  p_deletion_lag_ms bigint,
  p_pending_retry_count integer,
  p_error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_updated_job text;
BEGIN
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

REVOKE ALL ON FUNCTION public.begin_journey_retention_cycle_v1(
  text, timestamptz, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.begin_journey_retention_cycle_v1(
  text, timestamptz, integer
) FROM anon;
REVOKE ALL ON FUNCTION public.begin_journey_retention_cycle_v1(
  text, timestamptz, integer
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.begin_journey_retention_cycle_v1(
  text, timestamptz, integer
) TO service_role;

REVOKE ALL ON FUNCTION public.finish_journey_retention_cycle_v1(
  uuid, timestamptz, text, integer, integer, bigint, bigint, integer, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finish_journey_retention_cycle_v1(
  uuid, timestamptz, text, integer, integer, bigint, bigint, integer, text
) FROM anon;
REVOKE ALL ON FUNCTION public.finish_journey_retention_cycle_v1(
  uuid, timestamptz, text, integer, integer, bigint, bigint, integer, text
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finish_journey_retention_cycle_v1(
  uuid, timestamptz, text, integer, integer, bigint, bigint, integer, text
) TO service_role;

-- Claim bounded work atomically across multiple API instances. A worker crash
-- after deleting rows but before completion is safe: the lease expires and the
-- idempotent DELETE is retried.
CREATE OR REPLACE FUNCTION public.claim_journey_revocation_jobs_v1(
  p_worker_id text,
  p_limit integer,
  p_now timestamptz,
  p_lease_seconds integer
)
RETURNS SETOF public.journey_revocation_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_worker_id IS NULL OR length(p_worker_id) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'invalid worker id';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'invalid claim limit';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 900 THEN
    RAISE EXCEPTION 'invalid lease';
  END IF;

  RETURN QUERY
  UPDATE public.journey_revocation_jobs jobs
     SET status = 'processing',
         leased_by = p_worker_id,
         lease_token = gen_random_uuid(),
         lease_expires_at = p_now + make_interval(secs => p_lease_seconds),
         attempt_count = jobs.attempt_count + 1,
         last_attempt_at = p_now,
         updated_at = p_now
   WHERE jobs.id IN (
     SELECT candidate.id
       FROM public.journey_revocation_jobs candidate
      WHERE candidate.completed_at IS NULL
        AND (
          (
            candidate.status IN ('pending', 'failed')
            AND candidate.available_at <= p_now
          )
          OR (
            candidate.status = 'processing'
            AND candidate.lease_expires_at <= p_now
          )
        )
      ORDER BY candidate.requested_at, candidate.id
      FOR UPDATE SKIP LOCKED
      LIMIT p_limit
   )
  RETURNING jobs.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_journey_revocation_jobs_v1(
  text, integer, timestamptz, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_journey_revocation_jobs_v1(
  text, integer, timestamptz, integer
) FROM anon;
REVOKE ALL ON FUNCTION public.claim_journey_revocation_jobs_v1(
  text, integer, timestamptz, integer
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_journey_revocation_jobs_v1(
  text, integer, timestamptz, integer
) TO service_role;

-- A claim token prevents an expired worker from completing or failing a job
-- after another instance has reclaimed it.
CREATE OR REPLACE FUNCTION public.complete_journey_revocation_job_v1(
  p_job_id uuid,
  p_lease_token uuid,
  p_now timestamptz,
  p_deleted_count integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_updated_id uuid;
BEGIN
  IF p_lease_token IS NULL OR p_deleted_count IS NULL OR p_deleted_count < 0 THEN
    RAISE EXCEPTION 'invalid completion';
  END IF;

  UPDATE public.journey_revocation_jobs
     SET status = 'completed',
         completed_at = p_now,
         deleted_count = p_deleted_count,
         last_error = NULL,
         leased_by = NULL,
         lease_token = NULL,
         lease_expires_at = NULL,
         updated_at = p_now
   WHERE id = p_job_id
     AND status = 'processing'
     AND lease_token = p_lease_token
     AND lease_expires_at > p_now
  RETURNING id INTO v_updated_id;

  RETURN v_updated_id IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_journey_revocation_job_v1(
  p_job_id uuid,
  p_lease_token uuid,
  p_now timestamptz,
  p_available_at timestamptz,
  p_failed_count integer,
  p_error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_updated_id uuid;
BEGIN
  IF p_lease_token IS NULL
     OR p_available_at IS NULL
     OR p_available_at < p_now
     OR p_failed_count IS NULL
     OR p_failed_count < 1 THEN
    RAISE EXCEPTION 'invalid failure';
  END IF;

  UPDATE public.journey_revocation_jobs
     SET status = 'failed',
         available_at = p_available_at,
         failed_count = p_failed_count,
         last_error = left(COALESCE(p_error, 'unknown error'), 500),
         leased_by = NULL,
         lease_token = NULL,
         lease_expires_at = NULL,
         updated_at = p_now
   WHERE id = p_job_id
     AND status = 'processing'
     AND lease_token = p_lease_token
     AND lease_expires_at > p_now
  RETURNING id INTO v_updated_id;

  RETURN v_updated_id IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_journey_revocation_job_v1(
  uuid, uuid, timestamptz, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_journey_revocation_job_v1(
  uuid, uuid, timestamptz, integer
) FROM anon;
REVOKE ALL ON FUNCTION public.complete_journey_revocation_job_v1(
  uuid, uuid, timestamptz, integer
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.complete_journey_revocation_job_v1(
  uuid, uuid, timestamptz, integer
) TO service_role;

REVOKE ALL ON FUNCTION public.fail_journey_revocation_job_v1(
  uuid, uuid, timestamptz, timestamptz, integer, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fail_journey_revocation_job_v1(
  uuid, uuid, timestamptz, timestamptz, integer, text
) FROM anon;
REVOKE ALL ON FUNCTION public.fail_journey_revocation_job_v1(
  uuid, uuid, timestamptz, timestamptz, integer, text
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fail_journey_revocation_job_v1(
  uuid, uuid, timestamptz, timestamptz, integer, text
) TO service_role;

-- Consent changes are server-timestamped and versioned. Generic location
-- preferences remain the policy surface; this is not a parallel permission
-- system.
CREATE OR REPLACE FUNCTION public.set_journey_observation_consent_v1(
  p_user_id uuid,
  p_enabled boolean
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_preferences record;
  v_now timestamptz := clock_timestamp();
BEGIN
  SELECT user_id, location_mode, sharing_paused,
         journey_observation_enabled, journey_consent_granted_at
    INTO v_preferences
    FROM public.user_location_preferences
   WHERE user_id = p_user_id
   FOR UPDATE;

  IF p_enabled THEN
    IF NOT FOUND THEN
      RETURN 'not_eligible';
    END IF;
    IF v_preferences.sharing_paused IS DISTINCT FROM false
      OR v_preferences.location_mode NOT IN (
        'live_during_activity', 'trusted_circle_live'
      ) THEN
      RETURN 'not_eligible';
    END IF;

    INSERT INTO public.user_location_preferences (
      user_id,
      journey_observation_enabled,
      journey_consent_scope,
      journey_consent_version,
      journey_consent_granted_at,
      journey_consent_revoked_at,
      updated_at
    ) VALUES (
      p_user_id, true, 'journey_observation_v1', 1, v_now, NULL, v_now
    )
    ON CONFLICT (user_id) DO UPDATE
      SET journey_observation_enabled = true,
          journey_consent_scope = 'journey_observation_v1',
          journey_consent_version = 1,
          journey_consent_granted_at = v_now,
          journey_consent_revoked_at = NULL,
          updated_at = v_now;
    RETURN 'granted';
  END IF;

  IF NOT FOUND THEN
    INSERT INTO public.user_location_preferences (user_id, updated_at)
    VALUES (p_user_id, v_now)
    ON CONFLICT (user_id) DO NOTHING;
    RETURN 'already_revoked';
  END IF;

  UPDATE public.user_location_preferences
     SET journey_observation_enabled = false,
         journey_consent_revoked_at = CASE
           WHEN journey_consent_granted_at IS NOT NULL THEN v_now
           ELSE journey_consent_revoked_at
         END,
         updated_at = v_now
   WHERE user_id = p_user_id;
  RETURN CASE
    WHEN v_preferences.journey_observation_enabled = true THEN 'revoked'
    ELSE 'already_revoked'
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.set_journey_observation_consent_v1(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_journey_observation_consent_v1(uuid, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.set_journey_observation_consent_v1(uuid, boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.set_journey_observation_consent_v1(uuid, boolean) TO service_role;

-- Preserve 2119's same-transaction physical erasure while also recording a
-- durable, restart-safe audit/retry job. A successful consent change therefore
-- never leaves precise observations or derived segments behind.
CREATE OR REPLACE FUNCTION public.purge_journey_observations_on_consent_revocation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_reason text;
  v_revoked boolean := false;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_user_id := OLD.user_id;
    v_reason := 'preference_deleted';
    v_revoked := true;
  ELSE
    v_user_id := NEW.user_id;
    IF OLD.sharing_paused IS DISTINCT FROM true
       AND NEW.sharing_paused IS TRUE THEN
      v_reason := 'sharing_paused';
      v_revoked := true;
    ELSIF OLD.location_mode IN (
        'live_during_activity', 'trusted_circle_live'
      )
      AND NEW.location_mode NOT IN (
        'live_during_activity', 'trusted_circle_live'
      ) THEN
      v_reason := CASE
        WHEN NEW.location_mode = 'off' THEN 'location_mode_off'
        ELSE 'location_mode_non_authorizing'
      END;
      v_revoked := true;
    ELSIF OLD.journey_observation_enabled = true
       AND NEW.journey_observation_enabled IS DISTINCT FROM true THEN
      v_reason := 'consent_revoked';
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

    UPDATE public.location_sessions
       SET ended_at = COALESCE(ended_at, v_now)
     WHERE user_id = v_user_id
       AND journey_purpose = 'journey_observation_v1'
       AND ended_at IS NULL;

    DELETE FROM public.journey_observations
     WHERE user_id = v_user_id;

    DELETE FROM public.journey_segment_revisions
     WHERE user_id = v_user_id;

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
  v_user_id uuid;
  v_reason text;
  v_revoked boolean := false;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_session_id := OLD.id;
    v_user_id := OLD.user_id;
    IF OLD.journey_purpose = 'journey_observation_v1' THEN
      v_reason := 'session_deleted';
      v_revoked := true;
    END IF;
  ELSE
    v_session_id := NEW.id;
    v_user_id := NEW.user_id;
    IF OLD.journey_purpose = 'journey_observation_v1' THEN
      IF NEW.journey_purpose IS DISTINCT FROM 'journey_observation_v1' THEN
        v_reason := 'session_purpose_changed';
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
        v_reason := 'session_expired';
        v_revoked := true;
      END IF;
    END IF;
  END IF;

  IF v_revoked THEN
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

DROP TRIGGER IF EXISTS location_sessions_purge_journey_on_revocation
  ON public.location_sessions;
CREATE TRIGGER location_sessions_purge_journey_on_revocation
  AFTER UPDATE OF ended_at, expires_at, journey_purpose
     OR DELETE ON public.location_sessions
  FOR EACH ROW EXECUTE FUNCTION public.purge_journey_observations_on_session_revocation();

-- The one atomic write authority. Every missing/false/unknown control denies:
-- versioned consent, unpaused/allowed preferences, finite owned Journey-purpose
-- session, all three known flags, and fresh HEALTHY durable retention.
CREATE OR REPLACE FUNCTION public.ingest_journey_observation_v1(
  p_user_id uuid,
  p_location_session_id uuid,
  p_event_version smallint,
  p_observed_at timestamptz,
  p_source text,
  p_lat double precision,
  p_lng double precision,
  p_accuracy_m double precision,
  p_speed_mps double precision,
  p_heading_deg double precision,
  p_world_ref jsonb,
  p_consent_scope text,
  p_idempotency_key text,
  p_trust_class text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_master_enabled boolean;
  v_ingest_enabled boolean;
  v_global_stop boolean;
  v_preferences record;
  v_session record;
  v_retention record;
  v_received_at timestamptz := clock_timestamp();
  v_inserted_id uuid;
BEGIN
  SELECT enabled INTO v_master_enabled
    FROM public.feature_flags
   WHERE flag = 'COMPASS_JOURNEY_ENGINE_ENABLED'
   FOR SHARE;
  SELECT enabled INTO v_ingest_enabled
    FROM public.feature_flags
   WHERE flag = 'COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED'
   FOR SHARE;
  SELECT enabled INTO v_global_stop
    FROM public.feature_flags
   WHERE flag = 'disable_location_sharing'
   FOR SHARE;

  IF v_master_enabled IS DISTINCT FROM true
     OR v_ingest_enabled IS DISTINCT FROM true
     OR v_global_stop IS DISTINCT FROM false THEN
    RETURN 'feature_disabled';
  END IF;

  SELECT
      journey_observation_enabled,
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
     OR p_consent_scope IS DISTINCT FROM v_preferences.journey_consent_scope
     OR p_observed_at < v_preferences.journey_consent_granted_at
     OR v_preferences.sharing_paused IS DISTINCT FROM false
     OR v_preferences.location_mode NOT IN (
       'city_only', 'nearby', 'live_during_activity', 'trusted_circle_live'
     ) THEN
    RETURN 'not_authorized';
  END IF;

  SELECT id, user_id, session_type, journey_purpose,
         started_at, ended_at, expires_at
    INTO v_session
    FROM public.location_sessions
   WHERE id = p_location_session_id
     AND user_id = p_user_id
   FOR SHARE;

  IF NOT FOUND
     OR v_session.journey_purpose IS DISTINCT FROM 'journey_observation_v1'
     OR v_session.ended_at IS NOT NULL
     OR v_session.expires_at IS NULL
     OR v_session.expires_at <= v_received_at
     OR p_observed_at < v_session.started_at
     OR p_observed_at > v_session.expires_at
     OR p_observed_at < v_received_at - interval '24 hours'
     OR p_observed_at > v_received_at + interval '5 minutes' THEN
    RETURN 'not_authorized';
  END IF;

  SELECT last_status, last_success_at, pending_retry_count,
         oldest_expired_age_ms, deletion_lag_ms
    INTO v_retention
    FROM public.journey_retention_health
   WHERE job = 'journey_observation_retention'
   FOR SHARE;

  IF NOT FOUND
     OR v_retention.last_status IS DISTINCT FROM 'HEALTHY'
     OR v_retention.last_success_at IS NULL
     OR v_retention.last_success_at < v_received_at - interval '10 minutes'
     OR v_retention.pending_retry_count IS DISTINCT FROM 0
     OR COALESCE(v_retention.oldest_expired_age_ms, 0) > 0
     OR COALESCE(v_retention.deletion_lag_ms, 0) > 0 THEN
    RETURN 'temporarily_unavailable';
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
  ELSE
    RETURN 'not_authorized';
  END IF;

  INSERT INTO public.journey_observations (
    user_id, location_session_id, event_version, observed_at, received_at,
    source, lat, lng, accuracy_m, speed_mps, heading_deg, world_ref,
    consent_scope, idempotency_key, trust_class, expires_at
  ) VALUES (
    p_user_id, p_location_session_id, p_event_version, p_observed_at,
    v_received_at, p_source, p_lat, p_lng, p_accuracy_m, p_speed_mps,
    p_heading_deg, p_world_ref, p_consent_scope, p_idempotency_key,
    p_trust_class, v_received_at + interval '24 hours'
  )
  ON CONFLICT (user_id, location_session_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_inserted_id;

  IF v_inserted_id IS NULL THEN
    RETURN 'deduplicated';
  END IF;
  RETURN 'accepted';
END;
$$;

-- The SECURITY DEFINER RPC is the only observation writer. Task 2119 granted
-- service_role direct INSERT for the restricted foundation; revoke that bypass
-- now that the atomic consent/session/retention authority exists.
REVOKE INSERT ON TABLE public.journey_observations FROM service_role;

REVOKE ALL ON FUNCTION public.ingest_journey_observation_v1(
  uuid, uuid, smallint, timestamptz, text,
  double precision, double precision, double precision, double precision,
  double precision, jsonb, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ingest_journey_observation_v1(
  uuid, uuid, smallint, timestamptz, text,
  double precision, double precision, double precision, double precision,
  double precision, jsonb, text, text, text
) FROM anon;
REVOKE ALL ON FUNCTION public.ingest_journey_observation_v1(
  uuid, uuid, smallint, timestamptz, text,
  double precision, double precision, double precision, double precision,
  double precision, jsonb, text, text, text
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_journey_observation_v1(
  uuid, uuid, smallint, timestamptz, text,
  double precision, double precision, double precision, double precision,
  double precision, jsonb, text, text, text
) TO service_role;

COMMIT;

-- Rollback is intentionally separate and guarded:
-- docs/sql/rollback_2120_journey_privacy_foundation.sql