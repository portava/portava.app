/**
 * FAIL-OPEN unchecked reads — HTTP surfaces.
 *
 * Same defect class as src/test/failOpenServiceReads.test.ts: supabase-js
 * RESOLVES on a DB error, so `const { data } = await …` makes an unreadable
 * table indistinguishable from an empty one — and on these four surfaces the
 * empty reading was the permissive one:
 *
 *   rent_buddy_launch_controls   "no launch controls exist" → book anywhere
 *   geofence_admin_settings      admin radius clamp → the wide built-in defaults
 *   trust_restrictions           a restricted user rendered as having none
 *   delayed_post_location_events an uncountable abuse cap → credit past the cap
 *
 * TWO VACUITY TRAPS ARE AVOIDED DELIBERATELY, both of which have produced false
 * green here before:
 *
 *   1. Never `assert.notEqual(status, 200)`. A request rejected at VALIDATION
 *      never reaches the code under test and would satisfy that. Every
 *      assertion below names the exact `error` code in the JSON envelope.
 *   2. The `req.log` shim the real server installs is present. Without it these
 *      routes CRASH with a TypeError and a 500-from-crash masquerades as
 *      fail-closed.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/failOpenRouteReads.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeFailClosedClient, noopLog } from "./helpers/failClosedSupabase.js";
import geofenceRouter from "../routes/geofence.js";
import trustAdminRouter from "../routes/trust-admin.js";
import postsRouter from "../routes/posts.js";
import { enforceBookingCreationGates } from "../routes/rentABuddy.js";

const USER = "aaaaaaaa-0000-4000-a000-000000000001";
const ADMIN = "bbbbbbbb-0000-4000-a000-000000000002";
const SUBJECT = "cccccccc-0000-4000-a000-000000000003";
const TRIP = "dddddddd-0000-4000-a000-000000000004";
const BUDDY_USER = "eeeeeeee-0000-4000-a000-000000000005";

const USER_TOKEN = "tok-user";
const ADMIN_TOKEN = "tok-admin";

// ── Server ──────────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  // The shim the real server installs. Without it every `req.log.warn(...)`
  // in these handlers throws and the resulting 500 would be mistaken for a
  // deliberate refusal.
  app.use((req, _res, next) => { (req as any).log = noopLog; next(); });
  app.use("/api", geofenceRouter);
  app.use("/api", trustAdminRouter);
  app.use("/api", postsRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(async () => { await new Promise<void>((r) => server.close(() => r())); });

function req(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port),
        path: url.pathname + url.search, method,
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
    if (payload) r.write(payload);
    r.end();
  });
}

function install(spec: Parameters<typeof makeFailClosedClient>[0]) {
  const c = makeFailClosedClient(spec);
  _setTestClient(c, true);
  _setTestServiceClient(c);
  return c;
}

const READ_FAIL = { message: "server closed the connection unexpectedly", code: "08006" };

// ═══════════════════════════════════════════════════════════════════════════
// rent_buddy_launch_controls — the booking-creation gate (authorization)
// ═══════════════════════════════════════════════════════════════════════════
//
// enforceBookingCreationGates is the SINGLE gate stack every booking-creation
// path runs. Two `count` reads of rent_buddy_launch_controls decide (a) whether
// countryCode is mandatory and (b) whether an unmatched booking is denied by
// default. `const { count } = await …` yields `undefined` → `?? 0` → ZERO for a
// failed read, and zero means "no launch controls are configured anywhere" —
// so an unreadable admin-policy table waived both.
//
// Called directly rather than over HTTP: the function is exported precisely so
// every creation path shares it, and a direct call reaches the gate without
// passing through any route's validation (which is where a `status !== 200`
// assertion would have been satisfied for the wrong reason).

function fakeRes() {
  const out: { status: number | null; body: any } = { status: null, body: null };
  const res: any = {
    status(code: number) { out.status = code; return res; },
    json(payload: any) { out.body = payload; return res; },
  };
  return { res, out };
}

function gateOpts(sc: any, extra: Record<string, unknown> = {}) {
  const { res, out } = fakeRes();
  return {
    out,
    opts: {
      sc, res,
      userId: USER,
      buddyProfile: { user_id: BUDDY_USER, verification_status: "verified" },
      city: "Lisbon",
      category: "day_tour",
      ...extra,
    } as any,
  };
}

describe("enforceBookingCreationGates — rent_buddy_launch_controls", () => {
  it("FAILURE: an unreadable control table does NOT waive the countryCode requirement", async () => {
    // ISOLATION MATTERS HERE. Only the unfiltered `count` read — the one the
    // countryCode gate makes — is failed; the resolver's keyed lookups still
    // succeed and DO find a matching control. So if this gate stopped honouring
    // its error the request would sail past into the launch-control policy
    // itself (a 403 on age/DOB), never reaching the deny-by-default branch that
    // would otherwise mask the regression behind an identical 503.
    const sc = makeFailClosedClient({
      rows: {
        rent_buddy_launch_controls: [{
          id: "lc-any", country_code: null, city: null, category: "day_tour",
          enabled: true, min_age: 18, nightlife_min_age: 21,
          require_id_verification: false, require_phone_verification: false,
        }],
      },
      failOn: (ctx) =>
        ctx.table === "rent_buddy_launch_controls" && ctx.filters.length === 0 ? READ_FAIL : null,
    });
    const { opts, out } = gateOpts(sc); // no countryCode
    const ok = await enforceBookingCreationGates(opts);
    assert.equal(ok, false);
    assert.equal(out.status, 503);
    assert.equal(out.body?.error, "restrictions_unavailable");
    assert.equal(out.body?.retryable, true);
  });

  it("FAILURE: an unreadable control table does NOT bypass deny-by-default", async () => {
    // countryCode IS supplied, so the first read is skipped entirely and the
    // resolver finds no matching control — landing in the deny-by-default
    // branch, whose own count read is the one that fails here.
    const sc = makeFailClosedClient({
      rows: { rent_buddy_launch_controls: [] },
      failOn: (ctx) =>
        ctx.table === "rent_buddy_launch_controls" && ctx.filters.some((f) => f.op === "eq" || f.op === "is")
          ? null // the resolver's keyed lookups succeed and find nothing
          : ctx.table === "rent_buddy_launch_controls" ? READ_FAIL : null,
    });
    const { opts, out } = gateOpts(sc, { countryCode: "PT" });
    const ok = await enforceBookingCreationGates(opts);
    assert.equal(ok, false);
    assert.equal(out.status, 503);
    assert.equal(out.body?.error, "restrictions_unavailable");
  });

  it("HEALTHY: no launch controls configured — the booking is allowed through", async () => {
    const sc = makeFailClosedClient({ rows: { rent_buddy_launch_controls: [], blocks: [] } });
    const { opts, out } = gateOpts(sc);
    const ok = await enforceBookingCreationGates(opts);
    assert.equal(ok, true, `gate must not over-block; response was ${JSON.stringify(out)}`);
    assert.equal(out.status, null, "no response may be sent when every gate passes");
  });

  it("HEALTHY: controls exist and countryCode is missing — the 400 still fires", async () => {
    const sc = makeFailClosedClient({
      rows: {
        rent_buddy_launch_controls: [
          { id: "lc1", country_code: "PT", city: null, category: null, enabled: true },
        ],
      },
    });
    const { opts, out } = gateOpts(sc);
    const ok = await enforceBookingCreationGates(opts);
    assert.equal(ok, false);
    assert.equal(out.status, 400);
    assert.equal(out.body?.error, "invalid_payload");
  });

  it("HEALTHY: controls exist but none match — deny-by-default still fires", async () => {
    const sc = makeFailClosedClient({
      rows: {
        rent_buddy_launch_controls: [
          { id: "lc1", country_code: "FR", city: null, category: null, enabled: true },
        ],
      },
    });
    const { opts, out } = gateOpts(sc, { countryCode: "PT" });
    const ok = await enforceBookingCreationGates(opts);
    assert.equal(ok, false);
    assert.equal(out.status, 403);
    assert.equal(out.body?.error, "location_unavailable");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// geofence_admin_settings — the admin radius clamp
// ═══════════════════════════════════════════════════════════════════════════

const GEOFENCE_BODY = {
  lat: 38.72, lng: -9.14, checkInRadiusM: 5000,
};

function geofenceRows(extra: Record<string, any[]> = {}) {
  return {
    profiles: [{ id: USER, account_status: "active" }],
    trips: [{ id: TRIP, owner_id: USER }],
    plan_geofences: [],
    geofence_admin_settings: [],
    feature_flags: [{ flag: "plan_geofence_enabled", enabled: true }],
    ...extra,
  };
}

describe("POST /trips/:tripId/geofence — geofence_admin_settings", () => {
  it("FAILURE: an unreadable settings row refuses instead of clamping to built-in defaults", async () => {
    install({
      rows: geofenceRows(),
      users: { [USER_TOKEN]: USER },
      failOn: (ctx) => (ctx.table === "geofence_admin_settings" ? READ_FAIL : null),
    });
    const r = await req("POST", `/api/trips/${TRIP}/geofence`, USER_TOKEN, GEOFENCE_BODY);
    assert.equal(r.body?.error, "degraded_unavailable", `got ${JSON.stringify(r.body)}`);
    assert.equal(r.status, 503);
  });

  it("HEALTHY: an ABSENT settings row still uses the shipped defaults", async () => {
    const spec: any = {
      rows: geofenceRows(),
      users: { [USER_TOKEN]: USER },
      inserted: {},
    };
    install(spec);
    const r = await req("POST", `/api/trips/${TRIP}/geofence`, USER_TOKEN, GEOFENCE_BODY);
    assert.equal(r.status, 201, `expected the save to succeed; got ${JSON.stringify(r.body)}`);
    assert.equal(r.body.effectiveRadiusM, 5000, "the built-in max is 5000 m");
    assert.equal(
      (spec.inserted.plan_geofences ?? [])[0]?.check_in_radius_m, 5000,
      "and the written row carries it",
    );
  });

  it("HEALTHY: a configured settings row still clamps the requested radius", async () => {
    const spec: any = {
      rows: geofenceRows({
        geofence_admin_settings: [{
          id: 1, default_radius_m: 150, min_radius_m: 50, max_radius_m: 200,
          no_show_affects_reliability: false,
        }],
      }),
      users: { [USER_TOKEN]: USER },
      inserted: {},
    };
    install(spec);
    const r = await req("POST", `/api/trips/${TRIP}/geofence`, USER_TOKEN, GEOFENCE_BODY);
    assert.equal(r.status, 201, `expected the save to succeed; got ${JSON.stringify(r.body)}`);
    assert.equal(
      r.body.effectiveRadiusM, 200,
      "the ADMIN max must bind — this is the policy the fail-open path silently widened to 5000",
    );
    assert.equal((spec.inserted.plan_geofences ?? [])[0]?.check_in_radius_m, 200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// trust_restrictions — the moderator's dossier
// ═══════════════════════════════════════════════════════════════════════════

function trustRows(extra: Record<string, any[]> = {}) {
  return {
    profiles: [
      { id: ADMIN, account_status: "active", role: "admin" },
      { id: SUBJECT, account_status: "active", role: "user" },
    ],
    trust_profiles: [{ user_id: SUBJECT, score: 40 }],
    trust_caps: [],
    trust_restrictions: [],
    trust_events: [],
    trust_reviews: [],
    ...extra,
  };
}

describe("GET /admin/trust/users/:userId — trust_restrictions", () => {
  it("FAILURE: an unreadable exclusion table must not render a clean record", async () => {
    install({
      rows: trustRows(),
      users: { [ADMIN_TOKEN]: ADMIN },
      failOn: (ctx) => (ctx.table === "trust_restrictions" ? READ_FAIL : null),
    });
    const r = await req("GET", `/api/admin/trust/users/${SUBJECT}`, ADMIN_TOKEN);
    assert.equal(r.body?.error, "degraded_unavailable", `got ${JSON.stringify(r.body)}`);
    assert.equal(r.status, 503);
    assert.equal(r.body?.restrictions, undefined, "no dossier may be served at all");
  });

  it("HEALTHY: a genuinely unrestricted user still renders an empty restriction list", async () => {
    install({ rows: trustRows(), users: { [ADMIN_TOKEN]: ADMIN } });
    const r = await req("GET", `/api/admin/trust/users/${SUBJECT}`, ADMIN_TOKEN);
    assert.equal(r.status, 200, `got ${JSON.stringify(r.body)}`);
    assert.deepEqual(r.body.restrictions, []);
  });

  it("HEALTHY: a restricted user's restrictions are still returned", async () => {
    install({
      rows: trustRows({
        trust_restrictions: [{
          id: "r1", user_id: SUBJECT, restriction_type: "no_hosting",
          reason: "repeat no-shows", expires_at: null,
          created_at: new Date().toISOString(), lifted_at: null,
        }],
      }),
      users: { [ADMIN_TOKEN]: ADMIN },
    });
    const r = await req("GET", `/api/admin/trust/users/${SUBJECT}`, ADMIN_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.restrictions.length, 1);
    assert.equal(r.body.restrictions[0].restriction_type, "no_hosting");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// delayed_post_location_events — the geotag-credit abuse cap
// ═══════════════════════════════════════════════════════════════════════════
//
// The cap has THREE honest answers, not two. `over_cap` moves the post to
// `pending_safety_review` — a moderation assertion about the user — so flipping
// the old boolean would have traded "fabricate a reward" for "fabricate an
// accusation". `unknown` awards nothing and accuses nobody.

const POST_BODY = {
  content: "flat white",
  locationSource: "gps",
  locationLat: 38.7223, locationLng: -9.1393,
  userGpsLat: 38.7223, userGpsLng: -9.1393,
  venueName: "Copenhagen Coffee Lab",
  locationPrivacyMode: "none",
};

function postRows() {
  return {
    profiles: [{ id: USER, account_status: "active", handle: "tester" }],
    posts: [],
    feature_flags: [],
    delayed_post_location_events: [] as any[],
  };
}

/** Update payloads applied to `posts` during one request. */
function postUpdates(spec: any): any[] {
  return (spec.updated?.posts ?? []) as any[];
}

describe("POST /posts — geotag credit cap", () => {
  it("FAILURE: an uncountable cap awards NO credit and flags NO post", async () => {
    const spec: any = {
      rows: postRows(),
      users: { [USER_TOKEN]: USER },
      updated: {}, inserted: {},
      failOn: (ctx: any) => (ctx.table === "delayed_post_location_events" ? READ_FAIL : null),
    };
    install(spec);
    const r = await req("POST", "/api/posts", USER_TOKEN, POST_BODY);
    assert.equal(r.status, 201, `the post itself must still be created; got ${JSON.stringify(r.body)}`);
    const updates = postUpdates(spec);
    assert.equal(
      updates.some((u) => u.geotag_credit_awarded === true), false,
      "no credit may be awarded when the cap could not be counted",
    );
    assert.equal(
      updates.some((u) => u.post_status === "pending_safety_review"), false,
      "and no accusation may be manufactured either",
    );
  });

  it("HEALTHY: under the cap, the credit is still awarded", async () => {
    const spec: any = {
      rows: postRows(),
      users: { [USER_TOKEN]: USER },
      updated: {}, inserted: {},
    };
    install(spec);
    const r = await req("POST", "/api/posts", USER_TOKEN, POST_BODY);
    assert.equal(r.status, 201, `got ${JSON.stringify(r.body)}`);
    assert.ok(
      postUpdates(spec).some((u) => u.geotag_credit_awarded === true),
      `expected a geotag credit; updates were ${JSON.stringify(postUpdates(spec))}`,
    );
  });

  it("HEALTHY: at the cap, the post is still flagged for safety review", async () => {
    const rows = postRows();
    rows.delayed_post_location_events = Array.from({ length: 3 }, (_, i) => ({
      id: `e${i}`, user_id: USER, event_type: "geotag_credit_awarded",
      created_at: new Date().toISOString(),
      metadata: { venue_name: "Copenhagen Coffee Lab" },
    }));
    const spec: any = { rows, users: { [USER_TOKEN]: USER }, updated: {}, inserted: {} };
    install(spec);
    const r = await req("POST", "/api/posts", USER_TOKEN, POST_BODY);
    assert.equal(r.status, 201, `got ${JSON.stringify(r.body)}`);
    const updates = postUpdates(spec);
    assert.ok(
      updates.some((u) => u.post_status === "pending_safety_review"),
      `expected the safety-review flag; updates were ${JSON.stringify(updates)}`,
    );
    assert.equal(updates.some((u) => u.geotag_credit_awarded === true), false);
  });
});
