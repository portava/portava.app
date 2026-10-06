-- Rollback for 3781_input_telemetry_selection_reversed.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3781 DID: replaced 2950's `iate_event_name_known` CHECK with the same
-- fourteen names plus `selection_reversed`.
-- WHAT THIS ROLLBACK DOES: restores 2950's fourteen-name CHECK exactly. A stored
-- `selection_reversed` row would violate it, so the rollback RAISES while any
-- exists rather than deleting telemetry to make the constraint fit. It also
-- deletes 3781's ledger row so the applier can re-apply it.
--
-- ORDER MATTERS: the application code that admits `selection_reversed`
-- (lib/inputAssistance/telemetry.ts) must be reverted FIRST, or every batch
-- carrying the event fails at the database after this runs.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.input_assistance_telemetry_events WHERE event_name = 'selection_reversed') THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3781): selection_reversed rows exist and would violate the restored CHECK.';
  END IF;
END $$;

ALTER TABLE public.input_assistance_telemetry_events DROP CONSTRAINT IF EXISTS iate_event_name_known;
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
    'downstream_task_completed'
  ));
DELETE FROM public.schema_migration_ledger WHERE filename = '3781_input_telemetry_selection_reversed.sql';

COMMIT;

DO $post$
DECLARE
  def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
    FROM pg_constraint c
   WHERE c.conrelid = 'public.input_assistance_telemetry_events'::regclass
     AND c.conname = 'iate_event_name_known';
  IF def IS NULL OR position('selection_reversed' in def) > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3781 rollback): the fourteen-name CHECK is not restored.';
  END IF;
END $post$;
