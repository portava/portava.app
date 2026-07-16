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
  openDispute?: Record<string, any> | null;
  completingUserHasBuddyProfile?: boolean;
}

function makeFakeClient(opts: FakeOpts) {
  const updates: Array<{ table: string; payload: Record<string, any> }> = [];

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
        return { ...booking };
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

    const b: any = {
      select: () => b,
      insert: (p: any) => { op = "write"; payload = p; return b; },
      update: (p: any) => { op = "write"; payload = p; updates.push({ table, payload: p }); return b; },
      upsert: (p: any) => { op = "write"; payload = p; return b; },
      delete: () => { op = "write"; return b; },
      eq: (col: string, val: any) => { eqs[col] = val; return b; },
      neq: () => b, in: () => b, not: () => b, is: () => b,
      gte: () => b, lte: () => b, gt: () => b, lt: () => b,
      like: () => b, ilike: () => b, contains: () => b, overlaps: () => b,
      order: () => b, limit: () => b, range: () => b,
      single:      () => Promise.resolve({ data: op === "write" ? { id: "w1" } : singleRowFor(table, eqs), error: null }),
      maybeSingle: () => Promise.resolve({ data: op === "write" ? { id: "w1" } : singleRowFor(table, eqs), error: null }),
      then: (resolve: any, reject: any) => {
        let data: any;
        if (op === "write") data = null;
        else if (table === "rent_buddy_saved") data = opts.savedRows ?? [];
        else { const row = singleRowFor(table, eqs); data = row == null ? [] : [row]; }
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return b;
  }

  return {
    updates,
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
  const { default: marketplaceRouter } = await import("../routes/rentABuddyMarketplace.js");
  const app = express();
  app.use(express.json());
  app.use(rentABuddyRouter);
  app.use(marketplaceRouter);
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
    const res = await call("POST", `/api/admin/buddy-bookings/${BOOKING_ID}/resolve-dispute`, fake,
      { finalStatus: "cancelled" });
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
      { finalStatus: "completed" });
    assert.equal(res.status, 200);
    assert.ok(!profileUpdates(fake.updates).some((p) => "no_show_count" in p));
  });

  it("does NOT increment when the buddy raised the no-show report", async () => {
    const fake = makeFakeClient({
      userId: ADMIN_ID, profileRole: "admin", bookingStatus: "disputed",
      openDispute: { id: "disp-1", reason: "no_show", raised_by: BUDDY_USER_ID },
    });
    const res = await call("POST", `/api/admin/buddy-bookings/${BOOKING_ID}/resolve-dispute`, fake,
      { finalStatus: "cancelled" });
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
