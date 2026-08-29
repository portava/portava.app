/**
 * inviteLinkPreview.test.ts
 *
 * Focused tests for the trip-inactive 410 code path in:
 *   GET /api/trips/invite-link/:token/preview
 *
 * Scenarios:
 *   1. cancelled trip   → 410 { error: "gone", reason: "trip_inactive" }
 *   2. archived trip    → 410 { error: "gone", reason: "trip_inactive" }
 *   3. end_date < today → 410 { error: "gone", reason: "trip_inactive" }
 *   4. active trip      → 200 with isFull:false, no isTerminal field
 *   5. already a member → 200 with alreadyMember:true (active trip only)
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
const OWNER_ID   = "aa111111-aa11-aa11-aa11-aa1111111111";
const VIEWER_ID  = "bb222222-bb22-bb22-bb22-bb2222222222";
const TRIP_ID    = "cc333333-cc33-cc33-cc33-cc3333333333";
const LINK_ID    = "dd444444-dd44-dd44-dd44-dd4444444444";
const LINK_TOKEN = "preview-terminal-test-token-abcde12345";

// ---------------------------------------------------------------------------
// Fake-client factory
// ---------------------------------------------------------------------------

function makeClient(opts: {
  tripStatus?: string | null;
  endDate?: string | null;
  viewerIsMember?: boolean;
}) {
  const {
    tripStatus    = "upcoming",
    endDate       = null,
    viewerIsMember = false,
  } = opts;

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
      const filters: Array<(r: any) => boolean> = [];

      const obj: any = {
        select()          { return obj; },
        eq(col: string, val: any) {
          filters.push((r: any) => r[col] === val);
          return obj;
        },
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
                id:                 TRIP_ID,
                title:              "Test Trip",
                destination_city:   "Rome",
                destination_country: "Italy",
                start_date:         "2099-06-01",
                end_date:           endDate,
                cover_url:          null,
                owner_id:           OWNER_ID,
                visibility:         "invite_only",
                status:             tripStatus,
              },
              error: null,
            });
          }

          if (tableName === "trip_members") {
            const row = viewerIsMember
              ? { trip_id: TRIP_ID, user_id: VIEWER_ID, role: "member", status: "accepted" }
              : null;
            return Promise.resolve({ data: row, error: null });
          }

          return Promise.resolve({ data: null, error: null });
        },
      };

      return obj;
    },
  };

  return client;
}

// ---------------------------------------------------------------------------
// HTTP helper
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
  authToken: string = "viewer-token",
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
describe("GET /api/trips/invite-link/:token/preview — trip_inactive 410 paths", () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    if (server) server.close();
    ({ server, port } = await startServer());
  });

  after(() => {
    if (server) server.close();
  });

  // ── 1. cancelled trip ────────────────────────────────────────────────────
  it("returns 410 with reason trip_inactive for a cancelled trip", async () => {
    _setTestClient(makeClient({ tripStatus: "cancelled" }), true);

    const r = await getPreview(port, LINK_TOKEN);

    assert.equal(r.status, 410, "cancelled trip preview must return 410");
    assert.equal(r.body.error, "gone");
    assert.equal(r.body.reason, "trip_inactive");
  });

  // ── 2. archived trip ─────────────────────────────────────────────────────
  it("returns 410 with reason trip_inactive for an archived trip", async () => {
    _setTestClient(makeClient({ tripStatus: "archived" }), true);

    const r = await getPreview(port, LINK_TOKEN);

    assert.equal(r.status, 410, "archived trip preview must return 410");
    assert.equal(r.body.error, "gone");
    assert.equal(r.body.reason, "trip_inactive");
  });

  // ── 3. trip with end_date in the past ────────────────────────────────────
  it("returns 410 with reason trip_inactive when end_date is in the past", async () => {
    _setTestClient(
      makeClient({ tripStatus: "upcoming", endDate: "2020-01-01" }),
      true,
    );

    const r = await getPreview(port, LINK_TOKEN);

    assert.equal(r.status, 410, "past end_date trip preview must return 410");
    assert.equal(r.body.error, "gone");
    assert.equal(r.body.reason, "trip_inactive");
  });

  // ── 4. active upcoming trip ───────────────────────────────────────────────
  it("returns 200 for an active trip with isTerminal explicitly false", async () => {
    _setTestClient(
      makeClient({ tripStatus: "upcoming", endDate: "2099-12-31" }),
      true,
    );

    const r = await getPreview(port, LINK_TOKEN);

    assert.equal(r.status, 200);
    assert.equal(r.body.tripTitle, "Test Trip");
    assert.equal(r.body.isFull, false);
    // Contract: the 200 preview always emits isTerminal: false (terminal
    // trips 410 before reaching this branch). Matches inviteLinkPreviewFull.
    assert.equal(
      r.body.isTerminal,
      false,
      "isTerminal must be false in the 200 response",
    );
  });

  // ── 5. no end_date and active status ─────────────────────────────────────
  it("returns 200 when there is no end_date and status is upcoming", async () => {
    _setTestClient(
      makeClient({ tripStatus: "upcoming", endDate: null }),
      true,
    );

    const r = await getPreview(port, LINK_TOKEN);

    assert.equal(r.status, 200);
    assert.equal(
      r.body.isTerminal,
      false,
      "isTerminal must be false in the 200 response",
    );
  });

  // ── 6. already a member on a terminal trip ───────────────────────────────
  it("returns 410 trip_inactive even when the viewer is already a member of a cancelled trip", async () => {
    _setTestClient(
      makeClient({ tripStatus: "cancelled", viewerIsMember: true }),
      true,
    );

    const r = await getPreview(port, LINK_TOKEN);

    assert.equal(r.status, 410, "terminal trip must return 410 regardless of membership");
    assert.equal(r.body.error, "gone");
    assert.equal(r.body.reason, "trip_inactive");
  });
});

// ---------------------------------------------------------------------------
// POST /api/trips/invite-link/:token/accept — terminal-state enforcement
// ---------------------------------------------------------------------------

const ACCEPT_OWNER_ID   = "ee555555-ee55-ee55-ee55-ee5555555555";
const ACCEPT_VIEWER_ID  = "ff666666-ff66-ff66-ff66-ff6666666666";
const ACCEPT_TRIP_ID    = "aa777777-aa77-aa77-aa77-aa7777777777";
const ACCEPT_LINK_ID    = "bb888888-bb88-bb88-bb88-bb8888888888";
const ACCEPT_LINK_TOKEN = "accept-terminal-test-token-xyz9876543";

function makeAcceptClient(opts: {
  tripStatus?: string | null;
  endDate?: string | null;
}) {
  const { tripStatus = "upcoming", endDate = null } = opts;

  const client: any = {
    auth: {
      getUser: async (token: string) => {
        if (token === "accept-viewer-token") {
          return { data: { user: { id: ACCEPT_VIEWER_ID } }, error: null };
        }
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },

    from: (tableName: string) => {
      const obj: any = {
        select()            { return obj; },
        eq()                { return obj; },
        or()                { return obj; },
        limit() { return obj; }, // isBlockedBetween chains .or().limit(1)
        neq()               { return obj; },
        maybeSingle() {
          if (tableName === "trip_invite_links") {
            return Promise.resolve({
              data: {
                id:         ACCEPT_LINK_ID,
                trip_id:    ACCEPT_TRIP_ID,
                token:      ACCEPT_LINK_TOKEN,
                created_by: ACCEPT_OWNER_ID,
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
                id:          ACCEPT_TRIP_ID,
                owner_id:    ACCEPT_OWNER_ID,
                status:      tripStatus,
                end_date:    endDate,
                max_members: null,
              },
              error: null,
            });
          }

          if (tableName === "blocks") {
            return Promise.resolve({ data: null, error: null });
          }

          return Promise.resolve({ data: null, error: null });
        },
      };

      return obj;
    },
  };

  return client;
}

async function postAccept(
  port: number,
  token: string,
  authToken: string = "accept-viewer-token",
): Promise<{ status: number; body: any }> {
  const url = `http://127.0.0.1:${port}/api/trips/invite-link/${encodeURIComponent(token)}/accept`;
  const res = await fetch(url, {
    method: "POST",
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

describe("POST /api/trips/invite-link/:token/accept — terminal-state enforcement", () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    if (server) server.close();
    ({ server, port } = await startServer());
  });

  after(() => {
    if (server) server.close();
  });

  it("returns 410 gone when the trip is cancelled", async () => {
    _setTestClient(makeAcceptClient({ tripStatus: "cancelled" }), true);

    const r = await postAccept(port, ACCEPT_LINK_TOKEN);

    assert.equal(r.status, 410, "cancelled trip accept must return 410");
    assert.equal(r.body.error, "gone");
    assert.ok(
      typeof r.body.message === "string" && r.body.message.length > 0,
      "410 body must include a human-readable message",
    );
  });

  it("returns 410 gone when the trip is archived", async () => {
    _setTestClient(makeAcceptClient({ tripStatus: "archived" }), true);

    const r = await postAccept(port, ACCEPT_LINK_TOKEN);

    assert.equal(r.status, 410, "archived trip accept must return 410");
    assert.equal(r.body.error, "gone");
  });

  it("returns 410 gone when the trip end_date is in the past", async () => {
    _setTestClient(
      makeAcceptClient({ tripStatus: "upcoming", endDate: "2020-06-01" }),
      true,
    );

    const r = await postAccept(port, ACCEPT_LINK_TOKEN);

    assert.equal(r.status, 410, "past-end-date trip accept must return 410");
    assert.equal(r.body.error, "gone");
    assert.ok(
      typeof r.body.message === "string" && r.body.message.length > 0,
      "410 body must include a human-readable message",
    );
  });
});

// ---------------------------------------------------------------------------
// POST /api/trips/invite-link/:token/accept — concurrent slot race (max_uses=1)
// ---------------------------------------------------------------------------
//
// Verifies that claim_invite_link_slot_for_user is the single source of truth
// for slot capacity.  When two accepts arrive concurrently against a link with
// max_uses = 1, the first caller gets 'claimed' and joins (201); the second
// gets 'limit_reached' and receives 410.  The pre-flight max_members check is
// intentionally left null so both requests reach the RPC gate.

const RACE_OWNER_ID   = "11aaaaaa-11aa-11aa-11aa-11aaaaaaaaaa";
const RACE_USER_ID    = "22bbbbbb-22bb-22bb-22bb-22bbbbbbbbbb";
const RACE_TRIP_ID    = "33cccccc-33cc-33cc-33cc-33cccccccccc";
const RACE_LINK_ID    = "44dddddd-44dd-44dd-44dd-44dddddddddd";
const RACE_LINK_TOKEN = "race-capacity-test-token-xxxxxxxxxx1";

function makeRaceClient() {
  let rpcCallCount = 0;

  const client: any = {
    auth: {
      getUser: async (token: string) => {
        if (token === "race-accept-token") {
          return { data: { user: { id: RACE_USER_ID } }, error: null };
        }
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },

    rpc: async (fnName: string) => {
      if (fnName === "claim_invite_link_slot_for_user") {
        rpcCallCount += 1;
        if (rpcCallCount === 1) {
          return { data: "claimed", error: null };
        }
        return { data: "limit_reached", error: null };
      }
      return { data: null, error: null };
    },

    from: (tableName: string) => {
      const obj: any = {
        select() { return obj; },
        eq()     { return obj; },
        or()     { return obj; },
        limit() { return obj; }, // isBlockedBetween chains .or().limit(1)
        neq()    { return obj; },
        delete() { return obj; },

        insert() {
          return Promise.resolve({ data: null, error: null });
        },

        // Supports `await obj` directly (used by the capacity pre-flight check
        // and clearAttempt).  Returns an empty member list so both requests
        // pass the pre-flight guard and reach the RPC — exactly the race we
        // want to exercise.
        then(resolve: (v: any) => void) {
          if (tableName === "trip_members") {
            resolve({ data: [], error: null });
          } else {
            resolve({ data: null, error: null });
          }
        },

        maybeSingle() {
          if (tableName === "trip_invite_links") {
            return Promise.resolve({
              data: {
                id:         RACE_LINK_ID,
                trip_id:    RACE_TRIP_ID,
                token:      RACE_LINK_TOKEN,
                created_by: RACE_OWNER_ID,
                // max_uses = 1: only one slot available
                max_uses:   1,
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
                id:          RACE_TRIP_ID,
                owner_id:    RACE_OWNER_ID,
                status:      "upcoming",
                end_date:    "2099-12-31",
                // max_members left null so the pre-flight check is skipped and
                // both concurrent requests reach the RPC gate
                max_members: null,
              },
              error: null,
            });
          }

          // trip_members + blocks: neither user is a member yet, no blocks
          return Promise.resolve({ data: null, error: null });
        },
      };

      return obj;
    },
  };

  return client;
}

describe("POST /api/trips/invite-link/:token/accept — concurrent slot race with max_uses=1", () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    if (server) server.close();
    ({ server, port } = await startServer());
  });

  after(() => {
    if (server) server.close();
  });

  it("allows exactly one accept when two requests race for the last slot", async () => {
    // A single shared fake client — its rpc() counter increments on each call,
    // so the first caller gets 'claimed' and the second gets 'limit_reached'.
    _setTestClient(makeRaceClient(), true);

    const url = `http://127.0.0.1:${port}/api/trips/invite-link/${encodeURIComponent(RACE_LINK_TOKEN)}/accept`;

    const makeRequest = () =>
      fetch(url, {
        method: "POST",
        headers: { Authorization: "Bearer race-accept-token" },
      }).then(async (res) => ({
        status: res.status,
        body: res.headers.get("content-type")?.includes("application/json")
          ? await res.json()
          : await res.text(),
      }));

    // Fire both requests concurrently.
    const [r1, r2] = await Promise.all([makeRequest(), makeRequest()]);

    const statuses = [r1.status, r2.status].sort();

    // Exactly one must succeed (201 joined) and one must be rejected (410).
    assert.deepEqual(
      statuses,
      [201, 410],
      `expected one 201 and one 410 but got ${r1.status} and ${r2.status}`,
    );

    const winner  = r1.status === 201 ? r1 : r2;
    const loser   = r1.status === 410 ? r1 : r2;

    assert.equal(winner.body.status, "joined",  "winning response must have status=joined");
    assert.equal(winner.body.tripId, RACE_TRIP_ID, "winning response must include tripId");

    assert.equal(loser.body.error, "gone", "losing response must have error=gone");
    assert.ok(
      typeof loser.body.message === "string" && loser.body.message.length > 0,
      "losing 410 must include a human-readable message",
    );
  });
});
