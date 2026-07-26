/**
 * Event privacy tests — serializer unit tests + route enforcement
 *
 * Covers:
 *   1. toPrivateEventPreview returns only PrivateEventPreview fields
 *   2. Exact address, coordinates, exact start/end time, attendee count,
 *      description, and host notes are absent from the private preview
 *   3. A pending join request does not grant full access (still preview)
 *   4. An accepted attendee receives AuthorizedEventView (description, times, etc.)
 *   5. Coordinates are gated by show_exact_location and participant status
 *   6. safetyNotes are host-only (null for non-hosts)
 *   7. priceUrl is participant-only (null for outsiders)
 *   8. GET /events/:id for an unauthorized viewer of invite_only event → locked sentinel
 *   9. GET /events/:id for an authorized attendee → full AuthorizedEventView fields
 *
 * Run: node --import tsx/esm --test src/test/eventPrivacy.test.ts
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
  toPrivateEventPreview,
  toAuthorizedEventView,
} from "../lib/privacy/eventSerializers.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function apiReq(
  method: string,
  path: string,
  token: string,
  server: Server,
): Promise<{ status: number; body: any }> {
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = httpRequest(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
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
    r.end();
  });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const HOST_ID     = "host0000-0001-4000-a000-000000000001";
const VIEWER_ID   = "viewer00-0001-4000-a000-000000000002";
const ATTENDEE_ID = "attend00-0001-4000-a000-000000000003";
const EVENT_ID    = "eee00000-0001-4000-a000-000000000004";

const HOST_TOKEN     = "event-privacy-host-token";
const VIEWER_TOKEN   = "event-privacy-viewer-token";
const ATTENDEE_TOKEN = "event-privacy-attendee-token";

const FULL_EVENT_ROW = {
  id: EVENT_ID,
  host_id: HOST_ID,
  title: "Secret Sunset Hike",
  description: "Meet at the trailhead at 5 PM sharp.",
  location_name: "Eagle Peak Trailhead",
  location_lat: 37.8716,
  location_lng: -122.2727,
  starts_at: "2026-09-01T17:00:00Z",
  ends_at: "2026-09-01T21:00:00Z",
  cover_url: "https://cdn.example.com/event/hike.jpg",
  cover_media_type: "image",
  max_attendees: 20,
  age_min: null,
  age_max: null,
  trust_score_min: null,
  verified_only: false,
  visibility: "invite_only",
  state: "open",
  chat_enabled: true,
  chat_thread_id: "thread-abc",
  waitlist_enabled: false,
  price_type: "free",
  price_url: "https://tickets.example.com/abc",
  safety_notes: "Watch out for rattlesnakes.",
  rsvp_options: ["going", "maybe"],
  going_count: 5,
  waitlist_count: 0,
  category: "outdoor",
  city: "Berkeley",
  country: "USA",
  show_exact_location: true,
  show_header_publicly: false,
  rsvp_closed: false,
  tags: ["hiking", "sunset"],
  created_at: "2026-08-01T10:00:00Z",
  updated_at: "2026-08-01T10:00:00Z",
};

// ── Serializer unit tests ─────────────────────────────────────────────────────

describe("Event Privacy — serializer unit tests", () => {
  it("toPrivateEventPreview contains only allowed fields", () => {
    const result = toPrivateEventPreview(FULL_EVENT_ROW, null);
    const allowed = new Set([
      "id", "title", "coverUrl", "coverMediaType",
      "isPrivate", "visibility", "state", "hostId",
      "category", "city", "country",
      "myJoinRequestStatus", "showHeaderPublicly",
    ]);
    for (const key of Object.keys(result)) {
      assert(allowed.has(key), `unexpected field "${key}" in PrivateEventPreview`);
    }
  });

  it("exact address (location_name) is absent from private preview", () => {
    const result = toPrivateEventPreview(FULL_EVENT_ROW, null);
    assert(!("locationName" in result), "locationName must not be in PrivateEventPreview");
    assert(!("location_name" in result), "location_name must not be in PrivateEventPreview");
  });

  it("coordinates (locationLat/locationLng) are absent from private preview", () => {
    const result = toPrivateEventPreview(FULL_EVENT_ROW, null);
    assert(!("locationLat" in result), "locationLat must not be in PrivateEventPreview");
    assert(!("locationLng" in result), "locationLng must not be in PrivateEventPreview");
    assert(!("location_lat" in result), "location_lat must not be in PrivateEventPreview");
    assert(!("location_lng" in result), "location_lng must not be in PrivateEventPreview");
  });

  it("exact start/end times are absent from private preview", () => {
    const result = toPrivateEventPreview(FULL_EVENT_ROW, null);
    assert(!("startsAt" in result), "startsAt must not be in PrivateEventPreview");
    assert(!("endsAt" in result), "endsAt must not be in PrivateEventPreview");
    assert(!("starts_at" in result), "starts_at must not be in PrivateEventPreview");
    assert(!("ends_at" in result), "ends_at must not be in PrivateEventPreview");
  });

  it("attendee count (goingCount, maxAttendees) is absent from private preview", () => {
    const result = toPrivateEventPreview(FULL_EVENT_ROW, null);
    assert(!("goingCount" in result), "goingCount must not be in PrivateEventPreview");
    assert(!("maxAttendees" in result), "maxAttendees must not be in PrivateEventPreview");
    assert(!("waitlistCount" in result), "waitlistCount must not be in PrivateEventPreview");
  });

  it("description is absent from private preview", () => {
    const result = toPrivateEventPreview(FULL_EVENT_ROW, null);
    assert(!("description" in result), "description must not be in PrivateEventPreview");
  });

  it("host notes (safetyNotes) are absent from private preview", () => {
    const result = toPrivateEventPreview(FULL_EVENT_ROW, null);
    assert(!("safetyNotes" in result), "safetyNotes must not be in PrivateEventPreview");
    assert(!("safety_notes" in result), "safety_notes must not be in PrivateEventPreview");
  });

  it("priceUrl is absent from private preview", () => {
    const result = toPrivateEventPreview(FULL_EVENT_ROW, null);
    assert(!("priceUrl" in result), "priceUrl must not be in PrivateEventPreview");
  });

  it("chatThreadId is absent from private preview", () => {
    const result = toPrivateEventPreview(FULL_EVENT_ROW, null);
    assert(!("chatThreadId" in result), "chatThreadId must not be in PrivateEventPreview");
  });

  it("pending join request does NOT elevate access — still returns preview shape", () => {
    const result = toPrivateEventPreview(FULL_EVENT_ROW, "pending");
    // myJoinRequestStatus is recorded but no private fields appear
    assert.equal(result.myJoinRequestStatus, "pending");
    assert(!("description" in result), "description must not be present even with pending request");
    assert(!("locationLat" in result), "coordinates must not be present even with pending request");
    assert(!("startsAt" in result), "startsAt must not be present even with pending request");
  });

  it("isPrivate is always true in private preview", () => {
    const result = toPrivateEventPreview(FULL_EVENT_ROW, null);
    assert.equal(result.isPrivate, true);
  });

  it("showHeaderPublicly=false replaces cover with placeholder", () => {
    const result = toPrivateEventPreview({ ...FULL_EVENT_ROW, show_header_publicly: false }, null);
    assert.notEqual(result.coverUrl, FULL_EVENT_ROW.cover_url, "cover URL should be placeholder when show_header_publicly=false");
  });

  it("showHeaderPublicly=true preserves the real cover URL", () => {
    const result = toPrivateEventPreview({ ...FULL_EVENT_ROW, show_header_publicly: true }, null);
    assert.equal(result.coverUrl, FULL_EVENT_ROW.cover_url);
  });

  // ── toAuthorizedEventView ─────────────────────────────────────────────────

  it("authorized attendee receives description in AuthorizedEventView", () => {
    const result = toAuthorizedEventView(FULL_EVENT_ROW, ATTENDEE_ID, { goingRsvp: true });
    assert("description" in result, "description must be present in AuthorizedEventView");
    assert.equal(result.description, "Meet at the trailhead at 5 PM sharp.");
  });

  it("authorized attendee receives exact times in AuthorizedEventView", () => {
    const result = toAuthorizedEventView(FULL_EVENT_ROW, ATTENDEE_ID, { goingRsvp: true });
    assert("startsAt" in result, "startsAt must be in AuthorizedEventView");
    assert("endsAt" in result, "endsAt must be in AuthorizedEventView");
    assert.equal(result.startsAt, "2026-09-01T17:00:00Z");
  });

  it("attendee receives coordinates when show_exact_location=true", () => {
    const result = toAuthorizedEventView(FULL_EVENT_ROW, ATTENDEE_ID, { goingRsvp: true });
    assert.equal(result.locationLat, 37.8716);
    assert.equal(result.locationLng, -122.2727);
  });

  it("non-participant receives null coordinates when show_exact_location=false", () => {
    const row = { ...FULL_EVENT_ROW, show_exact_location: false };
    const result = toAuthorizedEventView(row, VIEWER_ID, { goingRsvp: false });
    assert.equal(result.locationLat, null, "non-participant should get null coords when show_exact_location=false");
    assert.equal(result.locationLng, null);
  });

  it("host receives safetyNotes", () => {
    const result = toAuthorizedEventView(FULL_EVENT_ROW, HOST_ID, { goingRsvp: false });
    assert.equal(result.safetyNotes, "Watch out for rattlesnakes.");
  });

  it("non-host receives null safetyNotes", () => {
    const result = toAuthorizedEventView(FULL_EVENT_ROW, ATTENDEE_ID, { goingRsvp: true });
    assert.equal(result.safetyNotes, null, "safetyNotes must be null for non-host");
  });

  it("participant receives priceUrl", () => {
    const result = toAuthorizedEventView(FULL_EVENT_ROW, ATTENDEE_ID, { goingRsvp: true });
    assert.equal(result.priceUrl, "https://tickets.example.com/abc");
  });

  it("non-participant receives null priceUrl", () => {
    const result = toAuthorizedEventView(FULL_EVENT_ROW, VIEWER_ID, { goingRsvp: false });
    assert.equal(result.priceUrl, null, "priceUrl must be null for non-participants");
  });
});

// ── Route integration tests ───────────────────────────────────────────────────

describe("Event Privacy — route integration", () => {
  let server: Server;

  before(
    () =>
      new Promise<void>((resolve) => {
        server = createServer(app);
        server.listen(0, "127.0.0.1", resolve);
      }),
  );

  after(() => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))));

  function makeClient(overrides: { attendeeId?: string } = {}) {
    const db: Record<string, any[]> = {
      events: [{ ...FULL_EVENT_ROW }],
      event_rsvps: overrides.attendeeId
        ? [{ event_id: EVENT_ID, user_id: overrides.attendeeId, status: "going" }]
        : [],
      event_roles: [],
      event_attendee_states: [],
      event_waitlist: [],
      event_join_requests: [],
      profiles: [
        { id: HOST_ID, handle: "hostuser", name: "Host User", avatar_url: null },
        { id: VIEWER_ID, handle: "vieweruser", name: "Viewer User", avatar_url: null },
        { id: ATTENDEE_ID, handle: "attendeeuser", name: "Attendee User", avatar_url: null },
      ],
      blocks: [],
      user_follows: [],
      user_restrictions: [],
      user_interaction_cooldowns: [],
      feature_flags: [],
      user_account_states: [],
      trust_profiles: [],
    };

    function chain(table: string) {
      const filters: Array<(r: any) => boolean> = [];
      let _update: any = null;
      let _insert: any = null;
      let _isInsert = false;
      let _isUpdate = false;

      const obj: any = {
        select(_c?: string, _o?: any) { return obj; },
        insert(d: any) { _insert = d; _isInsert = true; return obj; },
        upsert(d: any) { _insert = d; _isInsert = true; return obj; },
        update(p: any) { _update = p; _isUpdate = true; return obj; },
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
        gte(_c: string, _v: any) { return obj; },
        lte(_c: string, _v: any) { return obj; },
        gt(_c: string, _v: any) { return obj; },
        maybeSingle() {
          const rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: rows[0] ?? null, error: null });
        },
        single() {
          const rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: rows[0] ?? null, error: null });
        },
        then(onF: any, onR: any) {
          if (_isInsert) return Promise.resolve({ data: _insert, error: null }).then(onF, onR);
          if (_isUpdate) return Promise.resolve({ data: null, error: null }).then(onF, onR);
          const rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: rows, error: null }).then(onF, onR);
        },
      };
      return obj;
    }

    return {
      auth: {
        getUser: async (tok: string) => {
          if (tok === HOST_TOKEN) return { data: { user: { id: HOST_ID } }, error: null };
          if (tok === VIEWER_TOKEN) return { data: { user: { id: VIEWER_ID } }, error: null };
          if (tok === ATTENDEE_TOKEN) return { data: { user: { id: ATTENDEE_ID } }, error: null };
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

  beforeEach(() => {
    _setTestClient(makeClient(), true);
  });

  it("unauthorized viewer of invite_only event receives locked sentinel", async () => {
    _setTestClient(makeClient(), true);
    const { status, body } = await apiReq("GET", `/api/events/${EVENT_ID}`, VIEWER_TOKEN, server);
    // invite_only event: viewer not an attendee or host → locked sentinel
    assert.equal(status, 200);
    assert.equal(body.locked, true, "invite_only event should return locked sentinel for unauthorized viewer");
    assert.equal(body.eventId, EVENT_ID);
    // Must not leak title, venue, times
    assert(!("title" in body), "title must not leak through locked sentinel");
    assert(!("description" in body), "description must not leak through locked sentinel");
    assert(!("locationLat" in body), "coordinates must not leak through locked sentinel");
  });

  it("host receives full AuthorizedEventView", async () => {
    _setTestClient(makeClient({ attendeeId: HOST_ID }), true);
    const { status, body } = await apiReq("GET", `/api/events/${EVENT_ID}`, HOST_TOKEN, server);
    assert.equal(status, 200);
    assert(!body.locked, "host should not get locked sentinel");
    assert("description" in body, "host should receive description");
    assert("startsAt" in body, "host should receive startsAt");
    assert.equal(body.safetyNotes, "Watch out for rattlesnakes.", "host should receive safetyNotes");
  });

  it("accepted attendee receives full view with description and times", async () => {
    _setTestClient(makeClient({ attendeeId: ATTENDEE_ID }), true);
    const { status, body } = await apiReq("GET", `/api/events/${EVENT_ID}`, ATTENDEE_TOKEN, server);
    assert.equal(status, 200);
    assert(!body.locked, "attendee should not get locked sentinel");
    assert("description" in body, "attendee should receive description");
    assert("startsAt" in body, "attendee should receive startsAt");
    // safetyNotes must be null for non-host
    assert.equal(body.safetyNotes, null, "safetyNotes must be null for non-host attendee");
  });
});
