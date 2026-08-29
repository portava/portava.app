/**
 * inviteLinkTripFull.test.ts
 *
 * Regression guard for the trip-full race-condition fix.
 *
 * When a trip fills up between preview and accept, the capacity guard must
 * return HTTP 410 with BOTH `error: "gone"` AND `reason: "trip_full"` in the
 * response body.  The mobile client uses the `reason` field to distinguish
 * this case from other 410 responses and triggers a re-fetch instead of
 * showing a generic "link may have expired" alert.
 *
 * If `reason` is missing or incorrect, a regression would silently restore
 * the confusing error message for users whose trip fills up after they
 * previewed the invite.
 *
 * Scenarios:
 *   1. Trip at max_members cap → 410 with { error:"gone", reason:"trip_full" }
 *   2. Trip over cap           → same shape (defensive: should never happen in
 *                                practice but must behave consistently)
 *   3. Trip not at cap         → 201 joined (guard must NOT fire prematurely)
 *   4. max_members=null        → 201 joined (unlimited trips are never "full")
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

// ---------------------------------------------------------------------------
// Fixed test IDs — use only [0-9a-f] hex chars so UUID_RE validation passes
// ---------------------------------------------------------------------------
const OWNER_ID   = "a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1";
const JOINER_ID  = "b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2";
const TRIP_ID    = "c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3";
const LINK_ID    = "d4d4d4d4-d4d4-d4d4-d4d4-d4d4d4d4d4d4";
const LINK_TOKEN = "tripfull-race-guard-token-abcdef123456";

// ---------------------------------------------------------------------------
// Fake-client factory
// ---------------------------------------------------------------------------
function makeClient(opts: {
  maxMembers: number | null;
  existingMemberCount?: number;
  claimResult?: string;
}): { client: any; rpcCalls: Array<{ fn: string; args: Record<string, any> }> } {
  const {
    maxMembers,
    existingMemberCount = 0,
    claimResult = "claimed",
  } = opts;

  const rpcCalls: Array<{ fn: string; args: Record<string, any> }> = [];

  const client: any = {
    auth: {
      getUser: async (token: string) => {
        if (token === "joiner-token") {
          return { data: { user: { id: JOINER_ID } }, error: null };
        }
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },

    rpc: async (fn: string, args: Record<string, any>) => {
      rpcCalls.push({ fn, args });
      if (fn === "claim_invite_link_slot_for_user") {
        return { data: claimResult, error: null };
      }
      if (fn === "release_invite_link_slot") {
        return { data: null, error: null };
      }
      return { data: null, error: { message: `Unknown rpc: ${fn}` } };
    },

    from: (tableName: string) => {
      let memberCheckCount = 0;

      const obj: any = {
        select() { return obj; },
        insert() {
          return {
            then(onF: any, onR: any) {
              return Promise.resolve({ data: null, error: null }).then(onF, onR);
            },
          };
        },
        eq() { return obj; },
        or() { return obj; },
        limit() { return obj; }, // isBlockedBetween chains .or().limit(1)
        delete() { return obj; },

        maybeSingle() {
          if (tableName === "trip_invite_links") {
            return Promise.resolve({
              data: {
                id:         LINK_ID,
                trip_id:    TRIP_ID,
                token:      LINK_TOKEN,
                created_by: OWNER_ID,
                max_uses:   10,
                use_count:  0,
                revoked_at: null,
                expires_at: null,
                created_at: "2026-01-01T00:00:00Z",
              },
              error: null,
            });
          }

          if (tableName === "trips") {
            return Promise.resolve({
              data: {
                id:          TRIP_ID,
                owner_id:    OWNER_ID,
                status:      "upcoming",
                end_date:    "2099-12-31",
                max_members: maxMembers,
              },
              error: null,
            });
          }

          if (tableName === "trip_members") {
            // First check = requireTripMember (not a member), second = post-claim re-check.
            memberCheckCount += 1;
            return Promise.resolve({ data: null, error: null });
          }

          if (tableName === "blocks") {
            return Promise.resolve({ data: null, error: null });
          }

          return Promise.resolve({ data: null, error: null });
        },

        then(onF: any, onR: any) {
          if (tableName === "trip_members") {
            // Capacity count query: SELECT id FROM trip_members WHERE trip_id=... AND status='accepted'
            const rows = Array.from(
              { length: existingMemberCount },
              (_, i) => ({ id: `member-${i}` }),
            );
            return Promise.resolve({ data: rows, error: null }).then(onF, onR);
          }
          return Promise.resolve({ data: [], error: null }).then(onF, onR);
        },
      };

      return obj;
    },
  };

  return { client, rpcCalls };
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

async function postAccept(
  port: number,
  token: string,
  authToken = "joiner-token",
): Promise<{ status: number; body: any }> {
  const url = `http://127.0.0.1:${port}/api/trips/invite-link/${encodeURIComponent(token)}/accept`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({}),
  });
  let body: any;
  try {
    body = res.headers.get("content-type")?.includes("application/json")
      ? await res.json()
      : await res.text();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("POST /api/trips/invite-link/:token/accept — trip-full race-condition guard", () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    if (server) server.close();
    ({ server, port } = await startServer());
  });

  after(() => {
    if (server) server.close();
  });

  // ── 1. Trip exactly at cap → 410 with reason:"trip_full" ─────────────────
  it('returns 410 with { error:"gone", reason:"trip_full" } when accepted members == max_members', async () => {
    const { client } = makeClient({ maxMembers: 3, existingMemberCount: 3 });
    _setTestClient(client, true);

    const r = await postAccept(port, LINK_TOKEN);

    assert.equal(r.status, 410, "capacity guard must return HTTP 410");
    assert.equal(r.body.error, "gone", 'error field must be "gone"');
    assert.equal(
      r.body.reason,
      "trip_full",
      'reason field must be "trip_full" so the mobile client re-fetches instead of showing a generic error',
    );
    assert.ok(
      typeof r.body.message === "string" && r.body.message.length > 0,
      "response must include a human-readable message",
    );
  });

  // ── 2. Trip over cap → same 410 shape ────────────────────────────────────
  it('returns 410 with reason:"trip_full" when accepted members exceed max_members', async () => {
    const { client } = makeClient({ maxMembers: 2, existingMemberCount: 5 });
    _setTestClient(client, true);

    const r = await postAccept(port, LINK_TOKEN);

    assert.equal(r.status, 410);
    assert.equal(r.body.error, "gone");
    assert.equal(r.body.reason, "trip_full");
  });

  // ── 3. Trip under cap → succeeds, reason field absent ────────────────────
  it("returns 201 joined when the trip still has capacity", async () => {
    const { client } = makeClient({ maxMembers: 5, existingMemberCount: 2 });
    _setTestClient(client, true);

    const r = await postAccept(port, LINK_TOKEN);

    assert.equal(r.status, 201, "under-capacity trip must allow joining (HTTP 201)");
    assert.equal(r.body.status, "joined");
    assert.equal(
      r.body.reason,
      undefined,
      "reason must not be present on a successful join",
    );
  });

  // ── 4. No cap → succeeds (unlimited trip) ────────────────────────────────
  it("returns 201 joined when max_members is null (unlimited)", async () => {
    const { client } = makeClient({ maxMembers: null, existingMemberCount: 999 });
    _setTestClient(client, true);

    const r = await postAccept(port, LINK_TOKEN);

    assert.equal(r.status, 201, "unlimited trips must never be blocked by the capacity guard");
    assert.equal(r.body.status, "joined");
  });

  // ── 5. slot claim is never reached for a full trip ────────────────────────
  it("does not call claim_invite_link_slot_for_user when the trip is full", async () => {
    const { client, rpcCalls } = makeClient({ maxMembers: 3, existingMemberCount: 3 });
    _setTestClient(client, true);

    await postAccept(port, LINK_TOKEN);

    const claimCalls = rpcCalls.filter((c) => c.fn === "claim_invite_link_slot_for_user");
    assert.equal(
      claimCalls.length,
      0,
      "a full trip must be rejected before the slot claim to avoid wasting use_count",
    );
  });
});
