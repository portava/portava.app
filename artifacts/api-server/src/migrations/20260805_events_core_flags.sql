-- 20260805_events_core_flags.sql
--
-- Seeds the four core events feature flags that are consumed by routes/events.ts
-- but were never seeded in any prior migration.
--
-- Without these rows the flags default to FALSE (isFlagEnabled returns false on
-- a missing row), which permanently silences event creation and chat even when
-- the admin wants them on.  Seeding them OFF keeps the current behaviour
-- unchanged; admins can enable each flag independently via the admin panel.
--
-- Flag   What it gates                                   Default
-- ─────────────────────────────────────────────────────────────
-- events_enabled            POST /api/events (create), publish-draft   FALSE
-- events_chat_enabled       Event chat endpoints                        FALSE
-- events_trust_gates_enabled Trust-score gating on join/RSVP           FALSE
-- events_waitlist_enabled   Waitlist join / bump flow                   FALSE
--
-- Idempotent: ON CONFLICT (flag) DO NOTHING means re-running is safe.

INSERT INTO feature_flags (flag, enabled, description)
VALUES
  ('events_enabled',              FALSE, 'Master gate: event creation and draft publishing'),
  ('events_chat_enabled',         FALSE, 'Event chat threads (messages within an event)'),
  ('events_trust_gates_enabled',  FALSE, 'Trust-score gating on event RSVP / join'),
  ('events_waitlist_enabled',     FALSE, 'Waitlist join and bump flow for full events')
ON CONFLICT (flag) DO NOTHING;
