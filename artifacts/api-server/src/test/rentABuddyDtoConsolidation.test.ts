/**
 * The five remaining marketplace endpoints that served buddies through a
 * SECOND, local DTO — and the block filter none of them had.
 *
 * WHAT WAS WRONG
 * ==============
 * cb80eddff consolidated GET /sections onto the canonical public buddy DTO
 * (lib/buddyMapRead: BUDDY_PUBLIC_COLUMNS → stripBuddyPrivateFields →
 * mapBuddyPublicProfile) and reported that the local `mapProfile` still served
 * five more endpoints on `select("*")`, with the same omission-not-strip
 * exposure: private columns were read into memory and only the local mapper's
 * happening not to emit them kept them off the wire.
 *
 *   POST /rent-a-buddy/match
 *   GET  /rent-a-buddy/available-now
 *   GET  /rent-a-buddy/cities/:city/top
 *   GET  /rent-a-buddy/requests/:requestId/offers
 *   GET  /rent-a-buddy/me/saved-buddies
 *
 * Separately, NONE of them — nor GET /sections — filtered blocked people, the
 * same defect class POST /rent-a-buddy/search carried until cb80eddff.
 *
 * WHAT THIS SUITE PINS
 * ====================
 * 1. THE EXACT FIELD SET per endpoint. Not "these fields are present" — the
 *    complete key set, so drift in EITHER direction fails loudly here.
 * 2. NO MEETUP BASE. mapBuddyPublicProfile emits meetupBaseLat/Lng; none of
 *    these endpoints ever has. Those are a person's real location, and emitting
 *    them because the canonical mapper carries them would be a NEW disclosure
 *    dressed as consolidation. Each endpoint is canonical MINUS the meetup base,
 *    and the raw response body is searched for the coordinates themselves.
 * 3. BLOCKS, BIDIRECTIONALLY AND FAIL-CLOSED. "I blocked them" and "they blocked
 *    me" both remove the person, and an unreadable `blocks` table exposes
 *    NOBODY — never the unfiltered list.
 * 4. POST /match STILL EXCLUDES A RISK-HELD BUDDY. That endpoint deliberately
 *    keeps `select("*")`, because its ranker reads eleven columns absent from
 *    BUDDY_PUBLIC_COLUMNS and two of them (risk_hold, admin_status) gate
 *    ELIGIBILITY. Narrowing the select would default risk_hold to false and make
 *    risk-held buddies matchable. This test is what fails if someone "finishes
 *    the consolidation" there.
 *
 * WHAT THIS SUITE CANNOT PROVE — stated plainly
 * =============================================
 * (a) The fake Supabase client ignores the select list and returns whole
 *     fixture rows, so narrowing a select from `*` to BUDDY_PUBLIC_COLUMNS is
 *     invisible to it. What is tested here is the SERVING code.
 * (b) Consequently, dropping `stripBuddyPrivateFields` from the composition
 *     catches NOTHING through any of these endpoints — exactly as cb80eddff
 *     found for /sections. The canonical mapper's allow-list already keeps every
 *     private sentinel off the wire, so no black-box test through an endpoint
 *     can distinguish "stripped" from "never mapped". The strip stays because it
 *     protects callers that spread a row before mapping, and it is unit-tested
 *     directly in src/test/buddyMapRead.test.ts. The private-sentinel assertions
 *     below are still worth running — they catch a future mapper that starts
 *     emitting a private column — but they are not proof of the strip.
 *
 * Run:
 *   node --import tsx/esm --test src/test/rentABuddyDtoConsolidation.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import marketplaceRouter from "../routes/rentABuddyMarketplace.js";
import { mapBuddyPublicProfile, stripBuddyPrivateFields } from "../lib/buddyMapRead.js";

const TOKEN = "dto-consolidation-token";
const VIEWER = "viewer-user-id";

/** Buddy A — the viewer blocked them. */
const U_A = "buddy-user-a";
/** Buddy B — they blocked the viewer. */
const U_B = "buddy-user-b";
/** Buddy C — no block relationship in either direction. */
const U_C = "buddy-user-c";

/** Values that must never cross the wire. */
const PRIVATE_SENTINELS = {
  legal_name: "LEGAL-NAME-SENTINEL",
  phone_number: "PHONE-SENTINEL",
  exact_address: "EXACT-ADDRESS-SENTINEL",
  home_address: "HOME-ADDRESS-SENTINEL",
  id_verification_ref: "IDREF-SENTINEL",
};

/** The meetup base is a real location; no endpoint here may put it on the wire. */
const MEETUP_LAT = 16.061;
const MEETUP_LNG = 108.211;

/**
 * A whole profile row, as `select("*")` would return it: every column the
 * canonical DTO reads, every column the retired local mapper read, and the
 * private sentinels.
 */
function buddyRow(id: string, userId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    user_id: userId,
    display_name: `Buddy ${id}`,
    tagline: `Tagline ${id}`,
    bio: `Bio ${id}`,
    intro_video_url: "https://example.test/intro.mp4",
    languages: ["en", "vi"],
    city: "Da Nang",
    country: "VN",
    categories: ["food"],
    hourly_rate_usd: "20",
    status: "active",
    admin_status: "active",
    verified: true,
    verified_at: "2026-01-02T00:00:00.000Z",
    verification_status: "approved",
    average_rating: "4.5",
    review_count: 5,
    completed_bookings: 3,
    completed_count: 7,
    response_time_h: "2",
    cover_photo_url: "https://example.test/cover.jpg",
    gallery_urls: ["https://example.test/g1.jpg"],
    vibe_tags: ["chill"],
    safety_badges: ["id_verified"],
    buddy_level: "seasoned",
    category_approvals: { food: true },
    new_buddy_public_only: false,
    new_buddy_daytime_only: false,
    new_buddy_max_hours: 4,
    max_group_size: 4,
    preferred_meetup_zones: ["An Thuong"],
    availability_blocks: [{ day: "mon" }],
    meetup_base_lat: MEETUP_LAT,
    meetup_base_lng: MEETUP_LNG,
    featured: false,
    available_now: true,
    cancel_count: 0,
    no_show_count: 0,
    favorites_count: 4,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    profiles: { verification_level: "id_verified" },
    // Columns the retired local mapper emitted and the canonical DTO does not.
    half_day_rate_usd: "80",
    full_day_rate_usd: "150",
    nightlife_rate_usd: "60",
    arrival_rate_usd: "40",
    city_ambassador: false,
    female_only_service: true,
    public_meetup_only: true,
    group_approved: true,
    nightlife_approved: true,
    arrival_approved: true,
    energy_type: "calm",
    risk_hold: false,
    ...PRIVATE_SENTINELS,
    ...over,
  };
}

const ROWS = [buddyRow("a", U_A), buddyRow("b", U_B), buddyRow("c", U_C)];

/** The complete, intended field set of one served buddy card. */
const EXPECTED_FIELDS = [
  "availabilityBlocks",
  "averageRating",
  "bio",
  "buddyLevel",
  "categories",
  "categoryApprovals",
  "city",
  "completedBookings",
  "country",
  "coverPhotoUrl",
  "createdAt",
  "displayName",
  "galleryUrls",
  "hourlyRateUsd",
  "id",
  "introVideoUrl",
  "languages",
  "maxGroupSize",
  "newBuddyDaytimeOnly",
  "newBuddyMaxHours",
  "newBuddyPublicOnly",
  "preferredMeetupZones",
  "responseTimeH",
  "reviewCount",
  "safetyBadges",
  "status",
  "tagline",
  "updatedAt",
  "userId",
  "verificationLevel",
  "verified",
  "verifiedAt",
  "vibeTags",
].sort();

/** Fields the retired local DTO emitted that no client of these endpoints reads. */
const RETIRED_FIELDS = [
  "femaleOnlyService", "cityAmbassador", "nightlifeApproved", "groupApproved",
  "publicMeetupOnly", "featured", "availableNow", "energyType",
  "halfDayRateUsd", "fullDayRateUsd", "nightlifeRateUsd", "arrivalRateUsd",
];

/**
 * The offers embed is an EXPLICIT eight-column list — already narrower than
 * BUDDY_PUBLIC_COLUMNS — so the card it produces is the canonical DTO over the
 * columns actually fetched. Unfetched raw passthroughs come back `undefined` and
 * JSON drops them; the mapper's own defaults (`?? []`, `?? null`) survive.
 */
const EXPECTED_OFFER_BUDDY_FIELDS = [
  "availabilityBlocks",
  "averageRating",
  "buddyLevel",
  "categories",
  "categoryApprovals",
  "completedBookings",
  "coverPhotoUrl",
  "displayName",
  "galleryUrls",
  "hourlyRateUsd",
  "id",
  "languages",
  "preferredMeetupZones",
  "responseTimeH",
  "reviewCount",
  "safetyBadges",
  "tagline",
  "userId",
  "verificationLevel",
  "verified",
  "vibeTags",
].sort();

/** One offer row, with the buddy embed the route asks PostgREST for. */
function offerRow(id: string, buddyUserId: string) {
  return {
    id,
    request_id: "req-1",
    buddy_profile_id: `bp-${id}`,
    buddy_user_id: buddyUserId,
    proposed_price_usd: "100",
    deposit_amount_usd: "20",
    cash_balance_usd: "80",
    proposed_start: null,
    proposed_end: null,
    meetup_location: null,
    message: null,
    included_services: [],
    addons_offered: [],
    payment_mode: "full_in_app",
    expires_at: "2026-09-01T00:00:00.000Z",
    status: "pending",
    accepted_booking_id: null,
    created_at: "2026-08-01T00:00:00.000Z",
    buddy: {
      id: `bp-${id}`,
      user_id: buddyUserId,
      display_name: `Buddy ${id}`,
      tagline: `Tagline ${id}`,
      average_rating: "4.5",
      verified: true,
      buddy_level: "seasoned",
      cover_photo_url: "https://example.test/cover.jpg",
      // Present in the fixture on purpose: the fake client ignores the select
      // list, so if the SERVING code ever stopped stripping AND started mapping
      // these, they would show up.
      ...PRIVATE_SENTINELS,
      meetup_base_lat: MEETUP_LAT,
      meetup_base_lng: MEETUP_LNG,
    },
  };
}

/** One saved-buddy row, with the profile embed. */
function savedRow(id: string, buddy: Record<string, unknown>) {
  return {
    id,
    user_id: VIEWER,
    buddy_id: buddy.id,
    notes: "later",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    buddy,
  };
}

// ── fake Supabase client ──────────────────────────────────────────────────────

interface TableSpec { rows?: any[]; error?: { message: string } }
type FakeState = Record<string, TableSpec | any[]>;

function specOf(state: FakeState, table: string): TableSpec {
  const v = state[table];
  if (Array.isArray(v)) return { rows: v };
  return (v as TableSpec) ?? { rows: [] };
}

function buildQuery(spec: TableSpec) {
  let rows = [...(spec.rows ?? [])];
  const err = spec.error ?? null;
  const result = () => (err ? { data: null, count: null, error: err } : { data: rows, count: rows.length, error: null });

  const q: any = {
    select() { return q; },
    insert() { return q; },
    upsert() { return q; },
    order() { return q; },
    not() { return q; },
    limit(n: number) { rows = rows.slice(0, n); return q; },
    eq(col: string, val: any) { rows = rows.filter((r) => r[col] === val); return q; },
    in(col: string, vals: any[]) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
    gte(col: string, val: any) { rows = rows.filter((r) => Number(r[col]) >= Number(val)); return q; },
    lte(col: string, val: any) { rows = rows.filter((r) => Number(r[col]) <= Number(val)); return q; },
    ilike(col: string, pattern: string) {
      const needle = String(pattern).replace(/%/g, "").toLowerCase();
      rows = rows.filter((r) => String(r[col] ?? "").toLowerCase().includes(needle));
      return q;
    },
    contains(col: string, vals: any[]) {
      rows = rows.filter((r) => Array.isArray(r[col]) && vals.every((v) => r[col].includes(v)));
      return q;
    },
    // fetchBlockedSet's only operator. Left unfiltered on purpose: the block
    // ROWS are the fixture, and the assertions are about what each route does
    // with the set the REAL resolver builds from them — which is how
    // bidirectionality gets tested rather than mocked.
    or() { return q; },
    single() { return Promise.resolve(err ? { data: null, error: err } : { data: rows[0] ?? null, error: null }); },
    maybeSingle() { return Promise.resolve(err ? { data: null, error: err } : { data: rows[0] ?? null, error: null }); },
    then(resolve: (v: any) => void, reject?: (e: any) => void) {
      return Promise.resolve(result()).then(resolve, reject);
    },
  };
  return q;
}

function makeClient(state: FakeState) {
  return {
    auth: {
      getUser: async (token: string) =>
        token === TOKEN
          ? { data: { user: { id: VIEWER } }, error: null }
          : { data: { user: null }, error: { message: "Unauthorized" } },
    },
    from: (table: string) => buildQuery(specOf(state, table)),
  };
}

function state(over: FakeState = {}): FakeState {
  return {
    feature_flags: [{ flag: "rent_buddy_enabled", enabled: true }],
    rent_buddy_profiles: ROWS,
    blocks: [],
    trust_profiles: [],
    rent_buddy_match_preferences: [],
    rent_buddy_requests: [{ id: "req-1", traveler_id: VIEWER, city: "Da Nang", category: "food", status: "open" }],
    rent_buddy_offers: [offerRow("a", U_A), offerRow("b", U_B), offerRow("c", U_C)],
    rent_buddy_saved: ROWS.map((r, i) => savedRow(`s${i}`, r)),
    ...over,
  };
}

/** The viewer blocked A; B blocked the viewer. Both directions in one fixture. */
const BOTH_DIRECTIONS = [
  { blocker_id: VIEWER, blocked_id: U_A },
  { blocker_id: U_B, blocked_id: VIEWER },
];

// ── test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function call(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; raw: string; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          ...(payload
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, raw, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/**
 * Every endpoint under test, reduced to one shape: run it against a fake state
 * and report the served buddy cards plus the raw body. `ids` are profile ids so
 * the block assertions read the same way everywhere.
 */
const ENDPOINTS = {
  availableNow: {
    label: "GET /rent-a-buddy/available-now",
    run: async (s: FakeState) => {
      const res = await call("GET", "/api/rent-a-buddy/available-now");
      return { res, cards: (res.body?.buddies ?? []) as any[] };
    },
  },
  topInCity: {
    label: "GET /rent-a-buddy/cities/:city/top",
    run: async (s: FakeState) => {
      const res = await call("GET", "/api/rent-a-buddy/cities/Da%20Nang/top");
      return { res, cards: (res.body?.buddies ?? []) as any[] };
    },
  },
  match: {
    label: "POST /rent-a-buddy/match",
    run: async (s: FakeState) => {
      const res = await call("POST", "/api/rent-a-buddy/match", { city: "Da Nang", limit: 20 });
      return { res, cards: (res.body?.results ?? []) as any[] };
    },
  },
  savedBuddies: {
    label: "GET /rent-a-buddy/me/saved-buddies",
    run: async (s: FakeState) => {
      const res = await call("GET", "/api/rent-a-buddy/me/saved-buddies");
      return { res, cards: ((res.body?.saved ?? []) as any[]).map((e) => e.buddy) };
    },
  },
} as const;

type EndpointKey = keyof typeof ENDPOINTS;
/** The four endpoints that serve a WHOLE profile row through the canonical DTO. */
const FULL_ROW_ENDPOINTS = Object.keys(ENDPOINTS) as EndpointKey[];

async function run(key: EndpointKey, s: FakeState) {
  _setTestClient(makeClient(s) as any, true);
  const { res, cards } = await ENDPOINTS[key].run(s);
  return { res, cards, ids: cards.filter(Boolean).map((c: any) => String(c.id)).sort() };
}

async function offers(s: FakeState) {
  _setTestClient(makeClient(s) as any, true);
  const res = await call("GET", "/api/rent-a-buddy/requests/req-1/offers");
  const list = (res.body?.offers ?? []) as any[];
  return { res, list, ids: list.map((o) => String(o.id)).sort() };
}

async function sections(s: FakeState) {
  _setTestClient(makeClient(s) as any, true);
  const res = await call("GET", "/api/rent-a-buddy/sections");
  const cards = ((res.body?.sections ?? []) as any[]).flatMap((sec) => sec.buddies ?? []);
  return { res, cards, ids: [...new Set(cards.map((c: any) => String(c.id)))].sort() };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.log = { error() {}, warn() {}, info() {} };
    next();
  });
  app.use("/api", marketplaceRouter);
  await new Promise<void>((resolve) => {
    // Bind loopback explicitly: a host-less listen(0) binds [::] and a foreign
    // IPv4 listener can then answer the request.
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

// ── Defect 1 — the DTO, per endpoint ─────────────────────────────────────────

describe("the four whole-row endpoints serve the canonical buddy card", () => {
  for (const key of FULL_ROW_ENDPOINTS) {
    const { label } = ENDPOINTS[key];

    it(`${label}: serves the fixture at all (the baseline)`, async () => {
      const { res, ids } = await run(key, state());
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.raw}`);
      assert.deepEqual(ids, ["a", "b", "c"]);
    });

    it(`${label}: emits EXACTLY the canonical field set — no more, no less`, async () => {
      const { cards } = await run(key, state());
      // /match spreads two extra keys onto the card; they are contract, not drift.
      const extra = key === "match" ? ["compatibilityScore", "scoreBreakdown"] : [];
      for (const card of cards) {
        assert.deepEqual(
          Object.keys(card).sort(),
          [...EXPECTED_FIELDS, ...extra].sort(),
          "the buddy DTO drifted; update the endpoint or this list deliberately, never by accident",
        );
      }
    });

    it(`${label}: is the canonical composition verbatim, minus the meetup base`, async () => {
      // If a third mapper is ever reintroduced, this stops matching.
      const canonical = mapBuddyPublicProfile(stripBuddyPrivateFields(buddyRow("a", U_A), false))!;
      const { meetupBaseLat, meetupBaseLng, ...expected } = canonical;
      const { cards } = await run(key, state());
      const card = cards.find((c: any) => c.id === "a");
      const { compatibilityScore, scoreBreakdown, ...served } = card as any;
      assert.deepEqual(served, JSON.parse(JSON.stringify(expected)));
    });

    it(`${label}: does NOT emit the meetup base — consolidation may narrow, never widen`, async () => {
      const { res, cards } = await run(key, state());
      for (const card of cards) {
        assert.ok(!("meetupBaseLat" in card), "meetupBaseLat is a real location; this endpoint never exposed it");
        assert.ok(!("meetupBaseLng" in card), "meetupBaseLng is a real location; this endpoint never exposed it");
      }
      assert.ok(!res.raw.includes(String(MEETUP_LAT)), "the meetup base latitude must not appear anywhere in the response");
      assert.ok(!res.raw.includes(String(MEETUP_LNG)), "the meetup base longitude must not appear anywhere in the response");
    });

    it(`${label}: puts no private field on the wire`, async () => {
      const { res, cards } = await run(key, state());
      for (const sentinel of Object.values(PRIVATE_SENTINELS)) {
        assert.ok(!res.raw.includes(sentinel), `${sentinel} must never cross the wire`);
      }
      for (const bad of ["legalName", "phoneNumber", "exactAddress", "homeAddress",
                         "idVerificationRef", "adminStatus", "riskHold"]) {
        assert.ok(!(bad in cards[0]), `${bad} must not be on a buddy card`);
      }
    });

    it(`${label}: drops the retired local-DTO fields no client reads`, async () => {
      const { cards } = await run(key, state());
      for (const bad of RETIRED_FIELDS) {
        assert.ok(!(bad in cards[0]), `${bad} was drift, not contract, and no client reads it`);
      }
    });

    it(`${label}: gains the canonical fields the local mapper omitted`, async () => {
      const { cards } = await run(key, state());
      const card = cards.find((c: any) => c.id === "a");
      // `bio` is rendered by the quiz-match ProfileCard; verificationLevel is the
      // profiles-joined trust signal; completed_count wins over completed_bookings.
      assert.equal(card.bio, "Bio a");
      assert.equal(card.verificationLevel, "id_verified");
      assert.equal(card.verifiedAt, "2026-01-02T00:00:00.000Z");
      assert.equal(card.updatedAt, "2026-08-01T00:00:00.000Z");
      assert.equal(card.introVideoUrl, "https://example.test/intro.mp4");
      assert.equal(card.completedBookings, 7);
    });
  }

  it("POST /match keeps its scoring keys alongside the canonical card", async () => {
    const { cards } = await run("match", state());
    for (const card of cards) {
      assert.equal(typeof card.compatibilityScore, "number");
      assert.equal(typeof card.scoreBreakdown, "object");
    }
  });

  it("GET /me/saved-buddies keeps the saved-entry envelope around the card", async () => {
    _setTestClient(makeClient(state()) as any, true);
    const res = await call("GET", "/api/rent-a-buddy/me/saved-buddies");
    assert.deepEqual(
      Object.keys(res.body.saved[0]).sort(),
      ["buddy", "buddyId", "notes", "savedAt", "updatedAt"],
    );
  });
});

describe("GET /rent-a-buddy/requests/:requestId/offers — the embedded buddy card", () => {
  it("serves the fixture at all (the baseline)", async () => {
    const { res, ids } = await offers(state());
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.raw}`);
    assert.deepEqual(ids, ["a", "b", "c"]);
  });

  it("emits EXACTLY the canonical card over the columns the embed fetches", async () => {
    const { list } = await offers(state());
    for (const offer of list) {
      assert.deepEqual(
        Object.keys(offer.buddy).sort(),
        EXPECTED_OFFER_BUDDY_FIELDS,
        "the offers buddy DTO drifted; widen the embed or this list deliberately",
      );
    }
  });

  it("does NOT emit the meetup base, and no private field", async () => {
    const { res, list } = await offers(state());
    for (const offer of list) {
      assert.ok(!("meetupBaseLat" in offer.buddy), "meetupBaseLat is a real location");
      assert.ok(!("meetupBaseLng" in offer.buddy), "meetupBaseLng is a real location");
    }
    assert.ok(!res.raw.includes(String(MEETUP_LAT)));
    assert.ok(!res.raw.includes(String(MEETUP_LNG)));
    for (const sentinel of Object.values(PRIVATE_SENTINELS)) {
      assert.ok(!res.raw.includes(sentinel), `${sentinel} must never cross the wire`);
    }
  });

  it("still serves the three fields the offers screen renders", async () => {
    const { list } = await offers(state());
    const a = list.find((o) => o.id === "a")!;
    assert.equal(a.buddy.displayName, "Buddy a");
    assert.equal(a.buddy.verified, true);
    assert.equal(a.buddy.averageRating, 4.5);
  });

  it("leaves the offer envelope alone", async () => {
    const { list } = await offers(state());
    assert.equal(list[0].proposedPriceUsd, 100);
    assert.equal(list[0].status, "pending");
  });
});

// ── Defect 2 — the block filter ──────────────────────────────────────────────

describe("blocked people are not served by any of these endpoints", () => {
  for (const key of FULL_ROW_ENDPOINTS) {
    const { label } = ENDPOINTS[key];

    it(`${label}: hides a buddy the VIEWER blocked (blocker_id = viewer)`, async () => {
      const { ids } = await run(key, state({ blocks: [{ blocker_id: VIEWER, blocked_id: U_A }] }));
      assert.deepEqual(ids, ["b", "c"], "a buddy the viewer blocked must not be offered to them");
    });

    it(`${label}: hides a buddy who blocked the VIEWER (blocked_id = viewer)`, async () => {
      const { ids } = await run(key, state({ blocks: [{ blocker_id: U_B, blocked_id: VIEWER }] }));
      assert.deepEqual(ids, ["a", "c"], "blocking is symmetric for visibility");
    });

    it(`${label}: hides both directions at once`, async () => {
      const { ids } = await run(key, state({ blocks: BOTH_DIRECTIONS }));
      assert.deepEqual(ids, ["c"]);
    });

    it(`${label}: FAILS CLOSED — an unreadable blocks table exposes nobody`, async () => {
      const { res, ids } = await run(key, state({ blocks: { error: { message: "blocks unavailable" } } }));
      assert.equal(res.status, 200, "fail-closed means an empty 200, not an error page");
      assert.deepEqual(ids, [], "unknown block state must expose NOBODY, never the unfiltered list");
    });

    it(`${label}: serves everyone when there are no blocks (narrowing only)`, async () => {
      const { ids } = await run(key, state({ blocks: [] }));
      assert.deepEqual(ids, ["a", "b", "c"]);
    });
  }

  it("GET /requests/:requestId/offers: hides offers from blocked buddies, both directions", async () => {
    const { ids } = await offers(state({ blocks: BOTH_DIRECTIONS }));
    assert.deepEqual(ids, ["c"], "a blocked buddy must not reach the traveller's offer list");
  });

  it("GET /requests/:requestId/offers: FAILS CLOSED", async () => {
    const { res, ids } = await offers(state({ blocks: { error: { message: "blocks unavailable" } } }));
    assert.equal(res.status, 200);
    assert.deepEqual(ids, []);
  });

  it("GET /sections: hides blocked buddies from every section, both directions", async () => {
    const { res, ids, cards } = await sections(state({ blocks: BOTH_DIRECTIONS }));
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.raw}`);
    assert.ok(cards.length > 0, "the unblocked buddy must still reach the sections");
    assert.deepEqual(ids, ["c"], "thirteen browsable lists, one block filter");
  });

  it("GET /sections: FAILS CLOSED — an unreadable blocks table exposes nobody", async () => {
    const { res, cards } = await sections(state({ blocks: { error: { message: "blocks unavailable" } } }));
    assert.equal(res.status, 200);
    assert.deepEqual(cards, [], "unknown block state must expose NOBODY");
  });

  it("GET /sections: serves everyone when there are no blocks", async () => {
    const { ids } = await sections(state());
    assert.deepEqual(ids, ["a", "b", "c"]);
  });
});

// ── The deliberate non-narrowing on POST /match ──────────────────────────────

describe("POST /rent-a-buddy/match keeps reading the columns its ranker gates on", () => {
  it("still excludes a risk-held buddy", async () => {
    // risk_hold and admin_status are NOT in BUDDY_PUBLIC_COLUMNS — they are on
    // stripBuddyPrivateFields' own list. CompatibilityScoreService excludes a
    // buddy when `riskHold || adminStatus !== 'active'`, so narrowing this
    // endpoint's select to the public allow-list would leave risk_hold
    // undefined, default it to false, and make a risk-held buddy matchable.
    // If someone "finishes the consolidation" on /match, this fails.
    const rows = [buddyRow("a", U_A, { risk_hold: true }), buddyRow("c", U_C)];
    const { ids } = await run("match", state({ rent_buddy_profiles: rows }));
    assert.deepEqual(ids, ["c"], "a risk-held buddy must never be matchable");
  });

  it("still honours a female-only preference, which is also a non-public column", async () => {
    const rows = [
      buddyRow("a", U_A, { female_only_service: false }),
      buddyRow("c", U_C, { female_only_service: true }),
    ];
    _setTestClient(makeClient(state({ rent_buddy_profiles: rows })) as any, true);
    const res = await call("POST", "/api/rent-a-buddy/match", {
      city: "Da Nang",
      preferences: { femaleOnly: true },
      limit: 20,
    });
    const ids = ((res.body?.results ?? []) as any[]).map((r) => String(r.id)).sort();
    assert.deepEqual(ids, ["c"], "female_only_service must still reach the ranker");
  });
});
