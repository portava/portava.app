/**
 * A block, a mute, a restrict and a report are SAFETY actions: they must work
 * when the viewer's Trust restriction state cannot be read (lane T2's verifier,
 * reproduced under `fail_closed`). They used to answer 500: the permission
 * engine threw DegradedPermissionCheckError at the restriction read
 * (services/interactionPermissions.ts) and each route turned every throw into
 * `db_error`. The viewer's restriction state limits what the viewer may REACH;
 * it has nothing to say about whether they may protect themselves.
 *
 *   PA1  the engine, asked for a PROTECTIVE verdict under an unreadable
 *        restriction state, answers: block / mute / restrict / report allowed,
 *        every capability that GRANTS reach false, and the verdict marked
 *        degraded with `trust_restrictions` named
 *   PA2  without the protective option it still throws (every reach-granting
 *        caller keeps failing closed)
 *   PA3  with a READABLE restriction state the protective verdict is the
 *        ordinary one (nothing changes when nothing failed)
 *   PA4  POST /users/:id/block, /mute, /restrict and POST /reports (user)
 *        succeed under the unreadable state and write their row
 *
 * Run: node --import tsx/esm --test src/test/protectiveActionsUnreadableRestriction.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { resolveInteractionPermissions } from "../services/interactionPermissions.js";
import { DegradedPermissionCheckError } from "../services/trust/TrustRestrictionService.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import blocksRouter from "../routes/blocks.js";
import mutesRouter from "../routes/mutes.js";
import restrictRouter from "../routes/restrict.js";
import reportsRouter from "../routes/reports.js";

const VIEWER = "aaaaaaaa-0000-4000-a000-0000000000a1";
const TARGET = "bbbbbbbb-0000-4000-a000-0000000000b2";
const TOKEN = "tok-viewer";
const DB_ERROR = { code: "XX000", message: "internal error: relation unavailable" };

type Rows = Record<string, any[]>;

/** A PostgREST-shaped double whose `trust_restrictions` read can fail; writes are recorded. */
function makeClient(failTrust: boolean) {
  const writes: Array<{ table: string; op: string }> = [];
  const db: Rows = {
    profiles: [
      { id: VIEWER, is_private: false, tag_permission: "everyone", display_name: "V", username: "v" },
      { id: TARGET, is_private: false, tag_permission: "everyone", display_name: "T", username: "t" },
    ],
  };
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let op: string | null = null;
    const err = failTrust && table === "trust_restrictions" ? DB_ERROR : null;
    const rows = () => (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const result = (single: boolean) => {
      if (err) return { data: null, error: err };
      if (op) return { data: single ? { id: `${table}-1` } : [{ id: `${table}-1` }], error: null };
      const m = rows();
      return { data: single ? m[0] ?? null : m, error: null };
    };
    const record = (o: string) => { op = o; writes.push({ table, op: o }); return b; };
    const b: any = {
      select() { return b; },
      insert() { return record("insert"); },
      upsert() { return record("upsert"); },
      update() { return record("update"); },
      delete() { return record("delete"); },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      neq() { return b; }, in() { return b; }, is() { return b; }, not() { return b; }, or() { return b; },
      gte() { return b; }, lte() { return b; }, gt() { return b; }, lt() { return b; },
      order() { return b; }, range() { return b; }, ilike() { return b; }, limit() { return b; }, match() { return b; },
      async maybeSingle() { return result(true); },
      async single() { return result(true); },
      then(onF: any, onR: any) { return Promise.resolve(result(false)).then(onF, onR); },
    };
    return b;
  }
  const client: any = {
    from,
    rpc: async () => ({ data: null, error: null }),
    auth: { getUser: async (t: string) => (t === TOKEN ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "bad token" } }) },
  };
  return { client, writes };
}

const REACH_FIELDS = [
  "canMessage", "canSendMessageRequest", "canAddFriend", "canFollow", "canViewProfile", "canViewFullProfile",
  "canInviteToEvent", "canInviteToCircle", "canInviteToTripCrew", "canTag", "canMention", "canBookBuddy", "canReview",
  "canShareProfile", "canSeeMutuals", "canSeeAvailability", "canSeeTrips", "canSeePublicPosts", "canSeeFriendOnlyPosts", "canSeeLocationContext",
];

describe("the permission engine under an unreadable restriction state", () => {
  it("PA1 a PROTECTIVE verdict allows block / mute / restrict / report, grants no reach, and is marked degraded", async () => {
    const { client } = makeClient(true);
    const p: any = await resolveInteractionPermissions(client, VIEWER, TARGET, { protective: true });
    assert.equal(p.canBlock, true);
    assert.equal(p.canMute, true);
    assert.equal(p.canRestrict, true);
    assert.equal(p.canReport, true);
    for (const f of REACH_FIELDS) if (f in p) assert.equal(p[f], false, `${f} must not be granted on an unread restriction state`);
    assert.equal(p.degraded, true);
    assert.ok(p.degradedReads.includes("trust_restrictions"));
  });

  it("PA2 without the protective option it still throws (reach-granting callers fail closed)", async () => {
    const { client } = makeClient(true);
    await assert.rejects(resolveInteractionPermissions(client, VIEWER, TARGET), (e: unknown) => e instanceof DegradedPermissionCheckError);
  });

  it("PA3 with a READABLE restriction state the protective verdict is the ordinary one", async () => {
    const { client } = makeClient(false);
    const plain: any = await resolveInteractionPermissions(client, VIEWER, TARGET);
    const prot: any = await resolveInteractionPermissions(makeClient(false).client, VIEWER, TARGET, { protective: true });
    assert.deepEqual(prot, plain);
  });
});

describe("PA4 — the four safety routes succeed under an unreadable restriction state", () => {
  let server: http.Server;
  let base = "";
  let world = makeClient(true);
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => { req.log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
    app.use("/api", blocksRouter, mutesRouter, restrictRouter, reportsRouter);
    await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", r); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    world = makeClient(true);
    _setTestClient(world.client, true);
    _setTestServiceClient(world.client);
  });

  const post = async (path: string, body: unknown = {}) => {
    const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  for (const [name, path, table, body] of [
    ["block", `/api/users/${TARGET}/block`, "blocks", {}],
    ["mute", `/api/users/${TARGET}/mute`, "user_mutes", {}],
    ["restrict", `/api/users/${TARGET}/restrict`, "user_restrictions", {}],
    ["report (user)", "/api/reports", "reports", { target_type: "user", target_id: TARGET, reason_code: "spam" }],
  ] as const) {
    it(`${name}: succeeds and writes ${table}`, async () => {
      const r = await post(path, body);
      assert.ok(r.status >= 200 && r.status < 300, `${r.status} ${JSON.stringify(r.body)}`);
      assert.ok(world.writes.some((w) => w.table === table), `no write to ${table}: ${JSON.stringify(world.writes)}`);
    });
  }
});
