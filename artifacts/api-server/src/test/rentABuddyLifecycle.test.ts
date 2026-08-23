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
    app.use("/api", rentABuddyRouter);
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

// ── Suite C — Full-payload application round-trip ─────────────────────────────

const APPLICANT_ID = "cccccccc-0000-1111-0000-000000000001";

/**
 * Builds a fake supabase client for the submit-application round-trip tests.
 * storedProfile / storedApplication are mutated by upsert calls so that
 * subsequent maybeSingle() reads reflect what was "written".
 */
function makeApplyClient(
  userId: string,
  stores: { profile: Record<string, any> | null; application: Record<string, any> | null },
) {
  function builder(table: string): any {
    // Track eq() args so feature_flags can discriminate which flag is queried.
    const eqArgs: Record<string, string> = {};

    const b: any = {
      select: () => b,
      insert: () => b,
      upsert: (data: any, _opts?: any) => {
        if (table === "rent_buddy_applications") {
          stores.application = { id: "app-c-001", created_at: new Date().toISOString(), ...data };
        }
        if (table === "rent_buddy_profiles") {
          stores.profile = { ...data };
        }
        return b;
      },
      update: () => b,
      delete: () => b,
      eq: (col: string, val: string) => { eqArgs[col] = String(val); return b; },
      neq: () => b,
      ilike: () => b,
      is: () => b,
      gte: () => b,
      lte: () => b,
      or: () => b,
      contains: () => b,
      order: () => b,
      limit: () => b,
      range: () => b,
      maybeSingle: () => {
        if (table === "feature_flags") {
          const flag = eqArgs["flag"] ?? "";
          // Only rent_buddy_enabled is on; all others (RENT_BUDDY_ADMIN_ONLY_MODE,
          // RENT_BUDDY_MVP_MODE, etc.) must be off so the access check passes.
          const enabled = flag === "rent_buddy_enabled";
          return Promise.resolve({ data: { enabled }, error: null });
        }
        if (table === "rent_buddy_city_rollouts")  return Promise.resolve({ data: { id: "r1", status: "public_mvp" }, error: null });
        if (table === "rent_buddy_global_controls") return Promise.resolve({ data: null, error: null });
        if (table === "rent_buddy_beta_access")    return Promise.resolve({ data: null, error: null });
        if (table === "profiles")                  return Promise.resolve({ data: { role: "user" }, error: null });
        if (table === "rent_buddy_applications")   return Promise.resolve({ data: stores.application, error: null });
        if (table === "rent_buddy_profiles")       return Promise.resolve({ data: stores.profile, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      single: () => {
        if (table === "rent_buddy_applications")   return Promise.resolve({ data: stores.application, error: null });
        if (table === "rent_buddy_profiles")       return Promise.resolve({ data: stores.profile, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      then: (resolve: (r: any) => any) => Promise.resolve({ data: null, error: null }).then(resolve),
    };
    return b;
  }

  return {
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: userId } }, error: null }),
    },
    from: (table: string) => builder(table),
  };
}

describe("C — Full-payload application: wizard fields persist and round-trip via GET /api/rent-a-buddy/me/profile", () => {
  let server: ReturnType<typeof createServer>;
  let port: number;

  before(async () => {
    const { default: rentABuddyRouter } = await import("../routes/rentABuddy.js");
    const app = express();
    app.use(express.json());
    app.use("/api", rentABuddyRouter);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  after(async () => {
    await new Promise((r) => setTimeout(r, 250));
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  });

  it("persists all five wizard fields to rent_buddy_profiles on submit", async () => {
    const stores = { profile: null as Record<string, any> | null, application: null as Record<string, any> | null };
    _setTestClient(makeApplyClient(APPLICANT_ID, stores) as any, true);

    const payload = {
      city: "Manila",
      country: "PH",
      categories: ["city"],
      languages: ["English", "Filipino"],
      displayName: "Alex the Guide",
      bio: "Friendly local guide with five years showing visitors the best of Manila.",
      hourlyRateUsd: 25,
      availability: [{ day: "monday", from: "09:00", to: "18:00" }],
      zones: ["Makati", "BGC"],
    };

    const applyRes = await fetch(
      `http://127.0.0.1:${port}/api/rent-a-buddy/apply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
        body: JSON.stringify(payload),
      },
    );

    assert.equal(applyRes.status, 201, `expected 201, got ${applyRes.status}: ${await applyRes.text()}`);

    // Verify the profile upsert captured all five wizard fields (snake_case DB columns)
    assert.ok(stores.profile, "rent_buddy_profiles upsert must have been called");
    assert.equal(stores.profile!.display_name, "Alex the Guide", "display_name must be stored");
    assert.equal(stores.profile!.bio, payload.bio, "bio must be stored");
    assert.equal(stores.profile!.hourly_rate_usd, 25, "hourly_rate_usd must be stored");
    assert.deepEqual(stores.profile!.availability_blocks, payload.availability, "availability_blocks must be stored");
    assert.deepEqual(stores.profile!.preferred_meetup_zones, ["Makati", "BGC"], "preferred_meetup_zones must be stored");
  });

  it("round-trips all five wizard fields through GET /api/rent-a-buddy/me/profile (mapProfile mapping)", async () => {
    const stores = { profile: null as Record<string, any> | null, application: null as Record<string, any> | null };

    // --- POST: seed the profile store ---
    _setTestClient(makeApplyClient(APPLICANT_ID, stores) as any, true);

    const payload = {
      city: "Manila",
      country: "PH",
      categories: ["city"],
      languages: ["English"],
      displayName: "Maria Explorer",
      bio: "Passionate about sharing hidden gems and local culture across Metro Manila.",
      hourlyRateUsd: 30,
      availability: [{ day: "saturday", from: "08:00", to: "20:00" }],
      zones: ["Intramuros", "Malate"],
    };

    const applyRes = await fetch(
      `http://127.0.0.1:${port}/api/rent-a-buddy/apply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
        body: JSON.stringify(payload),
      },
    );
    assert.equal(applyRes.status, 201);

    // --- GET: read back through mapProfile ---
    _setTestClient(makeApplyClient(APPLICANT_ID, stores) as any, true);

    const profileRes = await fetch(
      `http://127.0.0.1:${port}/api/rent-a-buddy/me/profile`,
      { headers: { Authorization: "Bearer test-token" } },
    );

    assert.equal(profileRes.status, 200);
    const body = await profileRes.json() as any;
    assert.ok(body.profile, "profile must be present in response");

    // Verify camelCase fields come back via mapProfile
    assert.equal(body.profile.displayName, "Maria Explorer",         "displayName must round-trip");
    assert.equal(body.profile.bio, payload.bio,                       "bio must round-trip");
    assert.equal(body.profile.hourlyRateUsd, 30,                      "hourlyRateUsd must round-trip");
    assert.deepEqual(
      body.profile.availabilityBlocks,
      payload.availability,
      "availabilityBlocks must round-trip",
    );
    assert.deepEqual(
      body.profile.preferredMeetupZones,
      ["Intramuros", "Malate"],
      "preferredMeetupZones must round-trip",
    );
  });

  it("returns db_error (not 201) when rent_buddy_profiles upsert fails — no silent persistence gap", async () => {
    const stores = { profile: null as Record<string, any> | null, application: null as Record<string, any> | null };

    // Override the profile upsert to return an error
    const failClient = {
      ...makeApplyClient(APPLICANT_ID, stores),
      from(table: string) {
        const base = makeApplyClient(APPLICANT_ID, stores).from(table);
        if (table === "rent_buddy_profiles") {
          return {
            ...base,
            upsert: () => {
              const errResult = { data: null, error: { message: "db constraint violation" } };
              const errChain: any = {
                ...base,
                select: () => errChain,
                maybeSingle: () => Promise.resolve(errResult),
                single: () => Promise.resolve(errResult),
                then: (resolve: (r: any) => any) => Promise.resolve(errResult).then(resolve),
              };
              return errChain;
            },
          };
        }
        return base;
      },
    };

    _setTestClient(failClient as any, true);

    const applyRes = await fetch(
      `http://127.0.0.1:${port}/api/rent-a-buddy/apply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
        body: JSON.stringify({
          city: "Manila",
          categories: ["city"],
          languages: ["English"],
          displayName: "Test Buddy",
          bio: "A bio for testing the error path.",
          hourlyRateUsd: 20,
        }),
      },
    );

    // Must NOT return 201 when profile persistence fails
    assert.notEqual(applyRes.status, 201, "must not return 201 when profile upsert fails");
    const body = await applyRes.json() as any;
    assert.equal(body.error, "db_error", "must return db_error when profile upsert fails");
  });

  it("bare-minimum submit (no wizard fields) does not set profile wizard columns", async () => {
    const stores = { profile: null as Record<string, any> | null, application: null as Record<string, any> | null };
    _setTestClient(makeApplyClient(APPLICANT_ID, stores) as any, true);

    const applyRes = await fetch(
      `http://127.0.0.1:${port}/api/rent-a-buddy/apply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
        body: JSON.stringify({ city: "Cebu", categories: ["city"], languages: ["English"] }),
      },
    );

    assert.equal(applyRes.status, 201);
    // Profile upsert runs for base fields (city/categories/languages) but wizard columns must be absent
    assert.ok(stores.profile, "profile upsert runs even for bare-minimum submit");
    assert.equal(stores.profile!.display_name,           undefined, "display_name must not be set when not provided");
    assert.equal(stores.profile!.bio,                    undefined, "bio must not be set when not provided");
    assert.equal(stores.profile!.hourly_rate_usd,        undefined, "hourly_rate_usd must not be set when not provided");
    assert.equal(stores.profile!.availability_blocks,    undefined, "availability_blocks must not be set when not provided");
    assert.equal(stores.profile!.preferred_meetup_zones, undefined, "preferred_meetup_zones must not be set when not provided");
  });
});

// ── Suite D: end-early status guard ───────────────────────────────────────────
//
// POST /rent-a-buddy/bookings/:id/safety/end-early previously read only
// traveler_id and buddy_id — never status — and wrote status:"completed"
// unconditionally. Either party could therefore complete a booking from ANY
// state. The case that matters is `disputed`: the party losing an adjudication
// could close it themselves, taking the outcome away from the admin resolution
// route, while stamping a false safety_status:"emergency" on the record.
//
// This endpoint had NO test coverage of any kind before these.

describe("D — end-early: status guard", () => {
  let server: ReturnType<typeof createServer>;
  let port: number;

  before(async () => {
    const { default: rentABuddyRouter } = await import("../routes/rentABuddy.js");
    const app = express();
    app.use(express.json());
    app.use("/api", rentABuddyRouter);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  after(async () => {
    await new Promise((r) => setTimeout(r, 250));
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  });

  async function callEndEarly(userId: string, bookingStatus: string) {
    _setTestClient(makeLifecycleClient(userId, { bookingStatus, rentBuddyEnabled: true }) as any, true);
    return fetch(
      `http://127.0.0.1:${port}/api/rent-a-buddy/bookings/${BOOKING_ID}/safety/end-early`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
        body: JSON.stringify({ reason: "felt unsafe" }),
      },
    );
  }

  it("a DISPUTED booking cannot be closed by a party — the whole point of the guard", async () => {
    const res = await callEndEarly(TRAVELER_ID, "disputed");
    assert.equal(res.status, 409, `expected 409, got ${res.status}`);
    const body = await res.json() as any;
    assert.equal(body.error, "invalid_transition");
    assert.equal(body.currentStatus, "disputed");
  });

  it("a booking awaiting the traveller's confirmation cannot be closed early", async () => {
    // Ending this would destroy the traveller's 24h dispute window.
    const res = await callEndEarly(BUDDY_USER_ID, "completed_pending_traveler_confirmation");
    assert.equal(res.status, 409);
    assert.equal((await res.json() as any).error, "invalid_transition");
  });

  it("a session that never started cannot be 'ended' — that would fabricate one", async () => {
    for (const st of ["requested", "pending", "scheduled"]) {
      const res = await callEndEarly(TRAVELER_ID, st);
      assert.equal(res.status, 409, `status ${st} should be refused, got ${res.status}`);
    }
  });

  it("an already-terminal booking cannot be re-completed", async () => {
    for (const st of ["completed", "cancelled_by_traveler", "expired", "declined"]) {
      const res = await callEndEarly(TRAVELER_ID, st);
      assert.equal(res.status, 409, `status ${st} should be refused, got ${res.status}`);
    }
  });

  it("a no-show under adjudication cannot be closed by a party", async () => {
    const res = await callEndEarly(BUDDY_USER_ID, "no_show_pending");
    assert.equal(res.status, 409);
  });

  it("the traveller may end an in-progress session, which completes it", async () => {
    const res = await callEndEarly(TRAVELER_ID, "in_progress");
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const body = await res.json() as any;
    assert.equal(body.ok, true);
    assert.equal(body.status, "completed");
  });

  it("the buddy ending a session leaves the traveller a dispute window", async () => {
    // Mirrors the canonical completion route: a buddy must not be able to close
    // the booking outright, or the buddy-side dispute-window bypass survives the
    // guard.
    const res = await callEndEarly(BUDDY_USER_ID, "in_progress");
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const body = await res.json() as any;
    assert.equal(body.status, "completed_pending_traveler_confirmation");
  });
});
