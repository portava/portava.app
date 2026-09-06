/**
 * layoverProductionPath.test.ts
 *
 * Certifies the path a REAL layover request takes, end to end:
 *
 *   session -> candidates -> travel-time feasibility -> entry eligibility
 *           -> adviseLeaving / overall safety
 *
 * WHY A SEPARATE SUITE FROM airport.test.ts. That suite hands `assess` and
 * `rankActivities` candidate objects it built itself, with travel times it chose
 * — so it proves the arithmetic is right about numbers a test author supplied,
 * and can say nothing about where those numbers come from in production. That is
 * how a distance-blind constant survived: every test fed it a plausible value.
 *
 * Everything here starts from the production producers instead:
 * `generateRecommendations` builds the candidates, `resolveEntryEligibility`
 * resolves the border, and the assertions are about what a traveller would
 * actually be told.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE TWO FICTIONS THIS PINS SHUT
 * ══════════════════════════════════════════════════════════════════════════════
 * 1. TRAVEL TIME. `estimateTravelTime(placeType)` returned 15 minutes for a
 *    cafe and 25 for anything else. It never read a coordinate — the candidate
 *    query does not even SELECT lat/lng and matches its city with `ilike %city%`
 *    — and the safety engine doubled it into a round trip and turned it straight
 *    into "safe". A place across the airport road and a place across the city
 *    scored identically. There is no routing provider in this repo to replace it
 *    with, so the honest value is UNKNOWN and the honest verdict is a refusal.
 *
 * 2. ENTRY. `adviseLeaving` returned `verdict: "yes"` while listing "Visa or
 *    transit-permit requirements for your nationality" in `unknowns`, and
 *    nothing under src/routes/airport.ts or src/services/airport/ ever read
 *    `entry_requirements` or `traveler_passports` — both of which have existed
 *    since migration 0169. A caveat is not a gate.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { generateRecommendations } from "../services/airport/LayoverRecommendationService.js";
import {
  assess,
  rankActivities,
  adviseLeaving,
  computeWindow,
  assessWindowOnly,
  type ActivityCandidate,
} from "../services/airport/LayoverSafetyEngine.js";
import {
  resolveEntryEligibility,
  evaluateEntryStatus,
  ENTRY_STATUS_POLICY,
} from "../lib/layoverEntryEligibility.js";
import { ENTRY_FLAG } from "../lib/entryRequirements.js";

const USER = "11111111-2222-4333-8444-555555555555";
const NOW = Date.parse("2026-03-10T02:00:00.000Z");

const airport: any = {
  id: "ap-1", iataCode: "TPE", name: "Taoyuan", city: "Taoyuan",
  country: "Taiwan", countryCode: "TW", timezone: "Asia/Taipei",
  lat: 25.077, lng: 121.233,
  domesticBufferMin: 60, internationalBufferMin: 120, immigrationExtraMin: 30,
  checkedBagsExtraMin: 15, trafficExtraMin: 20, verified: true,
};

/** A long, roomy layover — the case the old code called "safe". */
const session: any = {
  id: "sess-1", userId: USER, airportId: "ap-1", tripId: null,
  arrivalTime: "2026-03-10T01:00:00.000Z",
  departureTime: "2026-03-10T13:00:00.000Z",
  boardingTime: null, flightType: "international", immigrationRequired: false,
  checkedBags: false, loungeAccess: false, wantsToLeave: true,
  comfortLevel: "moderate", vibeChips: [], manualAirportName: null,
  manualCity: "Taoyuan", manualCountry: "Taiwan", manualIata: "TPE",
  canonicalCityId: null, shareCityStatus: false, returnReminderAt: null,
  layoverMinutes: 720, status: "active", createdAt: "", updatedAt: "",
};

/**
 * A PostgREST-shaped double. Only the operators these readers issue are
 * implemented; anything else is absent rather than permissive, so a filter the
 * production code stops issuing surfaces as a crash rather than a quiet pass.
 */
function makeDb(cfg: {
  discoveryPlaces?: any[];
  passports?: any[];
  entryRows?: any[];
  flags?: Record<string, boolean>;
  errorTable?: string;
} = {}) {
  const inserted: Record<string, any[]> = {};
  function from(table: string) {
    const eqs: [string, any][] = [];
    let op: "select" | "insert" | "delete" = "select";
    let payload: any = null;
    const src = (): any[] =>
      (({
        discovery_places: cfg.discoveryPlaces ?? [],
        traveler_passports: cfg.passports ?? [],
        entry_requirements: cfg.entryRows ?? [],
      } as any)[table] ?? []);
    const run = () => {
      if (table === "feature_flags") {
        const f = eqs.find(([c]) => c === "flag")?.[1];
        return { data: { enabled: Boolean((cfg.flags ?? {})[f]) }, error: null };
      }
      if (cfg.errorTable === table) return { data: null, error: { message: "boom" } };
      if (op === "insert") {
        (inserted[table] ??= []).push(...(Array.isArray(payload) ? payload : [payload]));
        return { data: null, error: null };
      }
      if (op === "delete") return { data: null, error: null };
      return { data: src().filter((r) => eqs.every(([c, v]) => r[c] === v)), error: null };
    };
    const b: any = {
      select: () => b,
      insert: (p: any) => { op = "insert"; payload = p; return Promise.resolve(run()); },
      delete: () => { op = "delete"; return b; },
      eq: (c: string, v: any) => { eqs.push([c, v]); return b; },
      ilike: () => b,
      limit: () => b,
      order: () => b,
      maybeSingle: () => {
        const r = run();
        if (r.error) return Promise.resolve({ data: null, error: r.error });
        // feature_flags answers with a single object; table reads answer with a
        // list. Collapsing both through `[0]` silently nulled every flag.
        const d: any = r.data;
        return Promise.resolve({ data: Array.isArray(d) ? (d[0] ?? null) : (d ?? null), error: null });
      },
      then: (res: any) => Promise.resolve(run()).then(res),
    };
    return b;
  }
  return { from, _inserted: inserted };
}

const ENTRY_ON = { [ENTRY_FLAG]: true };

// ══ 1. TRAVEL TIME CANNOT BE A CATEGORY CONSTANT ══════════════════════════════

describe("Layover production path — travel time", () => {
  it("a landside candidate built by the REAL producer carries no travel time", async () => {
    const db = makeDb({
      discoveryPlaces: [
        { id: "p-cafe", name: "Corner Cafe", place_type: "cafe", category: null,
          neighborhood: "Zhongshan", blurb: null, verified: true, city: "Taoyuan", status: "active" },
      ],
    });
    const recs = await generateRecommendations(db as any, airport, session, NOW);
    const landside = (db._inserted["layover_recommendations"] ?? []).filter((r: any) => !r.inside_airport);
    assert.ok(landside.length > 0, "precondition: the producer emitted a landside candidate");

    for (const row of landside) {
      assert.equal(row.travel_time_min, null,
        "a landside journey nobody measured must be stored as NULL. The old code " +
        "wrote 15 for a cafe and 25 for anything else, from place_type alone.");
    }
    assert.ok(recs.length >= 0);
  });

  it("a cafe and a museum across the city are NOT distinguishable by a category constant", async () => {
    // The old estimateTravelTime gave these 15 and 25 minutes respectively —
    // numbers derived from the word "cafe", not from where either place is.
    const db = makeDb({
      discoveryPlaces: [
        { id: "p1", name: "Cafe", place_type: "cafe", neighborhood: null, blurb: null, verified: true, city: "Taoyuan", status: "active", category: null },
        { id: "p2", name: "Museum", place_type: "museum", neighborhood: null, blurb: null, verified: true, city: "Taoyuan", status: "active", category: null },
      ],
    });
    await generateRecommendations(db as any, airport, session, NOW);
    const times = (db._inserted["layover_recommendations"] ?? [])
      .filter((r: any) => !r.inside_airport).map((r: any) => r.travel_time_min);
    assert.ok(times.length >= 2);
    assert.deepEqual([...new Set(times)], [null],
      "neither place has a measured journey, so neither may carry a number");
  });

  it("an unmeasured landside candidate is never rated safe or merely risky", () => {
    const candidate: ActivityCandidate = {
      title: "Somewhere in the city", travelTimeMin: null,
      activityTimeMin: 60, insideAirport: false, verified: true,
    };
    const a = assess(airport, session, candidate, NOW);
    assert.equal(a.rating, "not_recommended");
    assert.equal(a.travelTimeUnknown, true);
    assert.equal(a.requiredMinutes, null,
      "there is no total to state when half of it is unknown");
    assert.match(a.warningReason ?? "", /can't work out how long/i,
      "and the reason must name the real cause, not blame the clock");
  });

  it("a twelve-hour layover does not rescue an unmeasured journey", () => {
    // The window is enormous; the old code would have said "safe" because
    // 25×2 + 60 fits inside it comfortably. Time is not the missing input.
    const roomy = { ...session, departureTime: "2026-03-11T01:00:00.000Z", layoverMinutes: 1440 };
    const a = assess(airport, roomy, {
      title: "Anywhere", travelTimeMin: null, activityTimeMin: 60,
      insideAirport: false, verified: true,
    }, NOW);
    assert.equal(a.rating, "not_recommended");
  });

  it("inside the terminal, zero travel is a FACT and stays ratable", () => {
    const a = assess(airport, session, {
      title: "Lounge", travelTimeMin: 0, activityTimeMin: 45, insideAirport: true, verified: true,
    }, NOW);
    assert.equal(a.travelTimeUnknown, false);
    assert.equal(a.rating, "safe",
      "the fix must not collapse the airside experience — there is genuinely no journey");
    assert.equal(typeof a.requiredMinutes, "number");
  });

  it("ranking puts an unmeasured candidate last, not first", () => {
    // `null` through arithmetic coerces to 0, which would have sorted the
    // least-known option ahead of a measured 5-minute one.
    const ranked = rankActivities(airport, session, [
      { title: "Unknown", travelTimeMin: null, activityTimeMin: 30, insideAirport: false, verified: true },
      { title: "Lounge", travelTimeMin: 0, activityTimeMin: 30, insideAirport: true, verified: true },
    ], NOW);
    assert.equal(ranked[0].title, "Lounge");
    assert.equal(ranked[ranked.length - 1].title, "Unknown");
  });

  it("the overall session rating claims nothing about any journey", () => {
    const w = computeWindow(airport, session, NOW);
    const a = assessWindowOnly(airport, session, w);
    assert.equal(a.requiredMinutes, null,
      "the old endpoint invented a 20-minute/30-minute candidate here and " +
      "presented the score as this session's overall safety");
    assert.equal(a.usableMinutes, w.usableMinutes);
  });
});

// ══ 2. ENTRY ELIGIBILITY IS A GATE, NOT A CAVEAT ══════════════════════════════

describe("Layover production path — entry eligibility", () => {
  // `user_id` matters: resolveEntryEligibility filters on it, and a fixture
  // without it is dropped by the real query exactly as a stranger's row would be.
  const passport = [{ user_id: USER, issuing_country: "GB", is_primary: true, created_at: "2026-01-01" }];
  const corridor = (status: string) => [{
    passport_country: "GB", destination_country: "TW", status,
    official_source_url: "https://example.gov/tw", last_verified_at: "2026-01-01T00:00:00.000Z",
  }];

  it("resolves a curated visa-free corridor from the REAL sources", async () => {
    const db = makeDb({ flags: ENTRY_ON, passports: passport, entryRows: corridor("visa_free") });
    const e = await resolveEntryEligibility(db as any, { userId: USER, airportCountryCode: "TW" });
    assert.equal(e.state, "permitted");
    if (e.state === "permitted") {
      assert.equal(e.passportCountry, "GB");
      assert.equal(e.destinationCountry, "TW");
      assert.equal(e.officialSourceUrl, "https://example.gov/tw");
    }
  });

  it("every non-affirmative cause is DISTINCT — they need different things from the user", async () => {
    const cases: Array<[any, string]> = [
      [{ flags: { [ENTRY_FLAG]: false } }, "entry_intelligence_disabled"],
      [{ flags: ENTRY_ON, passports: [] }, "no_passport_on_file"],
      [{ flags: ENTRY_ON, passports: passport, entryRows: [] }, "no_data_for_corridor"],
      [{ flags: ENTRY_ON, errorTable: "traveler_passports" }, "lookup_failed"],
    ];
    for (const [cfg, expected] of cases) {
      const e = await resolveEntryEligibility(makeDb(cfg) as any, { userId: USER, airportCountryCode: "TW" });
      assert.equal(e.state, "unresolved");
      if (e.state === "unresolved") assert.equal(e.reason, expected);
    }
    // An airport with no country cannot anchor a corridor, and the city name is
    // never used to guess one.
    const noCountry = await resolveEntryEligibility(
      makeDb({ flags: ENTRY_ON, passports: passport }) as any,
      { userId: USER, airportCountryCode: null },
    );
    assert.equal(noCountry.state, "unresolved");
    if (noCountry.state === "unresolved") assert.equal(noCountry.reason, "airport_country_unknown");
  });

  it("an unreadable entry lookup is never an approval", async () => {
    const e = await resolveEntryEligibility(
      makeDb({ flags: ENTRY_ON, passports: passport, errorTable: "entry_requirements" }) as any,
      { userId: USER, airportCountryCode: "TW" },
    );
    assert.notEqual(e.state, "permitted");
  });

  it("statuses needing prior arrangement do not clear a spontaneous exit", async () => {
    for (const status of ["evisa", "visa_required", "special_authorization", "entry_restricted"]) {
      const db = makeDb({ flags: ENTRY_ON, passports: passport, entryRows: corridor(status) });
      const e = await resolveEntryEligibility(db as any, { userId: USER, airportCountryCode: "TW" });
      assert.equal(e.state, "not_permitted", `${status} must not permit an unplanned exit`);
    }
    for (const status of ["visa_free", "visa_on_arrival"]) {
      const db = makeDb({ flags: ENTRY_ON, passports: passport, entryRows: corridor(status) });
      const e = await resolveEntryEligibility(db as any, { userId: USER, airportCountryCode: "TW" });
      assert.equal(e.state, "permitted", `${status} is obtainable without prior arrangement`);
    }
  });

  it("visa-on-arrival is permitted WITH its cost surfaced, never silently", async () => {
    const db = makeDb({ flags: ENTRY_ON, passports: passport, entryRows: corridor("visa_on_arrival") });
    const e = await resolveEntryEligibility(db as any, { userId: USER, airportCountryCode: "TW" });
    assert.equal(e.state, "permitted");
    if (e.state === "permitted") {
      assert.match(e.condition ?? "", /queue time|fee/i,
        "a border process that eats the layover window must be stated");
    }
  });

  it("a status nobody taught this policy about fails CLOSED", () => {
    const v = evaluateEntryStatus("some_new_status_added_later");
    assert.equal(v.permitted, false);
    // And the policy is data, so the mapping is reviewable in one place.
    assert.equal(ENTRY_STATUS_POLICY["visa_free"].permitted, true);
    assert.equal(ENTRY_STATUS_POLICY["visa_required"].permitted, false);
  });

  it("PRODUCTION REALITY: entry_requirements has no seeded rows, so nobody is affirmed today", async () => {
    // No migration in this repo INSERTs into entry_requirements — 0169 calls
    // that its "HONESTY CONTRACT". So the live corridor lookup returns nothing,
    // and the correct consequence is that adviseLeaving cannot say yes.
    const db = makeDb({ flags: ENTRY_ON, passports: passport, entryRows: [] });
    const entry = await resolveEntryEligibility(db as any, { userId: USER, airportCountryCode: "TW" });
    const w = computeWindow(airport, session, NOW);
    const advice = adviseLeaving(airport, session, w, entry);
    assert.ok(w.usableMinutes >= 90, "precondition: the clock alone would have said yes");
    assert.equal(advice.verdict, "entry_unverified");
    assert.notEqual(advice.verdict, "yes");
  });
});

// ══ 3. HAND-BUILT CANDIDATES CANNOT BYPASS THE PRODUCTION CHECK ═══════════════

describe("Layover production path — no bypass", () => {
  it("a candidate asserting a travel time it did not measure is still just a number to assess", () => {
    // assess() cannot tell a measured 20 from an invented 20 — which is exactly
    // why the invention had to be removed at the SOURCE rather than guarded
    // here. This test records that boundary honestly instead of pretending the
    // engine validates provenance.
    const a = assess(airport, session, {
      title: "Hand-built", travelTimeMin: 20, activityTimeMin: 30, insideAirport: false, verified: true,
    }, NOW);
    assert.equal(a.travelTimeUnknown, false);

    // The real protection is that no production producer can supply one: every
    // landside row the producer writes is NULL, proven above. The guard below
    // pins that the module no longer contains a category-to-minutes table.
  });

  it("the category-constant estimator is GONE from the production producer", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../services/airport/LayoverRecommendationService.ts", import.meta.url), "utf8"));
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*"))
      .join("\n");
    assert.ok(!/function\s+estimateTravelTime/.test(code),
      "estimateTravelTime must not be reintroduced — a category-to-minutes table " +
      "is not a travel-time provider, however plausible its numbers look");
    // `travelTimeMin: 0` stays legal — that is the inside-terminal case, where
    // zero is a fact rather than an estimate. Any NON-zero literal is an
    // invented journey.
    assert.ok(!/travelTimeMin:\s*[1-9]/.test(code),
      "no landside candidate may be born with a literal travel time");
  });
});
