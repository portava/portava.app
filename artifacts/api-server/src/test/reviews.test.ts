/**
 * Reviews — backend route tests
 *
 * Tests cover:
 * - GET  /api/reviews/my-review: exists:false before review, exists:true after
 * - GET  /api/reviews/my-review: scoped to authenticated user (other user's review doesn't affect it)
 * - POST /api/reviews: blocked without confirmed attendance (trip not completed)
 * - POST /api/reviews: allowed when user is a completed trip member
 * - POST /api/reviews: duplicate blocked — second submission returns duplicate_review (23505)
 * - POST /api/reviews: trust event fires (review_submitted), no direct score write
 * - GET  /api/trips/:id/reviews: returns published reviews with aggregate
 * - DELETE /api/reviews/:id: author can retract (state → hidden), admin removes (state → removed)
 * - POST /api/reviews/:id/report: 404 when review is hidden or removed
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

type Row = Record<string, any>;
interface FakeTable {
  rows: Row[];
  nextInsertError?: { code?: string; message: string };
}

const REVIEWER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER_ID    = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ADMIN_ID    = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const TRIP_ID     = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const REVIEW_ID   = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

function makeFakeClient(tables: Record<string, FakeTable> = {}) {
  const insertLog: Array<{ table: string; row: Row }> = [];

  const db: Record<string, FakeTable> = {
    reviews:             tables.reviews             ?? { rows: [] },
    trips:               tables.trips               ?? { rows: [] },
    trip_members:        tables.trip_members        ?? { rows: [] },
    profiles:            tables.profiles            ?? { rows: [] },
    trust_events:        tables.trust_events        ?? { rows: [] },
    trust_profiles:      tables.trust_profiles      ?? { rows: [] },
    trust_settings:      tables.trust_settings      ?? { rows: [] },
    trust_caps:          tables.trust_caps          ?? { rows: [] },
    rent_buddy_bookings: tables.rent_buddy_bookings ?? { rows: [] },
    notifications:       tables.notifications       ?? { rows: [] },
    reports:             tables.reports             ?? { rows: [] },
    feature_flags:       tables.feature_flags       ?? { rows: [] },
    ...tables,
  };

  let idCounter = 0;
  function newId() {
    const n = String(++idCounter).padStart(8, "0");
    return `${n}-0000-0000-0000-000000000000`;
  }

  function chain(tableName: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let _insert: Row | Row[] | null = null;
    let _update: Row | null = null;
    let _delete = false;
    let _limitN: number | null = null;
    let _rangeFrom: number | null = null;
    let _rangeTo: number | null = null;
    let _orderCol: string | null = null;
    let _orderAsc = true;
    let _single = false;
    let _maybeSingle = false;

    const obj: any = {
      select()         { return obj; },
      insert(data: Row | Row[]) { _insert = data; return obj; },
      update(patch: Row) { _update = patch; return obj; },
      delete()         { _delete = true; return obj; },
      eq(col: string, val: any) {
        filters.push((r) => r[col] === val);
        return obj;
      },
      neq(col: string, val: any) {
        filters.push((r) => r[col] !== val);
        return obj;
      },
      not(col: string, op: string, val: any) {
        if (op === "is") filters.push((r) => r[col] !== val);
        if (op === "in") {
          // val is like '("removed","hidden")' — strip parens, split, unquote
          const items = String(val)
            .replace(/^\(|\)$/g, "")
            .split(",")
            .map((s) => s.trim().replace(/^"|"$/g, ""));
          filters.push((r) => !items.includes(r[col]));
        }
        return obj;
      },
      in(col: string, vals: any[]) {
        filters.push((r) => vals.includes(r[col]));
        return obj;
      },
      or() { return obj; },
      gte(col: string, val: any) { filters.push((r) => r[col] >= val); return obj; },
      gt(col: string, val: any)  { filters.push((r) => r[col] > val);  return obj; },
      lt(col: string, val: any)  { filters.push((r) => r[col] < val);  return obj; },
      limit(n: number)           { _limitN = n; return obj; },
      range(from: number, to: number) {
        _rangeFrom = from;
        _rangeTo   = to;
        return obj;
      },
      order(col: string, opts?: any) {
        _orderCol = col;
        _orderAsc = opts?.ascending !== false;
        return obj;
      },
      maybeSingle() { _maybeSingle = true; return resolve(); },
      single()      { _single      = true; return resolve(); },
      then(onF: any, onR: any) { return resolve().then(onF, onR); },
    };

    function getTable(): FakeTable {
      if (!db[tableName]) db[tableName] = { rows: [] };
      return db[tableName];
    }

    function filteredRows(): Row[] {
      return getTable().rows.filter((r) => filters.every((f) => f(r)));
    }

    async function resolve(): Promise<{ data: any; error: any }> {
      const table = getTable();

      if (_delete) {
        table.rows = table.rows.filter((r) => !filters.every((f) => f(r)));
        return { data: null, error: null };
      }

      if (_insert !== null) {
        if (table.nextInsertError) {
          const err = table.nextInsertError;
          delete table.nextInsertError;
          return { data: null, error: err };
        }
        const rows = Array.isArray(_insert) ? _insert : [_insert];
        const inserted: Row[] = [];
        for (const row of rows) {
          const newRow = {
            id: newId(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...row,
          };
          table.rows.push(newRow);
          inserted.push(newRow);
          insertLog.push({ table: tableName, row: newRow });
        }
        const result = _single || _maybeSingle ? (inserted[0] ?? null) : inserted;
        return { data: result, error: null };
      }

      if (_update !== null) {
        const matched = filteredRows();
        for (const r of matched) Object.assign(r, _update);
        const result = _single || _maybeSingle ? (matched[0] ?? null) : matched;
        return { data: result, error: null };
      }

      // SELECT
      let rows = filteredRows();
      if (_orderCol) {
        rows = [...rows].sort((a, b) => {
          if (a[_orderCol!] < b[_orderCol!]) return _orderAsc ? -1 : 1;
          if (a[_orderCol!] > b[_orderCol!]) return _orderAsc ? 1 : -1;
          return 0;
        });
      }
      if (_rangeFrom !== null && _rangeTo !== null) rows = rows.slice(_rangeFrom, _rangeTo + 1);
      else if (_limitN !== null) rows = rows.slice(0, _limitN);
      if (_single)      return { data: rows[0] ?? null, error: null };
      if (_maybeSingle) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    }

    return obj;
  }

  const client: any = {
    from(table: string) { return chain(table); },
    auth: {
      getUser: async (token: string) => {
        if (token === "reviewer-token") return { data: { user: { id: REVIEWER_ID } }, error: null };
        if (token === "other-token")    return { data: { user: { id: OTHER_ID } }, error: null };
        if (token === "admin-token")    return { data: { user: { id: ADMIN_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
    _insertLog: insertLog,
  };
  return client;
}

function startServer(tables: Record<string, FakeTable> = {}): Promise<{
  url: string; close: () => Promise<void>; client: any;
}> {
  const client = makeFakeClient(tables);
  _setTestClient(client, true);
  return new Promise((resolve, reject) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        url: `http://127.0.0.1:${port}`,
        client,
        close: () => new Promise<void>((res, rej) => {
          srv.closeAllConnections?.();
          srv.close((e) => (e ? rej(e) : res()));
        }),
      });
    });
    srv.on("error", reject);
  });
}

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function fetchGet(url: string, path: string, token: string) {
  const res = await fetch(`${url}${path}`, { headers: authHeader(token) });
  return { status: res.status, body: await res.json() };
}

async function fetchPost(url: string, path: string, token: string, body: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: authHeader(token),
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function fetchDelete(url: string, path: string, token: string) {
  const res = await fetch(`${url}${path}`, {
    method: "DELETE",
    headers: authHeader(token),
  });
  return { status: res.status, body: await res.json() };
}

async function fetchPatch(url: string, path: string, token: string, body: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: "PATCH",
    headers: authHeader(token),
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ── Shared fixture: a completed trip with REVIEWER_ID as a member ─────────────

function completedTripTables(extraReviews: Row[] = []): Record<string, FakeTable> {
  return {
    trips: { rows: [{ id: TRIP_ID, owner_id: REVIEWER_ID, status: "completed" }] },
    trip_members: { rows: [
      { id: "mem-1", trip_id: TRIP_ID, user_id: REVIEWER_ID, role: "member" },
    ]},
    reviews: { rows: extraReviews },
    profiles: { rows: [
      { id: REVIEWER_ID, handle: "reviewer", display_name: "Reviewer", role: "user", avatar_url: null },
      { id: OTHER_ID,    handle: "other",    display_name: "Other",    role: "user", avatar_url: null },
      { id: ADMIN_ID,    handle: "admin",    display_name: "Admin",    role: "admin", avatar_url: null },
    ]},
  };
}

// ── GET /api/reviews/my-review ────────────────────────────────────────────────

describe("GET /api/reviews/my-review", () => {
  let server: { url: string; close: () => Promise<void>; client: any };

  afterEach(async () => { await server?.close(); });

  it("returns exists:false when no review exists for this user + entity", async () => {
    server = await startServer(completedTripTables());
    const { status, body } = await fetchGet(
      server.url,
      `/api/reviews/my-review?entityType=trip&entityId=${TRIP_ID}`,
      "reviewer-token",
    );
    assert.equal(status, 200);
    assert.equal(body.exists, false);
    assert.equal(body.reviewId, null);
  });

  it("returns exists:true after a review has been created", async () => {
    const existingReview = {
      id:          REVIEW_ID,
      reviewer_id: REVIEWER_ID,
      entity_type: "trip",
      entity_id:   TRIP_ID,
      rating:      5,
      state:       "published",
    };
    server = await startServer(completedTripTables([existingReview]));
    const { status, body } = await fetchGet(
      server.url,
      `/api/reviews/my-review?entityType=trip&entityId=${TRIP_ID}`,
      "reviewer-token",
    );
    assert.equal(status, 200);
    assert.equal(body.exists, true);
    assert.equal(body.reviewId, REVIEW_ID);
  });

  it("returns full payload including rating, body, tags, anonymous mapping", async () => {
    const existingReview = {
      id:          REVIEW_ID,
      reviewer_id: REVIEWER_ID,
      entity_type: "trip",
      entity_id:   TRIP_ID,
      rating:      4,
      body:        "Great trip overall",
      tags:        ["friendly", "scenic"],
      visibility:  "anonymous",
      state:       "published",
    };
    server = await startServer(completedTripTables([existingReview]));
    const { status, body } = await fetchGet(
      server.url,
      `/api/reviews/my-review?entityType=trip&entityId=${TRIP_ID}`,
      "reviewer-token",
    );
    assert.equal(status, 200);
    assert.equal(body.exists, true);
    assert.equal(body.reviewId, REVIEW_ID);
    assert.equal(body.rating, 4);
    assert.equal(body.body, "Great trip overall");
    assert.deepEqual(body.tags, ["friendly", "scenic"]);
    assert.equal(body.anonymous, true, "visibility=anonymous should map to anonymous:true");
  });

  it("maps visibility=public to anonymous:false", async () => {
    const existingReview = {
      id:          REVIEW_ID,
      reviewer_id: REVIEWER_ID,
      entity_type: "trip",
      entity_id:   TRIP_ID,
      rating:      3,
      body:        null,
      tags:        [],
      visibility:  "public",
      state:       "published",
    };
    server = await startServer(completedTripTables([existingReview]));
    const { status, body } = await fetchGet(
      server.url,
      `/api/reviews/my-review?entityType=trip&entityId=${TRIP_ID}`,
      "reviewer-token",
    );
    assert.equal(status, 200);
    assert.equal(body.anonymous, false, "visibility=public should map to anonymous:false");
    assert.equal(body.body, null);
    assert.deepEqual(body.tags, []);
  });

  it("is scoped to the authenticated user — other user's review does not affect the check", async () => {
    // OTHER_ID has a review; REVIEWER_ID does not
    const otherReview = {
      id:          "other-review-id",
      reviewer_id: OTHER_ID,
      entity_type: "trip",
      entity_id:   TRIP_ID,
      rating:      3,
      state:       "published",
    };
    server = await startServer(completedTripTables([otherReview]));

    const { status: statusA, body: bodyA } = await fetchGet(
      server.url,
      `/api/reviews/my-review?entityType=trip&entityId=${TRIP_ID}`,
      "reviewer-token",      // REVIEWER_ID — has no review
    );
    assert.equal(statusA, 200);
    assert.equal(bodyA.exists, false, "REVIEWER_ID should see exists:false — only OTHER_ID reviewed");

    const { status: statusB, body: bodyB } = await fetchGet(
      server.url,
      `/api/reviews/my-review?entityType=trip&entityId=${TRIP_ID}`,
      "other-token",         // OTHER_ID — has a review
    );
    assert.equal(statusB, 200);
    assert.equal(bodyB.exists, true, "OTHER_ID should see exists:true");
    assert.equal(bodyB.reviewId, "other-review-id");
  });

  it("excludes reviews with state=removed from the exists check", async () => {
    const removedReview = {
      id:          REVIEW_ID,
      reviewer_id: REVIEWER_ID,
      entity_type: "trip",
      entity_id:   TRIP_ID,
      rating:      4,
      state:       "removed",  // should be excluded
    };
    server = await startServer(completedTripTables([removedReview]));
    const { status, body } = await fetchGet(
      server.url,
      `/api/reviews/my-review?entityType=trip&entityId=${TRIP_ID}`,
      "reviewer-token",
    );
    assert.equal(status, 200);
    assert.equal(body.exists, false, "removed review should not count as existing");
  });

  it("excludes reviews with state=hidden from the exists check", async () => {
    const hiddenReview = {
      id:          REVIEW_ID,
      reviewer_id: REVIEWER_ID,
      entity_type: "trip",
      entity_id:   TRIP_ID,
      rating:      4,
      state:       "hidden",   // author-retracted — should be excluded
    };
    server = await startServer(completedTripTables([hiddenReview]));
    const { status, body } = await fetchGet(
      server.url,
      `/api/reviews/my-review?entityType=trip&entityId=${TRIP_ID}`,
      "reviewer-token",
    );
    assert.equal(status, 200);
    assert.equal(body.exists, false, "hidden review should not count as existing");
    assert.equal(body.reviewId, null);
  });

  it("400 invalid_payload when entityId is missing", async () => {
    server = await startServer();
    const { status, body } = await fetchGet(
      server.url,
      "/api/reviews/my-review?entityType=trip",
      "reviewer-token",
    );
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });

  it("401 when unauthenticated", async () => {
    server = await startServer();
    const { status } = await fetchGet(
      server.url,
      `/api/reviews/my-review?entityType=trip&entityId=${TRIP_ID}`,
      "bad-token",
    );
    assert.equal(status, 401);
  });
});

// ── POST /api/reviews ─────────────────────────────────────────────────────────

describe("POST /api/reviews", () => {
  let server: { url: string; close: () => Promise<void>; client: any };

  afterEach(async () => { await server?.close(); });

  it("403 review_not_eligible when trip is not completed", async () => {
    // Trip exists but status is NOT 'completed'
    server = await startServer({
      trips: { rows: [{ id: TRIP_ID, owner_id: REVIEWER_ID, status: "active" }] },
      trip_members: { rows: [{ id: "mem-1", trip_id: TRIP_ID, user_id: REVIEWER_ID }] },
    });
    const { status, body } = await fetchPost(server.url, "/api/reviews", "reviewer-token", {
      entityType: "trip",
      entityId: TRIP_ID,
      rating: 4,
    });
    assert.equal(status, 403);
    assert.equal(body.error, "review_not_eligible");
  });

  it("403 review_not_eligible when user is not a trip member", async () => {
    // Trip is completed but REVIEWER_ID is not in trip_members
    server = await startServer({
      trips: { rows: [{ id: TRIP_ID, owner_id: OTHER_ID, status: "completed" }] },
      trip_members: { rows: [] },
    });
    const { status, body } = await fetchPost(server.url, "/api/reviews", "reviewer-token", {
      entityType: "trip",
      entityId: TRIP_ID,
      rating: 4,
    });
    assert.equal(status, 403);
    assert.equal(body.error, "review_not_eligible");
  });

  it("201 review created for completed trip member", async () => {
    server = await startServer(completedTripTables());
    const { status, body } = await fetchPost(server.url, "/api/reviews", "reviewer-token", {
      entityType: "trip",
      entityId:   TRIP_ID,
      rating:     5,
      body:       "Fantastic trip, would go again.",
      tags:       ["friendly", "well_planned"],
    });
    assert.equal(status, 201);
    assert.ok(body.id);
    assert.equal(body.rating, 5);
    assert.deepEqual(body.tags, ["friendly", "well_planned"]);
    assert.equal(body.anonymous, false);
  });

  it("409 duplicate_review when second review hits unique constraint (23505)", async () => {
    const tables = completedTripTables();
    server = await startServer(tables);

    // First review succeeds
    const first = await fetchPost(server.url, "/api/reviews", "reviewer-token", {
      entityType: "trip",
      entityId:   TRIP_ID,
      rating:     4,
    });
    assert.equal(first.status, 201, "first review should succeed");

    // Simulate DB unique constraint on the second attempt
    tables.reviews.nextInsertError = { code: "23505", message: "unique violation" };
    const second = await fetchPost(server.url, "/api/reviews", "reviewer-token", {
      entityType: "trip",
      entityId:   TRIP_ID,
      rating:     5,
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.error, "duplicate_review");
  });

  it("trust event review_submitted is recorded, no direct trust_profiles write", async () => {
    const tables = {
      ...completedTripTables(),
      // Trust engine requires this flag to be on; without it recordTrustEvent is a no-op.
      // The feature_flags table uses "flag" as the column name, not "key".
      feature_flags: { rows: [{ flag: "trust_engine_enabled", enabled: true }] },
    };
    server = await startServer(tables);
    await fetchPost(server.url, "/api/reviews", "reviewer-token", {
      entityType: "trip",
      entityId:   TRIP_ID,
      rating:     4,
    });
    const log = server.client._insertLog;
    const trustEvent = log.find(
      (e: any) => e.table === "trust_events" && e.row.event_type === "review_submitted",
    );
    assert.ok(trustEvent, "review_submitted trust event should be recorded");
    assert.equal(trustEvent.row.category, "community_value");
    const directScoreWrite = log.find(
      (e: any) => e.table === "trust_profiles" && e.row.overall_score !== undefined,
    );
    assert.equal(directScoreWrite, undefined, "trust_profiles should NOT be written directly");
  });

  it("400 invalid_payload for missing required fields", async () => {
    server = await startServer();
    const { status, body } = await fetchPost(server.url, "/api/reviews", "reviewer-token", {
      entityType: "trip",
      // entityId missing
      rating: 4,
    });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });
});

// ── GET /api/trips/:id/reviews ────────────────────────────────────────────────

describe("GET /api/trips/:id/reviews", () => {
  let server: { url: string; close: () => Promise<void>; client: any };

  afterEach(async () => { await server?.close(); });

  it("returns published reviews with aggregate stats", async () => {
    const reviews: Row[] = [
      { id: "rev-1", reviewer_id: REVIEWER_ID, entity_type: "trip", entity_id: TRIP_ID, rating: 5, body: "Great!", tags: [], visibility: "public", state: "published", created_at: "2026-01-02T00:00:00Z" },
      { id: "rev-2", reviewer_id: OTHER_ID,    entity_type: "trip", entity_id: TRIP_ID, rating: 3, body: "Ok.",   tags: [], visibility: "public", state: "published", created_at: "2026-01-01T00:00:00Z" },
      { id: "rev-3", reviewer_id: ADMIN_ID,    entity_type: "trip", entity_id: TRIP_ID, rating: 4, body: "Good.", tags: [], visibility: "public", state: "removed",   created_at: "2026-01-03T00:00:00Z" },
    ];
    server = await startServer({ ...completedTripTables(reviews) });
    const { status, body } = await fetchGet(server.url, `/api/trips/${TRIP_ID}/reviews`, "reviewer-token");
    assert.equal(status, 200);
    assert.equal(body.reviews.length, 2, "removed review should be excluded");
    assert.equal(body.total, 2);
    assert.equal(body.avgRating, 4.0);
    assert.equal(body.page, 1);
  });
});

// ── DELETE /api/reviews/:id ───────────────────────────────────────────────────

describe("DELETE /api/reviews/:id", () => {
  let server: { url: string; close: () => Promise<void>; client: any };

  afterEach(async () => { await server?.close(); });

  it("author can retract their own review (state → hidden)", async () => {
    const tables = completedTripTables([{
      id: REVIEW_ID, reviewer_id: REVIEWER_ID, entity_type: "trip", entity_id: TRIP_ID,
      rating: 4, body: null, tags: [], visibility: "public", state: "published",
    }]);
    server = await startServer(tables);
    const { status, body } = await fetchDelete(server.url, `/api/reviews/${REVIEW_ID}`, "reviewer-token");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.state, "hidden");
  });

  it("admin can remove any review (state → removed)", async () => {
    const tables = completedTripTables([{
      id: REVIEW_ID, reviewer_id: OTHER_ID, entity_type: "trip", entity_id: TRIP_ID,
      rating: 4, body: null, tags: [], visibility: "public", state: "published",
    }]);
    server = await startServer(tables);
    const { status, body } = await fetchDelete(server.url, `/api/reviews/${REVIEW_ID}`, "admin-token");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.state, "removed");
  });

  it("403 when non-author non-admin tries to delete", async () => {
    const tables = completedTripTables([{
      id: REVIEW_ID, reviewer_id: REVIEWER_ID, entity_type: "trip", entity_id: TRIP_ID,
      rating: 4, body: null, tags: [], visibility: "public", state: "published",
    }]);
    server = await startServer(tables);
    // OTHER_ID is not the author and not admin
    const { status } = await fetchDelete(server.url, `/api/reviews/${REVIEW_ID}`, "other-token");
    assert.equal(status, 403);
  });
});

// ── PATCH /api/reviews/:id ────────────────────────────────────────────────────

describe("PATCH /api/reviews/:id", () => {
  let server: { url: string; close: () => Promise<void>; client: any };

  afterEach(async () => { await server?.close(); });

  it("200 succeeds and reflects changed fields in response", async () => {
    const tables = completedTripTables([{
      id:          REVIEW_ID,
      reviewer_id: REVIEWER_ID,
      entity_type: "trip",
      entity_id:   TRIP_ID,
      rating:      3,
      body:        "Original body",
      tags:        ["old_tag"],
      visibility:  "public",
      state:       "published",
    }]);
    server = await startServer(tables);
    const { status, body } = await fetchPatch(
      server.url,
      `/api/reviews/${REVIEW_ID}`,
      "reviewer-token",
      { rating: 5, body: "Updated body", tags: ["new_tag"], anonymous: true },
    );
    assert.equal(status, 200);
    assert.equal(body.id, REVIEW_ID);
    assert.equal(body.rating, 5);
    assert.equal(body.body, "Updated body");
    assert.deepEqual(body.tags, ["new_tag"]);
    assert.equal(body.anonymous, true, "anonymous:true → visibility=anonymous round-trip");
  });

  it("200 partial update — only supplied fields change", async () => {
    const tables = completedTripTables([{
      id:          REVIEW_ID,
      reviewer_id: REVIEWER_ID,
      entity_type: "trip",
      entity_id:   TRIP_ID,
      rating:      3,
      body:        "Stay the same",
      tags:        ["keep"],
      visibility:  "public",
      state:       "published",
    }]);
    server = await startServer(tables);
    const { status, body } = await fetchPatch(
      server.url,
      `/api/reviews/${REVIEW_ID}`,
      "reviewer-token",
      { rating: 4 },      // only rating changes
    );
    assert.equal(status, 200);
    assert.equal(body.rating, 4);
    assert.equal(body.anonymous, false, "visibility unchanged, should still be public→false");
  });

  it("403 when a different user tries to edit the review", async () => {
    const tables = completedTripTables([{
      id:          REVIEW_ID,
      reviewer_id: REVIEWER_ID,   // REVIEWER_ID is the owner
      entity_type: "trip",
      entity_id:   TRIP_ID,
      rating:      4,
      body:        null,
      tags:        [],
      visibility:  "public",
      state:       "published",
    }]);
    server = await startServer(tables);
    // OTHER_ID is NOT the author
    const { status, body } = await fetchPatch(
      server.url,
      `/api/reviews/${REVIEW_ID}`,
      "other-token",
      { rating: 1 },
    );
    assert.equal(status, 403);
    assert.equal(body.error, "forbidden");
  });

  it("404 when the review state is 'removed'", async () => {
    const tables = completedTripTables([{
      id:          REVIEW_ID,
      reviewer_id: REVIEWER_ID,
      entity_type: "trip",
      entity_id:   TRIP_ID,
      rating:      4,
      body:        null,
      tags:        [],
      visibility:  "public",
      state:       "removed",    // admin-removed — should be invisible to author
    }]);
    server = await startServer(tables);
    const { status, body } = await fetchPatch(
      server.url,
      `/api/reviews/${REVIEW_ID}`,
      "reviewer-token",
      { rating: 5 },
    );
    assert.equal(status, 404);
    assert.equal(body.error, "not_found");
  });

  it("404 when the review state is 'hidden'", async () => {
    const tables = completedTripTables([{
      id:          REVIEW_ID,
      reviewer_id: REVIEWER_ID,
      entity_type: "trip",
      entity_id:   TRIP_ID,
      rating:      4,
      body:        null,
      tags:        [],
      visibility:  "public",
      state:       "hidden",     // author-retracted — should block further edits
    }]);
    server = await startServer(tables);
    const { status, body } = await fetchPatch(
      server.url,
      `/api/reviews/${REVIEW_ID}`,
      "reviewer-token",
      { rating: 5 },
    );
    assert.equal(status, 404);
    assert.equal(body.error, "not_found");
  });

  it("400 invalid_payload when rating is out of range", async () => {
    server = await startServer(completedTripTables());
    const { status, body } = await fetchPatch(
      server.url,
      `/api/reviews/${REVIEW_ID}`,
      "reviewer-token",
      { rating: 10 },   // max is 5
    );
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });

  it("401 when unauthenticated", async () => {
    server = await startServer(completedTripTables());
    const { status } = await fetchPatch(
      server.url,
      `/api/reviews/${REVIEW_ID}`,
      "bad-token",
      { rating: 3 },
    );
    assert.equal(status, 401);
  });
});

// ── avgRating lifecycle — create then refetch ─────────────────────────────────
// Verifies GET /api/trips/:id/reviews returns an up-to-date avgRating immediately
// after a review is created. Both calls share the same in-memory fake-client state,
// so the POST insert is visible to the subsequent GET — exactly mirroring the
// focus-based refetch that ReviewsSection performs on screen re-entry.

describe("avgRating lifecycle — create then refetch", () => {
  let server: { url: string; close: () => Promise<void>; client: any };

  afterEach(async () => { await server?.close(); });

  it("avgRating is null and total is 0 when no reviews exist", async () => {
    server = await startServer(completedTripTables());
    const { status, body } = await fetchGet(
      server.url,
      `/api/trips/${TRIP_ID}/reviews`,
      "reviewer-token",
    );
    assert.equal(status, 200);
    assert.equal(body.avgRating, null);
    assert.equal(body.total, 0);
    assert.deepEqual(body.reviews, []);
  });

  it("avgRating equals the first review's rating after POST then GET (0→1 edge case)", async () => {
    server = await startServer(completedTripTables());

    // Submit the first review — no prior reviews, so this is the 0→1 transition
    const postRes = await fetchPost(server.url, "/api/reviews", "reviewer-token", {
      entityType: "trip",
      entityId:   TRIP_ID,
      rating:     4,
      body:       "First review ever",
    });
    assert.equal(postRes.status, 201, "first review should be created");

    // Refetch the trip reviews — avgRating should now equal the single submitted rating
    const { status, body } = await fetchGet(
      server.url,
      `/api/trips/${TRIP_ID}/reviews`,
      "reviewer-token",
    );
    assert.equal(status, 200);
    assert.equal(body.total, 1);
    assert.equal(body.avgRating, 4.0, "avgRating should equal the single submitted rating");
    assert.equal(body.reviews.length, 1);
    assert.equal(body.reviews[0].rating, 4);
  });

  it("avgRating is the rounded mean after a second review is added", async () => {
    // Seed one existing published review (rating 3)
    const existingReviews: Row[] = [
      {
        id:          "rev-x1",
        reviewer_id: OTHER_ID,
        entity_type: "trip",
        entity_id:   TRIP_ID,
        rating:      3,
        body:        null,
        tags:        [],
        visibility:  "public",
        state:       "published",
        created_at:  "2026-01-01T00:00:00Z",
      },
    ];
    server = await startServer(completedTripTables(existingReviews));

    // POST a second review by REVIEWER_ID (rating 5)
    const postRes = await fetchPost(server.url, "/api/reviews", "reviewer-token", {
      entityType: "trip",
      entityId:   TRIP_ID,
      rating:     5,
    });
    assert.equal(postRes.status, 201, "second review should be created");

    // Refetch: 2 reviews, ratings [3, 5] → mean 4.0
    const { status, body } = await fetchGet(
      server.url,
      `/api/trips/${TRIP_ID}/reviews`,
      "reviewer-token",
    );
    assert.equal(status, 200);
    assert.equal(body.total, 2);
    assert.equal(body.avgRating, 4.0, "avgRating should be the mean of both ratings");
  });

  it("avgRating uses only published reviews — excludes removed and hidden", async () => {
    // One published review (rating 5) + one removed (rating 1) + one hidden (rating 1)
    // Only the published rating should contribute to the average
    const reviews: Row[] = [
      {
        id:          "rev-pub",
        reviewer_id: OTHER_ID,
        entity_type: "trip",
        entity_id:   TRIP_ID,
        rating:      5,
        body:        null,
        tags:        [],
        visibility:  "public",
        state:       "published",
        created_at:  "2026-01-01T00:00:00Z",
      },
      {
        id:          "rev-removed",
        reviewer_id: ADMIN_ID,
        entity_type: "trip",
        entity_id:   TRIP_ID,
        rating:      1,
        body:        null,
        tags:        [],
        visibility:  "public",
        state:       "removed",
        created_at:  "2026-01-02T00:00:00Z",
      },
      {
        id:          "rev-hidden",
        reviewer_id: REVIEWER_ID,
        entity_type: "trip",
        entity_id:   TRIP_ID,
        rating:      1,
        body:        null,
        tags:        [],
        visibility:  "public",
        state:       "hidden",
        created_at:  "2026-01-03T00:00:00Z",
      },
    ];
    server = await startServer(completedTripTables(reviews));
    const { status, body } = await fetchGet(
      server.url,
      `/api/trips/${TRIP_ID}/reviews`,
      "reviewer-token",
    );
    assert.equal(status, 200);
    assert.equal(body.total, 1, "only the published review should count");
    assert.equal(body.avgRating, 5.0, "avgRating should only reflect published reviews");
    assert.equal(body.reviews.length, 1, "only one review should be returned");
  });
});

// ── photos round-trip ─────────────────────────────────────────────────────────
// POST /api/reviews with photos → response includes photos
// PATCH /api/reviews/:id with new photos → response reflects update

describe("photos round-trip", () => {
  let server: { url: string; close: () => Promise<void>; client: any };

  afterEach(async () => { await server?.close(); });

  it("POST /api/reviews persists photos and returns them in the response", async () => {
    server = await startServer(completedTripTables());
    const { status, body } = await fetchPost(server.url, "/api/reviews", "reviewer-token", {
      entityType: "trip",
      entityId:   TRIP_ID,
      rating:     4,
      photos:     [
        "https://cdn.example.com/review/photo1.jpg",
        "https://cdn.example.com/review/photo2.jpg",
      ],
    });
    assert.equal(status, 201);
    assert.ok(body.id);
    assert.deepEqual(body.photos, [
      "https://cdn.example.com/review/photo1.jpg",
      "https://cdn.example.com/review/photo2.jpg",
    ]);
  });

  it("POST /api/reviews with no photos returns an empty photos array", async () => {
    server = await startServer(completedTripTables());
    const { status, body } = await fetchPost(server.url, "/api/reviews", "reviewer-token", {
      entityType: "trip",
      entityId:   TRIP_ID,
      rating:     3,
    });
    assert.equal(status, 201);
    assert.deepEqual(body.photos, [], "omitted photos should default to []");
  });

  it("POST /api/reviews rejects more than 3 photos with 400", async () => {
    server = await startServer(completedTripTables());
    const { status, body } = await fetchPost(server.url, "/api/reviews", "reviewer-token", {
      entityType: "trip",
      entityId:   TRIP_ID,
      rating:     3,
      photos:     [
        "https://cdn.example.com/1.jpg",
        "https://cdn.example.com/2.jpg",
        "https://cdn.example.com/3.jpg",
        "https://cdn.example.com/4.jpg",
      ],
    });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });

  it("PATCH /api/reviews/:id updates photos and returns them in the response", async () => {
    const tables = completedTripTables([{
      id:          REVIEW_ID,
      reviewer_id: REVIEWER_ID,
      entity_type: "trip",
      entity_id:   TRIP_ID,
      rating:      3,
      body:        null,
      tags:        [],
      photos:      [],
      visibility:  "public",
      state:       "published",
    }]);
    server = await startServer(tables);
    const { status, body } = await fetchPatch(
      server.url,
      `/api/reviews/${REVIEW_ID}`,
      "reviewer-token",
      { photos: ["https://cdn.example.com/updated.jpg"] },
    );
    assert.equal(status, 200);
    assert.deepEqual(body.photos, ["https://cdn.example.com/updated.jpg"]);
  });
});

// ── POST /api/reviews/:id/report ──────────────────────────────────────────────

describe("POST /api/reviews/:id/report", () => {
  let server: { url: string; close: () => Promise<void>; client: any };

  afterEach(async () => { await server?.close(); });

  it("404 not_found when the target review has state=hidden", async () => {
    const tables = completedTripTables([{
      id:          REVIEW_ID,
      reviewer_id: OTHER_ID,
      entity_type: "trip",
      entity_id:   TRIP_ID,
      rating:      4,
      body:        null,
      tags:        [],
      visibility:  "public",
      state:       "hidden",   // author-retracted — should block reporting
    }]);
    server = await startServer(tables);
    const { status, body } = await fetchPost(
      server.url,
      `/api/reviews/${REVIEW_ID}/report`,
      "reviewer-token",
      { reason: "spam" },
    );
    assert.equal(status, 404);
    assert.equal(body.error, "not_found");
  });

  it("404 not_found when the target review has state=removed", async () => {
    const tables = completedTripTables([{
      id:          REVIEW_ID,
      reviewer_id: OTHER_ID,
      entity_type: "trip",
      entity_id:   TRIP_ID,
      rating:      4,
      body:        null,
      tags:        [],
      visibility:  "public",
      state:       "removed",  // admin-removed — should block reporting
    }]);
    server = await startServer(tables);
    const { status, body } = await fetchPost(
      server.url,
      `/api/reviews/${REVIEW_ID}/report`,
      "reviewer-token",
      { reason: "harassment" },
    );
    assert.equal(status, 404);
    assert.equal(body.error, "not_found");
  });

  it("201 ok when the target review is published", async () => {
    const tables = completedTripTables([{
      id:          REVIEW_ID,
      reviewer_id: OTHER_ID,
      entity_type: "trip",
      entity_id:   TRIP_ID,
      rating:      4,
      body:        null,
      tags:        [],
      visibility:  "public",
      state:       "published",
    }]);
    server = await startServer(tables);
    const { status, body } = await fetchPost(
      server.url,
      `/api/reviews/${REVIEW_ID}/report`,
      "reviewer-token",
      { reason: "spam" },
    );
    assert.equal(status, 201);
    assert.equal(body.ok, true);
  });
});
