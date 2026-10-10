-- Rollback for artifacts/api-server/src/migrations/3661_telegraph_group_controls.sql
-- Telegraph §30A.12 — group controls and host mutes.
--
-- WHAT THIS DESTROYS: every control a host set (slow mode, host-only posting,
-- media / link restrictions) and every host mute in force. No message,
-- membership or conversation is touched. A member REMOVED by a host stays
-- removed (that is message_thread_members.left_at, which this file does not
-- touch).
--
-- CHECK BEFORE RUNNING:
--     SELECT count(*) FROM public.telegraph_thread_controls;
--     SELECT count(*) FROM public.telegraph_thread_member_mutes;
--
-- THE FLAG IS ALMOST CERTAINLY WHAT YOU WANT INSTEAD:
--     UPDATE public.feature_flags SET enabled = false
--      WHERE flag = 'telegraph_group_controls_enabled';
-- With it off nothing reads either table and every send is decided as before.

BEGIN;

DROP TABLE IF EXISTS public.telegraph_thread_member_mutes;
DROP TABLE IF EXISTS public.telegraph_thread_controls;

DELETE FROM public.feature_flags
 WHERE flag = 'telegraph_group_controls_enabled'
   AND description LIKE 'RESTRICTIVE-WHEN-ON gate for Telegraph §30A.12 group controls:%';

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '3661_telegraph_group_controls.sql';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.telegraph_thread_controls') IS NOT NULL
     OR to_regclass('public.telegraph_thread_member_mutes') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: a 3661 table is still present.';
  END IF;
END $$;

COMMIT;
