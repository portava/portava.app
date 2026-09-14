/**
 * The FIFTH booking-creation path — POST /api/rent-a-buddy/buddies/:buddyId/request
 * (routes/rentABuddySpec.ts), also reachable as /api/buddies/:buddyId/request.
 *
 * ── THE INVARIANT BEING DEFENDED ────────────────────────────────────────────
 * routes/rentABuddy.ts states it about `enforceBookingCreationGates`:
 *
 *     "no creation path may seat a booking that POST /rent-a-buddy/bookings
 *      would refuse."
 *
 * This route INSERTs a `rent_buddy_bookings` row and never calls that function.
 * It re-implements the launch-control checks inline instead, and EVERY age
 * check it had lived inside `if (launchCtrl) { … }`. So with
 * `rent_buddy_launch_controls` empty — or with rows present but none matching
 * the city/country/category — the verified-minor refusal the canonical route
 * applies before any launch control is consulted was never reached, and a
 * booking was seated for a user whose government document says they are a minor.
 *
 * EXPOSURE, STATED ACCURATELY: latent, not live. The no-rows branch requires
 * `rent_buddy_launch_controls` to be empty and production holds 13 rows, and
 * the non-matching branch already returns `location_unavailable` before the
 * insert. It is fixed because the invariant is the thing that has to hold, not
 * because a user is walking through it today.
 *
 * ── AND THE OUTAGE VERDICT (Task 3) ─────────────────────────────────────────
 * `applyVerifiedAgeSignal` collapses `verificationUnreadable` into `age = null`,
 * and this file's launch-control branch reported that as
 * "Date of birth verification is required" — telling a user with a valid date of
 * birth on file that it is missing, during an outage of a DIFFERENT table. The
 * same fabrication `routes/meetups.ts:713-717` documents having fixed once.
 *
 * Run: node --import tsx --test src/test/rentABuddySpecBookingBypass.test.ts
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeFailClosedClient, type FakeClientSpec } from "./helpers/failClosedSupabase.js";

const TOKEN    = "spec-bypass-token";
const TRAVELER = "aaaa0000-0000-4000-8000-00000000000a";
const BUDDY_USER = "bbbb0000-0000-4000-8000-00000000000b";
const BUDDY_PROF = "cccc0000-0000-4000-8000-00000000000c";

const FUTURE_DATE = new Date(Date.now() + 86_400_000 * 10).toISOString().slice(0, 10);

function dobForAge(age: number): string {
  return `${new Date().getFullYear() - age}-01-01`;
}

const OPEN_FLAGS = [
  { flag: "rent_buddy_enabled", enabled: true },
  { flag: "disable_rent_buddy_booking", enabled: false },
  { flag: "disable_rab_bookings", enabled: false },
  { flag: "rent_buddy_allow_bookings_without_kyc", enabled: true },
];

interface World {
  /** `rent_buddy_launch_controls` rows. EMPTY is the bypass branch. */
  launchControls?: any[];
  /** `identity_verifications` rows for the traveller. */
  verifications?: any[];
  /** Make identity_verifications an unreadable table. */
  verificationsUnreadable?: boolean;
}

function world(w: World): FakeClientSpec {
  const spec: FakeClientSpec = {
    users: { [TOKEN]: TRAVELER },
    rows: {
      feature_flags: OPEN_FLAGS,
      rent_buddy_profiles: [{
        id: BUDDY_PROF, user_id: BUDDY_USER, status: "active", admin_status: "active",
        verified: true, categories: ["city", "food"], country: "KR",
      }],
      rent_buddy_launch_controls: w.launchControls ?? [],
      rent_buddy_city_rollouts: [{ id: "ro-1", city: "Seoul", status: "public_mvp", is_active: true }],
      profiles: [{
        id: TRAVELER, date_of_birth: dobForAge(30),
        verification_status: "verified", phone_verified_at: "2026-01-01T00:00:00Z",
      }],
      rent_buddy_user_limits: [],
      buddy_availability_exceptions: [],
      rent_buddy_city_restrictions: [],
      blocks: [],
      identity_verifications: w.verifications ?? [],
    },
    inserted: {}, updated: {},
  };
  if (w.verificationsUnreadable) {
    spec.failOn = (ctx) => (ctx.table === "identity_verifications" ? { message: "down", code: "57P01" } : null);
  }
  return spec;
}

/** The double implements the operators its own suites issue; this route also uses .ilike. */
function withIlike(c: any) {
  const from = c.from.bind(c);
  c.from = (table: string) => {
    const b = from(table);
    if (typeof b.ilike !== "function") b.ilike = (col: string, val: unknown) => b.filter(col, "ilike", val);
    return b;
  };
  return c;
}

let server: http.Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: unknown, next: () => void) => {
    req.log = { info() {}, warn() {}, error() {}, debug() {} };
    next();
  });
  const { default: specRouter } = await import("../routes/rentABuddySpec.js");
  app.use(specRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  server.unref();
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((res, rej) => {
    server.closeAllConnections();
    server.close((e) => (e ? rej(e) : res()));
  });
});

afterEach(() => { _clearTestClient(); _setTestServiceClient(null); });

async function requestBooking(spec: FakeClientSpec, body: Record<string, unknown> = {}) {
  const c = withIlike(makeFailClosedClient(spec));
  _setTestClient(c, true);
  _setTestServiceClient(c);
  const res = await fetch(`${base}/rent-a-buddy/buddies/${BUDDY_PROF}/request`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ bookingDate: FUTURE_DATE, durationH: 3, city: "Seoul", category: "city", ...body }),
  });
  const text = await res.text();
  let parsed: any = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  return { status: res.status, body: parsed, seated: spec.inserted?.rent_buddy_bookings ?? [] };
}

const MINOR = [{ user_id: TRAVELER, is_over_18: false, created_at: "2026-08-01T00:00:00.000Z" }];
const ADULT = [{ user_id: TRAVELER, is_over_18: true,  created_at: "2026-08-01T00:00:00.000Z" }];

describe("rentABuddySpec booking shorthand — the verified-minor refusal must not live inside the launch-control branch", () => {
  it("NO launch control matches: a verified minor is REFUSED and no booking row is written", async () => {
    const spec = world({ launchControls: [], verifications: MINOR });
    const { status, body, seated } = await requestBooking(spec);
    assert.equal(status, 403, "the canonical route refuses this booking; this alias must too");
    assert.equal(body.error, "age_requirement");
    assert.equal(seated.length, 0, "and NO rent_buddy_bookings row was inserted");
  });

  it("the same request without the contradiction still seats a booking", async () => {
    const spec = world({ launchControls: [], verifications: ADULT });
    const { status, seated } = await requestBooking(spec);
    assert.equal(status, 201, "the control: the route still works for a confirmed adult");
    assert.equal(seated.length, 1);
  });

  it("A MATCHING launch control: the verified minor is refused there too", async () => {
    const spec = world({
      launchControls: [{
        country_code: null, city: null, category: "city", enabled: true, waitlist_only: false,
        min_age: 18, nightlife_min_age: 21,
        require_id_verification: false, require_phone_verification: false, full_payment_required: false,
      }],
      verifications: MINOR,
    });
    const { status, seated } = await requestBooking(spec);
    assert.equal(status, 403);
    assert.equal(seated.length, 0);
  });
});

describe("rentABuddySpec booking shorthand — an outage is not a claim about the user's profile", () => {
  it("an unreadable identity_verifications is a retryable 503, not 'your date of birth is missing'", async () => {
    const spec = world({ launchControls: [], verificationsUnreadable: true });
    const { status, body, seated } = await requestBooking(spec);
    assert.equal(status, 503, "an unknown answer is an outage, not a verdict");
    assert.equal(body.error, "age_verification_unavailable");
    assert.ok(
      !String(body.message ?? "").toLowerCase().includes("date of birth"),
      `told a user with a date of birth on file that it is missing: "${body.message}"`,
    );
    assert.equal(seated.length, 0);
  });

  it("a traveller who genuinely has NO date of birth still gets the missing-DOB refusal", async () => {
    // The distinction has to survive in BOTH directions: fixing the fabricated
    // verdict must not delete the true one.
    const spec = world({
      launchControls: [{
        country_code: null, city: null, category: "city", enabled: true, waitlist_only: false,
        min_age: 18, nightlife_min_age: 21,
        require_id_verification: false, require_phone_verification: false, full_payment_required: false,
      }],
      verifications: ADULT,
    });
    (spec.rows as any).profiles = [{ id: TRAVELER, date_of_birth: null, verification_status: "verified", phone_verified_at: "2026-01-01T00:00:00Z" }];
    const { status, body } = await requestBooking(spec);
    assert.equal(status, 403);
    assert.equal(body.error, "age_verification_required");
  });
});

describe("GET /rent-a-buddy/me/eligibility — the reason it reports during an outage", () => {
  let elServer: http.Server;
  let elBase: string;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res: unknown, next: () => void) => {
      req.log = { info() {}, warn() {}, error() {}, debug() {} };
      next();
    });
    const { default: rabRouter } = await import("../routes/rentABuddy.js");
    app.use(rabRouter);
    elServer = http.createServer(app);
    await new Promise<void>((r) => elServer.listen(0, "127.0.0.1", () => r()));
    const { port } = elServer.address() as { port: number };
    elServer.unref();
    elBase = `http://127.0.0.1:${port}`;
  });
  after(async () => {
    await new Promise<void>((res, rej) => {
      elServer.closeAllConnections();
      elServer.close((e) => (e ? rej(e) : res()));
    });
  });

  async function eligibility(spec: FakeClientSpec) {
    const c = withIlike(makeFailClosedClient(spec));
    _setTestClient(c, true);
    _setTestServiceClient(c);
    const res = await fetch(`${elBase}/rent-a-buddy/me/eligibility?city=Seoul&category=city`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const text = await res.text();
    let parsed: any = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
    return { status: res.status, body: parsed };
  }

  it("an unreadable identity_verifications reports an OUTAGE, not 'age_unverified'", async () => {
    const { body } = await eligibility(world({ verificationsUnreadable: true }));
    assert.ok(Array.isArray(body.reasons), `expected a reasons array, got ${JSON.stringify(body)}`);
    assert.ok(
      !body.reasons.includes("age_unverified"),
      "'age_unverified' is a statement about this user's record, made from a read of a DIFFERENT table that failed",
    );
    assert.ok(
      body.reasons.includes("age_check_unavailable"),
      `expected the outage to be named; got ${JSON.stringify(body.reasons)}`,
    );
  });

  it("a verified minor reports the AGE requirement, not a missing date of birth", async () => {
    const { body } = await eligibility(world({ verifications: MINOR }));
    assert.ok(!body.reasons.includes("age_unverified"), "their date of birth is on file");
    assert.ok(
      body.reasons.includes("age_not_verified_adult"),
      `expected the contradiction to be named; got ${JSON.stringify(body.reasons)}`,
    );
  });

  it("a traveller with NO date of birth still reports age_unverified", async () => {
    const spec = world({ verifications: ADULT });
    (spec.rows as any).profiles = [{ id: TRAVELER, date_of_birth: null, verification_status: "verified", phone_verified_at: "2026-01-01T00:00:00Z" }];
    const { body } = await eligibility(spec);
    assert.ok(body.reasons.includes("age_unverified"), "the true verdict survives the fix to the false one");
  });
});
