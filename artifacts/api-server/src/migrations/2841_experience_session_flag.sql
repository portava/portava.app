-- 2841_experience_session_flag.sql
-- Seeds `experience_session_enabled` FALSE — the capability gate for Sensing
-- §5.4's ExperienceSession bridge (routes/experienceSessions.ts, engine
-- lib/experienceSession.ts, spine lib/experienceSessionStore.ts).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Sensing lane 2841.
--
-- NO TABLE, ON PURPOSE. §19 heads its contract list "Do Not Blindly
-- Materialize" and requires existing tables and services to be mapped first.
-- They were: migration 2130 already declined `intel_outcomes` "in favour of
-- canonical_events", and lib/intelOutcomes.ts is that ruling in code. So an
-- ExperienceSession is TWO ROWS on the existing canonical_events spine — an
-- opening `direction` event and the outcome's own existing verb — and its
-- state is the fold over them. This file therefore adds no table, no column,
-- no verb and no index: the only platform change the bridge needed is one new
-- allow-listed payload key (`experience_session`) in lib/canonicalEvents.ts,
-- which is application code, not schema.
--
-- WHAT THE FLAG GATES. Three routes: read the viewer's OPEN session, open one
-- against an opportunity, close one with an outcome. Every read and write is
-- keyed on the caller's own id, looks back at most one session lifetime (12 h),
-- and stores no coordinate — the spine's own sanitiser strips raw GPS at every
-- depth even if one were added.
--
-- Seeded FALSE. Read fail-closed by lib/featureFlags.isFlagEnabled: absent,
-- false or unreadable all mean the routes answer feature_disabled and neither
-- read nor write. Enabling is an owner decision — it opens a surface that
-- WRITES canonical events for a person — and the postcondition below refuses to
-- commit this file if the row reads TRUE.
--
-- Additive: one INSERT ... ON CONFLICT DO NOTHING. No DDL, no other row. It
-- does NOT self-register in schema_migration_ledger (the apply tooling's job).
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags (0037) does not exist.';
  END IF;
  IF to_regclass('public.canonical_events') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.canonical_events (2100) does not exist — the bridge has no spine to ride.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('experience_session_enabled', false,
   'Sensing §5.4: the ExperienceSession bridge (opportunity → action → session → outcome → calibration) over canonical_events, with NO table of its own. GET /api/intel/experience-sessions/open, POST /api/intel/experience-sessions, POST /api/intel/experience-sessions/:id/close. One open session per viewer, a window of at most 12 hours, a close after the window refused, closing terminal, no coordinate and no history read. FALSE / absent / unreadable (the seed): the routes answer feature_disabled and neither read nor write. Enabling is an owner decision.')
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE v_enabled boolean;
BEGIN
  SELECT enabled INTO v_enabled FROM public.feature_flags WHERE flag = 'experience_session_enabled';
  IF v_enabled IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: experience_session_enabled was not seeded.';
  END IF;
  IF v_enabled IS TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: experience_session_enabled reads TRUE on this database. This file seeds it FALSE and never flips it; a TRUE row here was set by hand, and this migration refuses to certify a write surface an owner has not enabled.';
  END IF;
END $$;

COMMIT;
