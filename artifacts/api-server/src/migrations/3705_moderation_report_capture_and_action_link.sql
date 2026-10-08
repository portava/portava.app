-- 3705_moderation_report_capture_and_action_link.sql
-- Lead ruling Q-L23 / D-38a (2026-10-06): capture the reported text WHEN THE
-- REPORT IS FILED, for moderators only, deleted with the report, never shown to
-- the reporter or the reported person. Lead ruling D-MODACTION-SHAPE
-- (2026-10-06): moderation_actions gains report_id as a real foreign key;
-- expires_at is NOT added (user_account_states.expires_at stays the source).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (lane L band 3700-3719). APPLIED TO
-- NO DATABASE by the lane that wrote it. Sequenced by the integration owner.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT IT CREATES
-- ══════════════════════════════════════════════════════════════════════════════
--   moderation_report_captures            one row per moderation_reports row whose
--                                         content was captured at intake: the
--                                         read's outcome (capture_state), the
--                                         moderator-facing excerpt (snapshot) and
--                                         when (captured_at). report_id is the
--                                         primary key and REFERENCES
--                                         moderation_reports ON DELETE CASCADE:
--                                         the capture is deleted with its report,
--                                         by the database, on every path.
--   moderation_actions.report_id          uuid, REFERENCES moderation_reports
--                                         ON DELETE SET NULL (the audit row
--                                         outlives a deleted report; the link
--                                         does not dangle). Back-filled from
--                                         metadata->>'report_id' where that is a
--                                         uuid naming an existing report.
--   moderation_report_capture_enabled     seeded FALSE.
--
-- WHY A TABLE AND NOT A COLUMN ON moderation_reports. 3700 classifies EVERY
-- column of moderation_reports and grants the reporter SELECT on twelve of them
-- by name; its precondition refuses an unclassified column, and its live-DB test
-- pins the column set. A new column there would also be reachable through the
-- client roles' remaining table-level INSERT/UPDATE privileges. A separate table
-- with RLS on, no policies and every client privilege revoked has none of that:
-- the reporter's key cannot name it at all.
--
-- POSTURE. RLS on, NO policies, REVOKE ALL from PUBLIC, anon and authenticated
-- (check:client-privilege-boundary rule 4); service_role only — the admin API
-- reads it, the report intake writes it. Nothing in the snapshot is a
-- coordinate, an email, a phone number or a media URL
-- (lib/moderationReportSnapshots.ts), and it carries no person uuid of its own.
--
-- ACCOUNT DELETION. The capture follows its report row (lead ruling Q-L23:
-- "deleted with the report"): ON DELETE CASCADE from moderation_reports. Its
-- fate on a person's erasure is therefore the report's, which is itself an open
-- owner decision (moderation_reports is in UNCLASSIFIED_BACKLOG; D-38b and D-39).
-- That is why the flag stays FALSE until those are answered — see
-- lib/deletionDispositions.ts RETAINED_WITH_REASON.
--
-- Rollback: db/rollback/2026-10-08-3705-moderation-report-capture-and-action-link-rollback.sql
-- (refuses while the flag is TRUE).
-- Proof: src/test/db/moderationReportCapture.db.test.ts (live-DB tier);
--        src/test/moderationReportCapture.test.ts (the intake, the queue, the audit link).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3705): public.feature_flags must exist.';
  END IF;
  IF to_regclass('public.moderation_reports') IS NULL OR to_regclass('public.moderation_actions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3705): public.moderation_reports and public.moderation_actions must exist.';
  END IF;
  IF to_regclass('public.moderation_report_captures') IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3705): public.moderation_report_captures already exists; read it before re-running.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.moderation_actions'::regclass AND attname = 'report_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3705): moderation_actions.report_id already exists; read it before re-running.';
  END IF;
  -- moderation_actions must stay service-role only: a client-role policy would
  -- make the new link readable, and this file adds no policy of its own.
  IF EXISTS (SELECT 1 FROM pg_policy p
              WHERE p.polrelid = 'public.moderation_actions'::regclass
                AND NOT (p.polroles = ARRAY['service_role'::regrole::oid])) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3705): moderation_actions has a policy that is not service_role-only; inspect pg_policy before adding report_id.';
  END IF;
END $pre$;

CREATE TABLE public.moderation_report_captures (
  report_id     uuid        PRIMARY KEY REFERENCES public.moderation_reports(id) ON DELETE CASCADE,
  capture_state text        NOT NULL,
  snapshot      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  captured_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT moderation_report_captures_state_check
    CHECK (capture_state IN ('ok', 'not_found', 'unavailable', 'unsupported')),
  CONSTRAINT moderation_report_captures_snapshot_object_check
    CHECK (jsonb_typeof(snapshot) = 'object')
);

COMMENT ON TABLE public.moderation_report_captures IS
  'Lead ruling Q-L23 / D-38a: the reported content as it was when the report was filed (moderators only; deleted with the report by ON DELETE CASCADE; never shown to the reporter or the reported person). Written only while moderation_report_capture_enabled is TRUE. Service-role only.';

ALTER TABLE public.moderation_report_captures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.moderation_report_captures FROM PUBLIC;
REVOKE ALL ON public.moderation_report_captures FROM anon;
REVOKE ALL ON public.moderation_report_captures FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.moderation_report_captures TO service_role;

ALTER TABLE public.moderation_actions
  ADD COLUMN report_id uuid REFERENCES public.moderation_reports(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.moderation_actions.report_id IS
  'Lead ruling D-MODACTION-SHAPE: the moderation_reports row this action was taken on, if any. SET NULL when the report is deleted. metadata.report_id is still written alongside it for existing readers.';

CREATE INDEX idx_moderation_actions_report_id
  ON public.moderation_actions (report_id) WHERE report_id IS NOT NULL;

-- Back-fill the link the metadata already records, where it names a real report.
-- Compared as TEXT, so a metadata value that is not a uuid is simply no match
-- (a cast in a WHERE clause is not guaranteed to run after the guard beside it).
UPDATE public.moderation_actions a
   SET report_id = r.id
  FROM public.moderation_reports r
 WHERE a.report_id IS NULL
   AND r.id::text = lower(a.metadata->>'report_id');

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'moderation_report_capture_enabled',
    FALSE,
    'Lead ruling Q-L23 / D-38a: when a moderation report is filed, capture the reported content (an excerpt, never coordinates, contact details or media URLs) for moderators only, deleted with the report. Off: moderators see the content live, as before. Keep OFF until the report retention questions (D-38b, D-39) are answered.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

DO $post$
DECLARE
  bad text;
BEGIN
  IF to_regclass('public.moderation_report_captures') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3705): moderation_report_captures was not created.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.moderation_report_captures'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3705): RLS is not enabled on moderation_report_captures.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.moderation_report_captures'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3705): moderation_report_captures has a policy; it must be service-role only.';
  END IF;
  SELECT string_agg(format('%s:%s', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END, a.privilege_type), ', ')
    INTO bad
    FROM pg_class c, LATERAL aclexplode(c.relacl) a
   WHERE c.oid = 'public.moderation_report_captures'::regclass
     AND (a.grantee = 0 OR a.grantee IN ('anon'::regrole, 'authenticated'::regrole));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3705): a client role holds privileges on moderation_report_captures: %.', bad;
  END IF;
  IF NOT has_table_privilege('service_role', 'public.moderation_report_captures', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.moderation_report_captures', 'INSERT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3705): service_role cannot read and write moderation_report_captures.';
  END IF;
  -- Deleted with the report: the FK cascades.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.moderation_report_captures'::regclass AND contype = 'f'
                    AND confrelid = 'public.moderation_reports'::regclass AND confdeltype = 'c') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3705): moderation_report_captures.report_id does not CASCADE from moderation_reports.';
  END IF;
  -- The action link: a real FK, SET NULL on the report's deletion.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.moderation_actions'::regclass AND contype = 'f'
                    AND confrelid = 'public.moderation_reports'::regclass AND confdeltype = 'n') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3705): moderation_actions.report_id is not a SET NULL foreign key to moderation_reports.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.moderation_actions'::regclass AND attname = 'expires_at' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3705): moderation_actions.expires_at exists; D-MODACTION-SHAPE keeps the expiry on user_account_states.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'moderation_report_capture_enabled' AND enabled IS FALSE) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3705): the moderation_report_capture_enabled flag row is missing or not FALSE.';
  END IF;
  RAISE NOTICE '3705 postcondition: moderation_report_captures is service-role only and cascades from its report; moderation_actions.report_id is a SET NULL foreign key; moderation_report_capture_enabled is seeded FALSE.';
END $post$;
