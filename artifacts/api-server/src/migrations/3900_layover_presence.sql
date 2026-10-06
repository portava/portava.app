-- 3900_layover_presence.sql
-- §4 `layover_presence` and §14's L1 rung ("5 open to food"), behind a flag
-- seeded OFF. census-layover L27, L129, L187.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (lane A band 3900-3929).
-- APPLIED TO NO DATABASE by the lane that wrote it.
--
-- ── WHAT WAS MISSING ────────────────────────────────────────────────────────
-- Layover spec §4 names `layover_presence` (visibility_scope, available_from /
-- available_until, intents_json, max_travel_minutes, precise_location_enabled,
-- expires_at) and §14 puts an "L1 opt-in intent" rung between the aggregate
-- count and named profiles. The tree has ONE boolean, `layover_sessions.
-- share_city_status` (0127), so a traveller can say "I am here" and nothing
-- about what they are open to, until when, or how far they would go.
--
-- ── WHAT THIS CREATES ───────────────────────────────────────────────────────
-- One row per layover session, written only by the service role through
-- services/layover/LayoverPresenceStore.ts:
--
--   intents            a CLOSED vocabulary, CHECKed below — the same keys the
--                      start sheet already offers as vibe chips, minus `rest`
--                      (a traveller resting is not open to anyone). An empty
--                      array is "not open to anything", which is allowed.
--   available_from /   the window the traveller is open in; until is required,
--   available_until    and bounded to the session (enforced by the writer,
--                      which reads the session; a CHECK cannot see it).
--   max_travel_minutes how far they would go; NULL = not stated, never 0.
--   visibility_scope   'aggregate' or 'intent'. Named discovery (L2) stays on
--                      the session's existing share flag; this record cannot
--                      widen it.
--   precise_location_enabled
--                      CHECKed FALSE. §14 L4 (temporary precise location) is
--                      not built and its consent rule is the owner's
--                      (OD-TRIP-6 / OD-MAP-5 govern Bluetooth/proximity, not
--                      this). The column exists so the spec's shape is the
--                      table's shape; lifting the CHECK is L4's migration.
--   expires_at         a FILTER, as in 2984 and 2992: every read is bounded by
--                      expires_at > now(). Not a retention promise.
--
-- NO COORDINATE, by construction: the postcondition refuses any lat/lng/
-- location/geom column, the same rule 2992 states for every layover table.
--
-- ── GRANTS ──────────────────────────────────────────────────────────────────
-- RLS on, NO policies, REVOKE ALL from anon and authenticated: service role
-- only, exactly 2992's posture. A presence record a client could write would
-- let anyone claim intents for any session.
--
-- ── THE FLAG ────────────────────────────────────────────────────────────────
-- `layover_presence_intents_enabled`, seeded FALSE. OFF / absent / unreadable:
-- nothing reads or writes this table and the routes say the capability is off.
-- PREREQUISITE for turning it ON: this file applied. Activation is an owner
-- decision.
--
-- DEPENDS ON: 0127 (layover_sessions). Independent of 2700/2992.
-- Rollback: db/rollback/2026-10-05-3900-layover-presence-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.layover_sessions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3900): public.layover_sessions does not exist (0127).';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3900): public.feature_flags does not exist.';
  END IF;
END
$pre$;

CREATE TABLE IF NOT EXISTS public.layover_presence (
  session_id               UUID        PRIMARY KEY REFERENCES public.layover_sessions(id) ON DELETE CASCADE,
  user_id                  UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  visibility_scope         TEXT        NOT NULL DEFAULT 'intent'
                             CHECK (visibility_scope IN ('aggregate', 'intent')),
  intents                  TEXT[]      NOT NULL DEFAULT '{}'
                             CHECK (intents <@ ARRAY['food', 'nightlife', 'shopping', 'culture', 'meetups']::TEXT[]),
  available_from           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  available_until          TIMESTAMPTZ NOT NULL,
  max_travel_minutes       INTEGER     CHECK (max_travel_minutes IS NULL OR max_travel_minutes BETWEEN 5 AND 240),
  precise_location_enabled BOOLEAN     NOT NULL DEFAULT FALSE CHECK (precise_location_enabled = FALSE),
  expires_at               TIMESTAMPTZ NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT layover_presence_window_ordered CHECK (available_until > available_from),
  CONSTRAINT layover_presence_expiry_covers_window CHECK (expires_at >= available_until)
);

CREATE INDEX IF NOT EXISTS layover_presence_expiry_idx ON public.layover_presence (expires_at);
CREATE INDEX IF NOT EXISTS layover_presence_user_idx ON public.layover_presence (user_id);

ALTER TABLE public.layover_presence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.layover_presence FROM PUBLIC;
REVOKE ALL ON public.layover_presence FROM anon;
REVOKE ALL ON public.layover_presence FROM authenticated;

COMMENT ON TABLE public.layover_presence IS
  'Layover spec §4 layover_presence / §14 L1 opt-in intent (census-layover L27, L129, L187). One row per session, service-role writes only, no coordinate, precise_location_enabled CHECKed FALSE until §14 L4 exists. Read only behind layover_presence_intents_enabled.';

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'layover_presence_intents_enabled',
    false,
    'Layover presence intents (census-layover L27/L129/L187). ON: a traveller sharing their city may say what they are open to (food, nightlife, shopping, culture, meetups) until a time, and travellers sharing in the same city see AGGREGATE counts per intent ("5 open to food") — never who. REQUIRES 3900 applied. OFF / absent (the seed): layover_presence is not read or written.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

DO $post$
DECLARE
  coord_cols TEXT;
  rls BOOLEAN;
  client_privs INT;
  flag_on INT;
  policies INT;
BEGIN
  IF to_regclass('public.layover_presence') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3900): layover_presence was not created';
  END IF;

  SELECT string_agg(column_name, ', ') INTO coord_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'layover_presence'
     AND (column_name ~* '(^|_)(lat|lng|lon|latitude|longitude|location|geom|geog|point)($|_)'
          AND column_name <> 'precise_location_enabled');
  IF coord_cols IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3900): coordinate column(s) on layover_presence: %', coord_cols;
  END IF;

  SELECT relrowsecurity INTO rls FROM pg_class WHERE oid = 'public.layover_presence'::regclass;
  IF NOT rls THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3900): RLS is not enabled on layover_presence';
  END IF;

  SELECT count(*) INTO policies FROM pg_policies WHERE schemaname = 'public' AND tablename = 'layover_presence';
  IF policies <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3900): layover_presence carries % polic(ies); service role only means none', policies;
  END IF;

  SELECT count(*) INTO client_privs FROM information_schema.table_privileges
   WHERE table_schema = 'public' AND table_name = 'layover_presence' AND grantee IN ('anon', 'authenticated');
  IF client_privs <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3900): anon/authenticated hold % privilege(s) on layover_presence', client_privs;
  END IF;

  SELECT count(*) INTO flag_on FROM public.feature_flags WHERE flag = 'layover_presence_intents_enabled' AND enabled = TRUE;
  IF flag_on <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3900): layover_presence_intents_enabled is ON — activation is an owner decision and it must ship OFF';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_presence_intents_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3900): layover_presence_intents_enabled was not seeded';
  END IF;
END
$post$;
