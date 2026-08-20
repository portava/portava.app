-- 2100_canonical_events.sql
-- The canonical event ingestion spine. Append-only by construction.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION
-- ========================================
-- This file carries a NEW 4-digit prefix in the 2100-2999 band (see
-- src/scripts/migrationPrefixRules.ts): a canonical forward migration authored
-- after the 2026-08-19 baseline cutover. It is applied by the OWNER in the
-- target environment, not by CI. Until it is applied, `audit:schema`
-- (auditMigrationsVsLive.ts) will report public.canonical_events and its
-- policies/triggers as MISSING-FROM-LIVE. That is expected and is not a
-- finding — the objects exist in this migration and will exist in the catalog
-- once the owner applies it.
--
-- WHAT THIS TABLE IS
-- ==================
-- One row per observed interaction event, written by the backend service only.
-- `verb` is the interaction kind; the (actor, subject) pair is who did it and
-- to what; and a five-column envelope — source_count, freshness_seconds,
-- confidence, privacy_eligible, expires_at — carries the provenance/quality
-- metadata every downstream reader needs to decide whether an event may be
-- shown, aggregated, or must be dropped. `payload` holds free-form,
-- allow-listed context (see src/lib/canonicalEvents.ts) and never coordinates.
--
-- APPEND-ONLY BY CONSTRUCTION — MIRRORS 2092/2093 EXACTLY
-- ======================================================
-- Same three mechanisms discovery_shadow_serves rests on, for the same reasons:
--
--   1. GRANTS narrow service_role to exactly INSERT + SELECT. On Supabase the
--      public schema's ALTER DEFAULT PRIVILEGES grants ALL to service_role at
--      CREATE TABLE time, so the revoke MUST come first and be unconditional —
--      a bare GRANT establishes no limit (this is the 2092 defect 2093 repaired).
--   2. RLS enabled + deny-by-default. Unlike discovery_shadow_serves this table
--      DOES have a client surface: an own-row SELECT for authenticated users
--      (actor_id = auth.uid()). anon holds nothing.
--   3. Triggers that RAISE on any mutation, so an UPDATE/DELETE/TRUNCATE fails
--      at the point of the statement regardless of who issues it.
--
-- DIFFERENCE FROM discovery_shadow_serves: DELETE IS BLOCKED HERE
-- ==============================================================
-- discovery_shadow_serves deliberately leaves DELETE reachable via an
-- auth.users ON DELETE CASCADE, because privacy/account-deletion outranks
-- absolute append-only there. This table takes NO such foreign key: `actor_id`
-- is a bare uuid, not a REFERENCES auth.users(id). There is therefore no
-- cascade that a DELETE trigger could hold hostage, and privacy is handled
-- through `privacy_eligible` and `expires_at` (expiry), not row deletion. So
-- the append-only guarantee here is absolute over UPDATE, DELETE and TRUNCATE —
-- the trigger blocks all three.
--
-- WHAT THIS MIGRATION DOES NOT DO
-- ===============================
-- It enables nothing. Nothing writes a row here until backend code calls
-- recordEvent()/recordEvents() (src/lib/canonicalEvents.ts), which this
-- migration does not wire into any route. Applying it creates an empty table.

CREATE TABLE IF NOT EXISTS canonical_events (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The interaction kind. Constrained to the nine canonical verbs; anything
  -- else is rejected at write time by both this CHECK and the projection in
  -- src/lib/canonicalEvents.ts.
  verb              text        NOT NULL CHECK (verb IN (
                      'impression','open','save','join','direction',
                      'arrival','completion','rejection','satisfaction')),

  -- Who and what. actor_id is a bare uuid on purpose (no auth.users FK) — see
  -- the header: there is no account-deletion cascade into this table.
  actor_id          uuid,
  subject_kind      text,
  subject_id        text,
  occurred_at       timestamptz NOT NULL DEFAULT now(),

  -- ── The five-column provenance/quality envelope ────────────────────────────
  source_count      integer,
  freshness_seconds integer,
  confidence        numeric,
  privacy_eligible  boolean,
  expires_at        timestamptz,

  -- Free-form, allow-listed context. Never coordinates: the writer strips
  -- raw-GPS keys and projects to an allow-list before insert.
  payload           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Own-row reads start from actor_id; the chronology from occurred_at.
CREATE INDEX IF NOT EXISTS canonical_events_actor_occurred_at
  ON canonical_events (actor_id, occurred_at DESC);

-- Verb slicing over time — the natural unit of every aggregate read.
CREATE INDEX IF NOT EXISTS canonical_events_verb_occurred_at
  ON canonical_events (verb, occurred_at DESC);

-- Retention/expiry sweeps read by expires_at.
CREATE INDEX IF NOT EXISTS canonical_events_expires_at
  ON canonical_events (expires_at);

-- ── Row-level security ────────────────────────────────────────────────────────

ALTER TABLE canonical_events ENABLE ROW LEVEL SECURITY;

-- No policy for anon. RLS denies by default; anon has no own-row to read.

CREATE POLICY "service_role_insert_canonical_events"
  ON canonical_events
  FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY "authenticated_read_own_canonical_events"
  ON canonical_events
  FOR SELECT
  TO authenticated
  USING (actor_id = auth.uid());

-- ── Privileges — revoke from service_role FIRST, then re-grant (2093 lesson) ───

REVOKE ALL ON canonical_events FROM service_role;
GRANT INSERT, SELECT ON canonical_events TO service_role;

REVOKE ALL ON canonical_events FROM PUBLIC;
REVOKE ALL ON canonical_events FROM anon;
REVOKE ALL ON canonical_events FROM authenticated;
-- authenticated may SELECT, but RLS narrows every read to the caller's own rows.
GRANT SELECT ON canonical_events TO authenticated;

-- ── Append-only enforcement — trigger fn copied from 2092 ─────────────────────
-- One function reused by every trigger; %/TG_OP names whichever operation
-- (UPDATE/DELETE/TRUNCATE) was attempted.

CREATE OR REPLACE FUNCTION canonical_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'canonical_events is an append-only ingestion spine: % is not permitted', TG_OP;
END;
$$;

-- Row level: covers UPDATE and DELETE of matched rows.
DROP TRIGGER IF EXISTS canonical_events_no_mutate ON canonical_events;
CREATE TRIGGER canonical_events_no_mutate
  BEFORE UPDATE OR DELETE ON canonical_events
  FOR EACH ROW
  EXECUTE FUNCTION canonical_events_append_only();

-- Statement level: not redundant — a FOR EACH ROW trigger does not fire for
-- `UPDATE/DELETE ... WHERE false`, so this makes the property verifiable with a
-- statement that touches nothing:
--   UPDATE canonical_events SET verb = 'open' WHERE false;
--   -- expect: ERROR ... is an append-only ingestion spine
DROP TRIGGER IF EXISTS canonical_events_no_mutate_stmt ON canonical_events;
CREATE TRIGGER canonical_events_no_mutate_stmt
  BEFORE UPDATE OR DELETE ON canonical_events
  FOR EACH STATEMENT
  EXECUTE FUNCTION canonical_events_append_only();

-- TRUNCATE fires none of the above and produces no DELETE; it can only be a
-- statement-level trigger.
DROP TRIGGER IF EXISTS canonical_events_no_truncate ON canonical_events;
CREATE TRIGGER canonical_events_no_truncate
  BEFORE TRUNCATE ON canonical_events
  FOR EACH STATEMENT
  EXECUTE FUNCTION canonical_events_append_only();

COMMENT ON TABLE canonical_events IS
  'Canonical event ingestion spine: one row per observed interaction (verb + actor/subject + a five-column provenance envelope). Append-only by construction; UPDATE/DELETE/TRUNCATE all blocked by trigger. service_role: INSERT+SELECT only; authenticated: own-row SELECT (actor_id = auth.uid()); anon: nothing.';
