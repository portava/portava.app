/**
 * IDF-25 REACH — the verified-minor contradiction rule, proven at each GATE.
 *
 * ── WHY THIS SUITE EXISTS AND WHY IT IS SHAPED LIKE THIS ────────────────────
 * The first attempt at this rule shipped a suite of pure-function tests. Every
 * one of them was green, and every one of them would ALSO have been green if no
 * gate in the product had consulted the rule at all — which is exactly what was
 * true: the rule lived in `loadTravelerIdentity`, four Rent-a-Buddy files called
 * it, and the seven gate families below called it zero times. A test that
 * exercises the helper proves the helper. It does not prove REACH.
 *
 * So every case here goes through the REAL router — a real express app, the real
 * handler, an HTTP request — or, for the one gate that is a service rather than
 * a route, through the service's real exported entry point. The fixture is
 * always the same person: a user whose `profiles.date_of_birth` makes them an
 * adult and whose newest decided `identity_verifications` row says
 * `is_over_18 = false`. Before the fix that user passed every gate below.
 *
 * The double is `helpers/failClosedSupabase`, the only one in this directory
 * that models BOTH the resolved-error read shape supabase-js really produces and
 * the writes these routes issue — so "the gate refused" can be asserted as "and
 * no row was written", not merely as a status code.
 *
 * Run: node --import tsx --test src/test/verifiedMinorGateReach.test.ts
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeFailClosedClient, type FakeClientSpec } from "./helpers/failClosedSupabase.js";

const VIEWER = "11111111-1111-4111-8111-111111111111";
const OTHER  = "22222222-2222-4222-8222-222222222222";
const TOKEN  = "reach-token";

/** Old enough that every 18+/21+ gate in the product admits them on the typed date alone. */
const ADULT_DOB = "1990-06-15";

/** The newest DECIDED provider result: this holder is not over 18. */
function minorVerification(userId = VIEWER) {
  return [{ user_id: userId, is_over_18: false, created_at: "2026-08-01T00:00:00.000Z" }];
}
/** The same shape, decided the other way — the control that must still pass. */
function adultVerification(userId = VIEWER) {
  return [{ user_id: userId, is_over_18: true, created_at: "2026-08-01T00:00:00.000Z" }];
}

function profileRows(userId = VIEWER, dob: string | null = ADULT_DOB) {
  return [{ id: userId, date_of_birth: dob, location_country: "US", verified: true }];
}

/**
 * `helpers/failClosedSupabase` implements the operators its own suites issue and
 * deliberately no more; GET /discovery/community additionally issues `.ilike`
 * for the city match. Rather than widen a double that
 * `src/test/supabaseContract.test.ts` checks against the REAL client — which
 * would make this suite's convenience a claim about PostgREST — the operator is
 * added HERE, on the instance, and routed through the double's own `.filter`.
 * It narrows nothing, which is correct for these fixtures and stated plainly so
 * no case is written that depends on it narrowing.
 */
function withIlike(c: any) {
  const from = c.from.bind(c);
  c.from = (table: string) => {
    const b = from(table);
    if (typeof b.ilike !== "function") b.ilike = (col: string, val: unknown) => b.filter(col, "ilike", val);
    return b;
  };
  return c;
}

function client(spec: FakeClientSpec) {
  const c = withIlike(makeFailClosedClient({ users: { [TOKEN]: VIEWER }, ...spec }));
  _setTestClient(c, true);
  _setTestServiceClient(c);
  return c;
}

// ── App plumbing ─────────────────────────────────────────────────────────────

async function startRouter(importPath: string): Promise<{ url: string; close: () => Promise<void> }> {
  const mod = await import(importPath);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: unknown, next: () => void) => {
    // The real server installs a logger. Without this shim these handlers CRASH
    // on req.log, and a 500-from-crash would satisfy a bare `notEqual(200)`.
    req.log = { info() {}, warn() {}, error(...a: any[]) { if (process.env.DEBUG_ROUTE_ERRORS) console.error('ROUTEERR', a?.[0]?.err ?? a); }, debug() {}, child() { return req.log; } };
    next();
  });
  app.use(mod.default);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  server.unref();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((res, rej) => {
      server.closeAllConnections();
      server.close((e) => (e ? rej(e) : res()));
    }),
  };
}

async function call(
  url: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: any = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  return { status: res.status, body: parsed };
}

/** Every refusal message in the product that names the USER'S RECORD. */
function assertSaysNothingAboutTheirProfile(message: unknown, where: string) {
  const m = String(message ?? "").toLowerCase();
  assert.ok(
    !m.includes("date of birth") && !m.includes("needs a date"),
    `${where}: refused by telling the user something about their date of birth — ` +
      `"${message}". It is on file and is contradicted, not missing.`,
  );
}

afterEach(() => { _clearTestClient(); _setTestServiceClient(null); });

// ── GATE 1 + 2: routes/meetups.ts ────────────────────────────────────────────

describe("GATE meetups — RSVP to an 18+ meetup (routes/meetups.ts)", () => {
  let url: string; let close: () => Promise<void>;
  const MEETUP = "33333333-3333-4333-8333-333333333333";

  before(async () => { ({ url, close } = await startRouter("../routes/meetups.js")); });
  after(async () => { await close(); });

  function world(verifications: any[]): FakeClientSpec {
    return {
      rows: {
        meetups: [{
          id: MEETUP, creator_id: OTHER, status: "open", visibility: "public",
          age_limit_enabled: true, min_age: 18, max_age: null, title: "Rooftop",
        }],
        meetup_invites: [{ id: "inv-1", meetup_id: MEETUP, user_id: VIEWER, status: "pending" }],
        profiles: profileRows(),
        identity_verifications: verifications,
      },
      inserted: {}, updated: {},
    };
  }

  it("a provider-verified minor with an adult birthday on file is REFUSED", async () => {
    const spec = world(minorVerification());
    client(spec);
    const { status, body } = await call(url, "POST", `/meetups/${MEETUP}/rsvp`, { status: "going" });
    assert.equal(status, 403, "the RSVP must not be seated");
    assert.equal(body.error, "age_not_eligible");
    assertSaysNothingAboutTheirProfile(body.message, "meetup RSVP");
    assert.equal((spec.inserted?.meetup_invites ?? []).length, 0, "and nothing was upserted");
  });

  it("the same person WITHOUT the contradiction still RSVPs — the gate did not simply close", async () => {
    const spec = world(adultVerification());
    client(spec);
    const { status } = await call(url, "POST", `/meetups/${MEETUP}/rsvp`, { status: "going" });
    assert.equal(status, 200, "an adult confirmed by the provider is unaffected");
  });

  it("an UNREADABLE identity_verifications refuses RETRYABLY and accuses nobody", async () => {
    const spec: FakeClientSpec = {
      ...world([]),
      failOn: (ctx) => (ctx.table === "identity_verifications" ? { message: "down", code: "57P01" } : null),
    };
    client(spec);
    const { status, body } = await call(url, "POST", `/meetups/${MEETUP}/rsvp`, { status: "going" });
    assert.notEqual(status, 200, "an outage is not a pass");
    assert.equal(body.error, "degraded_unavailable", "and it is reported as an outage, not as a verdict");
    assertSaysNothingAboutTheirProfile(body.message, "meetup RSVP outage");
  });
});

describe("GATE meetups — inviting a verified minor to an 18+ meetup", () => {
  let url: string; let close: () => Promise<void>;
  const MEETUP = "44444444-4444-4444-8444-444444444444";

  before(async () => { ({ url, close } = await startRouter("../routes/meetups.js")); });
  after(async () => { await close(); });

  it("the invitee pre-check filters the verified minor into ageIneligible", async () => {
    const spec: FakeClientSpec = {
      rows: {
        meetups: [{
          id: MEETUP, creator_id: VIEWER, status: "open", visibility: "public",
          trip_id: null, circle_owner_id: null,
          age_limit_enabled: true, min_age: 18, max_age: null, title: "Rooftop",
        }],
        meetup_invites: [],
        user_friendships: [{ user_a: VIEWER, user_b: OTHER }],
        profiles: [...profileRows(OTHER), ...profileRows()],
        identity_verifications: minorVerification(OTHER),
      },
      inserted: {}, updated: {},
    };
    client(spec);
    const { status, body } = await call(url, "POST", `/meetups/${MEETUP}/invites`, { userIds: [OTHER] });
    assert.equal(status, 200);
    assert.deepEqual(body.ageIneligible, [OTHER], "the contradicted invitee is age-ineligible");
    assert.deepEqual(body.invited, [], "and no invite row was created for them");
  });
});

// ── GATE 3: routes/requests.ts ───────────────────────────────────────────────

describe("GATE requests — accepting an 18+ circle invite (routes/requests.ts)", () => {
  let url: string; let close: () => Promise<void>;
  const INVITE = "55555555-5555-4555-8555-555555555555";

  before(async () => { ({ url, close } = await startRouter("../routes/requests.js")); });
  after(async () => { await close(); });

  function world(verifications: any[]): FakeClientSpec {
    return {
      rows: {
        circle_invites: [{ id: INVITE, owner_id: OTHER, recipient_id: VIEWER, status: "pending" }],
        circle_age_settings: [{ owner_id: OTHER, age_limit_enabled: true, min_age: 18, max_age: null }],
        profiles: profileRows(),
        identity_verifications: verifications,
      },
      inserted: {}, updated: {},
    };
  }

  it("a provider-verified minor is REFUSED and joins no circle", async () => {
    const spec = world(minorVerification());
    client(spec);
    const { status, body } = await call(url, "POST", `/me/requests/circle_invite/${INVITE}/accept`, {});
    assert.equal(status, 403);
    assert.equal(body.error, "age_not_eligible");
    assertSaysNothingAboutTheirProfile(body.message, "circle invite accept");
    assert.equal((spec.inserted?.circle_memberships ?? []).length, 0, "and no membership was written");
  });

  it("the same person without the contradiction still accepts", async () => {
    const spec = world(adultVerification());
    client(spec);
    const { status } = await call(url, "POST", `/me/requests/circle_invite/${INVITE}/accept`, {});
    assert.equal(status, 200);
  });
});

// ── GATE 4 + 5: routes/events.ts ─────────────────────────────────────────────

describe("GATE events — joining and waitlisting an age-restricted event (routes/events.ts)", () => {
  let url: string; let close: () => Promise<void>;
  const EVENT = "66666666-6666-4666-8666-666666666666";

  before(async () => { ({ url, close } = await startRouter("../routes/events.js")); });
  after(async () => { await close(); });

  function world(verifications: any[], state = "open"): FakeClientSpec {
    return {
      rows: {
        feature_flags: [{ flag: "events_trust_gates_enabled", enabled: true }],
        events: [{
          id: EVENT, host_id: OTHER, state, rsvp_closed: false, visibility: "public",
          verified_only: false, trust_score_min: null, age_min: 18, age_max: null,
          capacity: 10, going_count: 0, waitlist_enabled: true, waitlist_count: 0,
        }],
        event_roles: [], event_rsvps: [], event_waitlist: [], profiles: profileRows(),
        identity_verifications: verifications,
      },
      inserted: {}, updated: {},
    };
  }

  it("RSVP: a provider-verified minor is REFUSED", async () => {
    const spec = world(minorVerification());
    client(spec);
    const { status, body } = await call(url, "POST", `/events/${EVENT}/rsvp`, { status: "going" });
    assert.equal(status, 403);
    assertSaysNothingAboutTheirProfile(body.message, "event RSVP");
    assert.equal((spec.inserted?.event_rsvps ?? []).length, 0, "and no RSVP row was written");
  });

  it("RSVP: the same person without the contradiction is admitted by the age gate", async () => {
    const spec = world(adultVerification());
    client(spec);
    const { status } = await call(url, "POST", `/events/${EVENT}/rsvp`, { status: "going" });
    assert.notEqual(status, 403, "an adult confirmed by the provider is not refused by the age gate");
  });

  it("WAITLIST: a provider-verified minor is REFUSED at the separate waitlist gate", async () => {
    const spec = world(minorVerification(), "full");
    client(spec);
    const { status, body } = await call(url, "POST", `/events/${EVENT}/waitlist`, {});
    assert.equal(status, 403);
    assertSaysNothingAboutTheirProfile(body.message, "event waitlist");
    assert.equal((spec.inserted?.event_waitlist ?? []).length, 0, "and no waitlist row was written");
  });
});

// ── GATE 6: routes/mediaFeed.ts ──────────────────────────────────────────────

describe("GATE mediaFeed — viewer age for age-restricted media (routes/mediaFeed.ts)", () => {
  let url: string; let close: () => Promise<void>;
  const POST = "77777777-7777-4777-8777-777777777777";

  before(async () => { ({ url, close } = await startRouter("../routes/mediaFeed.js")); });
  after(async () => { await close(); });

  function world(verifications: any[]): FakeClientSpec {
    return {
      rows: {
        feature_flags: [{ flag: "MEDIA_FOR_YOU_ENABLED", enabled: true }],
        posts: [{
          id: POST, author_id: OTHER, status: "active", has_video: true, visibility: "public",
          created_at: "2026-09-01T00:00:00.000Z", age_restriction_enabled: true, age_min: 18, age_max: null,
          post_media: [{ id: "m-1", processing_status: "ready", moderation_status: "approved" }],
          profiles: { id: OTHER },
        }],
        profiles: profileRows(),
        identity_verifications: verifications,
      },
      inserted: {}, updated: {},
    };
  }

  it("an age-restricted post is WITHHELD from a provider-verified minor", async () => {
    client(world(minorVerification()));
    const { status, body } = await call(url, "GET", "/media/feed?mode=fullscreen&feedType=for_you&limit=5");
    assert.equal(status, 200);
    assert.deepEqual((body.items ?? []).map((i: any) => i.id), [],
      "the adult-restricted post reached a user a document says is a minor");
  });

  it("the same post reaches the same person once the provider confirms they are an adult", async () => {
    client(world(adultVerification()));
    const { status, body } = await call(url, "GET", "/media/feed?mode=fullscreen&feedType=for_you&limit=5");
    assert.equal(status, 200);
    assert.deepEqual((body.items ?? []).map((i: any) => i.id), [POST],
      "the control: the gate closed on the contradiction, not on the fixture");
  });
});

// ── GATE 7: services/media/MediaProjectionService.ts ─────────────────────────

describe("GATE MediaProjectionService — resolveViewer (services/media/MediaProjectionService.ts)", () => {
  it("resolves NO usable age for a provider-verified minor", async () => {
    const { resolveViewer } = await import("../services/media/MediaProjectionService.js");
    const c = makeFailClosedClient({
      users: { [TOKEN]: VIEWER },
      rows: { profiles: profileRows(), identity_verifications: minorVerification() },
    });
    const viewer = await resolveViewer(c, VIEWER);
    assert.equal(viewer.viewerAge, null,
      "a contradicted birthday must not become the number the media age gate compares");
    assert.equal(viewer.viewerCountry, "US", "and the rest of the viewer context still resolves");
  });

  it("resolves the real age when the provider confirms the adult", async () => {
    const { resolveViewer } = await import("../services/media/MediaProjectionService.js");
    const c = makeFailClosedClient({
      users: { [TOKEN]: VIEWER },
      rows: { profiles: profileRows(), identity_verifications: adultVerification() },
    });
    const viewer = await resolveViewer(c, VIEWER);
    assert.ok((viewer.viewerAge ?? 0) >= 18, "the control");
  });

  it("an UNREADABLE identity_verifications yields no usable age either", async () => {
    const { resolveViewer } = await import("../services/media/MediaProjectionService.js");
    const c = makeFailClosedClient({
      users: { [TOKEN]: VIEWER },
      rows: { profiles: profileRows(), identity_verifications: [] },
      failOn: (ctx) => (ctx.table === "identity_verifications" ? { message: "down", code: "57P01" } : null),
    });
    const viewer = await resolveViewer(c, VIEWER);
    assert.equal(viewer.viewerAge, null, "could-not-check is not checked-and-clean");
  });
});

// ── GATE 8: routes/discovery.ts ──────────────────────────────────────────────

describe("GATE discovery — caller age for age-restricted discovery (routes/discovery.ts)", () => {
  let url: string; let close: () => Promise<void>;
  let injectCache: (key: string, places: any[]) => void;
  let clearCache: (key: string) => void;
  let setDbPlaces: (fn: any) => void;
  const KEY = "miami:for_you:10";

  before(async () => {
    const mod: any = await import("../routes/discovery.js");
    injectCache = mod._injectTestCacheEntry;
    clearCache  = mod._clearTestCacheEntry;
    setDbPlaces = mod._setTestDbPlacesOverride;
    ({ url, close } = await startRouter("../routes/discovery.js"));
  });
  after(async () => { setDbPlaces(null); await close(); });
  beforeEach(() => { setDbPlaces(async () => []); });
  afterEach(() => { clearCache(KEY); });

  /** An adult-only OSM venue type — the proxy the route filters on. */
  function bar() {
    return {
      id: "osm/bar-1", canonicalPlaceId: null, name: "The Bar", category: "bar",
      type: "osm", description: null, distanceKm: 1, lat: 25.77, lng: -80.19,
      tags: [], address: "Miami", website: null, phone: null, openingHours: null,
      rating: null, isOpenNow: null, savedCount: 0,
    };
  }

  it("GET /discovery?ageFilter=open_to_me withholds adult-only venues from a verified minor", async () => {
    client({ rows: { profiles: profileRows(), identity_verifications: minorVerification() } });
    injectCache(KEY, [bar()] as any);
    const { status, body } = await call(
      url, "GET", "/discovery?destination=Miami&category=for_you&radiusKm=10&lat=25.77&lng=-80.19&ageFilter=open_to_me",
    );
    assert.equal(status, 200);
    assert.deepEqual((body.places ?? []).map((p: any) => p.name), [],
      "a bar was served to a caller a document says is under 18");
    assert.notEqual(body.ageFilterMeta?.callerDobMissing, true,
      "and the response did not claim their date of birth is missing — it is on file");
  });

  it("the control: the same venue is served once the provider confirms the adult", async () => {
    client({ rows: { profiles: profileRows(), identity_verifications: adultVerification() } });
    injectCache(KEY, [bar()] as any);
    const { body } = await call(
      url, "GET", "/discovery?destination=Miami&category=for_you&radiusKm=10&lat=25.77&lng=-80.19&ageFilter=open_to_me",
    );
    assert.deepEqual((body.places ?? []).map((p: any) => p.name), ["The Bar"]);
  });

  it("GET /discovery/community reports the contradiction rather than a missing date of birth", async () => {
    client({
      rows: {
        profiles: profileRows(),
        identity_verifications: minorVerification(),
        discovery_places: [],
      },
    });
    const { status, body } = await call(url, "GET", "/discovery/community?city=Miami&ageFilter=open_to_me");
    assert.equal(status, 200);
    assert.notEqual(body.ageFilterMeta?.callerDobMissing, true,
      "their date of birth is on file; saying it is missing is a fabricated verdict");
    assert.equal(body.ageFilterMeta?.callerAgeState, "not_verified_adult",
      "the response names what actually happened");
  });
});

// ── GATE 9: routes/profile.ts ────────────────────────────────────────────────

describe("GATE profile — the ageGateRequired flag the client acts on (routes/profile.ts)", () => {
  let url: string; let close: () => Promise<void>;

  before(async () => { ({ url, close } = await startRouter("../routes/profile.js")); });
  after(async () => { await close(); });

  it("ageGateRequired is TRUE for a provider-verified minor with an adult birthday typed", async () => {
    client({ rows: { profiles: profileRows(), identity_verifications: minorVerification() } });
    const { status, body } = await call(url, "GET", "/me/profile");
    assert.equal(status, 200);
    assert.equal(body.ageGateRequired, true,
      "the client was told this adult-by-typed-date user needs no age gate");
  });

  it("ageGateRequired is FALSE for the same person once the provider confirms the adult", async () => {
    client({ rows: { profiles: profileRows(), identity_verifications: adultVerification() } });
    const { body } = await call(url, "GET", "/me/profile");
    assert.equal(body.ageGateRequired, false, "the control");
  });

  it("an outage is a DISTINCT third answer, not a claim about the user", async () => {
    client({
      rows: { profiles: profileRows(), identity_verifications: [] },
      failOn: (ctx) => (ctx.table === "identity_verifications" ? { message: "down", code: "57P01" } : null),
    });
    const { body } = await call(url, "GET", "/me/profile");
    assert.equal(body.ageGateRequired, true, "fail closed");
    assert.equal(body.ageVerificationUnavailable, true,
      "and the client can tell 'we could not check' from 'this user is under 18'");
  });
});
