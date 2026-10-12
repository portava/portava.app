/**
 * OD-1012-STAMP-1..3 (owner, 2026-10-12, docs/ops/owner-decisions-20261012.md):
 *   "Planning or contribution stamps must not imply verified physical presence
 *    or earn verified-travel trust credit."
 *   "Enforce this consistently, including generic/admin award paths."
 *   "Use notification wording describing the actual achievement."
 *
 * Before this suite, the place strip lived only in three route call sites
 * (`placelessAward`, routes/trips.ts / hiddenGems.ts / posts.ts). Every other
 * path into StampAwardEngine — POST /admin/stamps/award, the internal
 * POST /stamps/award, the criteria engine, any future caller — could hand a
 * planning or contribution slug a city/country/lat/lng and the engine wrote it.
 *
 * What this suite pins (the engine is the one place every path meets):
 *   1. THE REGISTRY — `PRESENCE_STAMP_SLUGS` is exactly migration 2970's
 *      presence-TRUE block (13 slugs), and the test is fail-CLOSED: a slug that
 *      is not in it (unknown, mis-cased, padded, a future slug) is NOT presence.
 *   2. THE ENGINE STRIP — for every award-path shape (admin, internal/system,
 *      criteria, trips, posts, hidden_gems, a place-contributor worker call),
 *      a non-presence award writes NULL city/country/lat/lng even when the
 *      caller passed a place; a presence award keeps it (positive control).
 *   3. THE WORDING — `stampEarnedLocationText` never names the passed city for
 *      a non-presence stamp and uses the achievement copy for the four known
 *      planning/contribution slugs.
 *
 * The trust half (no STAMP_VERIFIED for these awards) is in
 * trustStampVerified.test.ts, whose fake carries the trust ledger; the HTTP
 * half (admin + internal routes) is in stampEarnedNotification.test.ts.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx --test src/test/stampPresenceAwardGate.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { awardStamp } from "../services/passport/StampAwardEngine.js";
import {
  PRESENCE_STAMP_SLUGS,
  isPresenceStamp,
  stampEarnedLocationText,
  TRIP_CREATION_STAMP_LOCATION_TEXT,
  GEM_APPROVAL_STAMP_LOCATION_TEXT,
  FIRST_POSTCARD_STAMP_LOCATION_TEXT,
} from "../services/passport/nonPresenceStampAwards.js";
import { makeEngineFake } from "./stampEngineFake.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_2970 = path.resolve(HERE, "..", "migrations", "2970_stamp_definitions_evidences_presence.sql");

const USER = "aaaaaaaa-0000-0000-0000-0000000000a1";
const ADMIN = "aaaaaaaa-0000-0000-0000-0000000000ad";
const SOURCE = "bbbbbbbb-0000-0000-0000-0000000000b1";
const PLACE = { city: "Paris", country: "France", lat: 48.8566, lng: 2.3522 } as const;
const PLACE_KEYS = ["city", "country", "lat", "lng"] as const;

/** 2970's presence-TRUE vocabulary, read from its delimited block (code lines only). */
function presenceTrueSlugs2970(): Set<string> {
  const sql = fs.readFileSync(MIGRATION_2970, "utf8");
  const block = /--\s*PRESENCE-TRUE-SLUGS-BEGIN([\s\S]*?)--\s*PRESENCE-TRUE-SLUGS-END/.exec(sql);
  assert.ok(block, "2970 must delimit its presence-TRUE slug list");
  const code = block[1].split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
  return new Set([...code.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]));
}

/**
 * Planning / contribution / social slugs that exist in the seeded catalog (or
 * are awarded by a writer in this tree) and are NOT presence. 2970's header
 * classifies each (sections c–f) and names the writer.
 */
const NON_PRESENCE = [
  "first_trip_created", "trip_planner",            // planning — POST /api/trips
  "hidden_gem_explorer",                           // contribution — gem approval
  "first_postcard",                                // contribution — postcard
  "place_contributor",                             // contribution — placeCollectionsWorker (unseeded)
  "place_contributor_bronze", "place_contributor_silver", "place_contributor_gold",
  "first_post", "storyteller", "photographer",     // social
  "verified_traveler",                             // admin identity grant
  "first_event_joined", "first_event_hosted", "event_participant",
  "safe_return_ready", "safe_return_completed",
  "first_buddy_booking", "top_rated_buddy",
];

function def(slug: string, name = slug) {
  return {
    id: `def-${slug}`, slug, name, stamp_type: "trip", is_active: true, is_repeatable: false,
    max_awards_per_user: null, visibility_default: "public", criteria_type: "automatic", criteria: null,
  };
}

async function awardRow(slug: string, over: Record<string, unknown>) {
  const fake = makeEngineFake({
    definition: def(slug),
    sources: { trips: { status: "completed" }, posts: { status: "active" }, events: { state: "completed" } },
  });
  const r = await awardStamp(fake.client, { userId: USER, definitionSlug: slug, ...PLACE, ...over } as any);
  const rows = fake.inserted.filter((x) => x.table === "user_stamps").map((x) => x.row);
  return { r, rows };
}

// The award-path shapes that reach the engine. Each is how that caller builds
// its input (routes/adminStamps.ts, routes/stamps.ts, lib/stamps/criteria,
// routes/trips.ts, routes/posts.ts, routes/hiddenGems.ts, placeCollectionsWorker).
const PATHS: Array<{ name: string; over: Record<string, unknown> }> = [
  { name: "admin POST /admin/stamps/award", over: { sourceType: "admin", adminId: ADMIN, awardReason: "manual grant" } },
  { name: "internal POST /stamps/award",    over: { sourceType: "system" } },
  { name: "criteria engine",                over: { sourceType: "criteria", sourceId: "none" } },
  { name: "trips writer",                   over: { sourceType: "trips", sourceId: SOURCE } },
  { name: "posts writer",                   over: { sourceType: "posts", sourceId: SOURCE } },
  { name: "hidden_gems writer",             over: { sourceType: "hidden_gems", sourceId: SOURCE } },
  { name: "no source (worker default)",     over: {} },
];

describe("the presence registry is 2970's presence-TRUE list, and fails closed", () => {
  it("PRESENCE_STAMP_SLUGS equals migration 2970's PRESENCE-TRUE block exactly (13 slugs)", () => {
    const sql = presenceTrueSlugs2970();
    assert.equal(sql.size, 13, "2970's presence list parsed short — the comparison would be vacuous");
    assert.deepEqual([...PRESENCE_STAMP_SLUGS].sort(), [...sql].sort());
  });

  it("every planning / contribution / social slug is NOT presence", () => {
    for (const s of NON_PRESENCE) assert.equal(isPresenceStamp(s), false, s);
  });

  it("an unknown, mis-cased, padded or empty slug is NOT presence (fail closed)", () => {
    for (const s of ["danang_city", "city_visited", "FIRST_TRIP_COMPLETED", " city_explorer", "city_explorer ", "", "first-trip"]) {
      assert.equal(isPresenceStamp(s), false, JSON.stringify(s));
    }
    assert.equal(isPresenceStamp(undefined as any), false);
    assert.equal(isPresenceStamp(null as any), false);
  });

  it("each of 2970's presence slugs IS presence (positive control)", () => {
    for (const s of presenceTrueSlugs2970()) assert.equal(isPresenceStamp(s), true, s);
  });
});

describe("StampAwardEngine strips the place from every non-presence award, on every path", () => {
  for (const p of PATHS) {
    it(`${p.name}: planning/contribution slugs are written with NULL city/country/lat/lng`, async () => {
      for (const slug of ["trip_planner", "first_trip_created", "hidden_gem_explorer", "first_postcard", "place_contributor", "verified_traveler"]) {
        const { r, rows } = await awardRow(slug, p.over);
        assert.equal(r.awarded, true, `${slug}: ${r.reason}`);
        assert.equal(rows.length, 1);
        for (const k of PLACE_KEYS) assert.equal(rows[0][k], null, `${p.name} / ${slug}: '${k}' was stored`);
        assert.equal(r.evidencesPresence, false, `${slug}: the result must say it is not presence`);
      }
    });

    it(`${p.name}: an UNKNOWN slug is treated as non-presence (fail closed)`, async () => {
      const { r, rows } = await awardRow("danang_city", p.over);
      assert.equal(r.awarded, true, r.reason);
      for (const k of PLACE_KEYS) assert.equal(rows[0][k], null, `unknown slug kept '${k}'`);
    });

    it(`${p.name}: POSITIVE CONTROL — a presence slug keeps its place`, async () => {
      const { r, rows } = await awardRow("city_explorer", p.over);
      assert.equal(r.awarded, true, r.reason);
      assert.equal(rows[0].city, PLACE.city);
      assert.equal(rows[0].country, PLACE.country);
      assert.equal(rows[0].lat, PLACE.lat);
      assert.equal(rows[0].lng, PLACE.lng);
      assert.equal(r.evidencesPresence, true);
    });
  }

  it("the strip keys on the slug, not the source: trip_completed-shaped input for trip_planner is still stripped", async () => {
    const { rows } = await awardRow("trip_planner", { sourceType: "trips", sourceId: SOURCE, city: "Lisbon", country: "Portugal" });
    assert.equal(rows[0].city, null);
    assert.equal(rows[0].country, null);
  });

  it("a city-only input for a non-presence slug does not get a DERIVED country either", async () => {
    // resolveCountry derives a country from a well-known city; deriving it from
    // a stripped city would re-introduce the place by the back door.
    const { rows } = await awardRow("first_trip_created", { sourceType: "trips", sourceId: SOURCE, city: "Tokyo", country: undefined, lat: undefined, lng: undefined });
    assert.equal(rows[0].city, null);
    assert.equal(rows[0].country, null);
  });
});

describe("stamp-earned notification wording describes the achievement", () => {
  it("the four known planning/contribution slugs use their achievement copy, never the passed place", () => {
    const cases: Array<[string, string]> = [
      ["first_trip_created", TRIP_CREATION_STAMP_LOCATION_TEXT],
      ["trip_planner", TRIP_CREATION_STAMP_LOCATION_TEXT],
      ["hidden_gem_explorer", GEM_APPROVAL_STAMP_LOCATION_TEXT],
      ["first_postcard", FIRST_POSTCARD_STAMP_LOCATION_TEXT],
    ];
    for (const [slug, text] of cases) {
      assert.equal(stampEarnedLocationText(slug, { city: "Paris", country: "France" }, "Some Name"), text, slug);
    }
  });

  it("any other non-presence slug uses its definition name, never the passed city/country", () => {
    const t = stampEarnedLocationText("verified_traveler", { city: "Paris", country: "France" }, "Verified Traveler");
    assert.equal(t, "Verified Traveler");
    const u = stampEarnedLocationText("danang_city", { city: "Da Nang", country: "Vietnam" }, undefined);
    assert.ok(!/Da Nang|Vietnam/.test(u), `unknown non-presence slug named the place: ${u}`);
    assert.ok(u.length > 0);
  });

  it("POSITIVE CONTROL — a presence slug names its city, then country, then its name", () => {
    assert.equal(stampEarnedLocationText("city_explorer", { city: "Kyoto", country: "Japan" }, "City Explorer"), "Kyoto");
    assert.equal(stampEarnedLocationText("world_citizen", { country: "Japan" }, "World Citizen"), "Japan");
    assert.equal(stampEarnedLocationText("first_trip_completed", {}, "First Trip"), "First Trip");
  });
});
