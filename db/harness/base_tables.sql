-- db/harness/base_tables.sql — the pre-existing schema the Trip Kernel
-- migrations assume. These tables are NOT created by any migration in the
-- 2400+ band; they are 0001-era spine that every environment already has.
--
-- Column names and types are copied from portava-ci's pg_attribute. What is
-- ADDED here beyond that copy is the keys, defaults and NOT NULLs the kernel's
-- writes actually depend on — a stub without them proves nothing, because the
-- write that should fail would succeed.
--
-- The four enum types are REAL enums with production's labels, read from
-- production's pg_enum on 2026-09-09. They were text DOMAINs until 2500's own
-- precondition refused to run against them -- "member_role has no co_host label
-- (0078) -- host cannot be expressed" -- which is the precondition doing
-- exactly its job and is why they are not stubs any more.

CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE ROLE authenticator;

CREATE SCHEMA IF NOT EXISTS authz;
-- Supabase's auth.uid(). authz.is_trip_crew calls it; no probe runs as a
-- signed-in user, so it returns NULL and is_trip_crew is false throughout.
-- Nothing here claims anything about RLS.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;

CREATE TYPE member_role          AS ENUM ('owner', 'member', 'invited', 'co_host', 'viewer');
CREATE TYPE trip_status          AS ENUM ('draft', 'planning', 'upcoming', 'active', 'completed', 'cancelled', 'archived');
CREATE TYPE trip_visibility      AS ENUM ('public', 'buddies', 'private', 'invite');
CREATE TYPE tag_permission_level AS ENUM ('anyone', 'interacted', 'friends_only', 'nobody');

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, handle text, name text, display_name text, username text,
  avatar_url text, account_status text DEFAULT 'active', role text,
  tag_permission tag_permission_level,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE public.trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title text, destination_city text, destination_country text,
  destination_lat double precision, destination_lng double precision,
  destination_place_id text, neighborhoods text[],
  start_date date, end_date date,
  status trip_status NOT NULL DEFAULT 'planning',
  visibility trip_visibility NOT NULL DEFAULT 'private',
  travel_style text, open_to_meet boolean, trip_type text, timezone text,
  cover_url text, cover_media_type text, cover_image_width integer, cover_image_height integer,
  progress integer, plan_edit_permission text, trip_notes text,
  show_on_profile boolean, show_in_discovery boolean, allow_friend_suggestions boolean,
  allow_trip_crew_invites boolean, allow_join_requests boolean, show_exact_dates boolean,
  show_destination_city boolean, delayed_posting_default boolean,
  precise_location_visible boolean, show_header_publicly boolean,
  max_members integer, original_language text,
  reminder_sent_at timestamptz, reminder_retry_count integer, reminder_delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE public.trip_members (
  trip_id uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role member_role NOT NULL DEFAULT 'member',
  status text NOT NULL DEFAULT 'accepted',
  permissions jsonb, invite_link_id uuid,
  joined_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, user_id));

CREATE TABLE public.trip_plan_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  creator_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  title text NOT NULL, category text, status text NOT NULL DEFAULT 'idea',
  source_type text, source_id text, day_date date,
  starts_at timestamptz, ends_at timestamptz,
  location_name text, notes text, description text, city text, country text,
  sort_order integer, visibility text NOT NULL DEFAULT 'members',
  lat double precision, lng double precision,
  location_is_private boolean NOT NULL DEFAULT true,
  lock_type text, route_stop_id uuid,
  added_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE public.trip_invite_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  max_uses integer, use_count integer NOT NULL DEFAULT 0,
  expires_at timestamptz, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE public.trip_invite_link_attempts (
  link_id uuid NOT NULL REFERENCES public.trip_invite_links(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (link_id, user_id));

CREATE TABLE public.feature_flags (
  flag text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false,
  description text, updated_at timestamptz NOT NULL DEFAULT now());
