/**
 * memorySnapshots.db.test.ts — the EXECUTING witness for 3811 (§3
 * `memory_snapshots`, its writer trigger on public.memories and its guard) on the
 * full chain scripts/local-db/up.sh replays: production's 2026-08-19 baseline
 * structure plus every migration, with every other memories trigger the chain
 * installs (3674's graph mirror, 3804's occurrence name) in place.
 * Census-highlights-memories H35; B58 cluster MEM-SNAPSHOTS.
 *
 * The route suite (src/test/memorySnapshots.test.ts) drives the API over a fake
 * whose trigger is the §25 harness's TypeScript model; this file is what proves
 * the SQL does what that model assumes, as the API's service role writes it.
 *
 *   D1  an INSERT and two place changes are versions 1..3 with the place history;
 *       a title / caption / coordinate edit writes nothing
 *   D2  property over EVERY column of public.memories, read from the catalog:
 *       only whitelisted keys are stored, and no other column's value appears
 *   D3  the cap keeps the newest 50
 *   D4  §21: the service code's purge (on service_role, over SQL) is refused
 *       while the Memory is live and leaves ZERO versions after its soft delete;
 *       the full lifecycle leaves zero too
 *   D5  RLS and the revokes: no client role reads, writes or executes; the
 *       server's role reads and purges and can neither insert nor rewrite
 *   D6  the §25 replay (the real reader) REPLAYS the real rows, and the
 *       TypeScript extractor equals the SQL one at every version
 *   D7  account deletion takes the history
 *   D8  the rollback refuses while history exists, drops everything when told
 *       to, and 3811 re-applied is today's catalog (inside BEGIN … ROLLBACK)
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, deleteUser, exec, psql, rows, scalar, seedUser } from "./localDb.js";
import { makeSqlClient, wrapForJson } from "./sqlPostgrestAdapter.js";
import {
  MEMORY_SNAPSHOT_CAP,
  MEMORY_SNAPSHOT_FACT_KEYS,
  eraseSnapshotsForDeletedMemory,
  factsEqual,
  snapshotFactsOf,
  whitelistFacts,
} from "../../services/memory/memorySnapshots.js";
import { replayMemoryFromSnapshots } from "../../services/memoryCertification/snapshotReplay.js";
import { runMemoryDeletionLifecycle } from "../../services/memory/memoryDeletionLifecycle.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(__dir, "../../migrations/3811_memory_snapshots.sql");
const ROLLBACK = resolve(__dir, "../../../../../db/rollback/2026-10-14-3811-memory-snapshots-rollback.sql");

let owner = "";
let other = "";
const TAG = `msn${randomUUID().slice(0, 8)}`;

/** One write as the API's service client makes it. */
const asService = (sql: string) => exec(`SET LOCAL ROLE service_role;\n${sql}`, { single: true });
const versions = (id: string) => (scalar(`SELECT coalesce(string_agg(version::text, ',' ORDER BY version), '') FROM public.memory_snapshots WHERE memory_id = '${id}'`) ?? "");
const placeHistory = (id: string) => (scalar(`SELECT coalesce(string_agg(coalesce(facts ->> 'place_id', '<null>'), ',' ORDER BY version), '') FROM public.memory_snapshots WHERE memory_id = '${id}'`) ?? "");
function newMemory(cols: Record<string, string | null> = {}): string {
  const id = randomUUID();
  const keys = ["id", "owner_id", "title", ...Object.keys(cols)];
  const vals = [`'${id}'`, `'${owner}'`, `'${TAG}'`, ...Object.values(cols).map((v) => (v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`))];
  asService(`INSERT INTO public.memories (${keys.join(", ")}) VALUES (${vals.join(", ")});`);
  return id;
}

/**
 * The supabase surface the service code uses, over SQL AS service_role (the
 * API's role), so a privilege 3811 does not grant fails here as it would live.
 */
const serviceClient = makeSqlClient(async (sql) => {
  const r = psql(`\\set VERBOSITY verbose\nSET LOCAL ROLE service_role;\n${wrapForJson(sql)};`, { single: true });
  if (r.status !== 0) {
    const m = /ERROR:\s+([0-9A-Z]{5}):\s*(.*)/.exec(r.stderr);
    throw { code: m?.[1], message: m?.[2] ?? r.stderr.trim() };
  }
  return JSON.parse(r.stdout.trim() || "[]"); // json_agg spans lines; -q prints no command tag
});

/** The Memory row (every column) and its item count, as the replay compares them. */
function canonical(id: string): { row: Record<string, unknown> | null; itemCount: number } {
  const [r] = rows<Record<string, unknown>>(`SELECT * FROM public.memories WHERE id = '${id}'`);
  const n = Number(scalar(`SELECT count(*) FROM public.memory_items WHERE memory_id = '${id}'`));
  return { row: r ?? null, itemCount: n };
}

describe("3811 on the full chain: memory_snapshots, its writer and its guard", { skip: !HAVE_DB }, () => {
  before(() => {
    owner = seedUser(TAG);
    other = seedUser(`${TAG}o`);
  });
  after(() => {
    if (owner) deleteUser(owner); // cascades the Memories and their history
    if (other) deleteUser(other);
  });

  test("D1 an INSERT and two place changes are versions 1..3 with the place history; non-fact edits write nothing", () => {
    const m = newMemory({ place_id: "fsq:a", caption: "CAPTION-MARK" });
    asService(`UPDATE public.memories SET place_id = 'fsq:b' WHERE id = '${m}';`);
    asService(`UPDATE public.memories SET place_id = 'fsq:c' WHERE id = '${m}';`);
    assert.equal(versions(m), "1,2,3");
    assert.equal(placeHistory(m), "fsq:a,fsq:b,fsq:c");
    asService(`UPDATE public.memories SET title = 'TITLE-MARK', caption = 'CAPTION-MARK-2', location_lat = 10.5, location_lng = 20.5, location_city = 'CITY-MARK', updated_at = now() WHERE id = '${m}';`);
    assert.equal(versions(m), "1,2,3", "a non-fact edit wrote a version");
    assert.equal(scalar(`SELECT count(*) FROM public.memory_snapshots WHERE memory_id = '${m}' AND (facts::text ~ 'MARK|10\\.5|20\\.5' OR cause <> '{}'::jsonb)`), "0");
    assert.equal(scalar(`SELECT engine_versions ->> 'snapshot' FROM public.memory_snapshots WHERE memory_id = '${m}' AND version = 1`), "memory-snapshot@1");
  });

  test("D2 property over every column of public.memories: only whitelisted keys, and no other column's value", () => {
    const cols = rows<{ attname: string; typ: string }>(
      `SELECT attname, format_type(atttypid, atttypmod) AS typ FROM pg_attribute
        WHERE attrelid = 'public.memories'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`);
    assert.ok(cols.length >= 20, `anti-vacuity: memories has ${cols.length} columns`);
    for (const c of ["title", "caption", "location_lat", "location_lng", "location_city", "location_country", "allowed_user_ids", "hidden_user_ids"]) {
      assert.ok(cols.some((x) => x.attname === c), `anti-vacuity: memories.${c}`);
    }
    // Every free-text column the trigger could ever see gets a marker; every numeric one a distinctive number.
    const m = newMemory({ place_id: "fsq:prop" });
    const sets = cols
      .filter((c) => !MEMORY_SNAPSHOT_FACT_KEYS.includes(c.attname) && !["id", "owner_id", "created_at", "updated_at", "trip_id", "event_id", "canonical_location_id"].includes(c.attname))
      .map((c) => (c.typ === "text" ? `${c.attname} = 'MARK-${c.attname}'` : c.typ === "numeric" ? `${c.attname} = 77.123456` : c.typ === "uuid[]" ? `${c.attname} = ARRAY['${other}'::uuid]` : null))
      .filter(Boolean);
    assert.ok(sets.length >= 6, `anti-vacuity: ${sets.length} non-fact columns marked`);
    asService(`UPDATE public.memories SET ${sets.join(", ")}, place_id = 'fsq:prop-2' WHERE id = '${m}';`);
    const stored = rows<{ facts: Record<string, unknown> }>(`SELECT facts FROM public.memory_snapshots WHERE memory_id = '${m}' ORDER BY version`);
    assert.equal(stored.length, 2);
    for (const s of stored) {
      for (const k of Object.keys(s.facts)) assert.ok(MEMORY_SNAPSHOT_FACT_KEYS.includes(k), `stored non-whitelisted key ${k}`);
      assert.doesNotMatch(JSON.stringify(s.facts), new RegExp(`MARK-|77\\.123456|${other}`));
    }
    // The CHECK refuses a non-fact from ANY writer, the table owner included.
    const r = psql(`INSERT INTO public.memory_snapshots (memory_id, owner_id, version, facts, engine_versions) VALUES ('${m}', '${owner}', 99, '{"caption": "x"}', '{"snapshot": "memory-snapshot@1"}');`, { single: true });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /memory_snapshots_facts_whitelist/);
  });

  test("D3 the cap keeps the newest 50", () => {
    const m = newMemory({ place_id: "fsq:p0" });
    asService(`DO $d$ BEGIN FOR i IN 1..55 LOOP UPDATE public.memories SET place_id = 'fsq:p' || i WHERE id = '${m}'; END LOOP; END $d$;`);
    const [s] = rows<{ n: number; lo: number; hi: number; newest: string }>(
      `SELECT count(*)::int AS n, min(version) AS lo, max(version) AS hi,
              (SELECT facts ->> 'place_id' FROM public.memory_snapshots WHERE memory_id = '${m}' ORDER BY version DESC LIMIT 1) AS newest
         FROM public.memory_snapshots WHERE memory_id = '${m}'`);
    assert.deepEqual(s, { n: MEMORY_SNAPSHOT_CAP, lo: 7, hi: 56, newest: "fsq:p55" });
  });

  test("D4 §21: the purge is refused while the Memory is live, and leaves zero versions after the soft delete", async () => {
    const m = newMemory({ place_id: "fsq:a" });
    asService(`UPDATE public.memories SET place_id = 'fsq:b' WHERE id = '${m}';`);
    const live = await eraseSnapshotsForDeletedMemory(serviceClient, { memoryId: m });
    assert.equal(live.state, "failed", JSON.stringify(live));
    assert.equal(versions(m), "1,2", "the guard kept a live Memory's history");
    asService(`UPDATE public.memories SET state = 'deleted', updated_at = now() WHERE id = '${m}';`);
    assert.equal(versions(m), "1,2", "the soft delete wrote no version");
    const purged = await eraseSnapshotsForDeletedMemory(serviceClient, { memoryId: m });
    assert.deepEqual(purged, { state: "done", purged: 2 });
    assert.equal(versions(m), "");

    // And the whole §21 lifecycle, whatever its other steps make of this harness.
    const m2 = newMemory({ place_id: "fsq:x" });
    asService(`UPDATE public.memories SET place_id = 'fsq:y' WHERE id = '${m2}';`);
    asService(`UPDATE public.memories SET state = 'deleted', updated_at = now() WHERE id = '${m2}';`);
    const report = await runMemoryDeletionLifecycle(serviceClient, {
      memoryId: m2, ownerId: owner, actorUserId: owner, previous: { visibility: "friends_only", state: "published" } as never,
    });
    const step = report.steps.find((s) => s.step === "RAW_EVIDENCE_PURGED")!;
    assert.notEqual(step.facts["snapshotsFailed"], true, JSON.stringify(step));
    assert.equal(versions(m2), "", `a version outlived §21: ${JSON.stringify(step)}`);
  });

  test("D5 RLS and the revokes: no client role, a read-and-purge-only server", () => {
    const [p] = rows<Record<string, boolean>>(`SELECT
      (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.memory_snapshots'::regclass) AS rls,
      NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.memory_snapshots'::regclass) AS no_policy,
      has_table_privilege('anon', 'public.memory_snapshots', 'SELECT') AS anon_select,
      has_table_privilege('authenticated', 'public.memory_snapshots', 'SELECT') AS auth_select,
      has_table_privilege('authenticated', 'public.memory_snapshots', 'INSERT') AS auth_insert,
      has_table_privilege('authenticated', 'public.memory_snapshots', 'DELETE') AS auth_delete,
      has_table_privilege('service_role', 'public.memory_snapshots', 'SELECT') AS svc_select,
      has_table_privilege('service_role', 'public.memory_snapshots', 'DELETE') AS svc_delete,
      has_table_privilege('service_role', 'public.memory_snapshots', 'INSERT') AS svc_insert,
      has_table_privilege('service_role', 'public.memory_snapshots', 'UPDATE') AS svc_update,
      has_function_privilege('anon', 'public.memory_snapshot_record()', 'EXECUTE') AS anon_exec,
      has_function_privilege('authenticated', 'public.memory_snapshot_record()', 'EXECUTE') AS auth_exec,
      has_function_privilege('authenticated', 'public.memory_snapshots_guard()', 'EXECUTE') AS auth_exec_guard`);
    assert.deepEqual(p, {
      rls: true, no_policy: true, anon_select: false, auth_select: false, auth_insert: false, auth_delete: false,
      svc_select: true, svc_delete: true, svc_insert: false, svc_update: false, anon_exec: false, auth_exec: false, auth_exec_guard: false,
    });
    const asAuth = psql(`SELECT set_config('request.jwt.claim.sub', '${owner}', true);\nSET LOCAL ROLE authenticated;\nSELECT count(*) FROM public.memory_snapshots;`, { single: true });
    assert.notEqual(asAuth.status, 0);
    assert.match(asAuth.stderr, /permission denied for table memory_snapshots/);
    const forge = psql(`SET LOCAL ROLE service_role;\nINSERT INTO public.memory_snapshots (memory_id, owner_id, version, facts, engine_versions) SELECT memory_id, owner_id, 999, facts, engine_versions FROM public.memory_snapshots LIMIT 1;`, { single: true });
    assert.notEqual(forge.status, 0);
    assert.match(forge.stderr, /permission denied for table memory_snapshots/);
    const rewrite = psql(`UPDATE public.memory_snapshots SET facts = '{}' WHERE owner_id = '${owner}';`, { single: true });
    assert.notEqual(rewrite.status, 0, "the table owner rewrote a version");
    assert.match(rewrite.stderr, /append-only/);
  });

  test("D6 the §25 replay REPLAYS the real rows, and the TypeScript extractor equals the SQL one at every version", async () => {
    const m = newMemory({ place_id: "fsq:a", starts_at: "2026-03-03T11:00:00.123456Z", location_precision: "neighborhood" });
    const seen: Array<{ v: number; expected: ReturnType<typeof snapshotFactsOf> }> = [];
    const step = (sql: string) => {
      asService(sql);
      const c = canonical(m);
      const v = Number(scalar(`SELECT max(version) FROM public.memory_snapshots WHERE memory_id = '${m}'`));
      seen.push({ v, expected: snapshotFactsOf(c.row!, c.itemCount) });
    };
    step(`UPDATE public.memories SET updated_at = updated_at WHERE id = '${m}';`);
    step(`INSERT INTO public.memory_items (memory_id, media_url) VALUES ('${m}', 'post-media/a.jpg'); UPDATE public.memories SET visibility = 'public' WHERE id = '${m}';`);
    step(`UPDATE public.memories SET place_id = 'fsq:b', ends_at = '2026-03-03T13:00:00Z', state = 'archived' WHERE id = '${m}';`);
    for (const s of seen) {
      const [stored] = rows<{ facts: Record<string, unknown> }>(`SELECT facts FROM public.memory_snapshots WHERE memory_id = '${m}' AND version = ${s.v}`);
      assert.ok(factsEqual(whitelistFacts(stored!.facts).facts, s.expected), `version ${s.v}: SQL ${JSON.stringify(stored!.facts)} vs TS ${JSON.stringify(s.expected)}`);
    }
    const replay = await replayMemoryFromSnapshots(serviceClient, { memoryId: m, ownerId: owner, canonical: canonical(m) });
    assert.equal(replay.status, "REPLAYED", replay.detail);
    assert.deepEqual(replay.versions, [1, 2, 3]);
    assert.deepEqual(replay.timeline[2]!.changed, ["ends_at", "place_id", "state"]);
    // Control: the Memory moved with the writer disabled — the replay must refuse it.
    exec(`ALTER TABLE public.memories DISABLE TRIGGER memory_snapshot_record;
          UPDATE public.memories SET place_id = 'fsq:unrecorded' WHERE id = '${m}';
          ALTER TABLE public.memories ENABLE TRIGGER memory_snapshot_record;`, { single: true });
    const stale = await replayMemoryFromSnapshots(serviceClient, { memoryId: m, ownerId: owner, canonical: canonical(m) });
    assert.equal(stale.status, "DIVERGED");
    assert.match(stale.detail, /place_id differ/);
  });

  test("D7 account deletion takes the history (both cascades)", () => {
    const u = seedUser(`${TAG}gone`);
    const id = randomUUID();
    asService(`INSERT INTO public.memories (id, owner_id, title, place_id) VALUES ('${id}', '${u}', 'gone', 'fsq:gone');`);
    assert.equal(versions(id), "1");
    deleteUser(u);
    assert.equal(scalar(`SELECT count(*) FROM public.memory_snapshots WHERE owner_id = '${u}'`), "0");
  });

  test("D8 the rollback refuses while history exists, drops all of 3811 when told to, and 3811 re-applied is today's catalog", () => {
    const unwrap = (path: string) => {
      const sql = readFileSync(path, "utf8");
      const begin = sql.search(/^BEGIN;\s*$/m);
      const commit = sql.lastIndexOf("\nCOMMIT;");
      return sql.slice(sql.indexOf("\n", begin) + 1, commit) + "\n" + sql.slice(commit + "\nCOMMIT;".length);
    };
    newMemory({ place_id: "fsq:keep" }); // there is history to protect
    const refused = psql(`BEGIN;\n${unwrap(ROLLBACK)}\nROLLBACK;`);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /ROLLBACK REFUSED \(3811\)/);
    const CATALOG = `SELECT json_build_object(
      'table', to_regclass('public.memory_snapshots') IS NOT NULL,
      'writer', EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.memories'::regclass AND tgname = 'memory_snapshot_record'),
      'fns', (SELECT count(*) FROM pg_proc WHERE proname IN ('memory_snapshot_record', 'memory_snapshots_guard')),
      'acl', (SELECT array_agg(x ORDER BY x) FROM (SELECT grantee::regrole::text || ':' || privilege_type AS x FROM pg_class c, LATERAL aclexplode(c.relacl) WHERE c.oid = to_regclass('public.memory_snapshots') AND grantee <> c.relowner) q))::text;`;
    const out = exec(`BEGIN;\n${CATALOG}\nSET LOCAL portava.rollback_3811_discard_history = 'discard';\n${unwrap(ROLLBACK)}\n${CATALOG}\n${unwrap(MIGRATION)}\n${CATALOG}\nROLLBACK;`)
      .filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
    const [now, rolled, reapplied] = out;
    assert.deepEqual(now.acl, ["service_role:DELETE", "service_role:SELECT"]);
    assert.deepEqual(rolled, { table: false, writer: false, fns: 0, acl: null });
    assert.deepEqual(reapplied, now, "3811 after its rollback is the state 3811 left");
    assert.ok(Number(scalar(`SELECT count(*) FROM public.memory_snapshots`)) > 0, "the test left the history as it found it");
  });
});
