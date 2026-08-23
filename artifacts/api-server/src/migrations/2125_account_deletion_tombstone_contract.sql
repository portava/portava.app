-- 2125_account_deletion_tombstone_contract.sql
--
-- Preserve the anonymised profile and deletion-request audit record after the
-- Supabase Auth identity is removed. This migration does not enable Journey
-- collection or alter any Journey feature flag.

BEGIN;

DO $$
DECLARE
  v_orphan_request_count bigint;
  v_handle_not_null boolean;
  v_handle_unique boolean;
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.profiles is missing';
  END IF;
  IF to_regclass('public.user_deletion_requests') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.user_deletion_requests is missing';
  END IF;

  SELECT a.attnotnull
    INTO v_handle_not_null
    FROM pg_attribute a
   WHERE a.attrelid = 'public.profiles'::regclass
     AND a.attname = 'handle'
     AND NOT a.attisdropped;

  IF v_handle_not_null IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.profiles.handle must remain NOT NULL';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_attribute a
     WHERE a.attrelid = 'public.profiles'::regclass
       AND a.attname = 'account_status'
       AND a.attnotnull
       AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.profiles.account_status must exist and remain NOT NULL';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM pg_constraint c
     WHERE c.conrelid = 'public.profiles'::regclass
       AND c.contype = 'u'
       AND pg_get_constraintdef(c.oid) = 'UNIQUE (handle)'
  )
    INTO v_handle_unique;

  IF v_handle_unique IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.profiles.handle must remain UNIQUE';
  END IF;

  SELECT count(*)
    INTO v_orphan_request_count
    FROM public.user_deletion_requests r
    LEFT JOIN public.profiles p ON p.id = r.user_id
   WHERE p.id IS NULL;

  IF v_orphan_request_count <> 0 THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: % user_deletion_requests row(s) have no profile tombstone',
      v_orphan_request_count;
  END IF;
END $$;

-- A deleted Auth identity must not cascade into the retained profile tombstone.
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_id_fkey;

-- The request is an audit record for the surviving tombstone, not for an Auth
-- identity that is intentionally removed before status becomes "executed".
ALTER TABLE public.user_deletion_requests
  DROP CONSTRAINT IF EXISTS user_deletion_requests_user_id_fkey;
ALTER TABLE public.user_deletion_requests
  ADD CONSTRAINT user_deletion_requests_user_id_fkey
  FOREIGN KEY (user_id)
  REFERENCES public.profiles(id)
  ON DELETE RESTRICT;

-- Destructive work is allowed only after an atomic, leased claim. The random
-- token prevents a concurrent worker or a cancellation request from finalizing
-- a deletion it does not own; the bounded lease permits crash recovery.
ALTER TABLE public.user_deletion_requests
  ADD COLUMN IF NOT EXISTS execution_token uuid,
  ADD COLUMN IF NOT EXISTS execution_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS execution_lease_expires_at timestamptz;

ALTER TABLE public.user_deletion_requests
  DROP CONSTRAINT IF EXISTS user_deletion_requests_status_check;
ALTER TABLE public.user_deletion_requests
  ADD CONSTRAINT user_deletion_requests_status_check
  CHECK (status IN ('pending', 'executing', 'cancelled', 'executed'));

ALTER TABLE public.user_deletion_requests
  DROP CONSTRAINT IF EXISTS user_deletion_requests_execution_claim_check;
ALTER TABLE public.user_deletion_requests
  ADD CONSTRAINT user_deletion_requests_execution_claim_check
  CHECK (
    status <> 'executing'
    OR (
      execution_token IS NOT NULL
      AND execution_started_at IS NOT NULL
      AND execution_lease_expires_at IS NOT NULL
      AND execution_lease_expires_at > execution_started_at
    )
  );

CREATE INDEX IF NOT EXISTS user_deletion_requests_execution_lease_idx
  ON public.user_deletion_requests (status, execution_lease_expires_at)
  WHERE status = 'executing';

-- Preserve all existing profile visibility paths, but never expose a retained
-- deleted tombstone through direct anon/authenticated table reads.
DROP POLICY IF EXISTS profiles_select ON public.profiles;
CREATE POLICY profiles_select ON public.profiles
  FOR SELECT
  USING (
    account_status <> 'deleted'
    AND (
      id = auth.uid()
      OR (is_private = false AND NOT viewer_is_blocked(id))
      OR (
        NOT viewer_is_blocked(id)
        AND EXISTS (
          SELECT 1
            FROM public.user_friendships
           WHERE (user_a = auth.uid() AND user_b = id)
              OR (user_b = auth.uid() AND user_a = id)
        )
      )
    )
  );

COMMENT ON COLUMN public.profiles.id IS
  'Stable profile/tombstone identity. Deliberately not an FK to auth.users so account deletion can remove Auth PII without deleting retained moderation and audit references.';
COMMENT ON TABLE public.user_deletion_requests IS
  'Account deletion audit record. user_id references the retained profile tombstone; execution is atomically leased and terminal status is executed.';

COMMIT;