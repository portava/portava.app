/**
 * Migration 3806 — memory_convergence_proposals, on the replayed chain
 * (census-highlights-memories H180; B58 MEM-CONVERGE).
 *
 * WHAT IS PROVED HERE, on the real chain rather than as text:
 *   · no client role can read or write the table (rule 4), and RLS is on with no policy;
 *   · the guard trigger refuses a proposal for ANOTHER person's Memory, or of
 *     another person's photo — whatever the server code does;
 *   · a decision is final: kept / dismissed never change again, and nothing
 *     but `state` / `decided_at` may change at all; an unstamped decision is refused;
 *   · the detector's insert (ON CONFLICT DO NOTHING) never reopens a dismissal;
 *   · the rows go with the Memory, with the photo, and with the account;
 *   · the migration re-applies as a no-op, and its postconditions hold when run alone.
 *
 * Run: LOCAL_DB_URL=... node --import tsx/esm --test src/test/db/memoryConvergenceProposals.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { HAVE_DB, deleteUser, exec, psql, scalar, seedUser } from "./localDb.ts";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";
const MIGRATION = new URL("../../migrations/3806_memory_convergence_proposals.sql", import.meta.url);
const T = "public.memory_convergence_proposals";

/** Run a statement as a role; return psql's exit status and stderr. */
function as(role: "anon" | "authenticated" | "service_role", script: string, sub?: string): { status: number; err: string } {
  const who = sub
    ? `SELECT set_config('request.jwt.claim.sub', '${sub}', true);\nSELECT set_config('request.jwt.claim.role', '${role}', true);\n`
    : "";
  const r = psql(`${who}SET LOCAL ROLE ${role};\n${script}`, { single: true });
  return { status: r.status, err: r.stderr };
}

function seedMemory(owner: string): string {
  const id = randomUUID();
  exec(`INSERT INTO public.memories (id, owner_id, title, visibility, state, starts_at, ends_at)
        VALUES ('${id}', '${owner}', 'Fado night', 'only_me', 'published', '2026-03-02T19:00:00Z', '2026-03-02T22:00:00Z');`);
  return id;
}

function seedPhoto(owner: string): string {
  const id = randomUUID();
  exec(`INSERT INTO public.media_assets (id, owner_user_id, uploader_user_id, storage_bucket, storage_path, media_type, mime_type, captured_at)
        VALUES ('${id}', '${owner}', '${owner}', 'post-media', '${owner}/${id}.jpg', 'image', 'image/jpeg', '2026-03-02T20:15:00Z');`);
  return id;
}

const propose = (owner: string, memory: string, photo: string) =>
  `INSERT INTO ${T} (owner_id, memory_id, media_asset_id, basis) VALUES ('${owner}', '${memory}', '${photo}', 'memory_window') ON CONFLICT (owner_id, memory_id, media_asset_id) DO NOTHING;`;

describe("3806 memory_convergence_proposals — on the replayed chain", { skip: SKIP }, () => {
  let owner = "";
  let other = "";

  before(() => {
    owner = seedUser("conv_owner");
    other = seedUser("conv_other");
  });
  after(() => {
    for (const id of [owner, other]) if (id) { try { deleteUser(id); } catch { /* already gone */ } }
  });

  it("no client role holds any privilege, RLS is on, and there is no policy", () => {
    for (const role of ["anon", "authenticated"]) {
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        assert.equal(scalar(`SELECT has_table_privilege('${role}', '${T}', '${priv}')::text;`), "false", `${role} ${priv}`);
      }
    }
    assert.equal(scalar(`SELECT relrowsecurity::text FROM pg_class WHERE oid = '${T}'::regclass;`), "true");
    assert.equal(scalar(`SELECT count(*)::text FROM pg_policy WHERE polrelid = '${T}'::regclass;`), "0");
  });

  it("a signed-in person can neither read nor write proposals through PostgREST", () => {
    const m = seedMemory(owner);
    const p = seedPhoto(owner);
    const write = as("authenticated", propose(owner, m, p), owner);
    assert.notEqual(write.status, 0);
    assert.match(write.err, /permission denied/);
    const read = as("authenticated", `SELECT count(*) FROM ${T};`, owner);
    assert.notEqual(read.status, 0);
    assert.match(read.err, /permission denied/);
  });

  it("the guard refuses another person's Memory, and another person's photo", () => {
    const mine = seedMemory(owner);
    const theirs = seedMemory(other);
    const myPhoto = seedPhoto(owner);
    const theirPhoto = seedPhoto(other);
    const a = as("service_role", propose(owner, theirs, myPhoto));
    assert.notEqual(a.status, 0);
    assert.match(a.err, /the Memory is not this owner's/);
    const b = as("service_role", propose(owner, mine, theirPhoto));
    assert.notEqual(b.status, 0);
    assert.match(b.err, /the photo is not this owner's/);
    const ok = as("service_role", propose(owner, mine, myPhoto));
    assert.equal(ok.status, 0, ok.err);
  });

  it("a decision is final, must be stamped, and the detector's insert never reopens a dismissal", () => {
    const m = seedMemory(owner);
    const p = seedPhoto(owner);
    assert.equal(as("service_role", propose(owner, m, p)).status, 0);
    const unstamped = as("service_role", `UPDATE ${T} SET state = 'dismissed' WHERE memory_id = '${m}';`);
    assert.notEqual(unstamped.status, 0);
    assert.match(unstamped.err, /memory_convergence_proposals_decision_stamped/);
    assert.equal(as("service_role", `UPDATE ${T} SET state = 'dismissed', decided_at = now() WHERE memory_id = '${m}';`).status, 0);
    const reopen = as("service_role", `UPDATE ${T} SET state = 'proposed', decided_at = NULL WHERE memory_id = '${m}';`);
    assert.notEqual(reopen.status, 0);
    assert.match(reopen.err, /a decision is final/);
    const flip = as("service_role", `UPDATE ${T} SET state = 'kept', decided_at = now() WHERE memory_id = '${m}';`);
    assert.notEqual(flip.status, 0);
    const move = as("service_role", `UPDATE ${T} SET basis = 'confirmed_episode' WHERE memory_id = '${m}';`);
    assert.notEqual(move.status, 0);
    assert.match(move.err, /only the decision of a proposal may change/);
    assert.equal(as("service_role", propose(owner, m, p)).status, 0, "the detector's insert is a no-op on a decided row");
    assert.equal(scalar(`SELECT state FROM ${T} WHERE memory_id = '${m}';`), "dismissed");
  });

  it("rows go with the Memory, with the photo, and with the account", () => {
    const m1 = seedMemory(owner);
    const m2 = seedMemory(owner);
    const p1 = seedPhoto(owner);
    const p2 = seedPhoto(owner);
    exec(`SET LOCAL ROLE service_role;\n${propose(owner, m1, p1)}\n${propose(owner, m2, p2)}`, { single: true });
    exec(`DELETE FROM public.memories WHERE id = '${m1}';`);
    assert.equal(scalar(`SELECT count(*)::text FROM ${T} WHERE memory_id = '${m1}';`), "0");
    exec(`DELETE FROM public.media_assets WHERE id = '${p2}';`);
    assert.equal(scalar(`SELECT count(*)::text FROM ${T} WHERE media_asset_id = '${p2}';`), "0");
    const gone = seedUser("conv_gone");
    const gm = seedMemory(gone);
    const gp = seedPhoto(gone);
    exec(`SET LOCAL ROLE service_role;\n${propose(gone, gm, gp)}`, { single: true });
    deleteUser(gone);
    assert.equal(scalar(`SELECT count(*)::text FROM ${T} WHERE owner_id = '${gone}';`), "0");
  });

  it("re-applies as a no-op, and its postconditions hold run alone", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const again = psql(sql);
    assert.equal(again.status, 0, again.stderr);
    const post = sql.slice(sql.indexOf("DO $post$"));
    const alone = psql(post);
    assert.equal(alone.status, 0, alone.stderr);
  });
});
