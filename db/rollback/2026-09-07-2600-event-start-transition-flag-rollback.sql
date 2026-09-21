-- Rollback for 2600_event_start_transition_flag.sql
-- NOT applied anywhere as of 2026-09-07: 2600 itself has not been applied to
-- portava-ci (hwokxgbmezheskbzskfr) or production (ajrurzioarfkagpuxfnb).
-- It was rehearsed on portava-ci inside a transaction that ended in ROLLBACK.
--
-- WHAT 2600 DID
-- =============
--   * INSERT feature_flags ('event_start_transition_enabled', false)
--
-- WHAT DELETING IT DOES
-- =====================
-- Nothing a user can observe: lib/eventLifecycle.ts reads the flag fail-closed
-- (isFlagEnabled), so an absent row is exactly the seeded FALSE — the
-- scheduler keeps making one flag read a minute and never writes. If an owner
-- had flipped the flag ON, deleting the row stops further transitions within
-- one scheduler interval (60 s).
--
-- WHAT IT DOES NOT UNDO
-- =====================
-- Rows already moved to `started` while the flag was ON stay `started`, and
-- their event_activity_log rows (action = 'started', actor_id NULL,
-- metadata.source = 'event_start_transition_enabled') stay. Reverting those
-- is a data decision, not this file's: the audit rows name every affected
-- event, so an owner who wants them back at their prior state can read
-- metadata.from_state per row. Trust events, stamps and pushes emitted by a
-- host completing or marking no-shows on a started event are downstream
-- actions of those hosts and are not reverted here.
--
-- Data loss: the one flag row (and any description edit an operator made).
--
-- Idempotent.

BEGIN;

DELETE FROM public.feature_flags WHERE flag = 'event_start_transition_enabled';

COMMIT;
