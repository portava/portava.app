/**
 * Trip privacy tests — serializer unit tests + route enforcement
 *
 * Covers:
 *   1. toPrivateTripPreview returns only PrivateTripPreview fields
 *   2. Exact dates (when show_exact_dates=false), hotel name, route, member
 *      list, budget, and itinerary are absent from the private preview
 *   3. A pending access request does not grant full access (still preview)
 *   4. An accepted member receives AuthorizedTripView (full fields)
 *   5. A removed member immediately receives the preview on the next request
 *   6. ownerId, tripNotes, planEditPermission absent from private preview
 *   7. GET /trips/:tripId for private visibility non-member → locked sentinel
 *   8. GET /trips/:tripId for trip owner → full AuthorizedTripView
 *   9. GET /trips/:tripId for public trip → PrivateTripPreview (stripped)
 *
 * Run: node --import tsx/esm --test src/test/tripPrivacy.test.ts
 *
 * NOTE: All suites inside one outer describe to prevent parallel execution
 * races on the shared _setTestClient global.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import {
  toPrivateTripPreview,
  toAuthorizedTripView,
} from "../lib/privacy/tripSerializers.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function apiReq(
  method: string,
  path: string,
  token: string | null,
  server: Server,
): Promise<{ status: number; body: any }> {
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const r = httpRequest(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method, headers },
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
    r.end();
  });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const OWNER_ID   = "owner000-0001-4000-a000-000000000001";
const MEMBER_ID  = "member00-0001-4000-a000-000000000002";
const OUTSIDER_ID = "outside0-0001-4000-a000-000000000003";
const TRIP_ID    = "cccc0000-0001-4000-a000-000000000004";

const OWNER_TOKEN    = "trip-privacy-owner-token";
const MEMBER_TOKEN   = "trip-privacy-member-token";
const OUTSIDER_TOKEN = "trip-privacy-outsider-token";

const FULL_TRIP_ROW = {
  id: TRIP_ID,
  owner_id: OWNER_ID,
  title: "Secret Alps Adventure",
  destination_city: "Chamonix",
  destination_country: "France",
  destination_lat: 45.9237,
  destination_lng: 6.8694,
  destination_place_id: "place-chamonix-123",
  start_date: "2026-12-20",
  end_date: "2026-12-27",
  status: "upcoming",
  visibility: "private",
  cover_url: "https://cdn.example.com/trip/alps.jpg",
  cover_media_type: "image",
  trip_type: "adventure",
  timezone: "Europe/Paris",
  travel_style: "active",
  open_to_meet: false,
  trip_notes: "Book Hotel Mont-Blanc ASAP. Budget: EUR 2000 each.",
  show_on_profile: false,
  show_in_discovery: false,
  allow_friend_suggestions: false,
  allow_trip_crew_invites: false,
  allow_join_requests: false,
  show_exact_dates: true,
  show_destination_city: true,
  delayed_posting_default: false,
  precise_location_visible: false,
  show_header_publicly: false,
  plan_edit_permission: "owner_only",
  progress: 30,
  created_at: "2026-09-01T10:00:00Z",
  updated_at: "2026-09-01T10:00:00Z",
};

// ── Serializer unit tests ─────────────────────────────────────────────────────

describe("Trip Privacy — serializer unit tests", () => {
  it("toPrivateTripPreview contains only allowed fields", () => {
    const result = toPrivateTripPreview(FULL_TRIP_ROW, null);
    const allowed = new Set([
      "id", "title", "destinationCity", "destinationCountry",
      "status", "visibility", "coverUrl", "tripType", "openToMeet",
      "isPrivate", "createdAt", "updatedAt",
      "startDate", "endDate",
      "destinationLat", "destinationLng",
      "myJoinRequestStatus", "showHeaderPublicly",
    ]);
    for (const key of Object.keys(result)) {
      assert(allowed.has(key), `unexpected field "${key}" in PrivateTripPreview`);
    }
  });

  it("ownerId is absent from private preview", () => {
    const result = toPrivateTripPreview(FULL_TRIP_ROW, null);
    assert(!("ownerId" in result), "ownerId must not be in PrivateTripPreview");
    assert(!("owner_id" in result), "owner_id must not be in PrivateTripPreview");
  });

  it("tripNotes (hotel/budget) are absent from private preview", () => {
    const result = toPrivateTripPreview(FULL_TRIP_ROW, null);
    assert(!("tripNotes" in result), "tripNotes must not be in PrivateTripPreview");
    assert(!("trip_notes" in result), "trip_notes must not be in PrivateTripPreview");
  });

  it("planEditPermission is absent from private preview", () => {
    const result = toPrivateTripPreview(FULL_TRIP_ROW, null);
    assert(!("planEditPermission" in result), "planEditPermission must not be in PrivateTripPreview");
  });

  it("coordinates are absent when precise_location_visible=false", () => {
    const result = toPrivateTripPreview({ ...FULL_TRIP_ROW, precise_location_visible: false }, null);
    assert(!("destinationLat" in result) || result.destinationLat === undefined,
      "destinationLat must not be present when precise_location_visible=false");
    assert(!("destinationLng" in result) || result.destinationLng === undefined,
      "destinationLng must not be present when precise_location_visible=false");
  });

  it("coordinates are included when precise_location_visible=true", () => {
    const result = toPrivateTripPreview({ ...FULL_TRIP_ROW, precise_location_visible: true }, null);
    assert.equal(result.destinationLat, 45.9237);
    assert.equal(result.destinationLng, 6.8694);
  });

  it("exact dates are null when show_exact_dates=false", () => {
    const result = toPrivateTripPreview({ ...FULL_TRIP_ROW, show_exact_dates: false }, null);
    assert.equal(result.startDate, null, "startDate must be null when show_exact_dates=false");
    assert.equal(result.endDate, null, "endDate must be null when show_exact_dates=false");
  });

  it("exact dates are included when show_exact_dates=true", () => {
    const result = toPrivateTripPreview({ ...FULL_TRIP_ROW, show_exact_dates: true }, null);
    assert.equal(result.startDate, "2026-12-20");
    assert.equal(result.endDate, "2026-12-27");
  });

  it("destinationCity is null when show_destination_city=false", () => {
    const result = toPrivateTripPreview({ ...FULL_TRIP_ROW, show_destination_city: false }, null);
    assert.equal(result.destinationCity, null);
  });

  it("pending request does NOT elevate access — still returns preview shape", () => {
    const result = toPrivateTripPreview(FULL_TRIP_ROW, "pending");
    assert.equal(result.myJoinRequestStatus, "pending");
    assert(!("tripNotes" in result), "tripNotes must not appear with pending request");
    assert(!("ownerId" in result), "ownerId must not appear with pending request");
  });

  it("isPrivate is always true in private preview", () => {
    const result = toPrivateTripPreview(FULL_TRIP_ROW, null);
    assert.equal(result.isPrivate, true);
  });

  it("showHeaderPublicly=false replaces cover with placeholder", () => {
    const result = toPrivateTripPreview({ ...FULL_TRIP_ROW, show_header_publicly: false }, null);
    assert.notEqual(result.coverUrl, FULL_TRIP_ROW.cover_url, "cover should be placeholder when show_header_publicly=false");
  });

  // ── toAuthorizedTripView ──────────────────────────────────────────────────

  it("accepted member receives full tripNotes in AuthorizedTripView", () => {
    const result = toAuthorizedTripView(FULL_TRIP_ROW);
    assert("tripNotes" in result, "tripNotes must be in AuthorizedTripView");
    assert.equal(result.tripNotes, "Book Hotel Mont-Blanc ASAP. Budget: EUR 2000 each.");
  });

  it("accepted member receives coverMediaType in AuthorizedTripView", () => {
    // This field was absent from the view until 2026-09-03, so GET /api/trips/me
    // never sent it and the app's Trips LIST rendered every video cover as a
    // still — while the detail screen, fed by a route that does send it, played
    // the video. Asserted against the fixture's own value so it cannot go
    // vacuous if the fixture changes.
    const result = toAuthorizedTripView(FULL_TRIP_ROW);
    assert.equal(result.coverMediaType, FULL_TRIP_ROW.cover_media_type);
  });

  it("a trip with no coverMediaType yields null, never undefined", () => {
    const { cover_media_type: _omitted, ...noType } = FULL_TRIP_ROW;
    assert.equal(toAuthorizedTripView(noType).coverMediaType, null);
  });

  it("accepted member receives ownerId in AuthorizedTripView", () => {
    const result = toAuthorizedTripView(FULL_TRIP_ROW);
    assert.equal(result.ownerId, OWNER_ID);
  });

  it("accepted member receives exact coordinates in AuthorizedTripView", () => {
    const result = toAuthorizedTripView(FULL_TRIP_ROW);
    assert.equal(result.destinationLat, 45.9237);
    assert.equal(result.destinationLng, 6.8694);
  });

  it("accepted member receives exact dates in AuthorizedTripView", () => {
    const result = toAuthorizedTripView(FULL_TRIP_ROW);
    assert.equal(result.startDate, "2026-12-20");
    assert.equal(result.endDate, "2026-12-27");
  });

  it("accepted member receives planEditPermission in AuthorizedTripView", () => {
    const result = toAuthorizedTripView(FULL_TRIP_ROW);
    assert.equal(result.planEditPermission, "owner_only");
  });
});

// ── Route integration tests ───────────────────────────────────────────────────

describe("Trip Privacy — route integration", () => {
  let server: Server;

  before(
    () =>
      new Promise<void>((resolve) => {
        server = createServer(app);
        server.listen(0, "127.0.0.1", resolve);
      }),
  );

  after(() => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))));

  function makeClient(opts: { memberRole?: string; visibility?: string } = {}) {
    const visibility = opts.visibility ?? "private";
    const db: Record<string, any[]> = {
      trips: [{ ...FULL_TRIP_ROW, visibility }],
      trip_members: opts.memberRole
        ? [{ trip_id: TRIP_ID, user_id: MEMBER_ID, role: opts.memberRole }]
        : [],
      trip_join_requests: [],
      blocks: [],
      user_follows: [],
      profiles: [
        { id: OWNER_ID, handle: "owner", name: "Owner" },
        { id: MEMBER_ID, handle: "member", name: "Member" },
        { id: OUTSIDER_ID, handle: "outsider", name: "Outsider" },
      ],
      user_account_states: [],
      user_restrictions: [],
      user_interaction_cooldowns: [],
    };

    function chain(table: string) {
      const filters: Array<(r: any) => boolean> = [];
      let _isInsert = false;
      let _insertData: any = null;

      const obj: any = {
        select(_c?: string, _o?: any) { return obj; },
        insert(d: any) { _insertData = d; _isInsert = true; return obj; },
        upsert(d: any) { _insertData = d; _isInsert = true; return obj; },
        update() { return obj; },
        delete() { return obj; },
        eq(col: string, val: any) { filters.push((r) => r[col] === val); return obj; },
        neq(col: string, val: any) { filters.push((r) => r[col] !== val); return obj; },
        in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return obj; },
        or(_f: string) { return obj; },
        not() { return obj; },
        is(col: string, val: any) { filters.push((r) => val === null ? r[col] == null : r[col] === val); return obj; },
        limit(_n: number) { return obj; },
        order() { return obj; },
        range() { return obj; },
        gte() { return obj; },
        gt() { return obj; },
        maybeSingle() {
          const rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: rows[0] ?? null, error: null });
        },
        single() {
          const rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: rows[0] ?? null, error: null });
        },
        then(onF: any, onR: any) {
          if (_isInsert) return Promise.resolve({ data: _insertData, error: null }).then(onF, onR);
          const rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: rows, error: null }).then(onF, onR);
        },
      };
      return obj;
    }

    return {
      auth: {
        getUser: async (tok: string) => {
          if (tok === OWNER_TOKEN) return { data: { user: { id: OWNER_ID } }, error: null };
          if (tok === MEMBER_TOKEN) return { data: { user: { id: MEMBER_ID } }, error: null };
          if (tok === OUTSIDER_TOKEN) return { data: { user: { id: OUTSIDER_ID } }, error: null };
          return { data: { user: null }, error: { message: "invalid" } };
        },
      },
      from: (table: string) => chain(table),
      storage: {
        createBucket: async () => ({ error: null }),
        from: () => ({ upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: "" } }) }),
      },
      rpc: async () => ({ data: null, error: null }),
    };
  }

  it("outsider on private trip receives locked sentinel", async () => {
    _setTestClient(makeClient({ visibility: "private" }), true);
    const { status, body } = await apiReq("GET", `/api/trips/${TRIP_ID}`, OUTSIDER_TOKEN, server);
    assert.equal(status, 200);
    assert.equal(body.locked, true, "private trip non-member should get locked sentinel");
    assert.equal(body.tripId, TRIP_ID);
    assert(!("title" in body), "title must not leak through locked sentinel");
    assert(!("tripNotes" in body), "tripNotes must not leak through locked sentinel");
    assert(!("destinationLat" in body), "coordinates must not leak through locked sentinel");
  });

  it("owner receives full AuthorizedTripView", async () => {
    _setTestClient(makeClient({ visibility: "private" }), true);
    const { status, body } = await apiReq("GET", `/api/trips/${TRIP_ID}`, OWNER_TOKEN, server);
    assert.equal(status, 200);
    assert(!body.locked, "owner should not get locked sentinel");
    assert("tripNotes" in body, "owner should receive tripNotes");
    assert("ownerId" in body, "owner should receive ownerId");
    assert("startDate" in body, "owner should receive startDate");
  });

  it("accepted member receives full AuthorizedTripView", async () => {
    _setTestClient(makeClient({ memberRole: "member", visibility: "private" }), true);
    const { status, body } = await apiReq("GET", `/api/trips/${TRIP_ID}`, MEMBER_TOKEN, server);
    assert.equal(status, 200);
    assert(!body.locked, "accepted member should not get locked sentinel");
    assert("tripNotes" in body, "accepted member should receive tripNotes");
  });

  it("removed member (not in trip_members) receives locked sentinel on next request", async () => {
    // No member row = effectively removed; private trip → locked
    _setTestClient(makeClient({ visibility: "private" }), true); // no memberRole
    const { status, body } = await apiReq("GET", `/api/trips/${TRIP_ID}`, MEMBER_TOKEN, server);
    assert.equal(status, 200);
    assert.equal(body.locked, true, "removed member should get locked sentinel");
  });

  it("public trip — outsider receives stripped PrivateTripPreview (no tripNotes)", async () => {
    _setTestClient(makeClient({ visibility: "public" }), true);
    const { status, body } = await apiReq("GET", `/api/trips/${TRIP_ID}`, OUTSIDER_TOKEN, server);
    assert.equal(status, 200);
    assert(!body.locked, "public trip should not return locked sentinel");
    assert(!("tripNotes" in body), "tripNotes must be absent from public trip preview");
    assert(!("ownerId" in body), "ownerId must be absent from public trip preview");
    // Title is exposed in the stripped preview
    assert("title" in body, "title must be present in public trip preview");
    assert.equal(body.isPrivate, true, "isPrivate sentinel must be true on stripped preview");
  });
});
