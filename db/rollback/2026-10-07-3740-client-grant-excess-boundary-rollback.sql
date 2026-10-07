-- Rollback for 3740_client_grant_excess_boundary.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3740 DID
-- =============
--   Part 1  REVOKE ALL ON nine tables FROM PUBLIC, anon, authenticated:
--           highlight_resurfacing_preferences, highlight_projection_policies,
--           highlight_sources, message_edits, message_reactions,
--           message_attachments, conversation_action_refs,
--           media_processing_attempts, media_asset_lifecycle_events.
--   Part 2  On profiles, REVOKE table-level SELECT and UPDATE from anon and
--           authenticated and re-GRANT the baseline's column lists (61 SELECT,
--           80 UPDATE columns).
--   service_role, every policy, every row and every flag were left alone.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Restores Part 1 to the state the creating migrations left: anon and
-- authenticated hold SELECT, INSERT, UPDATE and DELETE on the seven tables
-- created by 2720/2721/2722/2811 (Supabase's default ACL), and SELECT only on
-- the two media tables (2955 had already taken INSERT/UPDATE/DELETE).
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
DECLARE
  v_names text;
BEGIN
  SELECT string_agg(t, ', ' ORDER BY t) INTO v_names
    FROM unnest(ARRAY[
      'highlight_resurfacing_preferences', 'highlight_projection_policies',
      'highlight_sources', 'message_edits', 'message_reactions',
      'message_attachments', 'conversation_action_refs',
      'media_processing_attempts', 'media_asset_lifecycle_events']) AS t
   WHERE to_regclass('public.' || t) IS NULL;
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3740 rollback): % absent; this is not a database 3740 ran on.', v_names;
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.highlight_resurfacing_preferences,
  public.highlight_projection_policies,
  public.highlight_sources,
  public.message_edits,
  public.message_reactions,
  public.message_attachments,
  public.conversation_action_refs
TO anon, authenticated;
GRANT SELECT ON TABLE
  public.media_processing_attempts,
  public.media_asset_lifecycle_events
TO anon, authenticated;

DELETE FROM public.schema_migration_ledger WHERE filename = '3740_client_grant_excess_boundary.sql';
COMMIT;

DO $post$
BEGIN
  IF NOT has_table_privilege('anon', 'public.message_edits', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.highlight_sources', 'INSERT')
     OR NOT has_table_privilege('anon', 'public.media_processing_attempts', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3740 rollback): the pre-3740 client grants are not back.';
  END IF;
  IF has_table_privilege('anon', 'public.media_processing_attempts', 'INSERT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3740 rollback): a media write grant came back; 2955 had removed it.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger
              WHERE filename = '3740_client_grant_excess_boundary.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3740 rollback): the ledger still records 3740 as applied.';
  END IF;
END $post$;
