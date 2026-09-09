-- 2600_event_start_transition_flag.sql
--
-- Seeds ONE feature flag, FALSE: `event_start_transition_enabled`. It gates
-- lib/eventLifecycle.ts, the scheduler that moves an event from
-- open | full | waitlist to `started` once now() >= starts_at. Events-owned.
--
-- THE DEFECT THIS IS THE FIRST STEP OF FIXING (production, 2026-09-07)
-- ====================================================================
-- events.state is draft | open | full | waitlist | started | completed |
-- cancelled | archived. Three routes gate on `started` (complete, attendance,
-- no-show) and nothing ever wrote it: no route, no sweeper, no function, no
-- trigger (pg_trigger on public.events: none; no public function UPDATEs
-- events; pg_cron not installed). Production: 97 open (96 past starts_at,
-- 1 with NULL starts_at), 0 started, 7 completed — and those 7 were INSERTED
-- as completed by src/scripts/seed-demo-profile.ts, never transitioned;
-- event_activity_log is empty for every event. So POST /events/:id/complete
-- has never succeeded on production and cannot.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2600
-- (Events lifecycle). Additive + idempotent. Safe to re-run.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS CHANGES FOR A USER: NOTHING, UNTIL THE FLAG IS FLIPPED
-- ══════════════════════════════════════════════════════════════════════════════
-- One flag row. FALSE, absent, or unreadable: the scheduler is one
-- feature_flags read a minute and issues no other read and no write — pinned
-- by src/test/eventLifecycle.test.ts. The transition rule itself lives in
-- decideEventStart (pure) so a host-initiated route can share it later.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- FLIPPING IT IS THE OWNER DECISION `EVENT_START_TRANSITION`, NOT A ROLLOUT STEP
-- ══════════════════════════════════════════════════════════════════════════════
-- (a) derived — started once now >= starts_at (what this flag enables);
-- (b) host-initiated — the host presses start; an unstarted event never
--     becomes started and can never be completed.
-- These are different products. This migration pre-commits to neither: it
-- creates the switch for (a) in the OFF position. When ON, on production as
-- measured today, the first pass moves 96 events (3 hosts, 16 going RSVPs) to
-- `started`, after which their hosts CAN complete them (host +5 event_hosted,
-- checked-in attendees +5 event_attended, event_host / event_participant
-- stamps, review-prompt pushes) and CAN mark no-shows (attendee -5
-- event_no_show — an emitter that was unreachable until now).
-- trust_engine_enabled is TRUE on production. The pass does not consult
-- ends_at; whether an event whose window has elapsed should auto-complete is
-- the same decision's second half and is NOT built.
-- docs/architecture/event-lifecycle-started-transition.md has the full record.
--
-- Rollback: db/rollback/2026-09-07-2600-event-start-transition-flag-rollback.sql
-- RUNTIME EFFECT: NONE with the flag absent or false.

BEGIN;

-- ── 0. Preconditions ──────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags (0037) does not exist.';
  END IF;
  IF to_regclass('public.events') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.events does not exist; there is nothing to transition.';
  END IF;
  -- The scheduler writes the literal 'started'. It must be a member of the
  -- enum the column actually uses, or the first enabled pass fails every row.
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'event_state' AND e.enumlabel = 'started'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: enum event_state has no label ''started''.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'events' AND column_name = 'starts_at') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: events.starts_at is absent; the rule has nothing to derive from.';
  END IF;
  -- The pass writes an audit row per transition; the columns it writes must exist.
  IF to_regclass('public.event_activity_log') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.event_activity_log does not exist; transitions would be unauditable.';
  END IF;
END $$;

-- ── 1. Flag, seeded FALSE ─────────────────────────────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('event_start_transition_enabled', false,
   'EVENT_START_TRANSITION owner decision, option (a) DERIVED: lib/eventLifecycle.ts moves an event from open/full/waitlist to started once now() >= starts_at (NULL starts_at never starts; draft/cancelled/archived/completed never move). OFF / absent / unreadable (the seed): the scheduler is one flag read a minute and writes nothing — events.state is never set to started by anything, and POST /events/:id/complete, attendance and no-show stay unreachable, as measured on production 2026-09-07 (97 open, 0 started). ON: the gates open within a minute of starts_at; hosts can complete (trust event_hosted/event_attended, stamps, review pushes) and mark no-shows (trust event_no_show). Does not auto-complete after ends_at. Read fail-closed by isFlagEnabled. Flipping is an owner decision, not a rollout step.')
ON CONFLICT (flag) DO NOTHING;

-- ── 2. Postconditions ─────────────────────────────────────────────────────────
DO $$
DECLARE
  present  integer;
  on_count integer;
  due      integer;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
   WHERE flag = 'event_start_transition_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected exactly one event_start_transition_enabled row, found %', present;
  END IF;

  -- Tell the applier the blast radius of a flip on THIS database, measured
  -- with the scheduler's own predicate, so "ON" is never a surprise.
  SELECT count(*) INTO due FROM public.events
   WHERE state IN ('open', 'full', 'waitlist') AND starts_at IS NOT NULL AND starts_at <= now();
  RAISE NOTICE '2600: event_start_transition_enabled seeded/kept. If flipped ON now, the first pass would move % event(s) to started on this database.', due;

  SELECT count(*) INTO on_count FROM public.feature_flags
   WHERE flag = 'event_start_transition_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE NOTICE '2600: event_start_transition_enabled was already TRUE on this database (re-run); left as found — that is an owner flip, not this seed.';
  END IF;
END $$;

COMMIT;
