/**
 * A persisted travel time says where it came from, or says it does not know.
 *
 * node:test + node:assert (NOT vitest). Real services, fake table-backed DB.
 *
 * ── THE DEFECT THIS FILE CLOSES ──────────────────────────────────────────────
 * `LayoverTravelTime.ts`'s header states the obligation that made the provider
 * a module constant rather than an environment lookup:
 *
 *     "wiring a real provider must be a code change that lands on the line
 *      below, because it also obliges its author to add a provenance column to
 *      `layover_recommendations` before a 'measured' figure may be persisted
 *      (see `persistedTravelTimeSource` for why the read path cannot infer
 *      one). An env switch would let a routed provider appear in production
 *      with the read path still inferring 'category_default' for every row it
 *      wrote."
 *
 * The prerequisite is what is built here — the COLUMN (migration 2745) and the
 * read path that stops guessing — and NOT the routing provider. There is no
 * routing service on this tree; `straightLineTravelTimeProvider` exists and is
 * still refused, for the reason `LayoverPlanFit` states about its own totals: a
 * lower bound can REFUSE a journey and can never CERTIFY one.
 *
 * WHAT `persistedTravelTimeSource` DID BEFORE. A landside row holding a
 * positive `travel_time_min` was reported `category_default` — a claim about a
 * producer, decided from the sign of an integer, on a row that said nothing.
 * Every case below that asserts `unknown_provenance` was RED against that code.
 *
 * WHAT IS STILL READ OFF THE ROW, AND WHY THAT IS NOT INFERENCE. `inside_airport`
 * and a landside zero are FACTS the row's own columns carry (census L47/L293):
 * airside is 0 minutes by construction, and a landside zero is the absence the
 * NOT NULL DEFAULT 0 column forces an absence to be written as. Neither is a
 * claim that anything was measured.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx --test \
 *      src/services/airport/__tests__/layoverTravelTimeProvenanceColumn.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  persistedTravelTimeSource,
  TRAVEL_TIME_SOURCES,
  TRAVEL_TIME_SOURCE_IS_ROUTED,
} from "../LayoverSafetyEngine.js";
import {
  generateRecommendations,
  getRecommendations,
} from "../LayoverRecommendationService.js";
import { landsideLeg, LAYOVER_TRAVEL_TIME_PROVIDER } from "../LayoverTravelTime.js";
import type { GeoPoint, TravelTimeProvider } from "../../../domain/trips/contracts/TravelTimeProvider.js";
import { makeLayoverDb } from "../../../test/helpers/fakeLayoverDb.js";
import type { AirportProfile } from "../AirportProfileService.js";
import type { LayoverSession } from "../LayoverSessionService.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(HERE, "..", "..", "..", "migrations", "2745_layover_recommendation_travel_provenance.sql");

/** The one seam a test may move, and it moves it HERE — never in the module. */
function fakeRoutedProvider(minutes: number): TravelTimeProvider {
  return {
    id: "test-fake-routed",
    routed: true,
    async estimate(_q: { from: GeoPoint | null; to: GeoPoint | null; departAt: Date }) {
      return {
        kind: "estimate" as const,
        estimate: {
          minutes,
          p50Minutes: minutes, p75Minutes: minutes, p90Minutes: minutes,
          confidence: "HIGH" as const,
          sourceClass: "LIVE" as const,
          observedAt: null, expiresAt: null,
          fallbackLevel: 0 as const,
          sourceRefs: ["test-fake-routed"],
        },
      };
    },
  };
}

function cards(r: { ok: true; recommendations: any[] } | { ok: false; message: string }): any[] {
  if (!r.ok) assert.fail(`expected recommendations, got a refusal: ${r.message}`);
  return r.recommendations;
}

const AIRPORT: AirportProfile = {
  id: "airport-tpe", iataCode: "TPE", name: "Taoyuan Intl", city: "Taoyuan",
  country: "Taiwan", countryCode: "TW", timezone: "Asia/Taipei", lat: 25.07, lng: 121.23,
  domesticBufferMin: 60, domesticBufferMax: 90, internationalBufferMin: 120, internationalBufferMax: 180,
  immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20, verified: false,
};

function session(over: Partial<LayoverSession> = {}): LayoverSession {
  const now = Date.now();
  return {
    id: "session-1", userId: "user-1", airportId: "airport-tpe", tripId: null,
    arrivalTime: new Date(now + 5 * 60_000).toISOString(),
    departureTime: new Date(now + 9 * 3_600_000).toISOString(),
    boardingTime: null, layoverMinutes: 535,
    flightType: "international", immigrationRequired: false, checkedBags: false,
    loungeAccess: false, wantsToLeave: true, comfortLevel: "moderate", vibeChips: ["food"],
    manualAirportName: null, manualCity: null, manualCountry: null, manualIata: null,
    canonicalCityId: null, shareCityStatus: false, returnReminderAt: null, status: "active",
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    ...over,
  };
}

const PLACES = [
  { id: "place-1", name: "Night Market", place_type: "attraction", category: "food", neighborhood: "Zhongli", blurb: "Snacks", verified: true, city: "Taoyuan", status: "active", lat: 25.01, lng: 121.30 },
  { id: "place-2", name: "Riverside Cafe", place_type: "cafe", category: "food", neighborhood: null, blurb: "Coffee", verified: false, city: "Taoyuan", status: "active", lat: 24.99, lng: 121.31 },
];

function tables(): Record<string, any[]> {
  return {
    discovery_places: PLACES.map((p) => ({ ...p })),
    layover_recommendations: [],
    layover_plan_stops: [],
    layover_events: [],
  };
}

/** A persisted row, as `select("*")` hands it back. */
function row(over: Record<string, any> = {}): Record<string, any> {
  return {
    id: "r", session_id: "session-1", rec_type: "activity", title: "Night Market",
    safety_rating: "safe", travel_time_min: 25, activity_time_min: 90,
    return_buffer_min: 140, hard_return_time: null, inside_airport: false, sort_order: 0,
    ...over,
  };
}

// ── 1. The read path stops inferring ─────────────────────────────────────────

describe("persistedTravelTimeSource — a row that said nothing is not a row that said category_default", () => {
  it("landside, a stored figure, NO provenance ⇒ unknown_provenance", () => {
    assert.equal(
      persistedTravelTimeSource({ insideAirport: false, travelTimeMin: 25 }),
      "unknown_provenance",
    );
    assert.equal(
      persistedTravelTimeSource({ insideAirport: false, travelTimeMin: 25, provenance: null }),
      "unknown_provenance",
    );
  });

  it("the facts the row DOES carry are still read: airside 0 and a landside absence", () => {
    assert.equal(persistedTravelTimeSource({ insideAirport: true, travelTimeMin: 0 }), "inside_airport");
    assert.equal(persistedTravelTimeSource({ insideAirport: false, travelTimeMin: 0 }), "unmeasured");
    assert.equal(persistedTravelTimeSource({ insideAirport: false, travelTimeMin: null }), "unmeasured");
  });

  it("a RECORDED provenance is what the row reads as — all four the column must express", () => {
    for (const v of ["measured", "traveller_stated", "straight_line_bound", "unknown_provenance"] as const) {
      assert.equal(
        persistedTravelTimeSource({ insideAirport: false, travelTimeMin: 25, provenance: v }),
        v,
        `a row that says "${v}" must read as "${v}"`,
      );
    }
  });

  it("a recorded provenance wins over the row's facts, in both directions", () => {
    // An airside row whose column says a route was measured is not silently
    // relabelled by the `inside_airport` flag, and a landside ZERO whose column
    // says "traveller stated" is not relabelled `unmeasured` either.
    assert.equal(
      persistedTravelTimeSource({ insideAirport: true, travelTimeMin: 0, provenance: "measured" }),
      "measured",
    );
    assert.equal(
      persistedTravelTimeSource({ insideAirport: false, travelTimeMin: 0, provenance: "traveller_stated" }),
      "traveller_stated",
    );
  });

  it("a value outside the vocabulary is NOT trusted — it falls back to the row's facts", () => {
    assert.equal(
      persistedTravelTimeSource({ insideAirport: false, travelTimeMin: 25, provenance: "routed" }),
      "unknown_provenance",
    );
    assert.equal(
      persistedTravelTimeSource({ insideAirport: false, travelTimeMin: 25, provenance: "" }),
      "unknown_provenance",
    );
  });

  it("no unrecorded row can read as routed — swept over every shape the row can take", () => {
    for (const insideAirport of [true, false]) {
      for (const travelTimeMin of [null, 0, 1, 25, 999]) {
        const s = persistedTravelTimeSource({ insideAirport, travelTimeMin });
        assert.equal(TRAVEL_TIME_SOURCE_IS_ROUTED[s], false,
          `inside=${insideAirport} min=${travelTimeMin} read as routed without a column saying so`);
      }
    }
  });

  it("the vocabulary can express every state the column can hold", () => {
    for (const v of ["measured", "traveller_stated", "straight_line_bound", "unknown_provenance"]) {
      assert.ok((TRAVEL_TIME_SOURCES as readonly string[]).includes(v), `${v} is not in the vocabulary`);
    }
    // Only a real route is routed. A straight line is a refusal, not a route.
    assert.equal(TRAVEL_TIME_SOURCE_IS_ROUTED.straight_line_bound, false);
    assert.equal(TRAVEL_TIME_SOURCE_IS_ROUTED.traveller_stated, false);
    assert.equal(TRAVEL_TIME_SOURCE_IS_ROUTED.unknown_provenance, false);
  });
});

describe("getRecommendations — the persisted read path carries the column, not a guess", () => {
  it("a legacy row (no column) with a figure is unknown_provenance, not category_default", async () => {
    const t = tables();
    t.layover_recommendations.push(
      row({ id: "r-air", inside_airport: true, travel_time_min: 0, title: "Airport Dining" }),
      row({ id: "r-legacy", travel_time_min: 25 }),
      row({ id: "r-absent", travel_time_min: 0, sort_order: 2 }),
    );
    const recs = cards(await getRecommendations(makeLayoverDb(t), "session-1"));
    const by = (id: string) => recs.find((r) => r.id === id)!;
    assert.equal(by("r-air").travelTimeSource, "inside_airport");
    assert.equal(by("r-absent").travelTimeSource, "unmeasured");
    assert.equal(by("r-legacy").travelTimeSource, "unknown_provenance");
    // The FIGURE is untouched: "we do not know where this came from" is not
    // "this does not exist". Denying the number would be the other fabrication.
    assert.equal(by("r-legacy").travelTimeMin, 25);
  });

  it("a row whose column states its provenance reads exactly that", async () => {
    const t = tables();
    t.layover_recommendations.push(
      row({ id: "r-routed", travel_time_min: 41, travel_time_source: "measured" }),
      row({ id: "r-said", travel_time_min: 55, travel_time_source: "traveller_stated", sort_order: 1 }),
      row({ id: "r-bound", travel_time_min: 12, travel_time_source: "straight_line_bound", sort_order: 2 }),
    );
    const recs = cards(await getRecommendations(makeLayoverDb(t), "session-1"));
    const by = (id: string) => recs.find((r) => r.id === id)!;
    assert.equal(by("r-routed").travelTimeSource, "measured");
    assert.equal(by("r-said").travelTimeSource, "traveller_stated");
    assert.equal(by("r-bound").travelTimeSource, "straight_line_bound");
  });
});

// ── 2. The provider seam is unchanged, and ready ─────────────────────────────

describe("the provider seam stays exactly where LayoverTravelTime put it", () => {
  it("LAYOVER_TRAVEL_TIME_PROVIDER is still noRoutedProvider and still answers nothing", async () => {
    assert.equal(LAYOVER_TRAVEL_TIME_PROVIDER.id, "none-configured");
    // NOT asserted: `.routed`. `noRoutedProvider` declares itself routed and
    // then answers `unknown` for everything — the port's own choice, so that a
    // real adapter later changes one line and no branch. What matters is the
    // ANSWER, asked for with two real coordinates and a real departure time.
    const leg = await landsideLeg({ lat: 25.07, lng: 121.23 }, { lat: 25.01, lng: 121.30 }, new Date());
    assert.equal(leg.minutes, null);
    assert.equal(leg.source, "unmeasured");
    assert.equal(leg.reason, "NO_ROUTED_PROVIDER");
  });

  it("the module constant is assigned noRoutedProvider in the source, not read from the environment", () => {
    const src = readFileSync(join(HERE, "..", "LayoverTravelTime.ts"), "utf8");
    assert.match(src, /export const LAYOVER_TRAVEL_TIME_PROVIDER: TravelTimeProvider = noRoutedProvider;/);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.equal(/process\.env/.test(code), false, "the seam became an environment lookup");
  });

  it("a provenance is written to the row ONLY when the row's own facts cannot express it", async () => {
    const { travelTimeProvenanceColumn } = await import("../LayoverTravelTime.js");
    // Recoverable from the row: airside 0, and a landside absence stored as 0.
    assert.deepEqual(travelTimeProvenanceColumn("inside_airport"), {});
    assert.deepEqual(travelTimeProvenanceColumn("unmeasured"), {});
    // NOT recoverable: these are exactly the figures that must carry a column,
    // and the reason 2745 had to land before a routed provider could.
    assert.deepEqual(travelTimeProvenanceColumn("measured"), { travel_time_source: "measured" });
    assert.deepEqual(travelTimeProvenanceColumn("traveller_stated"), { travel_time_source: "traveller_stated" });
    assert.deepEqual(travelTimeProvenanceColumn("straight_line_bound"), { travel_time_source: "straight_line_bound" });
    assert.deepEqual(travelTimeProvenanceColumn("category_default"), { travel_time_source: "category_default" });
  });
});

describe("the persist path carries a routed provenance through — proven with a FAKE provider", () => {
  it("today (noRoutedProvider): no row carries travel_time_source at all", async () => {
    const t = tables();
    cards(await generateRecommendations(makeLayoverDb(t), AIRPORT, session(), Date.now(), { stableIds: true }));
    assert.ok(t.layover_recommendations.length > 0, "positive control: rows were written");
    for (const r of t.layover_recommendations) {
      assert.ok(!("travel_time_source" in r),
        `"${r.title}" wrote a provenance column on a database that may not have 2745`);
    }
  });

  for (const stableIds of [false, true]) {
    it(`stableIds=${stableIds}: a fake ROUTED provider injected in this test lands on the row`, async () => {
      const t = tables();
      const recs = cards(await generateRecommendations(
        makeLayoverDb(t), AIRPORT, session(), Date.now(),
        { stableIds, travelTimeProvider: fakeRoutedProvider(37) },
      ));
      const written = t.layover_recommendations.filter((r) => !r.inside_airport && r.place_id);
      assert.ok(written.length >= 2, `positive control: expected discovery rows, got ${written.length}`);
      for (const r of written) {
        assert.equal(r.travel_time_source, "measured", `"${r.title}" lost its provenance on the way to the row`);
        assert.equal(r.travel_time_min, 37, `"${r.title}" lost its figure`);
      }
      // Airside rows are unchanged: no provider was asked, so nothing is written.
      for (const r of t.layover_recommendations.filter((x) => x.inside_airport)) {
        assert.ok(!("travel_time_source" in r), `"${r.title}" wrote a column it did not need`);
      }
      // And the round trip agrees with itself: read back, it is still measured.
      const back = cards(await getRecommendations(makeLayoverDb(t), "session-1"));
      const measured = back.filter((r) => r.travelTimeSource === "measured");
      assert.equal(measured.length, written.length);
      assert.ok(recs.some((r) => r.travelTimeSource === "measured"),
        "the generate response and the persisted read disagree about the same card");
    });
  }

  it("the module default is what production gets — no provider, no column", async () => {
    const t = tables();
    cards(await generateRecommendations(makeLayoverDb(t), AIRPORT, session(), Date.now(),
      { stableIds: true, travelTimeProvider: undefined }));
    for (const r of t.layover_recommendations) assert.ok(!("travel_time_source" in r));
  });
});

// ── 3. The migration ─────────────────────────────────────────────────────────

describe("migration 2745 — additive, idempotent, nullable, no backfill", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  // The header quotes the rollback verbatim, so every "what this must not do"
  // check runs against EXECUTABLE SQL only — `--` lines are prose.
  const code = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

  it("adds the column idempotently and nothing else to the table", () => {
    assert.match(code, /ADD COLUMN IF NOT EXISTS travel_time_source TEXT/);
    assert.equal(/DROP\s+COLUMN/i.test(code), false, "a forward-only migration dropped a column");
    assert.equal(/SET\s+NOT\s+NULL/i.test(code), false, "the column must stay nullable — NULL is 'we do not know'");
    assert.equal(/ALTER\s+COLUMN\s+travel_time_source\s+SET\s+DEFAULT/i.test(code), false,
      "a default would be a settled claim on every row nobody wrote");
  });

  it("writes no row — no backfill, no flag flip, no runtime effect", () => {
    assert.equal(/\bUPDATE\s+public\.layover_recommendations\b/i.test(code), false, "the migration backfills");
    assert.equal(/\bDELETE\s+FROM\b/i.test(code), false, "the migration deletes rows");
    assert.equal(/\bINSERT\s+INTO\s+public\.feature_flags\b/i.test(code), false, "the migration flips a flag");
  });

  it("the CHECK admits every provenance the read path can return, and nothing else", () => {
    for (const v of ["measured", "traveller_stated", "straight_line_bound", "unknown_provenance", "unmeasured", "inside_airport", "category_default"]) {
      assert.ok(sql.includes(`'${v}'`), `the CHECK does not admit '${v}'`);
    }
    assert.match(sql, /travel_time_source IS NULL OR travel_time_source IN/);
  });

  it("has a precondition and postconditions that would catch a partial apply", () => {
    assert.match(sql, /PRECONDITION FAILED \(2745\)/);
    const posts = sql.match(/POSTCONDITION FAILED \(2745\)/g) ?? [];
    assert.ok(posts.length >= 5, `expected several postconditions, found ${posts.length}`);
    assert.match(sql, /is_nullable/);
    assert.match(sql, /column_default/);
    assert.match(sql, /REVERSIBLE BY/);
    assert.match(sql, /BEGIN;[\s\S]*COMMIT;/);
  });
});
