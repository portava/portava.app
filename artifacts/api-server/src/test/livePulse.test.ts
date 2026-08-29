/**
 * GET /api/pulse/live — Live Pulse smart rail endpoint tests.
 *
 * Covers:
 *  A. Returns correct item types (events, trips, buddy requests, hidden gems,
 *     circles, safe_return)
 *  B. Applies correct status labels (Starting Soon, Ongoing, Ends Soon, Tonight, Upcoming)
 *  C. Respects urgency ranking (safety → owned starting-soon → requests → ongoing → discovery)
 *  D. Deduplicates repeated objects (same item_type + item_id once only)
 *  E. Hides ended and cancelled events
 *  F. Hides blocked-user content (events hosted by blocked users excluded)
 *  G. Location-off fallback: returns items when no citySlug given
 *  H. Returns 401 without Authorization header
 *  I. Privacy — invite_only events excluded from non-hosts
 *  J. Privacy — capacity: is_joinable=false when event is at max_attendees
 *  K. Privacy — buddy items only from approved rent_buddy_profiles
 *  L. Feature flag gating — hidden gems skipped when hidden_gems_enabled=false
 *  M. Safe Return — active session surfaces as urgency-0 safe_return item
 *  N. Circle — active presence surfaces as circle item
 *  O. Context — specificTrip filter narrows to one trip
 *
 * Runtime: node:test + node:assert/strict (no vitest / no supertest).
 * Run: node --import tsx/esm --test src/test/livePulse.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";

// ── IDs ────────────────────────────────────────────────────────────────────────

const ALICE_ID   = "a1a1a1a1-aaaa-aaaa-aaaa-000000000001";
const BOB_ID     = "b2b2b2b2-bbbb-bbbb-bbbb-000000000002";
const BLOCKED_ID = "bb000000-cccc-dddd-eeee-000000000099";

// ── Time helpers ──────────────────────────────────────────────────────────────

const in30min  = new Date(Date.now() + 30 * 60_000).toISOString();
const in2h     = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
const in3days  = new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString();
const in20days = new Date(Date.now() + 20 * 24 * 60 * 60_000).toISOString();
const in45min  = new Date(Date.now() + 45 * 60_000).toISOString();
const past1h   = new Date(Date.now() - 60 * 60_000).toISOString();
const past2h   = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
const past30min = new Date(Date.now() - 30 * 60_000).toISOString();
const in40min  = new Date(Date.now() + 40 * 60_000).toISOString();
const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60_000 + 60_000).toISOString(); // just inside 4h window

// ── Fake client factory ────────────────────────────────────────────────────────

interface FakeState {
  user?: { id: string } | null;
  events?: any[];
  event_rsvps?: any[];
  event_saves?: any[];
  trip_members?: any[];
  trips?: any[];
  trip_join_requests?: any[];
  buddy_bookings?: any[];
  rent_buddy_profiles?: any[];
  hidden_gems?: any[];
  blocks?: any[];
  safe_return_sessions?: any[];
  circle_presence?: any[];
  feature_flags?: any[];
  compass_user_profiles?: any[];
  profiles?: any[];
}

function makeClient(state: FakeState = {}, callerUserId = ALICE_ID) {
  const db: Record<string, any[]> = {
    events:               state.events               ?? [],
    event_rsvps:          state.event_rsvps          ?? [],
    event_saves:          state.event_saves          ?? [],
    trip_members:         state.trip_members         ?? [],
    trips:                state.trips                ?? [],
    trip_join_requests:   state.trip_join_requests   ?? [],
    buddy_bookings:       state.buddy_bookings       ?? [],
    rent_buddy_profiles:  state.rent_buddy_profiles  ?? [],
    hidden_gems:          state.hidden_gems          ?? [],
    blocks:               state.blocks               ?? [],
    safe_return_sessions: state.safe_return_sessions ?? [],
    circle_presence:      state.circle_presence      ?? [],
    feature_flags:        state.feature_flags        ?? [],
    compass_user_profiles: state.compass_user_profiles ?? [],
    profiles:             state.profiles             ?? [],
  };

  function builder(table: string, rows: any[]) {
    let filtered = rows.map(r => ({ ...r })); // shallow copy each row

    const b: any = {
      select: (_cols?: string) => builder(table, filtered),
      eq: (col: string, val: any) => {
        filtered = filtered.filter((r) => r[col] === val);
        return b;
      },
      neq: (col: string, val: any) => {
        filtered = filtered.filter((r) => r[col] !== val);
        return b;
      },
      in: (col: string, vals: any[]) => {
        filtered = filtered.filter((r) => vals.includes(r[col]));
        return b;
      },
      gt: (col: string, val: any) => {
        filtered = filtered.filter((r) => r[col] > val);
        return b;
      },
      lt: (_col: string, _val: any) => b,
      ilike: (col: string, pattern: string) => {
        const rx = new RegExp("^" + pattern.replace(/%/g, ".*") + "$", "i");
        filtered = filtered.filter((r) => typeof r[col] === "string" && rx.test(r[col]));
        return b;
      },
      or: (_f: string) => b,
      order: (_col: string, _opts?: any) => b,
      limit: (_n: number) => b,
      is: (col: string, val: any) => {
        filtered = filtered.filter((r) => (val === null ? r[col] == null : r[col] === val));
        return b;
      },
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      single:      () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      then: (resolve: any) => resolve({ data: [...filtered], error: null }),
    };
    return b;
  }

  return {
    auth: {
      getUser: async (token: string) => {
        if (token === "valid-token") return { data: { user: { id: callerUserId } }, error: null };
        return { data: null, error: { message: "invalid" } };
      },
    },
    from: (table: string) => builder(table, db[table] ?? []),
  };
}

// ── App factory ────────────────────────────────────────────────────────────────

async function makeApp(): Promise<Express> {
  const { default: pulseRouter } = await import("../routes/pulse.js");
  const app = express();
  app.use(express.json());
  app.use("/api", pulseRouter);
  return app;
}

async function req(
  app: Express,
  path: string,
  token = "valid-token",
): Promise<{ status: number; body: any }> {
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port as number;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

let app: Express;

describe("GET /api/pulse/live", () => {
  before(async () => {
    app = await makeApp();
  });

  after(() => {
    _setTestClient(null, false);
  });

  // ── H. Auth guard ──────────────────────────────────────────────────────────

  it("H — returns 401 without Authorization header", async () => {
    _setTestClient(makeClient(), true);
    const { status } = await req(app, "/api/pulse/live", "");
    assert.equal(status, 401);
  });

  it("H — returns 401 with invalid token", async () => {
    _setTestClient(makeClient(), true);
    const { status } = await req(app, "/api/pulse/live", "bad-token");
    assert.equal(status, 401);
  });

  // ── A. Returns correct item types ──────────────────────────────────────────

  it("A — returns hosted event as item_type=event with user_relationship=host", async () => {
    _setTestClient(makeClient({
      events: [{
        id: "ev-0001-0000-0000-000000000001",
        host_id: ALICE_ID,
        title: "Beach Meetup",
        starts_at: in2h,
        ends_at: in3days,
        city: "Manila",
        state: "open",
        visibility: "public",
        going_count: 5,
        max_attendees: 20,
      }],
    }), true);

    const { status, body } = await req(app, "/api/pulse/live");
    assert.equal(status, 200);
    const items = body.items as any[];
    const event = items.find((i: any) => i.item_type === "event");
    assert.ok(event, "event item should be present");
    assert.equal(event.user_relationship, "host");
    assert.equal(event.title, "Beach Meetup");
  });

  it("A — returns rsvp'd event as item_type=event with user_relationship=joined", async () => {
    _setTestClient(makeClient({
      event_rsvps: [{ event_id: "ev-0002-0000-0000-000000000001", user_id: ALICE_ID, status: "going" }],
      events: [{
        id: "ev-0002-0000-0000-000000000001",
        host_id: BOB_ID,
        title: "Sunset Hike",
        starts_at: in2h,
        ends_at: in3days,
        city: "Cebu",
        state: "open",
        visibility: "public",
        going_count: 3,
        max_attendees: null,
      }],
    }), true);

    const { status, body } = await req(app, "/api/pulse/live");
    assert.equal(status, 200);
    const items = body.items as any[];
    const event = items.find((i: any) => i.item_id === "ev-0002-0000-0000-000000000001");
    assert.ok(event, "rsvp'd event item present");
    assert.equal(event.user_relationship, "joined");
  });

  it("A — returns trip member item as item_type=trip", async () => {
    _setTestClient(makeClient({
      trip_members: [{ trip_id: "tr-0001-0000-0000-000000000001", user_id: ALICE_ID, role: "owner" }],
      trips: [{
        id: "tr-0001-0000-0000-000000000001",
        owner_id: ALICE_ID,
        title: "Palawan Adventure",
        destination_city: "Palawan",
        start_date: in3days,
        end_date: in20days,
        status: "planning",
        visibility: "private",
      }],
    }), true);

    const { status, body } = await req(app, "/api/pulse/live");
    assert.equal(status, 200);
    const items = body.items as any[];
    const trip = items.find((i: any) => i.item_type === "trip");
    assert.ok(trip, "trip item present");
    assert.equal(trip.title, "Palawan Adventure");
  });

  it("A — returns pending buddy booking as item_type=buddy_request", async () => {
    _setTestClient(makeClient({
      buddy_bookings: [{
        id: "bk-0001-0000-0000-000000000001",
        buddy_id: BOB_ID,
        traveler_id: ALICE_ID,
        booking_date: in2h,
        city: "Manila",
        status: "requested",
      }],
    }), true);

    const { status, body } = await req(app, "/api/pulse/live");
    assert.equal(status, 200);
    const items = body.items as any[];
    const buddy = items.find((i: any) => i.item_type === "buddy_request");
    assert.ok(buddy, "buddy_request item present");
    assert.equal(buddy.status_label, "Action Needed");
    assert.equal(buddy.user_relationship, "pending");
  });

  // ── B. Status label rules ─────────────────────────────────────────────────

  it("B — Starting Soon when event starts in ≤60 min", async () => {
    _setTestClient(makeClient({
      events: [{
        id: "ev-0003-0000-0000-000000000001",
        host_id: ALICE_ID,
        title: "Quick Meetup",
        starts_at: in30min,
        ends_at: in2h,
        city: "Manila",
        state: "open",
        visibility: "public",
        going_count: 0,
        max_attendees: null,
      }],
    }), true);

    const { body } = await req(app, "/api/pulse/live");
    const ev = (body.items as any[]).find((i: any) => i.item_id === "ev-0003-0000-0000-000000000001");
    assert.ok(ev, "event present");
    assert.equal(ev.status_label, "Starting Soon");
  });

  it("B — Ongoing when event has started and not ended", async () => {
    _setTestClient(makeClient({
      events: [{
        id: "ev-0004-0000-0000-000000000001",
        host_id: ALICE_ID,
        title: "Running Event",
        starts_at: past1h,
        ends_at: in2h,
        city: "Manila",
        state: "started",
        visibility: "public",
        going_count: 10,
        max_attendees: null,
      }],
    }), true);

    const { body } = await req(app, "/api/pulse/live");
    const ev = (body.items as any[]).find((i: any) => i.item_id === "ev-0004-0000-0000-000000000001");
    assert.ok(ev, "event present");
    assert.equal(ev.status_label, "Ongoing");
  });

  it("B — Ends Soon when event ends in ≤45 min", async () => {
    _setTestClient(makeClient({
      events: [{
        id: "ev-0005-0000-0000-000000000001",
        host_id: ALICE_ID,
        title: "Almost Done",
        starts_at: past2h,
        ends_at: in40min,
        city: "Manila",
        state: "started",
        visibility: "public",
        going_count: 7,
        max_attendees: null,
      }],
    }), true);

    const { body } = await req(app, "/api/pulse/live");
    const ev = (body.items as any[]).find((i: any) => i.item_id === "ev-0005-0000-0000-000000000001");
    assert.ok(ev, "event present");
    assert.equal(ev.status_label, "Ends Soon");
  });

  it("B — Upcoming when event starts in 3+ days but ≤14 days", async () => {
    _setTestClient(makeClient({
      events: [{
        id: "ev-0006-0000-0000-000000000001",
        host_id: ALICE_ID,
        title: "Weekend Event",
        starts_at: in3days,
        ends_at: new Date(Date.now() + 4 * 24 * 60 * 60_000).toISOString(),
        city: "Manila",
        state: "open",
        visibility: "public",
        going_count: 2,
        max_attendees: null,
      }],
    }), true);

    const { body } = await req(app, "/api/pulse/live");
    const ev = (body.items as any[]).find((i: any) => i.item_id === "ev-0006-0000-0000-000000000001");
    assert.ok(ev, "event present");
    assert.equal(ev.status_label, "Upcoming");
  });

  // ── C. Ranking order ──────────────────────────────────────────────────────

  it("C — safe_return ranked before everything else (urgency 0)", async () => {
    _setTestClient(makeClient({
      safe_return_sessions: [{
        id: "sr-0001-0000-0000-000000000001",
        user_id: ALICE_ID,
        status: "active",
        timer_end_at: in45min,
        trip_id: null,
        escalation_level: 0,
      }],
      feature_flags: [{ flag: "safe_return_enabled", enabled: true }],
      events: [{
        id: "ev-c001-0000-0000-000000000001",
        host_id: ALICE_ID,
        title: "Starting Event",
        starts_at: in30min,
        ends_at: in3days,
        city: "Manila",
        state: "open",
        visibility: "public",
        going_count: 1,
        max_attendees: null,
      }],
    }), true);

    const { body } = await req(app, "/api/pulse/live");
    const items = body.items as any[];
    const srIdx = items.findIndex((i: any) => i.item_type === "safe_return");
    const evIdx = items.findIndex((i: any) => i.item_type === "event");
    assert.ok(srIdx !== -1, "safe_return item present");
    assert.ok(srIdx < evIdx, `safe_return (idx ${srIdx}) ranked before event (idx ${evIdx})`);
  });

  it("C — pending requests ranked above ongoing events", async () => {
    _setTestClient(makeClient({
      events: [{
        id: "ev-0007-0000-0000-000000000001",
        host_id: ALICE_ID,
        title: "Ongoing Party",
        starts_at: past1h,
        ends_at: in2h,
        city: "Manila",
        state: "started",
        visibility: "public",
        going_count: 5,
        max_attendees: null,
      }],
      buddy_bookings: [{
        id: "bk-0002-0000-0000-000000000001",
        buddy_id: BOB_ID,
        traveler_id: ALICE_ID,
        booking_date: in3days,
        city: "Manila",
        status: "requested",
      }],
    }), true);

    const { body } = await req(app, "/api/pulse/live");
    const items = body.items as any[];
    const buddyIdx = items.findIndex((i: any) => i.item_type === "buddy_request");
    const eventIdx = items.findIndex((i: any) => i.item_type === "event");
    assert.ok(buddyIdx < eventIdx, `buddy_request (idx ${buddyIdx}) should appear before event (idx ${eventIdx})`);
  });

  it("C — starting-soon host events ranked above starting-soon joined events", async () => {
    _setTestClient(makeClient({
      events: [
        {
          id: "ev-0008-0000-0000-000000000001",
          host_id: BOB_ID,
          title: "Joined Starting Soon",
          starts_at: in30min,
          ends_at: in2h,
          city: "Manila",
          state: "open",
          visibility: "public",
          going_count: 0,
          max_attendees: null,
        },
        {
          id: "ev-0009-0000-0000-000000000001",
          host_id: ALICE_ID,
          title: "Hosted Starting Soon",
          starts_at: in30min,
          ends_at: in2h,
          city: "Manila",
          state: "open",
          visibility: "public",
          going_count: 0,
          max_attendees: null,
        },
      ],
      event_rsvps: [{ event_id: "ev-0008-0000-0000-000000000001", user_id: ALICE_ID, status: "going" }],
    }), true);

    const { body } = await req(app, "/api/pulse/live");
    const items = body.items as any[];
    const hostedIdx = items.findIndex((i: any) => i.item_id === "ev-0009-0000-0000-000000000001");
    const joinedIdx = items.findIndex((i: any) => i.item_id === "ev-0008-0000-0000-000000000001");
    assert.ok(hostedIdx < joinedIdx, "hosted starting-soon ranked before joined starting-soon");
  });

  // ── D. Deduplication ──────────────────────────────────────────────────────

  it("D — same item_type + item_id appears only once in response", async () => {
    const eventId = "ev-0010-0000-0000-000000000001";
    _setTestClient(makeClient({
      events: [{
        id: eventId,
        host_id: ALICE_ID,
        title: "My Own Event",
        starts_at: in2h,
        ends_at: in3days,
        city: "Manila",
        state: "open",
        visibility: "public",
        going_count: 1,
        max_attendees: null,
      }],
      event_rsvps: [{ event_id: eventId, user_id: ALICE_ID, status: "going" }],
    }), true);

    const { body } = await req(app, "/api/pulse/live");
    const items = body.items as any[];
    const count = items.filter((i: any) => i.item_id === eventId).length;
    assert.equal(count, 1, "deduplicated: event appears exactly once");
  });

  // ── E. Hides ended / cancelled events ────────────────────────────────────

  it("E — ended events are excluded", async () => {
    _setTestClient(makeClient({
      events: [{
        id: "ev-0011-0000-0000-000000000001",
        host_id: ALICE_ID,
        title: "Old Event",
        starts_at: past2h,
        ends_at: past1h,
        city: "Manila",
        state: "completed",
        visibility: "public",
        going_count: 0,
        max_attendees: null,
      }],
    }), true);

    const { body } = await req(app, "/api/pulse/live");
    const found = (body.items as any[]).find((i: any) => i.item_id === "ev-0011-0000-0000-000000000001");
    assert.equal(found, undefined, "ended event should not appear");
  });

  it("E — events in cancelled state are excluded by state filter", async () => {
    _setTestClient(makeClient({
      events: [{
        id: "ev-0012-0000-0000-000000000001",
        host_id: ALICE_ID,
        title: "Cancelled Event",
        starts_at: in2h,
        ends_at: in3days,
        city: "Manila",
        state: "cancelled",
        visibility: "public",
        going_count: 0,
        max_attendees: null,
      }],
    }), true);

    const { body } = await req(app, "/api/pulse/live");
    const found = (body.items as any[]).find((i: any) => i.item_id === "ev-0012-0000-0000-000000000001");
    assert.equal(found, undefined, "cancelled event should not appear");
  });

  // ── F. Hides blocked-user content ─────────────────────────────────────────

  it("F — events hosted by a blocked user are excluded", async () => {
    _setTestClient(makeClient({
      blocks: [{ blocker_id: ALICE_ID, blocked_id: BLOCKED_ID }],
      event_rsvps: [{ event_id: "ev-0013-0000-0000-000000000001", user_id: ALICE_ID, status: "going" }],
      events: [{
        id: "ev-0013-0000-0000-000000000001",
        host_id: BLOCKED_ID,
        title: "Blocked Host Event",
        starts_at: in2h,
        ends_at: in3days,
        city: "Manila",
        state: "open",
        visibility: "public",
        going_count: 5,
        max_attendees: null,
      }],
    }), true);

    const { body } = await req(app, "/api/pulse/live");
    const found = (body.items as any[]).find((i: any) => i.item_id === "ev-0013-0000-0000-000000000001");
    assert.equal(found, undefined, "blocked host event should not appear");
  });

  // ── G. Location-off fallback ───────────────────────────────────────────────

  it("G — without citySlug, returns myPlans context items (trips)", async () => {
    _setTestClient(makeClient({
      trip_members: [{ trip_id: "tr-0002-0000-0000-000000000001", user_id: ALICE_ID, role: "owner" }],
      trips: [{
        id: "tr-0002-0000-0000-000000000001",
        owner_id: ALICE_ID,
        title: "My Upcoming Trip",
        destination_city: "Singapore",
        start_date: in3days,
        end_date: in20days,
        status: "planning",
        visibility: "private",
      }],
    }), true);

    const { status, body } = await req(app, "/api/pulse/live");
    assert.equal(status, 200);
    const trip = (body.items as any[]).find((i: any) => i.item_type === "trip");
    assert.ok(trip, "trip appears without citySlug (location-off fallback)");
  });

  it("G — nearMe without lat/lng falls back and includes fallbackContext in response", async () => {
    _setTestClient(makeClient({
      trip_members: [{ trip_id: "tr-0003-0000-0000-000000000001", user_id: ALICE_ID, role: "owner" }],
      trips: [{
        id: "tr-0003-0000-0000-000000000001",
        owner_id: ALICE_ID,
        title: "Trip With City",
        destination_city: "Cebu",
        start_date: in3days,
        end_date: in20days,
        status: "planning",
        visibility: "private",
      }],
    }), true);

    const { status, body } = await req(app, "/api/pulse/live?context=nearMe");
    assert.equal(status, 200);
    assert.equal(body.fallbackContext, "tripCity", "fallbackContext returned when nearMe without coords");
  });

  // ── I. Privacy — visibility filter ────────────────────────────────────────

  it("I — invite_only events are excluded for non-hosts (RSVP'd events)", async () => {
    _setTestClient(makeClient({
      event_rsvps: [{ event_id: "ev-0014-0000-0000-000000000001", user_id: ALICE_ID, status: "going" }],
      events: [{
        id: "ev-0014-0000-0000-000000000001",
        host_id: BOB_ID,
        title: "Invite Only Party",
        starts_at: in2h,
        ends_at: in3days,
        city: "Manila",
        state: "open",
        visibility: "invite_only", // should be filtered out
        going_count: 5,
        max_attendees: null,
      }],
    }), true);

    const { body } = await req(app, "/api/pulse/live");
    const found = (body.items as any[]).find((i: any) => i.item_id === "ev-0014-0000-0000-000000000001");
    assert.equal(found, undefined, "invite_only event from non-host should be excluded");
  });

  // ── J. Capacity check — is_joinable ───────────────────────────────────────

  it("J — event at full capacity has is_joinable=false", async () => {
    _setTestClient(makeClient({
      events: [{
        id: "ev-0015-0000-0000-000000000001",
        host_id: ALICE_ID,
        title: "Full Event",
        starts_at: in2h,
        ends_at: in3days,
        city: "Manila",
        state: "open",
        visibility: "public",
        going_count: 50,
        max_attendees: 50, // at capacity
      }],
    }), true);

    const { body } = await req(app, "/api/pulse/live");
    const ev = (body.items as any[]).find((i: any) => i.item_id === "ev-0015-0000-0000-000000000001");
    assert.ok(ev, "event present");
    assert.equal(ev.is_joinable, false, "at-capacity event should not be joinable");
    assert.ok(ev.reason_labels.includes("Full"), "reason label 'Full' should be present");
  });

  it("J — event below capacity has is_joinable=true", async () => {
    _setTestClient(makeClient({
      events: [{
        id: "ev-0016-0000-0000-000000000001",
        host_id: ALICE_ID,
        title: "Open Event",
        starts_at: in2h,
        ends_at: in3days,
        city: "Manila",
        state: "open",
        visibility: "public",
        going_count: 10,
        max_attendees: 50,
      }],
    }), true);

    const { body } = await req(app, "/api/pulse/live");
    const ev = (body.items as any[]).find((i: any) => i.item_id === "ev-0016-0000-0000-000000000001");
    assert.ok(ev, "event present");
    assert.equal(ev.is_joinable, true, "below-capacity event should be joinable");
  });

  // ── K. Buddy approved-only gating ─────────────────────────────────────────

  it("K — incoming buddy requests only shown when caller has an approved rent_buddy_profiles row", async () => {
    const bookingId = "bk-0003-0000-0000-000000000001";
    const buddyProfileId = "bp-0001-0000-0000-000000000001";
    // Alice has an approved buddy profile
    _setTestClient(makeClient({
      rent_buddy_profiles: [{
        id: buddyProfileId,
        user_id: ALICE_ID,
        admin_status: "active",
      }],
      buddy_bookings: [{
        id: bookingId,
        buddy_id: buddyProfileId,
        traveler_id: BOB_ID,
        booking_date: in2h,
        city: "Manila",
        status: "requested",
      }],
    }), true);

    const { body } = await req(app, "/api/pulse/live");
    const bk = (body.items as any[]).find((i: any) => i.item_id === bookingId);
    assert.ok(bk, "incoming booking appears for approved buddy");
  });

  it("K — incoming booking NOT shown when caller has no approved rent_buddy_profiles row", async () => {
    const bookingId = "bk-0004-0000-0000-000000000001";
    _setTestClient(makeClient({
      rent_buddy_profiles: [], // no approved profile
      buddy_bookings: [{
        id: bookingId,
        buddy_id: "bp-xxxx-0000-0000-000000000001",
        traveler_id: BOB_ID,
        booking_date: in2h,
        city: "Manila",
        status: "requested",
      }],
    }), true);

    const { body } = await req(app, "/api/pulse/live");
    const bk = (body.items as any[]).find((i: any) => i.item_id === bookingId);
    assert.equal(bk, undefined, "booking not shown when no approved profile");
  });

  // ── L. Feature flag gating ────────────────────────────────────────────────

  it("L — hidden gems NOT returned when hidden_gems_enabled=false", async () => {
    _setTestClient(makeClient({
      feature_flags: [{ flag: "hidden_gems_enabled", enabled: false }],
      hidden_gems: [{
        id: "gem-0001-0000-0000-000000000001",
        name: "Secret Beach",
        city: "Manila",
        category: "Beach",
        status: "active",
        save_count: 100,
      }],
    }), true);

    const { body } = await req(app, "/api/pulse/live?citySlug=manila");
    const gem = (body.items as any[]).find((i: any) => i.item_type === "hidden_gem");
    assert.equal(gem, undefined, "hidden gems not shown when flag disabled");
  });

  it("L — hidden gems returned when hidden_gems_enabled=true", async () => {
    _setTestClient(makeClient({
      feature_flags: [{ flag: "hidden_gems_enabled", enabled: true }],
      hidden_gems: [{
        id: "gem-0002-0000-0000-000000000001",
        name: "Secret Beach",
        city: "Manila",
        category: "Beach",
        status: "active",
        save_count: 100,
      }],
    }), true);

    const { body } = await req(app, "/api/pulse/live?citySlug=manila");
    const gem = (body.items as any[]).find((i: any) => i.item_type === "hidden_gem");
    assert.ok(gem, "hidden gem appears when flag enabled");
  });

  // ── M. Safe Return ──────────────────────────────────────────────────────────

  it("M — active safe_return session surfaces as item_type=safe_return", async () => {
    _setTestClient(makeClient({
      feature_flags: [{ flag: "safe_return_enabled", enabled: true }],
      safe_return_sessions: [{
        id: "sr-0002-0000-0000-000000000001",
        user_id: ALICE_ID,
        status: "active",
        timer_end_at: in45min,
        trip_id: null,
        escalation_level: 0,
      }],
    }), true);

    const { status, body } = await req(app, "/api/pulse/live");
    assert.equal(status, 200);
    const sr = (body.items as any[]).find((i: any) => i.item_type === "safe_return");
    assert.ok(sr, "safe_return item present");
    assert.equal(sr.status_label, "Action Needed");
    assert.equal(sr.primary_action?.type, "confirm_safe_return");
    assert.equal(sr.secondary_action?.type, "extend_safe_return");
  });

  it("M — safe_return NOT returned when safe_return_enabled=false", async () => {
    _setTestClient(makeClient({
      feature_flags: [{ flag: "safe_return_enabled", enabled: false }],
      safe_return_sessions: [{
        id: "sr-0003-0000-0000-000000000001",
        user_id: ALICE_ID,
        status: "active",
        timer_end_at: in45min,
        trip_id: null,
        escalation_level: 0,
      }],
    }), true);

    const { body } = await req(app, "/api/pulse/live");
    const sr = (body.items as any[]).find((i: any) => i.item_type === "safe_return");
    assert.equal(sr, undefined, "safe_return not shown when flag disabled");
  });

  // ── N. Circles ─────────────────────────────────────────────────────────────

  it("N — active circle_presence for caller's trip surfaces as circle item", async () => {
    const tripId = "tr-0004-0000-0000-000000000001";
    _setTestClient(makeClient({
      feature_flags: [{ flag: "find_your_circle_enabled", enabled: true }],
      trip_members: [{ trip_id: tripId, user_id: ALICE_ID, role: "owner" }],
      trips: [{
        id: tripId,
        owner_id: ALICE_ID,
        title: "Circle Trip",
        destination_city: "Davao",
        start_date: in3days,
        end_date: in20days,
        status: "planning",
        visibility: "private",
      }],
      circle_presence: [{
        context_type: "trip",
        context_id: tripId,
        user_id: BOB_ID,
        updated_at: fourHoursAgo, // within 4h window
      }],
    }), true);

    const { status, body } = await req(app, "/api/pulse/live");
    assert.equal(status, 200);
    const circle = (body.items as any[]).find((i: any) => i.item_type === "circle");
    assert.ok(circle, "circle item present when presence within 4h");
    assert.equal(circle.item_id, tripId);
  });

  it("N — circle item NOT shown when find_your_circle_enabled=false", async () => {
    const tripId = "tr-0005-0000-0000-000000000001";
    _setTestClient(makeClient({
      feature_flags: [{ flag: "find_your_circle_enabled", enabled: false }],
      trip_members: [{ trip_id: tripId, user_id: ALICE_ID, role: "owner" }],
      trips: [{
        id: tripId,
        owner_id: ALICE_ID,
        title: "Circle Trip 2",
        destination_city: "Cebu",
        start_date: in3days,
        end_date: in20days,
        status: "planning",
        visibility: "private",
      }],
      circle_presence: [{
        context_type: "trip",
        context_id: tripId,
        user_id: BOB_ID,
        updated_at: fourHoursAgo,
      }],
    }), true);

    const { body } = await req(app, "/api/pulse/live");
    const circle = (body.items as any[]).find((i: any) => i.item_type === "circle");
    assert.equal(circle, undefined, "circle not shown when flag disabled");
  });

  // ── O. Context — specificTrip ─────────────────────────────────────────────

  it("O — specificTrip context filters to only the requested trip", async () => {
    const tripA = "a0060000-0000-0000-0000-000000000001"; // valid UUID (hex only)
    const tripB = "b0060000-0000-0000-0000-000000000002";
    _setTestClient(makeClient({
      trip_members: [
        { trip_id: tripA, user_id: ALICE_ID, role: "owner" },
        { trip_id: tripB, user_id: ALICE_ID, role: "member" },
      ],
      trips: [
        {
          id: tripA,
          owner_id: ALICE_ID,
          title: "Trip A",
          destination_city: "Manila",
          start_date: in3days,
          end_date: in20days,
          status: "planning",
          visibility: "private",
        },
        {
          id: tripB,
          owner_id: BOB_ID,
          title: "Trip B",
          destination_city: "Cebu",
          start_date: in3days,
          end_date: in20days,
          status: "planning",
          visibility: "private",
        },
      ],
    }), true);

    const { body } = await req(app, `/api/pulse/live?context=specificTrip&tripId=${tripA}`);
    assert.ok(Array.isArray(body.items), `items should be an array, got: ${JSON.stringify(body)}`);
    const trips = (body.items as any[]).filter((i: any) => i.item_type === "trip");
    assert.equal(trips.length, 1, "only one trip returned");
    assert.equal(trips[0].item_id, tripA, "correct trip returned");
  });

  // ── Q. Saved events — event_saves surfaces as event item ─────────────────

  it("Q — saved event surfaces as event item with user_relationship=saved", async () => {
    const savedEvId = "sa000000-0000-0000-0000-000000000001";
    _setTestClient(makeClient({
      event_saves: [{ event_id: savedEvId, user_id: ALICE_ID }],
      events: [{
        id:            savedEvId,
        host_id:       BOB_ID,
        title:         "Saved Event",
        starts_at:     in2h,
        ends_at:       in3days,
        city:          "Manila",
        state:         "open",
        visibility:    "public",
        going_count:   0,
        max_attendees: null,
      }],
    }), true);
    const { body } = await req(app, "/api/pulse/live");
    const saved = (body.items as any[]).filter((i: any) => i.item_id === savedEvId);
    assert.ok(saved.length >= 1, `expected saved event item, got: ${JSON.stringify(body.items)}`);
    assert.equal(saved[0].user_relationship, "saved", "user_relationship should be 'saved'");
  });

  // ── R. Trip join requests — pending host requests surface as Action Needed ──

  it("R — pending trip join request surfaces as Action Needed item", async () => {
    const tripId = "aa000000-0000-0000-0000-000000000001";
    const requesterId = "bb000000-0000-0000-0000-000000000001";
    _setTestClient(makeClient({
      trips: [{ id: tripId, owner_id: ALICE_ID, destination_city: "Tokyo", status: "upcoming" }],
      trip_join_requests: [{
        id:         "cc000000-0000-0000-0000-000000000001",
        trip_id:    tripId,
        user_id:    requesterId,
        status:     "pending",
        created_at: in2h,
      }],
    }), true);
    const { body } = await req(app, "/api/pulse/live");
    const pending = (body.items as any[]).filter((i: any) => i.item_type === 'trip_request');
    assert.ok(pending.length >= 1, `expected trip_request item, got: ${JSON.stringify(body.items)}`);
    assert.equal(pending[0].status_label, "Action Needed");
    assert.ok((pending[0].title as string).includes("Tokyo"), "title should include destination");
  });

  it("R — blocked requester does not appear in join request count", async () => {
    const tripId = "aa000000-0000-0000-0000-000000000002";
    const blockedId = "dd000000-0000-0000-0000-000000000001";
    _setTestClient(makeClient({
      trips: [{ id: tripId, owner_id: ALICE_ID, destination_city: "Seoul", status: "active" }],
      trip_join_requests: [{
        id:         "cc000000-0000-0000-0000-000000000002",
        trip_id:    tripId,
        user_id:    blockedId,
        status:     "pending",
        created_at: in2h,
      }],
      blocks: [{ blocker_id: ALICE_ID, blocked_id: blockedId }],
    }), true);
    const { body } = await req(app, "/api/pulse/live");
    const pending = (body.items as any[]).filter((i: any) => i.item_type === 'trip_request');
    assert.equal(pending.length, 0, "blocked requester should not appear");
  });

  it("R — nearMe with coords returns gems within radius as Near You", async () => {
    // Manila: ~14.5995 N, 120.9842 E
    _setTestClient(makeClient({
      hidden_gems: [
        // within 50km of Manila
        { id: "ee000000-0000-0000-0000-000000000001", name: "Near Gem", city: "Manila", category: "cafe", save_count: 5, status: "active", latitude: 14.5995, longitude: 120.9842 },
        // >50km away (Baguio is ~250km)
        { id: "ee000000-0000-0000-0000-000000000002", name: "Far Gem", city: "Baguio", category: "spot", save_count: 10, status: "active", latitude: 16.4023, longitude: 120.5960 },
      ],
      feature_flags: [{ flag: "hidden_gems_enabled", enabled: true }],
    }), true);
    const { body } = await req(app, "/api/pulse/live?context=nearMe&lat=14.5995&lng=120.9842");
    const nearGems = (body.items as any[]).filter((i: any) =>
      i.item_type === 'hidden_gem' && (i.reason_labels as string[]).includes('Near You')
    );
    assert.ok(nearGems.length >= 1, `expected Near You gem, got: ${JSON.stringify(body.items)}`);
    const nearNames = nearGems.map((g: any) => g.title as string);
    assert.ok(nearNames.includes("Near Gem"), "Near Gem should be included");
    assert.ok(!nearNames.includes("Far Gem"), "Far Gem should be excluded by radius");
  });

  it("R — trip with join request AND member card: both appear (no dedup collision)", async () => {
    const tripId = "aa000000-0000-0000-0000-000000000003";
    const requesterId = "bb000000-0000-0000-0000-000000000002";
    // Alice is owner (trip appears as trip card) AND has a pending join request
    _setTestClient(makeClient({
      trips: [{ id: tripId, owner_id: ALICE_ID, destination_city: "Lisbon", status: "upcoming", title: "Lisbon Trip", start_date: in2h, end_date: in3days, visibility: "public" }],
      trip_members: [{ trip_id: tripId, user_id: ALICE_ID, role: "owner" }],
      trip_join_requests: [{
        id:         "cc000000-0000-0000-0000-000000000003",
        trip_id:    tripId,
        user_id:    requesterId,
        status:     "pending",
        created_at: in2h,
      }],
    }), true);
    const { body } = await req(app, "/api/pulse/live");
    const tripCards = (body.items as any[]).filter((i: any) => i.item_type === 'trip' && i.item_id === tripId);
    const requestCards = (body.items as any[]).filter((i: any) => i.item_type === 'trip_request' && i.item_id === tripId);
    assert.ok(tripCards.length >= 1, "trip plan card should appear");
    assert.ok(requestCards.length >= 1, `trip_request card should appear, got: ${JSON.stringify(body.items)}`);
    assert.equal(requestCards[0].status_label, "Action Needed");
  });

  it("Q — saved event already in rail via RSVP is not duplicated", async () => {
    const evId = "sa000000-0000-0000-0000-000000000002";
    _setTestClient(makeClient({
      event_saves: [{ event_id: evId, user_id: ALICE_ID }],
      event_rsvps: [{ event_id: evId, user_id: ALICE_ID, status: "going" }],
      events: [{
        id:            evId,
        host_id:       BOB_ID,
        title:         "RSVP + Saved Event",
        starts_at:     in2h,
        ends_at:       in3days,
        city:          "Manila",
        state:         "open",
        visibility:    "public",
        going_count:   1,
        max_attendees: null,
      }],
    }), true);
    const { body } = await req(app, "/api/pulse/live");
    const matches = (body.items as any[]).filter((i: any) => i.item_id === evId);
    assert.equal(matches.length, 1, "should appear only once (no duplicate)");
  });

  // ── O2. specificTrip validation — tripId required ────────────────────────

  it("O2 — context=specificTrip without tripId returns 400", async () => {
    _setTestClient(makeClient({}), true);
    const { status, body } = await req(app, "/api/pulse/live?context=specificTrip");
    assert.equal(status, 400, `expected 400, got ${status}: ${JSON.stringify(body)}`);
  });

  it("O2 — context=specificTrip with valid tripId returns 200", async () => {
    const tripId = "a0070000-0000-0000-0000-000000000001";
    _setTestClient(makeClient({
      trip_members: [{ trip_id: tripId, user_id: ALICE_ID, role: "owner" }],
      trips: [{
        id: tripId,
        owner_id: ALICE_ID,
        title: "Test Trip",
        destination_city: "Manila",
        start_date: new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString(),
        end_date:   new Date(Date.now() + 10 * 24 * 60 * 60_000).toISOString(),
        status: "planning",
        visibility: "private",
      }],
    }), true);
    const { status } = await req(app, `/api/pulse/live?context=specificTrip&tripId=${tripId}`);
    assert.equal(status, 200, `expected 200 with valid tripId`);
  });

  // ── P. Available buddies discovery cards ─────────────────────────────────

  it("P — approved buddy in city surfaces as available_buddy item", async () => {
    const buddyProfileId = "ba000000-0000-0000-0000-000000000001";
    const buddyUserId    = "ba000001-0000-0000-0000-000000000001";
    _setTestClient(makeClient({
      rent_buddy_profiles: [{
        id:                buddyProfileId,
        user_id:           buddyUserId,
        admin_status:      "active",
        city:              "Manila",
        bio:               "Local guide",
      }],
    }), true);
    const { body } = await req(app, "/api/pulse/live?citySlug=manila");
    const avail = (body.items as any[]).filter((i: any) => i.item_type === "available_buddy");
    assert.ok(avail.length >= 1, `expected available_buddy items, got: ${JSON.stringify(body.items)}`);
    assert.equal(avail[0].item_id, buddyProfileId, "item_id = buddy profile id");
    assert.equal(avail[0].is_joinable, true, "available buddy is joinable");
  });

  it("P — caller's own buddy profile is NOT returned as available_buddy", async () => {
    _setTestClient(makeClient({
      rent_buddy_profiles: [{
        id:                "ba000000-0000-0000-0000-000000000002",
        user_id:           ALICE_ID, // caller is Alice
        admin_status:      "active",
        city:              "Manila",
        bio:               "Own profile",
      }],
    }), true);
    const { body } = await req(app, "/api/pulse/live?citySlug=manila");
    const avail = (body.items as any[]).filter((i: any) => i.item_type === "available_buddy");
    assert.equal(avail.length, 0, "own profile excluded");
  });

  it("P — available_buddy NOT shown when no citySlug in request", async () => {
    _setTestClient(makeClient({
      rent_buddy_profiles: [{
        id:                "ba000000-0000-0000-0000-000000000003",
        user_id:           BOB_ID,
        moderation_status: "approved",
        city:              "Manila",
        bio:               "Guide",
      }],
    }), true);
    // No citySlug param — should not surface available_buddy cards
    const { body } = await req(app, "/api/pulse/live");
    const avail = (body.items as any[]).filter((i: any) => i.item_type === "available_buddy");
    assert.equal(avail.length, 0, "no citySlug = no available_buddy cards");
  });

  // ── Response shape ──────────────────────────────────────────────────────────

  it("response always has an items array", async () => {
    _setTestClient(makeClient({}), true);
    const { status, body } = await req(app, "/api/pulse/live");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.items), "items must be an array");
  });

  it("each item has required fields including is_joinable", async () => {
    _setTestClient(makeClient({
      events: [{
        id: "ev-shape-000-0000-000000000001",
        host_id: ALICE_ID,
        title: "Shape Test",
        starts_at: in2h,
        ends_at: in3days,
        city: "Manila",
        state: "open",
        visibility: "public",
        going_count: 0,
        max_attendees: null,
      }],
    }), true);

    const { body } = await req(app, "/api/pulse/live");
    const ev = (body.items as any[])[0];
    assert.ok(ev, "has at least one item");
    assert.ok("is_joinable" in ev, "is_joinable field present");
    assert.ok("item_type" in ev, "item_type field present");
    assert.ok("item_id" in ev, "item_id field present");
    assert.ok("status_label" in ev, "status_label field present");
    assert.ok(Array.isArray(ev.reason_labels), "reason_labels is array");
  });
});
