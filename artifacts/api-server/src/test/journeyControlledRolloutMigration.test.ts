/**
 * journeyControlledRolloutMigration.test.ts
 *
 * Focused integration suite that applies migrations 2103, 2119, 2120, and 2123
 * in order against a disposable local PostgreSQL cluster. All assertions are
 * executed via real SQL — no mocks, no live DB, no external network.
 *
 * Covers:
 *  - migration applies and replays idempotently (2103 → 2119 → 2120 → 2123)
 *  - all Journey flags remain false after each migration
 *  - non-admin cannot configure/assign/issue/stop/truth/report even through
 *    service_role RPC
 *  - approved internal stage + active assignment + issued finite session +
 *    explicit versioned consent + preferences + all flags + fresh HEALTHY
 *    retention authorize ingest/raw_read/derived_write; each one-at-a-time
 *    missing/stale/revoked/paused/off/wrong owner/source/window/health/flag
 *    denies
 *  - direct service_role INSERT into observations/segments/control tables
 *    denied; v1 writer RPCs denied
 *  - v2 quality rejects missing/wrong/out-of-range and unknown class;
 *    unusable IS accepted and persisted (for QA distribution measurement);
 *    segmentation excludes unusable at read time
 *  - service_role direct SELECT on journey_observations denied after 2123
 *  - read_journey_shadow_observations_v1: authorized success returns rows,
 *    excludes unusable, returns zero rows on denial (flags off / wrong owner)
 *  - aggregate_journey_shadow_observations_v1: admin aggregate returns counts
 *    + class/reason distributions including unusable; no coordinates/IDs;
 *    non-admin denied; fails closed when any session denied
 *  - append v2 is revision-safe/idempotent; deep forbidden payload keys
 *    rejected; unauthorized append denied
 *  - cohort revoke atomically ends issuance/session and erases raw+derived;
 *    account deletion function erases rollout data without FK failures
 *  - global stop disables flags, stops stages, revokes cohorts, ends sessions,
 *    erases raw+derived
 *  - finite raw/segment/truth expiry and finish_journey_retention_cycle_v2
 *    store all three purge counts with lease-token semantics
 *  - ground truth must match assignment+issued session; coordinate/raw-id JSON
 *    is rejected
 *
 * Pattern: follows locationMigrationReplaySuite / locationGps approach:
 *   - startPostgres() spins up an ephemeral cluster
 *   - seedMinimalPrerequisites() builds only the schema that migrations need
 *   - migrations applied in order via execPsql (with ON_ERROR_STOP=1)
 *   - assertions via sql() helper
 *   - stopPostgres() tears down on finally
 *
 * Run: node --import tsx/esm --test src/test/journeyControlledRolloutMigration.test.ts
 */

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

// ─── Migration paths ──────────────────────────────────────────────────────────

function migrationUrl(name: string): string {
  return fileURLToPath(new URL(`../migrations/${name}`, import.meta.url));
}

const MIGRATION_2103 = migrationUrl("2103_journey_segment_shadow.sql");
const MIGRATION_2119 = migrationUrl("2119_journey_observation_foundation.sql");
const MIGRATION_2120 = migrationUrl("2120_journey_privacy_foundation.sql");
const MIGRATION_2123 = migrationUrl("2123_journey_shadow_controlled_rollout.sql");

// ─── Fixed UUIDs ──────────────────────────────────────────────────────────────

const ADMIN_ID    = "00000001-0000-4000-8000-000000000001";
const USER_ID     = "00000001-0000-4000-8000-000000000002";
const NON_ADMIN   = "00000001-0000-4000-8000-000000000003";
const SESSION_ID  = "00000002-0000-4000-8000-000000000001";
const SEGMENT_ID  = "00000003-0000-4000-8000-000000000001";
const STAGE_ID    = "00000004-0000-4000-8000-000000000001";

// ─── Cluster helpers ──────────────────────────────────────────────────────────

interface PostgresCluster {
  port: number;
  process: ReturnType<typeof spawn>;
  socketDir: string;
  tempDir: string;
  /** Database the psql helpers connect to. Defaults to "postgres". */
  dbName: string;
}

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve port"));
        return;
      }
      server.close((err) => (err ? reject(err) : resolve(address.port)));
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
      "--no-psqlrc", "-X", "-v", "ON_ERROR_STOP=1",
      "-h", cluster.socketDir,
      "-p", String(cluster.port),
      "-U", "postgres",
      "-d", cluster.dbName,
      ...args,
    ],
    {
      env: { ...process.env, PGCONNECT_TIMEOUT: "5" },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
    },
  );
}

async function sql(cluster: PostgresCluster, statement: string): Promise<string> {
  const { stdout } = await execPsql(cluster, ["-A", "-t", "-c", statement]);
  return stdout.trim();
}

async function sqlRows(cluster: PostgresCluster, statement: string): Promise<string[]> {
  const out = await sql(cluster, statement);
  return out === "" ? [] : out.split("\n");
}

/** Execute SQL that is expected to succeed; assert it does not raise. */
async function sqlOk(cluster: PostgresCluster, statement: string): Promise<string> {
  return sql(cluster, statement);
}

/** Execute SQL inside a subtransaction; return true if it raised, false if it succeeded. */
async function sqlRaises(cluster: PostgresCluster, statement: string): Promise<boolean> {
  try {
    await sql(cluster, `DO $$ BEGIN ${statement}; END $$`);
    return false;
  } catch {
    return true;
  }
}

/** Execute SQL and assert it raises (psql -c form). */
async function assertRaises(cluster: PostgresCluster, statement: string, label: string): Promise<void> {
  let raised = false;
  try {
    await execPsql(cluster, ["-c", statement]);
  } catch {
    raised = true;
  }
  assert.equal(raised, true, `${label}: expected an error but query succeeded`);
}

/**
 * Execute SQL expected to raise; return the combined stdout+stderr error text
 * so callers can assert the message is generic (no user/session IDs leaked).
 */
async function captureRaise(cluster: PostgresCluster, statement: string, label: string): Promise<string> {
  try {
    await execPsql(cluster, ["-c", statement]);
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    return `${e.stderr ?? ""}\n${e.stdout ?? ""}\n${e.message ?? ""}`;
  }
  assert.fail(`${label}: expected an error but query succeeded`);
}

/**
 * Boot a single ephemeral PostgreSQL cluster. Expensive (initdb + start), so
 * this is done exactly once per suite (see the `before` hook). Per-test
 * isolation is achieved by cloning a pre-migrated template database, which is
 * an in-process file copy and dramatically faster than a fresh cluster.
 */
async function bootCluster(): Promise<PostgresCluster> {
  const tempDir = await mkdtemp(join(tmpdir(), "journey-rollout-migration-test-"));
  const dataDir = join(tempDir, "data");
  const socketDir = join(tempDir, "socket");
  const port = await reservePort();

  await execFileAsync(
    "initdb",
    ["-D", dataDir, "--auth=trust", "--encoding=UTF8", "--no-locale", "--username=postgres"],
    { timeout: 30_000 },
  );
  await mkdir(socketDir);

  const postgresProcess = spawn(
    "postgres",
    [
      "-D", dataDir,
      "-h", "127.0.0.1",
      "-p", String(port),
      "-k", socketDir,
      "-c", "fsync=off",
      "-c", "synchronous_commit=off",
      // Allow the concurrent-cap test and template clones to open enough
      // connections without exhausting the default cap.
      "-c", "max_connections=100",
    ],
    { stdio: "ignore" },
  );
  const cluster: PostgresCluster = { tempDir, socketDir, port, process: postgresProcess, dbName: "postgres" };

  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await sql(cluster, "SELECT 1");
      return cluster;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  postgresProcess.kill("SIGKILL");
  await rm(tempDir, { force: true, recursive: true });
  throw new Error(`PostgreSQL cluster did not start: ${String(lastError)}`);
}

async function shutdownCluster(cluster: PostgresCluster): Promise<void> {
  const exited = new Promise<void>((r) => cluster.process.once("exit", () => r()));
  if (cluster.process.exitCode === null) {
    cluster.process.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
    if (cluster.process.exitCode === null) cluster.process.kill("SIGKILL");
    await exited;
  }
  await rm(cluster.tempDir, { force: true, recursive: true });
}

// ─── Shared cluster + per-test template clones ────────────────────────────────

const TEMPLATE_DB = "journey_template";

/** The single shared cluster, booted once in `before`. */
let sharedCluster: PostgresCluster | null = null;
/** Monotonic counter so each test gets a unique clone database name. */
let cloneCounter = 0;

function baseCluster(): PostgresCluster {
  if (!sharedCluster) throw new Error("shared cluster not booted");
  // A handle bound to the maintenance database "postgres" for CREATE/DROP DATABASE.
  return { ...sharedCluster, dbName: "postgres" };
}

/**
 * Build the pre-migrated template database once: seed the minimal prerequisite
 * schema and apply all four migrations into TEMPLATE_DB. Marked as a template
 * so it cannot be connected to and can be cloned cheaply.
 */
async function buildTemplateDatabase(): Promise<void> {
  const base = baseCluster();
  await sql(base, `DROP DATABASE IF EXISTS ${TEMPLATE_DB}`);
  await sql(base, `CREATE DATABASE ${TEMPLATE_DB}`);
  const template: PostgresCluster = { ...base, dbName: TEMPLATE_DB };
  await seedMinimalPrerequisites(template);
  await applyMigrations(template);
  // Mark as a template and forbid connections so it stays a clean clone source.
  await sql(base, `UPDATE pg_database SET datistemplate = true WHERE datname = '${TEMPLATE_DB}'`);
}

/**
 * Acquire an isolated database for a single test by cloning the pre-migrated
 * template. This replaces the old per-test `startPostgres()`; it is an
 * in-cluster file copy, not a fresh cluster.
 */
async function startPostgres(): Promise<PostgresCluster> {
  const base = baseCluster();
  const dbName = `journey_test_${process.pid}_${cloneCounter++}`;
  await sql(base, `CREATE DATABASE ${dbName} TEMPLATE ${TEMPLATE_DB}`);
  return { ...base, dbName };
}

/**
 * Acquire a fresh EMPTY database (no template). Used only by the two tests that
 * apply migrations step-by-step and therefore must start from bare SQL.
 */
async function startEmptyPostgres(): Promise<PostgresCluster> {
  const base = baseCluster();
  const dbName = `journey_empty_${process.pid}_${cloneCounter++}`;
  await sql(base, `CREATE DATABASE ${dbName}`);
  return { ...base, dbName };
}

/** Release a per-test database: terminate stragglers and drop it. */
async function stopPostgres(cluster: PostgresCluster): Promise<void> {
  const base = baseCluster();
  try {
    await sql(
      base,
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${cluster.dbName}' AND pid <> pg_backend_pid()`,
    );
  } catch {
    // best-effort
  }
  try {
    await sql(base, `DROP DATABASE IF EXISTS ${cluster.dbName}`);
  } catch {
    // best-effort; a leaked clone does not affect correctness
  }
}

// ─── Minimal prerequisite schema ─────────────────────────────────────────────
//
// 2119 requires: public.user_location_preferences, public.location_sessions,
//   public.profiles, public.feature_flags.
// 2103 requires: public.profiles, public.feature_flags.
// 2120 requires all of the above + public.journey_observations (from 2119).
// 2123 requires all of the above + public.journey_segment_revisions (from 2103).
//
// We build the minimal live-compatible schema here. We do NOT apply any live
// migrations; this is a purpose-built prerequisite sandbox.

async function seedMinimalPrerequisites(cluster: PostgresCluster): Promise<void> {
  await sql(cluster, `
    -- auth schema (Supabase convention)
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY);
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
      LANGUAGE sql STABLE AS 'SELECT NULL::uuid';

    -- Roles expected by PostgREST / Supabase
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOLOGIN BYPASSRLS;
      END IF;
    END $$;

    -- profiles (minimal; 2123 requires role column)
    CREATE TABLE IF NOT EXISTS public.profiles (
      id          uuid PRIMARY KEY,
      handle      text NOT NULL UNIQUE,
      role        text NOT NULL DEFAULT 'user',
      account_status text NOT NULL DEFAULT 'active',
      CONSTRAINT profiles_role_check CHECK (role IN ('user', 'admin', 'moderator'))
    );
  `);

  await sql(cluster, `
    -- feature_flags table (minimal; 2103/2119 seed into it)
    CREATE TABLE IF NOT EXISTS public.feature_flags (
      flag        text PRIMARY KEY,
      enabled     boolean NOT NULL DEFAULT false,
      description text,
      metadata    jsonb
    );

    -- user_location_preferences (required by 2119/2120)
    CREATE TABLE IF NOT EXISTS public.user_location_preferences (
      user_id                     uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
      location_mode               text NOT NULL DEFAULT 'city_only',
      sharing_paused              boolean NOT NULL DEFAULT false,
      pulse_visibility            text,
      discovery_visibility        text,
      safe_return_enabled         boolean NOT NULL DEFAULT true,
      trusted_circle_share        boolean NOT NULL DEFAULT false,
      hotel_blur_enabled          boolean NOT NULL DEFAULT true,
      updated_at                  timestamptz NOT NULL DEFAULT now(),
      created_at                  timestamptz NOT NULL DEFAULT now()
    );

    -- location_sessions (required by 2119; must have id/user_id/session_type/started_at/ended_at/expires_at)
    CREATE TABLE IF NOT EXISTS public.location_sessions (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
      session_type text NOT NULL DEFAULT 'safe_return',
      started_at   timestamptz NOT NULL DEFAULT now(),
      ended_at     timestamptz,
      expires_at   timestamptz,
      created_at   timestamptz NOT NULL DEFAULT now()
    );

    -- Seed test profiles
    INSERT INTO auth.users (id) VALUES
      ('${ADMIN_ID}'), ('${USER_ID}'), ('${NON_ADMIN}')
    ON CONFLICT DO NOTHING;

    INSERT INTO public.profiles (id, handle, role) VALUES
      ('${ADMIN_ID}', 'admin_user',   'admin'),
      ('${USER_ID}',  'normal_user',  'user'),
      ('${NON_ADMIN}','non_admin',    'user')
    ON CONFLICT DO NOTHING;

    -- disable_location_sharing flag (global stop; must exist)
    INSERT INTO public.feature_flags (flag, enabled, description) VALUES
      ('disable_location_sharing', false, 'Global location sharing stop')
    ON CONFLICT DO NOTHING;
  `);
}

// ─── Apply all four migrations ────────────────────────────────────────────────

async function applyMigrations(cluster: PostgresCluster): Promise<void> {
  // 2103 has no BEGIN/COMMIT wrapper; run directly
  await execPsql(cluster, ["-f", MIGRATION_2103]);
  // 2119 wraps in BEGIN/COMMIT
  await execPsql(cluster, ["-f", MIGRATION_2119]);
  // 2120 wraps in BEGIN/COMMIT
  await execPsql(cluster, ["-f", MIGRATION_2120]);
  // 2123 wraps in BEGIN/COMMIT
  await execPsql(cluster, ["-f", MIGRATION_2123]);
}

// ─── Authorization helpers ────────────────────────────────────────────────────

/** Bring the system to a fully authorized state for ingest/raw_read/derived_write. */
async function setupAuthorizedState(cluster: PostgresCluster): Promise<{
  stageId: string;
  assignmentId: string;
  sessionId: string;
}> {
  const now = await sql(cluster, "SELECT clock_timestamp()::text");

  // 1. Enable all Journey flags
  await sql(cluster, `
    UPDATE public.feature_flags SET enabled = true
    WHERE flag IN (
      'COMPASS_JOURNEY_ENGINE_ENABLED',
      'COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED',
      'COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED'
    );
    UPDATE public.feature_flags SET enabled = false
    WHERE flag = 'disable_location_sharing';
  `);

  // 2. Set user preferences: live mode, unpaused, no sharing pause
  await sql(cluster, `
    INSERT INTO public.user_location_preferences (
      user_id, location_mode, sharing_paused
    ) VALUES (
      '${USER_ID}', 'live_during_activity', false
    ) ON CONFLICT (user_id) DO UPDATE SET
      location_mode = 'live_during_activity',
      sharing_paused = false,
      journey_observation_enabled = false,
      journey_consent_scope = NULL,
      journey_consent_version = NULL,
      journey_consent_granted_at = NULL,
      journey_consent_revoked_at = NULL;
  `);

  // 3. Grant versioned consent
  await sql(cluster, `SELECT public.set_journey_observation_consent_v1('${USER_ID}', true)`);

  // 4. Configure stage (admin required)
  const stageId = await sql(cluster, `
    SELECT public.configure_journey_shadow_stage_v1(
      '${ADMIN_ID}'::uuid,
      'internal',
      now() - interval '1 minute',
      now() + interval '2 days',
      '${ADMIN_ID}'::uuid,
      clock_timestamp()
    )
  `);

  // 5. Assign user to cohort
  const assignmentId = await sql(cluster, `
    SELECT public.assign_journey_shadow_cohort_v1(
      '${ADMIN_ID}'::uuid,
      '${USER_ID}'::uuid,
      '${stageId}'::uuid,
      now() - interval '30 seconds',
      now() + interval '1 day'
    )
  `);

  // 6. Issue a shadow session
  const issuedSessionId = await sql(cluster, `
    SELECT public.issue_journey_shadow_session_v1(
      '${ADMIN_ID}'::uuid,
      '${assignmentId}'::uuid,
      'live_share',
      now() + interval '1 hour'
    )
  `);

  // 7. Seed fresh HEALTHY retention
  await sql(cluster, `
    UPDATE public.journey_retention_health
    SET last_status = 'HEALTHY',
        last_success_at = clock_timestamp(),
        pending_retry_count = 0,
        oldest_expired_age_ms = 0,
        deletion_lag_ms = 0,
        consecutive_failures = 0,
        last_error = NULL
    WHERE job = 'journey_observation_retention';
  `);

  return {
    stageId,
    assignmentId,
    sessionId: issuedSessionId,
  };
}

/**
 * Insert one derived segment revision through the sole SECURITY DEFINER writer
 * append_journey_segment_revisions_v2 (service_role has no direct INSERT). The
 * session must already be authorized (call setupAuthorizedState first).
 */
async function seedSegment(
  cluster: PostgresCluster,
  sessionId: string,
  opts: {
    id: string;
    segmentKey: string;
    revisionIndex?: number;
    state?: string;
    startedAtIso?: string;
    qualityClass?: string;
    qualityReasons?: string[];
  },
): Promise<void> {
  const row = JSON.stringify([{
    id: opts.id,
    user_id: USER_ID,
    location_session_id: sessionId,
    segment_key: opts.segmentKey,
    revision_index: opts.revisionIndex ?? 0,
    state: opts.state ?? "moving",
    started_at: opts.startedAtIso ?? new Date(Date.now() - 5000).toISOString(),
    world_ref: { countryCode: null, regionId: null, cityId: null, districtId: null, placeId: null },
    movement_class: "walking",
    uncertainty_score: 0.1,
    uncertainty_tier: "low",
    reason_codes: ["good_accuracy"],
    stop_radius_m: 50,
    uncertainty_computed_at: new Date().toISOString(),
    algorithm_version: "v1",
    observation_count: 3,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    quality_version: "journey-segment-quality-v1",
    quality_score: opts.qualityClass === "unusable" ? 0.0 : 0.9,
    quality_class: opts.qualityClass ?? "high",
    quality_reasons: opts.qualityReasons ?? ["good_accuracy"],
  }]);
  const inserted = await sql(
    cluster,
    `SELECT public.append_journey_segment_revisions_v2('${row.replace(/'/g, "''")}'::jsonb)`,
  );
  assert.equal(inserted, "1", `seedSegment(${opts.id}) must insert exactly one row`);
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("Journey Controlled Rollout Migration SQL integration (2103+2119+2120+2123)", { timeout: 280_000, concurrency: 6 }, () => {
  // A single cluster is booted once; the four migrations are applied into a
  // template database. Each test clones the template (fast in-cluster copy)
  // for full isolation, so we pay the expensive initdb/start cost only once.
  before(async () => {
    sharedCluster = await bootCluster();
    await buildTemplateDatabase();
  });

  after(async () => {
    if (sharedCluster) {
      await shutdownCluster(sharedCluster);
      sharedCluster = null;
    }
  });

  // ── Section A: migration applies and replays idempotently ─────────────────

  it("applies all four migrations in order without error", async () => {
    const cluster = await startEmptyPostgres();
    try {
      await seedMinimalPrerequisites(cluster);
      await applyMigrations(cluster);

      // Core tables exist
      for (const table of [
        "public.journey_observations",
        "public.journey_segment_revisions",
        "public.journey_retention_health",
        "public.journey_revocation_jobs",
        "public.journey_shadow_stages",
        "public.journey_shadow_cohort_assignments",
        "public.journey_shadow_session_issuances",
        "public.journey_shadow_ground_truth",
        "public.journey_shadow_qa_reports",
      ]) {
        const exists = await sql(cluster, `SELECT count(*) FROM pg_class WHERE oid = to_regclass('${table}')`);
        assert.equal(exists, "1", `table ${table} must exist after migrations`);
      }
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("replays 2103, 2120, 2123 idempotently (2119 uses CREATE FUNCTION, not OR REPLACE)", async () => {
    const cluster = await startEmptyPostgres();
    try {
      await seedMinimalPrerequisites(cluster);
      await applyMigrations(cluster);

      // Snapshot: flag values before replay
      const flagsBefore = await sql(cluster, `
        SELECT json_agg(json_build_object('flag', flag, 'enabled', enabled) ORDER BY flag)
        FROM public.feature_flags
        WHERE flag LIKE 'COMPASS_JOURNEY%'
      `);

      // Replay 2103 (idempotent via IF NOT EXISTS)
      await execPsql(cluster, ["-f", MIGRATION_2103]);
      // 2119 uses CREATE FUNCTION (not OR REPLACE) so it is NOT safe to replay;
      // skipped here. Tables use IF NOT EXISTS so those are fine.
      // Replay 2120 (idempotent: DROP IF EXISTS, IF NOT EXISTS, ON CONFLICT DO NOTHING)
      await execPsql(cluster, ["-f", MIGRATION_2120]);
      // Replay 2123 (idempotent: OR REPLACE, IF NOT EXISTS, ON CONFLICT DO NOTHING)
      await execPsql(cluster, ["-f", MIGRATION_2123]);

      // Flags must be the same after idempotent replays
      const flagsAfter = await sql(cluster, `
        SELECT json_agg(json_build_object('flag', flag, 'enabled', enabled) ORDER BY flag)
        FROM public.feature_flags
        WHERE flag LIKE 'COMPASS_JOURNEY%'
      `);
      assert.equal(flagsBefore, flagsAfter, "flag state must be unchanged after idempotent replay");
    } finally {
      await stopPostgres(cluster);
    }
  });

  // ── Section B: all Journey flags remain false ──────────────────────────────

  it("all Journey flags are false after every migration", async () => {
    const cluster = await startEmptyPostgres();
    try {
      await seedMinimalPrerequisites(cluster);

      async function assertAllFalse(label: string): Promise<void> {
        const count = await sql(cluster, `
          SELECT count(*)
          FROM public.feature_flags
          WHERE flag IN (
            'COMPASS_JOURNEY_ENGINE_ENABLED',
            'COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED',
            'COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED'
          ) AND enabled = true
        `);
        assert.equal(count, "0", `${label}: Journey flags must all be false`);
      }

      await execPsql(cluster, ["-f", MIGRATION_2103]);
      await assertAllFalse("after 2103");

      await execPsql(cluster, ["-f", MIGRATION_2119]);
      await assertAllFalse("after 2119");

      await execPsql(cluster, ["-f", MIGRATION_2120]);
      await assertAllFalse("after 2120");

      await execPsql(cluster, ["-f", MIGRATION_2123]);
      await assertAllFalse("after 2123");
    } finally {
      await stopPostgres(cluster);
    }
  });

  // ── Section C: non-admin denied from all control RPCs ─────────────────────

  it("non-admin cannot configure stage, assign cohort, issue session, stop, truth, or report", async () => {
    const cluster = await startPostgres();
    try {

      const now = "now()";
      const future2d = "now() + interval '2 days'";

      // configure_journey_shadow_stage_v1 as non-admin
      await assertRaises(cluster, `
        SELECT public.configure_journey_shadow_stage_v1(
          '${NON_ADMIN}'::uuid, 'internal', ${now}, ${future2d},
          '${NON_ADMIN}'::uuid, clock_timestamp()
        )
      `, "non-admin configure stage");

      // First create a valid stage as admin to test downstream RPCs
      const stageId = await sql(cluster, `
        SELECT public.configure_journey_shadow_stage_v1(
          '${ADMIN_ID}'::uuid, 'internal', ${now} - interval '1 min', ${future2d},
          '${ADMIN_ID}'::uuid, clock_timestamp()
        )
      `);

      // Set USER preferences to allow assignment
      await sql(cluster, `
        INSERT INTO public.user_location_preferences (user_id, location_mode, sharing_paused)
        VALUES ('${USER_ID}', 'live_during_activity', false)
        ON CONFLICT DO NOTHING;
      `);
      await sql(cluster, `SELECT public.set_journey_observation_consent_v1('${USER_ID}', true)`);

      const assignmentId = await sql(cluster, `
        SELECT public.assign_journey_shadow_cohort_v1(
          '${ADMIN_ID}'::uuid, '${USER_ID}'::uuid, '${stageId}'::uuid,
          now() - interval '10 sec', now() + interval '1 day'
        )
      `);

      // assign_journey_shadow_cohort_v1 as non-admin
      await assertRaises(cluster, `
        SELECT public.assign_journey_shadow_cohort_v1(
          '${NON_ADMIN}'::uuid, '${USER_ID}'::uuid, '${stageId}'::uuid,
          now(), now() + interval '1 day'
        )
      `, "non-admin assign cohort");

      // issue_journey_shadow_session_v1 as non-admin
      await assertRaises(cluster, `
        SELECT public.issue_journey_shadow_session_v1(
          '${NON_ADMIN}'::uuid, '${assignmentId}'::uuid, 'live_share',
          now() + interval '1 hour'
        )
      `, "non-admin issue session");

      // global_journey_shadow_stop_v1 as non-admin
      await assertRaises(cluster, `
        SELECT public.global_journey_shadow_stop_v1('${NON_ADMIN}'::uuid)
      `, "non-admin global stop");

      // Issue a real session as admin for truth/report testing
      const sessionId = await sql(cluster, `
        SELECT public.issue_journey_shadow_session_v1(
          '${ADMIN_ID}'::uuid, '${assignmentId}'::uuid, 'live_share',
          now() + interval '1 hour'
        )
      `);

      // record_journey_shadow_ground_truth_v1 as non-admin
      await assertRaises(cluster, `
        SELECT public.record_journey_shadow_ground_truth_v1(
          '${NON_ADMIN}'::uuid, '${assignmentId}'::uuid, '${sessionId}'::uuid,
          now(), '{"motion":"walking"}'::jsonb, NULL
        )
      `, "non-admin record ground truth");

      // persist_journey_shadow_qa_report_v1 as non-admin
      await assertRaises(cluster, `
        SELECT public.persist_journey_shadow_qa_report_v1(
          '${NON_ADMIN}'::uuid, '${stageId}'::uuid, 'segment_accuracy',
          now() - interval '1 day', now(), '{"aggregate":1}'::jsonb, NULL
        )
      `, "non-admin persist qa report");

      // revoke_journey_shadow_cohort_v1 as non-admin
      await assertRaises(cluster, `
        SELECT public.revoke_journey_shadow_cohort_v1(
          '${NON_ADMIN}'::uuid, '${assignmentId}'::uuid
        )
      `, "non-admin revoke cohort");
    } finally {
      await stopPostgres(cluster);
    }
  });

  // ── Section D: full authorization path ────────────────────────────────────

  it("authorized ingest returns authorized with all prerequisites satisfied", async () => {
    const cluster = await startPostgres();
    try {

      const { sessionId } = await setupAuthorizedState(cluster);

      // Central authority should return 'authorized' for ingest
      const result = await sql(cluster, `
        SELECT public.journey_shadow_authorize_v1(
          '${USER_ID}'::uuid,
          '${sessionId}'::uuid,
          'ingest',
          clock_timestamp() + interval '1 second',
          'foreground_gps'
        )
      `);
      assert.equal(result, "authorized", "fully authorized ingest must return 'authorized'");

      // raw_read
      const rawRead = await sql(cluster, `
        SELECT public.journey_shadow_authorize_v1(
          '${USER_ID}'::uuid,
          '${sessionId}'::uuid,
          'raw_read',
          NULL,
          NULL
        )
      `);
      assert.equal(rawRead, "authorized", "raw_read must be authorized");

      // derived_write
      const derivedWrite = await sql(cluster, `
        SELECT public.journey_shadow_authorize_v1(
          '${USER_ID}'::uuid,
          '${sessionId}'::uuid,
          'derived_write',
          NULL,
          NULL
        )
      `);
      assert.equal(derivedWrite, "authorized", "derived_write must be authorized");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("denies when master flag is off", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      await sql(cluster, `UPDATE public.feature_flags SET enabled = false WHERE flag = 'COMPASS_JOURNEY_ENGINE_ENABLED'`);

      const result = await sql(cluster, `
        SELECT public.journey_shadow_authorize_v1('${USER_ID}'::uuid, '${sessionId}'::uuid, 'ingest', clock_timestamp(), 'foreground_gps')
      `);
      assert.equal(result, "feature_disabled", "disabled master flag must return feature_disabled");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("denies when ingest flag is off", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      await sql(cluster, `UPDATE public.feature_flags SET enabled = false WHERE flag = 'COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED'`);

      const result = await sql(cluster, `
        SELECT public.journey_shadow_authorize_v1('${USER_ID}'::uuid, '${sessionId}'::uuid, 'ingest', clock_timestamp(), 'foreground_gps')
      `);
      assert.equal(result, "feature_disabled");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("denies when shadow flag is off", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      await sql(cluster, `UPDATE public.feature_flags SET enabled = false WHERE flag = 'COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED'`);

      const result = await sql(cluster, `
        SELECT public.journey_shadow_authorize_v1('${USER_ID}'::uuid, '${sessionId}'::uuid, 'ingest', clock_timestamp(), 'foreground_gps')
      `);
      assert.equal(result, "feature_disabled");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("denies when global stop is on", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      await sql(cluster, `UPDATE public.feature_flags SET enabled = true WHERE flag = 'disable_location_sharing'`);

      const result = await sql(cluster, `
        SELECT public.journey_shadow_authorize_v1('${USER_ID}'::uuid, '${sessionId}'::uuid, 'ingest', clock_timestamp(), 'foreground_gps')
      `);
      assert.equal(result, "feature_disabled");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("denies when no active stage", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      // Deactivate all stages
      await sql(cluster, `UPDATE public.journey_shadow_stages SET is_active = false`);

      const result = await sql(cluster, `
        SELECT public.journey_shadow_authorize_v1('${USER_ID}'::uuid, '${sessionId}'::uuid, 'ingest', clock_timestamp(), 'foreground_gps')
      `);
      assert.equal(result, "feature_disabled");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("denies when consent is revoked", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      // Revoke consent
      await sql(cluster, `SELECT public.set_journey_observation_consent_v1('${USER_ID}', false)`);

      const result = await sql(cluster, `
        SELECT public.journey_shadow_authorize_v1('${USER_ID}'::uuid, '${sessionId}'::uuid, 'ingest', clock_timestamp(), 'foreground_gps')
      `);
      assert.equal(result, "not_authorized");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("denies when sharing is paused", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      await sql(cluster, `UPDATE public.user_location_preferences SET sharing_paused = true WHERE user_id = '${USER_ID}'`);

      const result = await sql(cluster, `
        SELECT public.journey_shadow_authorize_v1('${USER_ID}'::uuid, '${sessionId}'::uuid, 'ingest', clock_timestamp(), 'foreground_gps')
      `);
      assert.equal(result, "not_authorized");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("denies when location mode is non-live", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      await sql(cluster, `UPDATE public.user_location_preferences SET location_mode = 'city_only' WHERE user_id = '${USER_ID}'`);

      const result = await sql(cluster, `
        SELECT public.journey_shadow_authorize_v1('${USER_ID}'::uuid, '${sessionId}'::uuid, 'ingest', clock_timestamp(), 'foreground_gps')
      `);
      assert.equal(result, "not_authorized");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("denies when no active cohort assignment", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId, assignmentId } = await setupAuthorizedState(cluster);

      // Revoke cohort
      await sql(cluster, `
        UPDATE public.journey_shadow_cohort_assignments
        SET revoked_at = now(), revoked_by = '${ADMIN_ID}'
        WHERE id = '${assignmentId}'
      `);

      const result = await sql(cluster, `
        SELECT public.journey_shadow_authorize_v1('${USER_ID}'::uuid, '${sessionId}'::uuid, 'ingest', clock_timestamp(), 'foreground_gps')
      `);
      assert.equal(result, "not_authorized");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("denies when session is ended", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      await sql(cluster, `UPDATE public.location_sessions SET ended_at = now() WHERE id = '${sessionId}'`);

      const result = await sql(cluster, `
        SELECT public.journey_shadow_authorize_v1('${USER_ID}'::uuid, '${sessionId}'::uuid, 'ingest', clock_timestamp(), 'foreground_gps')
      `);
      assert.equal(result, "not_authorized");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("denies when session has wrong owner", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      // Use NON_ADMIN's user_id but the session belongs to USER_ID
      const result = await sql(cluster, `
        SELECT public.journey_shadow_authorize_v1('${NON_ADMIN}'::uuid, '${sessionId}'::uuid, 'ingest', clock_timestamp(), 'foreground_gps')
      `);
      assert.equal(result, "not_authorized");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("denies when retention health is STALE", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      // Make health stale
      await sql(cluster, `
        UPDATE public.journey_retention_health
        SET last_status = 'STALE', last_success_at = NULL
        WHERE job = 'journey_observation_retention'
      `);

      const result = await sql(cluster, `
        SELECT public.journey_shadow_authorize_v1('${USER_ID}'::uuid, '${sessionId}'::uuid, 'ingest', clock_timestamp(), 'foreground_gps')
      `);
      assert.equal(result, "temporarily_unavailable");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("denies when retention health success is older than 10 minutes", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      await sql(cluster, `
        UPDATE public.journey_retention_health
        SET last_success_at = clock_timestamp() - interval '11 minutes'
        WHERE job = 'journey_observation_retention'
      `);

      const result = await sql(cluster, `
        SELECT public.journey_shadow_authorize_v1('${USER_ID}'::uuid, '${sessionId}'::uuid, 'ingest', clock_timestamp(), 'foreground_gps')
      `);
      assert.equal(result, "temporarily_unavailable");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("denies when retention health has pending retries", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      await sql(cluster, `
        UPDATE public.journey_retention_health
        SET pending_retry_count = 1
        WHERE job = 'journey_observation_retention'
      `);

      const result = await sql(cluster, `
        SELECT public.journey_shadow_authorize_v1('${USER_ID}'::uuid, '${sessionId}'::uuid, 'ingest', clock_timestamp(), 'foreground_gps')
      `);
      assert.equal(result, "temporarily_unavailable");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("denies when observed_at is outside session window", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      // observed_at before session started_at
      const result = await sql(cluster, `
        SELECT public.journey_shadow_authorize_v1(
          '${USER_ID}'::uuid, '${sessionId}'::uuid, 'ingest',
          now() - interval '25 hours',
          'foreground_gps'
        )
      `);
      assert.equal(result, "not_authorized");
    } finally {
      await stopPostgres(cluster);
    }
  });

  // ── Section E: direct INSERT denied; v1 writer denied ────────────────────

  it("direct service_role INSERT into journey_observations is denied", async () => {
    const cluster = await startPostgres();
    try {

      // Create a location session to reference
      await sql(cluster, `
        INSERT INTO public.location_sessions (id, user_id, session_type)
        VALUES ('${SESSION_ID}', '${USER_ID}', 'live_share')
        ON CONFLICT DO NOTHING
      `);

      await assertRaises(cluster, `
        SET ROLE service_role;
        INSERT INTO public.journey_observations (
          user_id, location_session_id, observed_at, source,
          lat, lng, accuracy_m, consent_scope, idempotency_key, trust_class
        ) VALUES (
          '${USER_ID}', '${SESSION_ID}', now(), 'foreground_gps',
          10.3, 123.9, 5.0, 'journey_observation_v1', 'test-key-1', 'accepted'
        )
      `, "direct INSERT into journey_observations must be denied");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("direct service_role INSERT into journey_segment_revisions is denied", async () => {
    const cluster = await startPostgres();
    try {

      await assertRaises(cluster, `
        SET ROLE service_role;
        INSERT INTO public.journey_segment_revisions (
          id, user_id, location_session_id, segment_key, revision_index, state,
          started_at, world_ref, movement_class, uncertainty_score, uncertainty_tier,
          reason_codes, stop_radius_m, uncertainty_computed_at, algorithm_version,
          observation_count, expires_at
        ) VALUES (
          gen_random_uuid(), '${USER_ID}', '${SESSION_ID}', gen_random_uuid(),
          0, 'moving', now(),
          '{"countryCode":null,"regionId":null,"cityId":null,"districtId":null,"placeId":null}',
          'unknown', 0.1, 'low', ARRAY['good_accuracy'], 50, now(), 'v1', 1,
          now() + interval '1 day'
        )
      `, "direct INSERT into journey_segment_revisions must be denied");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("direct INSERT into journey_shadow_stages is denied", async () => {
    const cluster = await startPostgres();
    try {

      await assertRaises(cluster, `
        SET ROLE service_role;
        INSERT INTO public.journey_shadow_stages (stage, starts_at, ends_at, approved_by, approved_at)
        VALUES ('internal', now(), now() + interval '1 day', '${ADMIN_ID}', now())
      `, "direct INSERT into journey_shadow_stages must be denied");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("direct INSERT into journey_shadow_cohort_assignments is denied", async () => {
    const cluster = await startPostgres();
    try {

      // Need a stage first
      const stageId = await sql(cluster, `
        SELECT public.configure_journey_shadow_stage_v1(
          '${ADMIN_ID}'::uuid, 'internal', now() - interval '1 min', now() + interval '1 day',
          '${ADMIN_ID}'::uuid, clock_timestamp()
        )
      `);

      await assertRaises(cluster, `
        SET ROLE service_role;
        INSERT INTO public.journey_shadow_cohort_assignments (user_id, stage_id, assigned_by, cohort_starts_at, cohort_ends_at)
        VALUES ('${USER_ID}', '${stageId}', '${ADMIN_ID}', now(), now() + interval '1 day')
      `, "direct INSERT into journey_shadow_cohort_assignments must be denied");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("ingest_journey_observation_v1 RPC is revoked from service_role (v1 denied)", async () => {
    const cluster = await startPostgres();
    try {

      await assertRaises(cluster, `
        SET ROLE service_role;
        SELECT public.ingest_journey_observation_v1(
          '${USER_ID}', '${SESSION_ID}', 1::smallint, now(), 'foreground_gps',
          10.3, 123.9, 5.0, NULL, NULL, NULL,
          'journey_observation_v1', 'test-key-v1', 'accepted'
        )
      `, "v1 ingest RPC must be denied after 2123");
    } finally {
      await stopPostgres(cluster);
    }
  });

  // ── Section F: v2 quality validation ──────────────────────────────────────

  it("v2 ingest rejects missing quality fields", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      // quality_version missing (NULL) fails closed with the uniform public
      // denial result rather than leaking which field was invalid.
      const result = await sql(cluster, `
        SELECT public.ingest_journey_observation_v2(
          '${USER_ID}', '${sessionId}', 1::smallint, now() + interval '1 second',
          'foreground_gps', 10.3, 123.9, 5.0, NULL, NULL, NULL,
          'journey_observation_v1', 'quality-test-1', 'accepted',
          NULL, 0.9, 'high', ARRAY[]::text[]
        )
      `);
      assert.equal(result, "not_authorized");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("v2 ingest rejects wrong quality_version string", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      const result = await sql(cluster, `
        SELECT public.ingest_journey_observation_v2(
          '${USER_ID}', '${sessionId}', 1::smallint, now() + interval '1 second',
          'foreground_gps', 10.3, 123.9, 5.0, NULL, NULL, NULL,
          'journey_observation_v1', 'quality-test-2', 'accepted',
          'journey-observation-quality-v99', 0.9, 'high', ARRAY[]::text[]
        )
      `);
      // Should return 'not_authorized' or similar denial for wrong version
      assert.notEqual(result, "accepted", "wrong quality_version must not be accepted");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("v2 ingest rejects quality_score out of range", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      const result = await sql(cluster, `
        SELECT public.ingest_journey_observation_v2(
          '${USER_ID}', '${sessionId}', 1::smallint, now() + interval '1 second',
          'foreground_gps', 10.3, 123.9, 5.0, NULL, NULL, NULL,
          'journey_observation_v1', 'quality-test-3', 'accepted',
          'journey-observation-quality-v1', 1.5, 'high', ARRAY[]::text[]
        )
      `);
      assert.equal(result, "not_authorized");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("v2 ingest accepts unusable quality class and persists the row for QA distribution measurement", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      // unusable IS accepted: persisted so retention/QA/report aggregate paths
      // can measure stale/poor-accuracy/impossible-speed failure-mode distributions.
      // Segmentation excludes unusable at read time via .neq("quality_class", "unusable").
      const result = await sql(cluster, `
        SELECT public.ingest_journey_observation_v2(
          '${USER_ID}', '${sessionId}', 1::smallint, now() + interval '1 second',
          'foreground_gps', 10.3, 123.9, 5.0, NULL, NULL, NULL,
          'journey_observation_v1', 'quality-test-4', 'accepted',
          'journey-observation-quality-v1', 0.1, 'unusable', ARRAY['poor_accuracy']::text[]
        )
      `);
      assert.equal(result, "accepted", "unusable quality class must be accepted for distribution measurement");

      // Verify the row is actually persisted with unusable class
      const storedClass = await sql(cluster, `
        SELECT quality_class FROM public.journey_observations
        WHERE user_id = '${USER_ID}' AND idempotency_key = 'quality-test-4'
      `);
      assert.equal(storedClass, "unusable", "unusable quality_class must be stored verbatim");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("v2 ingest rejects unknown quality class (not in allowed set)", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      const result = await sql(cluster, `
        SELECT public.ingest_journey_observation_v2(
          '${USER_ID}', '${sessionId}', 1::smallint, now() + interval '1 second',
          'foreground_gps', 10.3, 123.9, 5.0, NULL, NULL, NULL,
          'journey_observation_v1', 'quality-test-unknown', 'accepted',
          'journey-observation-quality-v1', 0.1, 'unknown_class', ARRAY[]::text[]
        )
      `);
      assert.notEqual(result, "accepted", "unknown quality class must not be accepted");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("v2 ingest with valid quality fields is persisted and quality columns are stored", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      const result = await sql(cluster, `
        SELECT public.ingest_journey_observation_v2(
          '${USER_ID}', '${sessionId}', 1::smallint, now() + interval '1 second',
          'foreground_gps', 10.3, 123.9, 5.0, NULL, NULL, NULL,
          'journey_observation_v1', 'quality-test-ok-1', 'accepted',
          'journey-observation-quality-v1', 0.85, 'high', ARRAY['good_accuracy']::text[]
        )
      `);
      assert.equal(result, "accepted", "v2 ingest with valid quality must return accepted");

      // Verify quality columns stored
      const qualityVersion = await sql(cluster, `
        SELECT quality_version FROM public.journey_observations
        WHERE user_id = '${USER_ID}' AND idempotency_key = 'quality-test-ok-1'
      `);
      assert.equal(qualityVersion, "journey-observation-quality-v1", "quality_version must be stored");

      const qualityScore = await sql(cluster, `
        SELECT quality_score FROM public.journey_observations
        WHERE user_id = '${USER_ID}' AND idempotency_key = 'quality-test-ok-1'
      `);
      assert.equal(qualityScore, "0.85", "quality_score must be stored");
    } finally {
      await stopPostgres(cluster);
    }
  });

  // ── Section G: append v2 revision safety, idempotency, deep forbidden keys ─

  it("append_journey_segment_revisions_v2 is idempotent (ON CONFLICT id DO NOTHING)", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      const segId = "aabbccdd-0001-4000-8000-000000000001";
      const segKey = "aabbccdd-0002-4000-8000-000000000001";
      const row = JSON.stringify([{
        id: segId,
        user_id: USER_ID,
        location_session_id: sessionId,
        segment_key: segKey,
        revision_index: 0,
        state: "moving",
        started_at: new Date(Date.now() - 5000).toISOString(),
        world_ref: { countryCode: null, regionId: null, cityId: null, districtId: null, placeId: null },
        movement_class: "walking",
        uncertainty_score: 0.1,
        uncertainty_tier: "low",
        reason_codes: ["good_accuracy"],
        stop_radius_m: 50,
        uncertainty_computed_at: new Date().toISOString(),
        algorithm_version: "v1",
        observation_count: 3,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      }]);

      const first = await sql(cluster, `SELECT public.append_journey_segment_revisions_v2('${row.replace(/'/g, "''")}'::jsonb)`);
      assert.equal(first, "1", "first append must insert 1 row");

      const second = await sql(cluster, `SELECT public.append_journey_segment_revisions_v2('${row.replace(/'/g, "''")}'::jsonb)`);
      assert.equal(second, "0", "second append of same id must return 0 (idempotent)");

      const count = await sql(cluster, `SELECT count(*) FROM public.journey_segment_revisions WHERE id = '${segId}'`);
      assert.equal(count, "1", "exactly one row must exist");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("append_journey_segment_revisions_v2 rejects deep forbidden coordinate keys", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      const segId = "aabbccdd-0003-4000-8000-000000000001";
      const segKey = "aabbccdd-0004-4000-8000-000000000001";
      // timing_uncertainty has nested 'lat' key
      const row = JSON.stringify([{
        id: segId,
        user_id: USER_ID,
        location_session_id: sessionId,
        segment_key: segKey,
        revision_index: 0,
        state: "moving",
        started_at: new Date(Date.now() - 5000).toISOString(),
        world_ref: { countryCode: null, regionId: null, cityId: null, districtId: null, placeId: null },
        movement_class: "walking",
        uncertainty_score: 0.1,
        uncertainty_tier: "low",
        reason_codes: ["good_accuracy"],
        stop_radius_m: 50,
        uncertainty_computed_at: new Date().toISOString(),
        algorithm_version: "v1",
        observation_count: 3,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        timing_uncertainty: { lat: 10.3, lng: 123.9 },
      }]);

      await assertRaises(cluster, `SELECT public.append_journey_segment_revisions_v2('${row.replace(/'/g, "''")}'::jsonb)`,
        "append with forbidden lat key in timing_uncertainty must be rejected");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("append_journey_segment_revisions_v2 rejects unsupported field names", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      const row = JSON.stringify([{
        id: "aabbccdd-0005-4000-8000-000000000001",
        user_id: USER_ID,
        location_session_id: sessionId,
        segment_key: "aabbccdd-0006-4000-8000-000000000001",
        revision_index: 0,
        state: "moving",
        started_at: new Date(Date.now() - 5000).toISOString(),
        world_ref: { countryCode: null, regionId: null, cityId: null, districtId: null, placeId: null },
        movement_class: "walking",
        uncertainty_score: 0.1,
        uncertainty_tier: "low",
        reason_codes: ["good_accuracy"],
        stop_radius_m: 50,
        uncertainty_computed_at: new Date().toISOString(),
        algorithm_version: "v1",
        observation_count: 3,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        forbidden_field: "oops",
      }]);

      await assertRaises(cluster, `SELECT public.append_journey_segment_revisions_v2('${row.replace(/'/g, "''")}'::jsonb)`,
        "append with unsupported field must be rejected");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("append_journey_segment_revisions_v2 denied when not authorized", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      // Disable all flags — makes authorization fail
      await sql(cluster, `UPDATE public.feature_flags SET enabled = false WHERE flag LIKE 'COMPASS_JOURNEY%'`);

      const row = JSON.stringify([{
        id: "aabbccdd-0007-4000-8000-000000000001",
        user_id: USER_ID,
        location_session_id: sessionId,
        segment_key: "aabbccdd-0008-4000-8000-000000000001",
        revision_index: 0,
        state: "moving",
        started_at: new Date(Date.now() - 5000).toISOString(),
        world_ref: { countryCode: null, regionId: null, cityId: null, districtId: null, placeId: null },
        movement_class: "walking",
        uncertainty_score: 0.1,
        uncertainty_tier: "low",
        reason_codes: ["good_accuracy"],
        stop_radius_m: 50,
        uncertainty_computed_at: new Date().toISOString(),
        algorithm_version: "v1",
        observation_count: 3,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      }]);

      await assertRaises(cluster, `SELECT public.append_journey_segment_revisions_v2('${row.replace(/'/g, "''")}'::jsonb)`,
        "append when flags disabled must raise");
    } finally {
      await stopPostgres(cluster);
    }
  });

  // ── Section H: cohort revoke atomically cleans up ─────────────────────────

  it("revoke_journey_shadow_cohort_v1 atomically ends issuance/session and erases raw+derived", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId, assignmentId } = await setupAuthorizedState(cluster);

      // Ingest one observation
      await sql(cluster, `
        SELECT public.ingest_journey_observation_v2(
          '${USER_ID}', '${sessionId}', 1::smallint, now() + interval '1 second',
          'foreground_gps', 10.3, 123.9, 5.0, NULL, NULL, NULL,
          'journey_observation_v1', 'revoke-test-obs-1', 'accepted',
          'journey-observation-quality-v1', 0.9, 'high', ARRAY[]::text[]
        )
      `);

      // Append one segment
      const segRow = JSON.stringify([{
        id: "ccdd0001-0000-4000-8000-000000000001",
        user_id: USER_ID,
        location_session_id: sessionId,
        segment_key: "ccdd0002-0000-4000-8000-000000000001",
        revision_index: 0,
        state: "moving",
        started_at: new Date(Date.now() - 5000).toISOString(),
        world_ref: { countryCode: null, regionId: null, cityId: null, districtId: null, placeId: null },
        movement_class: "walking",
        uncertainty_score: 0.1,
        uncertainty_tier: "low",
        reason_codes: ["good_accuracy"],
        stop_radius_m: 50,
        uncertainty_computed_at: new Date().toISOString(),
        algorithm_version: "v1",
        observation_count: 3,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      }]);
      await sql(cluster, `SELECT public.append_journey_segment_revisions_v2('${segRow.replace(/'/g, "''")}'::jsonb)`);

      // Record ground truth for this assignment (must be deleted by revoke)
      await sql(cluster, `
        SELECT public.record_journey_shadow_ground_truth_v1(
          '${ADMIN_ID}'::uuid, '${assignmentId}'::uuid, '${sessionId}'::uuid,
          now(), '{"motion":"stationary"}'::jsonb, 'cohort-revoke truth'
        )
      `);

      // Verify data exists before revoke
      const obsBefore = await sql(cluster, `SELECT count(*) FROM public.journey_observations WHERE user_id = '${USER_ID}'`);
      assert.equal(obsBefore, "1", "observation must exist before revoke");
      const segBefore = await sql(cluster, `SELECT count(*) FROM public.journey_segment_revisions WHERE user_id = '${USER_ID}'`);
      assert.equal(segBefore, "1", "segment must exist before revoke");
      const truthBefore = await sql(cluster, `SELECT count(*) FROM public.journey_shadow_ground_truth WHERE assignment_id = '${assignmentId}'`);
      assert.equal(truthBefore, "1", "ground truth must exist before revoke");

      // Revoke cohort
      const revoked = await sql(cluster, `SELECT public.revoke_journey_shadow_cohort_v1('${ADMIN_ID}', '${assignmentId}')`);
      assert.equal(revoked, "t", "revoke must return true");

      // Observations erased
      const obsAfter = await sql(cluster, `SELECT count(*) FROM public.journey_observations WHERE user_id = '${USER_ID}'`);
      assert.equal(obsAfter, "0", "observations must be erased after cohort revoke");

      // Segments erased
      const segAfter = await sql(cluster, `SELECT count(*) FROM public.journey_segment_revisions WHERE user_id = '${USER_ID}'`);
      assert.equal(segAfter, "0", "segments must be erased after cohort revoke");

      // Ground truth for this assignment erased
      const truthAfter = await sql(cluster, `SELECT count(*) FROM public.journey_shadow_ground_truth WHERE assignment_id = '${assignmentId}'`);
      assert.equal(truthAfter, "0", "ground truth must be erased after cohort revoke");

      // Session ended
      const sessionEnded = await sql(cluster, `SELECT ended_at IS NOT NULL FROM public.location_sessions WHERE id = '${sessionId}'`);
      assert.equal(sessionEnded, "t", "session must have ended_at set after cohort revoke");

      // Issuance revoked
      const issuanceRevoked = await sql(cluster, `SELECT revoked_at IS NOT NULL FROM public.journey_shadow_session_issuances WHERE assignment_id = '${assignmentId}'`);
      assert.equal(issuanceRevoked, "t", "issuance must be revoked");

      // Assignment revoked (history row remains, marked revoked — not deleted)
      const assignmentRevoked = await sql(cluster, `SELECT revoked_at IS NOT NULL FROM public.journey_shadow_cohort_assignments WHERE id = '${assignmentId}'`);
      assert.equal(assignmentRevoked, "t", "assignment must be revoked");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("revoke_journey_consent_and_delete_segments physically deletes assignment + ground truth without FK failures", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId, assignmentId } = await setupAuthorizedState(cluster);

      // Ingest observation
      await sql(cluster, `
        SELECT public.ingest_journey_observation_v2(
          '${USER_ID}', '${sessionId}', 1::smallint, now() + interval '1 second',
          'foreground_gps', 10.3, 123.9, 5.0, NULL, NULL, NULL,
          'journey_observation_v1', 'account-del-obs-1', 'accepted',
          'journey-observation-quality-v1', 0.9, 'high', ARRAY[]::text[]
        )
      `);

      // Record a ground-truth row so we can prove it is erased on account deletion
      await sql(cluster, `
        SELECT public.record_journey_shadow_ground_truth_v1(
          '${ADMIN_ID}'::uuid, '${assignmentId}'::uuid, '${sessionId}'::uuid,
          now(), '{"motion":"walking"}'::jsonb, 'account-del truth'
        )
      `);
      const truthBefore = await sql(cluster, `SELECT count(*) FROM public.journey_shadow_ground_truth WHERE user_id = '${USER_ID}'`);
      assert.equal(truthBefore, "1", "ground truth must exist before account deletion");

      // Call account deletion erasure function
      const deletedCount = await sql(cluster, `
        SELECT public.revoke_journey_consent_and_delete_segments(
          '${USER_ID}',
          '{"location_mode":"off","journey_observation_enabled":false}'::jsonb
        )
      `);
      // Should not raise FK errors and returns an integer segment count
      assert.ok(
        !isNaN(Number(deletedCount)),
        "account deletion function must return integer count without FK error",
      );

      // Cohort assignment rows are PHYSICALLY DELETED (profile tombstone path),
      // not merely revoked — the account-deletion boundary erases them.
      const assignmentRows = await sql(cluster, `
        SELECT count(*)
        FROM public.journey_shadow_cohort_assignments
        WHERE user_id = '${USER_ID}'
      `);
      assert.equal(assignmentRows, "0", "assignment rows must be physically deleted by account deletion");

      // Issuances cascade-deleted along with the assignment
      const issuanceRows = await sql(cluster, `
        SELECT count(*) FROM public.journey_shadow_session_issuances
        WHERE assignment_id = '${assignmentId}'
      `);
      assert.equal(issuanceRows, "0", "issuances must cascade-delete with the assignment");

      // Ground truth erased for the user
      const truthAfter = await sql(cluster, `SELECT count(*) FROM public.journey_shadow_ground_truth WHERE user_id = '${USER_ID}'`);
      assert.equal(truthAfter, "0", "ground truth must be erased by account deletion");

      // Observations erased
      const obsCount = await sql(cluster, `SELECT count(*) FROM public.journey_observations WHERE user_id = '${USER_ID}'`);
      assert.equal(obsCount, "0", "observations must be erased by account deletion");

      // Open journey session ended
      const sessionEnded = await sql(cluster, `SELECT ended_at IS NOT NULL FROM public.location_sessions WHERE id = '${sessionId}'`);
      assert.equal(sessionEnded, "t", "journey session must be ended by account deletion");
    } finally {
      await stopPostgres(cluster);
    }
  });

  // ── Section I: global stop ────────────────────────────────────────────────

  it("global_journey_shadow_stop_v1 disables flags, stops stages, revokes cohorts, ends sessions, erases raw+derived", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId, assignmentId } = await setupAuthorizedState(cluster);

      // Ingest one observation and one segment
      const ingestResult = await sql(cluster, `
        SELECT public.ingest_journey_observation_v2(
          '${USER_ID}', '${sessionId}', 1::smallint, now() + interval '1 second',
          'foreground_gps', 10.3, 123.9, 5.0, NULL, NULL, NULL,
          'journey_observation_v1', 'global-stop-obs-1', 'accepted',
          'journey-observation-quality-v1', 0.9, 'high', ARRAY[]::text[]
        )
      `);
      assert.equal(ingestResult, "accepted", "observation ingest must be accepted before global stop");
      const obsSeeded = await sql(cluster, `SELECT count(*) FROM public.journey_observations WHERE user_id = '${USER_ID}'`);
      assert.equal(obsSeeded, "1", "observation must be persisted before global stop");

      const segRow = JSON.stringify([{
        id: "dd000001-0000-4000-8000-000000000001",
        user_id: USER_ID,
        location_session_id: sessionId,
        segment_key: "dd000002-0000-4000-8000-000000000001",
        revision_index: 0,
        state: "moving",
        started_at: new Date(Date.now() - 5000).toISOString(),
        world_ref: { countryCode: null, regionId: null, cityId: null, districtId: null, placeId: null },
        movement_class: "walking",
        uncertainty_score: 0.1,
        uncertainty_tier: "low",
        reason_codes: ["good_accuracy"],
        stop_radius_m: 50,
        uncertainty_computed_at: new Date().toISOString(),
        algorithm_version: "v1",
        observation_count: 3,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      }]);
      await sql(cluster, `SELECT public.append_journey_segment_revisions_v2('${segRow.replace(/'/g, "''")}'::jsonb)`);

      // Record a ground-truth row so global stop can prove it is erased too
      await sql(cluster, `
        SELECT public.record_journey_shadow_ground_truth_v1(
          '${ADMIN_ID}'::uuid, '${assignmentId}'::uuid, '${sessionId}'::uuid,
          now(), '{"motion":"driving"}'::jsonb, 'global-stop truth'
        )
      `);

      // Execute global stop
      const resultJson = await sql(cluster, `SELECT public.global_journey_shadow_stop_v1('${ADMIN_ID}')`);
      const result = JSON.parse(resultJson);

      assert.ok(result.flags_disabled >= 1, "global stop must disable at least one flag");
      assert.ok(result.stages_stopped >= 1, "global stop must stop at least one stage");
      assert.ok(result.assignments_revoked >= 1, "global stop must revoke at least one assignment");
      assert.ok(result.sessions_ended >= 1, "global stop must end at least one session");
      assert.ok(result.observations_deleted >= 1, "global stop must delete at least one observation");
      assert.ok(result.segments_deleted >= 1, "global stop must delete at least one segment");
      assert.ok(result.ground_truth_deleted >= 1, "global stop must delete at least one ground-truth row");

      // Verify flags are disabled
      const enabledFlagCount = await sql(cluster, `
        SELECT count(*) FROM public.feature_flags
        WHERE flag IN (
          'COMPASS_JOURNEY_ENGINE_ENABLED',
          'COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED',
          'COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED'
        ) AND enabled = true
      `);
      assert.equal(enabledFlagCount, "0", "all Journey flags must be disabled after global stop");

      // Verify no active stages
      const activeStages = await sql(cluster, `SELECT count(*) FROM public.journey_shadow_stages WHERE is_active = true`);
      assert.equal(activeStages, "0", "no stages must be active after global stop");

      // Verify no observations or segments
      const obsCount = await sql(cluster, `SELECT count(*) FROM public.journey_observations`);
      assert.equal(obsCount, "0", "no observations must remain after global stop");

      const segCount = await sql(cluster, `SELECT count(*) FROM public.journey_segment_revisions`);
      assert.equal(segCount, "0", "no segments must remain after global stop");

      const truthCount = await sql(cluster, `SELECT count(*) FROM public.journey_shadow_ground_truth`);
      assert.equal(truthCount, "0", "no ground-truth rows must remain after global stop");
    } finally {
      await stopPostgres(cluster);
    }
  });

  // ── Section J: retention cycle v2 with per-table counts ───────────────────

  it("finish_journey_retention_cycle_v2 stores all three purge counts with lease-token semantics", async () => {
    const cluster = await startPostgres();
    try {

      const now = new Date().toISOString();

      // Claim a retention cycle
      const cycleToken = await sql(cluster, `
        SELECT public.begin_journey_retention_cycle_v1('test-worker', '${now}'::timestamptz, 120)
      `);
      assert.ok(cycleToken && cycleToken.length > 0, "cycle token must be returned");

      // Finish with per-table counts
      const finished = await sql(cluster, `
        SELECT public.finish_journey_retention_cycle_v2(
          '${cycleToken}'::uuid,
          clock_timestamp(),
          'HEALTHY',
          15, 0, 0, 0, 0, NULL,
          10, 4, 1
        )
      `);
      assert.equal(finished, "t", "finish_journey_retention_cycle_v2 must return true");

      // Verify per-table counts stored
      const obsCount = await sql(cluster, `SELECT last_observation_deleted_count FROM public.journey_retention_health WHERE job = 'journey_observation_retention'`);
      assert.equal(obsCount, "10", "observation deleted count must be stored");

      const segCount = await sql(cluster, `SELECT last_segment_deleted_count FROM public.journey_retention_health WHERE job = 'journey_observation_retention'`);
      assert.equal(segCount, "4", "segment deleted count must be stored");

      const truthCount = await sql(cluster, `SELECT last_ground_truth_deleted_count FROM public.journey_retention_health WHERE job = 'journey_observation_retention'`);
      assert.equal(truthCount, "1", "ground truth deleted count must be stored");

      const status = await sql(cluster, `SELECT last_status FROM public.journey_retention_health WHERE job = 'journey_observation_retention'`);
      assert.equal(status, "HEALTHY", "health status must be HEALTHY");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("finish_journey_retention_cycle_v2 respects lease-token: stale token returns false", async () => {
    const cluster = await startPostgres();
    try {

      const now = new Date().toISOString();
      await sql(cluster, `SELECT public.begin_journey_retention_cycle_v1('test-worker', '${now}'::timestamptz, 120)`);

      const fakeToken = "ffffffff-ffff-4000-8000-ffffffffffff";
      const finished = await sql(cluster, `
        SELECT public.finish_journey_retention_cycle_v2(
          '${fakeToken}'::uuid,
          clock_timestamp(),
          'HEALTHY',
          0, 0, 0, 0, 0, NULL,
          0, 0, 0
        )
      `);
      assert.equal(finished, "f", "wrong lease token must return false");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("raw observation expires_at and segment expires_at are bounded within limits", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      // Valid observation: expires_at within 72h
      const result = await sql(cluster, `
        SELECT public.ingest_journey_observation_v2(
          '${USER_ID}', '${sessionId}', 1::smallint, now() + interval '1 second',
          'foreground_gps', 10.3, 123.9, 5.0, NULL, NULL, NULL,
          'journey_observation_v1', 'expiry-test-obs-1', 'accepted',
          'journey-observation-quality-v1', 0.9, 'high', ARRAY[]::text[]
        )
      `);
      assert.equal(result, "accepted");

      // Observation expires_at stored as received_at + 24h (per 2119/2120 ingest logic)
      const expiryGap = await sql(cluster, `
        SELECT (expires_at - received_at) <= interval '24 hours' AND expires_at > received_at
        FROM public.journey_observations WHERE idempotency_key = 'expiry-test-obs-1'
      `);
      assert.equal(expiryGap, "t", "observation expires_at must be within 24h of received_at");
    } finally {
      await stopPostgres(cluster);
    }
  });

  // ── Section K: ground truth validation ────────────────────────────────────

  it("record_journey_shadow_ground_truth_v1 requires session to belong to assignment", async () => {
    const cluster = await startPostgres();
    try {
      const { assignmentId } = await setupAuthorizedState(cluster);

      // Use a random session ID that does NOT belong to this assignment
      const randomSessionId = "eeff0001-0000-4000-8000-000000000001";

      await assertRaises(cluster, `
        SELECT public.record_journey_shadow_ground_truth_v1(
          '${ADMIN_ID}'::uuid, '${assignmentId}'::uuid, '${randomSessionId}'::uuid,
          now(), '{"motion":"walking"}'::jsonb, NULL
        )
      `, "ground truth with wrong session must raise");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("record_journey_shadow_ground_truth_v1 rejects coordinate keys in ground_truth payload", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId, assignmentId } = await setupAuthorizedState(cluster);

      await assertRaises(cluster, `
        SELECT public.record_journey_shadow_ground_truth_v1(
          '${ADMIN_ID}'::uuid, '${assignmentId}'::uuid, '${sessionId}'::uuid,
          now(), '{"lat":10.3,"lng":123.9}'::jsonb, NULL
        )
      `, "ground truth with lat/lng keys must raise");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("record_journey_shadow_ground_truth_v1 rejects raw_id keys", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId, assignmentId } = await setupAuthorizedState(cluster);

      await assertRaises(cluster, `
        SELECT public.record_journey_shadow_ground_truth_v1(
          '${ADMIN_ID}'::uuid, '${assignmentId}'::uuid, '${sessionId}'::uuid,
          now(), '{"observation_id":"some-id"}'::jsonb, NULL
        )
      `, "ground truth with observation_id key must raise");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("record_journey_shadow_ground_truth_v1 persists valid ground truth", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId, assignmentId } = await setupAuthorizedState(cluster);

      const truthId = await sql(cluster, `
        SELECT public.record_journey_shadow_ground_truth_v1(
          '${ADMIN_ID}'::uuid, '${assignmentId}'::uuid, '${sessionId}'::uuid,
          now(), '{"motion":"walking","duration_s":300}'::jsonb, 'test notes'
        )
      `);
      assert.ok(truthId && truthId.length > 0, "must return a UUID for inserted truth");

      const count = await sql(cluster, `SELECT count(*) FROM public.journey_shadow_ground_truth WHERE id = '${truthId}'`);
      assert.equal(count, "1", "truth record must be stored");

      // expires_at must be 30 days from submitted_at
      const expiryOk = await sql(cluster, `
        SELECT (expires_at - submitted_at) = interval '30 days'
        FROM public.journey_shadow_ground_truth WHERE id = '${truthId}'
      `);
      assert.equal(expiryOk, "t", "ground truth expires_at must be exactly 30 days after submitted_at");
    } finally {
      await stopPostgres(cluster);
    }
  });

  // ── Section L: FORCE RLS — no user row access ─────────────────────────────

  it("journey_shadow_stages has FORCE ROW LEVEL SECURITY with no authenticated SELECT policy", async () => {
    const cluster = await startPostgres();
    try {

      // Verify FORCE RLS is set
      const forceRls = await sql(cluster, `
        SELECT relforcerowsecurity
        FROM pg_class
        WHERE oid = 'public.journey_shadow_stages'::regclass
      `);
      assert.equal(forceRls, "t", "journey_shadow_stages must have FORCE ROW LEVEL SECURITY");

      // Verify no RLS policies exist (service-only means no anon/authenticated policies)
      const policyCount = await sql(cluster, `
        SELECT count(*)
        FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'journey_shadow_stages'
      `);
      assert.equal(policyCount, "0", "journey_shadow_stages must have no RLS policies (service-only)");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("journey_shadow_cohort_assignments has FORCE ROW LEVEL SECURITY", async () => {
    const cluster = await startPostgres();
    try {

      const forceRls = await sql(cluster, `
        SELECT relforcerowsecurity
        FROM pg_class
        WHERE oid = 'public.journey_shadow_cohort_assignments'::regclass
      `);
      assert.equal(forceRls, "t", "journey_shadow_cohort_assignments must have FORCE ROW LEVEL SECURITY");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("journey_observations has FORCE ROW LEVEL SECURITY", async () => {
    const cluster = await startPostgres();
    try {

      const forceRls = await sql(cluster, `
        SELECT relforcerowsecurity
        FROM pg_class
        WHERE oid = 'public.journey_observations'::regclass
      `);
      assert.equal(forceRls, "t", "journey_observations must have FORCE ROW LEVEL SECURITY");
    } finally {
      await stopPostgres(cluster);
    }
  });

  // ── Section M: partial unique index on active assignments ─────────────────

  it("only one active assignment per user per stage (partial unique index)", async () => {
    const cluster = await startPostgres();
    try {

      await sql(cluster, `
        INSERT INTO public.user_location_preferences (user_id, location_mode, sharing_paused)
        VALUES ('${USER_ID}', 'live_during_activity', false)
        ON CONFLICT DO NOTHING;
      `);
      await sql(cluster, `SELECT public.set_journey_observation_consent_v1('${USER_ID}', true)`);

      const stageId = await sql(cluster, `
        SELECT public.configure_journey_shadow_stage_v1(
          '${ADMIN_ID}'::uuid, 'internal', now() - interval '1 min', now() + interval '2 days',
          '${ADMIN_ID}'::uuid, clock_timestamp()
        )
      `);

      const id1 = await sql(cluster, `
        SELECT public.assign_journey_shadow_cohort_v1(
          '${ADMIN_ID}'::uuid, '${USER_ID}'::uuid, '${stageId}'::uuid,
          now(), now() + interval '1 day'
        )
      `);

      // Second assign returns same ID (idempotent)
      const id2 = await sql(cluster, `
        SELECT public.assign_journey_shadow_cohort_v1(
          '${ADMIN_ID}'::uuid, '${USER_ID}'::uuid, '${stageId}'::uuid,
          now(), now() + interval '1 day'
        )
      `);
      assert.equal(id1, id2, "second active assign for same user+stage must return same ID");

      // Count: should be exactly 1 unrevoked row
      const activeCount = await sql(cluster, `
        SELECT count(*) FROM public.journey_shadow_cohort_assignments
        WHERE user_id = '${USER_ID}' AND stage_id = '${stageId}' AND revoked_at IS NULL
      `);
      assert.equal(activeCount, "1", "only one active assignment must exist");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("revoked assignment is never reactivated; new assign creates a fresh audit row", async () => {
    const cluster = await startPostgres();
    try {

      await sql(cluster, `
        INSERT INTO public.user_location_preferences (user_id, location_mode, sharing_paused)
        VALUES ('${USER_ID}', 'live_during_activity', false)
        ON CONFLICT DO NOTHING;
      `);
      await sql(cluster, `SELECT public.set_journey_observation_consent_v1('${USER_ID}', true)`);

      const stageId = await sql(cluster, `
        SELECT public.configure_journey_shadow_stage_v1(
          '${ADMIN_ID}'::uuid, 'internal', now() - interval '1 min', now() + interval '2 days',
          '${ADMIN_ID}'::uuid, clock_timestamp()
        )
      `);

      const firstId = await sql(cluster, `
        SELECT public.assign_journey_shadow_cohort_v1(
          '${ADMIN_ID}'::uuid, '${USER_ID}'::uuid, '${stageId}'::uuid,
          now(), now() + interval '1 day'
        )
      `);

      // Revoke first assignment
      await sql(cluster, `SELECT public.revoke_journey_shadow_cohort_v1('${ADMIN_ID}', '${firstId}')`);

      // Re-assign after revocation
      const secondId = await sql(cluster, `
        SELECT public.assign_journey_shadow_cohort_v1(
          '${ADMIN_ID}'::uuid, '${USER_ID}'::uuid, '${stageId}'::uuid,
          now(), now() + interval '1 day'
        )
      `);
      assert.notEqual(firstId, secondId, "re-assignment after revocation must create a new audit row with different ID");

      // Revoked row must still be revoked
      const revokedRow = await sql(cluster, `
        SELECT revoked_at IS NOT NULL FROM public.journey_shadow_cohort_assignments WHERE id = '${firstId}'
      `);
      assert.equal(revokedRow, "t", "revoked row must remain revoked");
    } finally {
      await stopPostgres(cluster);
    }
  });

  // ── Section N: approve_at freshness window enforced ───────────────────────

  it("configure_journey_shadow_stage_v1 rejects approved_at more than 5 minutes in the past", async () => {
    const cluster = await startPostgres();
    try {

      await assertRaises(cluster, `
        SELECT public.configure_journey_shadow_stage_v1(
          '${ADMIN_ID}'::uuid, 'internal',
          now(), now() + interval '1 day',
          '${ADMIN_ID}'::uuid,
          now() - interval '10 minutes'
        )
      `, "configure stage with stale approved_at must raise");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("configure_journey_shadow_stage_v1 rejects approved_by != actor", async () => {
    const cluster = await startPostgres();
    try {

      await assertRaises(cluster, `
        SELECT public.configure_journey_shadow_stage_v1(
          '${ADMIN_ID}'::uuid, 'internal',
          now(), now() + interval '1 day',
          '${NON_ADMIN}'::uuid,
          clock_timestamp()
        )
      `, "configure stage with approved_by != actor must raise");
    } finally {
      await stopPostgres(cluster);
    }
  });

  // ── Section O: session duration cap ───────────────────────────────────────

  it("issue_journey_shadow_session_v1 rejects expires_at more than 24h from now", async () => {
    const cluster = await startPostgres();
    try {

      await sql(cluster, `
        INSERT INTO public.user_location_preferences (user_id, location_mode, sharing_paused)
        VALUES ('${USER_ID}', 'live_during_activity', false)
        ON CONFLICT DO NOTHING;
      `);
      await sql(cluster, `SELECT public.set_journey_observation_consent_v1('${USER_ID}', true)`);

      const stageId = await sql(cluster, `
        SELECT public.configure_journey_shadow_stage_v1(
          '${ADMIN_ID}'::uuid, 'internal', now() - interval '1 min', now() + interval '2 days',
          '${ADMIN_ID}'::uuid, clock_timestamp()
        )
      `);
      const assignmentId = await sql(cluster, `
        SELECT public.assign_journey_shadow_cohort_v1(
          '${ADMIN_ID}'::uuid, '${USER_ID}'::uuid, '${stageId}'::uuid,
          now(), now() + interval '1 day'
        )
      `);

      await assertRaises(cluster, `
        SELECT public.issue_journey_shadow_session_v1(
          '${ADMIN_ID}'::uuid, '${assignmentId}'::uuid, 'live_share',
          now() + interval '25 hours'
        )
      `, "issue session with expires_at > 24h must raise");
    } finally {
      await stopPostgres(cluster);
    }
  });

  // ── Section P: stage window cap ───────────────────────────────────────────

  it("configure_journey_shadow_stage_v1 rejects stage duration > 30 days", async () => {
    const cluster = await startPostgres();
    try {

      await assertRaises(cluster, `
        SELECT public.configure_journey_shadow_stage_v1(
          '${ADMIN_ID}'::uuid, 'internal',
          now(), now() + interval '31 days',
          '${ADMIN_ID}'::uuid, clock_timestamp()
        )
      `, "stage duration > 30 days must raise");
    } finally {
      await stopPostgres(cluster);
    }
  });

  // ── Section Q: QA report payload forbidden keys ───────────────────────────

  it("persist_journey_shadow_qa_report_v1 rejects user_id in payload", async () => {
    const cluster = await startPostgres();
    try {

      const stageId = await sql(cluster, `
        SELECT public.configure_journey_shadow_stage_v1(
          '${ADMIN_ID}'::uuid, 'internal', now() - interval '1 min', now() + interval '2 days',
          '${ADMIN_ID}'::uuid, clock_timestamp()
        )
      `);

      await assertRaises(cluster, `
        SELECT public.persist_journey_shadow_qa_report_v1(
          '${ADMIN_ID}'::uuid, '${stageId}'::uuid, 'segment_accuracy',
          now() - interval '1 day', now(),
          '{"user_id":"some-user","aggregate":1}'::jsonb, NULL
        )
      `, "QA report with user_id key must raise");
    } finally {
      await stopPostgres(cluster);
    }
  });

  // ── Section L: rollout-boundedness cap (max_accounts) ─────────────────────

  it("configure_journey_shadow_stage_v1 binds max_accounts to the stage (internal=10, qa=25, consented=50) and ignores caller input", async () => {
    const cluster = await startPostgres();
    try {
      for (const [stage, cap] of [
        ["internal", "10"],
        ["qa", "25"],
        ["consented", "50"],
      ] as const) {
        const stageId = await sql(cluster, `
          SELECT public.configure_journey_shadow_stage_v1(
            '${ADMIN_ID}'::uuid, '${stage}', now() - interval '1 min', now() + interval '2 days',
            '${ADMIN_ID}'::uuid, clock_timestamp()
          )
        `);
        const maxAccounts = await sql(cluster, `SELECT max_accounts FROM public.journey_shadow_stages WHERE id = '${stageId}'`);
        assert.equal(maxAccounts, cap, `${stage} stage must derive max_accounts = ${cap} from the stage (not caller input)`);
        // Deactivate so the next stage can be the sole active one
        await sql(cluster, `UPDATE public.journey_shadow_stages SET is_active = false WHERE id = '${stageId}'`);
      }
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("assign_journey_shadow_cohort_v1 enforces the non-overridable max_accounts cap (internal=10) and idempotent re-assign does not consume a slot", async () => {
    const cluster = await startPostgres();
    try {
      // Configure an internal stage (cap = 10)
      const stageId = await sql(cluster, `
        SELECT public.configure_journey_shadow_stage_v1(
          '${ADMIN_ID}'::uuid, 'internal', now() - interval '1 min', now() + interval '2 days',
          '${ADMIN_ID}'::uuid, clock_timestamp()
        )
      `);

      // Seed 11 distinct consented users
      const userIds: string[] = [];
      for (let i = 1; i <= 11; i++) {
        const uid = `0000ca90-0000-4000-8000-${String(i).padStart(12, "0")}`;
        userIds.push(uid);
        await sql(cluster, `
          INSERT INTO auth.users (id) VALUES ('${uid}') ON CONFLICT DO NOTHING;
          INSERT INTO public.profiles (id, handle, role) VALUES ('${uid}', 'cap_user_${i}', 'user') ON CONFLICT DO NOTHING;
          INSERT INTO public.user_location_preferences (user_id, location_mode, sharing_paused)
            VALUES ('${uid}', 'live_during_activity', false) ON CONFLICT (user_id) DO NOTHING;
          SELECT public.set_journey_observation_consent_v1('${uid}', true);
        `);
      }

      // First 10 assignments succeed (fill the cap)
      const firstAssignment: string[] = [];
      for (let i = 0; i < 10; i++) {
        const aid = await sql(cluster, `
          SELECT public.assign_journey_shadow_cohort_v1(
            '${ADMIN_ID}'::uuid, '${userIds[i]}'::uuid, '${stageId}'::uuid,
            now() - interval '10 sec', now() + interval '1 day'
          )
        `);
        assert.ok(aid && aid.length > 0, `assignment ${i + 1} within cap must succeed`);
        firstAssignment.push(aid);
      }

      const activeCount = await sql(cluster, `SELECT count(*) FROM public.journey_shadow_cohort_assignments WHERE stage_id = '${stageId}' AND revoked_at IS NULL`);
      assert.equal(activeCount, "10", "exactly 10 active assignments must fill the internal cap");

      // Idempotent re-assign of an already-active user must NOT consume a slot
      const reassign = await sql(cluster, `
        SELECT public.assign_journey_shadow_cohort_v1(
          '${ADMIN_ID}'::uuid, '${userIds[0]}'::uuid, '${stageId}'::uuid,
          now() - interval '10 sec', now() + interval '1 day'
        )
      `);
      assert.equal(reassign, firstAssignment[0], "idempotent re-assign must return the existing active assignment id");
      const stillTen = await sql(cluster, `SELECT count(*) FROM public.journey_shadow_cohort_assignments WHERE stage_id = '${stageId}' AND revoked_at IS NULL`);
      assert.equal(stillTen, "10", "idempotent re-assign must not consume a cap slot");

      // The 11th distinct user is rejected — cap is non-overridable
      await assertRaises(cluster, `
        SELECT public.assign_journey_shadow_cohort_v1(
          '${ADMIN_ID}'::uuid, '${userIds[10]}'::uuid, '${stageId}'::uuid,
          now() - interval '10 sec', now() + interval '1 day'
        )
      `, "11th assignment must be rejected by the max_accounts cap");

      // Revoking a slot frees capacity for exactly one more
      await sql(cluster, `SELECT public.revoke_journey_shadow_cohort_v1('${ADMIN_ID}', '${firstAssignment[0]}')`);
      const afterRevoke = await sql(cluster, `SELECT count(*) FROM public.journey_shadow_cohort_assignments WHERE stage_id = '${stageId}' AND revoked_at IS NULL`);
      assert.equal(afterRevoke, "9", "revoke must free one active slot");
      const newAssignment = await sql(cluster, `
        SELECT public.assign_journey_shadow_cohort_v1(
          '${ADMIN_ID}'::uuid, '${userIds[10]}'::uuid, '${stageId}'::uuid,
          now() - interval '10 sec', now() + interval '1 day'
        )
      `);
      assert.ok(newAssignment && newAssignment.length > 0, "assignment must succeed after a slot is freed");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("concurrent assignments cannot exceed max_accounts (stage lock serialises the cap)", async () => {
    const cluster = await startPostgres();
    try {
      // internal stage, cap = 10
      const stageId = await sql(cluster, `
        SELECT public.configure_journey_shadow_stage_v1(
          '${ADMIN_ID}'::uuid, 'internal', now() - interval '1 min', now() + interval '2 days',
          '${ADMIN_ID}'::uuid, clock_timestamp()
        )
      `);

      // Seed 20 consented users
      const userIds: string[] = [];
      for (let i = 1; i <= 20; i++) {
        const uid = `0000c0c0-0000-4000-8000-${String(i).padStart(12, "0")}`;
        userIds.push(uid);
        await sql(cluster, `
          INSERT INTO auth.users (id) VALUES ('${uid}') ON CONFLICT DO NOTHING;
          INSERT INTO public.profiles (id, handle, role) VALUES ('${uid}', 'cnc_user_${i}', 'user') ON CONFLICT DO NOTHING;
          INSERT INTO public.user_location_preferences (user_id, location_mode, sharing_paused)
            VALUES ('${uid}', 'live_during_activity', false) ON CONFLICT (user_id) DO NOTHING;
          SELECT public.set_journey_observation_consent_v1('${uid}', true);
        `);
      }

      // Fire all 20 assignments concurrently; the stage FOR UPDATE lock must
      // serialise them so no more than 10 ever succeed.
      const results = await Promise.allSettled(
        userIds.map((uid) =>
          sql(cluster, `
            SELECT public.assign_journey_shadow_cohort_v1(
              '${ADMIN_ID}'::uuid, '${uid}'::uuid, '${stageId}'::uuid,
              now() - interval '10 sec', now() + interval '1 day'
            )
          `),
        ),
      );
      const succeeded = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.filter((r) => r.status === "rejected").length;

      const activeCount = await sql(cluster, `SELECT count(*) FROM public.journey_shadow_cohort_assignments WHERE stage_id = '${stageId}' AND revoked_at IS NULL`);
      assert.equal(activeCount, "10", "concurrent race must never exceed the cap of 10 active assignments");
      assert.equal(succeeded, 10, "exactly 10 concurrent assignments must succeed");
      assert.equal(failed, 10, "the other 10 concurrent assignments must be rejected by the cap");
    } finally {
      await stopPostgres(cluster);
    }
  });

  // ── Section M: synchronous session-revocation erasure ─────────────────────

  it("natural session end synchronously erases raw observations and derived segments for that session", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      // Ingest a raw observation for the session
      await sql(cluster, `
        SELECT public.ingest_journey_observation_v2(
          '${USER_ID}', '${sessionId}', 1::smallint, now() + interval '1 second',
          'foreground_gps', 10.3, 123.9, 5.0, NULL, NULL, NULL,
          'journey_observation_v1', 'sync-erase-obs-1', 'accepted',
          'journey-observation-quality-v1', 0.9, 'high', ARRAY[]::text[]
        )
      `);

      const segRow = JSON.stringify([{
        id: "eedd0001-0000-4000-8000-000000000001",
        user_id: USER_ID,
        location_session_id: sessionId,
        segment_key: "eedd0002-0000-4000-8000-000000000001",
        revision_index: 0,
        state: "moving",
        started_at: new Date(Date.now() - 5000).toISOString(),
        world_ref: { countryCode: null, regionId: null, cityId: null, districtId: null, placeId: null },
        movement_class: "walking",
        uncertainty_score: 0.1,
        uncertainty_tier: "low",
        reason_codes: ["good_accuracy"],
        stop_radius_m: 50,
        uncertainty_computed_at: new Date().toISOString(),
        algorithm_version: "v1",
        observation_count: 3,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      }]);
      await sql(cluster, `SELECT public.append_journey_segment_revisions_v2('${segRow.replace(/'/g, "''")}'::jsonb)`);

      const obsBefore = await sql(cluster, `SELECT count(*) FROM public.journey_observations WHERE location_session_id = '${sessionId}'`);
      assert.equal(obsBefore, "1", "observation must exist before session end");
      const segBefore = await sql(cluster, `SELECT count(*) FROM public.journey_segment_revisions WHERE location_session_id = '${sessionId}'`);
      assert.equal(segBefore, "1", "segment must exist before session end");

      // End the session naturally (owner ends it) — trigger performs synchronous erasure
      await sql(cluster, `UPDATE public.location_sessions SET ended_at = clock_timestamp() WHERE id = '${sessionId}'`);

      // Raw + derived erased synchronously for THIS session
      const obsAfter = await sql(cluster, `SELECT count(*) FROM public.journey_observations WHERE location_session_id = '${sessionId}'`);
      assert.equal(obsAfter, "0", "raw observations must be synchronously erased on session end");
      const segAfter = await sql(cluster, `SELECT count(*) FROM public.journey_segment_revisions WHERE location_session_id = '${sessionId}'`);
      assert.equal(segAfter, "0", "derived segments must be synchronously erased on session end");

      // Issuance revoked so the ended session cannot keep authorizing
      const issuanceRevoked = await sql(cluster, `SELECT revoked_at IS NOT NULL FROM public.journey_shadow_session_issuances WHERE location_session_id = '${sessionId}'`);
      assert.equal(issuanceRevoked, "t", "issuance must be revoked on session end");

      // A durable revocation job is recorded for audit/retry after the sync erasure
      const jobCount = await sql(cluster, `SELECT count(*) FROM public.journey_revocation_jobs WHERE location_session_id = '${sessionId}'`);
      assert.ok(Number(jobCount) >= 1, "a durable revocation job must be recorded on session end");
    } finally {
      await stopPostgres(cluster);
    }
  });

  // ── Section N: consent revocation ground-truth + raw erasure ──────────────

  it("consent revocation (journey_observation_enabled -> false) erases raw + ground truth for the user", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId, assignmentId } = await setupAuthorizedState(cluster);

      await sql(cluster, `
        SELECT public.ingest_journey_observation_v2(
          '${USER_ID}', '${sessionId}', 1::smallint, now() + interval '1 second',
          'foreground_gps', 10.3, 123.9, 5.0, NULL, NULL, NULL,
          'journey_observation_v1', 'consent-rev-obs-1', 'accepted',
          'journey-observation-quality-v1', 0.9, 'high', ARRAY[]::text[]
        )
      `);
      await sql(cluster, `
        SELECT public.record_journey_shadow_ground_truth_v1(
          '${ADMIN_ID}'::uuid, '${assignmentId}'::uuid, '${sessionId}'::uuid,
          now(), '{"motion":"walking"}'::jsonb, 'consent-rev truth'
        )
      `);

      const obsBefore = await sql(cluster, `SELECT count(*) FROM public.journey_observations WHERE user_id = '${USER_ID}'`);
      assert.equal(obsBefore, "1", "observation must exist before consent revocation");
      const truthBefore = await sql(cluster, `SELECT count(*) FROM public.journey_shadow_ground_truth WHERE user_id = '${USER_ID}'`);
      assert.equal(truthBefore, "1", "ground truth must exist before consent revocation");

      // Revoke consent through the guarded server RPC
      await sql(cluster, `SELECT public.set_journey_observation_consent_v1('${USER_ID}', false)`);

      const obsAfter = await sql(cluster, `SELECT count(*) FROM public.journey_observations WHERE user_id = '${USER_ID}'`);
      assert.equal(obsAfter, "0", "raw observations must be erased on consent revocation");
      const truthAfter = await sql(cluster, `SELECT count(*) FROM public.journey_shadow_ground_truth WHERE user_id = '${USER_ID}'`);
      assert.equal(truthAfter, "0", "ground truth must be erased on consent revocation");

      // Cohort assignment revoked (history retained, marked revoked)
      const assignmentRevoked = await sql(cluster, `SELECT revoked_at IS NOT NULL FROM public.journey_shadow_cohort_assignments WHERE id = '${assignmentId}'`);
      assert.equal(assignmentRevoked, "t", "assignment must be revoked on consent revocation");
    } finally {
      await stopPostgres(cluster);
    }
  });

  // ── Section O: deep, fail-closed payload rejection ────────────────────────

  // ── Section P: SELECT revoke + raw-read / aggregate RPCs ─────────────────

  it("service_role direct SELECT and DELETE on journey_observations are denied after 2123", async () => {
    const cluster = await startPostgres();
    try {
      // First ensure a row exists so a SELECT would have returned data if allowed.
      const { sessionId } = await setupAuthorizedState(cluster);
      await sql(cluster, `
        SELECT public.ingest_journey_observation_v2(
          '${USER_ID}', '${sessionId}', 1::smallint, now() + interval '1 second',
          'foreground_gps', 10.3, 123.9, 5.0, NULL, NULL, NULL,
          'journey_observation_v1', 'select-revoke-test-1', 'accepted',
          'journey-observation-quality-v1', 0.9, 'high', ARRAY['good_accuracy']::text[]
        )
      `);

      // Direct service_role reads and deletes must both be denied. Erasure is
      // available only through the bounded maintenance RPCs.
      await assertRaises(cluster, `
        SET ROLE service_role;
        SELECT * FROM public.journey_observations LIMIT 1
      `, "direct service_role SELECT on journey_observations must be denied after 2123");
      await assertRaises(cluster, `
        SET ROLE service_role;
        DELETE FROM public.journey_observations
      `, "direct service_role DELETE on journey_observations must be denied after 2123");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("read_journey_shadow_observations_v1 returns rows for an authorized session", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      // Ingest one non-unusable observation.
      await sql(cluster, `
        SELECT public.ingest_journey_observation_v2(
          '${USER_ID}', '${sessionId}', 1::smallint, now() + interval '1 second',
          'foreground_gps', 10.3, 123.9, 5.0, NULL, NULL, NULL,
          'journey_observation_v1', 'rpc-raw-read-ok-1', 'accepted',
          'journey-observation-quality-v1', 0.9, 'high', ARRAY['good_accuracy']::text[]
        )
      `);

      const rowCount = await sql(cluster, `
        SELECT count(*) FROM public.read_journey_shadow_observations_v1(
          '${USER_ID}'::uuid, '${sessionId}'::uuid
        )
      `);
      assert.equal(rowCount, "1", "read RPC must return the one authorized non-unusable row");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("read_journey_shadow_observations_v1 excludes unusable rows (segmentation boundary)", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      // Ingest one usable and one unusable observation.
      await sql(cluster, `
        SELECT public.ingest_journey_observation_v2(
          '${USER_ID}', '${sessionId}', 1::smallint, now() + interval '1 second',
          'foreground_gps', 10.3, 123.9, 5.0, NULL, NULL, NULL,
          'journey_observation_v1', 'rpc-raw-read-usable', 'accepted',
          'journey-observation-quality-v1', 0.9, 'high', ARRAY['good_accuracy']::text[]
        )
      `);
      await sql(cluster, `
        SELECT public.ingest_journey_observation_v2(
          '${USER_ID}', '${sessionId}', 1::smallint, now() + interval '2 second',
          'foreground_gps', 10.3, 123.9, 5.0, NULL, NULL, NULL,
          'journey_observation_v1', 'rpc-raw-read-unusable', 'accepted',
          'journey-observation-quality-v1', 0.0, 'unusable', ARRAY['stale']::text[]
        )
      `);

      const rowCount = await sql(cluster, `
        SELECT count(*) FROM public.read_journey_shadow_observations_v1(
          '${USER_ID}'::uuid, '${sessionId}'::uuid
        )
      `);
      assert.equal(rowCount, "1", "read RPC must exclude unusable rows (segmentation boundary)");

      // Verify no unusable class in returned rows.
      const unusableCount = await sql(cluster, `
        SELECT count(*) FROM public.read_journey_shadow_observations_v1(
          '${USER_ID}'::uuid, '${sessionId}'::uuid
        ) WHERE quality_class = 'unusable'
      `);
      assert.equal(unusableCount, "0", "read RPC must never return unusable rows");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("read_journey_shadow_observations_v1 returns zero rows when flags are off (fails closed)", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      // Disable flags — authorization will deny.
      await sql(cluster, `UPDATE public.feature_flags SET enabled = false WHERE flag LIKE 'COMPASS_JOURNEY%'`);

      const rowCount = await sql(cluster, `
        SELECT count(*) FROM public.read_journey_shadow_observations_v1(
          '${USER_ID}'::uuid, '${sessionId}'::uuid
        )
      `);
      assert.equal(rowCount, "0", "read RPC must return zero rows when authorization is denied (fails closed)");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("read_journey_shadow_observations_v1 returns zero rows for wrong user (fails closed)", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      // NON_ADMIN is not the session owner — authorization must deny.
      const rowCount = await sql(cluster, `
        SELECT count(*) FROM public.read_journey_shadow_observations_v1(
          '${NON_ADMIN}'::uuid, '${sessionId}'::uuid
        )
      `);
      assert.equal(rowCount, "0", "read RPC must return zero rows when user does not own the session");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("aggregate_journey_shadow_observations_v1 returns counts + quality distributions for admin", async () => {
    const cluster = await startPostgres();
    try {
      const { stageId, sessionId } = await setupAuthorizedState(cluster);

      // Ingest one high observation.
      await sql(cluster, `
        SELECT public.ingest_journey_observation_v2(
          '${USER_ID}', '${sessionId}', 1::smallint, now() + interval '1 second',
          'foreground_gps', 10.3, 123.9, 5.0, NULL, NULL, NULL,
          'journey_observation_v1', 'agg-rpc-high-1', 'accepted',
          'journey-observation-quality-v1', 0.9, 'high', ARRAY['good_accuracy']::text[]
        )
      `);
      // Ingest one unusable observation (must appear in distribution for failure-mode measurement).
      await sql(cluster, `
        SELECT public.ingest_journey_observation_v2(
          '${USER_ID}', '${sessionId}', 1::smallint, now() + interval '2 second',
          'foreground_gps', 10.3, 123.9, 5.0, NULL, NULL, NULL,
          'journey_observation_v1', 'agg-rpc-unusable-1', 'accepted',
          'journey-observation-quality-v1', 0.0, 'unusable', ARRAY['stale']::text[]
        )
      `);

      const result = await sql(cluster, `
        SELECT public.aggregate_journey_shadow_observations_v1(
          '${ADMIN_ID}'::uuid,
          '${stageId}'::uuid,
          now() - interval '10 minutes',
          now() + interval '10 minutes'
        )
      `);
      const agg = JSON.parse(result);

      assert.equal(agg.totalObservationCount, 2, "aggregate must count all rows including unusable");
      assert.equal(agg.qualityClassDistribution?.high, 1, "high class must appear in distribution");
      assert.equal(agg.qualityClassDistribution?.unusable, 1, "unusable must appear in distribution for failure-mode measurement");
      assert.ok(!("lat" in agg) && !("lng" in agg), "aggregate must never return coordinates");
      assert.ok(!JSON.stringify(agg).includes(USER_ID), "aggregate must never return user IDs");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("aggregate_journey_shadow_observations_v1 is denied for non-admin", async () => {
    const cluster = await startPostgres();
    try {
      const { stageId } = await setupAuthorizedState(cluster);

      await assertRaises(cluster, `
        SELECT public.aggregate_journey_shadow_observations_v1(
          '${NON_ADMIN}'::uuid,
          '${stageId}'::uuid,
          now() - interval '1 hour',
          now() + interval '1 hour'
        )
      `, "non-admin must be denied from aggregate RPC");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("aggregate_journey_shadow_observations_v1 fails closed when flags are off for any session", async () => {
    const cluster = await startPostgres();
    try {
      const { stageId, sessionId } = await setupAuthorizedState(cluster);

      // Ingest one observation so the session is non-empty.
      await sql(cluster, `
        SELECT public.ingest_journey_observation_v2(
          '${USER_ID}', '${sessionId}', 1::smallint, now() + interval '1 second',
          'foreground_gps', 10.3, 123.9, 5.0, NULL, NULL, NULL,
          'journey_observation_v1', 'agg-deny-obs-1', 'accepted',
          'journey-observation-quality-v1', 0.9, 'high', ARRAY['good_accuracy']::text[]
        )
      `);

      // Disable flags — authorization of the issued session will fail.
      await sql(cluster, `UPDATE public.feature_flags SET enabled = false WHERE flag LIKE 'COMPASS_JOURNEY%'`);

      // Aggregate must raise because the session's raw_read is denied.
      const errText = await captureRaise(cluster, `
        SELECT public.aggregate_journey_shadow_observations_v1(
          '${ADMIN_ID}'::uuid,
          '${stageId}'::uuid,
          now() - interval '10 minutes',
          now() + interval '10 minutes'
        )
      `, "aggregate RPC must fail closed when any session's authorization is denied");
      // Part C: denial message must be generic — no session/user ID leaked.
      assert.ok(!errText.includes(sessionId), "aggregate denial must not leak session ID");
      assert.ok(!errText.includes(USER_ID), "aggregate denial must not leak user ID");
    } finally {
      await stopPostgres(cluster);
    }
  });

  // ── Section Q: read_journey_shadow_qa_observations_v1 (Part A) ────────────

  it("read_journey_shadow_qa_observations_v1 includes ALL quality classes (unusable) for QA", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      await sql(cluster, `
        SELECT public.ingest_journey_observation_v2(
          '${USER_ID}', '${sessionId}', 1::smallint, now() + interval '1 second',
          'foreground_gps', 10.3, 123.9, 5.0, NULL, NULL, NULL,
          'journey_observation_v1', 'qa-read-usable', 'accepted',
          'journey-observation-quality-v1', 0.9, 'high', ARRAY['good_accuracy']::text[]
        )
      `);
      await sql(cluster, `
        SELECT public.ingest_journey_observation_v2(
          '${USER_ID}', '${sessionId}', 1::smallint, now() + interval '2 second',
          'foreground_gps', 10.3, 123.9, 5.0, NULL, NULL, NULL,
          'journey_observation_v1', 'qa-read-unusable', 'accepted',
          'journey-observation-quality-v1', 0.0, 'unusable', ARRAY['stale','impossible_speed']::text[]
        )
      `);

      const total = await sql(cluster, `
        SELECT count(*) FROM public.read_journey_shadow_qa_observations_v1(
          '${ADMIN_ID}'::uuid, '${USER_ID}'::uuid, '${sessionId}'::uuid,
          now() - interval '10 minutes', now() + interval '10 minutes'
        )
      `);
      assert.equal(total, "2", "QA read must include unusable rows (all classes)");

      const unusable = await sql(cluster, `
        SELECT count(*) FROM public.read_journey_shadow_qa_observations_v1(
          '${ADMIN_ID}'::uuid, '${USER_ID}'::uuid, '${sessionId}'::uuid,
          now() - interval '10 minutes', now() + interval '10 minutes'
        ) WHERE quality_class = 'unusable' AND 'impossible_speed' = ANY(quality_reasons)
      `);
      assert.equal(unusable, "1", "QA read must expose unusable reasons for failure-mode measurement");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("read_journey_shadow_qa_observations_v1 RAISEs generic 42501 on denial (no IDs leaked)", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      // Disable flags → raw_read authorization denied.
      await sql(cluster, `UPDATE public.feature_flags SET enabled = false WHERE flag LIKE 'COMPASS_JOURNEY%'`);

      // Capture the RPC's own raised message + sqlstate via SQLERRM/SQLSTATE
      // inside a DO block, returning them through a temp table. This inspects
      // the RPC message itself (not psql's statement echo, which necessarily
      // embeds the parameter values we pass in the -c form).
      await sql(cluster, `
        CREATE TEMP TABLE qa_denial_capture (msg text, state text);
        DO $$
        BEGIN
          BEGIN
            PERFORM count(*) FROM public.read_journey_shadow_qa_observations_v1(
              '${ADMIN_ID}'::uuid, '${USER_ID}'::uuid, '${sessionId}'::uuid,
              now() - interval '10 minutes', now() + interval '10 minutes'
            );
            INSERT INTO qa_denial_capture VALUES ('DID_NOT_RAISE', NULL);
          EXCEPTION WHEN OTHERS THEN
            INSERT INTO qa_denial_capture VALUES (SQLERRM, SQLSTATE);
          END;
        END $$;
        SELECT msg || '|' || state FROM qa_denial_capture;
      `).then((out) => {
        const line = out.split("\n").pop() ?? "";
        const [msg, state] = line.split("|");
        assert.notEqual(msg, "DID_NOT_RAISE", "QA read must RAISE on denial");
        assert.equal(state, "42501", "denial must use generic 42501 sqlstate");
        assert.ok(/not authorized/.test(msg), "denial message must be the generic 'not authorized'");
        assert.ok(!msg.includes(sessionId), "denial message must not leak session ID");
        assert.ok(!msg.includes(USER_ID), "denial message must not leak user ID");
      });
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("read_journey_shadow_qa_observations_v1 returns [] (no raise) for authorized-but-empty session", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);
      // No observations ingested — authorized session with zero rows.
      const total = await sql(cluster, `
        SELECT count(*) FROM public.read_journey_shadow_qa_observations_v1(
          '${ADMIN_ID}'::uuid, '${USER_ID}'::uuid, '${sessionId}'::uuid,
          now() - interval '10 minutes', now() + interval '10 minutes'
        )
      `);
      assert.equal(total, "0", "authorized-but-empty returns zero rows without raising");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("read_journey_shadow_qa_observations_v1 is denied for non-admin actor", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);
      await assertRaises(cluster, `
        SELECT count(*) FROM public.read_journey_shadow_qa_observations_v1(
          '${NON_ADMIN}'::uuid, '${USER_ID}'::uuid, '${sessionId}'::uuid,
          now() - interval '10 minutes', now() + interval '10 minutes'
        )
      `, "QA read must reject a non-admin actor");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("read_journey_shadow_qa_observations_v1 rejects invalid period (end<=start, >30d)", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);
      await assertRaises(cluster, `
        SELECT count(*) FROM public.read_journey_shadow_qa_observations_v1(
          '${ADMIN_ID}'::uuid, '${USER_ID}'::uuid, '${sessionId}'::uuid,
          now() + interval '10 minutes', now() - interval '10 minutes'
        )
      `, "QA read must reject end<=start");
      await assertRaises(cluster, `
        SELECT count(*) FROM public.read_journey_shadow_qa_observations_v1(
          '${ADMIN_ID}'::uuid, '${USER_ID}'::uuid, '${sessionId}'::uuid,
          now() - interval '40 days', now()
        )
      `, "QA read must reject period > 30 days");
    } finally {
      await stopPostgres(cluster);
    }
  });

  // ── Section S: journey_segment_revisions sealed after 2123 ────────────────

  it("service_role direct SELECT, INSERT and DELETE on journey_segment_revisions are denied after 2123", async () => {
    const cluster = await startPostgres();
    try {
      // Seed one row through the sole SECURITY DEFINER writer so a direct SELECT
      // would have returned data if the grant still existed.
      const { sessionId } = await setupAuthorizedState(cluster);
      await seedSegment(cluster, sessionId, {
        id: "aabbccdd-5e01-4000-8000-000000000001",
        segmentKey: "aabbccdd-5e02-4000-8000-000000000001",
      });

      // Direct service_role reads, inserts and deletes must ALL be denied. Reads
      // are only via the authorising RPCs; erasure only via the sealed RPCs.
      await assertRaises(cluster, `
        SET ROLE service_role;
        SELECT * FROM public.journey_segment_revisions LIMIT 1
      `, "direct service_role SELECT on journey_segment_revisions must be denied after 2123");
      await assertRaises(cluster, `
        SET ROLE service_role;
        DELETE FROM public.journey_segment_revisions
      `, "direct service_role DELETE on journey_segment_revisions must be denied after 2123");
      await assertRaises(cluster, `
        SET ROLE service_role;
        INSERT INTO public.journey_segment_revisions (id) VALUES (gen_random_uuid())
      `, "direct service_role INSERT on journey_segment_revisions must be denied after 2123");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("aggregate_journey_shadow_segment_revisions_v1 counts revisions for admin (no rows/IDs)", async () => {
    const cluster = await startPostgres();
    try {
      const { stageId, sessionId } = await setupAuthorizedState(cluster);
      await seedSegment(cluster, sessionId, {
        id: "aabbccdd-5e03-4000-8000-000000000001",
        segmentKey: "aabbccdd-5e04-4000-8000-000000000001",
        revisionIndex: 0,
      });
      await seedSegment(cluster, sessionId, {
        id: "aabbccdd-5e03-4000-8000-000000000002",
        segmentKey: "aabbccdd-5e04-4000-8000-000000000002",
        revisionIndex: 0,
        qualityClass: "unusable",
        qualityReasons: ["low_accuracy"],
      });

      const result = await sql(cluster, `
        SELECT public.aggregate_journey_shadow_segment_revisions_v1(
          '${ADMIN_ID}'::uuid,
          '${stageId}'::uuid,
          now() - interval '10 minutes',
          now() + interval '10 minutes'
        )
      `);
      const agg = JSON.parse(result);
      assert.equal(agg.revisionCount, 2, "aggregate must count all segment revisions including unusable");
      assert.ok(!("lat" in agg) && !("lng" in agg), "segment aggregate must never return coordinates");
      assert.ok(!JSON.stringify(agg).includes(USER_ID), "segment aggregate must never return user IDs");
      assert.ok(!JSON.stringify(agg).includes(sessionId), "segment aggregate must never return session IDs");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("aggregate_journey_shadow_segment_revisions_v1 is denied for non-admin", async () => {
    const cluster = await startPostgres();
    try {
      const { stageId } = await setupAuthorizedState(cluster);
      await assertRaises(cluster, `
        SELECT public.aggregate_journey_shadow_segment_revisions_v1(
          '${NON_ADMIN}'::uuid,
          '${stageId}'::uuid,
          now() - interval '1 hour',
          now() + interval '1 hour'
        )
      `, "non-admin must be denied from segment aggregate RPC");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("aggregate_journey_shadow_segment_revisions_v1 fails closed (generic) when a session is denied", async () => {
    const cluster = await startPostgres();
    try {
      const { stageId, sessionId } = await setupAuthorizedState(cluster);
      await seedSegment(cluster, sessionId, {
        id: "aabbccdd-5e05-4000-8000-000000000001",
        segmentKey: "aabbccdd-5e06-4000-8000-000000000001",
      });

      // Disable flags → the issued session's raw_read is denied.
      await sql(cluster, `UPDATE public.feature_flags SET enabled = false WHERE flag LIKE 'COMPASS_JOURNEY%'`);

      const errText = await captureRaise(cluster, `
        SELECT public.aggregate_journey_shadow_segment_revisions_v1(
          '${ADMIN_ID}'::uuid,
          '${stageId}'::uuid,
          now() - interval '10 minutes',
          now() + interval '10 minutes'
        )
      `, "segment aggregate must fail closed when any session's authorization is denied");
      assert.ok(!errText.includes(sessionId), "segment aggregate denial must not leak session ID");
      assert.ok(!errText.includes(USER_ID), "segment aggregate denial must not leak user ID");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("aggregate_journey_shadow_segment_revisions_v1 rejects invalid period (end<=start, >30d)", async () => {
    const cluster = await startPostgres();
    try {
      const { stageId } = await setupAuthorizedState(cluster);
      await assertRaises(cluster, `
        SELECT public.aggregate_journey_shadow_segment_revisions_v1(
          '${ADMIN_ID}'::uuid, '${stageId}'::uuid,
          now() + interval '10 minutes', now() - interval '10 minutes'
        )
      `, "segment aggregate must reject end<=start");
      await assertRaises(cluster, `
        SELECT public.aggregate_journey_shadow_segment_revisions_v1(
          '${ADMIN_ID}'::uuid, '${stageId}'::uuid,
          now() - interval '40 days', now()
        )
      `, "segment aggregate must reject period > 30 days");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("read_journey_shadow_qa_segment_revisions_v1 returns revision fields for an authorized session", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);
      await seedSegment(cluster, sessionId, {
        id: "aabbccdd-5e07-4000-8000-000000000001",
        segmentKey: "aabbccdd-5e08-4000-8000-000000000001",
        qualityClass: "unusable",
        qualityReasons: ["low_accuracy", "long_gap"],
      });

      const total = await sql(cluster, `
        SELECT count(*) FROM public.read_journey_shadow_qa_segment_revisions_v1(
          '${ADMIN_ID}'::uuid, '${USER_ID}'::uuid, '${sessionId}'::uuid,
          now() - interval '10 minutes', now() + interval '10 minutes'
        )
      `);
      assert.equal(total, "1", "QA segment read must return the authorized session's revision");

      // Revision fields (incl. quality columns) must be present for QA scoring.
      const detail = await sql(cluster, `
        SELECT count(*) FROM public.read_journey_shadow_qa_segment_revisions_v1(
          '${ADMIN_ID}'::uuid, '${USER_ID}'::uuid, '${sessionId}'::uuid,
          now() - interval '10 minutes', now() + interval '10 minutes'
        ) WHERE quality_class = 'unusable'
          AND 'long_gap' = ANY(quality_reasons)
          AND segment_key IS NOT NULL
          AND algorithm_version = 'v1'
      `);
      assert.equal(detail, "1", "QA segment read must expose revision + quality fields");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("read_journey_shadow_qa_segment_revisions_v1 RAISEs generic 42501 on denial (no IDs leaked)", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);
      await sql(cluster, `UPDATE public.feature_flags SET enabled = false WHERE flag LIKE 'COMPASS_JOURNEY%'`);

      await sql(cluster, `
        CREATE TEMP TABLE seg_denial_capture (msg text, state text);
        DO $$
        BEGIN
          BEGIN
            PERFORM count(*) FROM public.read_journey_shadow_qa_segment_revisions_v1(
              '${ADMIN_ID}'::uuid, '${USER_ID}'::uuid, '${sessionId}'::uuid,
              now() - interval '10 minutes', now() + interval '10 minutes'
            );
            INSERT INTO seg_denial_capture VALUES ('DID_NOT_RAISE', NULL);
          EXCEPTION WHEN OTHERS THEN
            INSERT INTO seg_denial_capture VALUES (SQLERRM, SQLSTATE);
          END;
        END $$;
        SELECT msg || '|' || state FROM seg_denial_capture;
      `).then((out) => {
        const line = out.split("\n").pop() ?? "";
        const [msg, state] = line.split("|");
        assert.notEqual(msg, "DID_NOT_RAISE", "QA segment read must RAISE on denial");
        assert.equal(state, "42501", "segment denial must use generic 42501 sqlstate");
        assert.ok(/not authorized/.test(msg), "segment denial message must be generic 'not authorized'");
        assert.ok(!msg.includes(sessionId), "segment denial message must not leak session ID");
        assert.ok(!msg.includes(USER_ID), "segment denial message must not leak user ID");
      });
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("read_journey_shadow_qa_segment_revisions_v1 returns [] (no raise) for authorized-but-empty session", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);
      const total = await sql(cluster, `
        SELECT count(*) FROM public.read_journey_shadow_qa_segment_revisions_v1(
          '${ADMIN_ID}'::uuid, '${USER_ID}'::uuid, '${sessionId}'::uuid,
          now() - interval '10 minutes', now() + interval '10 minutes'
        )
      `);
      assert.equal(total, "0", "authorized-but-empty segment read returns zero rows without raising");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("read_journey_shadow_qa_segment_revisions_v1 is denied for non-admin actor", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);
      await assertRaises(cluster, `
        SELECT count(*) FROM public.read_journey_shadow_qa_segment_revisions_v1(
          '${NON_ADMIN}'::uuid, '${USER_ID}'::uuid, '${sessionId}'::uuid,
          now() - interval '10 minutes', now() + interval '10 minutes'
        )
      `, "QA segment read must reject a non-admin actor");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("read_journey_shadow_qa_segment_revisions_v1 rejects invalid period (end<=start, >30d)", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);
      await assertRaises(cluster, `
        SELECT count(*) FROM public.read_journey_shadow_qa_segment_revisions_v1(
          '${ADMIN_ID}'::uuid, '${USER_ID}'::uuid, '${sessionId}'::uuid,
          now() + interval '10 minutes', now() - interval '10 minutes'
        )
      `, "QA segment read must reject end<=start");
      await assertRaises(cluster, `
        SELECT count(*) FROM public.read_journey_shadow_qa_segment_revisions_v1(
          '${ADMIN_ID}'::uuid, '${USER_ID}'::uuid, '${sessionId}'::uuid,
          now() - interval '40 days', now()
        )
      `, "QA segment read must reject period > 30 days");
    } finally {
      await stopPostgres(cluster);
    }
  });

  // ── Section R: maintenance RPCs with SELECT revoked (Part B) ──────────────

  it("delete_journey_shadow_rows_v1 erases raw + segments for a user (retention retry cleanup)", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      await sql(cluster, `
        SELECT public.ingest_journey_observation_v2(
          '${USER_ID}', '${sessionId}', 1::smallint, now() + interval '1 second',
          'foreground_gps', 10.3, 123.9, 5.0, NULL, NULL, NULL,
          'journey_observation_v1', 'del-rows-obs-1', 'accepted',
          'journey-observation-quality-v1', 0.9, 'high', ARRAY['good_accuracy']::text[]
        )
      `);

      const deleted = await sql(cluster, `
        SELECT public.delete_journey_shadow_rows_v1('${USER_ID}'::uuid, NULL)
      `);
      assert.ok(Number(deleted) >= 1, "must report deleted rows across raw+segments");

      // Verify observations are gone (SECURITY DEFINER can read the count).
      const remaining = await sql(cluster, `
        SELECT public.aggregate_journey_shadow_observations_v1(
          '${ADMIN_ID}'::uuid,
          (SELECT stage_id FROM public.journey_shadow_cohort_assignments WHERE user_id = '${USER_ID}' LIMIT 1)::uuid,
          now() - interval '10 minutes', now() + interval '10 minutes'
        )
      `);
      const agg = JSON.parse(remaining);
      assert.equal(agg.totalObservationCount, 0, "raw observations must be erased");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("delete_journey_shadow_rows_v1 scopes to a single session when provided", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);
      await sql(cluster, `
        SELECT public.ingest_journey_observation_v2(
          '${USER_ID}', '${sessionId}', 1::smallint, now() + interval '1 second',
          'foreground_gps', 10.3, 123.9, 5.0, NULL, NULL, NULL,
          'journey_observation_v1', 'del-scoped-1', 'accepted',
          'journey-observation-quality-v1', 0.9, 'high', ARRAY['good_accuracy']::text[]
        )
      `);
      const deleted = await sql(cluster, `
        SELECT public.delete_journey_shadow_rows_v1('${USER_ID}'::uuid, '${sessionId}'::uuid)
      `);
      assert.ok(Number(deleted) >= 1, "scoped delete must erase the session's rows");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("purge_expired_journey_shadow_table_v1 deletes expired observations and returns aggregate-only", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);

      // Insert a row and force its expires_at into the past (bypassing v2 which
      // sets a future TTL). Direct INSERT is allowed under superuser test role.
      await sql(cluster, `
        INSERT INTO public.journey_observations (
          user_id, location_session_id, event_version, observed_at, received_at,
          source, lat, lng, accuracy_m, consent_scope, idempotency_key, trust_class,
          expires_at, quality_version, quality_score, quality_class, quality_reasons
        ) VALUES (
          '${USER_ID}', '${sessionId}', 1, now() - interval '2 hours', now() - interval '2 hours',
          'foreground_gps', 10.3, 123.9, 5.0, 'journey_observation_v1', 'purge-expired-1', 'accepted',
          now() - interval '1 hour', 'journey-observation-quality-v1', 0.9, 'high', ARRAY['good_accuracy']::text[]
        )
      `);

      const result = await sql(cluster, `
        SELECT public.purge_expired_journey_shadow_table_v1('observation', now())
      `);
      const purged = JSON.parse(result);
      assert.equal(purged.deletedCount, 1, "expired observation must be deleted");
      assert.ok("oldestBeforeAgeMs" in purged && "oldestAfterAgeMs" in purged, "must return age fields");
      // Aggregate-only: no rows/IDs/coordinates in the returned payload.
      assert.ok(!JSON.stringify(purged).includes(USER_ID), "purge result must not leak user ID");
      assert.ok(!JSON.stringify(purged).includes(sessionId), "purge result must not leak session ID");
      assert.ok(!JSON.stringify(purged).includes("123.9"), "purge result must not leak coordinates");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("purge_expired_journey_shadow_table_v1 rejects an unknown kind", async () => {
    const cluster = await startPostgres();
    try {
      await setupAuthorizedState(cluster);
      await assertRaises(cluster, `
        SELECT public.purge_expired_journey_shadow_table_v1('bogus_kind', now())
      `, "purge RPC must reject an unknown table kind");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("delete_journey_observations_for_user_v1 erases raw observations (content-only path)", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId } = await setupAuthorizedState(cluster);
      await sql(cluster, `
        SELECT public.ingest_journey_observation_v2(
          '${USER_ID}', '${sessionId}', 1::smallint, now() + interval '1 second',
          'foreground_gps', 10.3, 123.9, 5.0, NULL, NULL, NULL,
          'journey_observation_v1', 'content-del-1', 'accepted',
          'journey-observation-quality-v1', 0.9, 'high', ARRAY['good_accuracy']::text[]
        )
      `);
      const deleted = await sql(cluster, `
        SELECT public.delete_journey_observations_for_user_v1('${USER_ID}'::uuid)
      `);
      assert.equal(deleted, "1", "content-only delete must erase the user's raw observation");
      // Idempotent second call deletes zero.
      const again = await sql(cluster, `
        SELECT public.delete_journey_observations_for_user_v1('${USER_ID}'::uuid)
      `);
      assert.equal(again, "0", "second content-only delete is idempotent (zero)");
    } finally {
      await stopPostgres(cluster);
    }
  });

  // ── Section S: aggregate hardening (Part C) ───────────────────────────────

  it("aggregate_journey_shadow_observations_v1 rejects invalid period (end<=start, >30d)", async () => {
    const cluster = await startPostgres();
    try {
      const { stageId } = await setupAuthorizedState(cluster);
      await assertRaises(cluster, `
        SELECT public.aggregate_journey_shadow_observations_v1(
          '${ADMIN_ID}'::uuid, '${stageId}'::uuid,
          now() + interval '10 minutes', now() - interval '10 minutes'
        )
      `, "aggregate must reject end<=start");
      await assertRaises(cluster, `
        SELECT public.aggregate_journey_shadow_observations_v1(
          '${ADMIN_ID}'::uuid, '${stageId}'::uuid,
          now() - interval '40 days', now()
        )
      `, "aggregate must reject period > 30 days");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("aggregate_journey_shadow_observations_v1 scopes sessions by location_session overlap (not issued_at)", async () => {
    const cluster = await startPostgres();
    try {
      const { stageId, sessionId } = await setupAuthorizedState(cluster);

      await sql(cluster, `
        SELECT public.ingest_journey_observation_v2(
          '${USER_ID}', '${sessionId}', 1::smallint, now() + interval '1 second',
          'foreground_gps', 10.3, 123.9, 5.0, NULL, NULL, NULL,
          'journey_observation_v1', 'overlap-obs-1', 'accepted',
          'journey-observation-quality-v1', 0.9, 'high', ARRAY['good_accuracy']::text[]
        )
      `);

      // The session was issued "now" but its location_session started earlier and
      // remains active. A period window that STARTS AFTER issued_at but overlaps
      // the active session must still include it (overlap scoping, not issued_at).
      const result = await sql(cluster, `
        SELECT public.aggregate_journey_shadow_observations_v1(
          '${ADMIN_ID}'::uuid, '${stageId}'::uuid,
          now() - interval '5 minutes', now() + interval '1 hour'
        )
      `);
      const agg = JSON.parse(result);
      assert.equal(agg.totalObservationCount, 1, "overlap scoping must include the active session's observation");
    } finally {
      await stopPostgres(cluster);
    }
  });

  it("ground truth rejects forbidden coordinate/raw-id keys hidden deep in nested payloads (fail-closed)", async () => {
    const cluster = await startPostgres();
    try {
      const { sessionId, assignmentId } = await setupAuthorizedState(cluster);

      // Forbidden key nested a few levels deep must still be rejected
      await assertRaises(cluster, `
        SELECT public.record_journey_shadow_ground_truth_v1(
          '${ADMIN_ID}'::uuid, '${assignmentId}'::uuid, '${sessionId}'::uuid,
          now(),
          '{"a":{"b":{"c":{"lat":1.23}}}}'::jsonb,
          NULL
        )
      `, "deeply nested lat key must be rejected");

      // Forbidden key nested inside an array element must still be rejected
      await assertRaises(cluster, `
        SELECT public.record_journey_shadow_ground_truth_v1(
          '${ADMIN_ID}'::uuid, '${assignmentId}'::uuid, '${sessionId}'::uuid,
          now(),
          '{"samples":[{"ok":1},{"nested":{"raw_id":"x"}}]}'::jsonb,
          NULL
        )
      `, "raw_id key nested inside an array must be rejected");

      // Fail-closed: a payload nested beyond the depth cap is treated as forbidden
      const tooDeep = (() => {
        let obj: unknown = { safe: 1 };
        for (let i = 0; i < 10; i++) obj = { level: obj };
        return JSON.stringify(obj);
      })();
      await assertRaises(cluster, `
        SELECT public.record_journey_shadow_ground_truth_v1(
          '${ADMIN_ID}'::uuid, '${assignmentId}'::uuid, '${sessionId}'::uuid,
          now(),
          '${tooDeep.replace(/'/g, "''")}'::jsonb,
          NULL
        )
      `, "payload nested beyond the depth cap must be rejected (fail-closed)");
    } finally {
      await stopPostgres(cluster);
    }
  });
});
