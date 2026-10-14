/**
 * memoryVisibilityPolicies.db.test.ts — the EXECUTING witness for 3810
 * (`memory_visibility_policies`, the owner's per-Memory §10 person ceiling, and
 * the security_invoker view `memory_visibility_policy_effective`), on the full
 * chain scripts/local-db/up.sh replays (production's 2026-08-19 baseline
 * structure plus every migration). Census-highlights-memories H33; B58 cluster
 * MEM-POLICY.
 *
 * The route suite (src/test/memoryVisibilityPolicy.test.ts) drives the API over
 * a fake; this file proves the SQL the fake stands in for, as the API's service
 * role writes it and as a client key would reach it, with every other memories
 * trigger and grant the chain installs in place.
 *
 *   V1  one ceiling per Memory, from the §10 ladder only, never NULL; an upsert replaces it
 *   V2  the view reads the audience and the precision from memories as they are NOW (no copy)
 *   V3  erasure: the ceiling goes with its Memory and with its owner's account
 *   V4  no client role reaches the table or the view — not even the owner's own JWT
 *   V5  RLS on, no policy; the view is security_invoker over both relations
 *   V6  3813's refusal (PR #726) finds no client-readable view over memories here
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HAVE_DB, exec, psql, scalar, seedUser, deleteUser, asUser } from "./localDb.js";

let owner = "";
let other = "";
const TAG = `mvp${randomUUID().slice(0, 8)}`;

const asService = (sql: string) => exec(`SET LOCAL ROLE service_role;\n${sql}`, { single: true });
const ceilingOf = (id: string) =>
  scalar(`SELECT coalesce(person_visibility_ceiling, '<none>') FROM public.memory_visibility_policy_effective WHERE memory_id = '${id}'`);
function newMemory(ownerId: string, visibility = "public"): string {
  const id = randomUUID();
  asService(`INSERT INTO public.memories (id, owner_id, title, visibility) VALUES ('${id}', '${ownerId}', '${TAG}', '${visibility}');`);
  return id;
}
function setCeiling(memoryId: string, ownerId: string, rung: string): void {
  asService(`INSERT INTO public.memory_visibility_policies (memory_id, owner_id, person_visibility_ceiling) VALUES ('${memoryId}', '${ownerId}', '${rung}')
             ON CONFLICT (memory_id) DO UPDATE SET person_visibility_ceiling = EXCLUDED.person_visibility_ceiling, updated_at = now();`);
}
/** The psql stderr of a script that must fail. */
function refusal(script: string): string {
  const r = psql(script, { single: true });
  assert.notEqual(r.status, 0, `expected a refusal from:\n${script}`);
  return r.stderr;
}

describe("3810 on the full chain: the owner's person ceiling and the effective-policy view", { skip: !HAVE_DB }, () => {
  before(() => {
    owner = seedUser(TAG);
    other = seedUser(`${TAG}o`);
  });
  after(() => {
    if (owner) deleteUser(owner); // cascades the Memories, and with them the policies
    if (other) deleteUser(other);
  });

  test("V1 one ceiling per Memory, from the ladder only, never NULL; an upsert replaces it", () => {
    const m = newMemory(owner);
    assert.equal(ceilingOf(m), "<none>", "no row = no ceiling");
    setCeiling(m, owner, "ANONYMOUS_COUNT");
    assert.equal(ceilingOf(m), "ANONYMOUS_COUNT");
    setCeiling(m, owner, "HIDDEN");
    assert.equal(ceilingOf(m), "HIDDEN");
    assert.equal(scalar(`SELECT count(*) FROM public.memory_visibility_policies WHERE memory_id = '${m}'`), "1");
    assert.match(refusal(`SET LOCAL ROLE service_role; INSERT INTO public.memory_visibility_policies (memory_id, owner_id, person_visibility_ceiling) VALUES ('${m}', '${owner}', 'NAMED');`), /duplicate key|memory_visibility_policies_pkey/);
    const n = newMemory(owner);
    assert.match(refusal(`SET LOCAL ROLE service_role; INSERT INTO public.memory_visibility_policies (memory_id, owner_id, person_visibility_ceiling) VALUES ('${n}', '${owner}', 'SECRET');`), /memory_visibility_policies_person_ceiling_check/);
    assert.match(refusal(`SET LOCAL ROLE service_role; INSERT INTO public.memory_visibility_policies (memory_id, owner_id, person_visibility_ceiling) VALUES ('${n}', '${owner}', NULL);`), /null value/);
    assert.match(refusal(`SET LOCAL ROLE service_role; INSERT INTO public.memory_visibility_policies (memory_id, owner_id, person_visibility_ceiling) VALUES ('${randomUUID()}', '${owner}', 'HIDDEN');`), /foreign key/);
  });

  test("V2 the view reads the audience and the precision from memories as they are now", () => {
    const m = newMemory(owner, "public");
    setCeiling(m, owner, "CREW_ONLY");
    const sibling = newMemory(owner, "public");
    const row = () => scalar(`SELECT visibility || '/' || location_precision || '/' || cardinality(hidden_user_ids) || '/' || coalesce(person_visibility_ceiling, '<none>')
                                FROM public.memory_visibility_policy_effective WHERE memory_id = '${m}'`);
    assert.equal(row(), "public/exact/0/CREW_ONLY");
    asService(`UPDATE public.memories SET visibility = 'only_me', location_precision = 'city', hidden_user_ids = ARRAY['${other}']::uuid[] WHERE id = '${m}';`);
    assert.equal(row(), "only_me/city/1/CREW_ONLY", "a change on memories is the view's change: one source");
    assert.equal(ceilingOf(sibling), "<none>", "the same owner's other Memory does not inherit the ceiling");
    assert.equal(
      scalar(`SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'memory_visibility_policies'`),
      "memory_id,owner_id,person_visibility_ceiling,updated_at",
      "the table holds the ceiling only — never a copy of the audience or the precision (Q-H33)",
    );
  });

  test("V3 the ceiling goes with its Memory, and with its owner's account", () => {
    const m = newMemory(owner);
    setCeiling(m, owner, "HIDDEN");
    asService(`DELETE FROM public.memories WHERE id = '${m}';`);
    assert.equal(scalar(`SELECT count(*) FROM public.memory_visibility_policies WHERE memory_id = '${m}'`), "0");
    const gone = seedUser(`${TAG}g`);
    const g = newMemory(gone);
    setCeiling(g, gone, "ANONYMOUS_COUNT");
    deleteUser(gone);
    assert.equal(scalar(`SELECT count(*) FROM public.memory_visibility_policies WHERE owner_id = '${gone}'`), "0");
  });

  test("V4 no client role reaches the table or the view, not even through the owner's own JWT", () => {
    const m = newMemory(owner);
    setCeiling(m, owner, "HIDDEN");
    for (const rel of ["public.memory_visibility_policies", "public.memory_visibility_policy_effective"]) {
      for (const role of ["anon", "authenticated"]) {
        assert.equal(scalar(`SELECT has_table_privilege('${role}', '${rel}', 'SELECT') OR has_any_column_privilege('${role}', '${rel}', 'SELECT')`), "f", `${role} SELECT ${rel}`);
        assert.equal(scalar(`SELECT has_table_privilege('${role}', '${rel}', 'INSERT') OR has_table_privilege('${role}', '${rel}', 'UPDATE') OR has_table_privilege('${role}', '${rel}', 'DELETE')`), "f", `${role} write ${rel}`);
      }
    }
    assert.throws(() => asUser(owner, `SELECT count(*) FROM public.memory_visibility_policies;`), /permission denied/);
    assert.throws(() => asUser(owner, `SELECT count(*) FROM public.memory_visibility_policy_effective;`), /permission denied/);
    assert.throws(() => asUser(owner, `DELETE FROM public.memory_visibility_policies WHERE memory_id = '${m}';`), /permission denied/);
    assert.equal(ceilingOf(m), "HIDDEN", "the owner's JWT could not clear it past the API");
  });

  test("V5 RLS on with no policy; the view is security_invoker over memories and the table", () => {
    assert.equal(scalar(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.memory_visibility_policies'::regclass`), "t");
    assert.equal(scalar(`SELECT count(*) FROM pg_policy WHERE polrelid = 'public.memory_visibility_policies'::regclass`), "0");
    assert.equal(scalar(`SELECT reloptions @> ARRAY['security_invoker=true'] FROM pg_class WHERE oid = 'public.memory_visibility_policy_effective'::regclass`), "t");
    assert.equal(
      scalar(`SELECT string_agg(DISTINCT d.refobjid::regclass::text, ',' ORDER BY d.refobjid::regclass::text) FROM pg_depend d JOIN pg_rewrite w ON d.classid = 'pg_rewrite'::regclass AND d.objid = w.oid
               WHERE w.ev_class = 'public.memory_visibility_policy_effective'::regclass AND d.refclassid = 'pg_class'::regclass AND d.refobjid <> w.ev_class`),
      "memories,memory_visibility_policies",
    );
  });

  test("V6 3813's refusal finds no client-readable view over memories on this chain", () => {
    // The exact predicate 3813's $pre$ and $post$ (PR #726) evaluate. A client grant on 3810's view would block 3813.
    assert.equal(
      scalar(`SELECT coalesce(string_agg(DISTINCT format('%s (%s)', v.oid::regclass, r.rolname), ', '), '<none>')
                FROM pg_depend d JOIN pg_rewrite w ON d.classid = 'pg_rewrite'::regclass AND d.objid = w.oid
                JOIN pg_class v ON v.oid = w.ev_class CROSS JOIN (VALUES ('anon'), ('authenticated')) r(rolname)
               WHERE d.refclassid = 'pg_class'::regclass AND d.refobjid = 'public.memories'::regclass
                 AND w.ev_class = 'public.memory_visibility_policy_effective'::regclass AND has_any_column_privilege(r.rolname, v.oid, 'SELECT')`),
      "<none>",
    );
    assert.equal(scalar(`SELECT count(*) FROM pg_depend d JOIN pg_rewrite w ON d.classid = 'pg_rewrite'::regclass AND d.objid = w.oid
                          WHERE w.ev_class = 'public.memory_visibility_policy_effective'::regclass AND d.refobjid = 'public.memories'::regclass`) !== "0", true,
      "the view is one 3813's query examines (it reads public.memories), so the empty answer above is not vacuous");
  });
});
