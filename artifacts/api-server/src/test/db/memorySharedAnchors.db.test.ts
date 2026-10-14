/**
 * memorySharedAnchors.db.test.ts — the EXECUTING witness for 3805
 * (memory_shared_anchors, memory_shared_anchor_members, their guard and
 * dissolution triggers, memory_shared_anchor_invite) on the full chain
 * scripts/local-db/up.sh replays (production's 2026-08-19 baseline structure plus
 * every migration). Census-highlights-memories H53; B58 cluster MEM-ANCHOR-1.
 *
 * The route suite (src/test/memorySharedAnchors.test.ts) ports this SQL to
 * TypeScript to drive the API; this file is what proves the SQL itself does what
 * the port assumes, as the API's service role calls it, with every other trigger
 * the chain installs on memories and memory_tags in place.
 *
 *   D1  no client role reads or writes either table or calls any 3805 function;
 *       RLS is on with no policy; the flag is seeded FALSE
 *   D2  the invite function refuses a non-owner, a PENDING tag and a deleted
 *       Memory, and writes nothing when it does
 *   D3  an approved tag: the anchor exists with the host accepted, the invitee
 *       invited; not shared until the invitee accepts
 *   D4  the guard: no link to someone else's Memory, no illegal transition, one
 *       anchor per Memory
 *   D5  a hard-deleted linked Memory cuts the link (SET NULL), nothing else
 *   D6  leaving: two still accepted keep it; one left alone erases it, every row
 *   D7  account deletion: a member's takes their row; the host's takes the anchor
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HAVE_DB, exec, scalar, seedUser, deleteUser, asUser } from "./localDb.js";

const TAG = `msa${randomUUID().slice(0, 8)}`;
let host = ""; let b = ""; let c = ""; let d = "";
const users: string[] = [];

const asService = (sql: string) => exec(`SET LOCAL ROLE service_role;\n${sql}`, { single: true });
const invite = (memory: string, inviter: string, invitee: string): any =>
  JSON.parse(asService(`SELECT public.memory_shared_anchor_invite('${memory}', '${inviter}', '${invitee}')::text;`).join(""));
const statusOf = (anchor: string, user: string) =>
  scalar(`SELECT coalesce(status, '<none>') FROM public.memory_shared_anchor_members WHERE anchor_id = '${anchor}' AND user_id = '${user}'`) ?? "<none>";
const anchorExists = (anchor: string) => scalar(`SELECT count(*) FROM public.memory_shared_anchors WHERE id = '${anchor}'`) === "1";
const rowsOf = (anchor: string) => Number(scalar(`SELECT count(*) FROM public.memory_shared_anchor_members WHERE anchor_id = '${anchor}'`));
function newMemory(owner: string, visibility = "only_me", state = "published"): string {
  const id = randomUUID();
  asService(`INSERT INTO public.memories (id, owner_id, title, visibility, state) VALUES ('${id}', '${owner}', '${TAG}', '${visibility}', '${state}');`);
  return id;
}
const tag = (memory: string, user: string, status: string) =>
  exec(`INSERT INTO public.memory_tags (memory_id, tagged_user_id, status) VALUES ('${memory}', '${user}', '${status}');`);
const accept = (anchor: string, user: string, memory: string | null = null) =>
  asService(`UPDATE public.memory_shared_anchor_members SET status = 'accepted', consented_at = now(), memory_id = ${memory ? `'${memory}'` : "NULL"}
             WHERE anchor_id = '${anchor}' AND user_id = '${user}' AND status = 'invited';`);
const leave = (anchor: string, user: string) =>
  asService(`UPDATE public.memory_shared_anchor_members SET status = 'left', left_at = now(), memory_id = NULL
             WHERE anchor_id = '${anchor}' AND user_id = '${user}' AND status = 'accepted';`);

describe("3805 on the full chain: the shared-experience anchor", { skip: !HAVE_DB }, () => {
  let mh = "";
  before(() => {
    host = seedUser(`${TAG}h`); b = seedUser(`${TAG}b`); c = seedUser(`${TAG}c`); d = seedUser(`${TAG}d`);
    users.push(host, b, c, d);
    mh = newMemory(host);
    tag(mh, b, "approved"); tag(mh, c, "approved"); tag(mh, d, "pending");
  });
  after(() => {
    exec(`SET LOCAL ROLE service_role; DELETE FROM public.memory_shared_anchors WHERE created_by = ANY (ARRAY[${users.map((u) => `'${u}'::uuid`).join(", ")}]);`, { single: true });
    for (const u of users) { try { deleteUser(u); } catch { /* already deleted by D7 */ } }
  });

  test("D1 no client role reaches either table or any function; RLS on, no policy; the flag is FALSE", () => {
    for (const sql of [
      "SELECT 1 FROM public.memory_shared_anchors LIMIT 1;",
      "SELECT 1 FROM public.memory_shared_anchor_members LIMIT 1;",
      `INSERT INTO public.memory_shared_anchors (created_by) VALUES ('${host}');`,
      `SELECT public.memory_shared_anchor_invite('${mh}', '${host}', '${b}');`,
    ]) {
      assert.throws(() => asUser(host, sql), /permission denied/, sql);
    }
    for (const role of ["anon", "authenticated"]) {
      for (const fn of ["public.memory_shared_anchor_invite(uuid,uuid,uuid)", "public.memory_shared_anchor_members_guard()", "public.memory_shared_anchor_dissolve()"]) {
        assert.equal(scalar(`SELECT has_function_privilege('${role}', '${fn}', 'EXECUTE')::text`), "false", `${role} ${fn}`);
      }
    }
    assert.equal(scalar(`SELECT bool_and(relrowsecurity)::text FROM pg_class WHERE oid IN ('public.memory_shared_anchors'::regclass, 'public.memory_shared_anchor_members'::regclass)`), "true");
    assert.equal(scalar(`SELECT count(*) FROM pg_policy WHERE polrelid IN ('public.memory_shared_anchors'::regclass, 'public.memory_shared_anchor_members'::regclass)`), "0");
    assert.equal(scalar(`SELECT enabled::text FROM public.feature_flags WHERE flag = 'memory_shared_anchors_enabled'`), "false");
  });

  test("D2 a non-owner, a PENDING tag and a deleted Memory are refused, and nothing is written", () => {
    assert.equal(invite(mh, b, c).outcome, "not_found");
    assert.equal(invite(mh, host, d).outcome, "not_invitable");
    const gone = newMemory(host, "public", "deleted");
    tag(gone, b, "approved");
    assert.equal(invite(gone, host, b).outcome, "not_found");
    assert.equal(scalar(`SELECT count(*) FROM public.memory_shared_anchors WHERE created_by = '${host}'`), "0");
  });

  test("D3 an APPROVED tag starts the anchor (host accepted with MH, invitee invited); shared only after the second accept", () => {
    const r = invite(mh, host, b);
    assert.equal(r.outcome, "invited");
    assert.equal(r.created, true);
    assert.equal(statusOf(r.anchor_id, host), "accepted");
    assert.equal(scalar(`SELECT memory_id::text FROM public.memory_shared_anchor_members WHERE anchor_id = '${r.anchor_id}' AND user_id = '${host}'`), mh);
    assert.equal(statusOf(r.anchor_id, b), "invited");
    assert.equal(invite(mh, host, b).outcome, "already_invited");
    assert.equal(scalar(`SELECT count(*) FROM public.memory_shared_anchor_members WHERE anchor_id = '${r.anchor_id}' AND status = 'accepted'`), "1");
    accept(r.anchor_id, b);
    assert.equal(scalar(`SELECT count(*) FROM public.memory_shared_anchor_members WHERE anchor_id = '${r.anchor_id}' AND status = 'accepted'`), "2");
  });

  test("D4 the guard: no link to another person's Memory, no illegal transition, one anchor per Memory", () => {
    const anchor = invite(mh, host, c).anchor_id as string;
    const mb = newMemory(b);
    assert.throws(() => accept(anchor, c, mb), /link only a live Memory they own/);
    assert.throws(() => asService(`UPDATE public.memory_shared_anchor_members SET status = 'left', left_at = now() WHERE anchor_id = '${anchor}' AND user_id = '${c}';`), /not a transition/);
    assert.equal(statusOf(anchor, c), "invited");
    const mc = newMemory(c, "public");
    accept(anchor, c, mc);
    const other = newMemory(b, "public");
    tag(other, c, "approved");
    const second = invite(other, b, c).anchor_id as string;
    assert.throws(() => accept(second, c, mc), /memory_shared_anchor_members_memory_once/);
    asService(`UPDATE public.memory_shared_anchor_members SET status = 'declined' WHERE anchor_id = '${second}' AND user_id = '${c}';`);
    assert.equal(anchorExists(second), false, "a lone declined invitation dissolved");
  });

  test("D5 a hard-deleted linked Memory cuts the link and nothing else", () => {
    const anchor = scalar(`SELECT anchor_id::text FROM public.memory_shared_anchor_members WHERE memory_id = '${mh}'`)!;
    const mc = scalar(`SELECT memory_id::text FROM public.memory_shared_anchor_members WHERE anchor_id = '${anchor}' AND user_id = '${c}'`)!;
    asService(`DELETE FROM public.memories WHERE id = '${mc}';`);
    assert.equal(statusOf(anchor, c), "accepted");
    assert.equal(scalar(`SELECT coalesce(memory_id::text, '<null>') FROM public.memory_shared_anchor_members WHERE anchor_id = '${anchor}' AND user_id = '${c}'`), "<null>");
  });

  test("D6 leaving: two still accepted keep the anchor; one left alone erases it and every row", () => {
    const anchor = scalar(`SELECT anchor_id::text FROM public.memory_shared_anchor_members WHERE memory_id = '${mh}'`)!;
    leave(anchor, c);
    assert.equal(anchorExists(anchor), true);
    assert.equal(statusOf(anchor, c), "left");
    leave(anchor, b);
    assert.equal(anchorExists(anchor), false);
    assert.equal(rowsOf(anchor), 0);
  });

  test("D7 account deletion: a member's account takes their row; the host's takes the anchor", () => {
    const anchor = invite(mh, host, b).anchor_id as string;
    invite(mh, host, c);
    accept(anchor, b); accept(anchor, c);
    deleteUser(c);
    assert.equal(statusOf(anchor, c), "<none>");
    assert.equal(anchorExists(anchor), true, "host and b remain");
    deleteUser(host);
    assert.equal(anchorExists(anchor), false);
    assert.equal(rowsOf(anchor), 0);
  });
});
