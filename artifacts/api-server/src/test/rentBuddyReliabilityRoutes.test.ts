/**
 * rentBuddyReliabilityRoutes.test.ts
 *
 * Route-level integration tests for the buddy reliability counters on
 * rent_buddy_profiles:
 *
 *  - POST /api/rent-a-buddy/bookings/:id/complete   → completed_count +1
 *  - POST /api/rent-a-buddy/bookings/:id/cancel     → cancel_count +1 (buddy cancels only)
 *  - POST /api/admin/buddy-bookings/:id/resolve-dispute
 *        (no_show dispute raised by traveler, resolved cancelled) → no_show_count +1
 *  - POST/DELETE /api/rent-a-buddy/saved/:buddyId          (legacy save routes)
 *  - POST/DELETE /api/rent-a-buddy/buddies/:buddyId/save   (marketplace save routes)
 *        → favorites_count recomputed from rent_buddy_saved
 *
 * Runtime: node:test + node:assert/strict
 * Run: node --import tsx/esm --test src/test/rentBuddyReliabilityRoutes.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { specAliasRewrite } from "../lib/specAliasRewrite.js";

const BUDDY_USER_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const TRAVELER_ID   = "bbbbbbbb-0000-0000-0000-000000000002";
const BP_ID         = "cccccccc-0000-0000-0000-000000000003";
const BOOKING_ID    = "dddddddd-0000-0000-0000-000000000004";
const ADMIN_ID      = "ffffffff-0000-0000-0000-000000000006";

// ── Stateful fake supabase client ─────────────────────────────────────────────
// Records every update() per table and serves canned single rows. Array-await
// resolves to canned list rows (used by the favorites recount).

interface FakeOpts {
  userId: string;
  bookingStatus: string;
  profileCounters?: Record<string, number>;
  profileRole?: string;                 // profiles.role for the caller
  savedRows?: Array<Record<string, any>>;
  checkinRows?: Array<Record<string, any>>;    // rows returned for rent_buddy_safety_checkins
  safetyEventRows?: Array<Record<string, any>>; // rows returned for rent_buddy_safety_events
  openDispute?: Record<string, any> | null;
  completingUserHasBuddyProfile?: boolean;
  bookingExists?: boolean;              // default true; set false to simulate unknown booking ID
}

function makeFakeClient(opts: FakeOpts) {
  const updates: Array<{ table: string; payload: Record<string, any> }> = [];
  const inserts: Array<{ table: string; payload: Record<string, any> }> = [];

  const booking = {
    id: BOOKING_ID, buddy_id: BP_ID, traveler_id: TRAVELER_ID,
    booking_date: "2026-08-01", start_time: "10:00", duration_h: 2,
    telegraph_thread_id: null, category: "city", total_usd: 100, city: "Manila",
    status: opts.bookingStatus,
  };

  const buddyProfile: Record<string, any> = {
    id: BP_ID, user_id: BUDDY_USER_ID, status: "active", admin_status: "active",
    completed_bookings: 0, completed_count: 0, cancel_count: 0,
    no_show_count: 0, favorites_count: 0,
    ...(opts.profileCounters ?? {}),
  };

  function singleRowFor(table: string, eqs: Record<string, any>): any {
    switch (table) {
      case "feature_flags":
        return { enabled: true };
      case "profiles":
        return { role: opts.profileRole ?? "user" };
      case "rent_buddy_bookings":
        return (opts.bookingExists ?? true) ? { ...booking } : null;
      case "rent_buddy_profiles":
        // Lookup by user_id (completing party's own buddy profile)
        if ("user_id" in eqs) {
          if (eqs.user_id === BUDDY_USER_ID) return { ...buddyProfile };
          return opts.completingUserHasBuddyProfile ? { ...buddyProfile } : null;
        }
        return { ...buddyProfile };
      case "rent_buddy_disputes":
        return opts.openDispute ?? null;
      case "trust_events":
        return { id: "mock-trust-ev-1" }; // short-circuits duplicate check
      default:
        return null;
    }
  }

  function makeBuilder(table: string): any {
    let op: "read" | "write" = "read";
    let payload: Record<string, any> = {};
    const eqs: Record<string, any> = {};
    const orderSpecs: Array<{ col: string; ascending: boolean }> = [];

    const b: any = {
      select: () => b,
      insert: (p: any) => { op = "write"; payload = p; inserts.push({ table, payload: p }); return b; },
      update: (p: any) => { op = "write"; payload = p; updates.push({ table, payload: p }); return b; },
      upsert: (p: any) => { op = "write"; payload = p; return b; },
      delete: () => { op = "write"; return b; },
      eq: (col: string, val: any) => { eqs[col] = val; return b; },
      neq: () => b, in: () => b, not: () => b, is: () => b,
      gte: () => b, lte: () => b, gt: () => b, lt: () => b,
      like: () => b, ilike: () => b, contains: () => b, overlaps: () => b,
      order: (col: string, orderOpts?: { ascending?: boolean }) => {
        orderSpecs.push({ col, ascending: orderOpts?.ascending ?? true });
        return b;
      },
      limit: () => b, range: () => b,
      single:      () => Promise.resolve({ data: op === "write" ? { id: "w1" } : singleRowFor(table, eqs), error: null }),
      maybeSingle: () => Promise.resolve({ data: op === "write" ? { id: "w1" } : singleRowFor(table, eqs), error: null }),
      then: (resolve: any, reject: any) => {
        let data: any;
        if (op === "write") {
          data = null;
        } else if (table === "rent_buddy_saved") {
          data = opts.savedRows ?? [];
        } else if (table === "rent_buddy_safety_checkins") {
          data = opts.checkinRows ?? [];
        } else if (table === "rent_buddy_safety_events") {
          data = opts.safetyEventRows ?? [];
        } else {
          const row = singleRowFor(table, eqs);
          data = row == null ? [] : [row];
        }
        // Apply recorded .order() specs so tests can verify sort direction.
        if (Array.isArray(data) && orderSpecs.length > 0) {
          data = [...data];
          for (const spec of [...orderSpecs].reverse()) {
            data.sort((a: any, z: any) => {
              const av = a[spec.col] ?? "";
              const zv = z[spec.col] ?? "";
              if (av < zv) return spec.ascending ? -1 : 1;
              if (av > zv) return spec.ascending ? 1 : -1;
              return 0;
            });
          }
        }
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return b;
  }

  return {
    updates,
    inserts,
    client: {
      auth: { getUser: () => Promise.resolve({ data: { user: { id: opts.userId } }, error: null }) },
      from: (table: string) => makeBuilder(table),
    },
  };
}

function profileUpdates(updates: Array<{ table: string; payload: any }>) {
  return updates.filter((u) => u.table === "rent_buddy_profiles").map((u) => u.payload);
}

// ── Server ─────────────────────────────────────────────────────────────────────

let server: ReturnType<typeof createServer>;
let port: number;

before(async () => {
  const { default: rentABuddyRouter } = await import("../routes/rentABuddy.js");
  const { default: rentABuddySpecRouter } = await import("../routes/rentABuddySpec.js");
  const { default: marketplaceRouter } = await import("../routes/rentABuddyMarketplace.js");
  const app = express();
  app.use(express.json());
  // Same alias rewrite as production so tests exercise the alias URLs the mobile
  // client actually calls (e.g. /api/admin/buddy-bookings/:id/resolve-dispute).
  app.use(specAliasRewrite);
  app.use("/api", rentABuddyRouter);
  app.use("/api", rentABuddySpecRouter);
  app.use("/api", marketplaceRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

after(async () => {
  await new Promise((r) => setTimeout(r, 250)); // drain fire-and-forget ops
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

async function call(method: string, path: string, fake: ReturnType<typeof makeFakeClient>, body: any = {}) {
  _setTestClient(fake.client as any, true);
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
}

// ── Completion ─────────────────────────────────────────────────────────────────

describe("completed_count — booking completion", () => {
  it("increments completed_count (canonical counter) on completion", async () => {
    const fake = makeFakeClient({
      userId: TRAVELER_ID, bookingStatus: "in_progress",
      profileCounters: { completed_bookings: 7, completed_count: 7 },
    });
    const res = await call("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/complete`, fake);
    assert.equal(res.status, 200);

    // completed_count is the single source of truth; completed_bookings is no
    // longer written on completion (legacy column, kept for historical reads).
    const pu = profileUpdates(fake.updates).find((p) => "completed_count" in p);
    assert.ok(pu, "expected a rent_buddy_profiles update with completed_count");
    assert.equal(pu.completed_count, 8);
    const legacy = profileUpdates(fake.updates).find((p) => "completed_bookings" in p);
    assert.ok(!legacy, "completed_bookings must no longer be written on completion");
  });
});

// ── Cancellation ───────────────────────────────────────────────────────────────

describe("cancel_count — booking cancellation", () => {
  it("increments cancel_count when the BUDDY cancels", async () => {
    const fake = makeFakeClient({
      userId: BUDDY_USER_ID, bookingStatus: "confirmed",
      profileCounters: { cancel_count: 2 },
    });
    const res = await call("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/cancel`, fake);
    assert.equal(res.status, 200);

    const pu = profileUpdates(fake.updates).find((p) => "cancel_count" in p);
    assert.ok(pu, "expected a cancel_count update");
    assert.equal(pu.cancel_count, 3);
  });

  it("does NOT touch cancel_count when the TRAVELER cancels", async () => {
    const fake = makeFakeClient({ userId: TRAVELER_ID, bookingStatus: "confirmed" });
    const res = await call("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/cancel`, fake);
    assert.equal(res.status, 200);
    assert.ok(!profileUpdates(fake.updates).some((p) => "cancel_count" in p));
  });
});

// ── Confirmed no-show ──────────────────────────────────────────────────────────

describe("no_show_count — admin dispute resolution", () => {
  it("increments when a traveler-raised no_show dispute is resolved as cancelled", async () => {
    const fake = makeFakeClient({
      userId: ADMIN_ID, profileRole: "admin", bookingStatus: "disputed",
      openDispute: { id: "disp-1", reason: "no_show", raised_by: TRAVELER_ID },
      profileCounters: { no_show_count: 1 },
    });
    // Call through the alias URL — specAliasRewrite rewrites it to the canonical
    // /api/rent-a-buddy/admin/bookings/:id/resolve-dispute handler in rentABuddySpec.ts.
    const res = await call("POST", `/api/admin/buddy-bookings/${BOOKING_ID}/resolve-dispute`, fake,
      { resolution: "no_show_confirmed", favorTraveler: true });
    assert.equal(res.status, 200);

    const pu = profileUpdates(fake.updates).find((p) => "no_show_count" in p);
    assert.ok(pu, "expected a no_show_count update");
    assert.equal(pu.no_show_count, 2);
  });

  it("does NOT increment when the dispute is resolved as completed", async () => {
    const fake = makeFakeClient({
      userId: ADMIN_ID, profileRole: "admin", bookingStatus: "disputed",
      openDispute: { id: "disp-1", reason: "no_show", raised_by: TRAVELER_ID },
    });
    const res = await call("POST", `/api/admin/buddy-bookings/${BOOKING_ID}/resolve-dispute`, fake,
      { resolution: "no_show_confirmed", favorTraveler: false });
    assert.equal(res.status, 200);
    assert.ok(!profileUpdates(fake.updates).some((p) => "no_show_count" in p));
  });

  it("does NOT increment when the buddy raised the no-show report", async () => {
    const fake = makeFakeClient({
      userId: ADMIN_ID, profileRole: "admin", bookingStatus: "disputed",
      openDispute: { id: "disp-1", reason: "no_show", raised_by: BUDDY_USER_ID },
    });
    const res = await call("POST", `/api/admin/buddy-bookings/${BOOKING_ID}/resolve-dispute`, fake,
      { resolution: "no_show_confirmed", favorTraveler: true });
    assert.equal(res.status, 200);
    assert.ok(!profileUpdates(fake.updates).some((p) => "no_show_count" in p));
  });
});

// ── Favorites — both route families ───────────────────────────────────────────

describe("favorites_count — save/unsave keeps the counter in sync", () => {
  const cases: Array<[string, string, string]> = [
    ["POST",   `/api/rent-a-buddy/saved/${BP_ID}`,          "legacy save"],
    ["DELETE", `/api/rent-a-buddy/saved/${BP_ID}`,          "legacy unsave"],
    ["POST",   `/api/rent-a-buddy/buddies/${BP_ID}/save`,   "marketplace save"],
    ["DELETE", `/api/rent-a-buddy/buddies/${BP_ID}/save`,   "marketplace unsave"],
  ];

  for (const [method, path, label] of cases) {
    it(`${label} recomputes favorites_count from rent_buddy_saved`, async () => {
      const fake = makeFakeClient({
        userId: TRAVELER_ID, bookingStatus: "pending",
        savedRows: [{ user_id: "u1" }, { user_id: "u2" }],
      });
      const res = await call(method, path, fake);
      assert.equal(res.status, 200, `${label}: expected 200, got ${res.status}`);

      const pu = profileUpdates(fake.updates).find((p) => "favorites_count" in p);
      assert.ok(pu, `${label}: expected a favorites_count update`);
      assert.equal(pu.favorites_count, 2);
    });
  }

  it("sets favorites_count to 0 when the last save is removed", async () => {
    const fake = makeFakeClient({ userId: TRAVELER_ID, bookingStatus: "pending", savedRows: [] });
    const res = await call("DELETE", `/api/rent-a-buddy/saved/${BP_ID}`, fake);
    assert.equal(res.status, 200);
    const pu = profileUpdates(fake.updates).find((p) => "favorites_count" in p);
    assert.ok(pu);
    assert.equal(pu.favorites_count, 0);
  });
});

// ── Safety check-in via alias URL ─────────────────────────────────────────────

describe("check-in — alias URL reachability", () => {
  it("creates a safety-checkin row when traveler POSTs via alias /api/buddy-bookings/:id/check-in", async () => {
    const fake = makeFakeClient({ userId: TRAVELER_ID, bookingStatus: "in_progress" });
    // Call through the alias URL — specAliasRewrite rewrites it to the canonical
    // /api/rent-a-buddy/bookings/:id/check-in handler in rentABuddySpec.ts.
    const res = await call(
      "POST",
      `/api/buddy-bookings/${BOOKING_ID}/check-in`,
      fake,
      { checkinType: "arrival" },
    );
    assert.equal(res.status, 201);

    const checkinInsert = fake.inserts.find((i) => i.table === "rent_buddy_safety_checkins");
    assert.ok(checkinInsert, "expected an insert into rent_buddy_safety_checkins");
    assert.equal(checkinInsert.payload.booking_id, BOOKING_ID);
    assert.equal(checkinInsert.payload.user_id, TRAVELER_ID);
    assert.equal(checkinInsert.payload.checkin_type, "arrival");
  });

  it("creates a safety-checkin row when buddy POSTs via alias /api/buddy-bookings/:id/check-in", async () => {
    const fake = makeFakeClient({ userId: BUDDY_USER_ID, bookingStatus: "in_progress" });
    const res = await call(
      "POST",
      `/api/buddy-bookings/${BOOKING_ID}/check-in`,
      fake,
      { checkinType: "comfort_30min", response: "all good" },
    );
    assert.equal(res.status, 201);

    const checkinInsert = fake.inserts.find((i) => i.table === "rent_buddy_safety_checkins");
    assert.ok(checkinInsert, "expected an insert into rent_buddy_safety_checkins");
    assert.equal(checkinInsert.payload.checkin_type, "comfort_30min");
    assert.equal(checkinInsert.payload.response, "all good");
  });

  it("returns 400 for an invalid checkinType via alias URL", async () => {
    const fake = makeFakeClient({ userId: TRAVELER_ID, bookingStatus: "in_progress" });
    const res = await call(
      "POST",
      `/api/buddy-bookings/${BOOKING_ID}/check-in`,
      fake,
      { checkinType: "not_a_real_type" },
    );
    assert.equal(res.status, 400);
    assert.equal(fake.inserts.filter((i) => i.table === "rent_buddy_safety_checkins").length, 0);
  });
});

// ── Report no-show via alias URL ──────────────────────────────────────────────

describe("report-no-show — alias URL reachability", () => {
  it("creates a safety event when traveler POSTs via alias /api/buddy-bookings/:id/report-no-show", async () => {
    const fake = makeFakeClient({ userId: TRAVELER_ID, bookingStatus: "in_progress" });
    // specAliasRewrite rewrites /api/buddy-bookings/* →
    // /api/rent-a-buddy/bookings/* before the canonical handler runs.
    const res = await call(
      "POST",
      `/api/buddy-bookings/${BOOKING_ID}/report-no-show`,
      fake,
      { notes: "buddy never showed up" },
    );
    assert.equal(res.status, 201);

    const eventInsert = fake.inserts.find((i) => i.table === "rent_buddy_safety_events");
    assert.ok(eventInsert, "expected an insert into rent_buddy_safety_events");
    assert.equal(eventInsert.payload.booking_id, BOOKING_ID);
    assert.equal(eventInsert.payload.actor_user_id, TRAVELER_ID);
    assert.equal(eventInsert.payload.event_type, "no_show");
    assert.equal(eventInsert.payload.event_status, "open");
    // traveler reports → target is the buddy's user_id (resolved via rent_buddy_profiles)
    assert.equal(eventInsert.payload.target_user_id, BUDDY_USER_ID);
  });

  it("creates a safety event when buddy POSTs via alias /api/buddy-bookings/:id/report-no-show", async () => {
    const fake = makeFakeClient({ userId: BUDDY_USER_ID, bookingStatus: "in_progress" });
    const res = await call(
      "POST",
      `/api/buddy-bookings/${BOOKING_ID}/report-no-show`,
      fake,
      { notes: "traveler was a no-show" },
    );
    assert.equal(res.status, 201);

    const eventInsert = fake.inserts.find((i) => i.table === "rent_buddy_safety_events");
    assert.ok(eventInsert, "expected an insert into rent_buddy_safety_events");
    assert.equal(eventInsert.payload.actor_user_id, BUDDY_USER_ID);
    // buddy reports → target is traveler_id directly
    assert.equal(eventInsert.payload.target_user_id, TRAVELER_ID);
  });
});

// ── toBuddyScoringData counter precedence ─────────────────────────────────────
//
// toBuddyScoringData picks completed_count ?? completed_bookings. When both
// columns exist with divergent values the canonical completed_count must win,
// because that is the column the scorer (and the ranking tie-break) reads.

function makeMatchFakeClient(buddyRow: Record<string, any>) {
  function makeBuilder(table: string): any {
    const b: any = {
      select:    () => b,
      insert:    () => b,
      upsert:    () => b,
      eq:        () => b,
      neq:       () => b,
      in:        () => b,
      not:       () => b,
      // `or` exists because every buddy-listing endpoint now resolves
      // fetchBlockedSet, which uses it. Without it the builder throws, the
      // resolver catches and returns null, and the endpoint correctly fails
      // CLOSED to an empty list — so these assertions would fail with
      // "0 !== 1" for a reason unrelated to what they test. This fake returns
      // rows only for rent_buddy_profiles, so `blocks` resolves empty and no
      // buddy is filtered.
      or:        () => b,
      is:        () => b,
      gte:       () => b,
      lte:       () => b,
      gt:        () => b,
      lt:        () => b,
      like:      () => b,
      ilike:     () => b,
      contains:  () => b,
      overlaps:  () => b,
      order:     () => b,
      limit:     () => b,
      range:     () => b,
      single:      () => Promise.resolve({ data: null, error: null }),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (resolve: any, reject: any) => {
        // The match endpoint fetches rent_buddy_profiles as an array and
        // trust_profiles as an array. Everything else is a write or unused.
        const data = table === "rent_buddy_profiles" ? [buddyRow] : [];
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return b;
  }

  return {
    client: {
      auth: { getUser: () => Promise.resolve({ data: { user: { id: TRAVELER_ID } }, error: null }) },
      from: (table: string) => makeBuilder(table),
    },
  };
}

// ── Non-party authorization — check-in and report-no-show ─────────────────────

const STRANGER_ID = "eeeeeeee-0000-0000-0000-000000000099";

describe("safety check-in — non-party receives 403", () => {
  it("returns 403 when a stranger calls POST /api/buddy-bookings/:id/check-in via alias URL", async () => {
    // The stranger is neither the traveler nor the buddy on this booking.
    // completingUserHasBuddyProfile is false (default) so rent_buddy_profiles
    // lookup returns null, making isParty false.
    const fake = makeFakeClient({
      userId: STRANGER_ID,
      bookingStatus: "in_progress",
      completingUserHasBuddyProfile: false,
    });
    const res = await call(
      "POST",
      `/api/buddy-bookings/${BOOKING_ID}/check-in`,
      fake,
      { checkinType: "arrival" },
    );
    assert.equal(res.status, 403, "non-party must be rejected with 403");
    const body = (await res.json()) as any;
    assert.equal(body.error, "forbidden");
  });
});

describe("report-no-show — non-party receives 403", () => {
  it("returns 403 when a stranger calls POST /api/buddy-bookings/:id/report-no-show via alias URL", async () => {
    // Same stranger — not the traveler and has no buddy profile linked to this
    // booking, so isParty evaluates to false.
    const fake = makeFakeClient({
      userId: STRANGER_ID,
      bookingStatus: "in_progress",
      completingUserHasBuddyProfile: false,
    });
    const res = await call(
      "POST",
      `/api/buddy-bookings/${BOOKING_ID}/report-no-show`,
      fake,
      { notes: "they never showed" },
    );
    assert.equal(res.status, 403, "non-party must be rejected with 403");
    const body = (await res.json()) as any;
    assert.equal(body.error, "forbidden");
  });
});

// ── POST /report-no-show — 404 for unknown booking ───────────────────────────
//
// The route fetches the booking row before any isParty check. When that row is
// absent the handler must respond with 404 / { error: "not_found" } so that
// callers cannot distinguish a missing booking from a forbidden one via a
// status-code difference.

describe("report-no-show — unknown booking returns 404", () => {
  it("returns 404 with { error: 'not_found' } when the booking does not exist", async () => {
    // bookingExists: false makes the fake client return null for rent_buddy_bookings,
    // simulating a POST against an unknown booking ID. The route must respond
    // with 404 before reaching the isParty check so callers cannot probe
    // booking existence from a 403 vs 404 difference.
    const UNKNOWN_BOOKING_ID = "00000000-0000-0000-0000-000000000000";
    const fake = makeFakeClient({
      userId: TRAVELER_ID,
      bookingStatus: "in_progress",
      bookingExists: false,
    });
    const res = await call(
      "POST",
      `/api/buddy-bookings/${UNKNOWN_BOOKING_ID}/report-no-show`,
      fake,
      { notes: "they never showed" },
    );
    assert.equal(res.status, 404, `expected 404 for unknown booking, got ${res.status}`);
    const body = (await res.json()) as any;
    assert.equal(body.error, "not_found");
  });
});

// ── Safety check-in history — non-party authorization ────────────────────────
//
// GET /api/rent-a-buddy/bookings/:bookingId/events (alias: /api/buddy-bookings/:id/events)
// returns safety check-in and event rows for a booking. The route enforces the
// same isParty check as the POST check-in and report-no-show handlers, so a
// stranger must receive 403 — not 200 with someone else's safety data.

describe("booking events (check-in history) — non-party receives 403", () => {
  it("returns 403 when a stranger calls GET /api/buddy-bookings/:id/events via alias URL", async () => {
    // The stranger is neither the traveler nor the buddy on this booking.
    // completingUserHasBuddyProfile defaults to false so the rent_buddy_profiles
    // lookup returns null, making isParty evaluate to false.
    const fake = makeFakeClient({
      userId: STRANGER_ID,
      bookingStatus: "in_progress",
      completingUserHasBuddyProfile: false,
    });
    const res = await call(
      "GET",
      `/api/buddy-bookings/${BOOKING_ID}/events`,
      fake,
    );
    assert.equal(res.status, 403, "non-party must be rejected with 403");
    const body = (await res.json()) as any;
    assert.equal(body.error, "forbidden");
    // No safety rows should have been read — the 403 fires before the DB fetch.
  });

  it("returns 200 and an events array when the traveler calls GET /api/buddy-bookings/:id/events", async () => {
    // TRAVELER_ID matches booking.traveler_id so isParty is true without needing
    // a rent_buddy_profiles row (completingUserHasBuddyProfile defaults to false).
    const fake = makeFakeClient({
      userId: TRAVELER_ID,
      bookingStatus: "in_progress",
      completingUserHasBuddyProfile: false,
    });
    const res = await call(
      "GET",
      `/api/buddy-bookings/${BOOKING_ID}/events`,
      fake,
    );
    assert.equal(res.status, 200, "traveler must receive 200");
    const body = (await res.json()) as any;
    assert.ok(Array.isArray(body.events), "response must include an events array");
  });

  it("returns 200 and an events array when the buddy calls GET /api/buddy-bookings/:id/events", async () => {
    // BUDDY_USER_ID's rent_buddy_profiles row has id=BP_ID which matches
    // booking.buddy_id, so isParty evaluates to true via the buddy branch.
    const fake = makeFakeClient({
      userId: BUDDY_USER_ID,
      bookingStatus: "in_progress",
      completingUserHasBuddyProfile: true,
    });
    const res = await call(
      "GET",
      `/api/buddy-bookings/${BOOKING_ID}/events`,
      fake,
    );
    assert.equal(res.status, 200, "buddy must receive 200");
    const body = (await res.json()) as any;
    assert.ok(Array.isArray(body.events), "response must include an events array");
  });

  it("returns 404 with { error: 'not_found' } when the booking does not exist", async () => {
    // bookingExists: false makes the fake client return null for rent_buddy_bookings,
    // simulating a lookup by an unknown booking ID. The route must respond with 404
    // before reaching the isParty check, so callers cannot infer booking existence
    // from a response-code difference between 403 and 404.
    const UNKNOWN_BOOKING_ID = "00000000-0000-0000-0000-000000000000";
    const fake = makeFakeClient({
      userId: TRAVELER_ID,
      bookingStatus: "in_progress",
      bookingExists: false,
    });
    const res = await call(
      "GET",
      `/api/buddy-bookings/${UNKNOWN_BOOKING_ID}/events`,
      fake,
    );
    assert.equal(res.status, 404, `expected 404 for unknown booking, got ${res.status}`);
    const body = (await res.json()) as any;
    assert.equal(body.error, "not_found");
  });

  it("returns 404 (not 403) when a non-party caller requests an unknown booking's events", async () => {
    // A stranger (not the traveler, not the buddy) requests events for a booking
    // that does not exist. The null-booking guard must fire before the isParty
    // check — if it were evaluated after, the response would be 403, leaking the
    // information that the booking ID is unknown to a non-party caller.
    const UNKNOWN_BOOKING_ID = "00000000-0000-0000-0000-000000000000";
    const fake = makeFakeClient({
      userId: STRANGER_ID,
      bookingStatus: "in_progress",
      bookingExists: false,
      completingUserHasBuddyProfile: false,
    });
    const res = await call(
      "GET",
      `/api/buddy-bookings/${UNKNOWN_BOOKING_ID}/events`,
      fake,
    );
    assert.equal(res.status, 404, `stranger on unknown booking must receive 404, got ${res.status}`);
    const body = (await res.json()) as any;
    assert.equal(body.error, "not_found");
  });
});

describe("complete — non-party receives 403", () => {
  it("returns 403 when a stranger calls POST /api/buddy-bookings/:id/complete via alias URL", async () => {
    // The stranger is neither the traveler nor the buddy on this booking.
    // completingUserHasBuddyProfile: false means rent_buddy_profiles lookup
    // returns null, so isParty evaluates to false and the route must reject
    // before touching any counters.
    const fake = makeFakeClient({
      userId: STRANGER_ID,
      bookingStatus: "in_progress",
      completingUserHasBuddyProfile: false,
    });
    const res = await call(
      "POST",
      `/api/buddy-bookings/${BOOKING_ID}/complete`,
      fake,
    );
    assert.equal(res.status, 403, "non-party must be rejected with 403");
    const body = (await res.json()) as any;
    assert.equal(body.error, "forbidden");
  });

  it("returns 404 with { error: 'not_found' } when the booking does not exist", async () => {
    // bookingExists: false makes the fake client return null for the booking
    // lookup, simulating a POST to an unknown booking ID. The route must
    // respond with 404 before reaching the isParty or status checks, so
    // callers cannot infer booking existence from a 403 vs 404 difference.
    const UNKNOWN_BOOKING_ID = "00000000-0000-0000-0000-000000000000";
    const fake = makeFakeClient({
      userId: TRAVELER_ID,
      bookingStatus: "in_progress",
      bookingExists: false,
    });
    const res = await call(
      "POST",
      `/api/buddy-bookings/${UNKNOWN_BOOKING_ID}/complete`,
      fake,
    );
    assert.equal(res.status, 404, `expected 404 for unknown booking, got ${res.status}`);
    const body = (await res.json()) as any;
    assert.equal(body.error, "not_found");
  });
});

describe("cancel — non-party receives 403", () => {
  it("returns 403 when a stranger calls POST /api/buddy-bookings/:id/cancel via alias URL", async () => {
    // Same stranger scenario — isParty is false so the cancel route must
    // return 403 before any booking or profile mutation occurs.
    const fake = makeFakeClient({
      userId: STRANGER_ID,
      bookingStatus: "in_progress",
      completingUserHasBuddyProfile: false,
    });
    const res = await call(
      "POST",
      `/api/buddy-bookings/${BOOKING_ID}/cancel`,
      fake,
    );
    assert.equal(res.status, 403, "non-party must be rejected with 403");
    const body = (await res.json()) as any;
    assert.equal(body.error, "forbidden");
  });

  it("returns 404 with { error: 'not_found' } when the booking does not exist", async () => {
    // bookingExists: false makes the fake client return null for the booking
    // lookup, simulating a POST to an unknown booking ID. The route must
    // respond with 404 before reaching the isParty or status checks, so
    // callers cannot infer booking existence from a 403 vs 404 difference.
    const UNKNOWN_BOOKING_ID = "00000000-0000-0000-0000-000000000000";
    const fake = makeFakeClient({
      userId: TRAVELER_ID,
      bookingStatus: "in_progress",
      bookingExists: false,
    });
    const res = await call(
      "POST",
      `/api/buddy-bookings/${UNKNOWN_BOOKING_ID}/cancel`,
      fake,
    );
    assert.equal(res.status, 404, `expected 404 for unknown booking, got ${res.status}`);
    const body = (await res.json()) as any;
    assert.equal(body.error, "not_found");
  });
});

// ── mapProfile counter precedence (display path) ──────────────────────────────
//
// mapProfile (rentABuddyMarketplace.ts) also reads completed_count ??
// completed_bookings when building the profile object returned to the mobile
// client. When the two columns disagree, completed_count must win so the
// "sessions completed" shown on buddy cards matches the canonical counter.

describe("mapProfile — completed_count takes precedence over completed_bookings", () => {
  it("returns completedBookings=7 (not 3) when completed_count=7 and completed_bookings=3", async () => {
    // Buddy row deliberately has the two counters out of sync.
    const buddyRow = {
      id: BP_ID, user_id: BUDDY_USER_ID,
      status: "active", admin_status: "active",
      city: "Manila", country: "Philippines",
      display_name: "Test Buddy", tagline: null,
      languages: ["English"], categories: ["city"],
      hourly_rate_usd: 20, half_day_rate_usd: null,
      full_day_rate_usd: null, nightlife_rate_usd: null, arrival_rate_usd: null,
      average_rating: null, review_count: 0,
      completed_bookings: 3,  // legacy counter — must be ignored
      completed_count: 7,     // canonical counter — must win
      response_time_h: null, cover_photo_url: null, gallery_urls: [],
      vibe_tags: [], safety_badges: [], buddy_level: "experienced",
      verified: false, featured: false, city_ambassador: false,
      available_now: false, female_only_service: false, public_meetup_only: false,
      group_approved: false, nightlife_approved: false,
      energy_type: null, max_group_size: 4,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };

    // makeMatchFakeClient returns [buddyRow] for any rent_buddy_profiles query,
    // which is exactly what GET /cities/:city/top needs.
    const fake = makeMatchFakeClient(buddyRow);
    const res = await call("GET", "/api/rent-a-buddy/cities/Manila/top", fake as any);

    assert.equal(res.status, 200, "cities/top should return 200");
    const body = (await res.json()) as any;
    assert.ok(Array.isArray(body.buddies), "response.buddies should be an array");
    assert.equal(body.buddies.length, 1, "should return the one buddy");

    const profile = body.buddies[0];
    assert.equal(
      profile.completedBookings,
      7,
      `mapProfile must use completed_count=7, not completed_bookings=3; got ${profile.completedBookings}`,
    );
  });
});

// ── match display card counter precedence ────────────────────────────────────
//
// POST /api/rent-a-buddy/match merges mapProfile(row) with the scoring result.
// mapProfile reads completed_count ?? completed_bookings. When the two counters
// disagree, completed_count must win so the "sessions completed" displayed on
// buddy cards is accurate — even if a future refactor reorders the spread.

describe("match display cards — completed_count takes precedence over completed_bookings", () => {
  it("returns completedBookings=7 (not 3) in results[0] when completed_count=7 and completed_bookings=3", async () => {
    const buddyRow = {
      id: BP_ID, user_id: BUDDY_USER_ID, city: "Manila",
      status: "active", admin_status: "active",
      display_name: "Test Buddy", tagline: null,
      country: "Philippines",
      categories: ["city"], languages: ["English"],
      hourly_rate_usd: 20, half_day_rate_usd: null, full_day_rate_usd: null,
      nightlife_rate_usd: null, arrival_rate_usd: null,
      vibe_tags: [], safety_badges: [], energy_type: null, buddy_level: "experienced",
      average_rating: null, review_count: 0,
      completed_bookings: 3,  // legacy column — must be ignored
      completed_count: 7,     // canonical counter — must win
      response_time_h: null, cover_photo_url: null, gallery_urls: [],
      verified: false, featured: false, city_ambassador: false,
      available_now: true, female_only_service: false, public_meetup_only: false,
      group_approved: true, nightlife_approved: false, arrival_approved: false,
      category_approvals: {}, max_group_size: 4,
      new_buddy_public_only: false, new_buddy_daytime_only: false,
      risk_hold: false, created_at: new Date().toISOString(),
    };

    const fake = makeMatchFakeClient(buddyRow);
    const res = await call("POST", "/api/rent-a-buddy/match", fake, { city: "Manila" });

    assert.equal(res.status, 200, "match endpoint should return 200");
    const body = (await res.json()) as any;
    assert.ok(Array.isArray(body.results), "response.results should be an array");
    assert.equal(body.results.length, 1, "should return the one eligible buddy");

    // This is the display-card field (mapProfile path), not the scorer.
    // The spread { ...mapProfile(row), compatibilityScore, scoreBreakdown }
    // must not shadow completedBookings — completed_count=7 must win.
    assert.equal(
      body.results[0].completedBookings,
      7,
      `display card must show completed_count=7, not completed_bookings=3; got ${body.results[0].completedBookings}`,
    );
  });
});

// ── GET /safety-checkins — authorization ─────────────────────────────────────
//
// GET /api/rent-a-buddy/bookings/:bookingId/safety-checkins
// (alias: /api/buddy-bookings/:bookingId/safety-checkins)
//
// The route enforces an isParty check identical to the POST check-in handler:
// only the traveler and the buddy on the booking may read check-in history.
// A stranger must receive 403; the traveler and buddy must receive 200.

describe("GET safety-checkins — non-party receives 403", () => {
  it("returns 403 when a stranger calls GET /api/rent-a-buddy/bookings/:id/safety-checkins", async () => {
    // The stranger is neither the traveler nor the buddy on this booking.
    // completingUserHasBuddyProfile: false means the rent_buddy_profiles lookup
    // returns null, so the isParty check evaluates to false.
    const fake = makeFakeClient({
      userId: STRANGER_ID,
      bookingStatus: "in_progress",
      completingUserHasBuddyProfile: false,
    });
    const res = await call(
      "GET",
      `/api/rent-a-buddy/bookings/${BOOKING_ID}/safety-checkins`,
      fake,
    );
    assert.equal(res.status, 403, `non-party must receive 403 (got ${res.status})`);
    const body = (await res.json()) as any;
    assert.equal(body.error, "forbidden");
  });

  it("returns 403 when a stranger calls GET /api/buddy-bookings/:id/safety-checkins via alias URL", async () => {
    // Same contract exercised through the alias path that the mobile client uses.
    const fake = makeFakeClient({
      userId: STRANGER_ID,
      bookingStatus: "in_progress",
      completingUserHasBuddyProfile: false,
    });
    const res = await call(
      "GET",
      `/api/buddy-bookings/${BOOKING_ID}/safety-checkins`,
      fake,
    );
    assert.equal(res.status, 403, `non-party must receive 403 via alias (got ${res.status})`);
    const body = (await res.json()) as any;
    assert.equal(body.error, "forbidden");
  });
});

describe("GET safety-checkins — traveler and buddy receive 200", () => {
  it("returns 200 and a checkins array when the traveler calls GET /api/rent-a-buddy/bookings/:id/safety-checkins", async () => {
    // TRAVELER_ID matches booking.traveler_id so isParty is true without
    // needing a rent_buddy_profiles row.
    const fake = makeFakeClient({
      userId: TRAVELER_ID,
      bookingStatus: "in_progress",
      completingUserHasBuddyProfile: false,
    });
    const res = await call(
      "GET",
      `/api/rent-a-buddy/bookings/${BOOKING_ID}/safety-checkins`,
      fake,
    );
    assert.equal(res.status, 200, `traveler must receive 200 (got ${res.status})`);
    const body = (await res.json()) as any;
    assert.ok(Array.isArray(body.checkins), "response must include a checkins array");
  });

  it("returns 200 and a checkins array when the traveler calls GET /api/buddy-bookings/:id/safety-checkins via alias URL", async () => {
    const fake = makeFakeClient({
      userId: TRAVELER_ID,
      bookingStatus: "in_progress",
      completingUserHasBuddyProfile: false,
    });
    const res = await call(
      "GET",
      `/api/buddy-bookings/${BOOKING_ID}/safety-checkins`,
      fake,
    );
    assert.equal(res.status, 200, `traveler must receive 200 via alias (got ${res.status})`);
    const body = (await res.json()) as any;
    assert.ok(Array.isArray(body.checkins), "response must include a checkins array");
  });

  it("returns 200 and a checkins array when the buddy calls GET /api/rent-a-buddy/bookings/:id/safety-checkins", async () => {
    // BUDDY_USER_ID's rent_buddy_profiles row has id=BP_ID which matches
    // booking.buddy_id, so isParty evaluates to true via the buddy branch.
    const fake = makeFakeClient({
      userId: BUDDY_USER_ID,
      bookingStatus: "in_progress",
      completingUserHasBuddyProfile: true,
    });
    const res = await call(
      "GET",
      `/api/rent-a-buddy/bookings/${BOOKING_ID}/safety-checkins`,
      fake,
    );
    assert.equal(res.status, 200, `buddy must receive 200 (got ${res.status})`);
    const body = (await res.json()) as any;
    assert.ok(Array.isArray(body.checkins), "response must include a checkins array");
  });

  it("returns 200 and a checkins array when the buddy calls GET /api/buddy-bookings/:id/safety-checkins via alias URL", async () => {
    const fake = makeFakeClient({
      userId: BUDDY_USER_ID,
      bookingStatus: "in_progress",
      completingUserHasBuddyProfile: true,
    });
    const res = await call(
      "GET",
      `/api/buddy-bookings/${BOOKING_ID}/safety-checkins`,
      fake,
    );
    assert.equal(res.status, 200, `buddy must receive 200 via alias (got ${res.status})`);
    const body = (await res.json()) as any;
    assert.ok(Array.isArray(body.checkins), "response must include a checkins array");
  });
});

// ── GET /safety-checkins — ascending created_at order ────────────────────────
//
// The route calls .order("created_at", { ascending: true }) so the mobile
// client always sees oldest-first. Supplying rows out of order through the
// fake verifies that the sort clause is present: if it were dropped, the fake
// would return the rows in insertion order (newest-first) and the assertion
// would fail.

describe("GET safety-checkins — rows arrive in ascending created_at order", () => {
  it("returns checkins sorted oldest-first when the traveler calls GET /api/rent-a-buddy/bookings/:id/safety-checkins", async () => {
    // Rows supplied newest-first; the route's .order("created_at", { ascending: true })
    // must re-sort them so the response arrives oldest-first.
    const checkinRows = [
      { id: "c3", booking_id: BOOKING_ID, created_at: "2026-08-01T12:00:00.000Z" },
      { id: "c1", booking_id: BOOKING_ID, created_at: "2026-08-01T10:00:00.000Z" },
      { id: "c2", booking_id: BOOKING_ID, created_at: "2026-08-01T11:00:00.000Z" },
    ];
    const fake = makeFakeClient({
      userId: TRAVELER_ID,
      bookingStatus: "in_progress",
      completingUserHasBuddyProfile: false,
      checkinRows,
    });
    const res = await call(
      "GET",
      `/api/rent-a-buddy/bookings/${BOOKING_ID}/safety-checkins`,
      fake,
    );
    assert.equal(res.status, 200, `traveler must receive 200 (got ${res.status})`);
    const body = (await res.json()) as any;
    assert.ok(Array.isArray(body.checkins), "response must include a checkins array");
    assert.equal(body.checkins.length, 3, "all three checkin rows must be present");
    const timestamps: string[] = body.checkins.map((c: any) => c.created_at);
    assert.deepEqual(
      timestamps,
      [...timestamps].sort(),
      "checkins must arrive in ascending created_at order",
    );
  });
});

// ── GET /safety-events — authorization ───────────────────────────────────────
//
// GET /api/rent-a-buddy/bookings/:bookingId/safety-events
// (alias: /api/buddy-bookings/:bookingId/safety-events)
//
// The route enforces the same isParty check as the report-no-show handler:
// only the traveler and the buddy on the booking may read safety event history.
// A stranger must receive 403; the traveler and buddy must receive 200.

describe("GET safety-events — non-party receives 403", () => {
  it("returns 403 when a stranger calls GET /api/rent-a-buddy/bookings/:id/safety-events", async () => {
    // The stranger is neither the traveler nor the buddy on this booking.
    const fake = makeFakeClient({
      userId: STRANGER_ID,
      bookingStatus: "in_progress",
      completingUserHasBuddyProfile: false,
    });
    const res = await call(
      "GET",
      `/api/rent-a-buddy/bookings/${BOOKING_ID}/safety-events`,
      fake,
    );
    assert.equal(res.status, 403, `non-party must receive 403 (got ${res.status})`);
    const body = (await res.json()) as any;
    assert.equal(body.error, "forbidden");
  });

  it("returns 403 when a stranger calls GET /api/buddy-bookings/:id/safety-events via alias URL", async () => {
    const fake = makeFakeClient({
      userId: STRANGER_ID,
      bookingStatus: "in_progress",
      completingUserHasBuddyProfile: false,
    });
    const res = await call(
      "GET",
      `/api/buddy-bookings/${BOOKING_ID}/safety-events`,
      fake,
    );
    assert.equal(res.status, 403, `non-party must receive 403 via alias (got ${res.status})`);
    const body = (await res.json()) as any;
    assert.equal(body.error, "forbidden");
  });
});

describe("GET safety-events — traveler and buddy receive 200", () => {
  it("returns 200 and a safetyEvents array when the traveler calls GET /api/rent-a-buddy/bookings/:id/safety-events", async () => {
    // TRAVELER_ID matches booking.traveler_id so isParty is true.
    const fake = makeFakeClient({
      userId: TRAVELER_ID,
      bookingStatus: "in_progress",
      completingUserHasBuddyProfile: false,
    });
    const res = await call(
      "GET",
      `/api/rent-a-buddy/bookings/${BOOKING_ID}/safety-events`,
      fake,
    );
    assert.equal(res.status, 200, `traveler must receive 200 (got ${res.status})`);
    const body = (await res.json()) as any;
    assert.ok(Array.isArray(body.safetyEvents), "response must include a safetyEvents array");
  });

  it("returns 200 and a safetyEvents array when the traveler calls GET /api/buddy-bookings/:id/safety-events via alias URL", async () => {
    const fake = makeFakeClient({
      userId: TRAVELER_ID,
      bookingStatus: "in_progress",
      completingUserHasBuddyProfile: false,
    });
    const res = await call(
      "GET",
      `/api/buddy-bookings/${BOOKING_ID}/safety-events`,
      fake,
    );
    assert.equal(res.status, 200, `traveler must receive 200 via alias (got ${res.status})`);
    const body = (await res.json()) as any;
    assert.ok(Array.isArray(body.safetyEvents), "response must include a safetyEvents array");
  });

  it("returns 200 and a safetyEvents array when the buddy calls GET /api/rent-a-buddy/bookings/:id/safety-events", async () => {
    // BUDDY_USER_ID's rent_buddy_profiles row has id=BP_ID which matches
    // booking.buddy_id, so isParty evaluates to true via the buddy branch.
    const fake = makeFakeClient({
      userId: BUDDY_USER_ID,
      bookingStatus: "in_progress",
      completingUserHasBuddyProfile: true,
    });
    const res = await call(
      "GET",
      `/api/rent-a-buddy/bookings/${BOOKING_ID}/safety-events`,
      fake,
    );
    assert.equal(res.status, 200, `buddy must receive 200 (got ${res.status})`);
    const body = (await res.json()) as any;
    assert.ok(Array.isArray(body.safetyEvents), "response must include a safetyEvents array");
  });

  it("returns 200 and a safetyEvents array when the buddy calls GET /api/buddy-bookings/:id/safety-events via alias URL", async () => {
    const fake = makeFakeClient({
      userId: BUDDY_USER_ID,
      bookingStatus: "in_progress",
      completingUserHasBuddyProfile: true,
    });
    const res = await call(
      "GET",
      `/api/buddy-bookings/${BOOKING_ID}/safety-events`,
      fake,
    );
    assert.equal(res.status, 200, `buddy must receive 200 via alias (got ${res.status})`);
    const body = (await res.json()) as any;
    assert.ok(Array.isArray(body.safetyEvents), "response must include a safetyEvents array");
  });
});

// ── GET /safety-checkins — 404 for unknown booking ───────────────────────────
//
// The route fetches the booking row before the isParty check. When the booking
// does not exist it must return 404 so callers can distinguish "booking not
// found" from "you are not on this booking" (403).

describe("GET safety-checkins — unknown booking returns 404", () => {
  it("returns 404 with { error: 'not_found' } when the booking does not exist", async () => {
    // bookingExists: false makes the fake client return null for rent_buddy_bookings,
    // simulating a GET by an unknown booking ID. The route must respond with 404
    // before reaching the isParty check so callers cannot infer booking existence
    // from a response-code difference between 403 and 404.
    const UNKNOWN_BOOKING_ID = "00000000-0000-0000-0000-000000000000";
    const fake = makeFakeClient({
      userId: TRAVELER_ID,
      bookingStatus: "in_progress",
      bookingExists: false,
    });
    const res = await call(
      "GET",
      `/api/rent-a-buddy/bookings/${UNKNOWN_BOOKING_ID}/safety-checkins`,
      fake,
    );
    assert.equal(res.status, 404, `expected 404 for unknown booking, got ${res.status}`);
    const body = (await res.json()) as any;
    assert.equal(body.error, "not_found");
  });
});

// ── GET /safety-events — 404 for unknown booking ─────────────────────────────
//
// Same guard for the safety-events route: 404 must be returned before the
// isParty check when the booking row is absent.

describe("GET safety-events — unknown booking returns 404", () => {
  it("returns 404 with { error: 'not_found' } when the booking does not exist", async () => {
    // bookingExists: false makes the fake client return null for rent_buddy_bookings,
    // simulating a GET by an unknown booking ID. The route must respond with 404
    // before reaching the isParty check so callers cannot infer booking existence
    // from a response-code difference between 403 and 404.
    const UNKNOWN_BOOKING_ID = "00000000-0000-0000-0000-000000000000";
    const fake = makeFakeClient({
      userId: TRAVELER_ID,
      bookingStatus: "in_progress",
      bookingExists: false,
    });
    const res = await call(
      "GET",
      `/api/rent-a-buddy/bookings/${UNKNOWN_BOOKING_ID}/safety-events`,
      fake,
    );
    assert.equal(res.status, 404, `expected 404 for unknown booking, got ${res.status}`);
    const body = (await res.json()) as any;
    assert.equal(body.error, "not_found");
  });
});

// ── GET /safety-events — ascending created_at order ──────────────────────────
//
// The route calls .order("created_at", { ascending: true }) so the mobile
// client always sees oldest-first. Supplying rows out of order through the
// fake verifies that the sort clause is present: if it were dropped, the fake
// would return the rows in insertion order (newest-first) and the assertion
// would fail.

describe("GET safety-events — rows arrive in ascending created_at order", () => {
  it("returns safetyEvents sorted oldest-first when the traveler calls GET /api/rent-a-buddy/bookings/:id/safety-events", async () => {
    // Rows supplied newest-first; the route's .order("created_at", { ascending: true })
    // must re-sort them so the response arrives oldest-first.
    const safetyEventRows = [
      { id: "e3", booking_id: BOOKING_ID, created_at: "2026-08-01T12:00:00.000Z" },
      { id: "e1", booking_id: BOOKING_ID, created_at: "2026-08-01T10:00:00.000Z" },
      { id: "e2", booking_id: BOOKING_ID, created_at: "2026-08-01T11:00:00.000Z" },
    ];
    const fake = makeFakeClient({
      userId: TRAVELER_ID,
      bookingStatus: "in_progress",
      completingUserHasBuddyProfile: false,
      safetyEventRows,
    });
    const res = await call(
      "GET",
      `/api/rent-a-buddy/bookings/${BOOKING_ID}/safety-events`,
      fake,
    );
    assert.equal(res.status, 200, `traveler must receive 200 (got ${res.status})`);
    const body = (await res.json()) as any;
    assert.ok(Array.isArray(body.safetyEvents), "response must include a safetyEvents array");
    assert.equal(body.safetyEvents.length, 3, "all three safety event rows must be present");
    const timestamps: string[] = body.safetyEvents.map((e: any) => e.created_at);
    assert.deepEqual(
      timestamps,
      [...timestamps].sort(),
      "safety events must arrive in ascending created_at order",
    );
  });
});

// ── toBuddyScoringData counter precedence ─────────────────────────────────────
//
// toBuddyScoringData picks completed_count ?? completed_bookings. When both
// columns exist with divergent values the canonical completed_count must win,
// because that is the column the scorer (and the ranking tie-break) reads.

// ── Terminal-state guard — complete ───────────────────────────────────────────
//
// POST /api/rent-a-buddy/bookings/:bookingId/complete (alias: /api/buddy-bookings/:id/complete)
// must reject with a non-2xx response when the booking is already in a terminal
// state (e.g. "completed"), preventing double-completion and counter inflation.

describe("complete — terminal state is rejected", () => {
  it("returns 409 when the booking is already 'completed' via alias /api/buddy-bookings/:id/complete", async () => {
    // The traveler is a valid party member on this booking, so the isParty check
    // passes. The status check fires next and must reject with 409.
    const fake = makeFakeClient({
      userId: TRAVELER_ID,
      bookingStatus: "completed",
    });
    const res = await call(
      "POST",
      `/api/buddy-bookings/${BOOKING_ID}/complete`,
      fake,
    );
    assert.equal(res.status, 409, `expected 409, got ${res.status}`);
    const body = (await res.json()) as any;
    assert.equal(body.error, "invalid_transition", "expected error: invalid_transition");
    // No profile counter must have been updated.
    assert.equal(
      fake.updates.filter((u) => u.table === "rent_buddy_profiles").length,
      0,
      "no profile update must occur when the booking is already completed",
    );
  });

  it("returns 409 when the booking is 'completed_pending_traveler_confirmation' via alias /api/buddy-bookings/:id/complete", async () => {
    // The buddy has already marked the booking done; it is now awaiting traveler
    // confirmation. A redundant complete call must be rejected — the status guard
    // only allows transitions from 'in_progress', so this terminal-adjacent state
    // must produce 409 and leave rent_buddy_profiles untouched.
    const fake = makeFakeClient({
      userId: TRAVELER_ID,
      bookingStatus: "completed_pending_traveler_confirmation",
    });
    const res = await call(
      "POST",
      `/api/buddy-bookings/${BOOKING_ID}/complete`,
      fake,
    );
    assert.equal(res.status, 409, `expected 409, got ${res.status}`);
    const body = (await res.json()) as any;
    assert.equal(body.error, "invalid_transition", "expected error: invalid_transition");
    // No profile counter must have been updated — double increment must be prevented.
    assert.equal(
      fake.updates.filter((u) => u.table === "rent_buddy_profiles").length,
      0,
      "no profile update must occur when the booking is completed_pending_traveler_confirmation",
    );
  });

  it("returns 409 when the booking is 'disputed' via alias /api/buddy-bookings/:id/complete", async () => {
    // A disputed booking is a terminal-adjacent state where a dispute has been
    // raised by one of the parties. The status guard only allows completion from
    // 'in_progress', so calling complete on a disputed booking must be rejected
    // with 409 — preventing the buddy's counter from being incorrectly incremented.
    const fake = makeFakeClient({
      userId: TRAVELER_ID,
      bookingStatus: "disputed",
    });
    const res = await call(
      "POST",
      `/api/buddy-bookings/${BOOKING_ID}/complete`,
      fake,
    );
    assert.equal(res.status, 409, `expected 409, got ${res.status}`);
    const body = (await res.json()) as any;
    assert.equal(body.error, "invalid_transition", "expected error: invalid_transition");
    // No profile counter must have been updated — completing a disputed booking
    // must not inflate the buddy's earned or completion metrics.
    assert.equal(
      fake.updates.filter((u) => u.table === "rent_buddy_profiles").length,
      0,
      "no profile update must occur when the booking is disputed",
    );
  });
});

// ── Terminal-state guard — cancel ─────────────────────────────────────────────
//
// POST /api/rent-a-buddy/bookings/:bookingId/cancel (alias: /api/buddy-bookings/:id/cancel)
// must reject with a non-2xx response when the booking is already in a terminal
// state (e.g. "cancelled"), preventing double-cancellation and counter inflation.

describe("cancel — terminal state is rejected", () => {
  it("returns 409 when the booking is already 'cancelled' via alias /api/buddy-bookings/:id/cancel", async () => {
    // The traveler is a valid party member, so the isParty check passes.
    // The status check fires next and must reject with 409 because "cancelled"
    // is not in cancellableStatuses ["pending", "confirmed", "scheduled"].
    const fake = makeFakeClient({
      userId: TRAVELER_ID,
      bookingStatus: "cancelled",
    });
    const res = await call(
      "POST",
      `/api/buddy-bookings/${BOOKING_ID}/cancel`,
      fake,
    );
    assert.equal(res.status, 409, `expected 409, got ${res.status}`);
    const body = (await res.json()) as any;
    assert.equal(body.error, "invalid_transition", "expected error: invalid_transition");
    // No profile counter must have been updated.
    assert.equal(
      fake.updates.filter((u) => u.table === "rent_buddy_profiles").length,
      0,
      "no profile update must occur when the booking is already cancelled",
    );
  });

  it("returns 409 when the booking is 'in_progress' via alias /api/buddy-bookings/:id/cancel", async () => {
    // The traveler is a valid party member, so the isParty check passes.
    // The status check fires next and must reject with 409 because "in_progress"
    // is not in cancellableStatuses ["pending", "confirmed", "scheduled"].
    // An in_progress session must never be silently cancelled mid-session.
    const fake = makeFakeClient({
      userId: TRAVELER_ID,
      bookingStatus: "in_progress",
    });
    const res = await call(
      "POST",
      `/api/buddy-bookings/${BOOKING_ID}/cancel`,
      fake,
    );
    assert.equal(res.status, 409, `expected 409, got ${res.status}`);
    const body = (await res.json()) as any;
    assert.equal(body.error, "invalid_transition", "expected error: invalid_transition");
    // No profile counter must have been updated.
    assert.equal(
      fake.updates.filter((u) => u.table === "rent_buddy_profiles").length,
      0,
      "no profile update must occur when the booking is in_progress",
    );
  });

  it("returns 409 when the booking is 'completed' via alias /api/buddy-bookings/:id/cancel", async () => {
    // The traveler is a valid party member, so the isParty check passes.
    // The status check fires next and must reject with 409 because "completed"
    // is not in cancellableStatuses ["pending", "confirmed", "scheduled"].
    // A completed session must never be silently cancelled after the fact.
    const fake = makeFakeClient({
      userId: TRAVELER_ID,
      bookingStatus: "completed",
    });
    const res = await call(
      "POST",
      `/api/buddy-bookings/${BOOKING_ID}/cancel`,
      fake,
    );
    assert.equal(res.status, 409, `expected 409, got ${res.status}`);
    const body = (await res.json()) as any;
    assert.equal(body.error, "invalid_transition", "expected error: invalid_transition");
    // No profile counter must have been updated.
    assert.equal(
      fake.updates.filter((u) => u.table === "rent_buddy_profiles").length,
      0,
      "no profile update must occur when the booking is already completed",
    );
  });

  it("returns 409 when the booking is 'disputed' via alias /api/buddy-bookings/:id/cancel", async () => {
    // The traveler is a valid party member, so the isParty check passes.
    // The status check fires next and must reject with 409 because "disputed"
    // is not in cancellableStatuses ["pending", "confirmed", "scheduled"].
    // A disputed booking must never be silently cancelled — dispute resolution
    // is the only valid exit path.
    const fake = makeFakeClient({
      userId: TRAVELER_ID,
      bookingStatus: "disputed",
    });
    const res = await call(
      "POST",
      `/api/buddy-bookings/${BOOKING_ID}/cancel`,
      fake,
    );
    assert.equal(res.status, 409, `expected 409, got ${res.status}`);
    const body = (await res.json()) as any;
    assert.equal(body.error, "invalid_transition", "expected error: invalid_transition");
    // No profile counter must have been updated.
    assert.equal(
      fake.updates.filter((u) => u.table === "rent_buddy_profiles").length,
      0,
      "no profile update must occur when the booking is disputed",
    );
  });
});

// ── available-now display cards — completed_count precedence ─────────────────
//
// GET /api/rent-a-buddy/available-now returns buddies built via mapProfile().
// mapProfile picks completed_count ?? completed_bookings. When both columns are
// present with divergent values the canonical completed_count must win so the
// session count shown on these high-priority cards is always correct.

describe("available-now — completed_count takes precedence over completed_bookings in display cards", () => {
  it("returns completedBookings=5 (not 1) when completed_count=5 and completed_bookings=1", async () => {
    // Buddy row has both counters with different values.
    // completed_count is the canonical column written by the completion route;
    // completed_bookings is the legacy column. mapProfile must prefer
    // completed_count so the display card shows 5, not 1.
    const buddyRow = {
      id: BP_ID, user_id: BUDDY_USER_ID, city: "Bangkok",
      status: "active", admin_status: "active",
      categories: ["city"], languages: ["English"],
      hourly_rate_usd: 25, half_day_rate_usd: null, full_day_rate_usd: null,
      vibe_tags: [], energy_type: null, buddy_level: "experienced",
      average_rating: null, review_count: 0,
      completed_bookings: 1,  // legacy counter — should be ignored
      completed_count: 5,     // canonical counter — must win
      response_time_h: null, verified: false, featured: false,
      city_ambassador: false, available_now: true,
      female_only_service: false, public_meetup_only: false,
      group_approved: true, nightlife_approved: false, arrival_approved: false,
      category_approvals: {}, max_group_size: 4,
      new_buddy_public_only: false, new_buddy_daytime_only: false,
      risk_hold: false, created_at: new Date().toISOString(),
    };

    const fake = makeMatchFakeClient(buddyRow);
    const res = await call("GET", "/api/rent-a-buddy/available-now", fake);

    assert.equal(res.status, 200, `available-now should return 200, got ${res.status}`);
    const body = (await res.json()) as any;
    assert.ok(Array.isArray(body.buddies), "response.buddies should be an array");
    assert.equal(body.buddies.length, 1, "should return the one available buddy");

    // mapProfile: completedBookings: row.completed_count ?? row.completed_bookings ?? 0
    // With completed_count=5  → completedBookings=5  ← expected
    // With completed_bookings=1 → completedBookings=1  ← would indicate a regression
    assert.equal(
      body.buddies[0].completedBookings,
      5,
      `display card must use completed_count=5, not completed_bookings=1; got ${body.buddies[0].completedBookings}`,
    );
  });
});

// ── toBuddyScoringData counter precedence ─────────────────────────────────────

// ── sections display card counter precedence ──────────────────────────────────
//
// GET /api/rent-a-buddy/sections returns 13 discovery sections. Each section
// calls mapProfile(row) to build the display card. mapProfile reads
// completed_count ?? completed_bookings. When the two counters disagree,
// completed_count must win so the "sessions completed" shown on buddy cards
// throughout the Discover tab is accurate.

describe("sections display cards — completed_count takes precedence over completed_bookings", () => {
  it("returns completedBookings=9 (not 2) in at least one section when completed_count=9 and completed_bookings=2", async () => {
    const buddyRow = {
      id: BP_ID, user_id: BUDDY_USER_ID, city: "Manila",
      status: "active", admin_status: "active",
      display_name: "Test Buddy", tagline: null,
      country: "Philippines",
      categories: ["city"], languages: ["English"],
      hourly_rate_usd: 20, half_day_rate_usd: null,
      full_day_rate_usd: null, nightlife_rate_usd: null, arrival_rate_usd: null,
      average_rating: null, review_count: 0,
      completed_bookings: 2,  // legacy counter — must be ignored
      completed_count: 9,     // canonical counter — must win
      response_time_h: null, cover_photo_url: null, gallery_urls: [],
      vibe_tags: [], safety_badges: [], buddy_level: "experienced",
      verified: false, featured: false, city_ambassador: false,
      available_now: false, female_only_service: false, public_meetup_only: false,
      group_approved: false, nightlife_approved: false,
      energy_type: null, max_group_size: 4,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };

    // makeMatchFakeClient returns [buddyRow] for any rent_buddy_profiles query,
    // which is exactly what each of the 13 section queries needs.
    const fake = makeMatchFakeClient(buddyRow);
    const res = await call("GET", "/api/rent-a-buddy/sections?city=Manila", fake as any);

    assert.equal(res.status, 200, "sections endpoint should return 200");
    const body = (await res.json()) as any;
    assert.ok(Array.isArray(body.sections), "response.sections should be an array");
    assert.ok(body.sections.length > 0, "sections array should not be empty");

    // Find at least one section that has a buddy card — not all sections will
    // match every filter in the fake client (e.g. available_now=false means
    // the available_now section is empty), but at least one must have a row.
    const sectionWithBuddy = body.sections.find(
      (s: any) => Array.isArray(s.buddies) && s.buddies.length > 0,
    );
    assert.ok(
      sectionWithBuddy,
      "at least one section must contain a buddy card",
    );

    assert.equal(
      sectionWithBuddy.buddies[0].completedBookings,
      9,
      `mapProfile must use completed_count=9, not completed_bookings=2; got ${sectionWithBuddy.buddies[0].completedBookings}`,
    );
  });
});

// ── saved-buddies (featured) display cards — completed_count precedence ────────
//
// GET /api/rent-a-buddy/me/saved-buddies returns buddy display cards built via
// mapProfile(row.buddy) where row.buddy is the joined rent_buddy_profiles sub-
// object. mapProfile picks completed_count ?? completed_bookings. When both
// columns disagree, the canonical completed_count must win so the "sessions
// completed" count shown on these prominently featured saved-buddy cards is
// always accurate.

describe("saved-buddies display cards — completed_count takes precedence over completed_bookings", () => {
  it("returns completedBookings=11 (not 4) when completed_count=11 and completed_bookings=4", async () => {
    // The buddy profile has both counters with different values.
    // completed_count is the canonical column written by the completion route;
    // completed_bookings is the legacy column. mapProfile must prefer
    // completed_count so the display card shows 11, not 4.
    const buddyProfile = {
      id: BP_ID, user_id: BUDDY_USER_ID, city: "Bangkok",
      status: "active", admin_status: "active",
      display_name: "Test Buddy", tagline: null, country: "Thailand",
      categories: ["city"], languages: ["English"],
      hourly_rate_usd: 30, half_day_rate_usd: null, full_day_rate_usd: null,
      nightlife_rate_usd: null, arrival_rate_usd: null,
      vibe_tags: [], safety_badges: [], energy_type: null,
      buddy_level: "experienced", average_rating: null, review_count: 0,
      completed_bookings: 4,   // legacy counter — must be ignored
      completed_count: 11,     // canonical counter — must win
      response_time_h: null, cover_photo_url: null, gallery_urls: [],
      verified: false, featured: true, city_ambassador: false,
      available_now: false, female_only_service: false, public_meetup_only: false,
      group_approved: false, nightlife_approved: false,
      arrival_approved: false, category_approvals: {}, max_group_size: 4,
      new_buddy_public_only: false, new_buddy_daytime_only: false,
      risk_hold: false, created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // The saved-buddies endpoint fetches rent_buddy_saved with a join:
    //   .select("*, buddy:rent_buddy_profiles(*)")
    // so each data row has a `buddy` sub-object containing the profile fields.
    const savedRow = {
      buddy_id: BP_ID,
      user_id: TRAVELER_ID,
      notes: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      buddy: buddyProfile,
    };

    function makeSavedBuddiesBuilder(table: string): any {
      const b: any = {
        select:      () => b,
        eq:          () => b,
        neq:         () => b,
        // See makeMatchFakeClient: saved-buddies now resolves fetchBlockedSet,
        // which calls `.or(...)`. Without it the endpoint fails closed to an
        // empty list and this assertion reads "0 !== 1".
        or:          () => b,
        order:       () => b,
        limit:       () => b,
        single:      () => Promise.resolve({ data: null, error: null }),
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        then: (resolve: any, reject: any) =>
          Promise.resolve({
            data: table === "rent_buddy_saved" ? [savedRow] : [],
            error: null,
          }).then(resolve, reject),
      };
      return b;
    }

    const fake = {
      client: {
        auth: { getUser: () => Promise.resolve({ data: { user: { id: TRAVELER_ID } }, error: null }) },
        from: (table: string) => makeSavedBuddiesBuilder(table),
      },
    };

    const res = await call("GET", "/api/rent-a-buddy/me/saved-buddies", fake as any);

    assert.equal(res.status, 200, `saved-buddies should return 200, got ${res.status}`);
    const body = (await res.json()) as any;
    assert.ok(Array.isArray(body.saved), "response.saved should be an array");
    assert.equal(body.saved.length, 1, "should return the one saved buddy");

    // mapProfile: completedBookings: row.completed_count ?? row.completed_bookings ?? 0
    // With completed_count=11 → completedBookings=11  ← expected
    // With completed_bookings=4  → completedBookings=4   ← would indicate a regression
    assert.equal(
      body.saved[0].buddy.completedBookings,
      11,
      `display card must use completed_count=11, not completed_bookings=4; got ${body.saved[0].buddy.completedBookings}`,
    );
  });
});

// ── top-buddies-in-city display card counter precedence ───────────────────────
//
// GET /api/rent-a-buddy/cities/:city/top returns up to 20 buddies ranked by
// completed_count. Each card is built by mapProfile(row), which reads
// completed_count ?? completed_bookings. When the two counters disagree,
// completed_count must win so the "sessions completed" shown on prominent
// Top Buddies cards is accurate.

describe("top-buddies-in-city display cards — completed_count takes precedence over completed_bookings", () => {
  it("returns completedBookings=5 (not 1) when completed_count=5 and completed_bookings=1", async () => {
    const buddyRow = {
      id: BP_ID, user_id: BUDDY_USER_ID, city: "Manila",
      status: "active", admin_status: "active",
      display_name: "Test Buddy", tagline: null,
      country: "Philippines",
      categories: ["city"], languages: ["English"],
      hourly_rate_usd: 20, half_day_rate_usd: null,
      full_day_rate_usd: null, nightlife_rate_usd: null, arrival_rate_usd: null,
      average_rating: null, review_count: 0,
      completed_bookings: 1,  // legacy counter — must be ignored
      completed_count: 5,     // canonical counter — must win
      response_time_h: null, cover_photo_url: null, gallery_urls: [],
      vibe_tags: [], safety_badges: [], buddy_level: "experienced",
      verified: false, featured: false, city_ambassador: false,
      available_now: false, female_only_service: false, public_meetup_only: false,
      group_approved: false, nightlife_approved: false,
      energy_type: null, max_group_size: 4,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };

    const fake = makeMatchFakeClient(buddyRow);
    const res = await call("GET", "/api/rent-a-buddy/cities/Manila/top", fake as any);

    assert.equal(res.status, 200, "top endpoint should return 200");
    const body = (await res.json()) as any;
    assert.ok(Array.isArray(body.buddies), "response.buddies should be an array");
    assert.equal(body.buddies.length, 1, "should return the one buddy");

    // mapProfile: completedBookings: row.completed_count ?? row.completed_bookings ?? 0
    // With completed_count=5  → completedBookings=5  ← expected
    // With completed_bookings=1 → completedBookings=1  ← would indicate a regression
    assert.equal(
      body.buddies[0].completedBookings,
      5,
      `top-buddies card must use completed_count=5, not completed_bookings=1; got ${body.buddies[0].completedBookings}`,
    );
  });
});

// ── offers endpoint buddy card counter precedence ─────────────────────────────
//
// GET /api/rent-a-buddy/requests/:requestId/offers builds each offer's buddy
// card via mapProfile(o.buddy). mapProfile reads completed_count ??
// completed_bookings. When the two counters disagree, completed_count must win
// so the "sessions completed" shown on the traveler's offer list is accurate.

const REQUEST_ID = "11111111-0000-0000-0000-000000000010";

function makeOffersFakeClient(buddyRow: Record<string, any>) {
  const offerRow = {
    id:                  "22222222-0000-0000-0000-000000000020",
    request_id:          REQUEST_ID,
    buddy_profile_id:    BP_ID,
    buddy_user_id:       BUDDY_USER_ID,
    proposed_price_usd:  20,
    deposit_amount_usd:  0,
    cash_balance_usd:    0,
    proposed_start:      null,
    proposed_end:        null,
    meetup_location:     null,
    message:             null,
    included_services:   [],
    addons_offered:      [],
    payment_mode:        "cash",
    expires_at:          null,
    status:              "pending",
    accepted_booking_id: null,
    created_at:          new Date().toISOString(),
    buddy:               buddyRow,
  };

  function makeBuilder(table: string): any {
    const b: any = {
      select:      () => b,
      eq:          () => b,
      neq:         () => b,
      // See makeMatchFakeClient: the offers endpoint now resolves
      // fetchBlockedSet, which calls `.or(...)`.
      or:          () => b,
      order:       () => b,
      limit:       () => b,
      maybeSingle: () => {
        if (table === "rent_buddy_requests") {
          return Promise.resolve({ data: { traveler_id: TRAVELER_ID }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then: (resolve: any, reject: any) => {
        const data = table === "rent_buddy_offers" ? [offerRow] : [];
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return b;
  }

  return {
    client: {
      auth: { getUser: () => Promise.resolve({ data: { user: { id: TRAVELER_ID } }, error: null }) },
      from: (table: string) => makeBuilder(table),
    },
  };
}

describe("offers endpoint buddy card — completed_count takes precedence over completed_bookings", () => {
  it("returns offer.buddy.completedBookings=7 (not 3) when completed_count=7 and completed_bookings=3", async () => {
    // Buddy row has the two counters out of sync. mapProfile must prefer
    // completed_count (the canonical counter written by the completion route)
    // over the legacy completed_bookings column.
    const buddyRow = {
      id: BP_ID, user_id: BUDDY_USER_ID,
      status: "active", admin_status: "active",
      city: "Manila", country: "Philippines",
      display_name: "Test Buddy", tagline: null,
      languages: ["English"], categories: ["city"],
      hourly_rate_usd: 20, half_day_rate_usd: null,
      full_day_rate_usd: null, nightlife_rate_usd: null, arrival_rate_usd: null,
      average_rating: null, review_count: 0,
      completed_bookings: 3,  // legacy counter — must be ignored
      completed_count: 7,     // canonical counter — must win
      response_time_h: null, cover_photo_url: null, gallery_urls: [],
      vibe_tags: [], safety_badges: [], buddy_level: "experienced",
      verified: false, featured: false, city_ambassador: false,
      available_now: false, female_only_service: false, public_meetup_only: false,
      group_approved: false, nightlife_approved: false,
      energy_type: null, max_group_size: 4,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };

    const fake = makeOffersFakeClient(buddyRow);
    const res = await call(
      "GET",
      `/api/rent-a-buddy/requests/${REQUEST_ID}/offers`,
      fake as any,
    );

    assert.equal(res.status, 200, "offers endpoint should return 200");
    const body = (await res.json()) as any;
    assert.ok(Array.isArray(body.offers), "response.offers should be an array");
    assert.equal(body.offers.length, 1, "should return the one offer");

    const buddy = body.offers[0].buddy;
    assert.ok(buddy, "offer.buddy should be present");
    assert.equal(
      buddy.completedBookings,
      7,
      `offers buddy card must use completed_count=7, not completed_bookings=3; got ${buddy.completedBookings}`,
    );
  });
});

describe("toBuddyScoringData — completed_count takes precedence over completed_bookings", () => {
  it("uses completed_count=7 (not completed_bookings=3) when ranking via POST /api/rent-a-buddy/match", async () => {
    // Buddy row deliberately has the two counters out of sync.
    // completed_count is the canonical value written by the completion route;
    // completed_bookings is the legacy column. toBuddyScoringData must prefer
    // completed_count so the scorer and tie-break logic see 7, not 3.
    const buddyRow = {
      id: BP_ID, user_id: BUDDY_USER_ID, city: "Manila",
      status: "active", admin_status: "active",
      categories: ["city"], languages: ["English"],
      hourly_rate_usd: 20, half_day_rate_usd: null, full_day_rate_usd: null,
      vibe_tags: [], energy_type: null, buddy_level: "experienced",
      average_rating: null, review_count: 0,
      completed_bookings: 3,  // legacy counter — should be ignored
      completed_count: 7,     // canonical counter — must win
      response_time_h: null, verified: false, featured: false,
      city_ambassador: false, available_now: true,
      female_only_service: false, public_meetup_only: false,
      group_approved: true, nightlife_approved: false, arrival_approved: false,
      category_approvals: {}, max_group_size: 4,
      new_buddy_public_only: false, new_buddy_daytime_only: false,
      risk_hold: false, created_at: new Date().toISOString(),
    };

    const fake = makeMatchFakeClient(buddyRow);
    const res = await call("POST", "/api/rent-a-buddy/match", fake, { city: "Manila" });

    assert.equal(res.status, 200, "match endpoint should return 200");
    const body = (await res.json()) as any;
    assert.ok(Array.isArray(body.results), "response.results should be an array");
    assert.equal(body.results.length, 1, "should return the one eligible buddy");

    const breakdown = body.results[0].scoreBreakdown;
    assert.ok(breakdown, "scoreBreakdown should be present in the result");

    // CompatibilityScoreService: bkScore = Math.min(100, 30 + completedBookings * 2)
    // With completed_count=7  → 30 + 14 = 44  ← expected
    // With completed_bookings=3 → 30 + 6  = 36  ← would indicate a regression
    assert.equal(
      breakdown.completedBookings,
      44,
      `scorer must use completed_count=7 (bkScore=44) not completed_bookings=3 (bkScore=36); got ${breakdown.completedBookings}`,
    );
  });
});
