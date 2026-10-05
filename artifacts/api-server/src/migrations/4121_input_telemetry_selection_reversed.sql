-- 4121 — §57 "wrong-selection reversal rate" (census G368): admit the fifteenth
-- §44 event name, `selection_reversed`, into input_assistance_telemetry_events.
--
-- WHY A MIGRATION. 2950's `iate_event_name_known` CHECK enumerates the fourteen
-- names the taxonomy had when it was written. The ingest (lib/inputAssistance/
-- telemetry.ts) now rebuilds a fifteenth, and an insert carrying a name the
-- CHECK does not list fails THE WHOLE BATCH at the database — the route answers
-- 422 and every event queued with it is lost. So the code change and this file
-- must ship together, and until this file is applied the client's reversal
-- events are refused there (counted, never silently dropped).
--
-- WHAT IT DOES. Replaces the CHECK with the same fourteen names plus one. The
-- new set is a strict SUPERSET of the old, so every row 2950 ever admitted still
-- satisfies it and the ADD validates without touching data. Nothing else in 2950
-- changes: the raw-text key refusal, the no-actor rule and the retention bound
-- are untouched, and the postcondition below re-asserts the no-actor rule
-- because a later edit to this table is exactly where it would be broken.
--
-- PRIVACY. `selection_reversed` carries `{ suggestionType: token,
-- secondsSinceSelect: int }` — the type of the row that had resolved the field
-- and how long the resolution lasted. No identifier, no text, no account id.
--
-- The vocabulary in code and the vocabulary here are pinned to each other by
-- src/test/inputTelemetryVocabularyParity.test.ts, which reads the NEWEST
-- migration that defines this constraint.
--
-- NOT APPLIED BY ITS AUTHOR. Application follows the repository's reviewed
-- PR/CI path; see docs/migrations.md.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.input_assistance_telemetry_events') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (4121): input_assistance_telemetry_events (2950) does not exist.';
  END IF;
END $$;

ALTER TABLE public.input_assistance_telemetry_events
  DROP CONSTRAINT IF EXISTS iate_event_name_known;

ALTER TABLE public.input_assistance_telemetry_events
  ADD CONSTRAINT iate_event_name_known CHECK (event_name IN (
    'input_opened',
    'query_length_changed',
    'suggestion_request_started',
    'suggestion_request_completed',
    'suggestion_rendered',
    'suggestion_selected',
    'suggestion_dismissed',
    'raw_search_submitted',
    'manual_value_kept',
    'validation_shown',
    'correction_accepted',
    'disambiguation_selected',
    'action_completed',
    'downstream_task_completed',
    'selection_reversed'
  ));

DO $post$
DECLARE
  def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
    FROM pg_constraint c
   WHERE c.conrelid = 'public.input_assistance_telemetry_events'::regclass
     AND c.conname = 'iate_event_name_known';
  IF def IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (4121): iate_event_name_known is missing.';
  END IF;
  IF position('selection_reversed' in def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (4121): iate_event_name_known does not admit selection_reversed.';
  END IF;
  IF position('downstream_task_completed' in def) = 0 OR position('input_opened' in def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (4121): iate_event_name_known lost a name 2950 admitted.';
  END IF;
  -- 2950's no-actor rule, re-asserted where a later edit would break it.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'input_assistance_telemetry_events'
       AND column_name IN ('user_id', 'viewer_id', 'actor_id', 'profile_id', 'author_id', 'account_id')
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (4121): input_assistance_telemetry_events carries an account column.';
  END IF;
END $post$;

COMMIT;
