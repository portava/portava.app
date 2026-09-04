/**
 * GET /api/rent-a-buddy/sections — the buddy DTO on the wire.
 *
 * WHY THIS SUITE EXISTS
 * =====================
 * The sections endpoint used to `select("*")` from rent_buddy_profiles and map
 * rows through a SECOND, local buddy DTO that never called
 * stripBuddyPrivateFields. No private field actually reached the wire — the
 * local mapper happened not to emit one — but the protection was an OMISSION,
 * not a strip: a field added to that mapper later would have leaked silently,
 * and the two DTOs had already drifted apart in both directions.
 *
 * The endpoint now composes the canonical definitions from lib/buddyMapRead:
 * BUDDY_PUBLIC_COLUMNS on the select → stripBuddyPrivateFields →
 * mapBuddyPublicProfile, minus the meetup base (see below).
 *
 * WHAT IS PINNED, AND HOW HONESTLY
 * ================================
 * 1. THE EXACT FIELD SET. Not "these fields are present" — the complete key set
 *    of a served buddy card, so ANY future drift in either direction (a field
 *    added to the canonical mapper, a field quietly dropped) fails loudly here.
 *
 * 2. NO PRIVATE FIELD. Every private column carries a recognisable sentinel in
 *    the fixture and the whole serialized response is searched for it. Stated
 *    honestly: the fixture returns whole rows as if BUDDY_PUBLIC_COLUMNS had
 *    not filtered the select, so this tests the SERVING code — but the mapper's
 *    allow-list alone is sufficient to pass it. That is why (1) and (3) exist:
 *    together they pin that the strip is genuinely in the composition.
 *
 * 3. NO MEETUP BASE. mapBuddyPublicProfile emits meetupBaseLat/meetupBaseLng and
 *    this endpoint never has. Those are a person's real location; adding them
 *    while consolidating would be a NEW disclosure on a browsable list of
 *    people, so the sections DTO is canonical MINUS the meetup base. This test
 *    is what stops a later "just use the canonical mapper directly" from
 *    silently widening the endpoint.
 *
 * Run:
 *   node --import tsx/esm --test src/test/rentABuddyMarketplaceDto.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import marketplaceRouter from "../routes/rentABuddyMarketplace.js";
import { mapBuddyPublicProfile, stripBuddyPrivateFields } from "../lib/buddyMapRead.js";

const TOKEN = "sections-dto-test-token";
const USER = "sections-viewer-id";

/** Values that must never cross the wire. */
const PRIVATE_SENTINELS = {
  legal_name: "LEGAL-NAME-SENTINEL",
  phone_number: "PHONE-SENTINEL",
  exact_address: "EXACT-ADDRESS-SENTINEL",
  home_address: "HOME-ADDRESS-SENTINEL",
  id_verification_ref: "IDREF-SENTINEL",
};

/**
 * Every column the canonical DTO reads is set, so no mapped key can vanish from
 * the wire merely because JSON.stringify drops an `undefined`. The columns the
 * OLD local mapper read but the canonical one does not are set too — that is
 * how the drift assertions below can tell "dropped" from "absent from the row".
 */
const BUDDY_ROW: Record<string, unknown> = {
  id: "bp-1",
  user_id: "buddy-user-1",
  display_name: "Ada",
  tagline: "Street food guide",
  bio: "Ten years of eating.",
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
  average_rating: "4.8",
  review_count: 12,
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
  meetup_base_lat: 16.06,
  meetup_base_lng: 108.21,
  featured: true,
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
  city_ambassador: true,
  female_only_service: true,
  public_meetup_only: true,
  group_approved: true,
  nightlife_approved: true,
  arrival_approved: true,
  energy_type: "calm",
  ...PRIVATE_SENTINELS,
};

/** The complete, intended field set of one served buddy card. */
const EXPECTED_FIELDS = [
  "averageRating",
  "availabilityBlocks",
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

// ── fake Supabase client ──────────────────────────────────────────────────────

function buildQuery(rows: any[]) {
  let out = [...rows];
  const q: any = {
    select() { return q; },
    insert() { return q; },
    order() { return q; },
    limit(n: number) { out = out.slice(0, n); return q; },
    eq(col: string, val: any) { out = out.filter((r) => r[col] === val); return q; },
    gte(col: string, val: any) { out = out.filter((r) => Number(r[col]) >= Number(val)); return q; },
    lte(col: string, val: any) { out = out.filter((r) => Number(r[col]) <= Number(val)); return q; },
    ilike(col: string, pattern: string) {
      const needle = String(pattern).replace(/%/g, "").toLowerCase();
      out = out.filter((r) => String(r[col] ?? "").toLowerCase().includes(needle));
      return q;
    },
    contains(col: string, vals: any[]) {
      out = out.filter((r) => Array.isArray(r[col]) && vals.every((v) => r[col].includes(v)));
      return q;
    },
    // `or()` exists because /sections now resolves fetchBlockedSet, which uses
    // it. Without it the fake throws, the resolver catches and returns null,
    // and the endpoint correctly fails CLOSED to an empty list — so every
    // positive assertion here would fail for a reason that has nothing to do
    // with what this suite is testing.
    or() { return q; },
    maybeSingle() { return Promise.resolve({ data: out[0] ?? null, error: null }); },
    then(resolve: (v: any) => void, reject?: (e: any) => void) {
      return Promise.resolve({ data: out, count: out.length, error: null }).then(resolve, reject);
    },
  };
  return q;
}

function makeClient(profileRows: any[]) {
  return {
    auth: {
      getUser: async (token: string) =>
        token === TOKEN
          ? { data: { user: { id: USER } }, error: null }
          : { data: { user: null }, error: { message: "Unauthorized" } },
    },
    from: (table: string) =>
      buildQuery(table === "rent_buddy_profiles" ? profileRows : []),
  };
}

// ── test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function get(path: string): Promise<{ status: number; raw: string; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method: "GET",
        headers: { authorization: `Bearer ${TOKEN}` },
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
    r.end();
  });
}

async function sections(rows: any[] = [BUDDY_ROW]) {
  _setTestClient(makeClient(rows) as any, true);
  const res = await get("/api/rent-a-buddy/sections");
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.raw}`);
  const all: any[] = (res.body.sections ?? []).flatMap((s: any) => s.buddies ?? []);
  return { res, all };
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
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/rent-a-buddy/sections — buddy DTO", () => {
  it("serves buddy cards at all (the fixture reaches the sections)", async () => {
    const { res, all } = await sections();
    assert.equal((res.body.sections ?? []).length, 13, "all 13 discovery sections are returned");
    assert.ok(all.length > 0, "at least one section must contain the fixture buddy");
  });

  it("emits EXACTLY the canonical field set — no more, no less", async () => {
    const { all } = await sections();
    for (const card of all) {
      assert.deepEqual(
        Object.keys(card).sort(),
        EXPECTED_FIELDS,
        "the sections buddy DTO drifted; update the endpoint or this list deliberately, " +
          "never by accident",
      );
    }
  });

  it("is the canonical composition verbatim, minus the meetup base", async () => {
    // If a third mapper is ever reintroduced, this stops matching.
    const canonical = mapBuddyPublicProfile(stripBuddyPrivateFields(BUDDY_ROW, false))!;
    const { meetupBaseLat, meetupBaseLng, ...expected } = canonical;
    const { all } = await sections();
    assert.deepEqual(all[0], JSON.parse(JSON.stringify(expected)));
  });

  it("puts no private field on the wire", async () => {
    const { res } = await sections();
    for (const sentinel of Object.values(PRIVATE_SENTINELS)) {
      assert.ok(
        !res.raw.includes(sentinel),
        `${sentinel} must never cross the wire`,
      );
    }
    const { all } = await sections();
    for (const key of ["legalName", "phoneNumber", "exactAddress", "homeAddress",
                       "idVerificationRef", "adminStatus", "riskHold"]) {
      assert.ok(!(key in all[0]), `${key} must not be on a buddy card`);
    }
  });

  it("does NOT emit the meetup base — consolidation may narrow, never widen", async () => {
    const { all } = await sections();
    assert.ok(!("meetupBaseLat" in all[0]), "meetupBaseLat is a real location; this endpoint never exposed it");
    assert.ok(!("meetupBaseLng" in all[0]), "meetupBaseLng is a real location; this endpoint never exposed it");
    const { res } = await sections();
    assert.ok(!res.raw.includes("16.06"), "the meetup base latitude must not appear anywhere in the response");
    assert.ok(!res.raw.includes("108.21"), "the meetup base longitude must not appear anywhere in the response");
  });

  it("drops the fields the retired local DTO emitted that no client reads", async () => {
    const { all } = await sections();
    for (const key of [
      "femaleOnlyService", "cityAmbassador", "nightlifeApproved", "groupApproved",
      "publicMeetupOnly", "featured", "availableNow", "energyType",
      "halfDayRateUsd", "fullDayRateUsd", "nightlifeRateUsd", "arrivalRateUsd",
    ]) {
      assert.ok(!(key in all[0]), `${key} was drift, not contract, and no client reads it`);
    }
  });

  it("gains the fields the canonical DTO has that the local one omitted", async () => {
    const { all } = await sections();
    const card = all[0];
    // `bio` in particular is rendered by the client's share adapter, and
    // `verificationLevel` is the profiles-joined trust signal.
    assert.equal(card.bio, "Ten years of eating.");
    assert.equal(card.verificationLevel, "id_verified");
    assert.equal(card.verifiedAt, "2026-01-02T00:00:00.000Z");
    assert.equal(card.updatedAt, "2026-08-01T00:00:00.000Z");
    assert.equal(card.introVideoUrl, "https://example.test/intro.mp4");
  });

  it("keeps completed_count as the source of truth for completedBookings", async () => {
    // The fixture disagrees on purpose (completed_count 7, completed_bookings 3).
    const { all } = await sections();
    assert.equal(all[0].completedBookings, 7);
  });

  it("serves nothing rather than a partial card when the row is null", async () => {
    const { all } = await sections([]);
    assert.deepEqual(all, []);
  });
});
