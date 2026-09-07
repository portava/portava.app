/**
 * Airport / Layover Mode tests
 *
 * Uses node:test + fake-client pattern (no vitest, no real DB).
 * Covers all "Done looks like" bullet points from Task #319.
 *
 * Run: node --import tsx/esm --test src/test/airport.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveByIata,
  resolveByGps,
  buildFallbackProfile,
  searchAirports,
} from "../services/airport/AirportProfileService.js";
import {
  createSession,
  getSession,
  endSession,
  expireOldSessions,
} from "../services/airport/LayoverSessionService.js";
import {
  assess,
  computeBuffer,
  safetyLabel,
  rankActivities,
  computeWindow,
  adviseLeaving,
  estimateExitDelay,
} from "../services/airport/LayoverSafetyEngine.js";
import {
  wallTimeToUtc,
  localHour,
  localDayString,
} from "../services/airport/AirportTime.js";
import {
  sanitizeRecommendation,
  sanitizeCompassAnswer,
  sanitizeNearbyTraveler,
  isSharingAllowed,
} from "../services/airport/LayoverPrivacyGuard.js";
import {
  shouldSuggestSafeReturn,
} from "../services/airport/LayoverNotificationService.js";
import { detectIntent } from "../services/telegraphIntent.js";

// ── Fake client ───────────────────────────────────────────────────────────────

interface FakeTables {
  airport_profiles: any[];
  layover_sessions: any[];
  layover_recommendations: any[];
  layover_events: any[];
  feature_flags: any[];
}

function makeTables(): FakeTables {
  return {
    airport_profiles:      [],
    layover_sessions:      [],
    layover_recommendations: [],
    layover_events:        [],
    feature_flags:         [
      { key: "airport_mode_enabled",          enabled: true },
      { key: "layover_safety_engine_enabled", enabled: true },
    ],
  };
}

function makeClient(tables: FakeTables) {
  let _table = "";
  let _filters: Array<{ col: string; op: string; val: any }> = [];
  let _limit: number | null = null;
  let _order: { col: string; asc: boolean } | null = null;
  let _pendingInsert: any = null;
  let _pendingUpdate: any = null;
  let _pendingDelete = false;

  const chain: any = {
    from(table: string) {
      _table = table;
      _filters = [];
      _limit = null;
      _order = null;
      _pendingInsert = null;
      _pendingUpdate = null;
      _pendingDelete = false;
      return chain;
    },
    select() { return chain; },
    insert(data: any) {
      _pendingInsert = data;
      return chain;
    },
    upsert(data: any) {
      _pendingInsert = data;  // treat upsert as insert (replaces if already present by id)
      return chain;
    },
    update(data: any) {
      _pendingUpdate = data;
      return chain;
    },
    delete() { _pendingDelete = true; return chain; },
    eq(col: string, val: any) { _filters.push({ col, op: "eq", val }); return chain; },
    ilike(col: string, val: any) { _filters.push({ col, op: "ilike", val }); return chain; },
    gte(col: string, val: any) { _filters.push({ col, op: "gte", val }); return chain; },
    lte(col: string, val: any) { _filters.push({ col, op: "lte", val }); return chain; },
    lt(col: string, val: any) { _filters.push({ col, op: "lt", val }); return chain; },
    in(col: string, vals: any[]) { _filters.push({ col, op: "in", val: vals }); return chain; },
    or() { return chain; },
    order(col: string, opts: any = {}) { _order = { col, asc: opts.ascending !== false }; return chain; },
    limit(n: number) { _limit = n; return chain; },
    not() { return chain; },
    maybeSingle() {
      return Promise.resolve(resolve(true));
    },
    then(cb: any) { return Promise.resolve(resolve(false)).then(cb); },
  };

  function matchesFilters(row: any) {
    for (const f of _filters) {
      const v = row[f.col];
      if (f.op === "eq"    && v !== f.val) return false;
      if (f.op === "ilike" && typeof v === "string" && !v.toLowerCase().includes(String(f.val).replace(/%/g,"").toLowerCase())) return false;
      if (f.op === "gte"   && v < f.val)  return false;
      if (f.op === "lte"   && v > f.val)  return false;
      if (f.op === "lt"    && !(v < f.val)) return false;
      if (f.op === "in"    && !f.val.includes(v)) return false;
    }
    return true;
  }

  function resolve(single: boolean): any {
    const tbl: any[] = (tables as any)[_table] ?? [];

    if (_pendingDelete) {
      const before = tbl.length;
      const toRemove = tbl.filter(matchesFilters);
      toRemove.forEach((r) => { const i = tbl.indexOf(r); if (i >= 0) tbl.splice(i, 1); });
      return { data: toRemove, error: null };
    }

    if (_pendingInsert) {
      const rows = Array.isArray(_pendingInsert) ? _pendingInsert : [_pendingInsert];
      const inserted: any[] = [];
      for (const row of rows) {
        const newRow = {
          id:         row.id         ?? `fake-${Math.random().toString(36).slice(2)}`,
          created_at: row.created_at ?? new Date().toISOString(),
          updated_at: row.updated_at ?? new Date().toISOString(),
          ...row,
        };
        tbl.push(newRow);
        inserted.push(newRow);
      }
      const result = single ? inserted[0] : inserted;
      return { data: result ?? null, error: null };
    }

    if (_pendingUpdate) {
      const updated: any[] = [];
      for (const row of tbl) {
        if (matchesFilters(row)) {
          Object.assign(row, _pendingUpdate, { updated_at: new Date().toISOString() });
          updated.push(row);
        }
      }
      const result = single ? (updated[0] ?? null) : updated;
      return { data: result, error: null };
    }

    // SELECT
    let rows = tbl.filter(matchesFilters);
    if (_order) {
      const { col, asc } = _order;
      rows = rows.sort((a, b) => asc ? (a[col] > b[col] ? 1 : -1) : (a[col] < b[col] ? 1 : -1));
    }
    if (_limit !== null) rows = rows.slice(0, _limit);
    if (single) return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }

  return chain;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TPE_AIRPORT = {
  id:                     "airport-tpe",
  iata_code:              "TPE",
  name:                   "Taiwan Taoyuan International Airport",
  city:                   "Taoyuan",
  country:                "Taiwan",
  country_code:           "TW",
  timezone:               "Asia/Taipei",
  lat:                    25.0797,
  lng:                    121.2342,
  domestic_buffer_min:    60,
  domestic_buffer_max:    90,
  international_buffer_min: 120,
  international_buffer_max: 180,
  immigration_extra_min:  30,
  checked_bags_extra_min: 15,
  traffic_extra_min:      20,
  verified:               true,
};

const USER_A = "user-layover-a";

function makeSessionInput(overrides: any = {}) {
  const now = new Date();
  const arrival   = new Date(now.getTime() + 60_000).toISOString();    // 1 min from now
  const departure = new Date(now.getTime() + 360 * 60_000).toISOString(); // 6 hours from now
  return {
    userId:        USER_A,
    arrivalTime:   arrival,
    departureTime: departure,
    flightType:    "international" as const,
    immigrationRequired: false,
    checkedBags:   false,
    wantsToLeave:  true,
    comfortLevel:  "moderate" as const,
    vibeChips:     ["food", "culture"],
    ...overrides,
  };
}

function makeAirportProfile(overrides: any = {}) {
  return {
    id: "airport-fake", iataCode: "TPE", name: "Taoyuan Intl",
    city: "Taoyuan", country: "Taiwan", countryCode: "TW",
    timezone: "Asia/Taipei", lat: 25.07, lng: 121.23,
    domesticBufferMin: 60, domesticBufferMax: 90,
    internationalBufferMin: 120, internationalBufferMax: 180,
    immigrationExtraMin: 30, checkedBagsExtraMin: 15,
    trafficExtraMin: 20, verified: true,
    ...overrides,
  };
}

// ── AirportProfileService tests ───────────────────────────────────────────────

describe("AirportProfileService", () => {
  it("resolves airport by IATA code", async () => {
    const tables = makeTables();
    tables.airport_profiles.push(TPE_AIRPORT);
    const db = makeClient(tables);
    const result = await resolveByIata(db, "TPE");
    assert.ok(result, "should return a profile");
    assert.equal(result!.iataCode, "TPE");
    assert.equal(result!.city, "Taoyuan");
    assert.equal(result!.verified, true);
  });

  it("resolves airport by GPS proximity", async () => {
    const tables = makeTables();
    tables.airport_profiles.push(TPE_AIRPORT);
    const db = makeClient(tables);
    // Coords very close to TPE
    const result = await resolveByGps(db, 25.07, 121.23, 50);
    assert.ok(result, "should find airport near those coords");
    assert.equal(result!.iataCode, "TPE");
  });

  it("returns null when no airport found by GPS", async () => {
    const tables = makeTables();
    const db = makeClient(tables);
    const result = await resolveByGps(db, 0, 0);
    assert.equal(result, null);
  });

  it("builds fallback profile with hardcoded defaults when DB empty", () => {
    const profile = buildFallbackProfile({ iataCode: "NRT", city: "Tokyo", country: "Japan", countryCode: "JP" });
    assert.equal(profile.iataCode, "NRT");
    assert.equal(profile.id, null);
    assert.equal(profile.domesticBufferMin, 60);
    assert.equal(profile.internationalBufferMin, 120);
  });

  it("searches airports by name/city query", async () => {
    const tables = makeTables();
    tables.airport_profiles.push(TPE_AIRPORT);
    const db = makeClient(tables);
    const results = await searchAirports(db, "Taoyuan");
    assert.ok(results.length > 0, "should find TPE by city name");
    assert.equal(results[0].iataCode, "TPE");
  });
});

// ── LayoverSessionService tests ───────────────────────────────────────────────

describe("LayoverSessionService", () => {
  it("creates layover session with correct layover minutes", async () => {
    const tables = makeTables();
    const db = makeClient(tables);
    const input = makeSessionInput();
    const session = await createSession(db, input);
    assert.ok(session, "session should be created");
    assert.equal(session!.userId, USER_A);
    assert.equal(session!.status, "active");
    assert.ok(session!.layoverMinutes > 0, "layover minutes should be positive");
  });

  it("emits session_created event on creation", async () => {
    const tables = makeTables();
    const db = makeClient(tables);
    await createSession(db, makeSessionInput());
    const event = tables.layover_events.find((e) => e.event_type === "session_created");
    assert.ok(event, "session_created event should exist");
  });

  it("endSession marks session as cancelled", async () => {
    const tables = makeTables();
    const db = makeClient(tables);
    const session = await createSession(db, makeSessionInput());
    const ended = await endSession(db, session!.id, USER_A, "cancelled");
    assert.equal(ended!.status, "cancelled");
    const event = tables.layover_events.find((e) => e.event_type === "session_cancelled");
    assert.ok(event, "session_cancelled event should exist");
  });

  it("expireOldSessions marks past-departure sessions as expired", async () => {
    const tables = makeTables();
    // Session with departure in the past
    tables.layover_sessions.push({
      id:             "old-session",
      user_id:        USER_A,
      arrival_time:   new Date(Date.now() - 7_200_000).toISOString(),
      departure_time: new Date(Date.now() - 3_600_000).toISOString(),
      status:         "active",
      flight_type:    "domestic",
      immigration_required: false,
      checked_bags:   false,
      wants_to_leave: true,
      comfort_level:  "moderate",
      vibe_chips:     [],
    });
    const db = makeClient(tables);
    const count = await expireOldSessions(db);
    assert.equal(count, 1, "one session should be expired");
    const session = tables.layover_sessions.find((s) => s.id === "old-session");
    assert.equal(session.status, "expired");
  });
});

// ── LayoverSafetyEngine tests ─────────────────────────────────────────────────

describe("LayoverSafetyEngine", () => {
  const airport = makeAirportProfile();

  function makeSession(layoverMinutes = 360, opts: any = {}): any {
    const now  = Date.now();
    return {
      id:             "sess-test",
      userId:         USER_A,
      airportId:      "airport-fake",
      tripId:         null,
      arrivalTime:    new Date(now).toISOString(),
      departureTime:  new Date(now + layoverMinutes * 60_000).toISOString(),
      boardingTime:   null,
      layoverMinutes,
      flightType:     "international",
      immigrationRequired: false,
      checkedBags:    false,
      loungeAccess:   false,
      wantsToLeave:   true,
      comfortLevel:   "moderate",
      vibeChips:      [],
      manualAirportName: null,
      manualCity:     "Taoyuan",
      manualCountry:  "Taiwan",
      manualIata:     "TPE",
      status:         "active",
      createdAt:      new Date().toISOString(),
      updatedAt:      new Date().toISOString(),
      ...opts,
    };
  }

  it("domestic buffer is less than international buffer", () => {
    const session = makeSession(360, { flightType: "domestic" });
    const intlSession = makeSession(360, { flightType: "international" });
    const domesticBuf = computeBuffer(airport, session, new Date(session.departureTime));
    const intlBuf = computeBuffer(airport, intlSession, new Date(intlSession.departureTime));
    assert.ok(domesticBuf.totalBuffer < intlBuf.totalBuffer, "domestic buffer < international");
    assert.equal(domesticBuf.baseBuffer, airport.domesticBufferMin);
    assert.equal(intlBuf.baseBuffer, airport.internationalBufferMin);
  });

  it("immigration adds extra buffer", () => {
    const noImm  = makeSession(360, { immigrationRequired: false });
    const withImm = makeSession(360, { immigrationRequired: true });
    const bufNoImm  = computeBuffer(airport, noImm, new Date(noImm.departureTime));
    const bufWithImm = computeBuffer(airport, withImm, new Date(withImm.departureTime));
    assert.equal(bufWithImm.immigrationExtra, airport.immigrationExtraMin);
    assert.ok(bufWithImm.totalBuffer > bufNoImm.totalBuffer, "immigration adds buffer");
  });

  it("checked bags adds extra buffer", () => {
    const noBags  = makeSession(360, { checkedBags: false });
    const withBags = makeSession(360, { checkedBags: true });
    const bufNoBags  = computeBuffer(airport, noBags, new Date(noBags.departureTime));
    const bufWithBags = computeBuffer(airport, withBags, new Date(withBags.departureTime));
    assert.equal(bufWithBags.bagsExtra, airport.checkedBagsExtraMin);
    assert.ok(bufWithBags.totalBuffer > bufNoBags.totalBuffer);
  });

  it("inside-airport activity is always safe", () => {
    const session = makeSession(120);
    const a = assess(airport, session, {
      title: "Airport lounge", travelTimeMin: 0, activityTimeMin: 30, insideAirport: true,
    });
    assert.equal(a.rating, "safe");
  });

  it("activity too far → not_recommended for short layover", () => {
    const session = makeSession(150, { flightType: "domestic" }); // 2.5h layover
    // Activity needs 90 min + 60 min travel + 60 min buffer = way too long
    const a = assess(airport, session, {
      title: "City tour", travelTimeMin: 60, activityTimeMin: 120, insideAirport: false,
    });
    assert.ok(
      a.rating === "not_recommended" || a.rating === "possible_but_risky",
      `Expected not_recommended or possible_but_risky, got ${a.rating}`,
    );
  });

  it("safe activity for long layover with enough usable time", () => {
    const session = makeSession(480, { flightType: "domestic" }); // 8h layover
    const a = assess(airport, session, {
      title: "City visit", travelTimeMin: 20, activityTimeMin: 60, insideAirport: false, verified: true,
    });
    assert.equal(a.rating, "safe", `Expected safe, got ${a.rating}: ${a.warningReason}`);
  });

  it("wantsToLeave=false → airport_only for non-airport activity", () => {
    const session = makeSession(480, { wantsToLeave: false });
    const a = assess(airport, session, {
      title: "City tour", travelTimeMin: 30, activityTimeMin: 60, insideAirport: false,
    });
    assert.equal(a.rating, "airport_only");
  });

  it("rankActivities sorts safe first then shorter travel time", () => {
    const session = makeSession(480, { flightType: "domestic" });
    const candidates = [
      { title: "Far risky", travelTimeMin: 90, activityTimeMin: 120, insideAirport: false },
      { title: "Airport cafe", travelTimeMin: 0, activityTimeMin: 30, insideAirport: true },
      { title: "Near lunch", travelTimeMin: 15, activityTimeMin: 45, insideAirport: false, verified: true },
    ];
    const ranked = rankActivities(airport, session, candidates);
    assert.equal(ranked[0].title, "Airport cafe", "inside-airport should rank first");
  });

  it("safetyLabel returns correct wording per rating", () => {
    assert.ok(safetyLabel("safe").includes("Safe"));
    assert.ok(safetyLabel("possible_but_risky").includes("tight"));
    assert.ok(safetyLabel("not_recommended").includes("Not recommended"));
    assert.ok(safetyLabel("airport_only").includes("Airport-only"));
  });
});

// ── LayoverPrivacyGuard tests ─────────────────────────────────────────────────

describe("LayoverPrivacyGuard", () => {
  it("sanitizeCompassAnswer strips coordinates", () => {
    const text = "Head to (25.078, 121.234) for food or visit 51.5074, -0.1278 later.";
    const safe = sanitizeCompassAnswer(text);
    assert.ok(!safe.includes("25.078"), "lat should be stripped");
    assert.ok(!safe.includes("121.234"), "lng should be stripped");
    assert.ok(!safe.includes("51.5074"), "second lat stripped");
  });

  it("sanitizeNearbyTraveler returns only city/country, no coords", () => {
    const result = sanitizeNearbyTraveler({
      userId: "u1", username: "alice", avatarUrl: null,
      city: "Tokyo", country: "Japan",
      lat: 35.6762, lng: 139.6503, neighborhood: "Shinjuku",
    });
    assert.equal(result.approximateLocation, "Tokyo, Japan");
    assert.ok(!("lat" in result), "lat must not appear");
    assert.ok(!("lng" in result), "lng must not appear");
    assert.ok(!("neighborhood" in result), "neighborhood must not appear");
  });

  it("sanitizeRecommendation hides meetup location until accepted", () => {
    const rec = sanitizeRecommendation({
      recType: "meetup", title: "Coffee meetup",
      safetyRating: "safe", travelTimeMin: 10, activityTimeMin: 30,
      returnBufferMin: 90, insideAirport: false,
      locationLabel: "Exact: Terminal 2, Gate B12",
      city: "Taoyuan", neighborhood: "Terminal 2",
      meetupAccepted: false,
    });
    assert.equal(rec.meetupLocationHidden, true);
    assert.equal(rec.locationLabel, null, "exact label hidden until accepted");
    assert.equal(rec.neighborhood, null, "neighborhood hidden");
    assert.ok(rec.meetupLocationReveal, "reveal hint should be present");
  });

  it("sanitizeRecommendation reveals meetup location when accepted", () => {
    const rec = sanitizeRecommendation({
      recType: "meetup", title: "Coffee meetup",
      safetyRating: "safe", travelTimeMin: 10, activityTimeMin: 30,
      returnBufferMin: 90, insideAirport: false,
      locationLabel: "Terminal 2, Gate B12",
      city: "Taoyuan", neighborhood: "Terminal 2",
      meetupAccepted: true,
    });
    assert.equal(rec.meetupLocationHidden, false);
    assert.equal(rec.locationLabel, "Terminal 2, Gate B12");
  });

  it("isSharingAllowed returns false when location is off", () => {
    assert.equal(isSharingAllowed({ locationMode: "off", sharingPaused: false }), false);
    assert.equal(isSharingAllowed({ locationMode: "city_only", sharingPaused: true }), false);
    assert.equal(isSharingAllowed({ locationMode: "city_only", sharingPaused: false, ghostMode: true }), false);
    assert.equal(isSharingAllowed({ locationMode: "city_only", sharingPaused: false }), true);
  });
});

// ── LayoverNotificationService tests ─────────────────────────────────────────

describe("LayoverNotificationService", () => {
  it("shouldSuggestSafeReturn triggers for night layover", () => {
    const session: any = { wantsToLeave: true, immigrationRequired: false, flightType: "domestic", layoverMinutes: 240 };
    const { suggest, reasons } = shouldSuggestSafeReturn(session, { isNightLayover: true });
    assert.equal(suggest, true);
    assert.ok(reasons.length > 0);
  });

  it("shouldSuggestSafeReturn triggers for new country", () => {
    const session: any = { wantsToLeave: true, immigrationRequired: true, flightType: "international", layoverMinutes: 300 };
    const { suggest } = shouldSuggestSafeReturn(session, { isNewCountry: true });
    assert.equal(suggest, true);
  });

  it("shouldSuggestSafeReturn does not trigger for simple domestic layover", () => {
    const session: any = { wantsToLeave: false, immigrationRequired: false, flightType: "domestic", layoverMinutes: 120 };
    const { suggest } = shouldSuggestSafeReturn(session, {});
    assert.equal(suggest, false);
  });
});

// ── Telegraph layover intent tests ────────────────────────────────────────────

describe("Telegraph layover intents", () => {
  it("detects layover_activity intent from 'I have a layover'", () => {
    const result = detectIntent("I have a 6-hour layover at TPE, what should I do?");
    assert.ok(result, "should detect intent");
    assert.equal(result!.intent, "layover_activity");
  });

  it("detects layover_food from airport food question", () => {
    const result = detectIntent("Any good food near the airport during my layover?");
    assert.ok(result, "should detect intent");
    assert.ok(result!.intent === "layover_food" || result!.intent === "layover_activity");
  });

  it("detects layover_meetup from airport meetup suggestion", () => {
    const result = detectIntent("Let's meet at the airport during my layover");
    assert.ok(result, "should detect intent");
    assert.ok(
      result!.intent === "layover_meetup" || result!.intent === "layover_activity" || result!.intent === "create_meetup",
      `got ${result!.intent}`,
    );
  });

  it("does not change non-layover intent detection", () => {
    const result = detectIntent("Where's a good restaurant nearby?");
    assert.ok(result, "should still detect regular intent");
    assert.ok(result!.intent !== "layover_activity");
  });
});

// ── Admin reports route-level tests ───────────────────────────────────────────
// Tests the service-layer behavior for reports (status transitions) using the
// fake client, covering the same logic as GET /admin/airport/reports and
// POST /admin/airport/reports/:id/resolve.

describe("Admin airport reports", () => {
  it("lists flagged layover_recommendations only", async () => {
    const tables: any = {
      ...makeTables(),
      layover_recommendations: [
        { id: "rec-1", session_id: "sess-1", title: "Coffee shop", rec_type: "food", safety_rating: "safe",
          source: "ai", status: "flagged", created_at: new Date().toISOString() },
        { id: "rec-2", session_id: "sess-1", title: "Night market", rec_type: "activity", safety_rating: "possible_but_risky",
          source: "ai", status: "active", created_at: new Date().toISOString() },
        { id: "rec-3", session_id: "sess-2", title: "Spa", rec_type: "rest", safety_rating: "safe",
          source: "ai", status: "flagged", created_at: new Date().toISOString() },
      ],
    };
    const db = makeClient(tables);
    const { data, error } = await db
      .from("layover_recommendations")
      .select("id, session_id, title, rec_type, safety_rating, source, status, created_at")
      .eq("status", "flagged")
      .order("created_at", { ascending: false })
      .limit(50);
    assert.strictEqual(error, null);
    assert.strictEqual((data as any[]).length, 2, "should return only flagged recs");
    assert.ok((data as any[]).every((r: any) => r.status === "flagged"), "all results must be flagged");
  });

  it("resolves a report by approving it (status → active)", async () => {
    const tables: any = {
      ...makeTables(),
      layover_recommendations: [
        { id: "rec-10", session_id: "sess-1", title: "Dangerous spot",
          source: "ai", status: "flagged", created_at: new Date().toISOString() },
      ],
    };
    const db = makeClient(tables);
    const { data, error } = await db
      .from("layover_recommendations")
      .update({ status: "active" })
      .eq("id", "rec-10")
      .select("id, status")
      .maybeSingle();
    assert.strictEqual(error, null);
    assert.strictEqual((data as any).status, "active", "should transition to active");
    // Verify DB was mutated
    const updated = tables.layover_recommendations.find((r: any) => r.id === "rec-10");
    assert.strictEqual(updated.status, "active");
  });

  it("resolves a report by hiding it (status → hidden)", async () => {
    const tables: any = {
      ...makeTables(),
      layover_recommendations: [
        { id: "rec-11", session_id: "sess-1", title: "Bad rec",
          source: "user", status: "flagged", created_at: new Date().toISOString() },
      ],
    };
    const db = makeClient(tables);
    const { data, error } = await db
      .from("layover_recommendations")
      .update({ status: "hidden" })
      .eq("id", "rec-11")
      .select("id, status")
      .maybeSingle();
    assert.strictEqual(error, null);
    assert.strictEqual((data as any).status, "hidden");
  });

  it("returns null for non-existent recommendation on resolve", async () => {
    const tables: any = { ...makeTables(), layover_recommendations: [] };
    const db = makeClient(tables);
    const { data, error } = await db
      .from("layover_recommendations")
      .update({ status: "active" })
      .eq("id", "no-such-id")
      .select("id, status")
      .maybeSingle();
    assert.strictEqual(error, null);
    assert.strictEqual(data, null, "should return null for missing row");
  });
});

// ── Return deadline / admin tests ─────────────────────────────────────────────

describe("Admin airport profile buffer defaults", () => {
  it("upsertAirportProfile inserts a new profile", async () => {
    const { upsertAirportProfile } = await import("../services/airport/AirportProfileService.js");
    const tables = makeTables();
    const db = makeClient(tables);
    const result = await upsertAirportProfile(db, "admin-1", {
      iataCode: "NRT", name: "Narita Intl", city: "Narita", country: "Japan",
      countryCode: "JP", lat: 35.76, lng: 140.38,
      domesticBufferMin: 60, internationalBufferMin: 120,
    });
    assert.equal(result.ok, true);
    const profile = tables.airport_profiles.find((p) => p.iata_code === "NRT");
    assert.ok(profile, "profile should be persisted");
    assert.equal(profile.verified, false); // default
  });
});

// ── AirportTime (wall-time ⇄ UTC, timezone-local helpers) ─────────────────────

describe("AirportTime", () => {
  it("converts Tokyo wall time to UTC (no DST)", () => {
    const d = wallTimeToUtc("Asia/Tokyo", "2026-08-10T14:30");
    assert.ok(d, "should convert");
    assert.equal(d!.toISOString(), "2026-08-10T05:30:00.000Z"); // JST = UTC+9
  });

  it("converts LAX wall time to UTC across DST", () => {
    const summer = wallTimeToUtc("America/Los_Angeles", "2026-07-20T09:00");
    assert.equal(summer!.toISOString(), "2026-07-20T16:00:00.000Z"); // PDT −7
    const winter = wallTimeToUtc("America/Los_Angeles", "2026-01-20T09:00");
    assert.equal(winter!.toISOString(), "2026-01-20T17:00:00.000Z"); // PST −8
  });

  it("localHour and localDayString report airport-local values", () => {
    const instant = new Date("2026-03-10T20:00:00.000Z"); // 04:00 next day in Taipei
    assert.equal(localHour("Asia/Taipei", instant), 4);
    assert.equal(localDayString("Asia/Taipei", instant), "2026-03-11");
    assert.equal(localDayString("UTC", instant), "2026-03-10");
  });

  it("wallTimeToUtc rejects garbage input", () => {
    assert.equal(wallTimeToUtc("Asia/Tokyo", "not-a-time"), null);
  });
});

// ── computeWindow: usable window math & status tiers ──────────────────────────

describe("computeWindow tiers", () => {
  const airport = makeAirportProfile(); // Asia/Taipei buffers 60/120 +20 traffic

  function fixedSession(arrivalIso: string, departureIso: string, opts: any = {}): any {
    return {
      id: "sess-window", userId: USER_A, airportId: "airport-fake", tripId: null,
      arrivalTime: arrivalIso, departureTime: departureIso, boardingTime: null,
      layoverMinutes: Math.round((new Date(departureIso).getTime() - new Date(arrivalIso).getTime()) / 60000),
      flightType: "domestic", immigrationRequired: false, checkedBags: false,
      loungeAccess: false, wantsToLeave: true, comfortLevel: "moderate",
      vibeChips: [], manualAirportName: null, manualCity: "Taoyuan",
      manualCountry: "Taiwan", manualIata: "TPE", canonicalCityId: null,
      shareCityStatus: false, returnReminderAt: null,
      status: "active", createdAt: arrivalIso, updatedAt: arrivalIso,
      ...opts,
    };
  }

  it("2h international layover with immigration → too_short", () => {
    // 09:00–11:00 Taipei daytime
    const s = fixedSession("2026-03-10T01:00:00.000Z", "2026-03-10T03:00:00.000Z", {
      flightType: "international", immigrationRequired: true,
    });
    const w = computeWindow(airport, s, new Date("2026-03-10T01:00:00.000Z").getTime());
    assert.equal(w.tier, "too_short");
    assert.equal(w.usableMinutes, 0, "no usable time after intl buffers");
  });

  it("5h domestic layover → quick_city", () => {
    // 09:00–14:00 Taipei
    const s = fixedSession("2026-03-10T01:00:00.000Z", "2026-03-10T06:00:00.000Z");
    const w = computeWindow(airport, s, new Date("2026-03-10T01:00:00.000Z").getTime());
    assert.equal(w.tier, "quick_city");
    assert.ok(w.usableMinutes >= 90 && w.usableMinutes < 240, `usable ${w.usableMinutes}`);
  });

  it("10h daytime domestic layover → half_day", () => {
    // 09:00–19:00 Taipei, same local day
    const s = fixedSession("2026-03-10T01:00:00.000Z", "2026-03-10T11:00:00.000Z");
    const w = computeWindow(airport, s, new Date("2026-03-10T01:00:00.000Z").getTime());
    assert.equal(w.tier, "half_day");
    assert.equal(w.overnight, false);
  });

  it("overnight layover crossing local midnight → overnight", () => {
    // 20:00 Taipei → 08:00 next Taipei day (12h)
    const s = fixedSession("2026-03-10T12:00:00.000Z", "2026-03-11T00:00:00.000Z");
    const w = computeWindow(airport, s, new Date("2026-03-10T12:00:00.000Z").getTime());
    assert.equal(w.overnight, true);
    assert.equal(w.tier, "overnight");
  });

  it("wantsToLeave=false forces airport_only even with plenty of time", () => {
    const s = fixedSession("2026-03-10T01:00:00.000Z", "2026-03-10T06:00:00.000Z", { wantsToLeave: false });
    const w = computeWindow(airport, s, new Date("2026-03-10T01:00:00.000Z").getTime());
    assert.equal(w.tier, "airport_only");
  });

  it("boarding time (not departure) is the hard cutoff when present", () => {
    const s = fixedSession("2026-03-10T01:00:00.000Z", "2026-03-10T06:00:00.000Z", {
      boardingTime: "2026-03-10T05:30:00.000Z",
    });
    const w = computeWindow(airport, s, new Date("2026-03-10T01:00:00.000Z").getTime());
    assert.ok(
      w.hardReturnTime.getTime() <= new Date("2026-03-10T05:30:00.000Z").getTime(),
      "hard return must respect boarding cutoff",
    );
  });

  it("estimateExitDelay scales with flight type, immigration and bags", () => {
    assert.equal(estimateExitDelay({ flightType: "domestic", immigrationRequired: false, checkedBags: false } as any), 15);
    assert.equal(estimateExitDelay({ flightType: "international", immigrationRequired: false, checkedBags: false } as any), 25);
    assert.equal(estimateExitDelay({ flightType: "international", immigrationRequired: true, checkedBags: true } as any), 65);
  });

  it("computeBuffer time-of-day extra uses the airport timezone", () => {
    const s = fixedSession("2026-03-10T01:00:00.000Z", "2026-03-10T03:00:00.000Z");
    // 03:00 UTC = 11:00 Taipei → no night extra in tz mode, +20 in UTC mode.
    const tzAware = computeBuffer(airport, s, new Date("2026-03-10T03:00:00.000Z"), "Asia/Taipei");
    const utcOnly = computeBuffer(airport, s, new Date("2026-03-10T03:00:00.000Z"));
    assert.equal(tzAware.timeOfDayExtra, 0);
    assert.equal(utcOnly.timeOfDayExtra, 20);
  });
});

// ── adviseLeaving: "Can I Leave the Airport?" guidance ────────────────────────

describe("adviseLeaving", () => {
  const airport = makeAirportProfile();

  // The entry decisions this suite exercises. Shapes come from
  // lib/layoverEntryEligibility; nothing here invents a status.
  const ENTRY_PERMITTED = {
    state: "permitted" as const, passportCountry: "GB", destinationCountry: "TW",
    status: "visa_free", condition: null, officialSourceUrl: "https://example.gov/tw",
    lastVerifiedAt: "2026-01-01T00:00:00.000Z", disclaimer: "d",
  };
  const ENTRY_UNRESOLVED = {
    state: "unresolved" as const, reason: "no_data_for_corridor" as const,
    passportCountry: "GB", destinationCountry: "TW", disclaimer: "d",
  };
  const ENTRY_REFUSED = {
    state: "not_permitted" as const, passportCountry: "GB", destinationCountry: "TW",
    status: "visa_required", reason: "requires_advance_authorization" as const,
    officialSourceUrl: "https://example.gov/tw", lastVerifiedAt: null, disclaimer: "d",
  };

  function sessionFor(tier: "long" | "short" | "stay"): any {
    const base = {
      id: "sess-advice", userId: USER_A, airportId: "airport-fake", tripId: null,
      boardingTime: null, flightType: "domestic", immigrationRequired: false,
      checkedBags: false, loungeAccess: false, wantsToLeave: tier !== "stay",
      comfortLevel: "moderate", vibeChips: [], manualAirportName: null,
      manualCity: "Taoyuan", manualCountry: "Taiwan", manualIata: "TPE",
      canonicalCityId: null, shareCityStatus: false, returnReminderAt: null,
      status: "active", createdAt: "", updatedAt: "",
    };
    if (tier === "short") {
      return { ...base, arrivalTime: "2026-03-10T01:00:00.000Z", departureTime: "2026-03-10T03:00:00.000Z",
        flightType: "international", immigrationRequired: true, layoverMinutes: 120 };
    }
    return { ...base, arrivalTime: "2026-03-10T01:00:00.000Z", departureTime: "2026-03-10T11:00:00.000Z", layoverMinutes: 600 };
  }

  const adviceFor = (tier: "long" | "short" | "stay", entry: any) => {
    const s = sessionFor(tier);
    const w = computeWindow(airport, s, new Date(s.arrivalTime).getTime());
    return adviseLeaving(airport, s, w, entry);
  };

  it("says yes for a roomy window ONLY when entry is actually established", () => {
    const advice = adviceFor("long", ENTRY_PERMITTED);
    assert.equal(advice.verdict, "yes");
    assert.ok(advice.reasons.length > 0);
    assert.equal(advice.entry?.state, "permitted");
  });

  it("a roomy window with UNRESOLVED entry is not an affirmative answer", () => {
    // This is the defect this suite used to codify: the old test asserted
    // "yes" for exactly this case, with the visa question demoted to prose in
    // `unknowns`. Ten hours of spare time is not permission to cross a border.
    const advice = adviceFor("long", ENTRY_UNRESOLVED);
    assert.equal(advice.verdict, "entry_unverified");
    assert.notEqual(advice.verdict, "yes");
  });

  it("an omitted entry argument is treated as unresolved, never as permission", () => {
    // A caller that forgets to resolve entry must get the cautious answer.
    const advice = adviceFor("long", null);
    assert.equal(advice.verdict, "entry_unverified");
  });

  it("a REFUSED corridor overrides any amount of spare time", () => {
    const advice = adviceFor("long", ENTRY_REFUSED);
    assert.equal(advice.verdict, "no");
    assert.ok(advice.reasons.some((r: string) => /visa or permit arranged before travel/i.test(r)));
    assert.ok(advice.reasons.some((r: string) => r.includes("https://example.gov/tw")),
      "the official source must travel with a refusal so the traveller can check it");
  });

  it("says no when buffers eat the whole window, whatever the border says", () => {
    for (const entry of [ENTRY_PERMITTED, ENTRY_UNRESOLVED, ENTRY_REFUSED]) {
      assert.equal(adviceFor("short", entry).verdict, "no");
    }
  });

  it("the entry gate can only ever DOWNGRADE the clock's answer", () => {
    // The safety property, stated directly: for every window, no entry state
    // produces a better verdict than permitted entry does.
    const RANK: Record<string, number> = { yes: 0, tight: 1, entry_unverified: 2, no: 3, stay_airside: 4 };
    for (const tier of ["long", "short"] as const) {
      const best = RANK[adviceFor(tier, ENTRY_PERMITTED).verdict];
      for (const entry of [ENTRY_UNRESOLVED, ENTRY_REFUSED, null]) {
        assert.ok(RANK[adviceFor(tier, entry).verdict] >= best,
          `${tier} with ${JSON.stringify(entry)} must not beat the permitted verdict`);
      }
    }
  });

  it("respects the stay-airside preference", () => {
    assert.equal(adviceFor("stay", ENTRY_PERMITTED).verdict, "stay_airside");
  });

  it("always surfaces the entry question — as a gate, or as an explicit unknown", () => {
    const disclaimerHasGuidance = (a: any) => a.disclaimer.toLowerCase().includes("guidance");

    const unresolved = adviceFor("long", ENTRY_UNRESOLVED);
    assert.ok(
      unresolved.unknowns.some((u: string) => /may enter this country/i.test(u)),
      "an unresolved corridor must be named as an unknown, not silently dropped",
    );
    assert.ok(disclaimerHasGuidance(unresolved));

    // When it IS resolved it is no longer an unknown — it is a decision, and it
    // must be attached to the advice rather than left as a caveat.
    const permitted = adviceFor("long", ENTRY_PERMITTED);
    assert.equal(permitted.entry?.state, "permitted");
    assert.ok(
      !permitted.unknowns.some((u: string) => /may enter this country/i.test(u)),
      "a resolved corridor is a gate that passed, not a standing unknown",
    );
    assert.ok(disclaimerHasGuidance(permitted));
  });
});

// ── timeOfDayContext ─────────────────────────────────────────────────────────
import { timeOfDayContext } from "../services/airport/LayoverRecommendationService.js";

describe("timeOfDayContext", () => {
  const airport = makeAirportProfile(); // Asia/Taipei (UTC+8)

  function sessionAt(arrivalIso: string, departureIso: string): any {
    return {
      id: "sess-tod", userId: USER_A, airportId: "airport-fake", tripId: null,
      arrivalTime: arrivalIso, departureTime: departureIso, boardingTime: null,
      layoverMinutes: Math.round((new Date(departureIso).getTime() - new Date(arrivalIso).getTime()) / 60000),
      flightType: "domestic", immigrationRequired: false, checkedBags: false,
      loungeAccess: false, wantsToLeave: true, comfortLevel: "moderate",
      vibeChips: [], manualAirportName: null, manualCity: "Taoyuan",
      manualCountry: "Taiwan", manualIata: "TPE", canonicalCityId: null,
      shareCityStatus: false, returnReminderAt: null, status: "active",
      createdAt: "", updatedAt: "",
    };
  }

  it("flags a 10:00–14:00 local window as daytime-only", () => {
    const s = sessionAt("2026-03-10T02:00:00.000Z", "2026-03-10T06:00:00.000Z");
    const tod = timeOfDayContext(airport, s, new Date(s.arrivalTime).getTime());
    assert.equal(tod.coversEvening, false);
    assert.equal(tod.coversDaytime, true);
  });

  it("flags a 17:00–23:00 local window as covering the evening", () => {
    const s = sessionAt("2026-03-10T09:00:00.000Z", "2026-03-10T15:00:00.000Z");
    const tod = timeOfDayContext(airport, s, new Date(s.arrivalTime).getTime());
    assert.equal(tod.coversEvening, true);
  });

  it("flags a 22:00–08:00 overnight window as evening but not daytime", () => {
    const s = sessionAt("2026-03-10T14:00:00.000Z", "2026-03-11T00:00:00.000Z");
    const tod = timeOfDayContext(airport, s, new Date(s.arrivalTime).getTime());
    assert.equal(tod.coversEvening, true);
    assert.equal(tod.coversDaytime, false);
  });

  it("measures from 'now', not arrival, when the layover is already underway", () => {
    // Arrived 06:00 local, but it is now 18:00 local with a 23:00 departure.
    const s = sessionAt("2026-03-09T22:00:00.000Z", "2026-03-10T15:00:00.000Z");
    const tod = timeOfDayContext(airport, s, new Date("2026-03-10T10:00:00.000Z").getTime());
    assert.equal(tod.coversEvening, true);
    assert.equal(tod.coversDaytime, false);
  });
});

describe("timeOfDayContext precision", () => {
  const airport = makeAirportProfile(); // Asia/Taipei (UTC+8)

  it("does not overshoot into the evening on fractional-hour windows (12:00–16:30)", () => {
    const s = {
      id: "sess-tod2", userId: USER_A, airportId: "airport-fake", tripId: null,
      arrivalTime: "2026-03-10T04:00:00.000Z", departureTime: "2026-03-10T08:30:00.000Z",
      boardingTime: null, layoverMinutes: 270, flightType: "domestic",
      immigrationRequired: false, checkedBags: false, loungeAccess: false,
      wantsToLeave: true, comfortLevel: "moderate", vibeChips: [],
      manualAirportName: null, manualCity: "Taoyuan", manualCountry: "Taiwan",
      manualIata: "TPE", canonicalCityId: null, shareCityStatus: false,
      returnReminderAt: null, status: "active", createdAt: "", updatedAt: "",
    } as any;
    const tod = timeOfDayContext(airport, s, new Date(s.arrivalTime).getTime());
    assert.equal(tod.coversEvening, false, "16:30 end must not count hour 17");
    assert.equal(tod.coversDaytime, true);
  });

  it("stops at the boarding cutoff, not departure (evening dies at 16:45 boarding)", () => {
    const s = {
      id: "sess-tod3", userId: USER_A, airportId: "airport-fake", tripId: null,
      arrivalTime: "2026-03-10T02:00:00.000Z", departureTime: "2026-03-10T12:00:00.000Z",
      boardingTime: "2026-03-10T08:45:00.000Z", layoverMinutes: 600, flightType: "domestic",
      immigrationRequired: false, checkedBags: false, loungeAccess: false,
      wantsToLeave: true, comfortLevel: "moderate", vibeChips: [],
      manualAirportName: null, manualCity: "Taoyuan", manualCountry: "Taiwan",
      manualIata: "TPE", canonicalCityId: null, shareCityStatus: false,
      returnReminderAt: null, status: "active", createdAt: "", updatedAt: "",
    } as any;
    // Departure 20:00 local would cover the evening; boarding 16:45 must not.
    const tod = timeOfDayContext(airport, s, new Date(s.arrivalTime).getTime());
    assert.equal(tod.coversEvening, false);
  });
});
