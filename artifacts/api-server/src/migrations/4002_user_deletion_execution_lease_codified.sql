-- 4002_user_deletion_execution_lease_codified.sql
--
-- Written 2026-11-04 on the owner's decision ("codify" for the chunked-upload
-- store and the deletion lease, 23:09 UTC) over the 59 production objects that
-- check:undeclared-production-objects (PR #820) carried as owner-pending. The
-- journey-shadow programme stays on that ratchet, undecided.
--
-- Codifies the deletion execution lease on public.user_deletion_requests:
-- execution_token, execution_started_at, execution_lease_expires_at, the
-- CHECK user_deletion_requests_execution_claim_check and the partial index
-- user_deletion_requests_execution_lease_idx. Production has carried them in
-- every capture since 2026-09-07, no file in this tree declared them,
-- checkSchemaReferences named the three columns as undeclared-but-live since
-- 2026-09-04, and no row holds an execution_token. The 'executing' status the
-- check refers to is declared by 2178. Every definition is the census note's
-- transcription of production's catalogue (docs/architecture/census-media.md,
-- "Note (2026-10-24, capability refresh, PR #788)").
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION. Prerequisite: user_deletion_requests
-- with its status column (2178), which sorts before it.
--
-- WHAT IT DOES, BY STARTING SHAPE
--   production     every object exists: a strict no-op apart from the
--                  postconditions, which only read.
--   portava-ci,    adds the three nullable columns (no default, so no row is
--   local chain    rewritten), the check and the index.
--
-- It changes no row anywhere. The body runs inside BEGIN/COMMIT; the
-- postcondition follows the COMMIT as a read-only DO block, the shape
-- scripts/src/apply-migrations.ts applies and certify:migrations re-runs.

BEGIN;

ALTER TABLE public.user_deletion_requests ADD COLUMN IF NOT EXISTS execution_token uuid;
ALTER TABLE public.user_deletion_requests ADD COLUMN IF NOT EXISTS execution_started_at timestamptz;
ALTER TABLE public.user_deletion_requests ADD COLUMN IF NOT EXISTS execution_lease_expires_at timestamptz;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_deletion_requests_execution_claim_check'
      AND conrelid = 'public.user_deletion_requests'::regclass
  ) THEN
    ALTER TABLE public.user_deletion_requests
      ADD CONSTRAINT user_deletion_requests_execution_claim_check
      CHECK ((status <> 'executing'::text) OR ((execution_token IS NOT NULL) AND (execution_started_at IS NOT NULL) AND (execution_lease_expires_at IS NOT NULL) AND (execution_lease_expires_at > execution_started_at)));
  END IF;
END $do$;

CREATE INDEX IF NOT EXISTS user_deletion_requests_execution_lease_idx
  ON public.user_deletion_requests (status, execution_lease_expires_at) WHERE (status = 'executing'::text);

COMMIT;

-- ── Postconditions: read only ───────────────────────────────────────────────
DO $do$
DECLARE
  missing text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'user_deletion_requests' AND column_name = 'execution_token') THEN missing := missing || 'execution_token'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'user_deletion_requests' AND column_name = 'execution_started_at') THEN missing := missing || 'execution_started_at'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'user_deletion_requests' AND column_name = 'execution_lease_expires_at') THEN missing := missing || 'execution_lease_expires_at'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_deletion_requests_execution_claim_check') THEN missing := missing || 'user_deletion_requests_execution_claim_check'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'user_deletion_requests_execution_lease_idx') THEN missing := missing || 'user_deletion_requests_execution_lease_idx'; END IF;
  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION '4002: postcondition failed, missing %', array_to_string(missing, ', ');
  END IF;
END $do$;
