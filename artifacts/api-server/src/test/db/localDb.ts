/**
 * localDb.ts — the database-backed suites' one door to PostgreSQL.
 *
 * No driver: `psql` over a child process, the convention
 * scripts/src/saved-places-truncate-guard.test.ts established, so the suite
 * adds nothing to the lockfile and talks to the database exactly as an
 * operator would. Every call is one psql invocation; multi-statement work
 * goes through exec()/tx() as one script so `set_config(..., true)` and
 * `SET LOCAL ROLE` hold for the statements after them.
 *
 * HAVE_DB is false when LOCAL_DB_URL is unset — the ordinary `pnpm test` run
 * has no database. The suites skip on !HAVE_DB the way tripKernelLive.test.ts
 * skips on !CREDS, and scripts/local-db/run-tests.sh is the run that refuses
 * skipped > 0, so the skip can never be mistaken for a pass where it counts.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

export const LOCAL_DB_URL = (process.env["LOCAL_DB_URL"] ?? "").trim();
export const HAVE_DB = LOCAL_DB_URL !== "";

export interface PsqlResult { status: number; stdout: string; stderr: string }

let databaseUrlOverride: string | null = null;
const seededFixtureUsers = new Map<string, string>();

/**
 * Point every call made by THIS test process at another database on the same
 * server — a throwaway clone a suite created as an isolated fixture — or back
 * at LOCAL_DB_URL with null. node:test runs each file in its own process, so
 * the override never reaches another suite.
 */
export function useDatabase(url: string | null): void {
  databaseUrlOverride = url;
}

/** The database the next call will reach. */
export function currentDatabaseUrl(): string {
  return databaseUrlOverride ?? LOCAL_DB_URL;
}

/** One psql invocation over stdin. `single` wraps the script in one transaction (-1). */
export function psql(script: string, opts: { single?: boolean } = {}): PsqlResult {
  if (!HAVE_DB) throw new Error("localDb: LOCAL_DB_URL is not set");
  const args = ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-At", currentDatabaseUrl()];
  if (opts.single) args.splice(1, 0, "-1");
  const r = spawnSync("psql", args, { input: script, encoding: "utf8", timeout: 60_000 });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Run a script; throw with psql's stderr on failure. Returns stdout lines. */
export function exec(script: string, opts: { single?: boolean } = {}): string[] {
  const r = psql(script, opts);
  if (r.status !== 0) throw new Error(`psql exited ${r.status}:\n${r.stderr.trim()}\n--- script ---\n${script}`);
  return r.stdout.split("\n").filter((l) => l.length > 0);
}

/** Run a SELECT and get its rows as JSON objects (the query is wrapped in json_agg). The wrapper aggregates `t.*`, never a bare `t`: when the query has a column named t, PostgreSQL resolves a bare `t` to THAT column before the whole-row reference, so every row came back as its t value alone (census-trips TR79's CI failure; the same collapse hid columns from four more call sites in the payment and creator-ledger suites). */
export function rows<T = Record<string, unknown>>(query: string): T[] {
  const out = exec(`SELECT COALESCE(json_agg(t.*), '[]'::json)::text FROM (${query}) t;`);
  return JSON.parse(out.join("\n") || "[]") as T[];
}

/** A single scalar (first column of the first row) as text; null when no row. */
export function scalar(query: string): string | null {
  const out = exec(query);
  return out.length === 0 ? null : out[0]!;
}

/** Dollar-quote a JSON value for embedding in a script (never string-escaped by hand). */
export function jsonLiteral(value: unknown): string {
  const text = JSON.stringify(value);
  let tag = "j";
  while (text.includes(`$${tag}$`)) tag += "j";
  return `$${tag}$${text}$${tag}$::jsonb`;
}

/**
 * The service path: what server/trips/commandRoute.ts does through the service
 * client. service_role bypasses RLS (shim) and the kernel authorizes on
 * `actor_user_id` in the command, so the actor is the command's, not a JWT's.
 */
export function kernel(command: Record<string, unknown>): any {
  const out = exec(
    `SET LOCAL ROLE service_role;\nSELECT public.trip_kernel_execute(${jsonLiteral(command)})::text;`,
    { single: true },
  );
  return JSON.parse(out.join("\n"));
}

/** A command envelope the way the route builds it: ids fresh, actor explicit. */
export function command(over: Record<string, unknown>): Record<string, unknown> {
  return {
    command_id: randomUUID(),
    actor_role: "user",
    idempotency_key: randomUUID(),
    correlation_id: randomUUID(),
    client_observed_at: new Date().toISOString(),
    ...over,
  };
}

/**
 * Run a script AS a signed-in user through RLS: `authenticated` role plus the
 * JWT GUCs auth.uid() reads. This is the PostgREST path, not the service path.
 */
export function asUser(userId: string, script: string): string[] {
  return exec(
    [
      `SELECT set_config('request.jwt.claim.sub', '${userId}', true);`,
      `SELECT set_config('request.jwt.claim.role', 'authenticated', true);`,
      `SET LOCAL ROLE authenticated;`,
      script,
    ].join("\n"),
    { single: true },
  ).slice(2);
}

/** Insert an auth.users + profiles pair; returns the id. */
export function seedUser(label: string): string {
  const id = randomUUID();
  const handle = `${label}_${id.slice(0, 8)}`;
  exec(
    `INSERT INTO auth.users (id, email) VALUES ('${id}', '${handle}@local.test');\n` +
    `INSERT INTO public.profiles (id, handle, name) VALUES ('${id}', '${handle}', '${label}');`,
  );
  seededFixtureUsers.set(id, currentDatabaseUrl());
  return id;
}

/** Fixture teardown only: never use this to exercise a product deletion.
 * Local, process-seeded owners only. Table locks keep temporary guard changes
 * invisible to other writers; failure rolls back rows AND trigger state.
 * Every other trigger, FK, and moderation protection remains enabled.
 */
export function cleanupSyntheticMedia(userIds: readonly string[]): void {
  const ids = [...new Set(userIds)];
  if (!ids.length) return;
  const target = currentDatabaseUrl();
  const url = new URL(target);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('fixture cleanup requires a local database');
  if (ids.some(id => seededFixtureUsers.get(id) !== target)) throw new Error('fixture cleanup requires users seeded by this process in this database');
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!/^[a-zA-Z0-9_]+$/.test(database)) throw new Error('fixture cleanup database identity is invalid');
  const cluster = process.env.PORTAVA_TEST_CLUSTER_ID;
  if (cluster !== undefined && !/^[0-9]+$/.test(cluster)) throw new Error('fixture cleanup cluster identity is invalid');
  const who = ids.map(id => `'${id}'`).join(',');
  const catalog = `SELECT COALESCE(jsonb_agg(jsonb_build_object('relation',t.tgrelid::regclass::text,'name',t.tgname,
    'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid),'function',pg_get_functiondef(t.tgfoid)) ORDER BY t.tgrelid,t.tgname),'[]'::jsonb)
    FROM pg_trigger t JOIN (VALUES ('public.post_media'::regclass,'postcard_retention_source_guard'),
      ('public.media_assets'::regclass,'retained_media_purge_guard')) g(relation,name)
      ON t.tgrelid=g.relation AND t.tgname=g.name`;
  exec(`DO $fixture_media_cleanup$
    DECLARE before_guards jsonb; after_guards jsonb; guard jsonb;
    BEGIN
      IF current_database()<>'${database}' ${cluster ? `OR (SELECT system_identifier::text FROM pg_control_system())<>'${cluster}'` : ''} THEN
        RAISE EXCEPTION 'fixture database identity changed';
      END IF;
      LOCK TABLE public.media_assets,public.post_media IN ACCESS EXCLUSIVE MODE;
      PERFORM 1 FROM auth.users WHERE id IN (${who}) FOR SHARE;
      IF (SELECT count(*) FROM auth.users WHERE id IN (${who}) AND email LIKE '%@local.test')<>${ids.length} THEN
        RAISE EXCEPTION 'fixture cleanup requires existing synthetic identities';
      END IF;
      ${catalog} INTO before_guards;
      FOR guard IN SELECT value FROM jsonb_array_elements(before_guards) LOOP
        IF guard->>'enabled' NOT IN ('O','A') THEN RAISE EXCEPTION 'fixture retention guard is not enabled'; END IF;
        EXECUTE format('ALTER TABLE %s DISABLE TRIGGER %I',guard->>'relation',guard->>'name');
      END LOOP;
      DELETE FROM public.media_assets WHERE owner_user_id IN (${who});
      DELETE FROM public.post_media WHERE user_id IN (${who});
      FOR guard IN SELECT value FROM jsonb_array_elements(before_guards) LOOP
        EXECUTE format('ALTER TABLE %s ENABLE %s TRIGGER %I',guard->>'relation',
          CASE WHEN guard->>'enabled'='A' THEN 'ALWAYS' ELSE '' END,guard->>'name');
      END LOOP;
      ${catalog} INTO after_guards;
      IF before_guards IS DISTINCT FROM after_guards THEN RAISE EXCEPTION 'fixture retention guards changed'; END IF;
    END;$fixture_media_cleanup$;`, { single: true });
}

/** Remove this synthetic owner's reservations before trips: the append-only event guard
 * permits cascade only after its reservation parent is gone. Keep that guard active. */
export function deleteUser(id: string): void {
  // service_role owns the public rows; auth.users is GoTrue's and the service
  // role has no privilege on it (true on Supabase too), so that one delete runs
  // as the harness superuser after RESET ROLE.
  exec(
    `SET LOCAL ROLE service_role;\nDELETE FROM public.trip_reservations WHERE trip_id IN (SELECT id FROM public.trips WHERE owner_id = '${id}');\nDELETE FROM public.trips WHERE owner_id = '${id}';\nDELETE FROM public.profiles WHERE id = '${id}';\nRESET ROLE;\nDELETE FROM auth.users WHERE id = '${id}';`,
    { single: true },
  );
}

/**
 * SQL that removes a suite's OWN synthetic creator-ledger rows, for an after()
 * hook on the throwaway harness. 3510 refuses every DELETE of a ledger row while
 * C-11 is undecided — that refusal is what it is for — so cleanup switches
 * session_replication_role to `replica` for these statements: superuser-only
 * (Supabase's service_role cannot), and it also skips FK cascades, so children
 * are deleted first and `origin` is restored before anything else runs.
 */
export function creatorLedgerPurgeSql(beneficiaryIds: readonly string[], bookingIds: readonly string[] = []): string {
  const ids = (xs: readonly string[]) => (xs.length ? xs : ["00000000-0000-0000-0000-000000000000"]).map((x) => `'${x}'`).join(",");
  const who = ids(beneficiaryIds);
  const atts = `(SELECT id FROM public.creator_attributions WHERE beneficiary_user_id IN (${who}))`;
  return (
    "SET session_replication_role = replica; " +
    `DELETE FROM public.creator_ledger_audit_events WHERE attribution_id IN ${atts} OR resulting_attribution_id IN ${atts}; ` +
    `DELETE FROM public.creator_earning_entries WHERE attribution_id IN ${atts} OR beneficiary_user_id IN (${who}); ` +
    `DELETE FROM public.creator_attributions WHERE beneficiary_user_id IN (${who}); ` +
    `DELETE FROM public.rent_buddy_earnings_entries WHERE beneficiary_user_id IN (${who}) OR booking_id IN (${ids(bookingIds)}); ` +
    "SET session_replication_role = origin;"
  );
}
