/**
 * Admin venue moderation — baseline and fail-open tests
 *
 * Route under test: POST /admin/venues/:id/moderate
 * Source:           artifacts/api-server/src/routes/admin.ts (~line 316)
 *
 * Invariants tested:
 *  1. approve → status becomes "verified", route returns 200 with venue
 *  2. reject  → status becomes "blocked",  route returns 200 with venue
 *  3. Non-provisional venue returns 404 not_found
 *  4. Non-admin caller gets 403
 *  5. Unknown action gets 400
 *  6. Fail-open: if a future audit insert is added and fails, the status
 *     change must still apply and the route must still return 200.
 *     This test establishes the baseline so any future regression (turning
 *     the audit insert fail-closed) is immediately visible.
 *
 * Run: node --import tsx/esm --test src/test/adminVenueModeration.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminRouter from "../routes/admin.js";

// ── Constants ──────────────────────────────────────────────────────────────────
const ADMIN_USER_ID  = "aaaaaaaa-0000-0000-0001-000000000001";
const NON_ADMIN_ID   = "aaaaaaaa-0000-0000-0001-000000000002";
const VENUE_ID       = "bbbbbbbb-0000-0000-0001-000000000001";
const OTHER_VENUE_ID = "bbbbbbbb-0000-0000-0001-000000000002";

// ── Test server (shared for all tests) ────────────────────────────────────────
let server: http.Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => {
    r.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use(adminRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => server.close());

// ── Request helper ─────────────────────────────────────────────────────────────
function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: url.hostname,
        port:     Number(url.port),
        path:     url.pathname,
        method,
        headers: {
          "content-type":  "application/json",
          "authorization": "Bearer fake-admin-token",
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ── Fake client factory ────────────────────────────────────────────────────────
// opts.auditInsertError: simulate a future audit table insert returning an error.
// The current route has no audit write; this flag is wired so that any insert
// into "venue_moderation_audit" (a hypothetical future table) fails.  The test
// confirms the route still returns 200 with the updated venue.

function makeVenueModerationClient(opts: {
  actorUserId?:     string;
  actorRole?:       string;
  venueStatus?:     string;   // status of the seeded venue (default: "provisional")
  auditInsertError?: boolean; // simulate a future audit insert failure
} = {}) {
  const {
    actorUserId    = ADMIN_USER_ID,
    actorRole      = "admin",
    venueStatus    = "provisional",
    auditInsertError = false,
  } = opts;

  const db: Record<string, any[]> = {
    profiles: [
      { id: actorUserId, role: actorRole },
    ],
    discovery_places: [
      {
        id:     VENUE_ID,
        name:   "Test Venue",
        status: venueStatus,
      },
      {
        id:     OTHER_VENUE_ID,
        name:   "Other Venue",
        status: "verified", // not provisional — should never be touched
      },
    ],
    // Hypothetical future audit table — not used by the current route.
    // Seeded here so that if the route is extended with an audit write, the
    // auditInsertError flag immediately exercises the fail-open path.
    venue_moderation_audit: [],
  };

  function chain(tableName: string, rows: any[]) {
    let filtered = rows;
    let pendingUpdate: Record<string, any> | null = null;

    const b: any = {
      select: () => b,
      insert: (data: any) => {
        const newRows = Array.isArray(data) ? data : [data];
        if (tableName === "venue_moderation_audit" && auditInsertError) {
          // Fail-open simulation: the insert was attempted but the DB returned an error.
          return {
            then: (resolve: any) =>
              Promise.resolve({ data: null, error: { message: "venue_moderation_audit insert failed" } }).then(resolve),
          };
        }
        db[tableName] = [...(db[tableName] ?? []), ...newRows];
        filtered = newRows;
        return b;
      },
      update: (data: Record<string, any>) => { pendingUpdate = data; return b; },
      eq: (col: string, val: any) => {
        filtered = filtered.filter((r: any) => r[col] === val);
        if (pendingUpdate !== null) {
          // also narrow the update target
        }
        return b;
      },
      order:       () => b,
      limit:       () => b,
      maybeSingle: () => {
        if (pendingUpdate !== null) {
          for (const row of filtered) Object.assign(row, pendingUpdate);
          pendingUpdate = null;
        }
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      single: () => Promise.resolve(
        filtered[0]
          ? { data: filtered[0], error: null }
          : { data: null, error: { message: "No rows" } },
      ),
      then: (resolve: any, reject: any) => {
        if (pendingUpdate !== null) {
          for (const row of filtered) Object.assign(row, pendingUpdate);
          pendingUpdate = null;
        }
        return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
      },
    };
    return b;
  }

  return {
    from: (tableName: string) => chain(tableName, [...(db[tableName] ?? [])]),
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: actorUserId } }, error: null }),
    },
    _db: db,
  };
}

function setClient(client: ReturnType<typeof makeVenueModerationClient>) {
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
}

// ── Success path: approve ──────────────────────────────────────────────────────

describe("POST /admin/venues/:id/moderate — approve", () => {
  it("returns 200 with venue.status === 'verified' when approving a provisional venue", async () => {
    const client = makeVenueModerationClient();
    setClient(client);

    const { status, body } = await req(
      "POST",
      `/admin/venues/${VENUE_ID}/moderate`,
      { action: "approve" },
    );

    assert.equal(
      status, 200,
      `Expected 200 for approve, got ${status}: ${JSON.stringify(body)}`,
    );
    assert.ok(body.venue, "response must include a venue object");
    assert.equal(body.venue.id,     VENUE_ID,    "venue.id must match");
    assert.equal(body.venue.status, "verified",  "approve must set status to verified");

    // The DB row itself must also be updated (not just the response payload).
    const dbRow = client._db.discovery_places.find((r: any) => r.id === VENUE_ID);
    assert.equal(dbRow?.status, "verified", "discovery_places row must be updated to verified");

    // The response must reflect the post-update DB row — not a stale pre-update snapshot.
    assert.equal(
      body.venue.status,
      dbRow?.status,
      "body.venue.status must match the DB row status — response must not be a stale pre-update snapshot",
    );

    // The other (non-provisional) venue must be untouched.
    const otherRow = client._db.discovery_places.find((r: any) => r.id === OTHER_VENUE_ID);
    assert.equal(otherRow?.status, "verified", "other venue status must be unchanged");
  });
});

// ── Success path: reject ───────────────────────────────────────────────────────

describe("POST /admin/venues/:id/moderate — reject", () => {
  it("returns 200 with venue.status === 'blocked' when rejecting a provisional venue", async () => {
    const client = makeVenueModerationClient();
    setClient(client);

    const { status, body } = await req(
      "POST",
      `/admin/venues/${VENUE_ID}/moderate`,
      { action: "reject", reason: "Duplicate listing" },
    );

    assert.equal(
      status, 200,
      `Expected 200 for reject, got ${status}: ${JSON.stringify(body)}`,
    );
    assert.ok(body.venue, "response must include a venue object");
    assert.equal(body.venue.id,     VENUE_ID,  "venue.id must match");
    assert.equal(body.venue.status, "blocked", "reject must set status to blocked");

    // DB row must reflect the change.
    const dbRow = client._db.discovery_places.find((r: any) => r.id === VENUE_ID);
    assert.equal(dbRow?.status, "blocked", "discovery_places row must be updated to blocked");

    // The response must reflect the post-update DB row — not a stale pre-update snapshot.
    assert.equal(
      body.venue.status,
      dbRow?.status,
      "body.venue.status must match the DB row status — response must not be a stale pre-update snapshot",
    );
  });
});

// ── Not-found: non-provisional venue ──────────────────────────────────────────

describe("POST /admin/venues/:id/moderate — not-found guard", () => {
  it("returns 404 when the venue is not in provisional status", async () => {
    // Seed the target venue as already verified (not provisional).
    const client = makeVenueModerationClient({ venueStatus: "verified" });
    setClient(client);

    const { status, body } = await req(
      "POST",
      `/admin/venues/${VENUE_ID}/moderate`,
      { action: "approve" },
    );

    assert.equal(status, 404, `Expected 404 for non-provisional venue, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.error, "not_found");
  });
});

// ── Already-moderated venues are rejected ─────────────────────────────────────
//
// The route guards with .eq("status", "provisional"), so venues that have
// already been moderated (blocked or verified) must return 404 not_found.
// These tests pin the two concrete non-provisional states so a future change
// to the filter cannot silently allow double-moderation.

describe("POST /admin/venues/:id/moderate — already-moderated venues", () => {
  it("returns 404 not_found when the venue is already 'blocked' and action is approve", async () => {
    const client = makeVenueModerationClient({ venueStatus: "blocked" });
    setClient(client);

    const { status, body } = await req(
      "POST",
      `/admin/venues/${VENUE_ID}/moderate`,
      { action: "approve" },
    );

    assert.equal(
      status, 404,
      `Expected 404 for an already-blocked venue, got ${status}: ${JSON.stringify(body)}`,
    );
    assert.equal(body.error, "not_found", "error code must be not_found");

    // The venue status must not have changed.
    const dbRow = client._db.discovery_places.find((r: any) => r.id === VENUE_ID);
    assert.equal(dbRow?.status, "blocked", "blocked venue status must not be mutated");
  });

  it("returns 404 not_found when the venue is already 'verified' and action is reject", async () => {
    const client = makeVenueModerationClient({ venueStatus: "verified" });
    setClient(client);

    const { status, body } = await req(
      "POST",
      `/admin/venues/${VENUE_ID}/moderate`,
      { action: "reject", reason: "Duplicate listing" },
    );

    assert.equal(
      status, 404,
      `Expected 404 for an already-verified venue, got ${status}: ${JSON.stringify(body)}`,
    );
    assert.equal(body.error, "not_found", "error code must be not_found");

    // The venue status must not have changed.
    const dbRow = client._db.discovery_places.find((r: any) => r.id === VENUE_ID);
    assert.equal(dbRow?.status, "verified", "verified venue status must not be mutated");
  });
});

// ── Access control ─────────────────────────────────────────────────────────────

describe("POST /admin/venues/:id/moderate — access control", () => {
  it("non-admin user gets 403", async () => {
    const client = makeVenueModerationClient({ actorUserId: NON_ADMIN_ID, actorRole: "user" });
    setClient(client);

    const { status, body } = await req(
      "POST",
      `/admin/venues/${VENUE_ID}/moderate`,
      { action: "approve" },
    );

    assert.equal(status, 403);
    assert.equal(body.error, "forbidden");
  });

  it("unknown action returns 400 with invalid_payload", async () => {
    const client = makeVenueModerationClient();
    setClient(client);

    const { status, body } = await req(
      "POST",
      `/admin/venues/${VENUE_ID}/moderate`,
      { action: "nuke_venue" },
    );

    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });

  it("non-UUID venue id returns 404 not_found before any DB query", async () => {
    const client = makeVenueModerationClient();
    setClient(client);

    const { status, body } = await req(
      "POST",
      "/admin/venues/not-a-uuid/moderate",
      { action: "approve" },
    );

    assert.equal(status, 404, `Expected 404 for non-UUID id, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.error, "not_found");
  });
});

// ── Missing / malformed venue ID segment ──────────────────────────────────────
//
// These tests pin the routing invariant: an empty or non-UUID :id segment must
// never fall through to an unrelated admin endpoint or reach the DB.
// Both cases must return 404 not_found immediately.

describe("POST /admin/venues/:id/moderate — missing or malformed venue ID", () => {
  it("returns 404 when the venue ID segment is empty (/admin/venues//moderate)", async () => {
    // Express does not match :id for an empty path segment, so the request falls
    // through without matching the moderation route.  The server must return 404
    // rather than routing to a different admin handler.
    const client = makeVenueModerationClient();
    setClient(client);

    const { status } = await req(
      "POST",
      "/admin/venues//moderate",
      { action: "approve" },
    );

    assert.equal(status, 404, `Expected 404 for empty venue ID segment, got ${status}`);
  });

  it("returns 404 not_found for a non-UUID venue ID — no discovery_places query fired", async () => {
    // The UUID guard in the route handler must short-circuit before any query
    // against discovery_places.  requireAdmin legitimately queries profiles for
    // the role check, so we track per-table calls rather than total calls.
    const queriedTables: string[] = [];
    const baseClient = makeVenueModerationClient();
    const spyClient = {
      ...baseClient,
      from: (table: string) => { queriedTables.push(table); return baseClient.from(table); },
    };
    _setTestClient(spyClient as any, true);
    _setTestServiceClient(spyClient as any);

    const { status, body } = await req(
      "POST",
      "/admin/venues/not-a-uuid/moderate",
      { action: "approve" },
    );

    assert.equal(status, 404, `Expected 404 for non-UUID venue ID, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.error, "not_found", "error code must be not_found");
    assert.ok(
      !queriedTables.includes("discovery_places"),
      `discovery_places must not be queried for a non-UUID venue ID — queried: ${JSON.stringify(queriedTables)}`,
    );
  });
});

// ── PATCH /admin/venues/:id/status — UUID guard ────────────────────────────────

describe("PATCH /admin/venues/:id/status — UUID guard", () => {
  it("non-UUID venue id returns 404 not_found before any DB query", async () => {
    const client = makeVenueModerationClient();
    setClient(client);

    const { status, body } = await req(
      "PATCH",
      "/admin/venues/not-a-uuid/status",
      { status: "removed" },
    );

    assert.equal(status, 404, `Expected 404 for non-UUID id, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.error, "not_found");
  });
});

// ── Fail-open: hypothetical audit insert failure ───────────────────────────────
//
// The current route has no audit write.  This test documents the expected
// contract: if a future change adds an insert into a secondary audit table,
// that insert MUST be fail-open — a DB failure there must NOT prevent the
// status change from applying or the 200 from being returned.
//
// The fake client is wired to fail any insert into "venue_moderation_audit".
// Because the route does not currently call that table the test trivially
// passes now; its purpose is to make a future fail-closed regression
// immediately visible.

describe("POST /admin/venues/:id/moderate — fail-open baseline for future audit inserts", () => {
  it("status change applies and 200 is returned even when a hypothetical audit insert fails", async () => {
    const client = makeVenueModerationClient({ auditInsertError: true });
    setClient(client);

    const { status, body } = await req(
      "POST",
      `/admin/venues/${VENUE_ID}/moderate`,
      { action: "approve", reason: "fail-open audit test" },
    );

    // The primary status change must still succeed.
    assert.equal(
      status, 200,
      `A failing audit insert must not surface as a non-200 response — got ${status}: ${JSON.stringify(body)}`,
    );
    assert.ok(body.venue, "response must include venue even when audit fails");
    assert.equal(body.venue.status, "verified", "status must be updated to verified despite audit failure");

    // The DB row must reflect the change.
    const dbRow = client._db.discovery_places.find((r: any) => r.id === VENUE_ID);
    assert.equal(
      dbRow?.status, "verified",
      "discovery_places row must be updated even when the audit insert fails",
    );
  });
});
