/**
 * The events waitlist's tables on PGlite (PostgreSQL 16, in-process): the baseline's own definitions
 * (baseline/20260819_baseline_structure.sql), extracted verbatim, for every table the waitlist paths of
 * routes/events.ts touch, plus the keys those paths rely on. One stand-in, stated: public.events without its
 * PostGIS `geog` generated column (PGlite has no PostGIS; nothing on these paths reads it). Used by
 * eventsWaitlistSeatLockRace.test.ts and eventWaitlistSeatLockMigration.test.ts (migration 3906).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const BASE = readFileSync(new URL("../../../baseline/20260819_baseline_structure.sql", import.meta.url), "utf8");

function slice(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  assert.ok(i >= 0, `baseline has no "${start}"`);
  return src.slice(i, src.indexOf(end, i) + end.length);
}
const table = (name: string) => slice(BASE, `CREATE TABLE public.${name} (`, "\n);\n");
const enumType = (name: string) => slice(BASE, `CREATE TYPE public.${name} AS ENUM (`, ");");
export const EVENT_WAITLIST_SCHEMA = [
  "SET TimeZone = 'UTC';",
  "DO $r$ BEGIN CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $r$;",
  ...["event_rsvp_status", "event_state", "event_visibility", "event_role_type", "tag_permission_level"].map(enumType),
  table("profiles"),
  "ALTER TABLE ONLY public.profiles ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);",
  table("events").replace(/ {4}geog public\.geography[\s\S]*?END\) STORED,\n/, ""),
  "ALTER TABLE ONLY public.events ADD CONSTRAINT events_pkey PRIMARY KEY (id);",
  table("event_rsvps"),
  "ALTER TABLE ONLY public.event_rsvps ADD CONSTRAINT event_rsvps_pkey PRIMARY KEY (event_id, user_id);",
  "ALTER TABLE ONLY public.event_rsvps ADD CONSTRAINT event_rsvps_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;",
  table("event_waitlist"),
  "ALTER TABLE ONLY public.event_waitlist ADD CONSTRAINT event_waitlist_pkey PRIMARY KEY (event_id, user_id);",
  "ALTER TABLE ONLY public.event_waitlist ADD CONSTRAINT event_waitlist_event_id_position_key UNIQUE (event_id, \"position\");",
  "ALTER TABLE ONLY public.event_waitlist ADD CONSTRAINT event_waitlist_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;",
  table("event_attendees"),
  "ALTER TABLE ONLY public.event_attendees ADD CONSTRAINT event_attendees_pkey PRIMARY KEY (event_id, user_id);",
  table("event_roles"),
  table("event_activity_log"),
  table("user_account_states"),
  table("feature_flags"),
  "ALTER TABLE ONLY public.feature_flags ADD CONSTRAINT feature_flags_pkey PRIMARY KEY (flag);",
  table("blocks"),
  table("notifications"),
  "GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;",
].join("\n");


/** The three tables 3906 reads, their enums and the roles, alone: what the migration's own preconditions name. */
export const EVENT_WAITLIST_CORE_SCHEMA = [
  "DO $r$ BEGIN CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $r$;",
  ...["event_rsvp_status", "event_state", "event_visibility"].map(enumType),
  "CREATE TABLE public.profiles (id uuid PRIMARY KEY);",
  table("events").replace(/ {4}geog public\.geography[\s\S]*?END\) STORED,\n/, ""),
  "ALTER TABLE ONLY public.events ADD CONSTRAINT events_pkey PRIMARY KEY (id);",
  table("event_rsvps"),
  "ALTER TABLE ONLY public.event_rsvps ADD CONSTRAINT event_rsvps_pkey PRIMARY KEY (event_id, user_id);",
  "ALTER TABLE ONLY public.event_rsvps ADD CONSTRAINT event_rsvps_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;",
  table("event_waitlist"),
  "ALTER TABLE ONLY public.event_waitlist ADD CONSTRAINT event_waitlist_pkey PRIMARY KEY (event_id, user_id);",
  "ALTER TABLE ONLY public.event_waitlist ADD CONSTRAINT event_waitlist_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;",
  "GRANT ALL ON TABLE public.events, public.event_rsvps, public.event_waitlist TO service_role;",
].join("\n");
