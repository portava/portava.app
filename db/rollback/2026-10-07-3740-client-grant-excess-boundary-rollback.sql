-- Rollback for 3740_client_grant_excess_boundary.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3740 DID
-- =============
--   Part 1  REVOKE ALL FROM PUBLIC, anon, authenticated on whichever of seven
--           tables existed: highlight_resurfacing_preferences,
--           highlight_projection_policies, highlight_sources, message_edits,
--           message_reactions, message_attachments, conversation_action_refs.
--   Part 2  On profiles, REVOKE table-level SELECT and UPDATE from anon and
--           authenticated and re-GRANT the baseline's column lists (61 SELECT,
--           80 UPDATE columns).
--   service_role, every policy, every row and every flag were left alone.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Restores Part 1 to the state the creating migrations left: anon and
-- authenticated hold SELECT, INSERT, UPDATE and DELETE (Supabase's default
-- ACL) on each of the seven tables that exists.
--
-- ⚠ IT RE-OPENS WHAT 3740 CLOSED. Those grants are what lets the anonymous key
-- read or write these tables the moment any permissive policy admits it. Use it
-- only to recover from a reader 3740 broke, and re-apply 3740 with that table
-- removed from Part 1 and its reason recorded, as soon as the reader is known.
--
-- Part 2 is deliberately NOT reversed. Before 3740, the column ACL on profiles
-- was either the baseline's (production — 3740 changed nothing there) or the
-- baseline's buried under a table-level SELECT/UPDATE that no migration ever
-- granted (a baseline replayed over the Supabase default ACL). Restoring the
-- second would re-expose date_of_birth, phone_e164, expo_push_token and
-- full_name to the anonymous key; there is no legitimate pre-3740 state to
-- return to.
--
-- It changes no row except 3740's own schema_migration_ledger row, which it
-- deletes so the runner re-applies 3740 later.

BEGIN;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['highlight_resurfacing_preferences', 'highlight_projection_policies', 'highlight_sources', 'message_edits', 'message_reactions', 'message_attachments', 'conversation_action_refs'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE '3740 rollback: public.% absent; nothing to restore.', t;
    ELSE
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO anon, authenticated', t);
    END IF;
  END LOOP;
END $$;

DELETE FROM public.schema_migration_ledger WHERE filename = '3740_client_grant_excess_boundary.sql';
COMMIT;

DO $post$
BEGIN
  IF NOT has_table_privilege('authenticated', 'public.highlight_sources', 'INSERT')
     OR NOT has_table_privilege('anon', 'public.highlight_projection_policies', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3740 rollback): the pre-3740 client grants are not back.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger
              WHERE filename = '3740_client_grant_excess_boundary.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3740 rollback): the ledger still records 3740 as applied.';
  END IF;
END $post$;
