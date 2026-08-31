-- 2215_locate_friends_sessions.sql
--
-- Locate My Friends (Map spec §12) — storage + flag.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- WHAT §12 ASKS FOR, AND WHAT THIS SCHEMA REFUSES TO LET HAPPEN
-- =============================================================
--   "Opt-in only. Group-scoped. Temporary and auto-expiring.
--    No public friend tracking."
--
-- and §37 names the two shapes this feature must never take:
--
--   "Do not build a public real-time people tracker."
--   "Do not create permanent exact-location sharing."
--
-- Every one of those is a CONSTRAINT here, not a convention in the route:
--
--   TEMPORARY      `expires_at` is NOT NULL with NO DEFAULT, and a CHECK bounds
--                  it to (started_at, started_at + 12 hours]. There is no value
--                  a writer can supply — not NULL, not 'infinity', not a date in
--                  2099 — that produces an unbounded session. The route rejects
--                  a missing TTL before it gets here; this is the second line,
--                  for any writer that is not the route.
--   GROUP-SCOPED   `group_scope_kind` + `group_scope_id` are NOT NULL and the
--                  kind is a closed CHECK set. There is no scope meaning
--                  "everyone" and no nullable scope meaning "unscoped".
--   OPT-IN ONLY    A membership row cannot exist without `opted_in_at` and
--                  `consent_source`, both NOT NULL. There is no way to add a
--                  member without recording that they consented and how.
--   NO PERMANENT   `locate_friends_positions` is keyed by (session_id, user_id):
--   LOCATION       ONE row per member, upserted in place. The table therefore
--                  holds a CURRENT position and can never accumulate a track.
--                  A movement history is not something this schema forgets to
--                  delete — it is something it has no room to store.
--
-- WHY THE AUDIT TABLE HAS NO COORDINATE
-- =====================================
-- §12's safety story is that someone consented, to a specific group, for a
-- specific window, so every membership and position write must be attributable.
-- The obvious way to do that — an append-only log of position writes — would
-- rebuild the movement history the positions table was carefully shaped to
-- avoid, using the very mechanism meant to prevent it. So `locate_friends_audit`
-- records who wrote, to which session, at what rung and precision, and when. It
-- can answer "was this member opted in when they published at precise?" and
-- cannot answer "where were they at 11pm?".
--
-- NO PUBLIC READ PATH
-- ===================
-- Every table is RLS-enabled with all privileges revoked from PUBLIC, anon and
-- authenticated. Only service_role holds grants, and the API resolves the
-- caller's membership per request before returning anything. There is no view,
-- no RPC and no anon grant that lists sessions or finds members by proximity.
--
-- RETENTION. Sessions and positions both carry a hard expiry; the positions
-- expiry is additionally bounded to §23's 60-minute decay horizon by the route.
-- A sweep may delete expired rows, but nothing DEPENDS on the sweep: the read
-- path evaluates expiry itself on every request, so a sweeper that never runs
-- costs disk, not privacy.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: feature_flags must exist.';
  END IF;
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: profiles must exist.';
  END IF;
END $$;

-- ── Sessions ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.locate_friends_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_scope_kind  text NOT NULL,
  group_scope_id    uuid NOT NULL,
  created_by        uuid NOT NULL,
  started_at        timestamptz NOT NULL DEFAULT now(),
  -- NOT NULL and NO DEFAULT. A writer that forgets the expiry gets an error,
  -- not a session that lasts forever. This is the single most important line
  -- in the file.
  expires_at        timestamptz NOT NULL,
  ended_at          timestamptz,
  ceiling           text NOT NULL DEFAULT 'approximate',
  label             text
);

ALTER TABLE public.locate_friends_sessions
  DROP CONSTRAINT IF EXISTS locate_friends_sessions_scope_kind_check;
ALTER TABLE public.locate_friends_sessions
  ADD CONSTRAINT locate_friends_sessions_scope_kind_check
  CHECK (group_scope_kind IN ('trip', 'circle', 'event', 'plan'));

-- §12 "temporary and auto-expiring", as arithmetic. The upper bound matches
-- MAX_SESSION_MINUTES in lib/locateFriendsSession.ts and MAX_SESSION_MS in the
-- client model; all three must agree or a session valid on one side is invalid
-- on another.
ALTER TABLE public.locate_friends_sessions
  DROP CONSTRAINT IF EXISTS locate_friends_sessions_bounded_window_check;
ALTER TABLE public.locate_friends_sessions
  ADD CONSTRAINT locate_friends_sessions_bounded_window_check
  CHECK (
    expires_at > started_at
    AND expires_at <= started_at + interval '12 hours'
  );

-- The rungs of presence/domain/types.ts PRECISION_LADDER that a group may
-- choose. 'none' is absent: a session at 'none' would be a session that exists
-- only to show nothing, which is a bug wearing a valid state.
ALTER TABLE public.locate_friends_sessions
  DROP CONSTRAINT IF EXISTS locate_friends_sessions_ceiling_check;
ALTER TABLE public.locate_friends_sessions
  ADD CONSTRAINT locate_friends_sessions_ceiling_check
  CHECK (ceiling IN ('presence_only', 'venue', 'zone', 'approximate', 'nearby', 'precise'));

COMMENT ON TABLE public.locate_friends_sessions IS
  'Map spec §12 Locate My Friends. Temporary, group-scoped, opt-in coordination sessions. expires_at is NOT NULL with no default and is CHECK-bounded to 12 hours from started_at, so an unbounded session cannot be inserted by any writer. The API enforces expiry on every READ as well, so a stalled sweep can never keep an expired session serving positions.';

COMMENT ON COLUMN public.locate_friends_sessions.expires_at IS
  '§12 "temporary and auto-expiring". No default on purpose: a writer that omits it errors rather than creating a permanent share.';

COMMENT ON COLUMN public.locate_friends_sessions.ceiling IS
  'The most precise rung this session may EVER serve, on the §52 precision ladder. Combined with the feature ceiling, the rung ceiling and §23 decay by narrowestPrecision — it can only tighten the result, never raise it.';

CREATE INDEX IF NOT EXISTS locate_friends_sessions_scope_idx
  ON public.locate_friends_sessions (group_scope_kind, group_scope_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS locate_friends_sessions_expiry_idx
  ON public.locate_friends_sessions (expires_at);

ALTER TABLE public.locate_friends_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.locate_friends_sessions FROM PUBLIC;
REVOKE ALL ON public.locate_friends_sessions FROM anon;
REVOKE ALL ON public.locate_friends_sessions FROM authenticated;
REVOKE ALL ON public.locate_friends_sessions FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.locate_friends_sessions TO service_role;

-- ── Members ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.locate_friends_members (
  session_id      uuid NOT NULL
                    REFERENCES public.locate_friends_sessions (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL,
  -- §12 "Opt-in only". NOT NULL: there is no membership without a recorded
  -- consent moment, and no code path that can create one.
  opted_in_at     timestamptz NOT NULL DEFAULT now(),
  -- How the opt-in happened, so a membership is attributable to an act rather
  -- than merely to a row. NOT NULL for the same reason.
  consent_source  text NOT NULL,
  -- Set the instant a member leaves. The read path filters on it, so leaving
  -- stops exposure at once rather than at the next sweep.
  left_at         timestamptz,
  PRIMARY KEY (session_id, user_id)
);

ALTER TABLE public.locate_friends_members
  DROP CONSTRAINT IF EXISTS locate_friends_members_consent_source_check;
ALTER TABLE public.locate_friends_members
  ADD CONSTRAINT locate_friends_members_consent_source_check
  CHECK (consent_source IN ('creator', 'invite_accept', 'group_join'));

COMMENT ON TABLE public.locate_friends_members IS
  'Map spec §12 "Opt-in only" and "Group-scoped". opted_in_at and consent_source are NOT NULL, so a membership without a recorded consent act is unrepresentable. left_at is honoured by every read, so leaving stops exposure immediately.';

CREATE INDEX IF NOT EXISTS locate_friends_members_session_idx
  ON public.locate_friends_members (session_id) WHERE left_at IS NULL;
CREATE INDEX IF NOT EXISTS locate_friends_members_user_idx
  ON public.locate_friends_members (user_id) WHERE left_at IS NULL;

ALTER TABLE public.locate_friends_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.locate_friends_members FROM PUBLIC;
REVOKE ALL ON public.locate_friends_members FROM anon;
REVOKE ALL ON public.locate_friends_members FROM authenticated;
REVOKE ALL ON public.locate_friends_members FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.locate_friends_members TO service_role;

-- ── Positions ─────────────────────────────────────────────────────────────────
--
-- ONE ROW PER MEMBER PER SESSION. The primary key is the whole privacy design:
-- an upsert overwrites, so this table holds where each member is NOW and has
-- nowhere to put where they were. There is no append path, no history table and
-- no trigger that copies the old row aside.

CREATE TABLE IF NOT EXISTS public.locate_friends_positions (
  session_id        uuid NOT NULL
                      REFERENCES public.locate_friends_sessions (id) ON DELETE CASCADE,
  user_id           uuid NOT NULL,
  -- §12's six-rung preferred signal sequence.
  rung              text NOT NULL,
  -- The §52 rung this was STORED at, after narrowing. Never what was requested.
  precision         text NOT NULL,
  lat               double precision,
  lng               double precision,
  proximity_bucket  text,
  checkpoint_label  text,
  observed_at       timestamptz NOT NULL,
  written_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  PRIMARY KEY (session_id, user_id)
);

ALTER TABLE public.locate_friends_positions
  DROP CONSTRAINT IF EXISTS locate_friends_positions_rung_check;
ALTER TABLE public.locate_friends_positions
  ADD CONSTRAINT locate_friends_positions_rung_check
  CHECK (rung IN (
    'network_location', 'event_cached_location', 'device_proximity',
    'peer_relay', 'last_known', 'manual_checkpoint'
  ));

ALTER TABLE public.locate_friends_positions
  DROP CONSTRAINT IF EXISTS locate_friends_positions_precision_check;
ALTER TABLE public.locate_friends_positions
  ADD CONSTRAINT locate_friends_positions_precision_check
  CHECK (precision IN (
    'none', 'presence_only', 'venue', 'zone', 'approximate', 'nearby', 'precise'
  ));

-- THE DATABASE-LEVEL PRECISION BACKSTOP.
--
-- A coordinate may be stored ONLY at the 'precise' rung. Every coarser rung is
-- served as a ring derived from a snapped grid cell, so keeping the raw fix
-- "in case the ceiling is raised later" would buy nothing and would mean the
-- ceiling could be raised over data that was collected under a narrower
-- promise. The route drops the coordinate at write time; this constraint means
-- a writer that bypasses the route cannot store one either.
ALTER TABLE public.locate_friends_positions
  DROP CONSTRAINT IF EXISTS locate_friends_positions_coordinate_requires_precise_check;
ALTER TABLE public.locate_friends_positions
  ADD CONSTRAINT locate_friends_positions_coordinate_requires_precise_check
  CHECK (
    (lat IS NULL AND lng IS NULL)
    OR (precision = 'precise' AND lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180)
  );

-- A stored position never outlives §23's decay horizon (60 minutes from the
-- observation). Past that it is 'Expired' and cannot be served at any rung, so
-- keeping it would be retention with no purpose.
ALTER TABLE public.locate_friends_positions
  DROP CONSTRAINT IF EXISTS locate_friends_positions_decay_horizon_check;
ALTER TABLE public.locate_friends_positions
  ADD CONSTRAINT locate_friends_positions_decay_horizon_check
  CHECK (expires_at > observed_at AND expires_at <= observed_at + interval '60 minutes');

COMMENT ON TABLE public.locate_friends_positions IS
  'Map spec §12/§23. ONE row per (session, member), upserted in place — the primary key is what makes a movement history unstorable rather than merely un-queried. A coordinate may exist only at precision = precise; every coarser rung is served as a ring built from a snapped grid cell. Rows expire within §23''s 60-minute decay horizon, and the read path re-applies the decay regardless of whether a sweep has run.';

COMMENT ON COLUMN public.locate_friends_positions.precision IS
  'The rung this row was STORED at: narrowestPrecision(requested, feature ceiling, session ceiling, rung ceiling). Never what the client asked for.';

CREATE INDEX IF NOT EXISTS locate_friends_positions_expiry_idx
  ON public.locate_friends_positions (expires_at);

ALTER TABLE public.locate_friends_positions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.locate_friends_positions FROM PUBLIC;
REVOKE ALL ON public.locate_friends_positions FROM anon;
REVOKE ALL ON public.locate_friends_positions FROM authenticated;
REVOKE ALL ON public.locate_friends_positions FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.locate_friends_positions TO service_role;

-- ── Audit ─────────────────────────────────────────────────────────────────────
--
-- Deliberately coordinate-free. See the header.

CREATE TABLE IF NOT EXISTS public.locate_friends_audit (
  id          bigserial PRIMARY KEY,
  event       text NOT NULL,
  session_id  uuid NOT NULL,
  actor_id    uuid NOT NULL,
  rung        text,
  precision   text,
  at          timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '90 days')
);

ALTER TABLE public.locate_friends_audit
  DROP CONSTRAINT IF EXISTS locate_friends_audit_event_check;
ALTER TABLE public.locate_friends_audit
  ADD CONSTRAINT locate_friends_audit_event_check
  CHECK (event IN (
    'session_started', 'member_joined', 'member_left',
    'position_written', 'session_ended'
  ));

COMMENT ON TABLE public.locate_friends_audit IS
  'Attribution for every membership and position write in a §12 session: who, which session, what rung and precision, when. It carries NO coordinate on purpose — a per-write log that included the position would rebuild the movement history the positions table is shaped to make unstorable.';

CREATE INDEX IF NOT EXISTS locate_friends_audit_session_idx
  ON public.locate_friends_audit (session_id, at DESC);
CREATE INDEX IF NOT EXISTS locate_friends_audit_actor_idx
  ON public.locate_friends_audit (actor_id, at DESC);
CREATE INDEX IF NOT EXISTS locate_friends_audit_expiry_idx
  ON public.locate_friends_audit (expires_at);

ALTER TABLE public.locate_friends_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.locate_friends_audit FROM PUBLIC;
REVOKE ALL ON public.locate_friends_audit FROM anon;
REVOKE ALL ON public.locate_friends_audit FROM authenticated;
REVOKE ALL ON public.locate_friends_audit FROM service_role;
GRANT SELECT, INSERT, DELETE ON public.locate_friends_audit TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.locate_friends_audit_id_seq TO service_role;

-- ── Flag ──────────────────────────────────────────────────────────────────────
-- OFF by default. Reads and writes answer an explicitly-disabled envelope; the
-- LEAVE path is not gated by it, because a capability switch must never be able
-- to strand an opted-in member inside a session they cannot leave.

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('locate_friends_enabled', FALSE,
   'Map spec §12 Locate My Friends: temporary, group-scoped, opt-in location sessions. Capped at 12 hours; positions decay Precise to Approximate to Last known to Expired within 60 minutes and expiry is enforced on every read. No public read path. Leaving is never gated by this flag.')
ON CONFLICT (flag) DO NOTHING;

COMMIT;
