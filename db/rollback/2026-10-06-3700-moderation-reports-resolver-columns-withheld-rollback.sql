-- Rollback for 3700_moderation_reports_resolver_columns_withheld.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3700 DID
-- =============
--   * REVOKE SELECT ON TABLE public.moderation_reports FROM anon, authenticated;
--   * GRANT SELECT (12 columns) ON public.moderation_reports TO anon,
--     authenticated, withholding resolver_id and resolver_note.
--   No policy, row, function or service_role privilege was touched, and the
--   client roles' INSERT/UPDATE/DELETE grants were left as they were.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Restores the baseline state: anon and authenticated hold table-level SELECT
-- on moderation_reports and no column-level privilege.
--
-- ⚠ IT RE-OPENS WHAT 3700 CLOSED: a reporter's own client key can then read
-- resolver_id (the reviewing moderator's account id) and resolver_note on
-- their own reports. Use it only to recover from a reader 3700 broke, then
-- re-apply 3700 with that reader's column named.

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.moderation_reports') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK PRECONDITION FAILED (3700): public.moderation_reports does not exist.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c, LATERAL aclexplode(c.relacl) a
              WHERE c.oid = 'public.moderation_reports'::regclass AND a.privilege_type = 'SELECT'
                AND a.grantee IN ('anon'::regrole, 'authenticated'::regrole)) THEN
    RAISE EXCEPTION 'ROLLBACK PRECONDITION FAILED (3700): a client role already holds table-level SELECT on moderation_reports; 3700 is not in force here.';
  END IF;
END $pre$;

REVOKE SELECT (
  id, reporter_id, subject_type, subject_id, subject_user_id, category,
  details, status, created_at, resolved_at, thread_id, image_url
) ON TABLE public.moderation_reports FROM anon, authenticated;

GRANT SELECT ON TABLE public.moderation_reports TO anon, authenticated;

COMMIT;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.moderation_reports'::regclass AND attnum > 0 AND attacl IS NOT NULL) THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3700): a column-level privilege survives on moderation_reports.';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.moderation_reports', 'SELECT')
     OR NOT has_table_privilege('anon', 'public.moderation_reports', 'SELECT') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3700): a client role lacks the table-level SELECT the baseline grants.';
  END IF;
END $post$;
