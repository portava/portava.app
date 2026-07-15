/**
 * rentABuddyLifecycle.test.ts
 *
 * Two test suites:
 *
 * A. Booking state transition — POST /api/rent-a-buddy/bookings/:id/accept
 *    Verifies Requested → Scheduled happy path and invalid-transition guard.
 *
 * B. City rollout feature-flag gate — checkRentBuddyAccess() called directly
 *    with a hand-crafted fake supabase client. No HTTP server needed.
 *    Verifies city_not_available for unknown cities and allowed for public_mvp.
 *
 * Runtime: node:test + node:assert/strict
 * Run: node --import tsx/esm --test src/test/rentABuddyLifecycle.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { checkRentBuddyAccess } from "../routes/rentABuddyRollout.js";

// ── Shared IDs ─────────────────────────────────────────────────────────────────

const BUDDY_USER_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const TRAVELER_ID   = "bbbbbbbb-0000-0000-0000-000000000002";
const BP_ID         = "cccccccc-0000-0000-0000-000000000003";
const BOOKING_ID    = "dddddddd-0000-0000-0000-000000000004";
const THREAD_ID     = "eeeeeeee-0000-0000-0000-000000000005";

const BOOKING_BASE = {
  id: BOOKING_ID,
  buddy_id: BP_ID,
  traveler_id: TRAVELER_ID,
  booking_date: "2026-08-01",
  start_time: "10:00",
  duration_h: 2,
  telegraph_thread_id: null,
  expires_at: null,
  category: "city",
  total_usd: 100,
  city: "Manila",
};

// ── Suite A — builder helpers ──────────────────────────────────────────────────

/**
 * Builds a supabase-like query builder that:
 * - Tracks whether .in() was called (for conflict-detection queries)
 * - Returns singleData via .maybeSingle() and .single()
 * - Returns [] for array results when .in() was called; [singleData] otherwise
 */
function makeTrackingBuilder(singleData: any): any {
  let hasIn = false;

  const b: any = {
    select: () => b,
    insert: () => b,
    update: () => b,
    upsert: () => b,
    delete: () => b,
    eq: () => b,
    neq: () => b,
    in: () => { hasIn = true; return b; },
    not: () => b,
    is: () => b,
    gte: () => b,
    lte: () => b,
    gt: () => b,
    lt: () => b,
    like: () => b,
    ilike: () => b,
    contains: () => b,
    overlaps: () => b,
    order: () => b,
    limit: () => b,
    range: () => b,
    single: () => Promise.resolve({ data: singleData, error: null }),
    maybeSingle: () => Promise.resolve({ data: singleData, error: null }),
    then: (resolve: (r: any) => any) => {
      const data = hasIn ? [] : (singleData == null ? [] : [singleData]);
      return Promise.resolve({ data, error: null }).then(resolve);
    },
  };
  return b;
}

interface LifecycleState {
  bookingStatus: string;
  rentBuddyEnabled: boolean;
}

function makeLifecycleClient(userId: string, state: LifecycleState) {
  const booking = { ...BOOKING_BASE, status: state.bookingStatus };

  return {
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: userId } }, error: null }),
    },
    from: (table: string) => {
      switch (table) {
        case "feature_flags":
          return makeTrackingBuilder({ enabled: state.rentBuddyEnabled });
        case "rent_buddy_profiles":
          return makeTrackingBuilder({ id: BP_ID, user_id: BUDDY_USER_ID, status: "active", admin_status: "active" });
        case "rent_buddy_user_limits":
          return makeTrackingBuilder(null);
        case "rent_buddy_bookings":
          // Returns booking for .maybeSingle() / .single().
          // Returns [] when .in() is chained (conflict-detection query); otherwise [booking].
          return makeTrackingBuilder({ ...booking });
        case "trust_events":
          // Return a row so isDuplicate() short-circuits (returns true) and
          // skips the INSERT. Without a row, isDuplicate returns false and the
          // INSERT's .select("id").single() returns null → data.id crash.
          return makeTrackingBuilder({ id: "mock-trust-ev-1" });
        case "message_threads":
          return makeTrackingBuilder({ id: THREAD_ID });
        default:
          return makeTrackingBuilder(null);
      }
    },
  };
}

// ── Suite A: Booking state transition ─────────────────────────────────────────

describe("A — Booking state transition: accept (Requested → Scheduled)", () => {
  let server: ReturnType<typeof createServer>;
  let port: number;

  before(async () => {
    const { default: rentABuddyRouter } = await import("../routes/rentABuddy.js");
    const app = express();
    app.use(express.json());
    app.use(rentABuddyRouter);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  after(async () => {
    // Brief drain: fire-and-forget route operations (trust events, milestone
    // emissions) run after the response is sent. Allow them to settle before
    // closing the server so node:test does not flag leaked async activity.
    await new Promise((r) => setTimeout(r, 250));
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  });

  async function callAccept(bookingId: string, userId: string, state: LifecycleState) {
    _setTestClient(makeLifecycleClient(userId, state) as any, true);
    return fetch(
      `http://127.0.0.1:${port}/api/rent-a-buddy/bookings/${bookingId}/accept`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
        body: JSON.stringify({}),
      },
    );
  }

  it("transitions a requested booking to scheduled (200 ok)", async () => {
    const res = await callAccept(BOOKING_ID, BUDDY_USER_ID, {
      bookingStatus: "requested",
      rentBuddyEnabled: true,
    });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const body = await res.json() as any;
    assert.equal(body.ok, true);
  });

  it("accepts a pending booking (200 ok — 'pending' is also an acceptable state)", async () => {
    const res = await callAccept(BOOKING_ID, BUDDY_USER_ID, {
      bookingStatus: "pending",
      rentBuddyEnabled: true,
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.ok, true);
  });

  it("rejects accepting when feature flag is disabled (403 feature_disabled)", async () => {
    const res = await callAccept(BOOKING_ID, BUDDY_USER_ID, {
      bookingStatus: "requested",
      rentBuddyEnabled: false,
    });
    assert.equal(res.status, 403);
    const body = await res.json() as any;
    assert.equal(body.error, "feature_disabled");
  });

  it("rejects accepting a booking already in 'scheduled' status (409 invalid_transition)", async () => {
    const res = await callAccept(BOOKING_ID, BUDDY_USER_ID, {
      bookingStatus: "scheduled",
      rentBuddyEnabled: true,
    });
    assert.equal(res.status, 409);
    const body = await res.json() as any;
    assert.equal(body.error, "invalid_transition");
    assert.equal(body.currentStatus, "scheduled");
  });

  it("rejects accepting a completed booking (409 invalid_transition)", async () => {
    const res = await callAccept(BOOKING_ID, BUDDY_USER_ID, {
      bookingStatus: "completed",
      rentBuddyEnabled: true,
    });
    assert.equal(res.status, 409);
    const body = await res.json() as any;
    assert.equal(body.error, "invalid_transition");
    assert.equal(body.currentStatus, "completed");
  });

  it("rejects accepting a cancelled booking (409 invalid_transition)", async () => {
    const res = await callAccept(BOOKING_ID, BUDDY_USER_ID, {
      bookingStatus: "cancelled",
      rentBuddyEnabled: true,
    });
    assert.equal(res.status, 409);
    const body = await res.json() as any;
    assert.equal(body.error, "invalid_transition");
  });
});

// ── Suite B — rollout fake client ──────────────────────────────────────────────

/**
 * Builds a supabase-like client for checkRentBuddyAccess tests.
 * Tracks eq() / ilike() arguments so different flags and cities return
 * different values without a heavy state machine.
 */
function makeRolloutClient(opts: {
  rentBuddyEnabled: boolean;
  cityStatus?: string | null;
  hasBetaAccess?: boolean;
}) {
  return {
    from: (table: string) => {
      const eqArgs: Record<string, string> = {};
      const b: any = {
        select: () => b,
        eq:    (col: string, val: string) => { eqArgs[col] = String(val); return b; },
        ilike: (col: string, val: string) => { eqArgs[col] = String(val).toLowerCase(); return b; },
        maybeSingle: () => {
          if (table === "feature_flags") {
            const flag = eqArgs["flag"] ?? "";
            // Only rent_buddy_enabled respects the configured value; all others are off
            if (flag === "rent_buddy_enabled") {
              return Promise.resolve({ data: { enabled: opts.rentBuddyEnabled }, error: null });
            }
            return Promise.resolve({ data: { enabled: false }, error: null });
          }

          if (table === "rent_buddy_city_rollouts") {
            const data = opts.cityStatus != null
              ? { id: "city-r1", status: opts.cityStatus }
              : null;
            return Promise.resolve({ data, error: null });
          }

          if (table === "rent_buddy_beta_access") {
            const data = opts.hasBetaAccess
              ? { id: "beta-r1", status: "active" }
              : null;
            return Promise.resolve({ data, error: null });
          }

          if (table === "rent_buddy_global_controls") {
            return Promise.resolve({ data: null, error: null });
          }

          if (table === "profiles") {
            return Promise.resolve({ data: { role: "user" }, error: null });
          }

          return Promise.resolve({ data: null, error: null });
        },
        then: (resolve: (r: any) => any) => Promise.resolve({ data: [], error: null }).then(resolve),
        single: () => Promise.resolve({ data: null, error: null }),
      };
      return b;
    },
  };
}

// ── Suite B: City rollout feature-flag gate ────────────────────────────────────

describe("B — City rollout gate: checkRentBuddyAccess()", () => {
  it("city_not_available when no rollout row exists (city absent from DB)", async () => {
    const sc = makeRolloutClient({ rentBuddyEnabled: true, cityStatus: null });
    const result = await checkRentBuddyAccess({ sc, userId: TRAVELER_ID, city: "UnknownCity", action: "book" });
    assert.equal(result.allowed, false);
    assert.equal(result.code, "city_not_available");
    assert.equal(result.httpStatus, 403);
  });

  it("city_not_available when city rollout status is 'disabled'", async () => {
    const sc = makeRolloutClient({ rentBuddyEnabled: true, cityStatus: "disabled" });
    const result = await checkRentBuddyAccess({ sc, userId: TRAVELER_ID, city: "LockedCity", action: "book" });
    assert.equal(result.allowed, false);
    assert.equal(result.code, "city_not_available");
  });

  it("feature_disabled when rent_buddy_enabled flag is off (checked before city)", async () => {
    const sc = makeRolloutClient({ rentBuddyEnabled: false, cityStatus: "public_mvp" });
    const result = await checkRentBuddyAccess({ sc, userId: TRAVELER_ID, city: "Manila", action: "book" });
    assert.equal(result.allowed, false);
    assert.equal(result.code, "feature_disabled");
  });

  it("allowed for public_mvp city with action=read (no beta check required)", async () => {
    const sc = makeRolloutClient({ rentBuddyEnabled: true, cityStatus: "public_mvp" });
    const result = await checkRentBuddyAccess({ sc, userId: TRAVELER_ID, city: "Manila", action: "read" });
    assert.equal(result.allowed, true);
  });

  it("allowed for beta_testing city when user has active beta access (action=book)", async () => {
    const sc = makeRolloutClient({ rentBuddyEnabled: true, cityStatus: "beta_testing", hasBetaAccess: true });
    const result = await checkRentBuddyAccess({ sc, userId: TRAVELER_ID, city: "Cebu", action: "book" });
    assert.equal(result.allowed, true);
  });

  it("city_beta_access_required when city is beta_testing and user lacks beta invite", async () => {
    const sc = makeRolloutClient({ rentBuddyEnabled: true, cityStatus: "beta_testing", hasBetaAccess: false });
    const result = await checkRentBuddyAccess({ sc, userId: TRAVELER_ID, city: "Cebu", action: "book" });
    assert.equal(result.allowed, false);
    assert.equal(result.code, "city_beta_access_required");
  });
});
