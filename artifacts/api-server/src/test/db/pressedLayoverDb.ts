/**
 * pressedLayoverDb — a database built from the REAL migration chain (the
 * 2026-08-19 baseline + EVERY file in src/migrations in the applier's order,
 * including every layover migration production has not applied), with the
 * flags a case chooses, behind the real supabase-js client the layover routes
 * accept. Lane B1-P of the Layover 165 program: "prove that the rows whose code
 * is ready actually work once their migrations and flags are pressed".
 *
 * TWO ENGINES, ONE BRIDGE (postgrestSqlBridge.ts)
 *   psql   — LOCAL_DB_URL is set: CI's api-server-local-db job, whose database
 *            scripts/local-db/up.sh built from the same baseline and chain on
 *            PostgreSQL 16 + PostGIS. Flags a case changes are restored on
 *            close(); the users it seeded are deleted (best effort).
 *   pglite — LAYOVER_PGLITE_ROOT names a node_modules/@electric-sql directory
 *            holding `pglite` and `pglite-postgis` (the baseline needs PostGIS
 *            at CREATE TABLE time; the API's own @electric-sql/pglite@0.2.17
 *            devDependency ships no PostGIS). The chain is replayed ONCE into a
 *            cache directory keyed by the sha256 of every input byte, and each
 *            open() copies that directory, so a case owns its database.
 *   neither — HAVE_PRESSED_DB is false and the suites skip, as every db suite
 *            does without LOCAL_DB_URL (run-tests.sh refuses skips in CI).
 *
 * THE REPLAY (pglite) is the production packet's own method
 * (prod-apply-packet-20261017 §12 (iii), variant Z "the canonical end state"):
 * the Supabase-surface shim, the baseline restored statement by statement with
 * the repo's own classifier and tolerant batch runner (scripts/src/beta-db-core.ts),
 * the pre-2093 reference seeds, then the chain from 2093 in
 * `orderMigrations(listMigrationFiles(), readOrderOverrides())`, each file whole.
 * Excluded, exactly as the packet excludes them:
 *   2481 — must never run (Sensing is on Option B);
 *   3601, 3602 — owner hold D-OWNER1004-14 (Rent-a-Buddy commission, not layover);
 *   3982 — needs pgvector, which PGlite lacks: the packet's STAND-IN, a ledger
 *          row only. No layover file depends on its objects.
 * A file that fails fails the build (no tolerated list): 0 of the remaining
 * files may fail, so the database is the whole chain or nothing.
 *
 * VARIANTS (pglite only): `without: ["3513", …]` replays the chain WITHOUT
 * those files — the migration-absent arm a pressed-state proof needs. A later
 * file that depends on an excluded one is excluded too and reported in
 * `variantExcluded`.
 *
 * Nothing here dials a network: the bridge's fetch is the client's only
 * transport and its URL is a `.invalid` host. No hosted database is touched.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeBridge, lit, dollar, type Bridge, type BridgeEngine, type Row } from "./postgrestSqlBridge.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const API_DIR = resolve(HERE, "../../..");
const REPO = resolve(API_DIR, "../..");
const MIGRATIONS = join(API_DIR, "src/migrations");
const BASELINE = join(API_DIR, "baseline/20260819_baseline_structure.sql");

const LOCAL_DB_URL = (process.env["LOCAL_DB_URL"] ?? "").trim();
const PGLITE_ROOT = (() => {
  const env = (process.env["LAYOVER_PGLITE_ROOT"] ?? "").trim();
  if (env) return env;
  const own = join(API_DIR, "node_modules/@electric-sql");
  return existsSync(join(own, "pglite-postgis")) ? own : "";
})();

export type PressedBackend = "psql" | "pglite";
export const PRESSED_BACKEND: PressedBackend | null = LOCAL_DB_URL ? "psql" : PGLITE_ROOT && existsSync(join(PGLITE_ROOT, "pglite-postgis")) ? "pglite" : null;
export const HAVE_PRESSED_DB = PRESSED_BACKEND !== null;
export const PRESSED_SKIP_REASON = HAVE_PRESSED_DB ? false : "no pressed-state database: set LOCAL_DB_URL (scripts/local-db/up.sh) or LAYOVER_PGLITE_ROOT (a node_modules/@electric-sql with pglite + pglite-postgis)";

/** Files the packet never applies (see the header). */
export const PACKET_EXCLUDED = ["2481_sensing_sessions_option_a_issuer.sql", "3601_rent_buddy_commission_basis_points.sql", "3602_rent_buddy_standard_level_commission_seed.sql"] as const;
export const STAND_IN = "3982_media_visual_index.sql" as const;

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

// ── the Supabase surface (the production packet's verify/supabase-shim.sql, verbatim in effect) ──
const SHIM = `
DO $$ DECLARE r text; BEGIN
  FOR r IN SELECT unnest(ARRAY['anon','authenticated','service_role','supabase_admin','supabase_storage_admin','supabase_auth_admin','dashboard_user','authenticator','pgsodium_keyiduser','supabase_realtime_admin','supabase_replication_admin','supabase_read_only_user','pgbouncer']) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF;
  END LOOP;
  ALTER ROLE service_role BYPASSRLS;
END $$;
GRANT anon, authenticated, service_role TO authenticator;
GRANT anon, authenticated, service_role TO postgres;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  instance_id uuid, id uuid PRIMARY KEY DEFAULT gen_random_uuid(), aud varchar(255), role varchar(255),
  email varchar(255), encrypted_password varchar(255), email_confirmed_at timestamptz, invited_at timestamptz,
  confirmation_token varchar(255), confirmation_sent_at timestamptz, recovery_token varchar(255), recovery_sent_at timestamptz,
  email_change_token_new varchar(255), email_change varchar(255), email_change_sent_at timestamptz,
  last_sign_in_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb, is_super_admin boolean,
  created_at timestamptz, updated_at timestamptz, phone text UNIQUE DEFAULT NULL, phone_confirmed_at timestamptz,
  phone_change text DEFAULT '', phone_change_token varchar(255) DEFAULT '', phone_change_sent_at timestamptz,
  confirmed_at timestamptz, email_change_token_current varchar(255) DEFAULT '', email_change_confirm_status smallint DEFAULT 0,
  banned_until timestamptz, reauthentication_token varchar(255) DEFAULT '', reauthentication_sent_at timestamptz,
  is_sso_user boolean NOT NULL DEFAULT false, deleted_at timestamptz, is_anonymous boolean NOT NULL DEFAULT false
);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.sub', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text $$;
CREATE OR REPLACE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.email', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'))::text $$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY, name text NOT NULL, owner uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  public boolean DEFAULT false, avif_autodetection boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[], owner_id text, type text DEFAULT 'STANDARD'
);
CREATE UNIQUE INDEX IF NOT EXISTS bname ON storage.buckets (name);
CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets(id), name text, owner uuid,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), last_accessed_at timestamptz DEFAULT now(),
  metadata jsonb, path_tokens text[] GENERATED ALWAYS AS (string_to_array(name, '/')) STORED, version text, owner_id text, user_metadata jsonb, level integer
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE _parts text[]; BEGIN SELECT string_to_array(name, '/') INTO _parts; RETURN _parts[1:array_length(_parts,1)-1]; END $$;
CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE _parts text[]; BEGIN SELECT string_to_array(name, '/') INTO _parts; RETURN _parts[array_length(_parts,1)]; END $$;
CREATE OR REPLACE FUNCTION storage.extension(name text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE _parts text[]; _filename text; BEGIN SELECT string_to_array(name, '/') INTO _parts; SELECT _parts[array_length(_parts,1)] INTO _filename;
RETURN reverse(split_part(reverse(_filename), '.', 1)); END $$;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
GRANT ALL ON storage.objects, storage.buckets TO anon, authenticated, service_role;
CREATE SCHEMA IF NOT EXISTS realtime;
CREATE SCHEMA IF NOT EXISTS graphql_public;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN CREATE PUBLICATION supabase_realtime; END IF; END $$;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;
`;

// ── the applier and the baseline restorer, the repo's own (scripts/src) ───────

async function scripts(): Promise<{ A: any; B: any }> {
  const A = await import(pathToFileURL(join(REPO, "scripts/src/apply-migrations.ts")).href);
  const B = await import(pathToFileURL(join(REPO, "scripts/src/beta-db-core.ts")).href);
  return { A, B };
}

/** The chain in apply order, as the applier computes it. */
export async function chainOrder(): Promise<string[]> {
  const { A } = await scripts();
  return A.orderMigrations(A.listMigrationFiles(MIGRATIONS), A.readOrderOverrides(MIGRATIONS)) as string[];
}

// ── PGlite ─────────────────────────────────────────────────────────────────────

async function pgliteModules(): Promise<{ PGlite: any; extensions: Record<string, unknown>; version: string }> {
  const root = PGLITE_ROOT;
  const { PGlite } = await import(pathToFileURL(join(root, "pglite/dist/index.js")).href);
  const contrib = async (n: string) => (await import(pathToFileURL(join(root, `pglite/dist/contrib/${n}.js`)).href))[n];
  const { postgis } = await import(pathToFileURL(join(root, "pglite-postgis/dist/index.js")).href);
  const v = (p: string) => JSON.parse(readFileSync(join(root, p, "package.json"), "utf8")).version as string;
  return {
    PGlite,
    extensions: { pgcrypto: await contrib("pgcrypto"), uuid_ossp: await contrib("uuid_ossp"), pg_trgm: await contrib("pg_trgm"), unaccent: await contrib("unaccent"), postgis },
    version: `pglite@${v("pglite")}+postgis@${v("pglite-postgis")}`,
  };
}

const errText = (e: any) => `${e?.code ? e.code + ": " : ""}${String(e?.message ?? e).split("\n")[0]}`;

export interface ReplayReport { engine: string; key: string; applied: number; excluded: string[]; variantExcluded: string[]; standIn: string; seconds: number }

async function replayInto(dir: string, without: readonly string[]): Promise<ReplayReport> {
  const t0 = Date.now();
  const { PGlite, extensions, version } = await pgliteModules();
  const { A, B } = await scripts();
  const db = new PGlite(dir, { extensions });
  await db.waitReady;
  const reset = async () => { try { await db.exec("ROLLBACK"); } catch { /* none open */ } await db.exec("RESET ALL; RESET ROLE;"); };
  await db.exec(SHIM);
  const model = B.loadBaselineModel();
  const executed = model.statements.filter((s: any) => s.decision.action === "execute");
  await db.exec(B.buildCreateExtensionsSql());
  await db.exec(B.buildRunFunctionSql());
  for (const b of B.planBatches(executed, B.BATCH_SIZE)) await db.exec(B.buildBatchQuery(b.map((s: any) => s.code)).sql);
  await db.exec(B.DROP_SCRATCH_SQL);
  // the reference rows pre-2093 migrations seeded on production (as the packet's base build and the beta rehearsal do)
  const tables = new Set<string>(B.REFERENCE_PUBLIC_TABLES ?? []);
  for (const f of (A.listMigrationFiles(MIGRATIONS) as string[]).filter((x) => x < "2093")) {
    for (const s of B.splitTopLevelStatements(readFileSync(join(MIGRATIONS, f), "utf8")).statements) {
      const m = /^insert\s+into\s+(?:public\.)?"?([a-z_]+)"?/i.exec(s.code.trim());
      if (!(m && tables.has(m[1]!.toLowerCase())) && !/^insert\s+into\s+storage\.buckets\b/i.exec(s.code.trim())) continue;
      try { await db.exec(s.code); } catch { await reset(); }
    }
  }
  const order = (await chainOrder()).filter((f) => f >= "2093");
  const skip = new Set<string>([...PACKET_EXCLUDED, STAND_IN]);
  const wanted = (f: string) => !without.some((n) => f.startsWith(`${n}_`));
  let applied = 0;
  const excluded: string[] = [];
  const variantExcluded: string[] = [];
  for (const f of order) {
    if (skip.has(f)) { excluded.push(f); continue; }
    if (!wanted(f)) { excluded.push(f); continue; }
    try {
      await db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
      applied++;
    } catch (e) {
      await reset();
      if (without.length === 0) { await db.close(); throw new Error(`pressedLayoverDb: chain replay failed at ${f}: ${errText(e)}`); }
      variantExcluded.push(`${f} (${errText(e)})`); // depends on an excluded file
    }
    await reset();
  }
  // 3982's stand-in: the ledger row the main packet records, nothing else (no pgvector here)
  const ledger = (await db.query(`SELECT to_regclass('public.schema_migration_ledger') IS NOT NULL AS ok`)).rows[0] as { ok: boolean };
  if (ledger.ok) await db.exec(`INSERT INTO public.schema_migration_ledger (filename, checksum, applied_by, notes) VALUES (${lit(STAND_IN)}, ${lit(sha(readFileSync(join(MIGRATIONS, STAND_IN))))}, 'manual', 'HARNESS-ONLY STAND-IN: 3982 needs pgvector, which PGlite lacks') ON CONFLICT (filename) DO NOTHING`);
  await db.exec("ALTER DATABASE postgres SET timezone TO 'UTC'");
  await db.close();
  return { engine: version, key: "", applied, excluded, variantExcluded, standIn: STAND_IN, seconds: Math.round((Date.now() - t0) / 1000) };
}

function cacheKey(engine: string, without: readonly string[], order: string[]): string {
  const h = createHash("sha256");
  h.update(`v1|${engine}|without=${[...without].sort().join(",")}|`);
  h.update(SHIM);
  h.update(readFileSync(BASELINE));
  h.update(readFileSync(join(MIGRATIONS, "ORDER_OVERRIDES.json")));
  for (const f of order) { h.update(f); h.update(readFileSync(join(MIGRATIONS, f))); }
  for (const s of ["scripts/src/beta-db-core.ts", "scripts/src/apply-migrations.ts"]) h.update(readFileSync(join(REPO, s)));
  return h.digest("hex").slice(0, 24);
}

const CACHE_ROOT = (process.env["PRESSED_LAYOVER_CACHE"] ?? "").trim() || join(tmpdir(), "portava-pressed-layover");

/** The cached replay for `without` (built once, by one process; others wait for READY). */
export async function cachedReplay(without: readonly string[] = []): Promise<{ dir: string; report: ReplayReport }> {
  const { version } = await pgliteModules();
  const order = await chainOrder();
  const key = cacheKey(version, without, order);
  const dir = join(CACHE_ROOT, key);
  const ready = join(dir, "READY.json");
  mkdirSync(CACHE_ROOT, { recursive: true });
  const lock = join(CACHE_ROOT, `${key}.lock`);
  const deadline = Date.now() + 20 * 60_000;
  for (;;) {
    if (existsSync(ready)) return { dir, report: JSON.parse(readFileSync(ready, "utf8")) as ReplayReport };
    try {
      mkdirSync(lock);
    } catch {
      // another process is building it; a lock older than 20 minutes is a crashed build
      try { if (Date.now() - statSync(lock).mtimeMs > 20 * 60_000) rmSync(lock, { recursive: true, force: true }); } catch { /* gone */ }
      if (Date.now() > deadline) throw new Error(`pressedLayoverDb: timed out waiting for ${lock}`);
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    try {
      if (existsSync(ready)) continue;
      const tmp = `${dir}.build-${process.pid}`;
      rmSync(tmp, { recursive: true, force: true });
      const report = { ...(await replayInto(tmp, without)), key };
      rmSync(dir, { recursive: true, force: true });
      renameSync(tmp, dir);
      writeFileSync(ready, JSON.stringify(report, null, 2));
      pruneCache(key);
      return { dir, report };
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
}

/** Keep the newest few replays (each is ~130 MB, and the key moves whenever any migration does). */
function pruneCache(keep: string): void {
  const max = Number(process.env["PRESSED_LAYOVER_CACHE_KEEP"] ?? 6);
  try {
    const dirs = readdirSync(CACHE_ROOT)
      .filter((d) => /^[0-9a-f]{24}$/.test(d) && existsSync(join(CACHE_ROOT, d, "READY.json")))
      .map((d) => ({ d, t: statSync(join(CACHE_ROOT, d, "READY.json")).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { d } of dirs.slice(Math.max(1, max))) if (d !== keep) rmSync(join(CACHE_ROOT, d), { recursive: true, force: true });
  } catch { /* pruning is housekeeping; a failure here must not fail a suite */ }
}

// ── the psql engine (CI's local-db job) ───────────────────────────────────────

interface PsqlRan { ok: boolean; stdout: string; code: string; message: string; detail: string }
function psqlRun(script: string): PsqlRan {
  const r = spawnSync("psql", ["-X", "-q", "-1", "-v", "ON_ERROR_STOP=1", "-At", LOCAL_DB_URL], {
    input: `\\set VERBOSITY verbose\n${script}\n`, encoding: "utf8", timeout: 120_000, maxBuffer: 256 * 1024 * 1024, // the catalog read alone is several MB on the full chain; spawnSync's 1 MB default would truncate it
  });
  if (r.status === 0) return { ok: true, stdout: (r.stdout ?? "").replace(/\n$/, ""), code: "", message: "", detail: "" };
  const stderr = r.stderr ?? "";
  const m = /ERROR:\s+([0-9A-Z]{5}):\s+(.*)/.exec(stderr);
  const d = /DETAIL:\s+(.*)/.exec(stderr);
  return { ok: false, stdout: "", code: m?.[1] ?? "XX000", message: m?.[2]?.trim() ?? stderr.trim(), detail: d?.[1]?.trim() ?? "" };
}

// ── the handle a suite gets ────────────────────────────────────────────────────

export interface PressedUser { id: string; token: string; handle: string }

export interface PressedDb {
  backend: PressedBackend;
  report: ReplayReport | null;
  /** The service client the routes use (inject with `_setTestClient`). */
  client: any;
  bridge: Bridge;
  /** Superuser SQL (setup and assertions). */
  query<T = Row>(sql: string): Promise<T[]>;
  exec(sql: string): Promise<void>;
  /** The same SQL run as `authenticated` with this user's `sub` (RLS applies), in one transaction; returns the last statement's rows. */
  asUser<T = Row>(userId: string, sql: string): Promise<T[]>;
  /** A supabase-js client that is the CLIENT side: role `authenticated`, the user's sub, RLS and grants apply. */
  userClient(userId: string): any;
  seedUser(label: string): Promise<PressedUser>;
  tokens: Record<string, string>;
  /** Set a flag ON/OFF, or delete its row ("absent"). Restored on close() for psql. */
  setFlag(flag: string, state: boolean | "absent", metadata?: Record<string, unknown>): Promise<void>;
  /** Many flags at once (two statements), restored on close() for psql like setFlag. */
  setFlags(flags: Record<string, boolean>): Promise<void>;
  flag(flag: string): Promise<boolean | "absent">;
  /** The planner's plan for `sql` (EXPLAIN, FORMAT JSON) with sequential scans discouraged, as text. */
  explain(sql: string): Promise<string>;
  /** Does relation public.<name> exist? */
  hasTable(name: string): Promise<boolean>;
  close(): Promise<void>;
}

let instanceSeq = 0;

export async function openPressedLayoverDb(opts: { without?: readonly string[] } = {}): Promise<PressedDb> {
  if (!PRESSED_BACKEND) throw new Error(String(PRESSED_SKIP_REASON));
  const without = opts.without ?? [];
  const tokens: Record<string, string> = {};
  const seeded: string[] = [];
  const flagsTouched = new Map<string, { enabled: boolean; metadata: unknown } | "absent">();
  let engine: BridgeEngine & { exec(sql: string): Promise<void>; close(): Promise<void> };
  let report: ReplayReport | null = null;
  const prelude = (role: string, claims: Record<string, unknown>) =>
    `SET LOCAL ROLE ${role}; SET LOCAL TIME ZONE 'UTC'; SELECT set_config('request.jwt.claims', ${lit(JSON.stringify(claims))}, true), set_config('request.jwt.claim.role', ${lit(String(claims["role"] ?? ""))}, true), set_config('request.jwt.claim.sub', ${lit(String(claims["sub"] ?? ""))}, true);`;

  if (PRESSED_BACKEND === "pglite") {
    const cached = await cachedReplay(without);
    report = cached.report;
    const work = mkdtempSync(join(tmpdir(), "pressed-layover-"));
    cpSync(cached.dir, join(work, "pgdata"), { recursive: true });
    rmSync(join(work, "pgdata", "READY.json"), { force: true });
    const { PGlite, extensions } = await pgliteModules();
    const db = new PGlite(join(work, "pgdata"), { extensions });
    await db.waitReady;
    await db.exec("SET TIME ZONE 'UTC'");
    engine = {
      async request(statements, role, claims) {
        return db.transaction(async (tx: any) => {
          await tx.exec(prelude(role, claims));
          let last: any = null;
          for (const s of statements) last = await tx.query(s);
          const row = last?.rows?.[0];
          const v = row ? Object.values(row)[0] : null;
          return typeof v === "string" ? v : JSON.stringify(v ?? null);
        });
      },
      async query(sql) { return (await db.query(sql)).rows as Row[]; },
      async exec(sql) { await db.exec(sql); },
      async close() { await db.close(); rmSync(work, { recursive: true, force: true }); },
    };
  } else {
    const call = (script: string) => {
      const r = psqlRun(script);
      if (!r.ok) throw Object.assign(new Error(r.message), { code: r.code, detail: r.detail });
      return r.stdout;
    };
    engine = {
      async request(statements, role, claims) {
        const body = statements.slice(0, -1).map((s) => `${s};`).join("\n");
        return call(`\\o /dev/null\n${prelude(role, claims)}\n${body}\n\\o\n${statements[statements.length - 1]};`);
      },
      async query(sql) { return JSON.parse(call(`SELECT COALESCE(json_agg(_t.*), '[]'::json)::text FROM (${sql}) _t;`) || "[]") as Row[]; },
      async exec(sql) { call(sql); },
      async close() { /* the harness database outlives the suite */ },
    };
  }

  const url = `http://pressed-layover-${process.pid}-${++instanceSeq}.invalid`;
  const bridge = makeBridge(engine, { url, tokens: () => tokens });
  const { _markPostgrestBackedForTest } = await import("../../lib/supabase.js");
  _markPostgrestBackedForTest(bridge.client);

  const handle: PressedDb = {
    backend: PRESSED_BACKEND,
    report,
    client: bridge.client,
    bridge,
    tokens,
    query: (sql) => engine.query(sql) as any,
    exec: (sql) => engine.exec(sql),
    async asUser(userId, sql) {
      const body = sql.trim().replace(/;$/, "");
      const wrapped = /^(INSERT|UPDATE|DELETE)\b/i.test(body)
        ? `WITH _t AS (${body}) SELECT COALESCE(json_agg(_t.*), '[]'::json)::text FROM _t`
        : `SELECT COALESCE(json_agg(_t.*), '[]'::json)::text FROM (${body}) _t`;
      const text = await engine.request([wrapped], "authenticated", { role: "authenticated", sub: userId });
      return JSON.parse(text) as any[];
    },
    userClient(userId) {
      return makeBridge(engine, { url: `${url.replace(".invalid", "")}-as-${userId.slice(0, 8)}.invalid`, tokens: () => tokens, role: "authenticated", sub: userId }).client;
    },
    async seedUser(label) {
      const id = randomUUID();
      const handleName = `${label.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}_${id.slice(0, 8)}`;
      await engine.exec(
        // (id, email, created_at) only: the columns both shims declare (scripts/local-db/shim.sql has no aud/role)
        `INSERT INTO auth.users (id, email, created_at) VALUES (${lit(id)}, ${lit(`${handleName}@pressed.test`)}, now());` +
        `INSERT INTO public.profiles (id, handle, name) VALUES (${lit(id)}, ${lit(handleName)}, ${lit(label)}) ON CONFLICT (id) DO NOTHING;`,
      );
      const token = `pressed-token-${id}`;
      tokens[token] = id;
      seeded.push(id);
      return { id, token, handle: handleName };
    },
    async setFlag(flag, state, metadata) {
      if (!flagsTouched.has(flag)) {
        const cur = await engine.query(`SELECT enabled, metadata FROM public.feature_flags WHERE flag = ${lit(flag)}`);
        flagsTouched.set(flag, cur[0] ? { enabled: Boolean(cur[0]["enabled"]), metadata: cur[0]["metadata"] ?? null } : "absent");
      }
      if (state === "absent") { await engine.exec(`DELETE FROM public.feature_flags WHERE flag = ${lit(flag)}`); return; }
      const md = metadata === undefined ? "" : `, metadata = ${dollar(JSON.stringify(metadata))}::jsonb`;
      await engine.exec(
        `INSERT INTO public.feature_flags (flag, enabled${metadata === undefined ? "" : ", metadata"}) VALUES (${lit(flag)}, ${state}${metadata === undefined ? "" : `, ${dollar(JSON.stringify(metadata))}::jsonb`}) ` +
        `ON CONFLICT (flag) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()${md}`,
      );
    },
    async setFlags(flags) {
      const names = Object.keys(flags);
      if (names.length === 0) return;
      const cur = await engine.query(`SELECT flag, enabled, metadata FROM public.feature_flags WHERE flag IN (${names.map(lit).join(", ")})`);
      const byName = new Map(cur.map((r) => [String(r["flag"]), r]));
      for (const f of names) {
        if (flagsTouched.has(f)) continue;
        const r = byName.get(f);
        flagsTouched.set(f, r ? { enabled: Boolean(r["enabled"]), metadata: r["metadata"] ?? null } : "absent");
      }
      await engine.exec(`INSERT INTO public.feature_flags (flag, enabled) VALUES ${names.map((f) => `(${lit(f)}, ${flags[f] === true})`).join(", ")} ON CONFLICT (flag) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`);
    },
    async flag(flag) {
      const r = await engine.query(`SELECT enabled FROM public.feature_flags WHERE flag = ${lit(flag)}`);
      return r[0] ? Boolean(r[0]["enabled"]) : "absent";
    },
    async explain(sql) {
      return engine.request([`SELECT set_config('enable_seqscan', 'off', true)`, `EXPLAIN (FORMAT JSON) ${sql}`], "service_role", { role: "service_role" });
    },
    async hasTable(name) {
      const r = await engine.query(`SELECT to_regclass(${lit(`public.${name}`)}) IS NOT NULL AS ok`);
      return Boolean(r[0]?.["ok"]);
    },
    async close() {
      if (PRESSED_BACKEND === "psql") {
        for (const [flag, prev] of flagsTouched) {
          try {
            if (prev === "absent") await engine.exec(`DELETE FROM public.feature_flags WHERE flag = ${lit(flag)}`);
            else await engine.exec(`UPDATE public.feature_flags SET enabled = ${prev.enabled}, metadata = ${prev.metadata === null ? "NULL" : `${dollar(JSON.stringify(prev.metadata))}::jsonb`} WHERE flag = ${lit(flag)}`);
          } catch { /* best effort; the harness database is throwaway */ }
        }
        for (const id of seeded) {
          try { await engine.exec(`DELETE FROM public.profiles WHERE id = ${lit(id)}; DELETE FROM auth.users WHERE id = ${lit(id)};`); } catch { /* an append-only ledger may keep a row; throwaway */ }
        }
      }
      await engine.close();
    },
  };
  return handle;
}

/** Every migration file whose number is one of `numbers`, in the chain (for reporting a press). */
export function migrationFilesFor(numbers: readonly string[]): string[] {
  return readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && numbers.some((n) => f.startsWith(`${n}_`))).sort();
}

// ── the press, and its falsifying arms ─────────────────────────────────────────
//
// Every pressed-state case is written ONCE, as the pressed claim. `B1P_ARM`
// re-runs the same assertions with the press withheld, which is how a suite
// proves the press is what completes the row (the lane's red/green evidence):
//   pressed   (default) — the named migrations are in the chain and the flags are ON;
//   flag-off  — same chain, the press's flags OFF;
//   absent    — the chain WITHOUT the press's migrations (pglite only), flags as seeded.
export type PressArm = "pressed" | "flag-off" | "absent";
export const PRESS_ARM: PressArm = (["pressed", "flag-off", "absent"] as const).find((a) => a === (process.env["B1P_ARM"] ?? "pressed")) ?? "pressed";

export interface Press { migrations: readonly string[]; flags: Readonly<Record<string, boolean>> }

/** Open the database for a press under the current arm. */
export async function openForPress(press: Press, arm: PressArm = PRESS_ARM): Promise<PressedDb> {
  if (arm === "absent" && PRESSED_BACKEND !== "pglite") throw new Error("the migration-absent arm needs the pglite backend");
  return openPressedLayoverDb({ without: arm === "absent" ? press.migrations : [] });
}

/**
 * `B1P_OFF=<flag>[,<flag>]` narrows the flag-off arm to the named flags (the rest of the press stays ON),
 * so each row's OWN flag can be shown to be the one that completes it.
 */
export const PRESS_OFF_ONLY: readonly string[] = (process.env["B1P_OFF"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** Apply the press's flags under the current arm (absent: leave the chain's seeds alone). */
export async function applyPress(db: PressedDb, press: Press, arm: PressArm = PRESS_ARM): Promise<void> {
  if (arm === "absent") return;
  for (const [flag, on] of Object.entries(press.flags)) {
    const off = arm === "flag-off" && (PRESS_OFF_ONLY.length === 0 || PRESS_OFF_ONLY.includes(flag));
    if (!off) await db.setFlag(flag, on);
    else if (on) await db.setFlag(flag, false);
  }
}
