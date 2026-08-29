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
  /** Rows that exist in trip_members but carry a non-"accepted" status.
   *  The fake client serves these only when the status filter is NOT "accepted",
   *  mirroring the DB behaviour that a WHERE status='accepted' clause would give.
   *  This lets us assert that stale/pending/removed rows never inflate isFull. */
  nonAcceptedMemberCount?: number;
}) {
  const { maxMembers, acceptedMemberCount = 0, nonAcceptedMemberCount = 0 } = opts;

  // Track direct-await calls on trip_members (the isFull path, not maybeSingle).
  let memberCountQueryFired = false;
  // Track exactly which status value was passed to .eq("status", ...) so tests
  // can assert the query always filters by "accepted".
  let capturedStatusFilter: string | null = null;

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
      // Per-builder state: accumulate eq filters so then() can respect them.
      let statusFilter: string | null = null;

      const obj: any = {
        select() { return obj; },
        eq(col: string, val: any) {
          if (tableName === "trip_members" && col === "status") {
            statusFilter = String(val);
            capturedStatusFilter = statusFilter;
          }
          return obj;
        },

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
        // Honour the status filter so non-"accepted" rows are not included when
        // the query correctly asks for status="accepted" only.
        then(onFulfilled: any, onRejected: any) {
          if (tableName === "trip_members") {
            memberCountQueryFired = true;
            // Return only the rows that match the requested status filter.
            // If the filter is "accepted" (the correct contract), return accepted rows.
            // Any other filter value gets the non-accepted rows — this surfaces
            // a bug if the production code ever asks for the wrong status.
            const count =
              statusFilter === "accepted" ? acceptedMemberCount : nonAcceptedMemberCount;
            const prefix = statusFilter === "accepted" ? "accepted" : "other";
            const rows = Array.from(
              { length: count },
              (_, i) => ({ id: `member-${prefix}-${i}` }),
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
    get capturedStatusFilter()  { return capturedStatusFilter; },
  };

  return client;
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

  // ── 4. Stale/non-accepted rows must not inflate the count ─────────────────
  // Scenario: max_members=3, accepted=2, non-accepted=4 (e.g. pending/removed).
  // Total rows in trip_members would be 6, but only 2 are accepted.
  // The endpoint must count only accepted rows → isFull:false.
  it("does not count non-accepted rows (pending/removed) when checking isFull", async () => {
    const fakeClient = makeClient({
      maxMembers: 3,
      acceptedMemberCount: 2,
      nonAcceptedMemberCount: 4,
    });
    _setTestClient(fakeClient, true);

    const r = await getPreview(port, LINK_TOKEN);

    assert.equal(r.status, 200, "should return 200");
    assert.equal(
      r.body.isFull,
      false,
      "isFull must be false: only 2 accepted members, not 6 total rows",
    );
    assert.equal(
      fakeClient.capturedStatusFilter,
      "accepted",
      "isFull query must filter trip_members by status='accepted'",
    );
  });

  // Variant: if every non-accepted row were counted, the trip would look full
  // (4 stale rows >= max_members=3), but accepted-only count (1) is under cap.
  it("does not report full when stale rows alone would exceed max_members", async () => {
    const fakeClient = makeClient({
      maxMembers: 3,
      acceptedMemberCount: 1,
      nonAcceptedMemberCount: 5,
    });
    _setTestClient(fakeClient, true);

    const r = await getPreview(port, LINK_TOKEN);

    assert.equal(r.status, 200);
    assert.equal(
      r.body.isFull,
      false,
      "stale rows alone must not trigger isFull",
    );
    assert.equal(
      fakeClient.capturedStatusFilter,
      "accepted",
      "query must always use status='accepted' filter",
    );
  });
});
