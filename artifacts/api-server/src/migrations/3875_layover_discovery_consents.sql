-- 3875_layover_discovery_consents.sql
-- §14 "L2 mutual discovery — profiles visible under policy" (census-layover L130), as a PER-PAIR consent.
-- Owner decision 2026-10-18 (§7): "Implement per-pair mutual-discovery consent. Both parties must explicitly opt in
-- before the corresponding mutual-discovery behavior is enabled. Include consent revocation and authorization tests."
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; LAYOVER 165, lane B2-CREW, range 3872 + 3875-3879).
-- APPLIED TO NO DATABASE by the lane that wrote it.
--
-- ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
-- Reciprocity was one global toggle (`layover_sessions.share_city_status`): turning it on exposed a traveller to,
-- and showed them, everyone sharing in the city at once (census-layover L130 line 623). There was no record of WHO
-- agreed to see WHOM.
--
-- ── WHAT THIS CREATES ───────────────────────────────────────────────────────
-- layover_discovery_consents — one row per (requester session, target session) pair, KEYED ON layover_sessions so a
-- consent lives exactly as long as both layovers (ON DELETE CASCADE, and `expires_at` is bounded by both departures).
--   requested → accepted     the TARGET's explicit opt-in (the requester's is the request itself)
--   requested → declined     the target says no
--   requested → withdrawn    the requester takes it back before an answer
--   accepted  → revoked      EITHER party, at any time; takes effect on the next read (nothing is cached)
-- Terminal states are final; a new request is a new row. At most ONE live (requested|accepted) row per unordered pair
-- of sessions (unique index), so "both orders" cannot produce two consents for one pair.
--
-- ── A CLIENT CANNOT FORGE THE OTHER PARTY'S CONSENT ─────────────────────────
--   * RLS on, REVOKE ALL from PUBLIC/anon/authenticated, service_role policy + grants only: a traveller's PostgREST
--     client can neither read nor write a consent row (the routes are the only door, and they are owner-scoped).
--   * The guard trigger refuses a row whose session does not belong to the user it names (requester_user_id must own
--     requester_session_id, target_user_id must own target_session_id), a session that is not live, an expiry past
--     either departure, any change to who/which-session/when-requested/expiry, and any transition outside the graph
--     above. `ended_by_user_id` is CHECKed to be the party the transition belongs to (declined: the target;
--     withdrawn: the requester; revoked: either), so even the service role cannot record the wrong person's consent.
--   * BLOCKS ALWAYS WIN, here as well as in the route: a block in either direction (public.blocks) refuses the request
--     and refuses the acceptance. A block placed AFTER acceptance is enforced at read time by the route.
--
-- ── THE FLAG ────────────────────────────────────────────────────────────────
-- `layover_mutual_discovery_enabled`, seeded FALSE. OFF / absent / unreadable: nothing reads or writes this table and
-- no L2 profile is served (the route fails closed; it never falls back to the global toggle).
--
-- ── ORDER INDEPENDENCE (a gap number: applied at 3875 on a fresh replay, AFTER 3999 on portava-ci/production) ──
-- DEPENDS ON: 0127 (layover_sessions: id, user_id, status, departure_time), profiles, public.blocks (blocker_id,
-- blocked_id), feature_flags. Nothing numbered above 3875. Measured (grep of src/migrations, 2026-10-18): no file above
-- 3875 names layover_discovery_consents or layover_mutual_discovery_enabled; the files above 3875 that touch
-- layover_sessions (3900 layover_presence, 3996 crew location grants) only add tables with foreign keys to it and alter
-- none of the four columns read here; no file above 3875 alters public.blocks.
-- DELETION FATE: every row hangs off layover_sessions and profiles ON DELETE CASCADE (both parties' sessions and
-- profiles); account deletion's delete_layover_sessions step takes it.
-- Rollback: db/rollback/2026-10-18-3875-layover-discovery-consents-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.layover_sessions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3875): public.layover_sessions does not exist (0127).';
  END IF;
  IF to_regclass('public.profiles') IS NULL OR to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3875): public.profiles and public.feature_flags must exist.';
  END IF;
  IF to_regclass('public.blocks') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3875): public.blocks does not exist; a consent store that cannot see blocks would let a blocked person in.';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'layover_sessions'
         AND column_name IN ('id', 'user_id', 'status', 'departure_time')) <> 4 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3875): layover_sessions lacks one of id, user_id, status, departure_time.';
  END IF;
END
$pre$;

CREATE TABLE IF NOT EXISTS public.layover_discovery_consents (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_session_id  UUID        NOT NULL REFERENCES public.layover_sessions (id) ON DELETE CASCADE,
  target_session_id     UUID        NOT NULL REFERENCES public.layover_sessions (id) ON DELETE CASCADE,
  requester_user_id     UUID        NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  target_user_id        UUID        NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  status                TEXT        NOT NULL DEFAULT 'requested',
  requested_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at          TIMESTAMPTZ,
  ended_at              TIMESTAMPTZ,
  ended_by_user_id      UUID        REFERENCES public.profiles (id) ON DELETE CASCADE,
  -- NOT NULL and NO DEFAULT: the writer bounds it by both layovers (the guard checks it).
  expires_at            TIMESTAMPTZ NOT NULL,
  CONSTRAINT layover_discovery_consents_status_check
    CHECK (status IN ('requested', 'accepted', 'declined', 'withdrawn', 'revoked')),
  CONSTRAINT layover_discovery_consents_two_sessions CHECK (requester_session_id <> target_session_id),
  CONSTRAINT layover_discovery_consents_two_people CHECK (requester_user_id <> target_user_id),
  CONSTRAINT layover_discovery_consents_expiry_after_request CHECK (expires_at > requested_at),
  CONSTRAINT layover_discovery_consents_state_shape CHECK (
       (status = 'requested' AND responded_at IS NULL     AND ended_at IS NULL     AND ended_by_user_id IS NULL)
    OR (status = 'accepted'  AND responded_at IS NOT NULL AND ended_at IS NULL     AND ended_by_user_id IS NULL)
    OR (status = 'declined'  AND responded_at IS NOT NULL AND ended_at IS NOT NULL AND ended_by_user_id = target_user_id)
    OR (status = 'withdrawn' AND responded_at IS NULL     AND ended_at IS NOT NULL AND ended_by_user_id = requester_user_id)
    OR (status = 'revoked'   AND responded_at IS NOT NULL AND ended_at IS NOT NULL
                             AND ended_by_user_id IN (requester_user_id, target_user_id))
  )
);

-- One LIVE consent per unordered pair of sessions: A→B and B→A cannot both be live.
CREATE UNIQUE INDEX IF NOT EXISTS layover_discovery_consents_live_pair_idx
  ON public.layover_discovery_consents (LEAST(requester_session_id, target_session_id), GREATEST(requester_session_id, target_session_id))
  WHERE status IN ('requested', 'accepted');
CREATE INDEX IF NOT EXISTS layover_discovery_consents_target_idx
  ON public.layover_discovery_consents (target_session_id) WHERE status IN ('requested', 'accepted');
CREATE INDEX IF NOT EXISTS layover_discovery_consents_requester_idx
  ON public.layover_discovery_consents (requester_session_id) WHERE status IN ('requested', 'accepted');
CREATE INDEX IF NOT EXISTS layover_discovery_consents_requester_user_idx ON public.layover_discovery_consents (requester_user_id);
CREATE INDEX IF NOT EXISTS layover_discovery_consents_target_user_idx ON public.layover_discovery_consents (target_user_id);
CREATE INDEX IF NOT EXISTS layover_discovery_consents_ended_by_idx ON public.layover_discovery_consents (ended_by_user_id) WHERE ended_by_user_id IS NOT NULL;

COMMENT ON TABLE public.layover_discovery_consents IS
  'Layover spec §14 L2 mutual discovery (census-layover L130): a per-pair consent keyed on both layover sessions. requested -> accepted | declined | withdrawn; accepted -> revoked (either party). Profiles are visible to each other ONLY while accepted, unexpired, both sessions live and no block either way. Sessions must belong to the users named (guard trigger). Service role only; read only behind layover_mutual_discovery_enabled.';

CREATE OR REPLACE FUNCTION public.layover_discovery_consent_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  r_owner  UUID;
  r_status TEXT;
  r_depart TIMESTAMPTZ;
  t_owner  UUID;
  t_status TEXT;
  t_depart TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.requester_session_id IS DISTINCT FROM OLD.requester_session_id OR NEW.target_session_id IS DISTINCT FROM OLD.target_session_id
       OR NEW.requester_user_id IS DISTINCT FROM OLD.requester_user_id OR NEW.target_user_id IS DISTINCT FROM OLD.target_user_id
       OR NEW.requested_at IS DISTINCT FROM OLD.requested_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
      RAISE EXCEPTION '3875: who, which sessions, when requested and the expiry of a consent never change'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
         (OLD.status = 'requested' AND NEW.status IN ('accepted', 'declined', 'withdrawn'))
      OR (OLD.status = 'accepted'  AND NEW.status = 'revoked')
    ) THEN
      RAISE EXCEPTION '3875: % -> % is not a consent transition', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = OLD.status AND (NEW.responded_at IS DISTINCT FROM OLD.responded_at OR NEW.ended_at IS DISTINCT FROM OLD.ended_at
                                    OR NEW.ended_by_user_id IS DISTINCT FROM OLD.ended_by_user_id) THEN
      RAISE EXCEPTION '3875: a consent''s answer is recorded once' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'accepted' AND OLD.status = 'requested' THEN
      IF EXISTS (SELECT 1 FROM public.blocks b
                  WHERE (b.blocker_id = NEW.requester_user_id AND b.blocked_id = NEW.target_user_id)
                     OR (b.blocker_id = NEW.target_user_id AND b.blocked_id = NEW.requester_user_id)) THEN
        RAISE EXCEPTION '3875: a block between the two travellers refuses the acceptance' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.expires_at <= now() THEN
        RAISE EXCEPTION '3875: an expired request cannot be accepted' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status <> 'requested' THEN
    RAISE EXCEPTION '3875: a consent is created as a request' USING ERRCODE = 'check_violation';
  END IF;
  SELECT user_id, status, departure_time INTO r_owner, r_status, r_depart FROM public.layover_sessions WHERE id = NEW.requester_session_id;
  SELECT user_id, status, departure_time INTO t_owner, t_status, t_depart FROM public.layover_sessions WHERE id = NEW.target_session_id;
  IF r_owner IS DISTINCT FROM NEW.requester_user_id OR t_owner IS DISTINCT FROM NEW.target_user_id THEN
    RAISE EXCEPTION '3875: each session must belong to the traveller named for it (no consent may be recorded for someone else''s layover)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF r_status IS NULL OR t_status IS NULL OR r_status NOT IN ('active', 'returning') OR t_status NOT IN ('active', 'returning') THEN
    RAISE EXCEPTION '3875: both layovers must be live' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.expires_at > LEAST(r_depart, t_depart) THEN
    RAISE EXCEPTION '3875: a consent may not outlive either layover (expires % > first departure %)', NEW.expires_at, LEAST(r_depart, t_depart)
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.blocks b
              WHERE (b.blocker_id = NEW.requester_user_id AND b.blocked_id = NEW.target_user_id)
                 OR (b.blocker_id = NEW.target_user_id AND b.blocked_id = NEW.requester_user_id)) THEN
    RAISE EXCEPTION '3875: a block between the two travellers refuses the request' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS layover_discovery_consent_guard ON public.layover_discovery_consents;
CREATE TRIGGER layover_discovery_consent_guard
  BEFORE INSERT OR UPDATE ON public.layover_discovery_consents
  FOR EACH ROW EXECUTE FUNCTION public.layover_discovery_consent_guard();

REVOKE ALL ON FUNCTION public.layover_discovery_consent_guard() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.layover_discovery_consents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.layover_discovery_consents FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.layover_discovery_consents TO service_role;
DROP POLICY IF EXISTS layover_discovery_consents_service ON public.layover_discovery_consents;
CREATE POLICY layover_discovery_consents_service ON public.layover_discovery_consents
  TO service_role USING (true) WITH CHECK (true);

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'layover_mutual_discovery_enabled',
    false,
    'Layover L2 mutual discovery (census-layover L130, spec §14). ON: a traveller may ask another traveller (by handle) to see each other on this layover; profiles become visible to each other only once the other accepts, only while both layovers are live and neither has blocked the other, and either may revoke at once. REQUIRES 3875 applied. OFF / absent (the seed): nothing is read or written and no L2 profile is served.'
  )
ON CONFLICT (flag) DO NOTHING;

DO $post$
DECLARE
  rls BOOLEAN;
  client_privs INT;
  policies INT;
  coord_cols TEXT;
BEGIN
  IF to_regclass('public.layover_discovery_consents') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3875): layover_discovery_consents was not created';
  END IF;
  SELECT relrowsecurity INTO rls FROM pg_class WHERE oid = 'public.layover_discovery_consents'::regclass;
  IF NOT rls THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3875): RLS is not enabled on layover_discovery_consents';
  END IF;
  SELECT count(*) INTO client_privs FROM information_schema.table_privileges
   WHERE table_schema = 'public' AND table_name = 'layover_discovery_consents' AND grantee IN ('anon', 'authenticated', 'PUBLIC');
  IF client_privs <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3875): anon/authenticated/PUBLIC hold % privilege(s) on layover_discovery_consents (a client could forge the other party''s consent)', client_privs;
  END IF;
  SELECT count(*) INTO policies FROM pg_policy p
   WHERE p.polrelid = 'public.layover_discovery_consents'::regclass
     AND NOT (p.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'service_role')]::oid[]);
  IF policies <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3875): layover_discovery_consents carries % polic(ies) for a role other than service_role', policies;
  END IF;
  SELECT string_agg(column_name, ', ') INTO coord_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'layover_discovery_consents'
     AND column_name ~* '(^|_)(lat|lng|lon|latitude|longitude|location|geom|geog|point)($|_)';
  IF coord_cols IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3875): a coordinate column exists: % (L2 discloses a profile, never a position)', coord_cols;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'layover_discovery_consent_guard'
                    AND tgrelid = 'public.layover_discovery_consents'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3875): the guard trigger is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'layover_discovery_consents_live_pair_idx'
                    AND indexdef LIKE '%UNIQUE%') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3875): the one-live-consent-per-pair unique index is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_mutual_discovery_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3875): the flag row layover_mutual_discovery_enabled is missing';
  END IF;
END
$post$;

COMMIT;
