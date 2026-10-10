-- Rollback for 3621_layover_erasure_audit_pseudonym.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3621 DID: made layover_events.user_id and session_id nullable, changed
-- the session FK to ON DELETE SET NULL, added erasure_pseudonym /
-- pseudonymised_at / retain_until with the identity-or-pseudonym CHECK and the
-- retention index, so that account deletion can keep a pseudonymised audit
-- record for at most 12 months (OD-MAP-4, census-layover L163).
-- WHAT THIS ROLLBACK DOES: deletes every PSEUDONYMISED row first (they have no
-- user and no session, so 0127's NOT NULLs cannot be restored around them),
-- then restores 0127's shape exactly: NOT NULL on both columns, the session FK
-- ON DELETE CASCADE, the three columns, the CHECK and the index gone.
-- DATA LOSS: the pseudonymised audit records only. That is stricter than
-- OD-MAP-4's ceiling, never wider. Named rows are untouched.
-- AFTER ROLLBACK: AccountDeletionService's pseudonymise step answers 42703/
-- PGRST204 and falls back to erasing the departed traveller's events with
-- their sessions (the pre-3621 cascade).

BEGIN;

DELETE FROM public.layover_events WHERE pseudonymised_at IS NOT NULL;

ALTER TABLE public.layover_events DROP CONSTRAINT IF EXISTS layover_events_identity_or_pseudonym;
DROP INDEX IF EXISTS public.layover_events_retain_until_idx;

ALTER TABLE public.layover_events DROP CONSTRAINT layover_events_session_id_fkey;
ALTER TABLE public.layover_events
  ADD CONSTRAINT layover_events_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES public.layover_sessions(id) ON DELETE CASCADE;

ALTER TABLE public.layover_events ALTER COLUMN user_id    SET NOT NULL;
ALTER TABLE public.layover_events ALTER COLUMN session_id SET NOT NULL;

ALTER TABLE public.layover_events
  DROP COLUMN IF EXISTS erasure_pseudonym,
  DROP COLUMN IF EXISTS pseudonymised_at,
  DROP COLUMN IF EXISTS retain_until;

DELETE FROM public.schema_migration_ledger WHERE filename = '3621_layover_erasure_audit_pseudonym.sql';

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'layover_events'
                AND column_name IN ('erasure_pseudonym', 'pseudonymised_at', 'retain_until')) THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3621): a pseudonymisation column remains';
  END IF;
  IF (SELECT confdeltype FROM pg_constraint
       WHERE conname = 'layover_events_session_id_fkey' AND conrelid = 'public.layover_events'::regclass) IS DISTINCT FROM 'c' THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3621): the session FK is not ON DELETE CASCADE again';
  END IF;
END $post$;

COMMIT;
