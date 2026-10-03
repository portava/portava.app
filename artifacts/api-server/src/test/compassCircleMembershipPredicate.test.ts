/**
 * census-compass §33 (D-W11X2-94): Compass reads a circle membership the way every other surface does
 * — a `circle_memberships` row IS the membership — and not by a `status` no writer sets.
 *
 * `circle_memberships.status` is `text NOT NULL DEFAULT 'pending'` with no CHECK on its values
 * (baseline 20260819_baseline_structure.sql, the CREATE TABLE; confirmed on PostgreSQL 16). Its only
 * writers — POST /circle-invites/:inviteId/accept (routes/friends.ts) and
 * POST /me/requests/circle_invite/:id/accept (routes/requests.ts) — upsert
 * `{ user_id, other_id, created_at }` and never set it, and nothing moves a row to 'accepted'. The
 * invite/accept flow lives in `circle_invites` (pending → accepted); a membership row is written only
 * AFTER the accept. Every other reader (the chat sync, circle locations, the memory read policy,
 * meetups, locate-friends, messaging permissions, GET /circles/:owner/members …) treats the row as the
 * membership. Compass alone filtered `(status ?? "accepted") === "accepted"`, so on real data every
 * joined circle and every member list was invisible to `get_circle_activity`, /compass/ask's prompt
 * and `get_group_recommendation`, which said "not in any circles" / "not a member of a circle by that
 * name" from a successful read. Every earlier fixture wrote `status: "accepted"`, so no suite saw it.
 *
 * These fixtures model production: the membership is written by the REAL writer routes into an
 * in-memory table that applies the column's real default (`status` = 'pending'). `public.circles` has
 * no writer in the tree (check:writerless-reads, `circles`: dead-lane), so its rows here are seeded by
 * hand — that is the one part of this world production does not have, and census-compass §33 says so.
 *
 *   CM1  a join through POST /circle-invites/:id/accept → the joiner's get_circle_activity lists the circle
 *   CM2  the same join → the owner's circle lists the joiner as a member (tool and prompt)
 *   CM3  a join through POST /me/requests/circle_invite/:id/accept → get_group_recommendation finds the circle
 *   CM4  the writers leave `status` at the column default — the fixture is what production holds
 *   CM5  the same join → the OWNER's get_group_recommendation counts the joiner in the group
 *   CMc  CONTROL: another viewer's membership is not this viewer's; no row → "not in any circles"
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import friendsRouter from "../routes/friends.js";
import requestsRouter from "../routes/requests.js";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { executeCompassTool } from "../compass/CompassTools.js";
import { buildStructuredCompassContext, formatStructuredContextLines } from "../compass/CompassStructuredContext.js";
import type { CompassProfile } from "../compass/types.js";

const OWNER = "c1000000-0000-4000-a000-000000000001";
const JOINER = "c1000000-0000-4000-a000-000000000002";
const STRANGER = "c1000000-0000-4000-a000-000000000003";
const INVITE_A = "c1000000-0000-4000-a000-0000000000a1";
const INVITE_B = "c1000000-0000-4000-a000-0000000000b1";
const TOKENS: Record<string, string> = { "tok-owner": OWNER, "tok-joiner": JOINER, "tok-stranger": STRANGER };

type Row = Record<string, any>;
/** Column defaults as the baseline declares them (only the ones these writers leave unset). */
const DEFAULTS: Record<string, () => Row> = { circle_memberships: () => ({ status: "pending", created_at: new Date().toISOString() }) };
const PKEYS: Record<string, string[]> = { circle_memberships: ["user_id", "other_id"] };

/** A small in-memory PostgREST: filters, order, limit, upsert (merge on the primary key), update, insert. */
function memoryDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = {};
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
  const rowsOf = (t: string) => (tables[t] ??= []);
  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let op: { kind: "select" } | { kind: "upsert"; rows: Row[] } | { kind: "update"; patch: Row } | { kind: "insert"; rows: Row[] } | { kind: "delete" } = { kind: "select" };
    let order: Array<[string, boolean]> = []; let limit: number | null = null;
    const run = (single: boolean) => {
      if (op.kind === "upsert" || op.kind === "insert") {
        for (const r of op.rows) {
          const pk = PKEYS[table];
          const hit = pk ? rowsOf(table).find((x) => pk.every((k) => x[k] === r[k])) : undefined;
          if (hit && op.kind === "upsert") Object.assign(hit, r); else rowsOf(table).push({ ...(DEFAULTS[table]?.() ?? {}), ...r });
        }
        return { data: null, error: null };
      }
      let rows = rowsOf(table).filter((r) => filters.every((f) => f(r)));
      if (op.kind === "update") { rows.forEach((r) => Object.assign(r, (op as any).patch)); return { data: rows, error: null }; }
      if (op.kind === "delete") { tables[table] = rowsOf(table).filter((r) => !rows.includes(r)); return { data: rows, error: null }; }
      if (order.length) rows = [...rows].sort((a, b) => { for (const [k, asc] of order) { if (a[k] < b[k]) return asc ? -1 : 1; if (a[k] > b[k]) return asc ? 1 : -1; } return 0; });
      if (limit !== null) rows = rows.slice(0, limit);
      return single ? { data: rows[0] ?? null, error: null } : { data: rows.map((r) => ({ ...r })), error: null };
    };
    const b: any = {
      select() { return b; },
      eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: unknown) { filters.push((r) => r[c] !== v); return b; },
      in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(r[c])); return b; },
      order(c: string, o?: { ascending?: boolean }) { order.push([c, o?.ascending !== false]); return b; },
      limit(n: number) { limit = n; return b; },
      upsert(r: Row | Row[]) { op = { kind: "upsert", rows: Array.isArray(r) ? r : [r] }; return b; },
      insert(r: Row | Row[]) { op = { kind: "insert", rows: Array.isArray(r) ? r : [r] }; return b; },
      update(patch: Row) { op = { kind: "update", patch }; return b; },
      delete() { op = { kind: "delete" }; return b; },
      maybeSingle() { return Promise.resolve(run(true)); },
      single() { return Promise.resolve(run(true)); },
      then(f: any, r: any) { return Promise.resolve(run(false)).then(f, r); },
    };
    return new Proxy(b, { get: (t, k: string) => (k in t ? t[k] : () => b) });  // any other modifier is a no-op
  }
  return {
    tables,
    client: {
      auth: { getUser: async (tok: string) => (TOKENS[tok] ? { data: { user: { id: TOKENS[tok] } }, error: null } : { data: { user: null }, error: { message: "bad token" } }) },
      from: (t: string) => builder(t),
      rpc: () => Promise.resolve({ data: null, error: null }),
    },
  };
}

/** Production as the tree can make it: two profiles, two pending invites, the owner's named circle (hand-seeded: `circles` has no writer). */
const world = () => memoryDb({
  profiles: [{ id: OWNER, handle: "olga", account_status: "active" }, { id: JOINER, handle: "jo", account_status: "active", date_of_birth: "1990-01-01" }, { id: STRANGER, handle: "sam", account_status: "active" }],
  circle_invites: [
    { id: INVITE_A, owner_id: OWNER, recipient_id: JOINER, status: "pending" },
    { id: INVITE_B, owner_id: OWNER, recipient_id: JOINER, status: "pending" },
  ],
  circles: [{ id: "c-porto", name: "Porto crew", owner_id: OWNER }],
  circle_memberships: [],
});
const profileOf = (userId: string) => ({ userId, blockedUserIds: [], blockerUserIds: [], mutedUserIds: [] } as unknown as CompassProfile);

let base = ""; let server: Server;
before(async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
  app.use("/api", friendsRouter);
  app.use("/api", requestsRouter);
  server = createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(() => server.close());
beforeEach(() => _resetRateLimit());
async function accept(w: ReturnType<typeof world>, path: string, token: string) {
  _setTestClient(w.client as any, true);
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
  const body = await r.json() as any;
  assert.equal(r.status, 200, `the real writer must accept: ${JSON.stringify(body)}`);
}

describe("Compass reads a circle membership as every other surface does (census-compass §33, D-W11X2-94)", () => {
  it("CM4 the writers leave status at the column default — the fixture is what production holds", async () => {
    const w = world();
    await accept(w, `/circle-invites/${INVITE_A}/accept`, "tok-joiner");
    assert.deepEqual(w.tables.circle_memberships.map((r) => [r.user_id, r.other_id, r.status]), [[OWNER, JOINER, "pending"]]);
  });

  it("CM1 a join through POST /circle-invites/:id/accept → the joiner's get_circle_activity lists the circle", async () => {
    const w = world();
    await accept(w, `/circle-invites/${INVITE_A}/accept`, "tok-joiner");
    const r = (await executeCompassTool(w.client as any, JOINER, profileOf(JOINER), "get_circle_activity", {})) as any;
    assert.deepEqual(r.circles?.map((c: any) => c.name), ["<portava:ugc>Porto crew</portava:ugc>"], `a real join was invisible: ${JSON.stringify(r)}`);
    assert.equal(r.info, undefined, JSON.stringify(r));
  });

  it("CM2 the same join → the owner's circle lists the joiner as a member (tool and prompt)", async () => {
    const w = world();
    await accept(w, `/circle-invites/${INVITE_A}/accept`, "tok-joiner");
    const r = (await executeCompassTool(w.client as any, OWNER, profileOf(OWNER), "get_circle_activity", {})) as any;
    assert.deepEqual(r.circles?.[0]?.memberHandles, ["@jo"], `the member list dropped a real member: ${JSON.stringify(r)}`);
    const lines = formatStructuredContextLines(await buildStructuredCompassContext(w.client as any, profileOf(OWNER)));
    assert.ok(lines.some((l) => l.includes("members: @jo")), lines.join("\n"));
  });

  it("CM3 a join through POST /me/requests/circle_invite/:id/accept → get_group_recommendation finds the circle", async () => {
    const w = world();
    await accept(w, `/me/requests/circle_invite/${INVITE_B}/accept`, "tok-joiner");
    assert.equal(w.tables.circle_memberships[0]?.status, "pending", "the second writer also leaves the default");
    const r = (await executeCompassTool(w.client as any, JOINER, profileOf(JOINER), "get_group_recommendation", { circleName: "Porto crew" })) as any;
    assert.notEqual(r.info, "The user is not a member of a circle by that name.", `a real join was "not a member": ${JSON.stringify(r)}`);
  });

  it("CM5 the OWNER's group recommendation counts the joiner (a row written by the real writer) as a member", async () => {
    const w = world();
    await accept(w, `/circle-invites/${INVITE_A}/accept`, "tok-joiner");
    const r = (await executeCompassTool(w.client as any, OWNER, profileOf(OWNER), "get_group_recommendation", { circleName: "Porto crew" })) as any;
    assert.equal(r.group?.size, 2, `the joiner was dropped from the owner's group: ${JSON.stringify(r)}`);
  });
  it("CMc CONTROL: another viewer's membership is not this viewer's; no row → 'not in any circles'", async () => {
    const w = world();
    await accept(w, `/circle-invites/${INVITE_A}/accept`, "tok-joiner");
    const r = (await executeCompassTool(w.client as any, STRANGER, profileOf(STRANGER), "get_circle_activity", {})) as any;
    assert.deepEqual(r, { circles: [], info: "The user is not in any circles." });
    const g = (await executeCompassTool(w.client as any, STRANGER, profileOf(STRANGER), "get_group_recommendation", { circleName: "Porto crew" })) as any;
    assert.equal(g.info, "The user is not a member of a circle by that name.");
  });
});
