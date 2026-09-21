-- Rollback for 2540_trust_events_one_shot_uniqueness.sql
-- NOT applied to any database as of authoring (2026-09-07): neither portava-ci
-- (hwokxgbmezheskbzskfr) nor travel-buddy/production (ajrurzioarfkagpuxfnb).
--
-- WHAT 2540 DID
-- =============
-- Created one partial UNIQUE index on public.trust_events:
--   trust_events_one_shot_uniq (user_id, event_type, source_type, source_id)
--   WHERE source_id IS NOT NULL AND event_type IN (the five one-shot types)
-- plus a COMMENT on it. No policy, grant, column, flag or row.
--
-- WHAT DROPPING IT DOES
-- =====================
-- Nothing a user can observe. TrustEventService.recordTrustEvent's read-then-
-- insert dedup keeps running exactly as it does against a database that never
-- had the index; only the concurrent-insert race reopens. The 23505 handling
-- in the code becomes unreachable, not wrong.
--
-- Data loss: none. An index holds no data of its own.
--
-- Idempotent: DROP INDEX IF EXISTS.

BEGIN;

DROP INDEX IF EXISTS public.trust_events_one_shot_uniq;

COMMIT;
