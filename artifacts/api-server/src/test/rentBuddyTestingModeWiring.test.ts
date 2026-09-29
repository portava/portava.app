/**
 * Rent-a-Buddy — testing-mode wiring (lane tm-rab, WP-01).
 *
 * The client lane wired the booking lifecycle, the buddy's own offers and the
 * admin moderation/risk/verification/launch-control screens to routes that
 * already existed. Wiring a screen to a route makes the route's answers
 * user-visible, and five of those answers were not true enough to show:
 *
 *   1. GATE NAMES. `rent_buddy_enabled` (master switch) and both booking kill
 *      switches answered the SAME `{ error: "feature_disabled" }`. The app must
 *      say exactly which gate refused and what unblocks it, so each refusal now
 *      carries `gate` — the flag that refused. Nothing about WHETHER a request is
 *      refused changes; the `if`s are untouched.
 *   2. "SUGGEST ANOTHER TIME" HAD NO READ. The buddy's suggestion is stored as
 *      buddy_booking_change_requests rows, and the traveller answers through
 *      respond-change-request with a `changeRequestId` — which no route ever
 *      returned. GET /rent-a-buddy/bookings/:id/change-requests is the missing
 *      read, party-only and behind the master switch like every booking read.
 *   3. WITHDRAW WAS UNCONDITIONAL. A buddy could "withdraw" an offer the
 *      traveller had already ACCEPTED (a booking exists), flipping it to
 *      `withdrawn` under a live booking. Compare-and-set on `pending` now.
 *   4. ADMIN READS REPORTED A FAILED READ AS AN EMPTY QUEUE. launch-controls,
 *      support reports and risk review discarded the read error and answered
 *      200 with `[]` — an admin would see "nothing to review" during an outage
 *      (the DV-83 principle). They now answer 5xx.
 *   5. ADMIN WRITES REPORTED A FAILED WRITE AS DONE. launch-control PATCH,
 *      risk-status, verification override and review approve/reject discarded
 *      the update error and answered ok. They now answer 5xx.
 *
 * Run: node --import tsx/esm --test src/test/rentBuddyTestingModeWiring.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import rentABuddyRouter, { enforceBookingCreationGates } from "../routes/rentABuddy.js";
import marketplaceRouter from "../routes/rentABuddyMarketplace.js";
import specRouter from "../routes/rentABuddySpec.js";
import { KYC_OVERRIDE_FLAG } from "../lib/rentBuddyKycGate.js";

const TRAVELER = "tmr-traveler";
const BUDDY_USER = "tmr-buddy-user";
const OTHER_USER = "tmr-other-user";
const ADMIN = "tmr-admin";
const BUDDY_PROF = "tmr-buddy-prof";
const BOOKING = "tmr-booking-1";
const TOKENS: Record<string, string> = {
  "t-traveler": TRAVELER, "t-buddy": BUDDY_USER, "t-other": OTHER_USER, "t-admin": ADMIN,
};

type Row = Record<string, any>;
type Op = "select" | "update" | "insert" | "upsert" | "delete";

interface World {
  tables: Record<string, Row[]>;
  /** table -> op -> forced error for every such call. */
  errors: Record<string, Partial<Record<Op, { message: string }>>>;
  /** feature flag name -> forced read error. */
  flagErrors: Set<string>;
}

let world: World;

function flags(on: Record<string, boolean>): Row[] {
  return Object.entries(on).map(([flag, enabled]) => ({ flag, enabled }));
}

function baseWorld(flagState: Record<string, boolean> = { rent_buddy_enabled: true }): World {
  return {
    tables: {
      feature_flags: flags(flagState),
      profiles: [
        { id: TRAVELER, role: "user", date_of_birth: "1990-01-01", account_status: "active" },
        { id: BUDDY_USER, role: "user", date_of_birth: "1990-01-01", account_status: "active" },
        { id: OTHER_USER, role: "user", date_of_birth: "1990-01-01", account_status: "active" },
        { id: ADMIN, role: "admin", date_of_birth: "1980-01-01", account_status: "active" },
      ],
      rent_buddy_profiles: [
        { id: BUDDY_PROF, user_id: BUDDY_USER, status: "active", admin_status: "active", city: "Lisbon", country: "Portugal", hourly_rate_usd: 30 },
      ],
      rent_buddy_bookings: [
        { id: BOOKING, traveler_id: TRAVELER, buddy_id: BUDDY_PROF, status: "requested", booking_date: "2026-10-10", start_time: "10:00", duration_h: 2 },
      ],
    },
    errors: {},
    flagErrors: new Set(),
  };
}

function matches(row: Row, filters: Array<[string, string, any]>): boolean {
  return filters.every(([op, col, val]) => {
    const v = row[col];
    switch (op) {
      case "eq": return v === val;
      case "neq": return v !== val;
      case "in": return (val as any[]).includes(v);
      case "is": return val === null ? v == null : v === val;
      case "ilike": return typeof v === "string" && typeof val === "string" && v.toLowerCase() === val.toLowerCase();
      default: return true;
    }
  });
}

function makeClient() {
  function builder(table: string) {
    const b: any = {
      _op: "select" as Op,
      _filters: [] as Array<[string, string, any]>,
      _patch: null as Row | null,
      _rows: null as Row[] | null,
      _returning: false,
      _single: false,
      select() { if (b._op !== "select") b._returning = true; return b; },
      insert(rows: Row | Row[]) { b._op = "insert"; b._rows = Array.isArray(rows) ? rows : [rows]; return b; },
      upsert(rows: Row | Row[]) { b._op = "upsert"; b._rows = Array.isArray(rows) ? rows : [rows]; return b; },
      update(patch: Row) { b._op = "update"; b._patch = patch; return b; },
      delete() { b._op = "delete"; return b; },
      eq(c: string, v: any) { b._filters.push(["eq", c, v]); return b; },
      neq(c: string, v: any) { b._filters.push(["neq", c, v]); return b; },
      in(c: string, v: any[]) { b._filters.push(["in", c, v]); return b; },
      is(c: string, v: any) { b._filters.push(["is", c, v]); return b; },
      ilike(c: string, v: any) { b._filters.push(["ilike", c, v]); return b; },
      gte() { return b; }, lte() { return b; }, lt() { return b; }, gt() { return b; },
      or() { return b; }, contains() { return b; }, not() { return b; },
      order() { return b; }, range() { return b; }, limit() { return b; },
      maybeSingle() { b._single = true; return b; },
      single() { b._single = true; return b; },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        try { resolve(b._resolve()); } catch (e) { reject?.(e); }
      },
      _resolve() {
        if (table === "feature_flags") {
          const flag = b._filters.find(([, c]: [string, string]) => c === "flag")?.[2];
          if (flag && world.flagErrors.has(flag)) return { data: null, error: { message: "simulated flag read failure" } };
        }
        const forced = world.errors[table]?.[b._op as Op];
        if (forced) return { data: null, error: forced, count: null };
        const rows = (world.tables[table] ??= []);
        if (b._op === "insert" || b._op === "upsert") {
          for (const r of b._rows!) rows.push({ id: r.id ?? `${table}-${rows.length + 1}`, ...r });
          const out = b._rows!;
          return { data: b._returning ? (b._single ? out[0] : out) : null, error: null };
        }
        const hit = rows.filter((r) => matches(r, b._filters));
        if (b._op === "update") {
          for (const r of hit) Object.assign(r, b._patch);
          return { data: b._returning ? hit.map((r) => ({ ...r })) : null, error: null };
        }
        if (b._op === "delete") {
          world.tables[table] = rows.filter((r) => !hit.includes(r));
          return { data: null, error: null };
        }
        if (b._single) return { data: hit[0] ? { ...hit[0] } : null, error: null };
        return { data: hit.map((r) => ({ ...r })), error: null, count: hit.length };
      },
    };
    return b;
  }
  return {
    from: (t: string) => builder(t),
    rpc: async () => ({ data: null, error: null }),
    auth: {
      getUser: async (token: string) => TOKENS[token]
        ? { data: { user: { id: TOKENS[token] } }, error: null }
        : { data: { user: null }, error: { message: "invalid token" } },
    },
  };
}

let server: http.Server;
let base: string;

function call(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", rentABuddyRouter);
  app.use("/api", marketplaceRouter);
  app.use("/api", specRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => { server.close(); });

beforeEach(() => {
  world = baseWorld();
  _setTestClient(makeClient() as any, true);
});

// ── 1. Gate names ─────────────────────────────────────────────────────────────

describe("refusals name the gate that refused", () => {
  it("master switch off: a lifecycle write names rent_buddy_enabled", async () => {
    world = baseWorld({ rent_buddy_enabled: false });
    const r = await call("POST", `/api/rent-a-buddy/bookings/${BOOKING}/start`, "t-buddy", {});
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "feature_disabled");
    assert.equal(r.body.gate, "rent_buddy_enabled");
  });

  for (const ks of ["disable_rab_bookings", "disable_rent_buddy_booking"]) {
    it(`canonical booking create names ${ks} when only it is engaged`, async () => {
      world = baseWorld({ rent_buddy_enabled: true, [KYC_OVERRIDE_FLAG]: true, [ks]: true });
      const r = await call("POST", "/api/rent-a-buddy/bookings", "t-traveler", {
        buddyId: BUDDY_PROF, bookingDate: "2026-10-10", durationH: 2, city: "Lisbon", category: "city",
      });
      assert.equal(r.status, 404, JSON.stringify(r.body));
      assert.equal(r.body.error, "feature_disabled");
      assert.equal(r.body.gate, ks);
    });
  }

  it("an unreadable kill switch is named as the one that stopped the booking (fail-closed)", async () => {
    world = baseWorld({ rent_buddy_enabled: true, [KYC_OVERRIDE_FLAG]: true });
    world.flagErrors.add("disable_rent_buddy_booking");
    const r = await call("POST", "/api/rent-a-buddy/bookings", "t-traveler", {
      buddyId: BUDDY_PROF, bookingDate: "2026-10-10", durationH: 2, city: "Lisbon", category: "city",
    });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.gate, "disable_rent_buddy_booking");
  });

  it("shared creation gate (applyKillSwitch) names the switch", async () => {
    world = baseWorld({ rent_buddy_enabled: true, disable_rab_bookings: true });
    const rec: { status: number | null; body: any } = { status: null, body: null };
    const res: any = { status(c: number) { rec.status = c; return res; }, json(p: any) { rec.body = p; return res; } };
    const ok = await enforceBookingCreationGates({
      sc: makeClient(), res, userId: TRAVELER, buddyProfile: world.tables.rent_buddy_profiles[0],
      city: "Lisbon", category: "city", applyKillSwitch: true,
    });
    assert.equal(ok, false);
    assert.equal(rec.status, 404);
    assert.equal(rec.body.gate, "disable_rab_bookings");
  });

  it("marketplace offer accept names the switch", async () => {
    world = baseWorld({ rent_buddy_enabled: true, [KYC_OVERRIDE_FLAG]: true, disable_rab_bookings: true });
    const r = await call("POST", "/api/rent-a-buddy/offers/offer-x/accept", "t-traveler", {});
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.gate, "disable_rab_bookings");
  });

  it("marketplace package book names the switch", async () => {
    world = baseWorld({ rent_buddy_enabled: true, [KYC_OVERRIDE_FLAG]: true, disable_rent_buddy_booking: true });
    const r = await call("POST", "/api/rent-a-buddy/packages/pkg-x/book", "t-traveler", {});
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.gate, "disable_rent_buddy_booking");
  });

  it("spec request-a-buddy names the switch", async () => {
    world = baseWorld({ rent_buddy_enabled: true, [KYC_OVERRIDE_FLAG]: true, disable_rab_bookings: true });
    const r = await call("POST", `/api/rent-a-buddy/buddies/${BUDDY_PROF}/request`, "t-traveler", {});
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.gate, "disable_rab_bookings");
  });
});

// ── 2. The change-request read ────────────────────────────────────────────────

describe("GET /rent-a-buddy/bookings/:id/change-requests", () => {
  function seedSuggestion() {
    world.tables.buddy_booking_change_requests = [
      { id: "cr-1", booking_id: BOOKING, requested_by: BUDDY_USER, change_field: "start_time",
        current_value: { start_time: "10:00" }, proposed_value: { start_time: "14:00" },
        reason: "Morning is booked", status: "pending", created_at: "2026-10-01T10:00:00Z" },
      { id: "cr-other", booking_id: "some-other-booking", requested_by: BUDDY_USER, change_field: "date",
        current_value: {}, proposed_value: { date: "2026-12-01" }, reason: null, status: "pending",
        created_at: "2026-10-01T10:00:00Z" },
    ];
  }

  it("the traveller sees the buddy's suggestion, marked as not theirs to have raised", async () => {
    seedSuggestion();
    const r = await call("GET", `/api/rent-a-buddy/bookings/${BOOKING}/change-requests`, "t-traveler");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.changeRequests.length, 1);
    const cr = r.body.changeRequests[0];
    assert.equal(cr.id, "cr-1");
    assert.equal(cr.changeField, "start_time");
    assert.deepEqual(cr.proposedValue, { start_time: "14:00" });
    assert.equal(cr.status, "pending");
    assert.equal(cr.requestedByMe, false);
  });

  it("the buddy who raised it sees requestedByMe", async () => {
    seedSuggestion();
    const r = await call("GET", `/api/rent-a-buddy/bookings/${BOOKING}/change-requests`, "t-buddy");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.changeRequests[0].requestedByMe, true);
  });

  it("a stranger is refused", async () => {
    seedSuggestion();
    const r = await call("GET", `/api/rent-a-buddy/bookings/${BOOKING}/change-requests`, "t-other");
    assert.equal(r.status, 403, JSON.stringify(r.body));
  });

  it("an unknown booking is 404", async () => {
    const r = await call("GET", "/api/rent-a-buddy/bookings/nope/change-requests", "t-traveler");
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });

  it("a failed read is an error, never an empty list", async () => {
    seedSuggestion();
    world.errors.buddy_booking_change_requests = { select: { message: "boom" } };
    const r = await call("GET", `/api/rent-a-buddy/bookings/${BOOKING}/change-requests`, "t-traveler");
    assert.ok(r.status >= 500, JSON.stringify(r.body));
    assert.equal(r.body.changeRequests, undefined);
  });

  it("is behind the master switch and names it", async () => {
    world = baseWorld({ rent_buddy_enabled: false });
    const r = await call("GET", `/api/rent-a-buddy/bookings/${BOOKING}/change-requests`, "t-traveler");
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.gate, "rent_buddy_enabled");
  });
});

// ── 3. Withdraw is compare-and-set ────────────────────────────────────────────

describe("POST /rent-a-buddy/offers/:id/withdraw", () => {
  function seedOffer(status: string) {
    world.tables.rent_buddy_offers = [{ id: "off-1", buddy_user_id: BUDDY_USER, status, accepted_booking_id: status === "accepted" ? BOOKING : null }];
  }

  it("withdraws a pending offer", async () => {
    seedOffer("pending");
    const r = await call("POST", "/api/rent-a-buddy/offers/off-1/withdraw", "t-buddy", {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(world.tables.rent_buddy_offers[0].status, "withdrawn");
  });

  it("refuses to withdraw an offer the traveller already accepted", async () => {
    seedOffer("accepted");
    const r = await call("POST", "/api/rent-a-buddy/offers/off-1/withdraw", "t-buddy", {});
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "invalid_transition");
    assert.equal(world.tables.rent_buddy_offers[0].status, "accepted");
  });

  it("only the offering buddy may withdraw", async () => {
    seedOffer("pending");
    const r = await call("POST", "/api/rent-a-buddy/offers/off-1/withdraw", "t-other", {});
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(world.tables.rent_buddy_offers[0].status, "pending");
  });
});

// ── 4. Admin reads: a failed read is not an empty queue ───────────────────────

describe("admin reads surface a failed read", () => {
  const cases: Array<[string, string, string]> = [
    ["launch controls", "/api/rent-a-buddy/admin/launch-controls", "rent_buddy_launch_controls"],
    ["support reports", "/api/rent-a-buddy/admin/support/reports?status=open", "rent_buddy_support_reports"],
    ["risk review", "/api/rent-a-buddy/admin/risk-review?status=watch", "rent_buddy_profiles"],
    ["review moderation", "/api/rent-a-buddy/admin/reviews", "rent_buddy_reviews"],
  ];
  for (const [label, path, table] of cases) {
    it(`${label}: read error -> 5xx, not 200 []`, async () => {
      world.errors[table] = { select: { message: "boom" } };
      const r = await call("GET", path, "t-admin");
      assert.ok(r.status >= 500, `${label}: ${r.status} ${JSON.stringify(r.body)}`);
    });
  }

  it("launch controls: a readable table is returned", async () => {
    world.tables.rent_buddy_launch_controls = [{ id: "lc-1", city: "Lisbon", category: null, country_code: "PT", enabled: true }];
    const r = await call("GET", "/api/rent-a-buddy/admin/launch-controls", "t-admin");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.controls.length, 1);
  });

  it("support reports and risk review: readable tables are returned", async () => {
    world.tables.rent_buddy_support_reports = [{ id: "sr-1", status: "open" }];
    world.tables.rent_buddy_profiles[0].risk_review_status = "watch";
    const a = await call("GET", "/api/rent-a-buddy/admin/support/reports?status=open", "t-admin");
    const b = await call("GET", "/api/rent-a-buddy/admin/risk-review?status=watch", "t-admin");
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.reports.length, 1);
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(b.body.profiles.length, 1);
  });
});

// ── 5. Admin writes: a failed write is not "done" ─────────────────────────────

describe("admin writes surface a failed write", () => {
  it("launch-control PATCH", async () => {
    world.tables.rent_buddy_launch_controls = [{ id: "lc-1", enabled: false }];
    world.errors.rent_buddy_launch_controls = { update: { message: "boom" } };
    const r = await call("PATCH", "/api/rent-a-buddy/admin/launch-controls/lc-1", "t-admin", { enabled: true });
    assert.ok(r.status >= 500, JSON.stringify(r.body));
  });

  it("launch-control PATCH applies when the write succeeds", async () => {
    world.tables.rent_buddy_launch_controls = [{ id: "lc-1", enabled: false }];
    const r = await call("PATCH", "/api/rent-a-buddy/admin/launch-controls/lc-1", "t-admin", { enabled: true, minAge: 21 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(world.tables.rent_buddy_launch_controls[0].enabled, true);
    assert.equal(world.tables.rent_buddy_launch_controls[0].min_age, 21);
  });

  it("risk status", async () => {
    world.errors.rent_buddy_profiles = { update: { message: "boom" } };
    const r = await call("POST", `/api/rent-a-buddy/admin/users/${BUDDY_USER}/risk-status`, "t-admin", { status: "watch" });
    assert.ok(r.status >= 500, JSON.stringify(r.body));
    assert.equal(
      (world.tables.rent_buddy_admin_actions ?? []).length, 0,
      "no audit row may claim a risk change the database refused",
    );
  });

  it("verification override", async () => {
    world.errors.rent_buddy_profiles = { update: { message: "boom" } };
    const r = await call("PATCH", `/api/rent-a-buddy/admin/users/${BUDDY_USER}/verification`, "t-admin", { idVerified: true });
    assert.ok(r.status >= 500, JSON.stringify(r.body));
    assert.equal((world.tables.rent_buddy_admin_actions ?? []).length, 0);
  });

  for (const action of ["approve", "reject"]) {
    it(`review ${action}`, async () => {
      world.tables.rent_buddy_reviews = [{ id: "rv-1", reviewee_id: BUDDY_USER, role: "traveler", rating: 5, moderation_status: "pending_moderation" }];
      world.errors.rent_buddy_reviews = { update: { message: "boom" } };
      const r = await call("POST", `/api/rent-a-buddy/admin/reviews/rv-1/${action}`, "t-admin", {});
      assert.ok(r.status >= 500, JSON.stringify(r.body));
      assert.equal((world.tables.rent_buddy_admin_actions ?? []).length, 0);
    });
  }
});
