/**
 * Sensing §11 — the layover live intersection (lib/layoverLiveIntersection),
 * exercised directly, plus the real `generateRecommendations` path over the
 * fake PostgREST double so the wiring is proven, not assumed.
 *
 * What §11 asks for is an INTERSECTION, not a second engine: the live queue is
 * added to the activity time BEFORE LayoverSafetyEngine rates the card, so the
 * existing safe-return arithmetic — the one that already knows the certified
 * deadline — is what answers. These tests check both halves: the grading, and
 * that the graded number reaches the engine.
 *
 * Each case was watched red under its own mutation (census-sensing §7.3).
 *
 * Run: node --import tsx/esm --test src/test/layoverLiveIntersection.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { LiveClaimEnvelope } from "../lib/liveClaimRead.js";
import {
  QUEUE_CAP_MINUTES,
  compareByLive,
  intentFromVibeChips,
  intersectLayoverLive,
  intersectOne,
  type LayoverLiveCandidate,
} from "../lib/layoverLiveIntersection.js";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";
import { generateRecommendations } from "../services/airport/LayoverRecommendationService.js";
import type { AirportProfile } from "../services/airport/AirportProfileService.js";
import type { LayoverSession } from "../services/airport/LayoverSessionService.js";

const NOW = Date.parse("2026-09-12T09:00:00.000Z");
const iso = (min: number) => new Date(NOW + min * 60_000).toISOString();

let seq = 0;
function env(over: Partial<LiveClaimEnvelope> = {}): LiveClaimEnvelope {
  seq += 1;
  return {
    id: `env-${seq}`,
    claimType: "crowd.level",
    value: { level: "busy" },
    confidence: 0.9,
    band: "live",
    sourceClass: "firsthand_unverified",
    sourceCountBucket: "several",
    observedAt: iso(-3),
    validUntil: iso(120),
    state: "live",
    conflictState: "none",
    conflict: null,
    ...over,
  } as LiveClaimEnvelope;
}

function cand(key: string, envelopes: LiveClaimEnvelope[], over: Partial<LayoverLiveCandidate> = {}): LayoverLiveCandidate {
  return { key, subjectId: `subj-${key}`, envelopes, readable: true, travelTimeMin: 30, activityTimeMin: 60, ...over };
}

describe("Sensing §11 — friction becomes minutes the existing engine can see", () => {
  it("a Live queue wait is added to the activity time, and is reported as such", () => {
    const v = intersectOne(cand("q", [env(), env({ claimType: "queue.wait", value: { minMinutes: 45 } })]), { nowMs: NOW });
    assert.equal(v.evidence, "reading");
    assert.equal(v.frictionMinutes, 45);
    assert.equal(v.adjustedActivityMin, 105);
    assert.ok(v.reasons.includes("queue_45m"));
  });

  it("an absurd queue is capped rather than allowed to overflow the arithmetic", () => {
    const v = intersectOne(cand("q", [env(), env({ claimType: "queue.wait", value: { minMinutes: 10_000 } })]), { nowMs: NOW });
    assert.equal(v.frictionMinutes, QUEUE_CAP_MINUTES);
  });

  it("NO reading adds NO minutes — the absence of a queue report is not a report of no queue", () => {
    const v = intersectOne(cand("none", []), { nowMs: NOW });
    assert.equal(v.evidence, "none");
    assert.equal(v.frictionMinutes, 0);
    assert.equal(v.adjustedActivityMin, 60);
    assert.equal(v.drop, false);
    assert.deepEqual(v.reasons, []);
  });

  it("gates closed is labelled apart from nothing observed, and is equally a no-op", () => {
    const v = intersectOne(cand("closed", [], { readable: false }), { nowMs: NOW });
    assert.equal(v.evidence, "unreadable");
    assert.equal(v.adjustedActivityMin, 60);
  });

  it("a SPONSORED queue claim is not a reading and buys no minutes", () => {
    const v = intersectOne(
      cand("s", [env({ sourceClass: "sponsored" }), env({ claimType: "queue.wait", sourceClass: "sponsored", value: { minMinutes: 90 } })]),
      { nowMs: NOW },
    );
    assert.equal(v.evidence, "none");
    assert.equal(v.frictionMinutes, 0);
  });
});

describe("Sensing §16 — a layover card is a recommendation to GO, so safety drops it", () => {
  it("a Live unsafe_density drops the card, with the reason named", () => {
    const v = intersectOne(cand("u", [env({ value: { level: "unsafe_density" } })]), { nowMs: NOW });
    assert.equal(v.drop, true);
    assert.equal(v.dropReason, "unsafe_density");
  });

  it("a Live refused walk-in drops the card", () => {
    const v = intersectOne(cand("w", [env(), env({ claimType: "access.walk_in", value: { accepted: false } })]), { nowMs: NOW });
    assert.equal(v.drop, true);
    assert.equal(v.dropReason, "walk_in_refused");
  });

  it("an ACCEPTED walk-in does not drop anything", () => {
    const v = intersectOne(cand("w", [env(), env({ claimType: "access.walk_in", value: { accepted: true } })]), { nowMs: NOW });
    assert.equal(v.drop, false);
    assert.equal(v.dropReason, null);
  });

  it("the outcome counts what it did, so a caller can say it out loud", () => {
    const out = intersectLayoverLive([
      cand("a", [env({ value: { level: "unsafe_density" } })]),
      cand("b", [env(), env({ claimType: "queue.wait", value: { minMinutes: 20 } })]),
      cand("c", []),
    ], { nowMs: NOW });
    assert.deepEqual(out.dropped, [{ key: "a", reason: "unsafe_density" }]);
    assert.equal(out.frictionAdjusted, 1);
    assert.equal(out.withReadings, 2);
  });
});

describe("Sensing §11/§2 — value is intent-relative, and a decaying window demotes", () => {
  it("only a chip that is a crowd preference becomes one", () => {
    assert.equal(intentFromVibeChips(["food", "shopping"]), null);
    assert.equal(intentFromVibeChips(["culture"]), null);
    assert.equal(intentFromVibeChips(["nightlife"]), "high_energy");
    assert.equal(intentFromVibeChips(["quiet", "nightlife"]), "quiet");
    assert.equal(intentFromVibeChips(undefined), null);
  });

  it("with no crowd preference the experience value is null and nothing re-orders", () => {
    const a = intersectOne(cand("a", [env({ value: { level: "packed" } })]), { nowMs: NOW, intent: null });
    const b = intersectOne(cand("b", [env({ value: { level: "quiet" } })]), { nowMs: NOW, intent: null });
    assert.equal(a.experienceValue, null);
    assert.equal(b.experienceValue, null);
    assert.equal(compareByLive(a, b), 0);
  });

  it("with a preference the value orders, and a card with no reading is never re-ordered", () => {
    const packed = intersectOne(cand("p", [env({ value: { level: "packed" } })]), { nowMs: NOW, intent: "high_energy" });
    const calm   = intersectOne(cand("c", [env({ value: { level: "quiet" } })]),  { nowMs: NOW, intent: "high_energy" });
    const silent = intersectOne(cand("s", []), { nowMs: NOW, intent: "high_energy" });
    assert.ok(compareByLive(packed, calm) < 0, "packed must lead for a high-energy traveller");
    assert.equal(compareByLive(packed, silent), 0, "a card with no reading was re-ordered");
    assert.equal(compareByLive(silent, calm), 0);
  });

  it("a window that will have decayed before arrival demotes — and never drops", () => {
    // travel 30 min, evidence valid another 5.
    const decaying = intersectOne(cand("d", [env({ validUntil: iso(5) })]), { nowMs: NOW, intent: "social" });
    const standing = intersectOne(cand("s", [env({ validUntil: iso(300) })]), { nowMs: NOW, intent: "social" });
    assert.equal(decaying.windowDecaysBeforeArrival, true);
    assert.equal(decaying.interception.reachable, false);
    assert.equal(decaying.drop, false, "a closing window is not a closed door");
    assert.ok(compareByLive(standing, decaying) < 0);
  });

  it("an unknown horizon is an unknown interception, not a reachable one", () => {
    const v = intersectOne(cand("u", [env({ validUntil: "not-a-date" })]), { nowMs: NOW });
    assert.equal(v.interception.reachable, null);
    assert.equal(v.windowDecaysBeforeArrival, false);
  });
});

// ── The wiring: the graded minutes reach the REAL safety engine ──────────────

const AIRPORT: AirportProfile = {
  id: "airport-tpe", iataCode: "TPE", name: "Taoyuan Intl", city: "Taoyuan",
  country: "Taiwan", countryCode: "TW", timezone: "Asia/Taipei", lat: 25.07, lng: 121.23,
  domesticBufferMin: 60, domesticBufferMax: 90, internationalBufferMin: 120, internationalBufferMax: 180,
  immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20, verified: false,
};

const SUBJECT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

function layoverSession(over: Partial<LayoverSession> = {}): LayoverSession {
  const now = Date.now();
  return {
    id: "session-live", userId: "user-1", airportId: "airport-tpe", tripId: null,
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

const LIVE_GATES_OPEN = [
  { flag: "intel_live_label_crowd", enabled: true },
  { flag: "intel_claim_projection_crowd", enabled: true },
  { flag: "intel_capture_quick_signal", enabled: true },
  { flag: "intel_limited_live", enabled: true },
];

function snapshotRow(over: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: `snap-${Math.random().toString(36).slice(2, 8)}`,
    subject_id: SUBJECT, zone_id: null, claim_type: "queue.wait",
    value: { minMinutes: 90 }, confidence: 0.9, source_count: 30,
    observed_at: new Date(now - 3 * 60_000).toISOString(),
    expires_at: new Date(now + 120 * 60_000).toISOString(),
    privacy_eligible: true, conflict_state: "none",
    source_class: "firsthand_unverified",
    computed_at: new Date(now - 3 * 60_000).toISOString(),
    ...over,
  };
}

function tables(flags: Array<{ flag: string; enabled: boolean }>, snapshots: any[]) {
  return {
    feature_flags: [...LIVE_GATES_OPEN, ...flags],
    intel_live_promoted_scopes: [{ scope_key: "|queue.wait" }, { scope_key: "|crowd.level" }],
    intel_state_snapshots: snapshots,
    // `canonical_location_id` is nullable in the real table — an unbridged
    // discovery row is the ordinary case, not an edge one — so the fixture
    // says so rather than being widened at the one call site that needs null.
    discovery_places: [{
      id: "dp-1", name: "Night Market", place_type: "attraction", category: "food",
      neighborhood: "Zhongli", blurb: "Snacks", verified: true, city: "Taoyuan",
      status: "active", canonical_location_id: SUBJECT as string | null,
    }],
    layover_recommendations: [] as any[],
  };
}

function cardsOf(r: { ok: true; recommendations: any[] } | { ok: false; message: string }): any[] {
  if (!r.ok) assert.fail(`expected recommendations, got a refusal: ${r.message}`);
  return r.recommendations;
}

/**
 * ── FOUR ASSERTIONS HERE USED TO ENCODE census-layover L293b ────────────────
 * Every `assert.equal(market.activityTimeMin, 90)` below was reading
 * `estimateActivityTime("attraction")` — a per-category constant substituted
 * for a duration `discovery_places` has no column for — and the queue case
 * asserted 180 because it was 90 + 90. The producer no longer substitutes one,
 * so the number the REAL path yields is `null`, and the cases say so.
 *
 * WHAT THIS COSTS AND WHAT IT DOES NOT. The §11 friction ARITHMETIC is pinned
 * where it can be stated honestly — "Sensing §11 — friction becomes minutes the
 * existing engine can see" at the top of this file, on `intersectOne`, with a
 * dwell a caller STATED (60 + 45 = 105). What the real-producer cases pin now
 * is the boundary condition that arithmetic has to respect: a live queue
 * LENGTHENS a stated duration and cannot conjure one out of an absence. Adding
 * `frictionMinutes` to nothing would have turned "nobody said" into "90
 * minutes", which is the same substitution one layer along.
 *
 * The DROP path is unaffected and is asserted unchanged below: an unsafe
 * density still removes the card, whether or not anyone timed the visit.
 */
describe("Sensing §11 through the REAL generateRecommendations", () => {
  it("flag ABSENT (production's state): the landside card's duration is untouched — and unstated", async () => {
    const db = makeLayoverDb(tables([], [snapshotRow()])) as any;
    const cards = cardsOf(await generateRecommendations(db, AIRPORT, layoverSession()));
    const market = cards.find((c) => c.title === "Night Market");
    assert.ok(market, "the landside card must still be generated");
    assert.equal(market.activityTimeMin, null, "an unflagged run must not read a claim — nor invent a duration");
  });

  it("ON: a Live queue cannot lengthen a duration nobody stated", async () => {
    const db = makeLayoverDb(tables([{ flag: "layover_live_intersection_enabled", enabled: true }], [snapshotRow()])) as any;
    const cards = cardsOf(await generateRecommendations(db, AIRPORT, layoverSession()));
    const market = cards.find((c) => c.title === "Night Market");
    assert.ok(market, "the card must survive a queue — a wait is not a closed door");
    assert.equal(market.activityTimeMin, null,
      "a 90-minute queue was added to an absence and became a 90-minute visit");
  });

  it("ON: a Live unsafe_density removes the landside card entirely", async () => {
    const db = makeLayoverDb(tables(
      [{ flag: "layover_live_intersection_enabled", enabled: true }],
      [snapshotRow({ claim_type: "crowd.level", value: { level: "unsafe_density" } })],
    )) as any;
    const cards = cardsOf(await generateRecommendations(db, AIRPORT, layoverSession()));
    assert.equal(cards.find((c) => c.title === "Night Market"), undefined);
    assert.ok(cards.length > 0, "the inside-airport cards must survive — only the unsafe place goes");
  });

  it("ON with the Live pilot CLOSED: nothing is adjusted and nothing is dropped", async () => {
    const t = tables([{ flag: "layover_live_intersection_enabled", enabled: true }], [snapshotRow()]);
    t.feature_flags = [
      { flag: "intel_live_label_crowd", enabled: true },
      { flag: "intel_claim_projection_crowd", enabled: true },
      { flag: "intel_capture_quick_signal", enabled: true },
      { flag: "intel_limited_live", enabled: false },
      { flag: "layover_live_intersection_enabled", enabled: true },
    ];
    const db = makeLayoverDb(t) as any;
    const cards = cardsOf(await generateRecommendations(db, AIRPORT, layoverSession()));
    const market = cards.find((c) => c.title === "Night Market");
    assert.ok(market);
    assert.equal(market.activityTimeMin, null);
  });

  it("ON but the place is UNBRIDGED: no subject, so nothing is looked up and nothing changes", async () => {
    const t = tables([{ flag: "layover_live_intersection_enabled", enabled: true }], [snapshotRow()]);
    t.discovery_places = [{ ...t.discovery_places[0]!, canonical_location_id: null }];
    const db = makeLayoverDb(t) as any;
    const cards = cardsOf(await generateRecommendations(db, AIRPORT, layoverSession()));
    const market = cards.find((c) => c.title === "Night Market");
    assert.ok(market);
    assert.equal(market.activityTimeMin, null);
  });

  it("the friction arithmetic still adds to a STATED duration — the absence is the only thing refused", () => {
    // The positive control for the four cases above: `intersectOne` with a
    // dwell someone stated still gains the queue, so what changed is the
    // producer's honesty and not §11's mechanism.
    const queue = () => [env(), env({ claimType: "queue.wait", value: { minMinutes: 45 } })];
    const stated = intersectOne(cand("stated", queue()), { nowMs: NOW });
    assert.equal(stated.frictionMinutes, 45, "positive control: the fixture carries a queue");
    assert.equal(stated.adjustedActivityMin, 60 + 45);
    const absent = intersectOne(
      cand("absent", queue(), { travelTimeMin: null, activityTimeMin: null }),
      { nowMs: NOW },
    );
    assert.equal(absent.adjustedActivityMin, null);
    assert.equal(absent.frictionMinutes, 45, "the reading itself is unchanged");
    // An unknown ETA is not an instant arrival: `interceptPeak` answers
    // `reachable: null`, so nothing is promoted or demoted on a journey length
    // nobody measured.
    assert.equal(absent.interception.reachable, null);
  });
});
