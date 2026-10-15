-- 3786_layover_crew_abort_notify_flag.sql
-- census-layover L144 (spec §15 / §15.1: at the one-tap abort, "crew/buddy is
-- notified if policy + user settings allow"). B58 lane LAY-6, layover band
-- 3784-3799 (PLAN-layover: 3786 = LAY-6). APPLIED TO NO DATABASE by the lane
-- that wrote it.
--
-- Additive + idempotent. ONE INSERT: a feature_flags row seeded FALSE with
-- ON CONFLICT DO NOTHING. No schema object is created or changed; no table,
-- column, policy or grant is touched.
--
-- `layover_crew_abort_notify_enabled` — services/layover/LayoverCrewAbortNotice.ts
--   (read by POST /airport/sessions/:id/return-now through crewAbortNoticeRequest,
--   and by GET /airport/sessions/:id/overview through crewAbortNoticeCapability).
--   ON: a traveller who aborts with the explicit per-abort choice `tellCrew: true`
--   has ONE in-app notice written to each other live member of the crew they
--   joined with that session who clears blocks in both directions and the
--   sharing gate — "<name or 'A crew member'> is heading back to the airport",
--   no reason, time or place, no push. The abort answers a COUNT, never ids.
--   OFF / absent / unreadable (the seed): nothing is read beyond this flag,
--   nobody is told, and the abort answers crew_notify_not_enabled exactly as
--   before this migration.
--   Turning it ON is the owner's decision (OQ-3: is telling the crew that a
--   member turned back an acceptable disclosure?). This file does not take it.
--   PREREQUISITE for ON: 2984 + 2985 (layover_crews / layover_crew_members) —
--   applied to production 2026-09-16 (census-layover §26.1).
--
-- Rollback: db/rollback/2026-10-14-3786-layover-crew-abort-notify-flag-rollback.sql

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3786): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'layover_crew_abort_notify_enabled',
    false,
    'Layover L144: at the one-tap abort, tell the traveller''s crew they are heading back. ON: only when the traveller chooses it on that abort (tellCrew: true); one in-app notice per live crewmate who clears blocks both ways and the sharing gate; text "<name or A crew member> is heading back to the airport" only; no push; the abort reports a count, never ids. A disclosure about the traveller: enabling is an owner decision (OQ-3). REQUIRES 2984/2985. OFF / absent (the seed): nobody is told.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_crew_abort_notify_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3786): layover_crew_abort_notify_enabled has no feature_flags row';
  END IF;
END $post$;
