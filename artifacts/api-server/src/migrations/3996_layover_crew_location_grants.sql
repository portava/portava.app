-- 3996_layover_crew_location_grants.sql
-- §14 L4 "temporary location — explicit, scoped, auto-expiring" for a layover
-- crew, behind a flag seeded OFF. census-layover L132, L158, L166, L203, L124,
-- L277 (server half).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; wave 4 assigned
-- 3996 to the Layover crew/location lane). APPLIED TO NO DATABASE by the lane
-- that wrote it.
--
-- ── WHAT WAS MISSING ────────────────────────────────────────────────────────
-- 2984 created layover_crews / layover_crew_members and asserted in a
-- postcondition that NEITHER carries a coordinate: "a place to put a position
-- must not exist before the thing that decides whether it may be shown". The
-- deciding thing exists (services/airport/LayoverCrewService.ts —
-- evaluateCrewLocationShare / locationPrecisionFor — and
-- services/layover/LayoverCrewLocation.ts). There was no grant store. This is it,
-- in its own tables, so 2984's tables stay coordinate-free.
--
-- ── WHAT THIS CREATES ───────────────────────────────────────────────────────
-- layover_crew_location_controls   (crew_id, user_id) — the SEPARATE precise-
--   sharing control (spec §17.1 "Precise crew sharing: separate explicit
--   control, off by default"; census L166). One row per crew membership,
--   precise_sharing_enabled DEFAULT FALSE; no row = off. Keyed to the
--   membership, so leaving a crew forgets it and a new crew starts off.
--
-- layover_crew_location_grants     (crew_id, user_id) — ONE current share per
--   member, upserted in place (Locate My Friends' design, 2219): the table holds
--   where a member said they are NOW and has nowhere to put where they were.
--   The share is Telegraph's scoped share (§12 location_shares): precision
--   area|venue|exact, purpose presence_in_context|live_session_sharing paired
--   with precision exactly as Telegraph's scope sheet pairs it, an expiry that
--   is NOT NULL with NO DEFAULT and is CHECK-bounded to 4 hours
--   (MAX_LOCATION_SHARE_HOURS) after granted_at. A coordinate may exist only at
--   venue/exact; at area the CHECK refuses one.
--
-- ── "REQUIRE MEMBERSHIP AND EXPLICIT PERMISSION" (L203), AS SCHEMA ──────────
--   * Both tables FK (crew_id, user_id) → layover_crew_members ON DELETE
--     CASCADE: a location row cannot exist without a membership row.
--   * BEFORE INSERT/UPDATE guard on grants: the membership must be LIVE
--     (left_at IS NULL) and on the same session, the crew must be live (not
--     disbanded, not expired), the share may not outlive the crew, and an EXACT
--     share needs the separate control ON.
--   * The grant row IS the explicit permission: there is no default expiry, no
--     default label, and nothing writes one but the owner's own request.
--
-- ── EXPIRY (L158: "session scoped; expire automatically") ───────────────────
-- Every read evaluates expiry itself (read-time predicate), so nothing depends
-- on a sweep for privacy. Rows are also DELETED, not merely hidden:
--   * a member leaving (layover_crew_members.left_at set) deletes their grant
--     and their control — trigger below;
--   * a crew disbanding deletes every grant in it — trigger below;
--   * the crew-expiry sweep (lib/layoverCrewExpiryScheduler, no flag) deletes
--     the crew, which cascades through the membership to both tables;
--   * the precise control going OFF deletes an exact grant — trigger below;
--   * the route deletes ended/expired rows it reads (purge-on-touch), and the
--     owner's DELETE removes the row outright.
--
-- ── GRANTS ──────────────────────────────────────────────────────────────────
-- RLS on, REVOKE ALL from PUBLIC/anon/authenticated, explicit service_role
-- policy and grants: service role only, the 2984 / 3900 posture. Who may see a
-- crewmate's share is the route's answer (membership, blocks, preferences,
-- liveness), never a client's direct read.
--
-- ── AUDIT VOCABULARY ────────────────────────────────────────────────────────
-- layover_events gains 'crew_location_shared' and 'crew_location_stopped' by the
-- 2985 technique (the CHECK is rebuilt as the union of what is there plus the
-- new values, so this composes with any other lane's widening). The audit rows
-- carry precision and times only — never a label or a coordinate.
--
-- ── THE FLAG ────────────────────────────────────────────────────────────────
-- `layover_crew_location_enabled`, seeded FALSE. OFF / absent / unreadable:
-- nothing reads or writes these tables; GET answers `available: false`; the
-- owner's DELETE (stop sharing) is never gated. PREREQUISITE for ON: this file
-- applied. Activation is an owner decision.
--
-- DEPENDS ON: 0127 (layover_sessions, layover_events), 2984 (crew tables),
-- 2985 (crew event vocabulary). Independent of 2700 / 2992 / 3900.
-- DELETION FATE: both tables hang off layover_crew_members and
-- layover_sessions ON DELETE CASCADE; account deletion's
-- delete_layover_crew_memberships / delete_layover_sessions steps take them.
-- Rollback: db/rollback/2026-10-17-3996-layover-crew-location-grants-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.layover_sessions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3996): public.layover_sessions does not exist (0127).';
  END IF;
  IF to_regclass('public.layover_crews') IS NULL OR to_regclass('public.layover_crew_members') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3996): the crew tables do not exist (2984).';
  END IF;
  IF to_regclass('public.layover_events') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3996): public.layover_events does not exist (0127).';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3996): public.feature_flags does not exist.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.layover_crew_members'::regclass AND contype = 'p'
       AND pg_get_constraintdef(oid) = 'PRIMARY KEY (crew_id, user_id)'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3996): layover_crew_members must carry PRIMARY KEY (crew_id, user_id) (2984) — both new tables reference it.';
  END IF;
END
$pre$;

-- ── L166: the separate precise-sharing control ──────────────────────────────

CREATE TABLE IF NOT EXISTS public.layover_crew_location_controls (
  crew_id                  UUID        NOT NULL,
  user_id                  UUID        NOT NULL,
  precise_sharing_enabled  BOOLEAN     NOT NULL DEFAULT FALSE,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (crew_id, user_id),
  CONSTRAINT layover_crew_location_controls_membership_fk
    FOREIGN KEY (crew_id, user_id) REFERENCES public.layover_crew_members (crew_id, user_id) ON DELETE CASCADE
);

-- ── L132 / L158 / L203: the grant ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.layover_crew_location_grants (
  crew_id     UUID             NOT NULL,
  user_id     UUID             NOT NULL,
  session_id  UUID             NOT NULL REFERENCES public.layover_sessions (id) ON DELETE CASCADE,
  purpose     TEXT             NOT NULL,
  precision   TEXT             NOT NULL,
  label       TEXT             NOT NULL,
  lat         DOUBLE PRECISION,
  lng         DOUBLE PRECISION,
  granted_at  TIMESTAMPTZ      NOT NULL,
  -- NOT NULL and NO DEFAULT: a writer that forgets the end gets an error, not a
  -- share that lasts forever.
  expires_at  TIMESTAMPTZ      NOT NULL,
  PRIMARY KEY (crew_id, user_id),
  CONSTRAINT layover_crew_location_grants_membership_fk
    FOREIGN KEY (crew_id, user_id) REFERENCES public.layover_crew_members (crew_id, user_id) ON DELETE CASCADE,
  CONSTRAINT layover_crew_location_grants_precision_check
    CHECK (precision IN ('area', 'venue', 'exact')),
  CONSTRAINT layover_crew_location_grants_purpose_check
    CHECK (purpose IN ('presence_in_context', 'live_session_sharing')),
  CONSTRAINT layover_crew_location_grants_purpose_matches_precision
    CHECK ((precision = 'exact') = (purpose = 'live_session_sharing')),
  CONSTRAINT layover_crew_location_grants_label_check
    CHECK (char_length(label) BETWEEN 1 AND 200),
  CONSTRAINT layover_crew_location_grants_bounded_window
    CHECK (expires_at > granted_at AND expires_at <= granted_at + interval '4 hours'),
  CONSTRAINT layover_crew_location_grants_coordinates_paired
    CHECK ((lat IS NULL) = (lng IS NULL)),
  CONSTRAINT layover_crew_location_grants_no_coordinate_at_area
    CHECK (lat IS NULL OR (precision IN ('venue', 'exact') AND lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180))
);

CREATE INDEX IF NOT EXISTS layover_crew_location_grants_expiry_idx
  ON public.layover_crew_location_grants (expires_at);
CREATE INDEX IF NOT EXISTS layover_crew_location_grants_session_idx
  ON public.layover_crew_location_grants (session_id);

COMMENT ON TABLE public.layover_crew_location_controls IS
  'Layover spec §17.1 "Precise crew sharing: separate explicit control, off by default" (census-layover L166). One row per crew membership; no row = off. Leaving the crew deletes it. Service role only. Read only behind layover_crew_location_enabled.';
COMMENT ON TABLE public.layover_crew_location_grants IS
  'Layover spec §14 L4 temporary location (census-layover L132/L158/L203/L124/L277). ONE current share per crew member, Telegraph''s scoped share shape (precision area|venue|exact, purpose paired, expiry NOT NULL and <= 4 h). A coordinate only at venue (a 150 m cell centre) or exact (needs the precise control). Requires a live membership (FK + guard trigger). Deleted when the member leaves, the crew disbands or expires, or the precise control turns off. Service role only; read only behind layover_crew_location_enabled.';

-- ── The guard: live membership, live crew, the precise control ──────────────

CREATE OR REPLACE FUNCTION public.layover_crew_location_grant_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  m_session UUID;
  m_left    TIMESTAMPTZ;
  c_status  TEXT;
  c_expires TIMESTAMPTZ;
  precise   BOOLEAN;
BEGIN
  SELECT session_id, left_at INTO m_session, m_left
    FROM public.layover_crew_members
   WHERE crew_id = NEW.crew_id AND user_id = NEW.user_id;
  IF NOT FOUND OR m_left IS NOT NULL THEN
    RAISE EXCEPTION '3996: a crew location share needs a LIVE crew membership (crew %, user %)', NEW.crew_id, NEW.user_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF m_session IS DISTINCT FROM NEW.session_id THEN
    RAISE EXCEPTION '3996: a crew location share must be made from the session the member joined with'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT status, expires_at INTO c_status, c_expires FROM public.layover_crews WHERE id = NEW.crew_id;
  IF NOT FOUND OR c_status = 'disbanded' OR c_expires <= now() THEN
    RAISE EXCEPTION '3996: the crew is not live, so nothing may be shared to it'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.expires_at > c_expires THEN
    RAISE EXCEPTION '3996: a crew location share may not outlive its crew'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.precision = 'exact' THEN
    SELECT precise_sharing_enabled INTO precise
      FROM public.layover_crew_location_controls
     WHERE crew_id = NEW.crew_id AND user_id = NEW.user_id;
    IF precise IS NOT TRUE THEN
      RAISE EXCEPTION '3996: an exact share needs the separate precise-sharing control ON (it is off by default)'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS layover_crew_location_grant_guard ON public.layover_crew_location_grants;
CREATE TRIGGER layover_crew_location_grant_guard
  BEFORE INSERT OR UPDATE ON public.layover_crew_location_grants
  FOR EACH ROW EXECUTE FUNCTION public.layover_crew_location_grant_guard();

-- ── Ending a share: control off, member leaves, crew disbands ───────────────

CREATE OR REPLACE FUNCTION public.layover_crew_location_precise_off()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.layover_crew_location_grants
     WHERE crew_id = OLD.crew_id AND user_id = OLD.user_id AND precision = 'exact';
    RETURN OLD;
  END IF;
  IF NEW.precise_sharing_enabled IS NOT TRUE THEN
    DELETE FROM public.layover_crew_location_grants
     WHERE crew_id = NEW.crew_id AND user_id = NEW.user_id AND precision = 'exact';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS layover_crew_location_precise_off ON public.layover_crew_location_controls;
CREATE TRIGGER layover_crew_location_precise_off
  AFTER INSERT OR UPDATE OF precise_sharing_enabled OR DELETE ON public.layover_crew_location_controls
  FOR EACH ROW EXECUTE FUNCTION public.layover_crew_location_precise_off();

CREATE OR REPLACE FUNCTION public.layover_crew_location_member_left()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF NEW.left_at IS NOT NULL AND OLD.left_at IS NULL THEN
    DELETE FROM public.layover_crew_location_grants WHERE crew_id = NEW.crew_id AND user_id = NEW.user_id;
    DELETE FROM public.layover_crew_location_controls WHERE crew_id = NEW.crew_id AND user_id = NEW.user_id;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS layover_crew_location_member_left ON public.layover_crew_members;
CREATE TRIGGER layover_crew_location_member_left
  AFTER UPDATE OF left_at ON public.layover_crew_members
  FOR EACH ROW EXECUTE FUNCTION public.layover_crew_location_member_left();

CREATE OR REPLACE FUNCTION public.layover_crew_location_crew_disbanded()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF NEW.status = 'disbanded' AND OLD.status IS DISTINCT FROM 'disbanded' THEN
    DELETE FROM public.layover_crew_location_grants WHERE crew_id = NEW.id;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS layover_crew_location_crew_disbanded ON public.layover_crews;
CREATE TRIGGER layover_crew_location_crew_disbanded
  AFTER UPDATE OF status ON public.layover_crews
  FOR EACH ROW EXECUTE FUNCTION public.layover_crew_location_crew_disbanded();

REVOKE ALL ON FUNCTION public.layover_crew_location_grant_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.layover_crew_location_precise_off() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.layover_crew_location_member_left() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.layover_crew_location_crew_disbanded() FROM PUBLIC, anon, authenticated;

-- ── Service role only ───────────────────────────────────────────────────────

ALTER TABLE public.layover_crew_location_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.layover_crew_location_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.layover_crew_location_controls FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.layover_crew_location_grants FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.layover_crew_location_controls TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.layover_crew_location_grants TO service_role;
DROP POLICY IF EXISTS layover_crew_location_controls_service ON public.layover_crew_location_controls;
CREATE POLICY layover_crew_location_controls_service ON public.layover_crew_location_controls
  TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS layover_crew_location_grants_service ON public.layover_crew_location_grants;
CREATE POLICY layover_crew_location_grants_service ON public.layover_crew_location_grants
  TO service_role USING (true) WITH CHECK (true);

-- ── Audit vocabulary (the 2985 technique) ───────────────────────────────────

DO $vocab$
DECLARE
  conname_found TEXT;
  def TEXT;
  vals TEXT;
BEGIN
  SELECT c.conname, pg_get_constraintdef(c.oid)
    INTO conname_found, def
    FROM pg_constraint c
   WHERE c.conrelid = 'public.layover_events'::regclass
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) LIKE '%event_type%'
     AND pg_get_constraintdef(c.oid) LIKE '%session_created%'
   LIMIT 1;
  IF conname_found IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3996): no event_type CHECK containing session_created on public.layover_events (0127/2985). Refusing to leave the column unconstrained.';
  END IF;
  IF def LIKE '%crew_location_shared%' AND def LIKE '%crew_location_stopped%' THEN
    RETURN;
  END IF;
  SELECT string_agg(quote_literal(v), ', ' ORDER BY v)
    INTO vals
    FROM (
      SELECT DISTINCT (regexp_matches(def, '''([a-z_]+)''', 'g'))[1] AS v
      UNION SELECT 'crew_location_shared'
      UNION SELECT 'crew_location_stopped'
    ) s;
  IF vals IS NULL OR length(vals) = 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3996): extracted an EMPTY vocabulary from %', def;
  END IF;
  EXECUTE format('ALTER TABLE public.layover_events DROP CONSTRAINT %I', conname_found);
  EXECUTE format('ALTER TABLE public.layover_events ADD CONSTRAINT layover_events_event_type_check CHECK (event_type IN (%s))', vals);
END
$vocab$;

-- ── The flag, OFF ───────────────────────────────────────────────────────────

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'layover_crew_location_enabled',
    false,
    'Layover crew temporary location (census-layover L132/L158/L166/L203/L124/L277). ON: a crew member may share where they are with their own crew — a label, at area (no coordinate), venue (a 150 m cell) or exact (only with the separate precise-sharing control on) precision, for at most 4 hours and never past boarding or the crew''s end — and crewmates see live shares on the crew card and the layover map, with a proximity bucket when both share a point. REQUIRES 3996 applied. OFF / absent (the seed): nothing is read or written; stopping a share is never gated.'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions (catalog only; re-runnable) ──────────────────────────────

DO $post$
DECLARE
  t TEXT;
  rls BOOLEAN;
  client_privs INT;
  policies INT;
  coord_cols TEXT;
  def TEXT;
  fn TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['layover_crew_location_controls', 'layover_crew_location_grants'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3996): % was not created', t;
    END IF;
    SELECT relrowsecurity INTO rls FROM pg_class WHERE oid = ('public.' || t)::regclass;
    IF NOT rls THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3996): RLS is not enabled on %', t;
    END IF;
    SELECT count(*) INTO client_privs FROM information_schema.table_privileges
     WHERE table_schema = 'public' AND table_name = t AND grantee IN ('anon', 'authenticated', 'PUBLIC');
    IF client_privs <> 0 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3996): anon/authenticated/PUBLIC hold % privilege(s) on %', client_privs, t;
    END IF;
    SELECT count(*) INTO policies FROM pg_policy p
     WHERE p.polrelid = ('public.' || t)::regclass
       AND NOT (p.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'service_role')]::oid[]);
    IF policies <> 0 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3996): % carries % polic(ies) for a role other than service_role', t, policies;
    END IF;
  END LOOP;

  SELECT string_agg(column_name, ', ') INTO coord_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'layover_crew_location_controls'
     AND column_name ~* '(^|_)(lat|lng|lon|latitude|longitude|location|geom|geog|point)($|_)';
  IF coord_cols IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3996): a coordinate column exists on the control table: %', coord_cols;
  END IF;
  SELECT string_agg(column_name, ', ' ORDER BY column_name) INTO coord_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'layover_crew_location_grants'
     AND column_name ~* '(^|_)(lat|lng|lon|latitude|longitude|location|geom|geog|point)($|_)';
  IF coord_cols IS DISTINCT FROM 'lat, lng' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3996): the grant table''s coordinate columns are exactly lat and lng, got %', coord_cols;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'layover_crew_location_grants'
       AND column_name = 'expires_at' AND (is_nullable <> 'NO' OR column_default IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3996): layover_crew_location_grants.expires_at must be NOT NULL with no default';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conrelid = 'public.layover_crew_location_grants'::regclass AND conname = 'layover_crew_location_grants_bounded_window';
  IF def IS NULL OR position('04:00:00' IN def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3996): the 4-hour bound is missing or changed: %', def;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.layover_crew_location_grants'::regclass AND conname = 'layover_crew_location_grants_no_coordinate_at_area') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3996): the no-coordinate-at-area CHECK is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.layover_crew_location_grants'::regclass AND conname = 'layover_crew_location_grants_membership_fk' AND contype = 'f') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3996): the grant is not tied to a membership';
  END IF;

  FOREACH fn IN ARRAY ARRAY['layover_crew_location_grant_guard', 'layover_crew_location_precise_off', 'layover_crew_location_member_left', 'layover_crew_location_crew_disbanded'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = fn AND NOT p.prosecdef
         AND p.proconfig IS NOT NULL AND 'search_path=pg_catalog, public' = ANY (p.proconfig)
    ) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3996): % must be SECURITY INVOKER with a pinned search_path', fn;
    END IF;
    IF has_function_privilege('anon', 'public.' || fn || '()', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.' || fn || '()', 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3996): a client role may EXECUTE %', fn;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = fn AND NOT tgisinternal AND tgenabled <> 'D') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3996): trigger % is missing or disabled', fn;
    END IF;
  END LOOP;

  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conrelid = 'public.layover_events'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%event_type%' AND pg_get_constraintdef(oid) LIKE '%session_created%'
   LIMIT 1;
  IF def IS NULL OR position('crew_location_shared' IN def) = 0 OR position('crew_location_stopped' IN def) = 0 OR position('crew_left' IN def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3996): layover_events vocabulary is not the union it should be: %', def;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_crew_location_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3996): layover_crew_location_enabled was not seeded';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_crew_location_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3996): layover_crew_location_enabled is ON — activation is an owner decision and it must ship OFF';
  END IF;
END
$post$;

COMMIT;
