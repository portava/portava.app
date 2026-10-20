import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

export const memoryImportPostgresIds = {
  owner: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  other: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  first: "10000000-0000-4000-8000-000000000001",
  second: "10000000-0000-4000-8000-000000000002",
  foreign: "10000000-0000-4000-8000-000000000003",
  key: "20000000-0000-4000-8000-000000000001",
  trip: "30000000-0000-4000-8000-000000000001",
  place: "50000000-0000-4000-8000-000000000001",
};

export async function memoryImportPostgresSchema(): Promise<string> {
  const migration = (name: string) => readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
  const section = (sql: string, start: string, end: string) => {
    const startIndex = sql.indexOf(start);
    const endIndex = sql.indexOf(end, startIndex);
    assert.ok(startIndex >= 0 && endIndex > startIndex, `Actual migration section missing: ${start}`);
    return sql.slice(startIndex, endIndex);
  };
  return `
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
    CREATE TABLE public.profiles(id uuid PRIMARY KEY, handle text NOT NULL UNIQUE,
      account_status text NOT NULL DEFAULT 'active');
    CREATE TABLE public.highlights(id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES profiles(id),
      deleted_at timestamptz, archived_at timestamptz, pinned_at timestamptz, expires_at timestamptz);
    CREATE TABLE public.memory_episodes(id uuid PRIMARY KEY, user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE);
    CREATE TABLE public.feature_flags(flag text PRIMARY KEY, enabled boolean NOT NULL, description text);
    CREATE TABLE public.memories(id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      state text NOT NULL DEFAULT 'published', trip_id uuid, event_id uuid, place_id text, canonical_location_id uuid,
      title text DEFAULT 'synthetic private title', caption text DEFAULT 'synthetic private caption',
      updated_at timestamptz NOT NULL DEFAULT '2020-01-01T00:00:00Z');
    CREATE TABLE public.memory_tags(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      tagged_user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, status text NOT NULL);
    ${await migration("2710_memory_command_kernel_tables.sql")}
    ${await migration("2993_highlight_command_boundary.sql")}
    ${section(await migration("2130_intel_storage.sql"),
      "CREATE OR REPLACE FUNCTION public.intel_append_only()", "CREATE OR REPLACE FUNCTION public.intel_append_only_stmt()")}
    ${await migration("3673_memory_corrections.sql")}
    ${section(await migration("2994_memory_relations_and_outbox_consumer.sql"),
      "CREATE TABLE IF NOT EXISTS public.memory_relations", "-- ── 4. The outbox")}
    ${await migration("3674_memory_graph_model.sql")}
    ${await migration("3992_memory_import_batches.sql")}
  `;
}

export function memoryImportPostgresSeed(): string {
  const { owner, other, first, second, foreign, trip, place } = memoryImportPostgresIds;
  return `
    DROP TRIGGER IF EXISTS fixture_import_outbox_pause ON public.memory_event_outbox;
    DELETE FROM auth.users;
    DELETE FROM public.profiles;
    DELETE FROM public.memory_command_audit;
    UPDATE public.feature_flags SET enabled = false;
    UPDATE public.feature_flags SET enabled = true WHERE flag IN ('memory_kernel_enabled', 'memory_import_batches_enabled');
    INSERT INTO auth.users VALUES ('${owner}'), ('${other}');
    INSERT INTO public.profiles(id, handle) VALUES ('${owner}', 'fixture-owner'), ('${other}', 'fixture-other');
    INSERT INTO public.memories(id, owner_id, trip_id, place_id, canonical_location_id, source_mode) VALUES
      ('${first}', '${owner}', '${trip}', 'fixture-provider', '${place}', 'LEGACY_IMPORTED'),
      ('${second}', '${owner}', NULL, 'fixture-second', NULL, 'LEGACY_IMPORTED'),
      ('${foreign}', '${other}', NULL, 'fixture-provider', '${place}', 'LEGACY_IMPORTED');
    INSERT INTO public.memory_tags(memory_id, tagged_user_id, status) VALUES ('${first}', '${other}', 'approved');
    DELETE FROM public.memory_relations WHERE source_id IN ('${first}', '${second}');
  `;
}
