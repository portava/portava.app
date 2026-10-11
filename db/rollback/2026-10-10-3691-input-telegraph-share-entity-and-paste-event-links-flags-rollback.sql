-- Rollback for 3691_input_telegraph_share_entity_and_paste_event_links_flags.sql
-- NOT applied anywhere at the time of writing.
--
-- WHAT 3691 DID: seeded input_telegraph_share_entity_enabled and
-- input_paste_event_links_enabled, both FALSE. Nothing else.
-- WHAT THIS ROLLBACK DOES: removes both rows ONLY while each is FALSE, and
-- deletes 3691's ledger row so the applier can re-apply it.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
             WHERE flag IN ('input_telegraph_share_entity_enabled', 'input_paste_event_links_enabled') AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3691): a 3691 flag is TRUE. Turn it off deliberately first.';
  END IF;
END $$;

DELETE FROM public.feature_flags
 WHERE flag IN ('input_telegraph_share_entity_enabled', 'input_paste_event_links_enabled') AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3691_input_telegraph_share_entity_and_paste_event_links_flags.sql';

COMMIT;
