-- 2115_events_family_rls_enable_idempotent.sql
--
-- STATUS: STAGED — NOT APPLIED. reconciliation-staging/, outside canonical.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- BLOCKED ON: Q1 (relation census + RLS flag)
--
-- On today's live production, every statement below is a no-op (`ENABLE ROW
-- LEVEL SECURITY` on a table that already has it enabled is harmless and
-- idempotent). Q1 confirms that is actually true before this file runs,
-- rather than assuming it.
--
-- ROLLBACK: derivable and instant (§8 item 9e).
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS RESOLVES
-- ==================
-- RECONCILIATION-PACKET.md §5.4 RLS_UNDISPOSED Class B and §7 row 2115.
-- `docs/migrations/0065_events.sql` (a frozen, non-canonical root — §2.3
-- root #7, FREEZE) is the ONLY place the `events` family's
-- `ENABLE ROW LEVEL SECURITY` statements exist. Canonical declares policies
-- for members of this family (e.g. `events_public_read`,
-- `events_participant_read`, `events_host_read` at
-- `2033_rls_hardening.sql:266-289`, `event_roles_host_read` at
-- `2033:289`) but never enables RLS on any of them itself. On a
-- canonical-only rebuild, `CREATE POLICY` against a table with RLS not yet
-- enabled is wrapped in canonical's own `DO ... EXCEPTION WHEN
-- undefined_table` pattern elsewhere in this project and swallows failures
-- silently in some call sites — the practical result the packet warns about
-- is the same regardless of the exact mechanism: "the events surface would
-- be wide open with no error raised."
--
-- SCOPE CORRECTION: EIGHT TABLES, NOT SEVEN
-- ============================================
-- §7's own text says "events + 6 sub-tables" (7 total). Direct verification
-- of `docs/migrations/0065_events.sql` finds EIGHT `CREATE TABLE` /
-- `ENABLE ROW LEVEL SECURITY` pairs: `events` (line 33/76), `event_rsvps`
-- (112/124), `event_waitlist` (144/157), `event_roles` (177/188),
-- `event_attendee_states` (206/222), `event_join_requests` (242/257),
-- `event_updates` (277/288), `event_reviews` (303/318). This file covers
-- all eight; the packet's count is corrected here, not silently followed.
--
-- OUT OF SCOPE, FLAGGED, NOT INCLUDED: `event_attendees` (distinct from
-- `event_attendee_states`) is a separate table created and RLS-enabled
-- within canonical itself (`0080_events_extension.sql`, which carries both
-- its own ENABLE and its policies `event_attendees_participant_read` /
-- `event_attendees_service_all`). It does not depend on the frozen 0065
-- file and is not part of this migration's problem — including it here
-- would conflate two unrelated tables that happen to share a naming root.
--
-- INTENDED FINAL STATE
-- =====================
-- All eight tables from 0065_events.sql carry
-- `ENABLE ROW LEVEL SECURITY` declared directly in canonical (via this
-- staged file), independent of the frozen docs/migrations root. On today's
-- production this changes nothing observable; on a clean rebuild from
-- canonical + baseline, it is what makes the events surface hardened
-- instead of silently open.

BEGIN;

-- ── Precondition ─────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'events', 'event_rsvps', 'event_waitlist', 'event_roles',
    'event_attendee_states', 'event_join_requests', 'event_updates', 'event_reviews'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION 'PRECONDITION FAILED: public.% does not exist live. Re-derive the events family from Q1.', t;
    END IF;
  END LOOP;
END $$;

-- ── The change — idempotent, one statement per table ─────────────────────
ALTER TABLE public.events                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_rsvps            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_waitlist         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_roles            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_attendee_states  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_join_requests    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_updates          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_reviews          ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.events IS
  '2115: RLS enable declared directly in canonical, independent of the frozen docs/migrations/0065_events.sql root. Idempotent no-op on current production; closes the clean-rebuild gap where canonical''s own policies (2033_rls_hardening.sql) had no ENABLE to attach to.';

-- ── Postcondition ────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'events', 'event_rsvps', 'event_waitlist', 'event_roles',
    'event_attendee_states', 'event_join_requests', 'event_updates', 'event_reviews'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: public.% does not have RLS enabled after this migration ran.', t;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role no longer has BYPASSRLS.';
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK — instant and complete (§8 item 9e)
-- ═══════════════════════════════════════════════════════════════════════════
-- ALTER TABLE public.events                 DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.event_rsvps            DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.event_waitlist         DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.event_roles            DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.event_attendee_states  DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.event_join_requests    DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.event_updates          DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.event_reviews          DISABLE ROW LEVEL SECURITY;
-- -- Not expected to ever be needed against production, since this file is a
-- -- true no-op there; relevant mainly for a clean-build proof re-run.

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run after apply)
-- ═══════════════════════════════════════════════════════════════════════════
-- SELECT relname, relrowsecurity FROM pg_class
--  WHERE relname IN ('events','event_rsvps','event_waitlist','event_roles',
--    'event_attendee_states','event_join_requests','event_updates','event_reviews');
-- -- expect relrowsecurity = true for all eight.
