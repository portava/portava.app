-- 2294_event_passport_shares.sql
--
-- Temporary / event Passport (Passport spec §25 "Share Passport options", §31
-- "Explicitly expire … event Passport, temporary sharing", TABLE 31 Phase 8).
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Passport lane 2294.
--
-- WHY A TABLE AT ALL
-- =================
-- The event RELATIONSHIP already exists: `event_rsvps` says who is going to an
-- event and `events.ends_at` says when it stops happening, and the projection
-- layer already resolves the TABLE 5 `event_group` viewer context from a shared
-- event. None of that is duplicated here. What co-attendance CANNOT express is
-- the share itself:
--
--   • a shareable, server-minted handle the owner can put behind a QR;
--   • a bounded TTL that is INDEPENDENT of, and never longer than, the event;
--   • REVOCATION — the owner withdrawing the share while still attending.
--
-- Those three facts have nowhere to live in event_rsvps, so this table stores
-- exactly them and nothing else. It carries no projected passport content: the
-- share is a pointer, and every read re-projects through the ONE assembler.
--
-- THE TWO RULES THIS SCHEMA REFUSES TO LET A WRITER BREAK
-- ======================================================
--   1. BOUNDED TTL (§31). `event_passport_shares_ttl_check` makes a share that
--      outlives its own creation by more than 24 hours UNREPRESENTABLE. A bug
--      that computes a bad horizon, or a writer that bypasses the service,
--      still cannot store an event Passport that never ends. The service
--      additionally clamps expires_at to the event's ends_at; the CHECK is the
--      backstop that does not depend on the service being correct.
--
--   2. UNGUESSABLE HANDLE. `event_passport_shares_token_check` requires at
--      least 32 characters, so a short/sequential token is unrepresentable.
--
-- EXPIRY AND REVOCATION ARE ENFORCED ON READ
-- ==========================================
-- Like every other Passport expiry (§31 "Never render stale Availability as
-- current"), services/passport/EventPassportService.ts re-evaluates revoked_at,
-- expires_at AND the event's own ends_at/state on EVERY resolve. A stalled
-- sweep can never make an expired or revoked event Passport resolve; the sweep
-- would only reclaim disk, never truth.
--
-- OWNER-SCOPED, SERVICE-AUTHORITATIVE
-- ===================================
-- RLS is enabled with a deny-default posture: all privileges are revoked from
-- PUBLIC, anon and authenticated explicitly, and only the owner's own SELECT is
-- granted back. Nobody but service_role may write, so token, expires_at and
-- revoked_at cannot be forged through PostgREST — in particular a viewer cannot
-- read a token belonging to someone else and cannot mint one for another user.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist.';
  END IF;
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.profiles does not exist.';
  END IF;
  IF to_regclass('public.events') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.events must exist — an event Passport is scoped to one.';
  END IF;
  IF to_regclass('public.event_rsvps') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.event_rsvps must exist — attendance is the eligibility source.';
  END IF;
END $$;

-- ── Table ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.event_passport_shares (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The traveler whose Passport is being shared.
  user_id     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- The event the share is scoped to. Deleting the event takes its shares.
  event_id    uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  -- Server-minted opaque handle placed behind the QR / share link. Never a
  -- user id, never a handle: resolving it is a server call, not a decode.
  token       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- §31 bounded TTL. The service clamps this to MIN(event ends_at, now + cap);
  -- the CHECK below is the structural backstop.
  expires_at  timestamptz NOT NULL,
  -- Explicit revocation. NULL = live. Set (never deleted) so a revoked share
  -- can be told apart from one that never existed.
  revoked_at  timestamptz
);

-- One live share per traveler per event. A second create revokes the first
-- (service behaviour) — this index makes two LIVE rows unrepresentable.
CREATE UNIQUE INDEX IF NOT EXISTS event_passport_shares_live_uniq
  ON public.event_passport_shares (user_id, event_id)
  WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS event_passport_shares_token_uniq
  ON public.event_passport_shares (token);

-- Resolve path: token lookup is the unique index above; this one serves the
-- owner's "my shares for this event" read and the expiry sweep.
CREATE INDEX IF NOT EXISTS event_passport_shares_user_expiry_idx
  ON public.event_passport_shares (user_id, expires_at DESC);

-- ── THE §31 BACKSTOP: an event Passport always ends ──────────────────────────
ALTER TABLE public.event_passport_shares
  DROP CONSTRAINT IF EXISTS event_passport_shares_ttl_check;
ALTER TABLE public.event_passport_shares
  ADD CONSTRAINT event_passport_shares_ttl_check
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '24 hours');

-- An unguessable handle, structurally.
ALTER TABLE public.event_passport_shares
  DROP CONSTRAINT IF EXISTS event_passport_shares_token_check;
ALTER TABLE public.event_passport_shares
  ADD CONSTRAINT event_passport_shares_token_check
  CHECK (char_length(token) >= 32);

-- Revocation cannot predate creation.
ALTER TABLE public.event_passport_shares
  DROP CONSTRAINT IF EXISTS event_passport_shares_revoked_check;
ALTER TABLE public.event_passport_shares
  ADD CONSTRAINT event_passport_shares_revoked_check
  CHECK (revoked_at IS NULL OR revoked_at >= created_at);

COMMENT ON TABLE public.event_passport_shares IS
  'Passport spec §25/§31 temporary event Passport (TABLE 31 Phase 8). Stores ONLY the three facts co-attendance cannot express: a server-minted share token, a bounded TTL, and revocation. Carries no projected passport content — every resolve re-runs the ONE projection assembler under the viewer''s ordinary privacy policy, so a scan can never widen what that viewer could already see (§25 "Scanning a QR never bypasses privacy policy"). Expiry and revocation are re-evaluated on EVERY read, alongside the event''s own ends_at/state, so a stalled sweep cannot resolve a dead share. event_passport_shares_ttl_check makes an unbounded event Passport unrepresentable.';

COMMENT ON COLUMN public.event_passport_shares.expires_at IS
  '§31 bounded TTL. The service sets MIN(event ends_at, created_at + cap); the ttl_check CHECK independently forbids anything beyond created_at + 24h. Enforced on read, never trusted to a sweep.';

COMMENT ON COLUMN public.event_passport_shares.revoked_at IS
  'Explicit owner revocation. NULL = live. Set rather than deleted so a revoked share resolves as revoked (not "unknown token"), and so the partial unique index still admits a fresh share for the same event.';

-- ── RLS (deny-default, REVOKE-first) ─────────────────────────────────────────

ALTER TABLE public.event_passport_shares ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.event_passport_shares FROM PUBLIC;
REVOKE ALL ON public.event_passport_shares FROM anon;
REVOKE ALL ON public.event_passport_shares FROM authenticated;
REVOKE ALL ON public.event_passport_shares FROM service_role;

-- The owner may read their OWN shares (to show "sharing until 11 PM · Revoke").
-- No write grant: token / expires_at / revoked_at are service-minted only.
GRANT SELECT ON public.event_passport_shares TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.event_passport_shares TO service_role;

DROP POLICY IF EXISTS event_passport_shares_owner_read ON public.event_passport_shares;
CREATE POLICY event_passport_shares_owner_read ON public.event_passport_shares
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS event_passport_shares_service_all ON public.event_passport_shares;
CREATE POLICY event_passport_shares_service_all ON public.event_passport_shares
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ── Flag (CAPABILITY, seeded OFF) ────────────────────────────────────────────
-- OFF (the seed): the event-share routes answer an explicitly-disabled envelope
-- and mint nothing; no existing surface changes. ON: an attendee of a live event
-- may mint one bounded, revocable event Passport share for that event, which
-- resolves ONLY for another attendee of the same event and ONLY to the narrow
-- `event` consumer-projection variant. Read fail-closed via isFlagEnabled.

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'passport_event_share_enabled',
    false,
    'Passport spec §25/§31 temporary event Passport (Phase 8). OFF (the seed): routes/passport.ts event-share endpoints mint nothing and resolve nothing. ON: an attendee of a live, time-bounded event may mint ONE bounded-TTL, revocable share token for that event (services/passport/EventPassportService.ts). Resolving it requires the viewer to be an attendee of the SAME event, and returns only the narrow `event` consumer-projection variant built from the viewer''s ORDINARY projection — it can never widen what that viewer could already see. Expiry + revocation + the event''s own end are re-checked on every read. Fail-closed (isFlagEnabled).'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions ───────────────────────────────────────────────────────────
DO $$
DECLARE present int; on_count int;
BEGIN
  IF to_regclass('public.event_passport_shares') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: event_passport_shares was not created.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'event_passport_shares_ttl_check'
      AND conrelid = 'public.event_passport_shares'::regclass
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the §31 bounded-TTL CHECK is missing.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'event_passport_shares_live_uniq'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the one-live-share-per-event unique index is missing.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'event_passport_shares'
      AND grantee IN ('anon', 'PUBLIC')
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: anon/PUBLIC still hold a grant on event_passport_shares.';
  END IF;
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'passport_event_share_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: passport_event_share_enabled not seeded (found %)', present;
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'passport_event_share_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: passport_event_share_enabled seeded ON — it must ship OFF';
  END IF;
END $$;

COMMIT;

-- REVERSAL (manual):
--   DROP TABLE IF EXISTS public.event_passport_shares;
--   DELETE FROM public.feature_flags WHERE flag = 'passport_event_share_enabled';
-- Nothing else reads the table, and the flag ships disabled, so the reversal
-- changes no served data.
