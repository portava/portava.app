import { readFile } from "node:fs/promises";

export const memorySnapshotLockIds = {
  owner: "11111111-1111-4111-8111-111111111111",
  memory: "22222222-2222-4222-8222-222222222222",
  episode: "33333333-3333-4333-8333-333333333333",
  media: "44444444-4444-4444-8444-444444444444",
  evidence: "55555555-5555-4555-8555-555555555555",
};

export async function memorySnapshotLockSchema(): Promise<string> {
  const migration = (name: string) => readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
  return `
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
    CREATE TABLE public.profiles(id uuid PRIMARY KEY);
    CREATE TABLE public.feature_flags(flag text PRIMARY KEY, enabled boolean, description text);
    INSERT INTO public.feature_flags VALUES ('memory_kernel_enabled', false, 'fixture');
    CREATE TABLE public.memories(id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES public.profiles ON DELETE CASCADE,
      title text, caption text, starts_at timestamptz, ends_at timestamptz, state text NOT NULL,
      updated_at timestamptz NOT NULL, place_id text, trip_id uuid, location_city text, location_country text);
    CREATE TABLE public.memory_policy(retention_class text PRIMARY KEY, ttl interval, deletion_behavior text NOT NULL);
    INSERT INTO public.memory_policy VALUES ('trip_context', NULL, 'erase_with_account');
    CREATE TABLE public.media_assets(id uuid PRIMARY KEY, owner_user_id uuid NOT NULL, media_type text NOT NULL,
      captured_at timestamptz, provenance jsonb, deleted_at timestamptz, processing_status text, moderation_status text, source_type text);
    CREATE TABLE public.memory_domain_events(memory_id uuid REFERENCES public.memories ON DELETE CASCADE, sequence bigint);
    CREATE TABLE public.memory_feedback(user_id uuid);
    CREATE TABLE public.memory_projections(user_id uuid);
    CREATE TABLE public.memory_events(user_id uuid);
    CREATE FUNCTION public.erase_memory_for_user(uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
    CREATE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
    ${await migration("2320_memory_episode_provenance_spine.sql")}
    ${await migration("3990_memory_snapshots.sql")}
  `;
}

export function memorySnapshotLockSeed(): string {
  const { owner, memory, episode, media, evidence } = memorySnapshotLockIds;
  return `
    TRUNCATE public.memory_snapshots, public.memory_domain_events, public.memory_evidence, public.memory_episodes,
      public.media_assets, public.memories, public.profiles, auth.users CASCADE;
    UPDATE public.feature_flags SET enabled = true;
    UPDATE public.memory_policy SET ttl = NULL, deletion_behavior = 'erase_with_account';
    INSERT INTO auth.users VALUES ('${owner}');
    INSERT INTO public.profiles VALUES ('${owner}');
    INSERT INTO public.memories(id, owner_id, title, caption, starts_at, state, updated_at)
      VALUES ('${memory}', '${owner}', 'Private original', 'Original caption', '2020-01-01T01:00:00Z', 'published', '2020-01-02T00:00:00Z');
    INSERT INTO public.memory_episodes(id, user_id, episode_kind, started_at, detection_reason, detector_version,
      significance, significance_basis, state, retention_class)
      VALUES ('${episode}', '${owner}', 'visit', '2020-01-01T01:00:00Z', 'user_declared', 1, 1, 'user_affirmed', 'confirmed', 'trip_context');
    INSERT INTO public.media_assets VALUES ('${media}', '${owner}', 'image', '2020-01-01T01:00:00Z',
      '{"captureProvenance":"camera"}', NULL, 'ready', 'active', 'user');
    INSERT INTO public.memory_evidence(id, episode_id, user_id, truth_level, source_class, source_table, source_id) VALUES
      ('${evidence}', '${episode}', '${owner}', 'observed', 'system', 'media_assets', '${media}'),
      ('66666666-6666-4666-8666-666666666666', '${episode}', '${owner}', 'asserted', 'explicit', 'memories', '${memory}');
  `;
}
