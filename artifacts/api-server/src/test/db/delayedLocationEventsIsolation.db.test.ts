/** 3926 real-role privacy proof on local replay only. No census row moves. */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { HAVE_DB, exec, psql, seedUser, deleteUser } from "./localDb.js";
let owner = "", stranger = "";
const post = randomUUID(), event = randomUUID();
const table = "public.delayed_post_location_events";
const oldPolicy = `ALTER POLICY "service role manages delayed post events" ON ${table} TO public;`;
type Who = "anon" | "owner" | "stranger" | "service_role";
function role(who: Who): string {
  const id = who === "owner" ? owner : who === "stranger" ? stranger : "";
  return `SELECT set_config('request.jwt.claim.sub','${id}',true); SELECT set_config('request.jwt.claim.role','${id ? "authenticated" : who}',true); SET LOCAL ROLE ${id ? "authenticated" : who};`;
}
function read(who: Who, prelude = ""): string[] {
  return exec(`BEGIN; ${prelude} ${role(who)} SELECT 'row=' || id || ':' || lat || ':' || lng FROM ${table} WHERE id='${event}'; ROLLBACK;`).filter(x => x.startsWith("row="));
}
function insert(id: string, user = owner): string {
  return `INSERT INTO ${table}(id,post_id,user_id,event_type,lat,lng) VALUES ('${id}','${post}','${user}','created_pending',16.0544,108.2022)`;
}
describe("3926 delayed location event isolation", { skip: !HAVE_DB }, () => {
  before(() => {
    owner = seedUser("event3926owner"); stranger = seedUser("event3926stranger");
    exec(`INSERT INTO public.posts(id,author_id,content,visibility,status,post_status) VALUES ('${post}','${owner}','3926 fixture','public','active','pending_location_exit'); ${insert(event)};`);
  });
  after(() => {
    exec(`DELETE FROM ${table} WHERE post_id='${post}'; DELETE FROM public.posts WHERE id='${post}';`);
    if (owner) deleteUser(owner); if (stranger) deleteUser(stranger);
  });
  it("catalog: service ALL is service_role only; owner SELECT preserved", () => {
    assert.deepEqual(exec(`SELECT roles::text || ':' || cmd || ':' || qual || ':' || with_check FROM pg_policies WHERE schemaname='public' AND tablename='delayed_post_location_events' AND policyname='service role manages delayed post events';`), ["{service_role}:ALL:true:true"]);
    assert.deepEqual(exec(`SELECT qual FROM pg_policies WHERE schemaname='public' AND tablename='delayed_post_location_events' AND policyname='users read own delayed post events' AND cmd='SELECT';`), ["(auth.uid() = user_id)"]);
  });
  it("anon and stranger cannot read; owner and service read intact coordinates", () => {
    assert.deepEqual(read("anon"), []); assert.deepEqual(read("stranger"), []);
    for (const who of ["owner", "service_role"] as const) assert.deepEqual(read(who), [`row=${event}:16.0544:108.2022`]);
  });
  it("red before: PUBLIC policy exposes coordinates to anon and stranger", () => {
    for (const who of ["anon", "stranger"] as const) assert.equal(read(who, oldPolicy).length, 1);
    assert.deepEqual(read("anon"), []);
  });
  it("anon, stranger and owner cannot INSERT events", () => {
    for (const who of ["anon", "stranger", "owner"] as const) {
      const r = psql(`BEGIN; ${role(who)} ${insert(randomUUID(), who === "stranger" ? stranger : owner)}; ROLLBACK;`);
      assert.notEqual(r.status, 0, `${who} inserted`); assert.match(r.stderr, /row-level security|permission denied/i);
    }
  });
  it("anon, stranger and owner cannot UPDATE or DELETE events", () => {
    for (const who of ["anon", "stranger", "owner"] as const) {
      for (const op of [`UPDATE ${table} SET lat=0 WHERE id='${event}'`, `DELETE FROM ${table} WHERE id='${event}'`]) {
        const r = psql(`BEGIN; ${role(who)} WITH changed AS (${op} RETURNING id) SELECT 'changed=' || count(*) FROM changed; ROLLBACK;`);
        if (r.status === 0) assert.ok(r.stdout.includes("changed=0"), `${who}: ${r.stdout}`);
        else assert.match(r.stderr, /row-level security|permission denied/i);
      }
    }
    assert.deepEqual(read("owner"), [`row=${event}:16.0544:108.2022`]);
  });
  it("service INSERT/UPDATE/DELETE remain operational", () => {
    const id = randomUUID();
    const out = exec(`BEGIN; ${role("service_role")} ${insert(id)}; UPDATE ${table} SET lat=17 WHERE id='${id}'; SELECT 'lat=' || lat FROM ${table} WHERE id='${id}'; DELETE FROM ${table} WHERE id='${id}'; SELECT 'remaining=' || count(*) FROM ${table} WHERE id='${id}'; ROLLBACK;`);
    assert.ok(out.includes("lat=17")); assert.ok(out.includes("remaining=0"));
  });
  it("red before: PUBLIC policy admits anon/stranger INSERT, UPDATE, DELETE", () => {
    for (const who of ["anon", "stranger"] as const) {
      const out = exec(`BEGIN; ${oldPolicy} ${role(who)} ${insert(randomUUID())}; WITH changed AS (UPDATE ${table} SET lat=0 WHERE id='${event}' RETURNING id) SELECT 'updated=' || count(*) FROM changed; WITH changed AS (DELETE FROM ${table} WHERE id='${event}' RETURNING id) SELECT 'deleted=' || count(*) FROM changed; ROLLBACK;`);
      assert.ok(out.includes("updated=1")); assert.ok(out.includes("deleted=1"));
    }
  });
  it("preconditions refuse disabled RLS and unexpected policy shapes transactionally", () => {
    const sql = readFileSync(new URL("../../migrations/3926_delayed_post_location_events_service_role_policy.sql", import.meta.url), "utf8");
    const pre = sql.slice(sql.indexOf("DO $pre$"), sql.indexOf("END $pre$;") + "END $pre$;".length);
    for (const change of [
      `ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`,
      `ALTER POLICY "service role manages delayed post events" ON ${table} USING (false);`,
      `DROP POLICY "users read own delayed post events" ON ${table};`,
    ]) {
      const result = psql(`BEGIN; ${change} ${pre} ROLLBACK;`);
      assert.notEqual(result.status, 0); assert.match(result.stderr, /PRECONDITION FAILED/);
    }
    assert.deepEqual(read("anon"), []); assert.equal(read("owner").length, 1);
  });
  it("apply/rollback idempotence and row preservation", () => {
    const migration = readFileSync(new URL("../../migrations/3926_delayed_post_location_events_service_role_policy.sql", import.meta.url), "utf8");
    const rollback = readFileSync(new URL("../../../../../db/rollback/2026-10-24-3926-delayed-location-events-policy-rollback.sql", import.meta.url), "utf8");
    try {
      exec(rollback); exec(rollback); assert.equal(read("anon").length, 1);
      exec(migration); exec(migration); assert.deepEqual(read("anon"), []);
      assert.deepEqual(read("owner"), [`row=${event}:16.0544:108.2022`]);
    } finally { exec(migration); }
  });
});
