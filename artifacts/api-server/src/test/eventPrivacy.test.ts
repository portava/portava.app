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
import { checkEventEligibility, TRUST_SCORE_WHEN_NO_PROFILE } from "../routes/events.js";
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


// ── Trust gate: an unreadable trust_profiles must not open the gate ──────────
//
// Measured in production on 2026-09-07: 2 trust_profiles rows for 58 profiles,
// and 22 events carrying trust_score_min — 20 thresholds <= 50 (so the
// substituted score admits everyone and the gate does nothing) and 2 above it
// (so it denies 56 of 58 users). The substitution therefore decides real
// access, and the error path decides it too: supabase-js RESOLVES on a
// database error, so a discarded `error` read as "no profile" and substituted
// a passing score.
describe("Event eligibility — trust gate", () => {
  const HOST = "11111111-1111-4111-8111-111111111111";
  const USER = "22222222-2222-4222-8222-222222222222";

  /** Minimal client: every lookup empty except trust_profiles, which is
   *  configurable — including returning an error rather than a row. */
  function gateClient(opts: { trustRow?: any; trustError?: boolean } = {}) {
    return {
      from(table: string) {
        const obj: any = {
          select() { return obj; },
          eq() { return obj; },
          neq() { return obj; },
          in() { return obj; },
          is() { return obj; },
          or() { return obj; },
          not() { return obj; },
          gt() { return obj; },
          gte() { return obj; },
          lte() { return obj; },
          limit() { return obj; },
          order() { return obj; },
          range() { return obj; },
          single() { return obj.maybeSingle(); },
          maybeSingle() {
            // The whole trust gate sits behind events_trust_gates_enabled, which
            // is TRUE in production (since 2026-06-30). Without this the gate is
            // skipped entirely and every assertion below passes vacuously —
            // which is exactly what happened on the first run of these tests.
            if (table === "feature_flags") {
              return Promise.resolve({ data: { enabled: true }, error: null });
            }
            if (table === "trust_profiles") {
              if (opts.trustError) return Promise.resolve({ data: null, error: { message: "trust_profiles unavailable" } });
              return Promise.resolve({ data: opts.trustRow ?? null, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          },
          then(onF: any, onR: any) { return Promise.resolve({ data: [], error: null }).then(onF, onR); },
        };
        return obj;
      },
    };
  }

  const eventWith = (min: number | null) => ({
    host_id: HOST, age_min: null, age_max: null, verified_only: false, trust_score_min: min,
  });

  it("an unreadable trust_profiles DENIES rather than admitting (fail closed)", async () => {
    // Threshold 40: the substituted 50 would pass it, so before the fix a
    // database outage silently ADMITTED. This is the load-bearing assertion.
    const r = await checkEventEligibility(gateClient({ trustError: true }), eventWith(40), USER);
    assert.equal(r.ok, false, "an unreadable trust table must not open the gate");
    assert.match((r as any).message, /temporarily unavailable/i,
      "the denial must be distinguishable from a real trust denial");
  });

  it("no trust profile is still substituted, so today's access is unchanged", async () => {
    // Preserves current behaviour deliberately: whether an unscored user is
    // admitted is an owner decision, not one to make inside a bug fix.
    const pass = await checkEventEligibility(gateClient(), eventWith(TRUST_SCORE_WHEN_NO_PROFILE - 10), USER);
    assert.equal(pass.ok, true, "threshold below the substitution still admits");

    const fail = await checkEventEligibility(gateClient(), eventWith(TRUST_SCORE_WHEN_NO_PROFILE + 15), USER);
    assert.equal(fail.ok, false, "threshold above the substitution still denies");
  });

  it("a real profile is used in preference to the substitution", async () => {
    const r = await checkEventEligibility(
      gateClient({ trustRow: { overall_score: TRUST_SCORE_WHEN_NO_PROFILE + 20 } }),
      eventWith(TRUST_SCORE_WHEN_NO_PROFILE + 15),
      USER,
    );
    assert.equal(r.ok, true, "a scored user above the threshold is admitted on their own score");
  });

  it("the substituted score is pinned at 50 — changing it changes live access", async () => {
    // Deliberately an ABSOLUTE assertion, not one written relative to the
    // constant. Every other threshold in this suite is expressed as
    // TRUST_SCORE_WHEN_NO_PROFILE +/- N, so they all move WITH the constant and
    // none of them can detect a change to it — a hand-revert setting it to 1000
    // left this whole suite green. That value decides access to 22 production
    // events (20 thresholds <= 50, 2 above it), so it is pinned here.
    assert.equal(TRUST_SCORE_WHEN_NO_PROFILE, 50,
      "changing the substituted score changes who can join 22 live events — it is an owner decision, not a refactor");

    // And pin the consequence, not just the number: at exactly 50 an unscored
    // user is admitted, at 51 they are not.
    const at50 = await checkEventEligibility(gateClient(), eventWith(50), USER);
    assert.equal(at50.ok, true, "an unscored user is admitted at a threshold of 50");
    const at51 = await checkEventEligibility(gateClient(), eventWith(51), USER);
    assert.equal(at51.ok, false, "an unscored user is denied at a threshold of 51");
  });

  it("the gate flag is actually on in this harness (vacuity guard)", async () => {
    // These assertions are worthless if events_trust_gates_enabled reads false,
    // because the entire block is skipped and everything returns ok. Pin it:
    // a threshold far above the substitution MUST deny. If this ever passes as
    // ok:true the harness has stopped exercising the gate.
    const r = await checkEventEligibility(gateClient(), eventWith(TRUST_SCORE_WHEN_NO_PROFILE + 40), USER);
    assert.equal(r.ok, false, "the gate is not being exercised — every other assertion here is vacuous");
  });

  it("no gate configured means the trust table is never consulted", async () => {
    // Vacuity guard: if trust_score_min is null the error path must not fire.
    const r = await checkEventEligibility(gateClient({ trustError: true }), eventWith(null), USER);
    assert.equal(r.ok, true, "an ungated event must not be affected by trust_profiles at all");
  });
});

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
