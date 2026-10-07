-- 3700_moderation_reports_resolver_columns_withheld.sql
-- moderation_reports: the person who filed a report may read their own report,
-- but never WHO reviewed it (resolver_id) or what the moderator wrote about it
-- (resolver_note). The client roles keep SELECT on every other column.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (lane L band 3700-3719). APPLIED TO
-- NO DATABASE by the lane that wrote it. It narrows what a signed-in client key
-- can read from a live table, so it needs the owner's production approval and
-- is sequenced by the integration owner, not by this file.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY (independent verification of lane L, finding 6, 2026-10-06)
-- ══════════════════════════════════════════════════════════════════════════════
-- The baseline (20260819_baseline_structure.sql) gives moderation_reports
--
--     resolver_id uuid, resolver_note text,
--     GRANT ALL ON TABLE public.moderation_reports TO anon;
--     GRANT ALL ON TABLE public.moderation_reports TO authenticated;
--     CREATE POLICY moderation_reports_select_own ... FOR SELECT USING ((auth.uid() = reporter_id));
--     CREATE POLICY modrep_reporter_read          ... FOR SELECT USING ((reporter_id = auth.uid()));
--     CREATE POLICY modrep_svc                    ... USING ((auth.role() = 'service_role'::text));
--
-- and no later migration narrows the grant. So a reporter, with their own
-- client key, can read every column of their own report through PostgREST —
-- including resolver_id (the moderator's account id: who to retaliate against)
-- and resolver_note (an internal note). RLS decides ROWS; it cannot hide a
-- column.
--
-- Today nothing writes those two columns: the review route
-- (routes/admin.ts POST /admin/moderation/reports/:id/review) records the
-- moderator and the note only in moderation_actions (service-role only) for
-- exactly this reason. This file makes that a database guarantee rather than a
-- convention one future write could break.
--
-- WHO STILL READS THEM: the moderator, through the admin API, which reads as
-- service_role (table-level ALL, untouched here). No client-key read of
-- moderation_reports exists in either build (the mobile app reports through
-- the API: travel-buddy-standalone/src/services/moderation.ts), so no reader
-- loses a column it uses. A future client `select=*` on this table would be
-- refused as a whole — name the columns.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- HOW: A COLUMN REVOKE CANNOT SUBTRACT FROM A TABLE GRANT
-- ══════════════════════════════════════════════════════════════════════════════
-- PostgreSQL privileges are additive: `REVOKE SELECT (resolver_id) ...` against
-- a table-level SELECT is a no-op (3520's header records the same trap in
-- 0081). So the table-level SELECT is revoked from anon and authenticated and
-- SELECT is granted back on the twelve other columns by name. INSERT, UPDATE
-- and DELETE are not touched (no client-role policy admits a write).
--
-- Rollback: db/rollback/2026-10-06-3700-moderation-reports-resolver-columns-withheld-rollback.sql
-- Proof: src/test/db/moderationReportsResolverColumns.db.test.ts (live-DB tier).

BEGIN;

DO $pre$
DECLARE
  granted  text[] := ARRAY[
    'id','reporter_id','subject_type','subject_id','subject_user_id','category',
    'details','status','created_at','resolved_at','thread_id','image_url'];
  withheld text[] := ARRAY['resolver_id','resolver_note'];
  cols     text[];
  missing  text;
  unknown  text;
  bad      text;
BEGIN
  IF to_regclass('public.moderation_reports') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3700): public.moderation_reports does not exist.';
  END IF;
  -- RLS decides the ROWS. Without it these column grants would be the only
  -- boundary, and every reporter would read every report.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.moderation_reports'::regclass) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3700): RLS is not enabled on moderation_reports; refusing to narrow columns on a table whose rows are open.';
  END IF;

  SELECT array_agg(attname::text ORDER BY attnum) INTO cols
    FROM pg_attribute
   WHERE attrelid = 'public.moderation_reports'::regclass AND attnum > 0 AND NOT attisdropped;

  SELECT string_agg(c, ', ') INTO missing
    FROM unnest(granted || withheld) c WHERE c <> ALL (cols);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3700): moderation_reports lacks column(s) this migration classifies: %.', missing;
  END IF;
  -- Every column that exists must be classified: an unclassified one might be
  -- another moderator-only field. Refuse rather than guess its side.
  SELECT string_agg(c, ', ') INTO unknown
    FROM unnest(cols) c WHERE c <> ALL (granted) AND c <> ALL (withheld);
  IF unknown IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3700): moderation_reports has column(s) this migration does not classify: %. Classify them in 3700 before applying.', unknown;
  END IF;

  -- THE DEFECT MUST BE PRESENT: both client roles hold a plain table-level
  -- SELECT (without the grant option). That is what makes every column
  -- readable, and it is the one privilege this file removes.
  IF (SELECT count(*) FROM pg_class c, LATERAL aclexplode(c.relacl) a
       WHERE c.oid = 'public.moderation_reports'::regclass AND a.privilege_type = 'SELECT'
         AND NOT a.is_grantable
         AND a.grantee IN ('anon'::regrole, 'authenticated'::regrole)) <> 2 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3700): anon and authenticated do not both hold a plain table-level SELECT on moderation_reports. Either this ran already, or something re-granted it WITH GRANT OPTION. Read pg_class.relacl first.';
  END IF;
  -- PUBLIC must hold nothing: its SELECT would survive the revoke below.
  SELECT string_agg(a.privilege_type, ', ') INTO bad
    FROM pg_class c, LATERAL aclexplode(c.relacl) a
   WHERE c.oid = 'public.moderation_reports'::regclass AND a.grantee = 0;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3700): PUBLIC holds table privileges on moderation_reports (%); revoking from anon and authenticated would not close the read.', bad;
  END IF;
  -- No column-level privilege may exist yet: the rollback could not restore one.
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.moderation_reports'::regclass AND attnum > 0 AND attacl IS NOT NULL) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3700): moderation_reports already carries column-level privileges; inspect pg_attribute.attacl first.';
  END IF;
END $pre$;

REVOKE SELECT ON TABLE public.moderation_reports FROM anon, authenticated;

GRANT SELECT (
  id, reporter_id, subject_type, subject_id, subject_user_id, category,
  details, status, created_at, resolved_at, thread_id, image_url
) ON TABLE public.moderation_reports TO anon, authenticated;

COMMIT;

DO $post$
DECLARE
  granted  text[] := ARRAY[
    'id','reporter_id','subject_type','subject_id','subject_user_id','category',
    'details','status','created_at','resolved_at','thread_id','image_url'];
  never    text[] := ARRAY['resolver_id','resolver_note'];
  leak     text;
  lost     text;
BEGIN
  -- VACUITY GUARD: the two withheld columns must exist, or the claim below is
  -- about nothing.
  IF (SELECT count(*) FROM pg_attribute
       WHERE attrelid = 'public.moderation_reports'::regclass AND NOT attisdropped
         AND attname IN ('resolver_id','resolver_note')) <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3700) VACUOUS: resolver_id and resolver_note are not both present.';
  END IF;
  -- No table-level SELECT survives for a client role, and PUBLIC holds nothing.
  -- Checked first: a table-level SELECT covers every column and would make
  -- every column check below pass for the wrong reason.
  SELECT string_agg(format('%s:%s', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END, x.privilege_type), ', ')
    INTO leak
    FROM pg_class c, LATERAL aclexplode(c.relacl) x
   WHERE c.oid = 'public.moderation_reports'::regclass
     AND ((x.grantee = 0) OR (x.grantee IN ('anon'::regrole, 'authenticated'::regrole) AND x.privilege_type = 'SELECT'));
  IF leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3700): a table-level privilege covering every column survives on moderation_reports: %.', leak;
  END IF;
  -- THE NEGATIVE: neither client role can read either withheld column.
  SELECT string_agg(r || '.' || a.attname, ', ') INTO leak
    FROM unnest(ARRAY['anon','authenticated']) r, pg_attribute a
   WHERE a.attrelid = 'public.moderation_reports'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname::text = ANY (never)
     AND has_column_privilege(r, a.attrelid, a.attnum, 'SELECT');
  IF leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3700): a client role can still read a moderator-only column: %.', leak;
  END IF;
  -- Exactly the granted set: nothing more, nothing less.
  SELECT string_agg(r || '.' || a.attname, ', ') INTO leak
    FROM unnest(ARRAY['anon','authenticated']) r, pg_attribute a
   WHERE a.attrelid = 'public.moderation_reports'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname::text <> ALL (granted)
     AND has_column_privilege(r, a.attrelid, a.attnum, 'SELECT');
  IF leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3700): a client role can read a withheld moderation_reports column: %.', leak;
  END IF;
  SELECT string_agg(r || '.' || a.attname, ', ') INTO lost
    FROM unnest(ARRAY['anon','authenticated']) r, pg_attribute a
   WHERE a.attrelid = 'public.moderation_reports'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname::text = ANY (granted)
     AND NOT has_column_privilege(r, a.attrelid, a.attnum, 'SELECT');
  IF lost IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3700): a client role lost a column it must keep: %.', lost;
  END IF;
  -- The moderator's path is untouched: service_role still reads both columns.
  IF NOT has_column_privilege('service_role', 'public.moderation_reports', 'resolver_id', 'SELECT')
     OR NOT has_column_privilege('service_role', 'public.moderation_reports', 'resolver_note', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3700): service_role can no longer read resolver_id/resolver_note; the admin API would lose the moderator''s record.';
  END IF;
  RAISE NOTICE '3700 postcondition: anon/authenticated read 12 columns of moderation_reports and neither resolver column; service_role reads all.';
END $post$;
