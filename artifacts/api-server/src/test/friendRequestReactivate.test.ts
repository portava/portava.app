/**
 * Friend request re-activation — responded_at reset (task audit accuracy)
 *
 * POST /users/:userId/friend-request re-activates a declined/cancelled
 * request by setting status back to "pending". Migration 0161 added
 * responded_at/updated_at to friend_requests, so the reset path MUST null
 * out the stale responded_at and bump updated_at — otherwise re-activated
 * pending requests carry a bogus answer timestamp into response-time reports.
 *
 * Runtime: node:test + node:assert/strict.
 * Run:
 *   node --import tsx/esm --test src/test/friendRequestReactivate.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";

const ALICE_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const BOB_ID   = "bbbbbbbb-0000-0000-0000-000000000002";
const REQ_ID   = "dddddddd-0000-0000-0000-00000000d001";

const OLD_RESPONDED_AT = "2026-06-01T12:00:00.000Z";
const OLD_UPDATED_AT   = "2026-06-01T12:00:00.000Z";

// ── Minimal fake Supabase client that APPLIES updates to in-memory rows ──────

interface FakeState {
  users: Record<string, { id: string }>;
  tables: Record<string, Array<Record<string, any>>>;
}

function makeClient(state: FakeState) {
  const db = state.tables;

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let insertPayload: any = null;
    let updatePayload: any = null;

    const rows = () => (db[table] ?? []).filter((r) => filters.every((f) => f(r)));

    const b: any = {
      select() { return b; },
      insert(row: any) { insertPayload = row; return b; },
      update(patch: any) { updatePayload = patch; return b; },
      upsert() { return b; },
      delete() { return b; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return b; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return b; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return b; },
      is(col: string, val: any) {
        filters.push((r) => (val === null ? r[col] == null : r[col] === val));
        return b;
      },
      or() { return b; },
      not() { return b; },
      limit() { return b; },
      order() { return b; },
      maybeSingle: () => resolve(true),
      single: () => resolve(false),
      then(onF: any, onR: any) { return resolve(true).then(onF, onR); },
    };

    async function resolve(maybe: boolean) {
      if (insertPayload) {
        const row = { id: "new-id", ...insertPayload };
        (db[table] ??= []).push(row);
        return { data: row, error: null };
      }
      if (updatePayload) {
        const matched = rows();
        for (const r of matched) Object.assign(r, updatePayload);
        return { data: matched[0] ?? null, error: null };
      }
      const matched = rows();
      if (!maybe && matched.length === 0) return { data: null, error: { message: "not found" } };
      return { data: matched[0] ?? null, error: null };
    }

    return b;
  }

  return {
    from,
    auth: {
      getUser: async (token: string) => {
        const u = state.users[token];
        if (!u) return { data: { user: null }, error: { message: "invalid token" } };
        return { data: { user: { id: u.id } }, error: null };
      },
    },
  };
}

function makeApp(...routers: any[]): Express {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });
  for (const router of routers) app.use("/api", router);
  return app;
}

async function startServer(app: Express) {
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as any).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(r)) });
    });
  });
}

// =============================================================================

describe("Re-activating a declined friend request clears the stale answer timestamp", () => {
  let url: string;
  let close: () => Promise<void>;
  let friendRequests: Array<Record<string, any>>;
  let testStart: number;

  before(async () => {
    const { default: friendsRouter } = await import("../routes/friends.js");
    friendRequests = [{
      id: REQ_ID,
      requester_id: ALICE_ID,
      recipient_id: BOB_ID,
      status: "declined",
      responded_at: OLD_RESPONDED_AT,
      updated_at: OLD_UPDATED_AT,
    }];
    const client = makeClient({
      users: { "alice-tok": { id: ALICE_ID }, "bob-tok": { id: BOB_ID } },
      tables: {
        profiles: [
          { id: ALICE_ID, handle: "alice", name: "Alice", is_private: false },
          { id: BOB_ID,   handle: "bob",   name: "Bob",   is_private: false },
        ],
        friend_requests: friendRequests,
        blocks: [],
        user_follows: [],
        user_friendships: [],
        user_account_states: [],
        user_privacy_settings: [],
        user_mutes: [],
        user_restrictions: [],
        trust_restrictions: [],
        user_interaction_cooldowns: [],
        moderation_actions: [],
        trip_members: [],
        circle_memberships: [],
        rent_buddy_bookings: [],
        user_message_settings: [],
        message_requests: [],
      },
    });
    _setTestClient(client, true);
    testStart = Date.now();
    const srv = await startServer(makeApp(friendsRouter));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("resets responded_at to null and bumps updated_at when re-sending", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/friend-request`, {
      method: "POST",
      headers: { Authorization: "Bearer alice-tok", "Content-Type": "application/json" },
    });
    assert.equal(res.status, 200, "re-send of a declined request should succeed");
    const body = await res.json() as any;
    assert.equal(body.requestId, REQ_ID, "must reuse the existing request row");
    assert.equal(body.status, "outgoing_pending");
    assert.equal(body.reactivated, true, "response must flag the re-activation");

    const row = friendRequests.find((r) => r.id === REQ_ID)!;
    assert.equal(row.status, "pending", "status must be back to pending");
    assert.equal(row.responded_at, null,
      "stale responded_at must be cleared — a pending request has no answer timestamp");
    assert.notEqual(row.updated_at, OLD_UPDATED_AT, "updated_at must be bumped");
    assert.ok(
      Date.parse(row.updated_at) >= testStart - 1000,
      "updated_at must reflect the re-activation time",
    );
  });
});
