/**
 * Tests for the `removed` flag on invite-link joiners.
 *
 * GET /api/trips/:tripId/invite-links cross-checks each joiner (from the
 * trip_activity_log) against the current trip_members table and sets
 * `removed: true` when the user is no longer a member.
 *
 * Covers:
 *   1. Joiner still in trip_members → removed: false
 *   2. Joiner removed from trip_members → removed: true
 *   3. Invite link with no activity-log rows → empty joiners array, no crash
 *   4. Multiple links on the same trip — each link shows only its own joiners
 *      with the correct removed flag per joiner
 *
 * Runtime: node:test + node:assert/strict
 * Run: node --import tsx/esm --test src/test/inviteLinkRemovedFlag.test.ts
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

// ---------------------------------------------------------------------------
// ID constants (valid UUIDs)
// ---------------------------------------------------------------------------
const OWNER_ID   = "a0000000-0000-0000-0000-000000000001";
const ALICE_ID   = "a0000000-0000-0000-0000-000000000002";  // stays a member
const BOB_ID     = "a0000000-0000-0000-0000-000000000003";  // gets removed
const CAROL_ID   = "a0000000-0000-0000-0000-000000000004";  // second link joiner
const TRIP_ID    = "b0000000-0000-0000-0000-000000000001";
const LINK_A_ID  = "c0000000-0000-0000-0000-000000000001";
const LINK_B_ID  = "c0000000-0000-0000-0000-000000000002";

// ---------------------------------------------------------------------------
// Fake Supabase client (mirrors the pattern in tripsExpansion.test.ts)
// ---------------------------------------------------------------------------
type Row = Record<string, any>;
interface FakeTable { rows: Row[]; }

function makeFakeClient(tables: Record<string, FakeTable>) {
  const db: Record<string, FakeTable> = {
    trips:             { rows: [] },
    trip_members:      { rows: [] },
    trip_invite_links: { rows: [] },
    trip_activity_log: { rows: [] },
    profiles:          { rows: [] },
    ...tables,
  };

  function chain(tableName: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let _update: Row | null = null;
    let _single = false;
    let _maybeSingle = false;
    let _orderCol: string | null = null;
    let _orderAsc = true;

    const obj: any = {
      select(_cols?: string) { return obj; },
      update(patch: Row) { _update = patch; return obj; },
      eq(col: string, val: any)  { filters.push((r) => r[col] === val); return obj; },
      in(col: string, vals: any[]) { filters.push((r) => (vals as any[]).includes(r[col])); return obj; },
      order(col: string, opts?: any) { _orderCol = col; _orderAsc = opts?.ascending !== false; return obj; },
      maybeSingle() { _maybeSingle = true; return resolve(); },
      single()      { _single      = true; return resolve(); },
      then(onF: any, onR: any) { return resolve().then(onF, onR); },
    };

    function getTable() {
      if (!db[tableName]) db[tableName] = { rows: [] };
      return db[tableName];
    }

    function resolve(): Promise<{ data: any; error: any }> {
      return Promise.resolve().then(() => {
        const table = getTable();

        if (_update !== null) {
          let matched: Row | null = null;
          table.rows = table.rows.map((r) => {
            if (filters.every((f) => f(r))) {
              matched = { ...r, ..._update };
              return matched;
            }
            return r;
          });
          if (_single || _maybeSingle) return { data: matched, error: null };
          return { data: null, error: null };
        }

        let rows = table.rows.filter((r) => filters.every((f) => f(r)));
        if (_orderCol) {
          const col = _orderCol;
          rows = [...rows].sort((a, b) =>
            _orderAsc
              ? String(a[col] ?? "").localeCompare(String(b[col] ?? ""))
              : String(b[col] ?? "").localeCompare(String(a[col] ?? ""))
          );
        }

        if (_single || _maybeSingle) return { data: rows[0] ?? null, error: null };
        return { data: rows, error: null };
      });
    }

    return obj;
  }

  const client: any = {
    auth: {
      getUser: async (token: string) => {
        if (token === "owner-token") return { data: { user: { id: OWNER_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
    from: (tableName: string) => chain(tableName),
  };

  return { client, db };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
async function startServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      server.unref();
      resolve({ server, port: (server.address() as any).port });
    });
  });
}

async function req(
  port: number,
  method: string,
  path: string,
  opts: { token?: string; body?: any } = {},
): Promise<{ status: number; body: any }> {
  const url = `http://127.0.0.1:${port}/api${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;

  const res = await fetch(url, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  let body: any;
  const ct = res.headers.get("content-type") ?? "";
  try { body = ct.includes("application/json") ? await res.json() : await res.text(); }
  catch { body = null; }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe("invite-link removed-member flagging", () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    if (server) server.close();
    ({ server, port } = await startServer());
  });

  after(async () => {
    if (server) server.close();
  });

  // ── Case 1: joiner still in trip_members → removed: false ─────────────────
  it("joiner still a member → removed: false", async () => {
    const { client } = makeFakeClient({
      trips: { rows: [
        { id: TRIP_ID, owner_id: OWNER_ID, title: "Test Trip", created_at: "2026-01-01T00:00:00Z" },
      ]},
      trip_invite_links: { rows: [
        { id: LINK_A_ID, trip_id: TRIP_ID, token: "tokenA", created_by: OWNER_ID,
          max_uses: null, use_count: 1, revoked_at: null, expires_at: null,
          created_at: "2026-01-01T00:00:00Z" },
      ]},
      trip_activity_log: { rows: [
        { trip_id: TRIP_ID, actor_id: ALICE_ID, event_type: "joined_via_invite_link",
          metadata: { linkId: LINK_A_ID }, created_at: "2026-01-02T00:00:00Z" },
      ]},
      trip_members: { rows: [
        // Alice is still a member
        { trip_id: TRIP_ID, user_id: ALICE_ID, role: "member" },
      ]},
      profiles: { rows: [
        { id: ALICE_ID, full_name: "Alice", username: "alice", avatar_url: null },
      ]},
    });
    _setTestClient(client, true);

    const r = await req(port, "GET", `/trips/${TRIP_ID}/invite-links`, { token: "owner-token" });
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 1);

    const link = r.body[0];
    assert.equal(link.joiners.length, 1);
    assert.equal(link.joiners[0].id, ALICE_ID);
    assert.equal(link.joiners[0].removed, false, "Alice is still a member — removed must be false");
  });

  // ── Case 2: joiner removed from trip_members → removed: true ──────────────
  it("joiner removed from trip → removed: true", async () => {
    const { client } = makeFakeClient({
      trips: { rows: [
        { id: TRIP_ID, owner_id: OWNER_ID, title: "Test Trip", created_at: "2026-01-01T00:00:00Z" },
      ]},
      trip_invite_links: { rows: [
        { id: LINK_A_ID, trip_id: TRIP_ID, token: "tokenA", created_by: OWNER_ID,
          max_uses: null, use_count: 1, revoked_at: null, expires_at: null,
          created_at: "2026-01-01T00:00:00Z" },
      ]},
      trip_activity_log: { rows: [
        { trip_id: TRIP_ID, actor_id: BOB_ID, event_type: "joined_via_invite_link",
          metadata: { linkId: LINK_A_ID }, created_at: "2026-01-02T00:00:00Z" },
      ]},
      // Bob is NOT in trip_members — he was removed after joining
      trip_members: { rows: [] },
      profiles: { rows: [
        { id: BOB_ID, full_name: "Bob", username: "bob", avatar_url: null },
      ]},
    });
    _setTestClient(client, true);

    const r = await req(port, "GET", `/trips/${TRIP_ID}/invite-links`, { token: "owner-token" });
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 1);

    const link = r.body[0];
    assert.equal(link.joiners.length, 1);
    assert.equal(link.joiners[0].id, BOB_ID);
    assert.equal(link.joiners[0].removed, true, "Bob was removed — removed must be true");
  });

  // ── Case 3: no activity-log rows → empty joiners array, no crash ───────────
  it("link with no activity-log entries → empty joiners array, no crash", async () => {
    const { client } = makeFakeClient({
      trips: { rows: [
        { id: TRIP_ID, owner_id: OWNER_ID, title: "Test Trip", created_at: "2026-01-01T00:00:00Z" },
      ]},
      trip_invite_links: { rows: [
        { id: LINK_A_ID, trip_id: TRIP_ID, token: "tokenA", created_by: OWNER_ID,
          max_uses: 10, use_count: 0, revoked_at: null, expires_at: null,
          created_at: "2026-01-01T00:00:00Z" },
      ]},
      // No activity-log rows at all
      trip_activity_log: { rows: [] },
      trip_members: { rows: [] },
      profiles: { rows: [] },
    });
    _setTestClient(client, true);

    const r = await req(port, "GET", `/trips/${TRIP_ID}/invite-links`, { token: "owner-token" });
    assert.equal(r.status, 200, "should return 200, not crash");
    assert.equal(r.body.length, 1);

    const link = r.body[0];
    assert.ok(Array.isArray(link.joiners), "joiners should be an array");
    assert.equal(link.joiners.length, 0, "no activity rows → empty joiners array");
  });

  // ── Case 4: multiple links → each shows only its own joiners, correct flags ─
  it("multiple links each show correct subset of joiners with accurate removed flags", async () => {
    // Link A: Alice joined and is still a member
    // Link B: Bob joined but was later removed; Carol joined and stayed
    const { client } = makeFakeClient({
      trips: { rows: [
        { id: TRIP_ID, owner_id: OWNER_ID, title: "Test Trip", created_at: "2026-01-01T00:00:00Z" },
      ]},
      trip_invite_links: { rows: [
        { id: LINK_A_ID, trip_id: TRIP_ID, token: "tokenA", created_by: OWNER_ID,
          max_uses: null, use_count: 1, revoked_at: null, expires_at: null,
          created_at: "2026-01-01T00:00:00Z" },
        { id: LINK_B_ID, trip_id: TRIP_ID, token: "tokenB", created_by: OWNER_ID,
          max_uses: null, use_count: 2, revoked_at: null, expires_at: null,
          created_at: "2026-01-02T00:00:00Z" },
      ]},
      trip_activity_log: { rows: [
        { trip_id: TRIP_ID, actor_id: ALICE_ID, event_type: "joined_via_invite_link",
          metadata: { linkId: LINK_A_ID }, created_at: "2026-01-03T00:00:00Z" },
        { trip_id: TRIP_ID, actor_id: BOB_ID, event_type: "joined_via_invite_link",
          metadata: { linkId: LINK_B_ID }, created_at: "2026-01-04T00:00:00Z" },
        { trip_id: TRIP_ID, actor_id: CAROL_ID, event_type: "joined_via_invite_link",
          metadata: { linkId: LINK_B_ID }, created_at: "2026-01-05T00:00:00Z" },
      ]},
      trip_members: { rows: [
        // Alice and Carol are still members; Bob was removed
        { trip_id: TRIP_ID, user_id: ALICE_ID, role: "member" },
        { trip_id: TRIP_ID, user_id: CAROL_ID, role: "member" },
      ]},
      profiles: { rows: [
        { id: ALICE_ID, full_name: "Alice",  username: "alice",  avatar_url: null },
        { id: BOB_ID,   full_name: "Bob",    username: "bob",    avatar_url: null },
        { id: CAROL_ID, full_name: "Carol",  username: "carol",  avatar_url: null },
      ]},
    });
    _setTestClient(client, true);

    const r = await req(port, "GET", `/trips/${TRIP_ID}/invite-links`, { token: "owner-token" });
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 2, "two links should be returned");

    // Links are ordered newest-first (created_at DESC)
    const linkB = r.body[0]; // created 2026-01-02 — newest
    const linkA = r.body[1]; // created 2026-01-01

    assert.equal(linkA.id, LINK_A_ID);
    assert.equal(linkA.joiners.length, 1, "Link A has only Alice");
    assert.equal(linkA.joiners[0].id, ALICE_ID);
    assert.equal(linkA.joiners[0].removed, false, "Alice is still a member");

    assert.equal(linkB.id, LINK_B_ID);
    assert.equal(linkB.joiners.length, 2, "Link B has Bob and Carol");

    const byId = Object.fromEntries(linkB.joiners.map((j: any) => [j.id, j]));
    assert.equal(byId[BOB_ID].removed,   true,  "Bob was removed");
    assert.equal(byId[CAROL_ID].removed, false, "Carol is still a member");
  });
});
