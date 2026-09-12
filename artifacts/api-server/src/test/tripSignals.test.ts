/**
 * Trips spec §16 — SignalEstimate (§16.2) and Trip Pulse's context filter
 * (§16.1), pure. census-trips TR299–TR311.
 *
 * Run: node --import tsx/esm --test src/test/tripSignals.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  estimateFromObservations, interpretSignal, projectSignals, looksWeatherSensitive,
  SIGNAL_KINDS, SIGNAL_INTERPRETATIONS, SOURCE_CLASS_RANK, FALLBACK_SOURCE_CLASSES, ATTENTION_STATES, PULSE_RELEVANCE,
  type SignalObservation, type PulseContext, type TripSignal,
} from "../services/trips/TripSignals.js";
import { SOURCE_CLASSES } from "../lib/intelContracts.js";

const T = (hhmm: string, day = "13") => `2026-09-${day}T${hhmm}:00.000Z`;
const NOW = Date.parse(T("12:00"));
const obs = <T,>(value: T, o: Partial<SignalObservation<T>> = {}): SignalObservation<T> => ({
  value, confidence: 0.8, sourceClass: "firsthand_unverified", observedAt: T("11:50"), expiresAt: T("13:00"), ...o,
});

function ctx(over: Partial<PulseContext> = {}): PulseContext {
  return {
    now: NOW,
    stage: { id: "st1", startsAt: T("00:00", "12"), endsAt: T("23:59", "15"), anchor: null },
    locationBand: { centre: { lat: 48.8566, lng: 2.3522 }, radiusM: 2000 },
    goals: [], savedIdeas: [], commitments: [], plans: [], transport: [],
    crew: { viewerId: "me", memberIds: ["me", "ana", "bo"] },
    attention: "NORMAL",
    ...over,
  };
}
const sig = (kind: TripSignal["kind"], subjectId: string, value: any, est: Partial<TripSignal["estimate"]> = {}): TripSignal => ({
  kind, subjectId,
  estimate: { value, confidence: 0.8, sourceClass: "firsthand_unverified", observedAt: T("11:50"), expiresAt: T("13:00"), fallbackUsed: false, contradictorySources: [], support: { agreeing: 1, total: 1 }, ...est },
});

describe("§16.2 SignalEstimate — estimateFromObservations", () => {
  it("carries every §16.2 field, and every intel source class has a rank", () => {
    const e = estimateFromObservations([obs("busy")], { now: NOW })!;
    for (const k of ["value", "confidence", "sourceClass", "observedAt", "expiresAt", "fallbackUsed", "contradictorySources"]) assert.ok(k in e, k);
    assert.equal(e.value, "busy"); assert.equal(e.confidence, 0.8); assert.equal(e.fallbackUsed, false); assert.deepEqual(e.contradictorySources, []);
    for (const c of SOURCE_CLASSES) assert.equal(typeof SOURCE_CLASS_RANK[c], "number", `rank for ${c}`);
  });
  it("nothing admissible → null, not a zero-confidence estimate; an expired observation is not admissible", () => {
    assert.equal(estimateFromObservations([], { now: NOW }), null);
    assert.equal(estimateFromObservations([obs("busy", { expiresAt: T("11:59") })], { now: NOW }), null);
    assert.equal(estimateFromObservations([obs("busy", { expiresAt: "garbage" })], { now: NOW }), null);
  });
  it("contradiction: the best-supported value wins, EVERY disagreeing source is listed, and confidence falls by the agreeing share", () => {
    const e = estimateFromObservations([
      obs("busy", { confidence: 0.9 }), obs("busy", { confidence: 0.7, sourceClass: "verified_firsthand", observedAt: T("11:55") }),
      obs("dead", { confidence: 0.95, sourceClass: "official_signed" }),
    ], { now: NOW })!;
    assert.equal(e.value, "busy");
    assert.equal(e.support.agreeing, 2); assert.equal(e.support.total, 3);
    assert.equal(e.contradictorySources.length, 1);
    assert.equal(e.contradictorySources[0].sourceClass, "official_signed"); assert.equal(e.contradictorySources[0].value, "dead");
    assert.ok(Math.abs(e.confidence - 0.9 * (2 / 3)) < 1e-9, `confidence ${e.confidence} = 0.9 × 2/3`);
    assert.equal(e.sourceClass, "verified_firsthand", "the best source AMONG THE AGREEING, not the best overall");
    assert.equal(e.observedAt, T("11:55"), "the latest agreeing observation");
  });
  it("does not silently select: an official single source loses to two agreeing visitors, and is listed", () => {
    const e = estimateFromObservations([
      obs("closed", { sourceClass: "official_signed", confidence: 1 }),
      obs("open", { sourceClass: "firsthand_unverified" }), obs("open", { sourceClass: "hearsay" }),
    ], { now: NOW })!;
    assert.equal(e.value, "open");
    assert.deepEqual(e.contradictorySources.map((c) => c.sourceClass), ["official_signed"]);
    assert.ok(e.confidence < 0.8, "confidence is lower than the best agreeing source's, because a source disagrees");
  });
  it("ties break by source-class rank, then by value order — never by input order (shuffle-invariant)", () => {
    const a = [obs("busy", { sourceClass: "hearsay" }), obs("quiet", { sourceClass: "verified_firsthand" })];
    const e1 = estimateFromObservations(a, { now: NOW })!;
    const e2 = estimateFromObservations([...a].reverse(), { now: NOW })!;
    assert.equal(e1.value, "quiet"); assert.equal(e2.value, "quiet");
    assert.deepEqual(e1, e2);
    const b = [obs("x", { sourceClass: "hearsay" }), obs("y", { sourceClass: "hearsay" })];
    assert.equal(estimateFromObservations(b, { now: NOW })!.value, estimateFromObservations([...b].reverse(), { now: NOW })!.value);
  });
  it("fallbackUsed: a pattern or prediction as the source, or a source that says so; expiresAt is the weakest supporter's", () => {
    for (const c of FALLBACK_SOURCE_CLASSES) assert.equal(estimateFromObservations([obs("busy", { sourceClass: c })], { now: NOW })!.fallbackUsed, true, c);
    assert.equal(estimateFromObservations([obs("busy", { fallback: true })], { now: NOW })!.fallbackUsed, true);
    const e = estimateFromObservations([obs("busy", { expiresAt: T("14:00") }), obs("busy", { expiresAt: T("12:30") })], { now: NOW })!;
    assert.equal(e.expiresAt, T("12:30"));
  });
  it("object values are compared structurally, key order aside", () => {
    const e = estimateFromObservations([obs({ a: 1, b: 2 }), obs({ b: 2, a: 1 })], { now: NOW })!;
    assert.equal(e.support.agreeing, 2); assert.deepEqual(e.contradictorySources, []);
  });
});

describe("§16.1 the five signals, interpreted through the trip context", () => {
  it("the vocabulary is the spec's table: five kinds, each with the spec's interpretation; seven relevance axes; three attention states", () => {
    assert.deepEqual([...SIGNAL_KINDS], ["crowd_rising", "rain_arriving", "taxi_demand_high", "event_delayed", "friend_nearby"]);
    for (const k of SIGNAL_KINDS) assert.ok(SIGNAL_INTERPRETATIONS[k].length > 20, k);
    assert.deepEqual([...PULSE_RELEVANCE], ["stage", "location", "goals", "saved_ideas", "commitments", "crew", "attention"]);
    assert.deepEqual([...ATTENTION_STATES], ["NORMAL", "AT_RISK", "SAFETY_EVENT"]);
  });
  it("crowd rising at a saved nightlife venue → better now + queue risk later; at a place the trip does not hold → dropped", () => {
    const c = ctx({ savedIdeas: [{ id: "s1", placeId: "p1", placeType: "bar", name: "Le Bar", point: { lat: 48.857, lng: 2.353 } }], goals: [{ type: "nightlife", scope: "shared", status: "open" }] });
    const r = interpretSignal(sig("crowd_rising", "p1", { placeId: "p1", level: "busy", trajectory: "building" }), c);
    assert.ok("kept" in r);
    assert.equal(r.kept.interpretation, SIGNAL_INTERPRETATIONS.crowd_rising);
    assert.deepEqual(r.kept.effects.map((e) => e.kind), ["saved_idea_better_now", "queue_risk_later"]);
    assert.deepEqual(r.kept.effects[0].subjectIds, ["s1"]);
    assert.deepEqual(r.kept.relevance, ["saved_ideas", "goals", "location"]);
    const d = interpretSignal(sig("crowd_rising", "p9", { placeId: "p9", level: "packed", trajectory: "peaking" }), c);
    assert.ok("dropped" in d); assert.match(d.dropped.reason, /no saved idea or plan/);
    const q = interpretSignal(sig("crowd_rising", "p1", { placeId: "p1", level: "quiet", trajectory: "declining" }), c);
    assert.ok("dropped" in q); assert.match(q.dropped.reason, /not rising/);
  });
  it("rain arriving invalidates a weather-sensitive plan that day and names indoor saved ideas as the fallback; a dry day or an indoor day is dropped", () => {
    const plans = [
      { id: "walk", title: "Walking tour of Montmartre", category: "activity", startsAt: T("15:00"), endsAt: T("17:00"), weatherSensitive: true, point: null },
      { id: "museum", title: "Louvre", category: "activity", startsAt: T("10:00"), endsAt: T("12:00"), weatherSensitive: false, point: null },
    ];
    const c = ctx({ plans, savedIdeas: [{ id: "s1", placeId: null, placeType: "museum", name: "Musée d'Orsay", point: null }, { id: "s2", placeId: null, placeType: "park", name: "Jardin", point: null }] });
    const r = interpretSignal(sig("rain_arriving", "2026-09-13", { date: "2026-09-13", precipMm: 8, weatherCode: 61 }), c);
    assert.ok("kept" in r);
    assert.deepEqual(r.kept.effects.map((e) => e.kind), ["plan_invalidated", "fallback_opportunity"]);
    assert.deepEqual(r.kept.effects[0].subjectIds, ["walk"]);
    assert.deepEqual(r.kept.effects[1].subjectIds, ["s1"], "the park is not an indoor fallback");
    const dry = interpretSignal(sig("rain_arriving", "2026-09-13", { date: "2026-09-13", precipMm: 0, weatherCode: 1 }), c);
    assert.ok("dropped" in dry);
    const other = interpretSignal(sig("rain_arriving", "2026-09-14", { date: "2026-09-14", precipMm: 8, weatherCode: 61 }), c);
    assert.ok("dropped" in other); assert.match(other.dropped.reason, /no weather-sensitive plan on 2026-09-14/);
    assert.equal(looksWeatherSensitive("Rooftop drinks"), true); assert.equal(looksWeatherSensitive("Dinner at Chez Paul"), false);
  });
  it("taxi demand high → transport uncertainty on taxi-like segments and upcoming commitments within six hours; nothing affected → dropped", () => {
    const c = ctx({
      transport: [{ id: "t1", mode: "taxi", state: "planned", plannedDepartureAt: T("14:00") }, { id: "t2", mode: "metro", state: "planned", plannedDepartureAt: T("14:00") }, { id: "t3", mode: "taxi", state: "planned", plannedDepartureAt: T("23:00") }],
      commitments: [{ id: "c1", type: "dinner", startsAt: T("16:00"), requiredArrivalAt: null, placeId: null, eventId: null }, { id: "c2", type: "flight", startsAt: T("10:00", "14"), requiredArrivalAt: null, placeId: null, eventId: null }],
    });
    const r = interpretSignal(sig("taxi_demand_high", "z1", { zone: "z1", condition: "high_demand" }), c);
    assert.ok("kept" in r);
    assert.deepEqual(r.kept.effects[0].subjectIds, ["t1", "c1"], "the metro segment, the late taxi and tomorrow's flight are not affected");
    const none = interpretSignal(sig("taxi_demand_high", "z1", { zone: "z1", condition: "high_demand" }), ctx());
    assert.ok("dropped" in none);
    const normal = interpretSignal(sig("taxi_demand_high", "z1", { zone: "z1", condition: "normal" }), c);
    assert.ok("dropped" in normal);
  });
  it("event delayed → a free window may appear, and a later commitment may conflict; an event the trip is not going to → dropped", () => {
    const c = ctx({ commitments: [
      { id: "gig", type: "event", startsAt: T("20:00"), requiredArrivalAt: null, placeId: null, eventId: "ev1" },
      { id: "last-train", type: "transport", startsAt: T("23:30"), requiredArrivalAt: T("23:20"), placeId: null, eventId: null },
    ] });
    const r = interpretSignal(sig("event_delayed", "ev1", { eventId: "ev1", status: "delayed", delayMinutes: 90, newStartsAt: T("21:30") }), c);
    assert.ok("kept" in r);
    assert.deepEqual(r.kept.effects.map((e) => e.kind), ["free_window_may_appear", "downstream_conflict"]);
    assert.deepEqual(r.kept.effects[1].subjectIds, ["last-train"]);
    const cancelled = interpretSignal(sig("event_delayed", "ev1", { eventId: "ev1", status: "cancelled", delayMinutes: null, newStartsAt: null }), c);
    assert.ok("kept" in cancelled); assert.deepEqual(cancelled.kept.effects.map((e) => e.kind), ["free_window_may_appear"]);
    const d = interpretSignal(sig("event_delayed", "ev9", { eventId: "ev9", status: "delayed", delayMinutes: 30, newStartsAt: null }), c);
    assert.ok("dropped" in d);
  });
  it("friend nearby is surfaced only when BOTH parties share; a one-sided share is dropped with the privacy reason", () => {
    const yes = interpretSignal(sig("friend_nearby", "ana", { userId: "ana", distanceBand: "walking", bothSharing: true }), ctx());
    assert.ok("kept" in yes); assert.deepEqual(yes.kept.relevance, ["crew", "location"]); assert.equal(yes.kept.effects[0].kind, "meetup_opportunity");
    const no = interpretSignal(sig("friend_nearby", "ana", { userId: "ana", distanceBand: "walking", bothSharing: false }), ctx());
    assert.ok("dropped" in no); assert.match(no.dropped.reason, /TRIP_PRIVACY_SCOPE/);
    const stranger = interpretSignal(sig("friend_nearby", "zed", { userId: "zed", distanceBand: "nearby", bothSharing: true }), ctx());
    assert.ok("kept" in stranger); assert.deepEqual(stranger.kept.relevance, ["location"]);
  });
  it("§17.2 attention: SAFETY_EVENT drops everything, AT_RISK drops the discovery signals only, and the reason is TRIP_DISRUPTION_SUPPRESSED", () => {
    const c = ctx({ savedIdeas: [{ id: "s1", placeId: "p1", placeType: "bar", name: "Le Bar", point: null }], plans: [{ id: "walk", title: "Walk", category: "activity", startsAt: T("15:00"), endsAt: T("17:00"), weatherSensitive: true, point: null }] });
    const crowd = sig("crowd_rising", "p1", { placeId: "p1", level: "busy", trajectory: "building" });
    const rain = sig("rain_arriving", "2026-09-13", { date: "2026-09-13", precipMm: 8, weatherCode: 61 });
    const normal = projectSignals([crowd, rain], c);
    assert.equal(normal.kept.length, 2);
    const atRisk = projectSignals([crowd, rain], { ...c, attention: "AT_RISK" });
    assert.deepEqual(atRisk.kept.map((k) => k.kind), ["rain_arriving"]);
    assert.match(atRisk.dropped[0].reason, /^TRIP_DISRUPTION_SUPPRESSED/);
    const safety = projectSignals([crowd, rain], { ...c, attention: "SAFETY_EVENT" });
    assert.equal(safety.kept.length, 0); assert.ok(safety.dropped.every((d) => /^TRIP_DISRUPTION_SUPPRESSED/.test(d.reason)));
  });
  it("an expired estimate is dropped before interpretation; kept signals are ordered by confidence", () => {
    const c = ctx({ savedIdeas: [{ id: "s1", placeId: "p1", placeType: "bar", name: "Le Bar", point: null }, { id: "s2", placeId: "p2", placeType: "bar", name: "Bar 2", point: null }] });
    const old = sig("crowd_rising", "p1", { placeId: "p1", level: "busy", trajectory: "building" }, { expiresAt: T("11:00") });
    assert.ok("dropped" in interpretSignal(old, c));
    const lo = sig("crowd_rising", "p1", { placeId: "p1", level: "busy", trajectory: "building" }, { confidence: 0.3 });
    const hi = sig("crowd_rising", "p2", { placeId: "p2", level: "busy", trajectory: "building" }, { confidence: 0.9 });
    assert.deepEqual(projectSignals([lo, hi], c).kept.map((k) => k.subjectId), ["p2", "p1"]);
  });
});
