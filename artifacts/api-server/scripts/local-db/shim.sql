-- Supabase shim for a plain PostgreSQL 16 — ONLY what the canonical chain and
-- the 2026-08-19 baseline structure reference. Measured, not guessed: over the
-- 498 canonical files the Supabase-specific surface is auth.uid() (451 uses),
-- auth.role() (109), auth.users (57) and the three PostgREST roles; the
-- baseline dump additionally names supabase_admin, supabase_storage_admin,
-- dashboard_user, the `extensions` schema (pgcrypto lives there on Supabase)
-- and PostGIS geography columns. Nothing here reproduces GoTrue, PostgREST,
-- storage or realtime: a test that needs one of those is not a test this
-- harness can run, and it should say so rather than pass.
DO $$ DECLARE r text; BEGIN
  FOR r IN SELECT unnest(ARRAY['anon','authenticated','service_role','supabase_admin','supabase_storage_admin','supabase_auth_admin','dashboard_user','authenticator','pgsodium_keyiduser']) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF;
  END LOOP;
  -- service_role bypasses RLS on Supabase; the API's service client relies on it.
  ALTER ROLE service_role BYPASSRLS;
END $$;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;
GRANT USAGE ON SCHEMA extensions TO PUBLIC;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE,
  phone text,
  raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_app_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_sign_in_at timestamptz,
  email_confirmed_at timestamptz,
  deleted_at timestamptz
);
-- auth.uid()/role()/jwt() read the same GUCs PostgREST sets, so a test that
-- does `SELECT set_config('request.jwt.claim.sub', '<uuid>', true)` inside a
-- transaction is seen by RLS exactly as a signed-in user would be.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.sub', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
