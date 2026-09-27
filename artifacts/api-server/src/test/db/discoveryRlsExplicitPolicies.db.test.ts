/**
 * discoveryRlsExplicitPolicies — census-discovery DV-71 / §54: migration 3390
 * and its rollback, executed against real PostgreSQL 16.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/discoveryRlsExplicitPolicies.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every
 *      src/test/db suite; scripts/local-db/run-tests.sh refuses a skipped run.
 *
 * THE REQUIREMENT: `10` §5 — "Every user-visible table must explicitly define:
 * read policy, insert policy, update policy, delete policy … Do not rely only
 * on API filtering."
 *
 * WHAT THE HARNESS MODELS: the PostgREST roles, auth.uid() from the GUC
 * PostgREST sets, and the real tables, policies and grants the chain builds.
 * There is no PostgREST process; each request is the SQL PostgREST would issue,
 * run under `SET LOCAL ROLE anon|authenticated` exactly as its request would be.
 *
 * PROPERTIES
 *   R0  the catalogue: on all sixteen Discovery tables RLS is on, and for anon
 *       and authenticated EACH of SELECT / INSERT / UPDATE / DELETE is either a
 *       kept permissive path (with its predicate unchanged and its privilege
 *       held) or an explicit RESTRICTIVE deny (with its privilege revoked); no
 *       client holds TRUNCATE / REFERENCES / TRIGGER; the momentum rebuild is
 *       not client-executable.
 *   R1  cross-user denial, per operation, on the four own-row tables — and the
 *       owner's legitimate path still works.
 *   R2  anon: the public catalogue reads active places only; everything else
 *       is refused, every operation.
 *   R3  authenticated, on the eight service-only tables: every operation refused.
 *   R4  the three public Trail tables still read; nothing writes.
 *   R5  a re-GRANT no longer reopens a write: the restrictive policy holds.
 *   R6  the server's path (service_role) still performs every operation its
 *       privileges allow, on every table.
 *   R7  the rollback restores the pre-3390 posture (every 3390 policy gone, the
 *       chain's DML privileges back, service_role untouched), and 3390
 *       re-applies to the identical catalogue.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, exec, psql, rows, seedUser, deleteUser } from "./localDb.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(__dir, "../../migrations/3390_discovery_rls_explicit_policies.sql");
const ROLLBACK = resolve(__dir, "../../../../../db/rollback/2026-09-27-3390-discovery-rls-explicit-policies-rollback.sql");

const OPS = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;
type Op = (typeof OPS)[number];
type Role = "anon" | "authenticated";

/** The sixteen, re-derived from the migrations (3390's header). */
const TABLES = [
  "discovery_places", "discovery_place_saves", "discovery_place_reports", "discovery_cache",
  "discovery_geocode_cache", "discovery_shadow_serves", "discovery_place_photos", "place_momentum",
  "trails", "content_trails", "trail_edges", "trail_follows", "trail_reports",
  "trail_health_snapshots", "recommendations", "rank_events",
] as const;
type Table = (typeof TABLES)[number];

/** The declared posture: the client paths that stay, with the predicate each must still carry. */
const KEPT: Array<{ t: Table; op: Op; role: Role; policy: string; qual: string | null; check: string | null }> = [
  { t: "discovery_places",        op: "SELECT", role: "anon",          policy: "discovery_places_public_read", qual: "(status = 'active'::text)", check: null },
  { t: "discovery_places",        op: "SELECT", role: "authenticated", policy: "discovery_places_public_read", qual: "(status = 'active'::text)", check: null },
  { t: "discovery_place_saves",   op: "SELECT", role: "authenticated", policy: "Users read own saves",         qual: "(auth.uid() = user_id)", check: null },
  { t: "discovery_place_saves",   op: "INSERT", role: "authenticated", policy: "Users insert own saves",       qual: null, check: "(auth.uid() = user_id)" },
  { t: "discovery_place_reports", op: "SELECT", role: "authenticated", policy: "auth_select_own_report",       qual: "(reporter_id = auth.uid())", check: null },
  { t: "discovery_place_reports", op: "INSERT", role: "authenticated", policy: "auth_insert_own_report",       qual: null, check: "(reporter_id = auth.uid())" },
  { t: "trails",                  op: "SELECT", role: "authenticated", policy: "trails_public_select",         qual: "(lifecycle_status <> 'archived'::text)", check: null },
  { t: "content_trails",          op: "SELECT", role: "authenticated", policy: "content_trails_public_select", qual: "true", check: null },
  { t: "trail_edges",             op: "SELECT", role: "authenticated", policy: "trail_edges_public_select",    qual: "true", check: null },
  { t: "trail_follows",           op: "SELECT", role: "authenticated", policy: "trail_follows_own_select",     qual: "(user_id = auth.uid())", check: null },
  { t: "rank_events",             op: "SELECT", role: "authenticated", policy: "users_read_own_rank_events",   qual: "(auth.uid() = user_id)", check: null },
];
const kept = (t: string, op: Op, role: Role) => KEPT.find((k) => k.t === t && k.op === op && k.role === role);
const SERVICE_ONLY: Table[] = TABLES.filter((t) => !KEPT.some((k) => k.t === t));

type Who = { role: "anon" } | { role: "authenticated"; uid: string };
function prelude(who: Who): string {
  if (who.role === "anon") {
    return `DO $p$ BEGIN PERFORM set_config('request.jwt.claim.role', 'anon', true); END $p$;\nSET LOCAL ROLE anon;\n`;
  }
  return (
    `DO $p$ BEGIN PERFORM set_config('request.jwt.claim.sub', '${who.uid}', true);` +
    ` PERFORM set_config('request.jwt.claim.role', 'authenticated', true); END $p$;\n` +
    `SET LOCAL ROLE authenticated;\n`
  );
}
function runAs(who: Who, sql: string) {
  return psql(prelude(who) + sql, { single: true });
}
function okAs(who: Who, sql: string): string[] {
  const r = runAs(who, sql);
  assert.equal(r.status, 0, `expected success as ${who.role}:\n${sql}\n${r.stderr}`);
  return r.stdout.split("\n").filter((l) => l.length > 0);
}
function privilegeDenied(who: Who, table: string, sql: string): void {
  const r = runAs(who, sql);
  assert.notEqual(r.status, 0, `expected a refusal as ${who.role}, got success:\n${sql}\n${r.stdout}`);
  assert.match(r.stderr, new RegExp(`permission denied for table ${table}`), `expected a privilege refusal as ${who.role}:\n${sql}\n${r.stderr}`);
}
function rlsDenied(who: Who, table: string, sql: string): void {
  const r = runAs(who, sql);
  assert.notEqual(r.status, 0, `expected an RLS refusal as ${who.role}, got success:\n${sql}\n${r.stdout}`);
  assert.match(r.stderr, new RegExp(`new row violates row-level security policy (".+" )?for table "${table}"`), `${who.role}:\n${sql}\n${r.stderr}`);
}

function unwrapped(path: string): string {
  const sql = readFileSync(path, "utf8");
  const begin = sql.search(/^BEGIN;\s*$/m);
  const commit = sql.lastIndexOf("\nCOMMIT;");
  assert.ok(begin >= 0 && commit > begin, `${path}: no BEGIN … COMMIT wrapper`);
  return sql.slice(sql.indexOf("\n", begin) + 1, commit) + "\n" + sql.slice(commit + "\nCOMMIT;".length);
}

const TABLE_ARRAY = `ARRAY[${TABLES.map((t) => `'${t}'`).join(",")}]`;
/** One line of JSON: every policy on the sixteen, and every privilege every role holds on them. */
const SNAPSHOT = `SELECT json_build_object(
  'policies', (SELECT json_agg(x ORDER BY x) FROM (
      SELECT c.relname || '|' || p.polname || '|' || p.polcmd::text || '|' || p.polpermissive::text || '|' ||
             coalesce(pg_get_expr(p.polqual, p.polrelid), '') || '|' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') || '|' ||
             (SELECT string_agg(CASE WHEN r = 0 THEN 'PUBLIC' ELSE r::regrole::text END, ',' ORDER BY 1) FROM unnest(p.polroles) r) AS x
        FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
       WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY (${TABLE_ARRAY})) s),
  'privs', (SELECT json_agg(x ORDER BY x) FROM (
      SELECT g.table_name || '|' || g.grantee || '|' || g.privilege_type AS x
        FROM information_schema.role_table_grants g
       WHERE g.table_schema = 'public' AND g.table_name = ANY (${TABLE_ARRAY})
         AND g.grantee IN ('anon','authenticated','service_role')) s)
)::text;`;

let A = "";       // viewer A
let B = "";       // viewer B
let PLACE = "";   // an active discovery place, submitted by A
let PENDING = ""; // a pending place, submitted by A
let TRAIL = "";   // an active trail
let TRAIL2 = "";  // a second trail (edges need two)
let ARCHIVED = "";// an archived trail
const RE_B = randomUUID();

describe("census-discovery DV-71 — 3390: every Discovery table defines all four client operations explicitly", { skip: !HAVE_DB }, () => {
  before(() => {
    A = seedUser("p9rls_a");
    B = seedUser("p9rls_b");
    PLACE = randomUUID(); PENDING = randomUUID(); TRAIL = randomUUID(); TRAIL2 = randomUUID(); ARCHIVED = randomUUID();
    exec(`
      INSERT INTO public.discovery_places (id, name, place_type, submitted_by, status) VALUES
        ('${PLACE}', 'p9 active', 'restaurant', '${A}', 'active'),
        ('${PENDING}', 'p9 pending', 'restaurant', '${A}', 'pending');
      INSERT INTO public.discovery_place_saves (user_id, place_id) VALUES ('${A}', '${PLACE}'), ('${B}', '${PLACE}');
      INSERT INTO public.discovery_place_reports (place_id, reporter_id, reason) VALUES ('${PLACE}', '${A}', 'a'), ('${PLACE}', '${B}', 'b');
      INSERT INTO public.rank_events (user_id, item_id, surface) VALUES ('${A}', 'db/${PLACE}', 'discovery'), ('${B}', 'db/${PLACE}', 'discovery');
      INSERT INTO public.trails (id, slug, title, lifecycle_status) VALUES
        ('${TRAIL}', 'p9-${TRAIL.slice(0, 8)}', 'p9 trail', 'active'),
        ('${TRAIL2}', 'p9-${TRAIL2.slice(0, 8)}', 'p9 trail 2', 'active'),
        ('${ARCHIVED}', 'p9-${ARCHIVED.slice(0, 8)}', 'p9 archived', 'archived');
      INSERT INTO public.content_trails (trail_id, source_type, source_id, relationship) VALUES ('${TRAIL}', 'place', '${PLACE}', 'primary');
      INSERT INTO public.trail_edges (from_trail_id, to_trail_id, edge_type) VALUES ('${TRAIL}', '${TRAIL2}', 'related');
      INSERT INTO public.trail_follows (trail_id, user_id) VALUES ('${TRAIL}', '${A}'), ('${TRAIL}', '${B}');
      INSERT INTO public.trail_reports (trail_id, reported_by, reason) VALUES ('${TRAIL}', '${A}', 'stale');
      INSERT INTO public.trail_health_snapshots (trail_id, metrics, model_version) VALUES ('${TRAIL}', '{}'::jsonb, 'p9');
      INSERT INTO public.discovery_place_photos (place_key, source, photo_url, expires_at) VALUES ('p9:${RE_B}', 'google', 'https://x', now() + interval '1 day');
    `);
  });

  after(() => {
    exec(`
      DELETE FROM public.trails WHERE id IN ('${TRAIL}', '${TRAIL2}', '${ARCHIVED}');
      DELETE FROM public.discovery_place_photos WHERE place_key = 'p9:${RE_B}';
      DELETE FROM public.rank_events WHERE user_id IN ('${A}', '${B}');
      DELETE FROM public.discovery_places WHERE id IN ('${PLACE}', '${PENDING}');
    `);
    deleteUser(A);
    deleteUser(B);
  });

  it("R0. the catalogue: each operation is a kept path or an explicit restrictive deny, for both client roles", () => {
    const pol = rows<{ tbl: string; polname: string; cmd: string; permissive: boolean; roles: string[]; qual: string | null; wcheck: string | null }>(`
      SELECT c.relname AS tbl, p.polname, p.polcmd::text AS cmd, p.polpermissive AS permissive,
             ARRAY(SELECT CASE WHEN r = 0 THEN 'PUBLIC' ELSE r::regrole::text END FROM unnest(p.polroles) r) AS roles,
             pg_get_expr(p.polqual, p.polrelid) AS qual, pg_get_expr(p.polwithcheck, p.polrelid) AS wcheck
        FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
       WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY (${TABLE_ARRAY})`);
    const cmdOf: Record<Op, string> = { SELECT: "r", INSERT: "a", UPDATE: "w", DELETE: "d" };
    const failures: string[] = [];
    for (const t of TABLES) {
      const rls = rows<{ on: boolean }>(`SELECT relrowsecurity AS on FROM pg_class WHERE oid = 'public.${t}'::regclass`)[0]!.on;
      if (!rls) failures.push(`${t}: RLS off`);
      for (const op of OPS) {
        const forOp = pol.filter((p) => p.tbl === t && p.cmd === cmdOf[op]
          && p.roles.some((r) => r === "PUBLIC" || r === "anon" || r === "authenticated"));
        if (forOp.length === 0) failures.push(`${t} ${op}: no policy names this operation for a client role`);
        for (const role of ["anon", "authenticated"] as Role[]) {
          const holds = rows<{ h: boolean }>(`SELECT has_table_privilege('${role}', 'public.${t}', '${op}') AS h`)[0]!.h;
          const deny = pol.some((p) => p.tbl === t && !p.permissive && p.cmd === cmdOf[op] && p.roles.includes(role));
          const k = kept(t, op, role);
          if (k) {
            const p = pol.find((x) => x.tbl === t && x.polname === k.policy);
            if (!p || !p.permissive) failures.push(`${t} ${op} ${role}: kept policy ${k.policy} missing`);
            else if (p.qual !== k.qual || p.wcheck !== k.check) failures.push(`${t} ${op} ${role}: ${k.policy} predicate changed (${p.qual} / ${p.wcheck})`);
            if (!holds) failures.push(`${t} ${op} ${role}: kept path has no privilege`);
            if (deny) failures.push(`${t} ${op} ${role}: kept path is denied`);
          } else {
            if (holds) failures.push(`${t} ${op} ${role}: privilege held outside the posture`);
            if (!deny) failures.push(`${t} ${op} ${role}: no explicit restrictive deny`);
          }
        }
      }
      for (const priv of ["TRUNCATE", "REFERENCES", "TRIGGER"]) {
        for (const role of ["anon", "authenticated"]) {
          if (rows<{ h: boolean }>(`SELECT has_table_privilege('${role}', 'public.${t}', '${priv}') AS h`)[0]!.h) failures.push(`${t} ${priv} ${role}: held`);
        }
      }
    }
    const fnExec = rows<{ a: boolean; u: boolean }>(`SELECT has_function_privilege('anon', 'public.rebuild_place_momentum(timestamptz)', 'EXECUTE') AS a,
                                                            has_function_privilege('authenticated', 'public.rebuild_place_momentum(timestamptz)', 'EXECUTE') AS u`)[0]!;
    if (fnExec.a || fnExec.u) failures.push("rebuild_place_momentum is client-executable");
    assert.deepEqual(failures, [], failures.join("\n"));
  });

  it("R1a. discovery_place_saves: A reads only A's, inserts only as A, and updates or deletes nothing", () => {
    const a: Who = { role: "authenticated", uid: A };
    assert.deepEqual(okAs(a, `SELECT user_id FROM public.discovery_place_saves WHERE place_id = '${PLACE}';`), [A]);
    rlsDenied(a, "discovery_place_saves", `INSERT INTO public.discovery_place_saves (user_id, place_id) VALUES ('${B}', '${PENDING}');`);
    okAs(a, `INSERT INTO public.discovery_place_saves (user_id, place_id) VALUES ('${A}', '${PENDING}');`); // the owner's path (removed with the place in after())
    privilegeDenied(a, "discovery_place_saves", `UPDATE public.discovery_place_saves SET saved_at = now() WHERE user_id = '${B}';`);
    privilegeDenied(a, "discovery_place_saves", `UPDATE public.discovery_place_saves SET saved_at = now() WHERE user_id = '${A}';`);
    privilegeDenied(a, "discovery_place_saves", `DELETE FROM public.discovery_place_saves WHERE user_id = '${B}';`);
  });

  it("R1b. discovery_place_reports: A reads only A's, files only as A, and edits or withdraws nothing", () => {
    const a: Who = { role: "authenticated", uid: A };
    assert.deepEqual(okAs(a, `SELECT reporter_id FROM public.discovery_place_reports WHERE place_id = '${PLACE}';`), [A]);
    rlsDenied(a, "discovery_place_reports", `INSERT INTO public.discovery_place_reports (place_id, reporter_id, reason) VALUES ('${PLACE}', '${B}', 'x');`);
    okAs(a, `INSERT INTO public.discovery_place_reports (place_id, reporter_id, reason) VALUES ('${PENDING}', '${A}', 'x');`); // one report per (place, reporter)
    privilegeDenied(a, "discovery_place_reports", `UPDATE public.discovery_place_reports SET notes = 'x' WHERE reporter_id = '${B}';`);
    privilegeDenied(a, "discovery_place_reports", `DELETE FROM public.discovery_place_reports WHERE reporter_id = '${B}';`);
  });

  it("R1c. rank_events: A reads only A's events and writes none", () => {
    const a: Who = { role: "authenticated", uid: A };
    assert.deepEqual(okAs(a, `SELECT user_id FROM public.rank_events WHERE item_id = 'db/${PLACE}';`), [A]);
    privilegeDenied(a, "rank_events", `INSERT INTO public.rank_events (user_id, item_id, surface) VALUES ('${A}', 'x', 'discovery');`);
    privilegeDenied(a, "rank_events", `UPDATE public.rank_events SET outcome = 'dismiss' WHERE user_id = '${B}';`);
    privilegeDenied(a, "rank_events", `DELETE FROM public.rank_events WHERE user_id = '${B}';`);
  });

  it("R1d. trail_follows: A reads only A's follows and writes none", () => {
    const a: Who = { role: "authenticated", uid: A };
    assert.deepEqual(okAs(a, `SELECT user_id FROM public.trail_follows WHERE trail_id = '${TRAIL}';`), [A]);
    privilegeDenied(a, "trail_follows", `INSERT INTO public.trail_follows (trail_id, user_id) VALUES ('${TRAIL2}', '${A}');`);
    privilegeDenied(a, "trail_follows", `UPDATE public.trail_follows SET created_at = now() WHERE user_id = '${B}';`);
    privilegeDenied(a, "trail_follows", `DELETE FROM public.trail_follows WHERE user_id = '${B}';`);
  });

  it("R2. anon: active places read, pending ones do not; every other table and every write is refused", () => {
    const anon: Who = { role: "anon" };
    assert.deepEqual(okAs(anon, `SELECT id FROM public.discovery_places WHERE id IN ('${PLACE}', '${PENDING}');`), [PLACE]);
    for (const t of TABLES) {
      if (t !== "discovery_places") privilegeDenied(anon, t, `SELECT 1 FROM public.${t} LIMIT 1;`);
      privilegeDenied(anon, t, `DELETE FROM public.${t};`);
      privilegeDenied(anon, t, `UPDATE public.${t} SET ${firstColumn(t)} = ${firstColumn(t)} WHERE false;`);
    }
    privilegeDenied(anon, "discovery_places", `INSERT INTO public.discovery_places (name, place_type) VALUES ('forge', 'bar');`);
  });

  it("R3. authenticated, on the service-only tables: all four operations refused", () => {
    const a: Who = { role: "authenticated", uid: A };
    assert.deepEqual([...SERVICE_ONLY].sort(), [
      "discovery_cache", "discovery_geocode_cache", "discovery_place_photos", "discovery_shadow_serves",
      "place_momentum", "recommendations", "trail_health_snapshots", "trail_reports",
    ]);
    for (const t of SERVICE_ONLY) {
      privilegeDenied(a, t, `SELECT 1 FROM public.${t} LIMIT 1;`);
      privilegeDenied(a, t, `INSERT INTO public.${t} DEFAULT VALUES;`);
      privilegeDenied(a, t, `UPDATE public.${t} SET ${firstColumn(t)} = ${firstColumn(t)} WHERE false;`);
      privilegeDenied(a, t, `DELETE FROM public.${t};`);
    }
  });

  it("R4. the public Trail tables still read (not archived); nothing writes", () => {
    const a: Who = { role: "authenticated", uid: A };
    assert.deepEqual(okAs(a, `SELECT id FROM public.trails WHERE id IN ('${TRAIL}', '${ARCHIVED}');`), [TRAIL]);
    assert.equal(okAs(a, `SELECT count(*) FROM public.content_trails WHERE trail_id = '${TRAIL}';`)[0], "1");
    assert.equal(okAs(a, `SELECT count(*) FROM public.trail_edges WHERE from_trail_id = '${TRAIL}';`)[0], "1");
    for (const t of ["trails", "content_trails", "trail_edges"] as const) {
      privilegeDenied(a, t, `INSERT INTO public.${t} DEFAULT VALUES;`);
      privilegeDenied(a, t, `DELETE FROM public.${t};`);
    }
    privilegeDenied(a, "trails", `UPDATE public.trails SET title = 'x' WHERE id = '${TRAIL}';`);
  });

  it("R5. a re-GRANT does not reopen a write: the restrictive policy refuses it on its own", () => {
    // Inside one transaction that is rolled back: grant the privilege 3390
    // revoked, then attempt the write the grant would have allowed.
    const r = psql(
      `GRANT INSERT ON public.discovery_places TO authenticated;\n` +
      `GRANT UPDATE ON public.discovery_place_saves TO authenticated;\n` +
      prelude({ role: "authenticated", uid: A }) +
      `UPDATE public.discovery_place_saves SET saved_at = now() WHERE user_id = '${A}' RETURNING 1;\n` +
      `INSERT INTO public.discovery_places (name, place_type, submitted_by, verified, status) VALUES ('forge', 'bar', '${A}', true, 'active');\n`,
      { single: true },
    );
    assert.notEqual(r.status, 0, "the §6 D6 forge must be refused even with the INSERT privilege back");
    assert.equal(r.stdout.trim(), "", "the UPDATE must reach no row: its restrictive USING (false) hides every row");
    assert.match(r.stderr, /new row violates row-level security policy "discovery_places_deny_insert_clients" for table "discovery_places"/,
      "the refusal must come from 3390's restrictive policy, by name");
  });

  it("R6. the server's path (service_role) performs every operation its privileges allow, on every table", () => {
    // Column names chosen not to collide with localDb.rows()'s own subquery alias `t`.
    const writable = rows<{ tbl: string; priv: string }>(`
      SELECT g.table_name AS tbl, g.privilege_type AS priv FROM information_schema.role_table_grants g
       WHERE g.table_schema = 'public' AND g.table_name = ANY (${TABLE_ARRAY}) AND g.grantee = 'service_role'
         AND g.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE')`);
    const holds = (t: string, op: string) => writable.some((w) => w.tbl === t && w.priv === op);
    for (const t of TABLES) assert.ok(holds(t, "SELECT") && holds(t, "INSERT"), `${t}: service_role must read and insert`);
    const ins: Record<Table, string> = {
      discovery_places: `INSERT INTO public.discovery_places (name, place_type) VALUES ('svc', 'bar') RETURNING ctid`,
      discovery_place_saves: `INSERT INTO public.discovery_place_saves (user_id, place_id) VALUES ('${B}', '${PENDING}') RETURNING ctid`,
      discovery_place_reports: `INSERT INTO public.discovery_place_reports (place_id, reporter_id, reason) VALUES ('${PENDING}', '${B}', 'svc') RETURNING ctid`,
      discovery_cache: `INSERT INTO public.discovery_cache (cache_key, destination, category, radius_km, expires_at) VALUES ('p9:${RE_B}', 'x', 'x', 1, now()) RETURNING ctid`,
      discovery_geocode_cache: `INSERT INTO public.discovery_geocode_cache (location_key, lat, lng, display_name, expires_at) VALUES ('p9:${RE_B}', 0, 0, 'x', now()) RETURNING ctid`,
      discovery_shadow_serves: `INSERT INTO public.discovery_shadow_serves (user_id, destination, category, radius_km, page, page_size, serve_point, legacy_total, pde_total, overlap_count, displaced_count, top_changed, engine_mode, mode_reason) VALUES ('${A}', 'x', 'x', 1, 0, 20, 1, 0, 0, 0, 0, false, 'shadow', 'resolved') RETURNING ctid`,
      discovery_place_photos: `INSERT INTO public.discovery_place_photos (place_key, source, photo_url, expires_at) VALUES ('p9svc:${RE_B}', 'google', 'https://y', now()) RETURNING ctid`,
      place_momentum: `INSERT INTO public.place_momentum (place_id, recent_rate, mid_rate, prior_rate, total_weight, trend_state, model_version, event_weights, window_ms, thresholds) VALUES ('p9', 0, 0, 0, 0, 'unknown', 'p9', '{}', '{}', '{}') RETURNING ctid`,
      trails: `INSERT INTO public.trails (slug, title) VALUES ('p9-svc-${RE_B.slice(0, 8)}', 'svc') RETURNING ctid`,
      content_trails: `INSERT INTO public.content_trails (trail_id, source_type, source_id, relationship) VALUES ('${TRAIL2}', 'place', '${PLACE}', 'supporting') RETURNING ctid`,
      trail_edges: `INSERT INTO public.trail_edges (from_trail_id, to_trail_id, edge_type) VALUES ('${TRAIL2}', '${TRAIL}', 'related') RETURNING ctid`,
      trail_follows: `INSERT INTO public.trail_follows (trail_id, user_id) VALUES ('${TRAIL2}', '${B}') RETURNING ctid`,
      trail_reports: `INSERT INTO public.trail_reports (trail_id, reason) VALUES ('${TRAIL2}', 'stale') RETURNING ctid`,
      trail_health_snapshots: `INSERT INTO public.trail_health_snapshots (trail_id, metrics, model_version) VALUES ('${TRAIL2}', '{}', 'svc') RETURNING ctid`,
      recommendations: `INSERT INTO public.recommendations (id, viewer_class, session_id, surface, serve_point, model_version, served_count, served_at) VALUES ('p9svc${RE_B.replace(/-/g, "").slice(0, 17)}', 'anonymous', '${RE_B}', 'discovery', 1, 'p9', 0, now()) RETURNING ctid`,
      rank_events: `INSERT INTO public.rank_events (user_id, item_id, surface) VALUES ('${B}', 'svc', 'discovery') RETURNING ctid`,
    };
    for (const t of TABLES) {
      // psql's \gset carries the inserted row's ctid to the next statement; the
      // whole sequence is one transaction that is rolled back.
      const steps = [`SET LOCAL ROLE service_role;`, `${ins[t]} \\gset ins_`,
        `SELECT count(*) FROM public.${t} WHERE ctid = :'ins_ctid';`];
      let at = "ins_ctid";
      if (holds(t, "UPDATE")) { steps.push(`UPDATE public.${t} SET ${firstColumn(t)} = ${firstColumn(t)} WHERE ctid = :'${at}' RETURNING ctid AS upd_ctid \\gset`); at = "upd_ctid"; }
      if (holds(t, "DELETE")) steps.push(`DELETE FROM public.${t} WHERE ctid = :'${at}' RETURNING 1;`);
      steps.push(`ROLLBACK;`);
      const r = psql(`BEGIN;\n${steps.join("\n")}`);
      assert.equal(r.status, 0, `${t}: the service path failed:\n${r.stderr}`);
      const lines = r.stdout.split("\n").filter((l) => l.length > 0);
      assert.equal(lines[0], "1", `${t}: the service role must read back the row it inserted`);
      if (holds(t, "DELETE")) assert.equal(lines[lines.length - 1], "1", `${t}: the service role must delete it`);
    }
  });

  it("R7. the rollback restores the pre-3390 posture and 3390 re-applies to the identical catalogue", () => {
    const out = exec(`BEGIN;\n${SNAPSHOT}\n${unwrapped(ROLLBACK)}\n${SNAPSHOT}\n${unwrapped(MIGRATION)}\n${SNAPSHOT}\nROLLBACK;`)
      .filter((l) => l.startsWith("{"));
    assert.equal(out.length, 3);
    const [applied, rolledBack, reapplied] = out.map((l) => JSON.parse(l) as { policies: string[]; privs: string[] });
    assert.deepEqual(reapplied, applied, "3390 must re-apply to exactly the catalogue it produced");
    const ours = applied!.policies.filter((p) => /\|[a-z_]+_deny_(select|insert|update|delete)_(clients|anon)\|/.test(p));
    assert.ok(ours.length >= 40, `expected the 3390 deny set, found ${ours.length}`);
    assert.deepEqual(rolledBack!.policies, applied!.policies.filter((p) => !ours.includes(p)),
      "the rollback drops exactly the 3390 policies and no other");
    const svc = (s: { privs: string[] }) => s.privs.filter((p) => p.includes("|service_role|"));
    assert.deepEqual(svc(rolledBack!), svc(applied!), "service_role privileges are identical with and without 3390");
    for (const restored of ["discovery_place_saves|anon|SELECT", "discovery_cache|authenticated|DELETE", "rank_events|authenticated|INSERT"]) {
      assert.ok(rolledBack!.privs.includes(restored), `the rollback restores the chain's ${restored}`);
      assert.ok(!applied!.privs.includes(restored), `3390 revoked ${restored}`);
    }
    for (const never of ["discovery_place_saves|anon|TRUNCATE", "rank_events|anon|TRUNCATE"]) {
      assert.ok(!rolledBack!.privs.includes(never), `the rollback must not restore ${never}`);
    }
  });
});

/** A column every table has, to write a no-op UPDATE against. */
function firstColumn(t: string): string {
  const special: Record<string, string> = {
    discovery_place_saves: "saved_at", trail_follows: "created_at", trail_edges: "updated_at",
    discovery_cache: "cache_key", discovery_geocode_cache: "location_key", discovery_place_photos: "place_key",
  };
  return special[t] ?? "id";
}
