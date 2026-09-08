/**
 * rabLifecycleRestrictions — admin location policy must be read on EVERY
 * booking-creation path, not on four out of five.
 *
 * ── THE GAP ──────────────────────────────────────────────────────────────────
 * `rent_buddy_city_restrictions` carries three admin-set rules for a city (and
 * optionally a category): require_public_meetup, disable_deposit_cash,
 * require_full_in_app. It was read in exactly one place —
 * enforceBookingCreationGates — which POST /rent-a-buddy/bookings, rebook,
 * offer-accept and package-book all run.
 *
 * The fifth creation path does not run that gate stack.
 * rentABuddySpec's POST /rent-a-buddy/buddies/:buddyId/request, reached from
 * mobile as /api/buddies/:buddyId/request, builds its own gate sequence, and
 * that sequence never touched the restrictions table. So a traveller refused a
 * private meetup, or a cash split, by the canonical route could seat exactly
 * that booking through the shorthand. Its launch-control read was also
 * fail-OPEN — `const { data: launchRows }` with the error dropped, so an
 * unreadable table became "no launch controls are configured", waiving the
 * server-derived-country requirement and every age / ID / phone rule with it —
 * and it had no deny-by-default branch, so a city an admin had simply not
 * listed was bookable here and refused everywhere else.
 *
 * The restriction enforcement now lives in ONE exported helper that both paths
 * call, so they cannot drift again.
 *
 * Assertions are over a REAL supabase client with a recording fetch: the
 * evidence for "the table was read" is the GET, and for "no booking was seated"
 * is the absence of the POST.
 *
 * Run: node --import tsx/esm --test src/test/rabLifecycleRestrictions.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { createClient } from "@supabase/supabase-js";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const SUPA_URL = "http://supabase.test";
const SUPA_KEY = "test-service-role-key";

const TRAVELER_ID = "22222222-2222-4222-8222-222222222222";
const BUDDY_USER  = "33333333-3333-4333-8333-333333333333";
const BUDDY_PROF  = "44444444-4444-4444-8444-444444444444";
const CITY        = "Cebu";

interface Call { method: string; path: string; query: string; body: any }
let calls: Call[] = [];
type Responder = (c: Call) => unknown;

function makeRecordingFetch(respond: Responder): typeof fetch {
  return (async (input: any, init: any = {}) => {
    const raw = typeof input === "string" ? input : (input?.url ?? String(input));
    const u = new URL(raw);
    let body: any = null;
    if (init?.body) { try { body = JSON.parse(String(init.body)); } catch { body = String(init.body); } }
    const call: Call = { method: (init?.method ?? "GET").toUpperCase(), path: u.pathname, query: decodeURIComponent(u.search), body };
    calls.push(call);
    const payload = respond(call);
    if (payload instanceof Response) return payload;
    return new Response(JSON.stringify(payload ?? []), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

function realClient(respond: Responder): any {
  return createClient(SUPA_URL, SUPA_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: makeRecordingFetch(respond) },
  });
}

const bookingsInserted = () => calls.filter((c) => c.path === "/rest/v1/rent_buddy_bookings" && c.method === "POST");
const restrictionReads = () => calls.filter((c) => c.path === "/rest/v1/rent_buddy_city_restrictions" && c.method === "GET");

const settle = () => new Promise((r) => setTimeout(r, 80));

let server: http.Server;
let base: string;

function httpReq(path: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = JSON.stringify(body ?? {});
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port),
        path: url.pathname, method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TRAVELER_ID}` },
      },
      (inRes) => {
        let raw = "";
        inRes.on("data", (c) => (raw += c));
        inRes.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: inRes.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    r.write(payload);
    r.end();
  });
}

before(async () => {
  const { default: rentABuddySpecRouter } = await import("../routes/rentABuddySpec.js");
  const app = express();
  app.use(express.json());
  // req.log shim — without it the route's log calls crash and a 500-from-crash
  // would masquerade as a refusal, which is exactly the confusion these tests
  // exist to avoid.
  app.use((req: any, _res, next) => {
    req.log = { info() {}, warn() {}, error() {}, debug() {} };
    next();
  });
  app.use("/api", rentABuddySpecRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(async () => {
  _clearTestClient();
  _setTestServiceClient(null);
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => { calls = []; });

interface Fixture {
  /** rows for rent_buddy_city_restrictions, or a Response to fail the read. */
  restrictions?: unknown[] | Response;
  /** rows for rent_buddy_launch_controls, or a Response to fail the read. */
  launchControls?: unknown[] | Response;
}

/**
 * Everything the shorthand's gate sequence reads, in its permissive state, so
 * the only thing under test is the restriction/launch-control policy.
 */
function responder(f: Fixture): Responder {
  return (c) => {
    if (c.path === "/auth/v1/user") {
      return { id: TRAVELER_ID, aud: "authenticated", role: "authenticated", email: "t@t.test",
               app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
    }
    if (c.path === "/rest/v1/feature_flags") {
      const q = c.query;
      // Master switch on; both booking kill switches off; KYC waived so the
      // gate stack reaches the policy reads this file is about.
      if (q.includes("rent_buddy_enabled")) return [{ flag: "rent_buddy_enabled", enabled: true }];
      if (q.includes("rent_buddy_allow_bookings_without_kyc")) return [{ flag: "rent_buddy_allow_bookings_without_kyc", enabled: true }];
      return [];
    }
    if (c.path === "/rest/v1/rent_buddy_global_controls") {
      return [{ id: 1, all_bookings_paused: false, applications_paused: false, cash_balance_paused: false,
                nightlife_paused: false, force_full_in_app: false, force_public_meetup: false }];
    }
    if (c.path === "/rest/v1/rent_buddy_city_rollouts") return [{ id: "roll-1", city: CITY, status: "public_mvp" }];
    if (c.path === "/rest/v1/rent_buddy_user_limits") return [];
    if (c.path === "/rest/v1/blocks") return [];
    if (c.path === "/rest/v1/profiles") {
      // A verified adult, so nothing else in the stack refuses.
      return [{ id: TRAVELER_ID, role: "user", account_status: "active",
                id_verified: true, phone_verified: true, date_of_birth: "1990-01-01" }];
    }
    if (c.path === "/rest/v1/rent_buddy_profiles" && c.method === "GET") {
      if (c.query.includes(`user_id=eq.${TRAVELER_ID}`)) return []; // traveller has no buddy profile
      return [{ id: BUDDY_PROF, user_id: BUDDY_USER, status: "active", admin_status: "active",
                verified: true, categories: ["city"], country: "PH" }];
    }
    if (c.path === "/rest/v1/rent_buddy_launch_controls") {
      const lc = f.launchControls;
      if (lc instanceof Response) return lc;
      return lc ?? [];
    }
    if (c.path === "/rest/v1/rent_buddy_city_restrictions") {
      const r = f.restrictions;
      if (r instanceof Response) return r;
      return r ?? [];
    }
    if (c.path === "/rest/v1/buddy_availability_exceptions") return [];
    if (c.path === "/rest/v1/rent_buddy_bookings" && c.method === "POST") {
      return [{ id: "new-booking-1", city: CITY, category: "city" }];
    }
    return [];
  };
}

function install(f: Fixture): void {
  const client = realClient(responder(f));
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
}

const REQUEST_PATH = `/api/rent-a-buddy/buddies/${BUDDY_PROF}/request`;
const BASE_BODY = { bookingDate: "2099-08-01", durationH: 2, city: CITY, category: "city" };

describe("A: the shorthand creation path reads rent_buddy_city_restrictions", () => {
  it("refuses a private meetup where require_public_meetup is set, and seats nothing", async () => {
    install({ restrictions: [{ city: CITY, category: null, require_public_meetup: true }] });
    const res = await httpReq(REQUEST_PATH, { ...BASE_BODY, meetupType: "private" });
    await settle();

    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body?.error, "public_meetup_required");
    assert.ok(restrictionReads().length > 0, "the restrictions table must actually be consulted on this path");
    assert.deepEqual(bookingsInserted(), [], "a refused booking must not be inserted");
  });

  it("refuses a cash split where disable_deposit_cash is set", async () => {
    install({ restrictions: [{ city: CITY, category: null, disable_deposit_cash: true }] });
    const res = await httpReq(REQUEST_PATH, { ...BASE_BODY, paymentMode: "deposit_plus_cash" });
    await settle();

    assert.equal(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body?.error, "cash_payment_unavailable");
    assert.deepEqual(bookingsInserted(), []);
  });

  it("allows a compliant booking — the gate is additive, not a blanket refusal", async () => {
    install({ restrictions: [{ city: CITY, category: null, require_public_meetup: true }] });
    const res = await httpReq(REQUEST_PATH, { ...BASE_BODY, meetupType: "public" });
    await settle();

    assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(bookingsInserted().length, 1);
  });

  it("an UNREADABLE restrictions table refuses this booking rather than allowing it", async () => {
    install({
      restrictions: new Response(JSON.stringify({ message: "statement timeout" }), {
        status: 500, headers: { "content-type": "application/json" },
      }),
    });
    const res = await httpReq(REQUEST_PATH, { ...BASE_BODY, meetupType: "private" });
    await settle();

    assert.equal(res.status, 503, `expected 503, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body?.error, "restrictions_unavailable");
    assert.deepEqual(
      bookingsInserted(), [],
      "a restriction that cannot be read might be one that should block this booking",
    );
  });
});

describe("B: the shorthand's launch-control read fails closed", () => {
  it("an UNREADABLE rent_buddy_launch_controls refuses, it does not read as 'none configured'", async () => {
    install({
      launchControls: new Response(JSON.stringify({ message: "connection terminated" }), {
        status: 500, headers: { "content-type": "application/json" },
      }),
    });
    const res = await httpReq(REQUEST_PATH, BASE_BODY);
    await settle();

    assert.equal(res.status, 503, `expected 503, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body?.error, "restrictions_unavailable");
    assert.deepEqual(
      bookingsInserted(), [],
      "dropping the error waived the country requirement AND every age / ID / phone rule at once",
    );
  });

  it("launch controls configured but none matching is DENIED, as on the canonical route", async () => {
    install({ launchControls: [{ id: "lc-1", city: "Bangkok", country_code: "TH", category: null, enabled: true }] });
    const res = await httpReq(REQUEST_PATH, BASE_BODY);
    await settle();

    assert.equal(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body?.error, "location_unavailable");
    assert.deepEqual(
      bookingsInserted(), [],
      "a city an admin has not listed must not be bookable through the shorthand and refused on the main route",
    );
  });

  it("no launch controls anywhere leaves the path unchanged", async () => {
    install({ launchControls: [] });
    const res = await httpReq(REQUEST_PATH, BASE_BODY);
    await settle();

    assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(bookingsInserted().length, 1);
  });
});
