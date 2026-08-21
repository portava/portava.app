-- 2110_location_sharing_schema_convergence.sql
--
-- Canonical forward-only reconciliation for the conflicting 0032/0033
-- location migrations. New location migrations belong in
-- artifacts/api-server/src/migrations; the other migration roots are frozen.
--
-- This migration is intentionally rollback-safe:
--   * no table or column is dropped or renamed;
--   * the legacy location_preferences table and legacy location_sessions
--     columns remain available to the previous application version;
--   * session-type acceptance is widened, never narrowed;
--   * preference rows are copied only when the canonical row is absent.
--
-- IMPORTANT: this migration does not create a journey observation table,
-- ingest coordinates, schedule collection, or enable a Journey feature flag.

BEGIN;

-- ── Canonical preference authority ──────────────────────────────────────────
-- user_location_preferences owns sharing mode and precision. The similarly
-- named location_preferences table used an incompatible "who can see this"
-- vocabulary in pulse_visibility/discovery_visibility and is retained only as
-- a rollback source.

CREATE TABLE IF NOT EXISTS public.user_location_preferences (
  user_id                 uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  location_mode           text        NOT NULL DEFAULT 'city_only',
  sharing_paused          boolean     NOT NULL DEFAULT false,
  pulse_visibility        text,
  discovery_visibility    text,
  safe_return_enabled     boolean     NOT NULL DEFAULT true,
  trusted_circle_share    boolean     NOT NULL DEFAULT false,
  hotel_blur_enabled      boolean     NOT NULL DEFAULT true,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  created_at              timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_location_preferences
  ADD COLUMN IF NOT EXISTS location_mode text NOT NULL DEFAULT 'city_only',
  ADD COLUMN IF NOT EXISTS sharing_paused boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pulse_visibility text,
  ADD COLUMN IF NOT EXISTS discovery_visibility text,
  ADD COLUMN IF NOT EXISTS safe_return_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS trusted_circle_share boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hotel_blur_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.user_location_preferences
  ALTER COLUMN location_mode SET DEFAULT 'city_only',
  ALTER COLUMN sharing_paused SET DEFAULT false,
  ALTER COLUMN pulse_visibility DROP NOT NULL,
  ALTER COLUMN discovery_visibility DROP NOT NULL,
  ALTER COLUMN safe_return_enabled SET DEFAULT true,
  ALTER COLUMN trusted_circle_share SET DEFAULT false,
  ALTER COLUMN hotel_blur_enabled SET DEFAULT true;

-- Backfill only absent canonical rows. Legacy visibility values are
-- deliberately not copied: that table stores audience values such as
-- "everyone", while the canonical table stores precision values such as
-- "city_only". trusted_circle_share is also reset to false because the legacy
-- table's true default is not evidence of explicit live-location consent.
INSERT INTO public.user_location_preferences (
  user_id,
  location_mode,
  sharing_paused,
  pulse_visibility,
  discovery_visibility,
  safe_return_enabled,
  trusted_circle_share,
  hotel_blur_enabled,
  updated_at
)
SELECT
  lp.user_id,
  CASE
    WHEN lp.location_mode IN (
      'off', 'city_only', 'nearby', 'live_during_activity', 'trusted_circle_live'
    ) THEN lp.location_mode
    WHEN lp.location_mode IN ('city', 'precise') THEN 'city_only'
    ELSE 'off'
  END,
  lp.sharing_paused,
  NULL,
  NULL,
  lp.safe_return_enabled,
  false,
  lp.hotel_blur_enabled,
  lp.updated_at
FROM public.location_preferences lp
ON CONFLICT (user_id) DO NOTHING;

ALTER TABLE public.user_location_preferences
  DROP CONSTRAINT IF EXISTS user_location_preferences_location_mode_check,
  DROP CONSTRAINT IF EXISTS user_location_preferences_pulse_visibility_check,
  DROP CONSTRAINT IF EXISTS user_location_preferences_discovery_visibility_check;

ALTER TABLE public.user_location_preferences
  ADD CONSTRAINT user_location_preferences_location_mode_check
    CHECK (location_mode IN (
      'off', 'city_only', 'nearby', 'live_during_activity', 'trusted_circle_live'
    )),
  ADD CONSTRAINT user_location_preferences_pulse_visibility_check
    CHECK (
      pulse_visibility IS NULL OR pulse_visibility IN (
        'city_only', 'neighborhood', 'venue_tagged', 'exact_hidden', 'no_location'
      )
    ),
  ADD CONSTRAINT user_location_preferences_discovery_visibility_check
    CHECK (
      discovery_visibility IS NULL OR discovery_visibility IN (
        'city_only', 'neighborhood', 'venue_tagged', 'exact_hidden', 'no_location'
      )
    );

ALTER TABLE public.user_location_preferences ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_location_preferences'
      AND policyname = 'ulp_select_own'
  ) THEN
    CREATE POLICY ulp_select_own
      ON public.user_location_preferences
      FOR SELECT USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_location_preferences'
      AND policyname = 'ulp_insert_own'
  ) THEN
    CREATE POLICY ulp_insert_own
      ON public.user_location_preferences
      FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_location_preferences'
      AND policyname = 'ulp_update_own'
  ) THEN
    CREATE POLICY ulp_update_own
      ON public.user_location_preferences
      FOR UPDATE USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;

END $$;

COMMENT ON TABLE public.user_location_preferences IS
  'Canonical location sharing preferences. Visibility columns describe precision, not audience.';
COMMENT ON TABLE public.location_preferences IS
  'Legacy location preference table retained for rollback after 2110. New application reads and writes use user_location_preferences.';

-- ── Canonical location-session service contract ─────────────────────────────
-- Keep legacy aliases (resolved_city, trip_id, plan_item_id) while adding the
-- fields used by LocationSessionService and GeoZoneService.

ALTER TABLE public.location_sessions
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS district text,
  ADD COLUMN IF NOT EXISTS country text,
  ADD COLUMN IF NOT EXISTS country_code text,
  ADD COLUMN IF NOT EXISTS lat double precision,
  ADD COLUMN IF NOT EXISTS lng double precision,
  ADD COLUMN IF NOT EXISTS related_trip_id uuid,
  ADD COLUMN IF NOT EXISTS related_plan_id uuid,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- A fresh canonical replay may have the original enum column, while the
-- deployed table uses text. Widen either representation without converting or
-- rewriting existing rows.
DO $$
DECLARE
  session_type_schema text;
  session_type_name text;
  session_type_kind "char";
  value_to_add text;
BEGIN
  SELECT type_ns.nspname, type_row.typname, type_row.typtype
    INTO session_type_schema, session_type_name, session_type_kind
  FROM pg_attribute attr
  JOIN pg_class relation ON relation.oid = attr.attrelid
  JOIN pg_namespace relation_ns ON relation_ns.oid = relation.relnamespace
  JOIN pg_type type_row ON type_row.oid = attr.atttypid
  JOIN pg_namespace type_ns ON type_ns.oid = type_row.typnamespace
  WHERE relation_ns.nspname = 'public'
    AND relation.relname = 'location_sessions'
    AND attr.attname = 'session_type'
    AND attr.attnum > 0
    AND NOT attr.attisdropped;

  IF session_type_kind = 'e' THEN
    FOREACH value_to_add IN ARRAY ARRAY[
      'private_stay',
      'trusted_circle',
      'live_share',
      'trip_check_in',
      'auto'
    ]
    LOOP
      EXECUTE format(
        'ALTER TYPE %I.%I ADD VALUE IF NOT EXISTS %L',
        session_type_schema,
        session_type_name,
        value_to_add
      );
    END LOOP;
  END IF;
END $$;

ALTER TABLE public.location_sessions
  DROP CONSTRAINT IF EXISTS location_sessions_session_type_check;

ALTER TABLE public.location_sessions
  ADD CONSTRAINT location_sessions_session_type_check
    CHECK (
      session_type::text IN (
        -- LocationSessionService contract
        'private_stay', 'safe_return', 'trusted_circle', 'plan_checkin',
        -- Original canonical 0033 values retained for rollback/readability
        'manual', 'trip_arrival',
        -- Early deployed/root values retained for old rows and rollback
        'live_share', 'trip_check_in', 'auto'
      )
    );

CREATE INDEX IF NOT EXISTS location_sessions_active_expiry_idx
  ON public.location_sessions (expires_at)
  WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS location_sessions_user_type_started_idx
  ON public.location_sessions (user_id, session_type, started_at DESC);

COMMENT ON TABLE public.location_sessions IS
  'Timed location-sharing sessions. 2110 preserves legacy columns while defining the LocationSessionService contract; not a Journey observation stream.';

-- ── Transactional postconditions ────────────────────────────────────────────

DO $$
DECLARE
  missing_preferences bigint;
  missing_session_columns text[];
BEGIN
  SELECT count(*)
    INTO missing_preferences
  FROM public.location_preferences lp
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.user_location_preferences ulp
    WHERE ulp.user_id = lp.user_id
  );

  IF missing_preferences <> 0 THEN
    RAISE EXCEPTION
      '2110 postcondition failed: % legacy preference rows were not backfilled',
      missing_preferences;
  END IF;

  SELECT array_agg(required.column_name ORDER BY required.column_name)
    INTO missing_session_columns
  FROM unnest(ARRAY[
    'expires_at', 'city', 'district', 'country', 'country_code',
    'lat', 'lng', 'related_trip_id', 'related_plan_id'
  ]) AS required(column_name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns actual
    WHERE actual.table_schema = 'public'
      AND actual.table_name = 'location_sessions'
      AND actual.column_name = required.column_name
  );

  IF missing_session_columns IS NOT NULL THEN
    RAISE EXCEPTION
      '2110 postcondition failed: location_sessions is missing columns %',
      missing_session_columns;
  END IF;
END $$;

COMMIT;

-- ROLLBACK PLAN
-- Deploying the previous application version is sufficient: the legacy table,
-- aliases, constraints' legacy values, and data remain intact. The extra
-- canonical rows/columns are inert to old code. Do not delete backfilled rows
-- during an emergency rollback because users may have updated them after 2110.