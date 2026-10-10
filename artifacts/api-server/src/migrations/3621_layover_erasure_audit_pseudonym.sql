-- 3621_layover_erasure_audit_pseudonym.sql
--
-- census-layover L163, lead ruling 2026-10-07 under OD-MAP-4.
-- Written by lane R. NOT applied to any database at the time of writing:
-- not to portava-ci (hwokxgbmezheskbzskfr), not to production (ajrurzioarfkagpuxfnb).
--
-- ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
-- Account deletion keeps an anonymised TOMBSTONE profile, so no cascade off
-- profiles ever fires, and AccountDeletionService named no layover table: every
-- layover session, plan stop, recommendation and event a traveller ever produced
-- survived their deletion, keyed to the same uuid (census-layover L163;
-- lib/deletionDispositions.ts filed layover_events and layover_sessions as
-- UNCLASSIFIED_BACKLOG).
--
-- ── THE RULING ───────────────────────────────────────────────────────────────
-- Account deletion ERASES the traveller's layover sessions and everything that
-- hangs off them (stops, recommendations, presence, constraints, time budgets,
-- return plans, checkpoints, outcomes, certified computations, crews created on
-- the session and crew memberships, all ON DELETE CASCADE from the session).
-- `layover_events` is the layover decision ledger, and OD-MAP-4 governs it:
--   "Keep a pseudonymized, access-restricted audit record for up to 12 months,
--    then delete it, unless a specific local legal obligation requires a
--    different period." (docs/ops/owner-decisions-20261004.md, OD-MAP-4)
--
-- ── WHY THE SCHEMA HAS TO CHANGE FOR THAT ────────────────────────────────────
-- 0127 declared layover_events.session_id ... ON DELETE CASCADE and user_id NOT
-- NULL. Deleting the session therefore deletes the event, and the event can
-- never lose the person's uuid. Retention as a PSEUDONYMISED record needs:
--   * user_id and session_id nullable, and the session FK SET NULL, so the
--     record outlives the session it described;
--   * erasure_pseudonym — one random uuid per deleted account, so the audit
--     trail of one departed traveller stays internally consistent without being
--     joinable to anything else (not the tombstone, not any other table);
--   * pseudonymised_at and retain_until — the 12-month ceiling, enforced by a
--     CHECK, swept by lib/layoverAuditRetentionScheduler.ts.
--
-- ── WHAT THE CHECK HOLDS ─────────────────────────────────────────────────────
-- layover_events_identity_or_pseudonym: a row is either NAMED (it has its
-- traveller, no pseudonym and no retain_until) or fully PSEUDONYMISED (no user,
-- no session, a pseudonym, and a retain_until no later than 12 months after
-- pseudonymisation). Nothing in between: a row can never carry a pseudonym next
-- to a user id, and can never be kept past 12 months.
--
-- A named row MAY lose its session (session_id NULL). That is deliberate: a hard
-- delete of a profile fires its two 0127 cascades in constraint order, sessions
-- first, so the session FK's SET NULL reaches the event before the event's own
-- user cascade removes it; refusing that intermediate state would make such a
-- profile undeletable. The ORDER that keeps a departed traveller's events from
-- surviving named — pseudonymise, then delete the sessions — is
-- AccountDeletionService's, and its tests pin it.
--
-- Access: unchanged. 3620 already leaves `authenticated` SELECT only, scoped by
-- the owner policy `user_id = auth.uid()`, which a NULL user_id never matches;
-- anon nothing; the service role is the only reader of a pseudonymised row.
--
-- Rollback: db/rollback/2026-10-07-3621-layover-erasure-audit-pseudonym-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.layover_events') IS NULL OR to_regclass('public.layover_sessions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3621): layover_events or layover_sessions is missing -- apply 0127 first.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'layover_events_session_id_fkey' AND conrelid = 'public.layover_events'::regclass
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3621): layover_events_session_id_fkey is not the constraint 0127 created; this file will not guess which FK to replace.';
  END IF;
END $pre$;

ALTER TABLE public.layover_events
  ADD COLUMN IF NOT EXISTS erasure_pseudonym UUID,
  ADD COLUMN IF NOT EXISTS pseudonymised_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retain_until      TIMESTAMPTZ;

ALTER TABLE public.layover_events ALTER COLUMN user_id    DROP NOT NULL;
ALTER TABLE public.layover_events ALTER COLUMN session_id DROP NOT NULL;

ALTER TABLE public.layover_events DROP CONSTRAINT layover_events_session_id_fkey;
ALTER TABLE public.layover_events
  ADD CONSTRAINT layover_events_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES public.layover_sessions(id) ON DELETE SET NULL;

ALTER TABLE public.layover_events
  ADD CONSTRAINT layover_events_identity_or_pseudonym CHECK (
    (pseudonymised_at IS NULL
       AND user_id IS NOT NULL
       AND erasure_pseudonym IS NULL AND retain_until IS NULL)
    OR
    (pseudonymised_at IS NOT NULL
       AND user_id IS NULL AND session_id IS NULL
       AND erasure_pseudonym IS NOT NULL
       AND retain_until IS NOT NULL
       AND retain_until <= pseudonymised_at + INTERVAL '12 months')
  );

-- The sweep's read: due pseudonymised rows, oldest first.
CREATE INDEX IF NOT EXISTS layover_events_retain_until_idx
  ON public.layover_events (retain_until)
  WHERE pseudonymised_at IS NOT NULL;

DO $post$
DECLARE
  fk_action "char";
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'layover_events'
         AND column_name IN ('erasure_pseudonym', 'pseudonymised_at', 'retain_until')) <> 3 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3621): the three pseudonymisation columns are not all present';
  END IF;
  IF (SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'layover_events' AND column_name = 'user_id') <> 'YES'
     OR (SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'layover_events' AND column_name = 'session_id') <> 'YES' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3621): user_id and session_id must both be nullable';
  END IF;
  SELECT confdeltype INTO fk_action FROM pg_constraint
   WHERE conname = 'layover_events_session_id_fkey' AND conrelid = 'public.layover_events'::regclass;
  IF fk_action IS DISTINCT FROM 'n' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3621): layover_events_session_id_fkey is not ON DELETE SET NULL (confdeltype=%)', fk_action;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'layover_events_identity_or_pseudonym' AND conrelid = 'public.layover_events'::regclass AND contype = 'c'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3621): layover_events_identity_or_pseudonym is absent';
  END IF;
  IF has_table_privilege('authenticated', 'public.layover_events', 'UPDATE')
     OR has_table_privilege('anon', 'public.layover_events', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3621): a client role can write layover_events, or anon can read it -- the audit record would not be access-restricted';
  END IF;
END $post$;

COMMIT;
