/**
 * inviteLinkPreviewFull.test.ts
 *
 * Covers the isFull code path in:
 *   GET /api/trips/invite-link/:token/preview
 *
 * Scenarios:
 *   1. max_members=null  → isFull:false (member-count query is skipped entirely)
 *   2. At capacity       → accepted member count >= max_members → isFull:true
 *   3. Under capacity    → accepted member count < max_members  → isFull:false
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

// ---------------------------------------------------------------------------
// Fixed test IDs
// ---------------------------------------------------------------------------
const OWNER_ID   = "aa000001-aa00-aa00-aa00-aa0000000001";
const VIEWER_ID  = "bb000002-bb00-bb00-bb00-bb0000000002";
const TRIP_ID    = "cc000003-cc00-cc00-cc00-cc0000000003";
const LINK_ID    = "dd000004-dd00-dd00-dd00-dd0000000004";
const LINK_TOKEN = "full-check-test-token-abcde1234567890";

// ---------------------------------------------------------------------------
// Fake-client factory
// ---------------------------------------------------------------------------
function makeClient(opts: {
  maxMembers: number | null;
  acceptedMemberCount?: number;
}) {
  const { maxMembers, acceptedMemberCount = 0 } = opts;

  // Track direct-await calls on trip_members (the isFull path, not maybeSingle).
  let memberCountQueryFired = false;

  const client: any = {
    auth: {
      getUser: async (token: string) => {
        if (token === "viewer-token") {
          return { data: { user: { id: VIEWER_ID } }, error: null };
        }
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },

    from: (tableName: string) => {
      const obj: any = {
        select()                { return obj; },
        eq(_col: string, _val: any) { return obj; },

        // Used by requireTripMember (membership check) and link/trip lookups.
        maybeSingle() {
          if (tableName === "trip_invite_links") {
            return Promise.resolve({
              data: {
                id:         LINK_ID,
                trip_id:    TRIP_ID,
                token:      LINK_TOKEN,
                created_by: OWNER_ID,
                max_uses:   null,
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
                id:                  TRIP_ID,
                title:               "Full-check Trip",
                destination_city:    "Tokyo",
                destination_country: "Japan",
                start_date:          "2099-07-01",
                end_date:            "2099-07-14",
                cover_url:           null,
                owner_id:            OWNER_ID,
                visibility:          "invite_only",
                status:              "upcoming",
                max_members:         maxMembers,
              },
              error: null,
            });
          }

          if (tableName === "trip_members") {
            // requireTripMember — viewer is never a member in these scenarios.
            return Promise.resolve({ data: null, error: null });
          }

          return Promise.resolve({ data: null, error: null });
        },

        // Used by the isFull member-count query (direct await, no maybeSingle).
        then(onFulfilled: any, onRejected: any) {
          if (tableName === "trip_members") {
            memberCountQueryFired = true;
            const rows = Array.from(
              { length: acceptedMemberCount },
              (_, i) => ({ id: `member-accepted-${i}` }),
            );
            return Promise.resolve({ data: rows, error: null }).then(onFulfilled, onRejected);
          }
          return Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected);
        },
      };

      return obj;
    },

    // Expose for assertions.
    get memberCountQueryFired() { return memberCountQueryFired; },
  };

  return client;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
async function startServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, () => {
      server.unref();
      resolve({ server, port: (server.address() as any).port });
    });
  });
}

async function getPreview(
  port: number,
  token: string,
  authToken = "viewer-token",
): Promise<{ status: number; body: any }> {
  const url = `http://127.0.0.1:${port}/api/trips/invite-link/${encodeURIComponent(token)}/preview`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${authToken}` },
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
describe("GET /api/trips/invite-link/:token/preview — isFull code paths", () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    if (server) server.close();
    ({ server, port } = await startServer());
  });

  after(() => {
    if (server) server.close();
  });

  // ── 1. max_members=null → isFull:false, no member-count query issued ──────
  it("returns isFull:false and skips the member-count query when max_members is null", async () => {
    const fakeClient = makeClient({ maxMembers: null });
    _setTestClient(fakeClient, true);

    const r = await getPreview(port, LINK_TOKEN);

    assert.equal(r.status, 200, "should return 200");
    assert.equal(r.body.isFull, false, "isFull must be false when max_members is null");
    assert.equal(
      fakeClient.memberCountQueryFired,
      false,
      "member-count query must NOT run when max_members is null",
    );
  });

  // ── 2. At capacity: accepted count >= max_members → isFull:true ───────────
  it("returns isFull:true when accepted member count equals max_members", async () => {
    _setTestClient(
      makeClient({ maxMembers: 3, acceptedMemberCount: 3 }),
      true,
    );

    const r = await getPreview(port, LINK_TOKEN);

    assert.equal(r.status, 200, "should return 200");
    assert.equal(r.body.isFull, true, "isFull must be true when accepted count === max_members");
    assert.equal(r.body.isTerminal, false, "active trip must not be terminal");
    assert.equal(r.body.alreadyMember, false);
  });

  it("returns isFull:true when accepted member count exceeds max_members", async () => {
    _setTestClient(
      makeClient({ maxMembers: 2, acceptedMemberCount: 5 }),
      true,
    );

    const r = await getPreview(port, LINK_TOKEN);

    assert.equal(r.status, 200);
    assert.equal(r.body.isFull, true, "isFull must be true when accepted count > max_members");
  });

  // ── 3. Under capacity: accepted count < max_members → isFull:false ────────
  it("returns isFull:false when accepted member count is under max_members", async () => {
    _setTestClient(
      makeClient({ maxMembers: 5, acceptedMemberCount: 2 }),
      true,
    );

    const r = await getPreview(port, LINK_TOKEN);

    assert.equal(r.status, 200, "should return 200");
    assert.equal(r.body.isFull, false, "isFull must be false when accepted count < max_members");
    assert.equal(r.body.tripTitle, "Full-check Trip");
  });

  it("returns isFull:false when max_members is set but no accepted members exist", async () => {
    _setTestClient(
      makeClient({ maxMembers: 4, acceptedMemberCount: 0 }),
      true,
    );

    const r = await getPreview(port, LINK_TOKEN);

    assert.equal(r.status, 200);
    assert.equal(r.body.isFull, false, "isFull must be false when no accepted members");
  });
});
