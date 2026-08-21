/**
 * Real-PostgreSQL replay coverage for the location-sharing convergence.
 *
 * Imported by locationGps.test.ts so the disposable-database checks remain in
 * the registered location suite instead of becoming an unregistered test file.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const migrationPath = fileURLToPath(
  new URL("../migrations/2110_location_sharing_schema_convergence.sql", import.meta.url),
);

const USER_A = "10000000-0000-4000-8000-000000000001";
const USER_B = "10000000-0000-4000-8000-000000000002";
const USER_WITH_CANONICAL_PREFERENCES = "10000000-0000-4000-8000-000000000003";
const SERVICE_SESSION_TYPES = [
  "private_stay",
  "safe_return",
  "trusted_circle",
  "plan_checkin",
] as const;

type HistoricalSessionShape = "enum" | "text";

interface PostgresCluster {
  port: number;
  process: ReturnType<typeof spawn>;
  socketDir: string;
  tempDir: string;
}

interface PreferenceRow {
  discovery_visibility: string | null;
  location_mode: string;
  pulse_visibility: string | null;
  sharing_paused: boolean;
  trusted_circle_share: boolean;
  user_id: string;
}

interface MigrationSnapshot {
  preferences: PreferenceRow[];
  session_columns: string[];
  session_rows: Array<{ session_type: string; user_id: string }>;
  session_type_values: string[];
}

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a port for the PostgreSQL replay test"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function execPsql(
  cluster: PostgresCluster,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    "psql",
    [
      "--no-psqlrc",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-h",
      cluster.socketDir,
      "-p",
      String(cluster.port),
      "-U",
      "postgres",
      "-d",
      "postgres",
      ...args,
    ],
    {
      env: { ...process.env, PGCONNECT_TIMEOUT: "1" },
      maxBuffer: 1024 * 1024,
      timeout: 20_000,
    },
  );
}

async function sql(cluster: PostgresCluster, statement: string): Promise<string> {
  const { stdout } = await execPsql(cluster, ["-A", "-t", "-c", statement]);
  return stdout.trim();
}

async function startPostgres(): Promise<PostgresCluster> {
  const tempDir = await mkdtemp(join(tmpdir(), "location-migration-replay-"));
  const dataDir = join(tempDir, "data");
  const socketDir = join(tempDir, "socket");
  const port = await reservePort();

  await execFileAsync(
    "initdb",
    ["-D", dataDir, "--auth=trust", "--encoding=UTF8", "--no-locale", "--username=postgres"],
    { timeout: 20_000 },
  );
  await mkdir(socketDir);

  const postgresProcess = spawn(
    "postgres",
    [
      "-D",
      dataDir,
      "-h",
      "127.0.0.1",
      "-p",
      String(port),
      "-k",
      socketDir,
      "-c",
      "fsync=off",
      "-c",
      "synchronous_commit=off",
    ],
    { stdio: "ignore" },
  );
  const cluster = { tempDir, socketDir, port, process: postgresProcess };

  let lastError: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await sql(cluster, "SELECT 1");
      return cluster;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  postgresProcess.kill("SIGKILL");
  await rm(tempDir, { force: true, recursive: true });
  throw new Error(`Temporary PostgreSQL cluster did not start: ${String(lastError)}`);
}

async function stopPostgres(cluster: PostgresCluster): Promise<void> {
  const exited = new Promise<void>((resolve) => cluster.process.once("exit", () => resolve()));
  if (cluster.process.exitCode === null) {
    cluster.process.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (cluster.process.exitCode === null) {
      cluster.process.kill("SIGKILL");
      await exited;
    }
  }
  await rm(cluster.tempDir, { force: true, recursive: true });
}

function historicalSessionSql(shape: HistoricalSessionShape): string {
  if (shape === "enum") {
    return `
      CREATE TYPE public.location_session_type AS ENUM (
        'manual', 'trip_arrival', 'plan_checkin', 'safe_return'
      );
      CREATE TABLE public.location_sessions (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL,
        session_type public.location_session_type NOT NULL,
        started_at timestamptz NOT NULL DEFAULT now(),
        ended_at timestamptz,
        resolved_city text,
        resolved_country text,
        trip_id uuid,
        plan_item_id uuid,
        metadata jsonb
      );
      INSERT INTO public.location_sessions (id, user_id, session_type, resolved_city)
      VALUES ('20000000-0000-4000-8000-000000000001', '${USER_A}', 'manual', 'Cebu City');
    `;
  }

  return `
    CREATE TABLE public.location_sessions (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL,
      session_type text NOT NULL DEFAULT 'safe_return',
      started_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz,
      ended_at timestamptz,
      city text,
      district text,
      country text,
      country_code text,
      lat double precision,
      lng double precision,
      related_trip_id uuid,
      related_plan_id uuid,
      metadata jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO public.location_sessions (id, user_id, session_type, city)
    VALUES ('20000000-0000-4000-8000-000000000002', '${USER_A}', 'live_share', 'Cebu City');
  `;
}

async function seedHistoricalSchema(
  cluster: PostgresCluster,
  shape: HistoricalSessionShape,
): Promise<void> {
  await sql(cluster, `
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid
      LANGUAGE sql STABLE AS 'SELECT NULL::uuid';
    INSERT INTO auth.users (id) VALUES
      ('${USER_A}'), ('${USER_B}'), ('${USER_WITH_CANONICAL_PREFERENCES}');

    -- Legacy visibility fields are audience values, not precision values.
    CREATE TABLE public.location_preferences (
      user_id uuid PRIMARY KEY,
      location_mode text NOT NULL,
      sharing_paused boolean NOT NULL DEFAULT false,
      pulse_visibility text,
      discovery_visibility text,
      safe_return_enabled boolean NOT NULL DEFAULT false,
      trusted_circle_share boolean NOT NULL DEFAULT true,
      hotel_blur_enabled boolean NOT NULL DEFAULT true,
      updated_at timestamptz NOT NULL DEFAULT '2026-08-01T00:00:00Z'
    );
    INSERT INTO public.location_preferences (
      user_id, location_mode, sharing_paused, pulse_visibility,
      discovery_visibility, safe_return_enabled, trusted_circle_share
    ) VALUES
      ('${USER_A}', 'precise', false, 'everyone', 'circle_only', false, true),
      ('${USER_B}', 'nearby', true, 'trip_only', 'everyone', true, true),
      ('${USER_WITH_CANONICAL_PREFERENCES}', 'nearby', false, 'everyone', 'everyone', true, true);

    -- Existing canonical choices must win over the rollback source.
    CREATE TABLE public.user_location_preferences (
      user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
      location_mode text NOT NULL DEFAULT 'city_only',
      sharing_paused boolean NOT NULL DEFAULT false,
      pulse_visibility text,
      discovery_visibility text,
      safe_return_enabled boolean NOT NULL DEFAULT true,
      trusted_circle_share boolean NOT NULL DEFAULT false,
      hotel_blur_enabled boolean NOT NULL DEFAULT true,
      updated_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO public.user_location_preferences (
      user_id, location_mode, pulse_visibility, discovery_visibility, trusted_circle_share
    ) VALUES (
      '${USER_WITH_CANONICAL_PREFERENCES}', 'off', 'no_location', 'exact_hidden', true
    );
  `);
  await sql(cluster, historicalSessionSql(shape));
}

async function snapshot(cluster: PostgresCluster): Promise<MigrationSnapshot> {
  const json = await sql(cluster, `
    SELECT json_build_object(
      'preferences', COALESCE((
        SELECT json_agg(row ORDER BY row.user_id)
        FROM (
          SELECT user_id::text, location_mode, sharing_paused, pulse_visibility,
                 discovery_visibility, trusted_circle_share
          FROM public.user_location_preferences
        ) row
      ), '[]'::json),
      'session_columns', COALESCE((
        SELECT json_agg(column_name ORDER BY column_name)
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'location_sessions'
      ), '[]'::json),
      'session_rows', COALESCE((
        SELECT json_agg(row ORDER BY row.user_id, row.session_type)
        FROM (
          SELECT user_id::text, session_type::text
          FROM public.location_sessions
        ) row
      ), '[]'::json),
      'session_type_values', COALESCE((
        SELECT json_agg(enum_value.enumlabel ORDER BY enum_value.enumsortorder)
        FROM pg_enum enum_value
        JOIN pg_type type_row ON type_row.oid = enum_value.enumtypid
        JOIN pg_namespace type_namespace ON type_namespace.oid = type_row.typnamespace
        WHERE type_namespace.nspname = 'public'
          AND type_row.typname = 'location_session_type'
      ), '[]'::json)
    );
  `);
  return JSON.parse(json) as MigrationSnapshot;
}

async function assertServiceTypesInsert(cluster: PostgresCluster): Promise<void> {
  const rows = SERVICE_SESSION_TYPES.map((sessionType, index) =>
    `('30000000-0000-4000-8000-00000000000${index + 1}', '${USER_B}', '${sessionType}')`
  ).join(", ");
  await sql(
    cluster,
    `INSERT INTO public.location_sessions (id, user_id, session_type) VALUES ${rows}`,
  );
  const inserted = JSON.parse(await sql(cluster, `
    SELECT json_agg(session_type::text ORDER BY session_type::text)
    FROM public.location_sessions
    WHERE user_id = '${USER_B}'
  `)) as string[];
  assert.deepEqual(inserted, [...SERVICE_SESSION_TYPES].sort());
}

async function assertNoJourneyCollection(cluster: PostgresCluster): Promise<void> {
  assert.equal(
    await sql(
      cluster,
      "SELECT count(*) FROM pg_class WHERE oid = to_regclass('public.journey_observations')",
    ),
    "0",
    "2110 must not create journey_observations",
  );

  const publicTriggers = JSON.parse(await sql(cluster, `
    SELECT COALESCE(json_agg(trigger_name ORDER BY trigger_name), '[]'::json)
    FROM (
      SELECT namespace.nspname || '.' || relation.relname || '.' || trigger.tgname AS trigger_name
      FROM pg_trigger trigger
      JOIN pg_class relation ON relation.oid = trigger.tgrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE NOT trigger.tgisinternal AND namespace.nspname = 'public'
    ) triggers
  `)) as string[];
  assert.deepEqual(publicTriggers, [], "2110 must not create a collection trigger");
}

describe("2110 location sharing schema convergence replay", () => {
  for (const shape of ["enum", "text"] as const) {
    it(`replays safely from the ${shape}-based location_sessions shape`, { timeout: 45_000 }, async () => {
      const cluster = await startPostgres();
      try {
        await seedHistoricalSchema(cluster, shape);
        await execPsql(cluster, ["-f", migrationPath]);
        const first = await snapshot(cluster);
        await execPsql(cluster, ["-f", migrationPath]);
        assert.deepEqual(
          await snapshot(cluster),
          first,
          "a second 2110 replay must not change the converged result",
        );

        const preferences = new Map(first.preferences.map((row) => [row.user_id, row]));
        assert.deepEqual(preferences.get(USER_A), {
          user_id: USER_A,
          location_mode: "city_only",
          sharing_paused: false,
          pulse_visibility: null,
          discovery_visibility: null,
          trusted_circle_share: false,
        });
        assert.deepEqual(preferences.get(USER_B), {
          user_id: USER_B,
          location_mode: "nearby",
          sharing_paused: true,
          pulse_visibility: null,
          discovery_visibility: null,
          trusted_circle_share: false,
        });
        assert.deepEqual(preferences.get(USER_WITH_CANONICAL_PREFERENCES), {
          user_id: USER_WITH_CANONICAL_PREFERENCES,
          location_mode: "off",
          sharing_paused: false,
          pulse_visibility: "no_location",
          discovery_visibility: "exact_hidden",
          trusted_circle_share: true,
        });

        const legacyType = shape === "enum" ? "manual" : "live_share";
        assert.ok(first.session_rows.some(
          (row) => row.user_id === USER_A && row.session_type === legacyType,
        ));
        for (const column of [
          "expires_at", "city", "district", "country", "country_code",
          "lat", "lng", "related_trip_id", "related_plan_id",
        ]) {
          assert.ok(first.session_columns.includes(column), `location_sessions must expose ${column}`);
        }
        if (shape === "enum") {
          for (const value of ["private_stay", "trusted_circle", "live_share", "trip_check_in", "auto"]) {
            assert.ok(first.session_type_values.includes(value), `the enum must accept ${value}`);
          }
        } else {
          assert.deepEqual(first.session_type_values, []);
        }

        await assertServiceTypesInsert(cluster);
        await assertNoJourneyCollection(cluster);
      } finally {
        await stopPostgres(cluster);
      }
    });
  }
});