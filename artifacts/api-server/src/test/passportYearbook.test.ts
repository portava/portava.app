/**
 * Passport Yearbook — §9 / Phase 9 "Intelligence".
 *
 * The yearbook aggregates a traveller's OWN already-built material into
 * explainable per-year lines. The invariants that matter are not "does it
 * produce nice copy" but:
 *
 *   1. every line carries the evidence its claim was derived from;
 *   2. a blocked or hidden item never appears — not in a list, not in evidence;
 *   3. a viewer sees no more than the passport projection already shows them;
 *   4. an empty year renders an honest empty state instead of a fabricated one;
 *   5. §37 truth boundary — an inferred Travel DNA reading is always labelled
 *      `inferred` and never presented as an observation.
 *
 * Run: node --import tsx/esm --test src/test/passportYearbook.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildYearbook,
  isHiddenGemStamp,
  type YearbookLine,
  type YearbookPermissions,
  type YearbookProjection,
} from "../services/passport/PassportYearbookService.js";
import {
  buildPassportProjection,
  type ViewerPermissions,
  type ViewerResolution,
} from "../services/passport/PassportProjectionService.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";

const OWNER = "owner-1";
const VIEWER = "viewer-1";
const FRIEND = "friend-1";
const BLOCKED = "blocked-1";

const T_VN = "trip-vn";
const T_TH = "trip-th";
const T_PRIV = "trip-priv";

// ── Fixture ──────────────────────────────────────────────────────────────────
//
// Two years of real history plus the things that must NOT surface:
//   • T_PRIV  — a private trip (Sa Pa)
//   • m-priv  — a private memory ("Secret spot")
//   • m-priv2 — a private memory on the private trip ("Hidden beach", Sa Pa)
//   • BLOCKED — a trip companion the owner blocked ("Mallory")

function seed(overrides: Record<string, any[]> = {}) {
  return makePassportDb({
    profiles: [
      { id: OWNER, handle: "wanderer", display_name: "Wanderer", created_at: "2023-01-01" },
      { id: FRIEND, handle: "ana", display_name: "Ana", avatar_url: "https://x/ana.png", show_profile_picture_publicly: true },
      { id: BLOCKED, handle: "mallory", display_name: "Mallory", avatar_url: "https://x/m.png", show_profile_picture_publicly: true },
    ],
    // Name visibility is not what these cases are about — every seeded person
    // has opted in to `show_real_name`, so "Ana is still credited" stays a real
    // assertion about block-filtering rather than about the display-name rule
    // (which passportProjectionNameVisibility.test.ts owns).
    profile_privacy_settings: [
      { user_id: OWNER, show_real_name: true },
      { user_id: FRIEND, show_real_name: true },
      { user_id: BLOCKED, show_real_name: true },
    ],
    blocks: [{ blocker_id: OWNER, blocked_id: BLOCKED }],
    trip_members: [
      { trip_id: T_VN, user_id: OWNER, role: "owner", status: "accepted" },
      { trip_id: T_VN, user_id: FRIEND, role: "member", status: "accepted" },
      { trip_id: T_VN, user_id: BLOCKED, role: "member", status: "accepted" },
      { trip_id: T_TH, user_id: OWNER, role: "member", status: "accepted" },
      { trip_id: T_PRIV, user_id: OWNER, role: "owner", status: "accepted" },
    ],
    trips: [
      { id: T_VN, owner_id: OWNER, title: "30 Days in Vietnam", destination_city: "Da Nang", destination_country: "Vietnam", start_date: "2025-03-01", end_date: "2025-03-30", status: "completed", visibility: "public", show_on_profile: true, show_exact_dates: true },
      { id: T_TH, owner_id: "someone", title: "Bangkok Weekend", destination_city: "Bangkok", destination_country: "Thailand", start_date: "2024-11-10", end_date: "2024-11-12", status: "completed", visibility: "public", show_on_profile: true, show_exact_dates: false },
      { id: T_PRIV, owner_id: OWNER, title: "Secret Trip", destination_city: "Sa Pa", destination_country: "Vietnam", start_date: "2025-01-01", end_date: "2025-01-05", status: "completed", visibility: "private", show_on_profile: true, show_exact_dates: true },
    ],
    passport_memories: [
      { id: "m-beach", user_id: OWNER, status: "active", title: "Beach day", city: "Da Nang", country: "Vietnam", trip_id: T_VN, visibility: "public", earned_at: "2025-03-05" },
      { id: "m-town", user_id: OWNER, status: "active", title: "Old town", city: "Hoi An", country: "Vietnam", trip_id: T_VN, visibility: "public", earned_at: "2025-03-06" },
      { id: "m-priv", user_id: OWNER, status: "active", title: "Secret spot", city: "Da Nang", country: "Vietnam", trip_id: T_VN, visibility: "private", earned_at: "2025-03-07" },
      { id: "m-priv2", user_id: OWNER, status: "active", title: "Hidden beach", city: "Sa Pa", country: "Vietnam", trip_id: T_PRIV, visibility: "private", earned_at: "2025-01-02" },
      { id: "m-solo", user_id: OWNER, status: "active", title: "Solo sunset", city: "Bangkok", country: "Thailand", trip_id: null, visibility: "public", earned_at: "2024-11-11" },
    ],
    user_stamps: [
      { id: "s-bkk", user_id: OWNER, visibility: "public", source_type: "posts", city: "Bangkok", country: "Thailand", is_revoked: false, earned_at: "2024-11-11", catalog_id: "c-bkk", stamp_definitions: { name: "Chatuchak", stamp_type: "market" } },
      { id: "s-night1", user_id: OWNER, visibility: "public", source_type: "posts", city: "Da Nang", country: "Vietnam", is_revoked: false, earned_at: "2025-03-10", catalog_id: "c-n1", stamp_definitions: { name: "Night Market", stamp_type: "nightlife" } },
      { id: "s-night2", user_id: OWNER, visibility: "public", source_type: "posts", city: "Da Nang", country: "Vietnam", is_revoked: false, earned_at: "2025-03-12", catalog_id: "c-n2", stamp_definitions: { name: "Sky Bar", stamp_type: "nightlife" } },
      { id: "s-trip", user_id: OWNER, visibility: "public", source_type: "trips", source_id: T_VN, city: "Da Nang", country: "Vietnam", is_revoked: false, earned_at: "2025-03-30", catalog_id: "c-t", stamp_definitions: { name: "Da Nang", stamp_type: "city" } },
      { id: "s-gem1", user_id: OWNER, visibility: "public", source_type: "posts", city: "Da Nang", country: "Vietnam", is_revoked: false, earned_at: "2025-04-02", catalog_id: "c-g1", stamp_definitions: { name: "Quiet Alley Cafe", stamp_type: "hidden_gem" } },
      { id: "s-gem2", user_id: OWNER, visibility: "public", source_type: "posts", city: "Hue", country: "Vietnam", is_revoked: false, earned_at: "2025-04-03", catalog_id: "c-g2", stamp_definitions: { name: "Rooftop Garden", stamp_type: "hidden_gem" } },
    ],
    passport_stamps: [],
    ...overrides,
  });
}

function ownerPerms(): YearbookPermissions {
  return { isSelf: true, canSeeTrips: true, canSeeRestricted: true, callerCtx: "owner", viewerId: OWNER };
}
function publicPerms(): YearbookPermissions {
  return { isSelf: false, canSeeTrips: true, canSeeRestricted: false, callerCtx: "public", viewerId: VIEWER };
}

function allLines(yb: YearbookProjection): YearbookLine[] {
  return yb.years.flatMap((y) => y.lines);
}
function year(yb: YearbookProjection, y: number) {
  const found = yb.years.find((x) => x.year === y);
  assert.ok(found, `expected a ${y} entry`);
  return found!;
}
function lineByKey(yb: YearbookProjection, y: number, key: string): YearbookLine | undefined {
  return year(yb, y).lines.find((l) => l.key === key);
}

// ── 1. Every line carries its evidence ───────────────────────────────────────

describe("yearbook explainability", () => {
  it("gives every line a non-empty headline and non-empty evidence", async () => {
    const yb = await buildYearbook(seed(), OWNER, ownerPerms());
    const lines = allLines(yb);
    assert.ok(lines.length > 0, "fixture must produce lines");
    for (const l of lines) {
      assert.ok(l.headline.trim().length > 0, `line ${l.key} has no headline`);
      assert.ok(l.evidence.length > 0, `line ${l.key} states a claim with no evidence`);
      for (const e of l.evidence) {
        assert.equal(typeof e, "string");
        assert.ok(e.trim().length > 0, `line ${l.key} carries a blank evidence entry`);
      }
    }
  });

  it("explains the places count with one attributed source per place", async () => {
    const yb = await buildYearbook(seed(), OWNER, ownerPerms());
    const places = lineByKey(yb, 2025, "places");
    assert.ok(places, "2025 must have a places line");
    const y2025 = year(yb, 2025);
    // The headline counts are exactly the attributed lists' lengths.
    assert.match(places!.headline, /1 country/);
    assert.match(places!.headline, /cities/);
    // Every country/city named in the year is attributed in the evidence.
    for (const c of [...y2025.countries, ...y2025.cities]) {
      assert.ok(
        places!.evidence.some((e) => e.startsWith(`${c} — `)),
        `${c} appears in the year but is not attributed in the evidence`,
      );
    }
  });

  it("ranks defining journeys and shows the ranking inputs as evidence", async () => {
    const yb = await buildYearbook(seed(), OWNER, ownerPerms());
    const j = lineByKey(yb, 2025, `journey:${T_VN}`);
    assert.ok(j, "the Vietnam trip must be a defining journey of 2025");
    assert.equal(j!.basis, "observed");
    assert.ok(j!.evidence.some((e) => /memories/.test(e)), "memory count is evidence");
    assert.ok(j!.evidence.some((e) => /stamp/.test(e)), "stamp count is evidence");
    assert.ok(j!.evidence.some((e) => /30 days/.test(e)), "duration is evidence");
    // The richest journey of the year sorts first among journey lines.
    const journeyKeys = year(yb, 2025).lines.filter((l) => l.kind === "journey").map((l) => l.key);
    assert.equal(journeyKeys[0], `journey:${T_VN}`);
  });

  it("attributes each stamp milestone to the exact stamp that crossed it", async () => {
    const yb = await buildYearbook(seed(), OWNER, ownerPerms());
    const first = lineByKey(yb, 2024, "stamps-total:1");
    assert.ok(first, "the first stamp ever is a 2024 milestone");
    assert.ok(first!.evidence.some((e) => e.includes("Chatuchak")));
    // Cumulative totals continue across years — the 5th stamp lands in 2025.
    const fifth = lineByKey(yb, 2025, "stamps-total:5");
    assert.ok(fifth, "the running total must not restart each year");
    assert.ok(fifth!.evidence.some((e) => e.includes("Stamp #5")));
    // New countries of the year name the stamp that opened them.
    const newCountries = lineByKey(yb, 2025, "new-countries");
    assert.ok(newCountries);
    assert.ok(newCountries!.evidence.some((e) => e.startsWith("Vietnam — first stamp")));
  });
});

// ── 2. Blocked / hidden items never appear ───────────────────────────────────

describe("yearbook hides what the passport hides", () => {
  it("never names a blocked companion, anywhere", async () => {
    const yb = await buildYearbook(seed(), OWNER, ownerPerms());
    const blob = JSON.stringify(yb);
    assert.ok(!blob.includes("Mallory"), "a blocked companion leaked into the yearbook");
    assert.ok(!blob.includes(BLOCKED), "a blocked companion id leaked into the yearbook");
    // …while the permitted companion is still credited.
    assert.ok(blob.includes("Ana"), "the non-blocked companion should still be credited");
  });

  it("omits a private trip and private memories from a public viewer", async () => {
    const yb = await buildYearbook(seed(), OWNER, publicPerms());
    const blob = JSON.stringify(yb);
    assert.ok(!blob.includes(T_PRIV), "the private trip leaked");
    assert.ok(!blob.includes("Secret Trip"), "the private trip title leaked");
    assert.ok(!blob.includes("Sa Pa"), "the private trip's city leaked");
    assert.ok(!blob.includes("Secret spot"), "a private memory leaked");
    assert.ok(!blob.includes("Hidden beach"), "a private memory leaked");
    // The public material is still there.
    assert.ok(blob.includes("30 Days in Vietnam"));
    assert.ok(blob.includes("Beach day"));
  });

  it("keeps the private material for the owner", async () => {
    const yb = await buildYearbook(seed(), OWNER, ownerPerms());
    const blob = JSON.stringify(yb);
    assert.ok(blob.includes("Secret Trip"));
    assert.ok(blob.includes("Secret spot"));
    assert.ok(blob.includes("Hidden beach"));
  });

  it("drops all stamp material when the stamp collection is private to this viewer", async () => {
    const db = seed({
      passport_visibility_preferences: [
        { user_id: OWNER, stamps_visible: "private", memories_visible: "public" },
      ],
    });
    const yb = await buildYearbook(db, OWNER, publicPerms());
    assert.equal(yb.included.stamps, false);
    assert.equal(allLines(yb).filter((l) => l.kind === "stamp_milestone").length, 0);
    for (const y of yb.years) assert.equal(y.stampCount, 0);
    const blob = JSON.stringify(yb);
    assert.ok(!blob.includes("Chatuchak"), "a stamp name leaked past the collection tier");
    assert.ok(!blob.includes("Sky Bar"), "a stamp name leaked past the collection tier");
    // The owner is unaffected by the viewer-facing tier.
    const own = await buildYearbook(db, OWNER, ownerPerms());
    assert.equal(own.included.stamps, true);
  });

  it("drops all memory material when the memory collection is private to this viewer", async () => {
    const db = seed({
      passport_visibility_preferences: [
        { user_id: OWNER, stamps_visible: "public", memories_visible: "private" },
      ],
    });
    const yb = await buildYearbook(db, OWNER, publicPerms());
    assert.equal(yb.included.memories, false);
    const blob = JSON.stringify(yb);
    assert.ok(!blob.includes("Solo sunset"), "a standalone memory leaked past the collection tier");
  });

  it("hides a Travel DNA trait the owner marked 'not me' from a viewer, but not from the owner", async () => {
    const db = seed({
      feature_flags: [{ flag: "passport_travel_dna_enabled", enabled: true }],
      passport_travel_dna_prefs: [
        { user_id: OWNER, dimension_key: "night_explorer", state: "not_me" },
      ],
    });
    const viewer = await buildYearbook(db, OWNER, publicPerms());
    assert.ok(
      !allLines(viewer).some((l) => l.key === "dna-trait:night_explorer"),
      "a 'not me' trait resurfaced through the yearbook",
    );
    const own = await buildYearbook(db, OWNER, ownerPerms());
    assert.ok(
      allLines(own).some((l) => l.key === "dna-trait:night_explorer"),
      "the owner should still see their own suppressed trait",
    );
  });
});

// ── 3. A viewer sees no more than the projection allows ──────────────────────

function permsPublicProjection(): ViewerPermissions {
  return {
    relationshipLabel: "stranger", isBlocked: false, isUnavailable: false,
    canViewProfile: true, canViewFullProfile: false, canSeeAvailability: false,
    canSeeTrips: true, canSeeMutuals: false, canSeeLocationContext: false,
    canSeeFriendOnlyPosts: false, canMessage: false, canSendMessageRequest: false,
    canFollow: true, canInviteToTripCrew: false,
  };
}

describe("yearbook is a subset of the passport projection", () => {
  it("names no memory, stamp or journey the same viewer's projection does not carry", async () => {
    const db = seed();
    const resolution: ViewerResolution = {
      context: "public",
      permissions: permsPublicProjection(),
      sharedTrip: false, sharedEvent: false, ownerIsTripHost: false, buddyRole: null,
    };
    const projection = await buildPassportProjection(db, OWNER, VIEWER, {
      resolveViewerContext: async () => resolution,
    });
    assert.ok(projection, "projection must build");

    const yb = await buildYearbook(seed(), OWNER, publicPerms());
    const blob = JSON.stringify(yb);

    const projectionMemoryTitles = new Set(projection!.memories.map((m) => m.title));
    const projectionStampNames = new Set(projection!.stamps.map((s) => s.name));

    // Every memory title the yearbook mentions is one the projection already gave
    // this viewer. (Fixture memory titles are distinctive strings.)
    for (const title of ["Beach day", "Old town", "Solo sunset", "Secret spot", "Hidden beach"]) {
      if (blob.includes(title)) {
        assert.ok(
          projectionMemoryTitles.has(title),
          `yearbook exposed memory "${title}" the projection withheld`,
        );
      }
    }
    for (const name of ["Chatuchak", "Night Market", "Sky Bar", "Da Nang", "Quiet Alley Cafe", "Rooftop Garden"]) {
      if (blob.includes(`"${name}"`)) {
        assert.ok(
          projectionStampNames.has(name),
          `yearbook exposed stamp "${name}" the projection withheld`,
        );
      }
    }
    // And the private material the projection stripped is absent here too.
    assert.ok(!projectionMemoryTitles.has("Secret spot"));
    assert.ok(!blob.includes("Secret spot"));
  });

  it("applies the PER-STAMP visibility tier, not only the stamp-shelf tier (§22)", async () => {
    // The collection tier (`stamps_visible`) says whether the shelf is shown at
    // all; the per-stamp tier says which stamps on it are. The projection gates
    // on BOTH, so the yearbook — a retelling of the projection — must too.
    const withPrivate = {
      user_stamps: [
        { id: "s-open", user_id: OWNER, visibility: "public", source_type: "posts", city: "Hue", country: "Vietnam", is_revoked: false, earned_at: "2025-05-01", catalog_id: "c-o", stamp_definitions: { name: "Open Stamp", stamp_type: "place" } },
        { id: "s-shut", user_id: OWNER, visibility: "private", source_type: "posts", city: "Hue", country: "Vietnam", is_revoked: false, earned_at: "2025-05-02", catalog_id: "c-s", stamp_definitions: { name: "Private Stamp", stamp_type: "place" } },
        // No tier at all: `isUnifiedStampVisible` fails closed rather than
        // defaulting an absent tier to public.
        { id: "s-untiered", user_id: OWNER, source_type: "posts", city: "Hue", country: "Vietnam", is_revoked: false, earned_at: "2025-05-03", catalog_id: "c-u2", stamp_definitions: { name: "Untiered Stamp", stamp_type: "place" } },
      ],
    };
    const viewer = await buildYearbook(seed(withPrivate), OWNER, publicPerms());
    const viewerBlob = JSON.stringify(viewer);
    assert.ok(viewerBlob.includes("Open Stamp"), "a public stamp must still be narrated");
    assert.ok(!viewerBlob.includes("Private Stamp"), "yearbook narrated a stamp the owner marked private");
    assert.ok(!viewerBlob.includes("Untiered Stamp"), "yearbook narrated a stamp with no visibility tier");
    assert.equal(year(viewer, 2025).stampCount, 1, "only the one public stamp may be counted");

    // …and the owner's own yearbook still counts all three: the gate is a
    // viewer-side filter, not a deletion.
    const own = await buildYearbook(seed(withPrivate), OWNER, ownerPerms());
    assert.equal(year(own, 2025).stampCount, 3, "the owner must still see every stamp they earned");
  });

  it("a viewer's years are a subset of the owner's own years and places", async () => {
    const own = await buildYearbook(seed(), OWNER, ownerPerms());
    const viewer = await buildYearbook(seed(), OWNER, publicPerms());
    for (const vy of viewer.years) {
      const oy = own.years.find((y) => y.year === vy.year);
      assert.ok(oy, `viewer saw year ${vy.year} the owner does not have`);
      for (const c of vy.countries) assert.ok(oy!.countries.includes(c), `extra country ${c}`);
      for (const c of vy.cities) assert.ok(oy!.cities.includes(c), `extra city ${c}`);
      assert.ok(vy.journeyCount <= oy!.journeyCount);
      assert.ok(vy.memoryCount <= oy!.memoryCount);
    }
  });

  it("carries no coordinate-shaped field anywhere (§23)", async () => {
    const yb = await buildYearbook(seed(), OWNER, ownerPerms());
    const blob = JSON.stringify(yb);
    for (const banned of ["latitude", "longitude", '"lat"', '"lng"', '"lon"', "geo_point", "coordinates"]) {
      assert.ok(!blob.includes(banned), `yearbook carries ${banned}`);
    }
  });

  it("reads no trust or reputation score into the yearbook", async () => {
    const yb = await buildYearbook(seed(), OWNER, ownerPerms());
    const blob = JSON.stringify(yb);
    for (const banned of ["trust", "trustScore", "reputation", "score"]) {
      assert.ok(!blob.includes(banned), `yearbook surfaced ${banned} — a derived score must stay out`);
    }
  });
});

// ── 4. Honest empty states ───────────────────────────────────────────────────

describe("yearbook empty states", () => {
  it("returns an explicitly empty yearbook for a traveller with no history", async () => {
    const db = makePassportDb({ profiles: [{ id: OWNER, handle: "new" }] });
    const yb = await buildYearbook(db, OWNER, ownerPerms());
    assert.equal(yb.years.length, 0);
    assert.equal(yb.empty, true);
    assert.ok(yb.emptyMessage && yb.emptyMessage.length > 0);
    assert.ok(!/\d+ countr/.test(yb.emptyMessage!), "empty state must not assert a count");
  });

  it("returns an honest empty entry for a requested year with nothing in it", async () => {
    const yb = await buildYearbook(seed(), OWNER, ownerPerms(), { year: 2019 });
    assert.equal(yb.years.length, 1);
    const y = yb.years[0];
    assert.equal(y.year, 2019);
    assert.equal(y.empty, true);
    assert.equal(y.lines.length, 0);
    assert.deepEqual(y.countries, []);
    assert.deepEqual(y.cities, []);
    assert.equal(y.journeyCount, 0);
    assert.equal(y.stampCount, 0);
    assert.equal(y.memoryCount, 0);
    assert.ok(y.emptyMessage?.includes("2019"));
    assert.equal(yb.empty, true);
  });

  it("returns just the requested year when it does have content", async () => {
    const yb = await buildYearbook(seed(), OWNER, ownerPerms(), { year: 2024 });
    assert.equal(yb.years.length, 1);
    assert.equal(yb.years[0].year, 2024);
    assert.equal(yb.years[0].empty, false);
    assert.equal(yb.empty, false);
  });

  it("gives a viewer who may see nothing an empty yearbook, not a partial one", async () => {
    const yb = await buildYearbook(seed(), OWNER, {
      isSelf: false, canSeeTrips: false, canSeeRestricted: false, callerCtx: "public",
      viewerId: VIEWER,
    });
    // No trips at all; stamps/memories still flow through their own public tiers,
    // so the assertion is that no TRIP material appears.
    assert.ok(!JSON.stringify(yb).includes("30 Days in Vietnam"));
    assert.equal(yb.included.journeys, false);
  });
});

// ── 5. §37 truth boundary ────────────────────────────────────────────────────

describe("yearbook truth boundary (§37)", () => {
  it("labels every Travel DNA line inferred and every record line observed", async () => {
    const yb = await buildYearbook(seed(), OWNER, ownerPerms());
    const lines = allLines(yb);
    assert.ok(lines.some((l) => l.kind === "dna_shift"), "fixture must produce DNA lines");
    for (const l of lines) {
      if (l.kind === "dna_shift") {
        assert.equal(l.basis, "inferred", `${l.key} is a model reading and must be labelled inferred`);
      } else {
        assert.equal(l.basis, "observed", `${l.key} restates records and must be labelled observed`);
      }
    }
  });

  it("reports a year-over-year DNA shift only with both years' evidence", async () => {
    const yb = await buildYearbook(seed(), OWNER, ownerPerms());
    const emerged = lineByKey(yb, 2025, "dna-trait:night_explorer");
    assert.ok(emerged, "Night Explorer emerged in 2025");
    assert.equal(emerged!.basis, "inferred");
    assert.ok(emerged!.evidence.some((e) => e.startsWith("2025:")), "this year's evidence");
    assert.ok(emerged!.evidence.some((e) => e.startsWith("2024:")), "last year's evidence");
    // 2024 is the earliest year, so its readings are labelled first readings, not shifts.
    for (const l of year(yb, 2024).lines.filter((l) => l.kind === "dna_shift")) {
      assert.ok(
        l.headline.includes("first reading") || l.evidence.some((e) => e.includes("No earlier year")),
        `${l.key} claimed a shift with no earlier year to shift from`,
      );
    }
  });

  it("never attributes a current profile field to a past year", async () => {
    // The owner's profile says "planner"/"luxury" today. A year reading is built
    // from that year's activity ONLY, so no profile-derived axis may appear.
    const db = seed({
      profiles: [
        {
          id: OWNER, handle: "wanderer", display_name: "Wanderer",
          travel_pace: "packed", planning_style: "planner", budget_style: "luxury",
          spoken_languages: ["English", "Vietnamese"], created_at: "2023-01-01",
        },
      ],
    });
    const yb = await buildYearbook(db, OWNER, ownerPerms());
    const dna = allLines(yb).filter((l) => l.kind === "dna_shift");
    for (const key of ["dna:planning", "dna:spend_style", "dna:travel_pace", "dna:languages"]) {
      assert.ok(!dna.some((l) => l.key === key), `${key} is a profile field, not ${"a"} year's activity`);
    }
    // …while the activity-derived axes are present.
    assert.ok(dna.some((l) => l.key === "dna:discovery"), "discovery is derived from that year's stamps");
  });

  it("only reports a DNA axis for a year whose own activity supports it", async () => {
    const yb = await buildYearbook(seed(), OWNER, ownerPerms());
    const dna2024 = year(yb, 2024).lines.filter((l) => l.kind === "dna_shift").map((l) => l.key);
    // 2024 has a single market stamp: no nightlife, no hidden gems.
    assert.ok(!dna2024.includes("dna:discovery"));
    assert.ok(!dna2024.includes("dna-trait:night_explorer"));
  });
});

// ── 6. Small pure helpers ────────────────────────────────────────────────────

describe("isHiddenGemStamp", () => {
  const base = {
    source: "v2_achievement" as const, stampSource: "system_observed" as const,
    verification: "verified" as const, visibility: "public", userStampId: null, definitionId: null,
    catalogId: null, city: null, country: null, earnedAt: null, rarity: null, artworkUrl: null,
  };
  it("matches on the stamp type", () => {
    assert.equal(isHiddenGemStamp({ ...base, stampType: "hidden_gem", name: "Alley" }), true);
  });
  it("matches on a hidden-gem name", () => {
    assert.equal(isHiddenGemStamp({ ...base, stampType: "place", name: "Hidden Gem: Alley" }), true);
  });
  it("does not match an ordinary stamp", () => {
    assert.equal(isHiddenGemStamp({ ...base, stampType: "city", name: "Da Nang" }), false);
  });
});

// ── 7. What was counted, and WHY something was not ───────────────────────────
//
// `included` is a PERMISSION flag, never a has-content flag, and `exclusions`
// names the real reason per collection. The surface renders that reason
// verbatim, so a wrong flag here becomes a false statement to the owner about
// their own privacy settings.

/** A client that throws for one table, so a reader genuinely fails. */
function seedWithBrokenTable(table: string, overrides: Record<string, any[]> = {}) {
  const inner = seed(overrides);
  return {
    ...inner,
    from(t: string) {
      if (t === table) throw new Error(`simulated read failure on ${t}`);
      return inner.from(t);
    },
  } as any;
}

/** The fixture minus every trip — an owner who simply has not travelled yet. */
function seedWithoutTrips() {
  return seed({ trips: [], trip_members: [] });
}

describe("yearbook says what it counted and why", () => {
  it("still counts journeys as included for an owner who simply has no trips", async () => {
    const yb = await buildYearbook(seedWithoutTrips(), OWNER, ownerPerms());

    // The owner has stamps and memories, so the yearbook is not empty…
    assert.ok(yb.years.length > 0, "fixture must still produce years");
    for (const y of yb.years) assert.equal(y.journeyCount, 0);
    // …and having no trips is NOT an exclusion: nothing was withheld.
    assert.equal(yb.included.journeys, true);
    assert.deepEqual(
      yb.exclusions.filter((e) => e.collection === "journeys"),
      [],
      "an owner with no trips must not be told their journeys were withheld",
    );
  });

  it("excludes journeys as a visibility exclusion for a viewer the trips gate blocks", async () => {
    const yb = await buildYearbook(seed(), OWNER, {
      isSelf: false, canSeeTrips: false, canSeeRestricted: false, callerCtx: "public",
      viewerId: VIEWER,
    });
    assert.equal(yb.included.journeys, false);
    assert.deepEqual(
      yb.exclusions.filter((e) => e.collection === "journeys"),
      [{ collection: "journeys", reason: "visibility" }],
    );
  });

  it("names a private stamp collection as a visibility exclusion", async () => {
    const yb = await buildYearbook(
      seed({
        passport_visibility_preferences: [
          { user_id: OWNER, stamps_visible: "private", memories_visible: "public" },
        ],
      }),
      OWNER,
      publicPerms(),
    );
    assert.equal(yb.included.stamps, false);
    assert.deepEqual(
      yb.exclusions.filter((e) => e.collection === "stamps"),
      [{ collection: "stamps", reason: "visibility" }],
    );
    // The collections that WERE counted carry no exclusion at all.
    assert.deepEqual(yb.exclusions.map((e) => e.collection), ["stamps"]);
  });

  it("reports a failed reader as unavailable, never as the owner's visibility choice", async () => {
    const yb = await buildYearbook(seedWithBrokenTable("passport_memories"), OWNER, ownerPerms());

    assert.equal(yb.included.memories, false, "a collection that could not be read is not included");
    assert.deepEqual(
      yb.exclusions.filter((e) => e.collection === "memories"),
      [{ collection: "memories", reason: "unavailable" }],
      "a read failure must not be reported as a privacy setting",
    );
    // Everything else still counted — the failure is scoped to its collection.
    assert.equal(yb.included.stamps, true);
    assert.equal(yb.included.journeys, true);
  });

  it("gives an owner with nothing at all an empty yearbook with no invented exclusion", async () => {
    const yb = await buildYearbook(
      seed({ trips: [], trip_members: [], user_stamps: [], passport_memories: [] }),
      OWNER,
      ownerPerms(),
    );
    assert.equal(yb.empty, true);
    assert.equal(yb.years.length, 0);
    assert.deepEqual(yb.exclusions, [], "an empty history is not an exclusion");
    assert.deepEqual(yb.included, { journeys: true, stamps: true, memories: true, travelDna: true });
  });
});

// ── 8. Milestone totals agree with the per-year counts ───────────────────────

describe("yearbook stamp milestones", () => {
  const UNDATED = {
    id: "s-undated", user_id: OWNER, source_type: "posts", city: "Hue", country: "Vietnam",
    is_revoked: false, earned_at: null, catalog_id: "c-u",
    stamp_definitions: { name: "Undated Stamp", stamp_type: "place" },
  };

  it("numbers milestones over dated stamps only, so the running total matches the year cards", async () => {
    // The fixture's six dated stamps plus one whose earned_at never parsed.
    const db = seed({
      user_stamps: [
        UNDATED,
        { id: "s-bkk", user_id: OWNER, visibility: "public", source_type: "posts", city: "Bangkok", country: "Thailand", is_revoked: false, earned_at: "2024-11-11", catalog_id: "c-bkk", stamp_definitions: { name: "Chatuchak", stamp_type: "market" } },
        { id: "s-night1", user_id: OWNER, visibility: "public", source_type: "posts", city: "Da Nang", country: "Vietnam", is_revoked: false, earned_at: "2025-03-10", catalog_id: "c-n1", stamp_definitions: { name: "Night Market", stamp_type: "nightlife" } },
        { id: "s-night2", user_id: OWNER, visibility: "public", source_type: "posts", city: "Da Nang", country: "Vietnam", is_revoked: false, earned_at: "2025-03-12", catalog_id: "c-n2", stamp_definitions: { name: "Sky Bar", stamp_type: "nightlife" } },
        { id: "s-trip", user_id: OWNER, visibility: "public", source_type: "trips", source_id: T_VN, city: "Da Nang", country: "Vietnam", is_revoked: false, earned_at: "2025-03-30", catalog_id: "c-t", stamp_definitions: { name: "Da Nang", stamp_type: "city" } },
        { id: "s-gem1", user_id: OWNER, visibility: "public", source_type: "posts", city: "Da Nang", country: "Vietnam", is_revoked: false, earned_at: "2025-04-02", catalog_id: "c-g1", stamp_definitions: { name: "Quiet Alley Cafe", stamp_type: "hidden_gem" } },
        { id: "s-gem2", user_id: OWNER, visibility: "public", source_type: "posts", city: "Hue", country: "Vietnam", is_revoked: false, earned_at: "2025-04-03", catalog_id: "c-g2", stamp_definitions: { name: "Rooftop Garden", stamp_type: "hidden_gem" } },
      ],
    });
    const yb = await buildYearbook(db, OWNER, ownerPerms());

    // #1 is the first DATED stamp — the undated one anchors no year and must not
    // consume the first slot (which would delete the "First stamp earned" line).
    const first = lineByKey(yb, 2024, "stamps-total:1");
    assert.ok(first, "the first dated stamp must still produce a first-stamp milestone");
    assert.ok(
      first!.evidence.some((e) => e.includes("Chatuchak")),
      `first-stamp milestone anchored to the wrong stamp: ${JSON.stringify(first!.evidence)}`,
    );

    // #5 is still the fifth DATED stamp.
    const fifth = lineByKey(yb, 2025, "stamps-total:5");
    assert.ok(fifth, "expected a 5-stamp milestone");
    assert.ok(
      fifth!.evidence.some((e) => e.includes("Quiet Alley Cafe")),
      `5-stamp milestone anchored to the wrong stamp: ${JSON.stringify(fifth!.evidence)}`,
    );

    // The invariant behind both: no milestone may be numbered over more stamps
    // than the year cards actually show.
    const shown = yb.years.reduce((n, y) => n + y.stampCount, 0);
    for (const l of allLines(yb)) {
      const m = /^stamps-total:(\d+)$/.exec(l.key);
      if (!m) continue;
      assert.ok(
        Number(m[1]) <= shown,
        `milestone ${l.key} counts stamps that appear in no year card (year cards show ${shown})`,
      );
    }
    // The undated stamp is in no year, so it is named nowhere.
    assert.ok(!JSON.stringify(yb).includes("Undated Stamp"));
  });
});
