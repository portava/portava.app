-- 2812_telegraph_report_evidence.sql
-- Telegraph §22 — restricted moderation storage for reported content.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Telegraph lane
-- 2810-2819.
--
-- Required identically by both specification versions:
--   §22  "Evidence: store minimum necessary reported content/context under
--        restricted policy."
--   §22  "Reported deleted content may remain in restricted moderation storage
--        but must not appear in normal retrieval."
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THE CENSUS FOUND
-- ══════════════════════════════════════════════════════════════════════════════
-- T283 (BUILT-BUT-WRONG): "Minimal, arguably too minimal: a report row carries
--   reporter, target type/id and a 200-character reason_detail and NO CONTENT
--   SNAPSHOT — so a message deleted after being reported leaves a moderator
--   with a pointer to a redacted row."
--
-- T284 (NOT BUILT): "The opposite happens. Deletion redacts in place —
--   routes/groupChat.ts `.update({ deleted_at: now, body: '' })` — with nothing
--   copied to moderation storage first, so reported content is DESTROYED, not
--   restricted."
--
-- Both were re-read against this tree before this file was written and both are
-- still exactly true: `reports` has no content column of any kind, and the
-- delete path blanks `messages.body` unconditionally.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- RESTRICTED MEANS NO POLICY AT ALL, NOT A CAREFUL POLICY
-- ══════════════════════════════════════════════════════════════════════════════
-- Every other Telegraph table in this lane ships RLS with a SELECT policy keyed
-- on thread membership. This one ships RLS with NO POLICY WHATSOEVER, which in
-- PostgreSQL means every non-superuser, non-owner role reads zero rows and
-- writes nothing. Only the service role — which bypasses RLS — can touch it.
--
-- That is the strongest available reading of "restricted policy", and it is
-- also the only one that cannot be got wrong by a later membership change: a
-- policy keyed on thread membership would hand the reported party their own
-- evidence file the moment they were still a member, which is the exact
-- disclosure §22 exists to prevent. A postcondition below RAISES if any policy
-- is ever added, so relaxing this is a migration someone has to write on
-- purpose rather than a line someone adds by habit.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THERE IS NO FOREIGN KEY TO messages
-- ══════════════════════════════════════════════════════════════════════════════
-- This table exists so that content survives the deletion of the thing it came
-- from. An FK to public.messages would either block that deletion or cascade
-- the evidence away with it, and both defeat the point. `target_id` is a plain
-- uuid and is deliberately NOT referential.
--
-- The one FK that IS here points at public.reports with ON DELETE CASCADE, and
-- that direction is the privacy-correct one: evidence is retained to serve a
-- report, so when the report ceases to exist the justification for holding the
-- content ceases with it.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- MINIMUM NECESSARY, STATED AS NUMBERS
-- ══════════════════════════════════════════════════════════════════════════════
-- "Minimum necessary" is not a feeling, so it is a CHECK:
--   * body_snapshot is capped at 4000 characters — longer than any message this
--     product renders, short enough that this cannot become a message archive.
--   * context is capped at 16 KB by pg_column_size, which bounds a thread
--     report's surrounding window to roughly the last twenty messages.
--   * NOTHING about the reporter's own account, the reported party's profile,
--     location, or any other thread is stored. What is here is what was
--     reported, plus enough to locate it.
--
-- RETENTION IS AN OWNER DECISION AND IS LEFT AS ONE. `retention_until` is
-- written by the application and defaults to NULL, meaning "no expiry has been
-- decided". There is deliberately no purge job in this migration: a deletion
-- schedule for moderation evidence is a legal and policy call, not a schema
-- one, and a job that silently destroyed evidence on a number this file
-- invented would be worse than no job.
--
-- ROLLBACK: db/rollback/2026-09-12-2812-telegraph-report-evidence-rollback.sql

BEGIN;

-- ── Preconditions ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.reports') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.reports must exist — evidence is retained to serve a report.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags must exist.';
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- 1. The evidence table
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.telegraph_report_evidence (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The report this evidence serves. CASCADE: no report, no reason to hold it.
  report_id          uuid        NOT NULL REFERENCES public.reports(id) ON DELETE CASCADE,

  -- What was reported. Deliberately NOT a foreign key — see the header.
  target_type        text        NOT NULL CHECK (target_type IN ('message','thread')),
  target_id          uuid        NOT NULL,

  -- Where it lived, so a moderator can locate it without a second lookup that
  -- may no longer resolve.
  thread_id          uuid        NULL,
  author_id          uuid        NULL,

  -- The content itself, as it read at the moment it was reported.
  body_snapshot      text        NULL CHECK (body_snapshot IS NULL OR length(body_snapshot) <= 4000),
  media_url_snapshot text        NULL CHECK (media_url_snapshot IS NULL OR length(media_url_snapshot) <= 2048),
  msg_type           text        NULL,
  subtype            text        NULL,
  content_created_at timestamptz NULL,

  -- Bounded surrounding context for a thread report, where a single message id
  -- is not what was reported. Capped so this cannot grow into an archive.
  context            jsonb       NULL CHECK (context IS NULL OR pg_column_size(context) <= 16384),

  -- Whether the snapshot is complete. A report filed AFTER the content was
  -- already deleted has nothing to copy, and a moderator must be able to tell
  -- "we captured nothing" from "there was nothing to capture".
  capture_status     text        NOT NULL DEFAULT 'captured'
                     CHECK (capture_status IN ('captured','already_deleted','unreadable')),

  captured_at        timestamptz NOT NULL DEFAULT now(),

  -- NULL = no retention decision has been made. See the header.
  retention_until    timestamptz NULL,

  CONSTRAINT telegraph_report_evidence_one_per_report UNIQUE (report_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_tg_report_evidence_report
  ON public.telegraph_report_evidence(report_id);
CREATE INDEX IF NOT EXISTS idx_tg_report_evidence_target
  ON public.telegraph_report_evidence(target_type, target_id);

COMMENT ON TABLE public.telegraph_report_evidence IS
  'Telegraph §22 restricted moderation storage. RLS is ENABLED with NO POLICY, so only the service role can read or write it — a membership-keyed policy would hand the reported party their own evidence file. Content is snapshotted at REPORT time so it survives a later deletion (§22 T284); nothing here references public.messages, deliberately, so a deletion cannot cascade the evidence away. retention_until is NULL until an owner decides a schedule; there is no purge job.';

COMMENT ON COLUMN public.telegraph_report_evidence.capture_status IS
  'captured = the content was read and copied. already_deleted = the target was soft-deleted before the report was filed, so there was nothing to copy. unreadable = the read failed; the evidence row still exists so the gap is recorded rather than silent.';

-- ══════════════════════════════════════════════════════════════════════════════
-- 2. RLS on, and no policy. See the header for why this is not an oversight.
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.telegraph_report_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegraph_report_evidence FORCE ROW LEVEL SECURITY;

-- ══════════════════════════════════════════════════════════════════════════════
-- 3. The flag, seeded FALSE
-- ══════════════════════════════════════════════════════════════════════════════

INSERT INTO public.feature_flags (flag, enabled, description)
VALUES
  ('telegraph_report_evidence_enabled', false,
   'CAPABILITY gate for Telegraph §22 moderation evidence. OFF (the seed): the report routes behave exactly as before — a report row is written and no content is snapshotted, so a database without 2812 never has this table named at it. ON: filing a report against a message or a thread also writes one row to public.telegraph_report_evidence containing the reported content as it read at that moment. Turning it ON begins retaining user content in restricted storage, which is a policy decision as much as a technical one; retention_until stays NULL until a schedule is decided and nothing purges.')
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.telegraph_report_evidence') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: public.telegraph_report_evidence was not created.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'telegraph_report_evidence' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: RLS is not enabled on telegraph_report_evidence.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'telegraph_report_evidence' AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: FORCE ROW LEVEL SECURITY is not set on telegraph_report_evidence — the table owner would bypass RLS.';
  END IF;

  -- THE assertion. Any policy at all reopens this table to a non-service role.
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'telegraph_report_evidence'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a policy exists on telegraph_report_evidence — restricted moderation storage must be reachable only by the service role.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'telegraph_report_evidence_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: telegraph_report_evidence_enabled was not seeded.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'telegraph_report_evidence_enabled' AND enabled) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: telegraph_report_evidence_enabled must be seeded FALSE.';
  END IF;
END $$;

COMMIT;
