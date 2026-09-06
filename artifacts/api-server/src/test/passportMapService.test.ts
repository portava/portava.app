/**
 * PassportMapService — §26 "My World" map payload + the passport stat counters.
 *
 * `PassportMapService` had NO test of its own on main: nothing demonstrated the
 * ownership filter, the visibility filter, the no-coordinates invariant, or the
 * four category counters. Two of those turned out to be broken:
 *
 *   • `buildStats` counted `stamp_definitions.category === "plan" | "host" |
 *     "hidden_gem" | "safe_return"`. The seeded category vocabulary
 *     (migrations 0081/0082/0145/0189, identical in production) is
 *     community | event | location | rent_buddy | safety | special | trip |
 *     trust — so all four counters were structurally zero for everyone, and
 *     `hiddenGemStamps` is the only input to the Travel DNA "hidden gem hunter"
 *     trait (PassportTravelIdentityService:362 needs >= 2).
 *   • the counters now key off SLUG, and `STATS_SLUG_BUCKETS` names the slugs.
 *
 * OWNERSHIP AND VISIBILITY TESTS CARRY POSITIVE CONTROLS. A row that is absent
 * proves nothing on its own — it could be excluded by any of the four filters
 * in this path, or by a fixture missing a column a fail-closed gate inspects.
 * Each exclusion below is paired with a control that makes the SAME row appear
 * when only the field under test changes.
 *
 * Every stamp fixture sets `visibility` explicitly. A `UnifiedStamp`-shaped
 * fixture missing it reads as undefined → `isVisible` returns false → every
 * stamp vanishes and every assertion passes vacuously. That trap has already
 * hidden one real leak in this lane.
 *
 * MUTATION PROOFS (each performed, each RED):
 *   • drop `.eq("user_id", userId)` from buildMapPayload → ownership test RED;
 *   • drop the `filterStamps` call → visibility test RED;
 *   • revert `STATS_SLUG_BUCKETS` back to the category literals → all four
 *     counter tests RED.
 *
 * Run: node --import tsx/esm --test src/test/passportMapService.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildMapPayload,
  buildStats,
  STATS_SLUG_BUCKETS,
} from "../services/passport/PassportMapService.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";

const OWNER = "map-owner-1";
const STRANGER = "map-stranger-1";

/**
 * A complete passport_stamps row. Every column the guard reads is set —
 * visibility above all, because a missing one reads as "deny" and makes the
 * whole suite vacuous.
 */
function stamp(over: Partial<Record<string, any>> = {}): Record<string, any> {
  return {
    id: `s-${Math.random().toString(16).slice(2)}`,
    user_id: OWNER,
    stamp_type: "city",
    country: "Vietnam",
    city: "Da Nang",
    neighborhood: null,
    place_id: null,
    plan_id: null,
    trip_id: null,
    source_type: "gps_pipeline",
    verification_level: "gps",
    visibility: "public",
    earned_at: "2026-03-01T00:00:00Z",
    awarded_at: "2026-03-01T00:00:00Z",
    created_at: "2026-03-01T00:00:00Z",
    ...over,
  };
}

describe("buildMapPayload — §26 My World", () => {
  it("aggregates a traveller's public stamps into coarse city markers", async () => {
    const db = makePassportDb({
      passport_stamps: [
        stamp({ city: "Da Nang", country: "Vietnam" }),
        stamp({ city: "Da Nang", country: "Vietnam", verification_level: "checkin" }),
        stamp({ city: "Bangkok", country: "Thailand" }),
      ],
    });
    const payload = await buildMapPayload(db as any, OWNER, "public");
    assert.equal(payload.markers.length, 2);
    assert.deepEqual(payload.cities, ["Bangkok", "Da Nang"]);
    assert.deepEqual(payload.countries, ["Thailand", "Vietnam"]);
    const danang = payload.markers.find((m) => m.city === "Da Nang")!;
    assert.equal(danang.stampCount, 2);
    assert.equal(danang.verificationLevel, "checkin", "the marker takes the HIGHEST verification of its stamps");
    assert.equal(danang.displayLabel, "Da Nang, Vietnam");
  });

  it("NEVER emits a coordinate, however the row is shaped", async () => {
    // The service's stated invariant. Feed it coordinate-shaped columns and
    // assert none of them survive into the payload at any depth.
    const db = makePassportDb({
      passport_stamps: [stamp({ lat: 16.0544, lng: 108.2022, latitude: 16.0544, longitude: 108.2022 })],
    });
    const payload = await buildMapPayload(db as any, OWNER, "owner");
    const serialized = JSON.stringify(payload);
    for (const leak of ["16.05", "108.20", "lat", "lng", "latitude", "longitude"]) {
      assert.ok(!serialized.includes(leak), `My World payload leaked ${leak}: ${serialized}`);
    }
  });

  // ── Ownership ─────────────────────────────────────────────────────────────

  it("never returns another traveller's stamps — and the control proves the user filter is why", async () => {
    const db = makePassportDb({
      passport_stamps: [
        stamp({ user_id: OWNER, city: "Da Nang", country: "Vietnam" }),
        // A stranger's stamp, in a DIFFERENT city so its absence is visible,
        // and public + fully populated so nothing else can exclude it.
        stamp({ user_id: STRANGER, city: "Lisbon", country: "Portugal" }),
      ],
    });
    const mine = await buildMapPayload(db as any, OWNER, "owner");
    assert.deepEqual(mine.cities, ["Da Nang"], "a stranger's city reached the owner's My World");

    // POSITIVE CONTROL: the identical row IS returned for its own owner, so the
    // exclusion above is the ownership filter and not some unrelated path.
    const theirs = await buildMapPayload(db as any, STRANGER, "owner");
    assert.deepEqual(
      theirs.cities,
      ["Lisbon"],
      "control failed: the stranger's stamp is invisible to everyone, so the " +
        "first assertion proved nothing about ownership",
    );
  });

  // ── Visibility ────────────────────────────────────────────────────────────

  it("hides a private stamp from a public caller — and the control proves the visibility gate is why", async () => {
    const rows = [
      stamp({ city: "Da Nang", country: "Vietnam", visibility: "public" }),
      stamp({ city: "Hoi An", country: "Vietnam", visibility: "private" }),
    ];
    const publicView = await buildMapPayload(makePassportDb({ passport_stamps: rows }) as any, OWNER, "public");
    assert.deepEqual(publicView.cities, ["Da Nang"], "a private stamp reached a public caller");

    // POSITIVE CONTROL: the SAME row, same fixture, owner context.
    const ownerView = await buildMapPayload(makePassportDb({ passport_stamps: rows }) as any, OWNER, "owner");
    assert.deepEqual(
      ownerView.cities,
      ["Da Nang", "Hoi An"],
      "control failed: 'Hoi An' is missing for the owner too, so the first " +
        "assertion proved nothing about the visibility gate",
    );
  });

  it("shows a circle_only stamp to the circle but not to the public", async () => {
    const rows = [stamp({ city: "Hue", country: "Vietnam", visibility: "circle_only" })];
    const pub = await buildMapPayload(makePassportDb({ passport_stamps: rows }) as any, OWNER, "public");
    assert.deepEqual(pub.cities, []);
    const circle = await buildMapPayload(makePassportDb({ passport_stamps: rows }) as any, OWNER, "circle");
    assert.deepEqual(circle.cities, ["Hue"], "control: the circle DOES see it");
  });

  it("returns an empty payload rather than throwing when the read fails", async () => {
    const broken: any = { from: () => ({ select: () => ({ eq: () => ({ not: () => ({ order: () => ({ limit: async () => ({ data: null, error: { message: "boom" } }) }) }) }) }) }) };
    assert.deepEqual(await buildMapPayload(broken, OWNER, "owner"), { markers: [], countries: [], cities: [] });
  });
});

// ── buildStats ───────────────────────────────────────────────────────────────

function userStamp(slug: string, over: Record<string, any> = {}) {
  return {
    user_id: OWNER,
    country: "Vietnam",
    city: "Da Nang",
    visibility: "public",
    is_revoked: false,
    stamp_definitions: { category: "location", slug },
    ...over,
  };
}

describe("buildStats — the four category counters", () => {
  it("counts hidden-gem stamps (the Travel DNA 'hidden gem hunter' input)", async () => {
    const db = makePassportDb({
      user_stamps: [
        userStamp("hidden_gem_hunter"),
        userStamp("hidden_gem_explorer", { stamp_definitions: { category: "special", slug: "hidden_gem_explorer" } }),
        // A different `location` stamp that must NOT be counted as a gem — the
        // reason a category-level remap would have been wrong.
        userStamp("city_explorer"),
      ],
    });
    const stats = await buildStats(db as any, OWNER);
    assert.equal(stats.hiddenGemStamps, 2, "zero here means the counter is dead again");
    assert.ok(stats.hiddenGemStamps >= 2, "PassportTravelIdentityService:362 needs >= 2 to infer the trait");
    assert.equal(stats.totalStamps, 3);
  });

  it("counts completed Safe Returns without counting the opt-in 'ready' stamp", async () => {
    const db = makePassportDb({
      user_stamps: [
        userStamp("safe_return_completed", { stamp_definitions: { category: "safety", slug: "safe_return_completed" } }),
        userStamp("safe_return_ready", { stamp_definitions: { category: "safety", slug: "safe_return_ready" } }),
        userStamp("safe_traveler", { stamp_definitions: { category: "safety", slug: "safe_traveler" } }),
      ],
    });
    const stats = await buildStats(db as any, OWNER);
    assert.equal(stats.safeReturnStamps, 1, "only a COMPLETED return counts");
  });

  it("separates attending a plan from hosting one", async () => {
    const db = makePassportDb({
      user_stamps: [
        userStamp("event_participant", { stamp_definitions: { category: "event", slug: "event_participant" } }),
        userStamp("first_event_joined", { stamp_definitions: { category: "event", slug: "first_event_joined" } }),
        userStamp("event_host", { stamp_definitions: { category: "event", slug: "event_host" } }),
        userStamp("good_host", { stamp_definitions: { category: "community", slug: "good_host" } }),
      ],
    });
    const stats = await buildStats(db as any, OWNER);
    assert.equal(stats.planStamps, 2);
    assert.equal(stats.hostStamps, 2, "a category-level count would have folded these together");
  });

  it("reads the embedded definition whether PostgREST returns an object or a one-element array", async () => {
    const db = makePassportDb({
      user_stamps: [userStamp("hidden_gem_hunter", { stamp_definitions: [{ category: "location", slug: "hidden_gem_hunter" }] })],
    });
    assert.equal((await buildStats(db as any, OWNER)).hiddenGemStamps, 1);
  });

  it("counts distinct countries and cities", async () => {
    const db = makePassportDb({
      user_stamps: [
        userStamp("city_explorer", { city: "Da Nang", country: "Vietnam" }),
        userStamp("city_explorer", { city: "Da Nang", country: "Vietnam" }),
        userStamp("city_explorer", { city: "Bangkok", country: "Thailand" }),
      ],
    });
    const stats = await buildStats(db as any, OWNER);
    assert.equal(stats.countries, 2);
    assert.equal(stats.cities, 2);
    assert.equal(stats.totalStamps, 3);
  });
});

describe("STATS_SLUG_BUCKETS — every slug it names is one a migration actually seeds", () => {
  /** Slugs inserted into stamp_definitions by any migration. */
  function seededSlugs(): Set<string> {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
    const slugs = new Set<string>();
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql"))) {
      const sql = fs.readFileSync(path.join(dir, f), "utf8");
      if (!/stamp_definitions/i.test(sql)) continue;
      // The seed rows all start with the slug as the first literal of the tuple.
      for (const m of sql.matchAll(/\(\s*'([a-z0-9_]+)'\s*,\s*'/g)) slugs.add(m[1]);
    }
    return slugs;
  }

  it("names no slug the seed data does not contain", () => {
    const seeded = seededSlugs();
    assert.ok(seeded.size > 20, `slug extraction failed — only found ${seeded.size}`);
    const unknown: string[] = [];
    for (const [bucket, set] of Object.entries(STATS_SLUG_BUCKETS)) {
      for (const slug of set) if (!seeded.has(slug)) unknown.push(`${bucket}:${slug}`);
    }
    assert.deepEqual(
      unknown,
      [],
      `these stat slugs are not seeded by any migration, so their counter is dead: ${unknown.join(", ")}`,
    );
  });

  it("does not name a CATEGORY by mistake — the original defect", () => {
    const categories = new Set(["community", "event", "location", "rent_buddy", "safety", "special", "trip", "trust"]);
    for (const [bucket, set] of Object.entries(STATS_SLUG_BUCKETS)) {
      for (const slug of set) {
        assert.ok(!categories.has(slug), `${bucket} counts '${slug}', which is a category, not a slug`);
      }
    }
  });
});
