/** Reversible fixture snapshots, never database clones. Only the designated
 * loopback test database is reset, under the caller's exclusive database lease.
 * A recovery marker survives crashes; a later run refuses to overwrite it. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Client } from 'pg';
import type { ReplayReport } from './pressedLayoverDb.js';

const run = promisify(execFile);
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
export function reusableDatabaseName(url: URL): string {
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!['portava_local', 'portava_ci_repairs'].includes(name)) throw new Error('Pressed replay requires the designated reusable test database');
  return name;
}

export interface ReusableDatabaseIdentity { name: string; role: string; host: string | null; cluster: string }
/** Docker port forwarding preserves a loopback client destination but reports
 * the container's internal server address. Accept it only when the job has
 * independently pinned this exact cluster through its service container. */
export function assertReusableDatabaseIdentity(identity: ReusableDatabaseIdentity, url: URL, expectedCluster = process.env.PORTAVA_TEST_CLUSTER_ID): void {
  const name = reusableDatabaseName(url);
  const loopback = identity.host === '127.0.0.1' || identity.host === '::1';
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || identity.name !== name || identity.role !== 'postgres' ||
      typeof identity.host !== 'string' || !/^\d+$/.test(identity.cluster) || (expectedCluster !== undefined && identity.cluster !== expectedCluster) ||
      (!loopback && (!expectedCluster || !/^\d+$/.test(expectedCluster)))) throw new Error('Pressed replay target identity mismatch');
}

export async function openSnapshotLease(db: Client, url: URL, recoveryChecksum?: string) {
  const name = reusableDatabaseName(url);
  const identity = (await db.query(`SELECT current_database() AS name, current_user AS role,
    host(inet_server_addr()) AS host, system_identifier::text AS cluster FROM pg_control_system()`)).rows[0];
  assertReusableDatabaseIdentity(identity, url);
  if (!(await db.query("SELECT pg_try_advisory_lock(hashtext('pressed-reusable-fixture')) AS locked")).rows[0].locked) throw new Error('Pressed fixture already leased; close the current whole-database variant first');
  const root = join(process.env.PRESSED_SNAPSHOT_ROOT || tmpdir(), 'portava-pressed-snapshots', `${identity.cluster}-${name}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const marker = join(root, 'RECOVERY.json');
  const recovery = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) as { identity: typeof identity; baseline: string; checksum: string } : null;
  if (recovery && !recoveryChecksum) throw new Error(`Unfinished pressed recovery; inspect ${marker} before another replay`);
  if (recoveryChecksum && (!recovery || recovery.checksum !== recoveryChecksum || recovery.identity.cluster !== identity.cluster || recovery.identity.name !== name || recovery.baseline !== join(root, 'recovery.dump'))) throw new Error('Explicit recovery does not match the recorded fixture identity and checksum');
  for (const table of ['auth.users', 'public.profiles']) {
    if ((await db.query('SELECT to_regclass($1) AS relation', [table])).rows[0].relation &&
      Number((await db.query(`SELECT count(*) FROM ${table}`)).rows[0].count)) throw new Error('Pressed replay refuses a database containing user fixtures; finish their cleanup first');
  }
  if ((await db.query("SELECT 1 FROM pg_extension WHERE extname='pg_cron'")).rowCount &&
    (await db.query("SELECT current_setting('cron.launch_active_jobs',true) AS value")).rows[0].value !== 'off') throw new Error('Pressed replay requires the disposable scheduler to be disabled');

  // Passwords stay out of process arguments and error messages.
  const connection = new URL(url); const password = decodeURIComponent(connection.password); connection.password = '';
  const env = { ...process.env, ...(password ? { PGPASSWORD: password } : {}) };
  const command = async (tool: string, args: string[]) => {
    try { return (await run(tool, args, { env, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 })).stdout; }
    catch (error) { const e = error as { stderr?: string; code?: unknown }; throw new Error(`${tool} failed (${String(e.code)}): ${(e.stderr ?? '').slice(-2000)}`); }
  };
  const save = async (path: string) => {
    const temporary = path + '.building';
    await command('pg_dump', ['--format=custom', '--file', temporary, '--dbname', connection.toString()]);
    await command('pg_restore', ['--list', temporary]);
    renameSync(temporary, path);
    return digest(path);
  };
  const clear = async () => {
    await db.query('ROLLBACK; RESET ROLE; RESET ALL; SET lock_timeout=\'5s\'');
    // These are database-level objects, not children of an application schema.
    // Publications are part of the synthetic Supabase shim and must be reset
    // with it. External integrations are never disposable fixture contents.
    const external = (await db.query('SELECT (SELECT count(*) FROM pg_subscription) + (SELECT count(*) FROM pg_foreign_server) + (SELECT count(*) FROM pg_largeobject_metadata) AS count')).rows[0];
    if (Number(external.count)) throw new Error('Pressed reset refuses subscriptions, foreign servers or large objects');
    const publications = (await db.query('SELECT pubname FROM pg_publication')).rows;
    const extensions = (await db.query("SELECT extname FROM pg_extension WHERE extname<>'plpgsql'")).rows;
    const schemas = (await db.query("SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema'")).rows;
    await db.query('BEGIN');
    try {
      for (const row of publications) await db.query(`DROP PUBLICATION ${quote(row.pubname)}`);
      for (const row of extensions) await db.query(`DROP EXTENSION IF EXISTS ${quote(row.extname)} CASCADE`);
      for (const row of schemas) await db.query(`DROP SCHEMA IF EXISTS ${quote(row.nspname)} CASCADE`);
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; }
  };
  const restore = async (path: string, checksum: string) => {
    if (digest(path) !== checksum) throw new Error('Pressed snapshot checksum mismatch; reset refused');
    const contents = await command('pg_restore', ['--list', path]);
    // A SCHEMA TOC entry may contain only ALTER OWNER: pg_dump assumes
    // initdb already created public. Inspect that entry's actual SQL.
    const schemaList = join(root, 'public-schema.list');
    writeFileSync(schemaList, contents.split('\n').filter(line => /\bSCHEMA - public\s/.test(line)).join('\n') + '\n', { mode: 0o600 });
    let schemaSql: string;
    try { schemaSql = await command('pg_restore', ['--use-list', schemaList, '--file=-', path]); }
    finally { rmSync(schemaList, { force: true }); }
    await clear();
    if (!/^CREATE SCHEMA (?:public|"public")(?:\s|;)/m.test(schemaSql)) await db.query('CREATE SCHEMA public AUTHORIZATION postgres');
    await command('pg_restore', ['--exit-on-error', '--single-transaction', '--dbname', connection.toString(), path]);
  };
  const baseline = join(root, 'recovery.dump');
  const checksum = recovery ? recovery.checksum : await save(baseline);
  if (!recovery) writeFileSync(marker, JSON.stringify({ identity, baseline, checksum }), { mode: 0o600 });
  let restored = false;
  return {
    clear,
    async cached(key: string): Promise<ReplayReport | null> {
      const path = join(root, `${key}.dump`), meta = join(root, `${key}.json`);
      if (!existsSync(meta)) return null;
      const saved = JSON.parse(readFileSync(meta, 'utf8')) as { checksum: string; report: ReplayReport };
      if (saved.report.key !== key) throw new Error('Pressed cached report identity mismatch');
      await restore(path, saved.checksum);
      return saved.report;
    },
    async cache(key: string, report: ReplayReport) {
      const path = join(root, `${key}.dump`);
      const checksum = await save(path);
      writeFileSync(join(root, `${key}.json`), JSON.stringify({ checksum, report }), { mode: 0o600 });
      const cached = readdirSync(root).filter(file => /^[a-f0-9]{24}\.json$/.test(file))
        .sort((a, b) => statSync(join(root, b)).mtimeMs - statSync(join(root, a)).mtimeMs);
      for (const old of cached.slice(6)) {
        if (old === `${key}.json`) continue;
        rmSync(join(root, old)); rmSync(join(root, old.replace(/\.json$/, '.dump')), { force: true });
      }
    },
    async restore() {
      if (restored) return;
      await restore(baseline, checksum);
      restored = true;
      rmSync(marker); rmSync(baseline);
    },
  };
}
