/**
 * IG-07 — Compass live-intel constraints, arrival forecast, explanation, Plan B.
 *
 * AT-14 "Hard accessibility constraint — ranking cannot override it", end to end
 * over a fixed candidate set + synthetic envelopes:
 *   • walk-in denied at the Live band EXCLUDES the top pick, whatever its score,
 *     and yields a same-category Plan B;
 *   • a below-Live band (emerging) NEVER excludes — a bounded nudge at most;
 *   • non-observation classes (prediction / pattern) and expired envelopes are
 *     never constraints, even when dressed as `state: 'live'`;
 *   • the arrival forecast flips exactly at the TTL boundary;
 *   • explanation lines carry the source-class label + cohort bucket and never
 *     an actor id or the raw claim ref;
 *   • gate off ⇒ the pipeline is byte-for-byte the pre-IG-07 pipeline and the
 *     read seam is never called.
 *
 * Runtime: node:test. Run: node --import tsx/esm --test src/test/compass-live-constraints.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runPipeline, type PipelineTestOverrides } from "../compass/CompassPipeline.js";
import type { CompassContext, CompassItem, CompassProfile } from "../compass/types.js";
import type { LiveClaimEnvelope } from "../lib/liveClaimRead.js";
import { PHASE1_CLAIM_TYPES, SOURCE_CLASS_LABELS } from "../lib/intelContracts.js";
import { buildWhyThisText } from "../compass/CompassRecommendationEngine.js";
import {
  COMPASS_LIVE_CONSTRAINTS_ENV,
  DEFAULT_QUEUE_TOLERANCE_MINUTES,
  EMERGING_SOFT_PENALTY,
  LIVE_DEMOTE_PENALTY,
  WALKING_SPEED_KMH,
  computePlanB,
  deriveViewerLiveTolerances,
  describeLiveIntelSource,
  etaMinutesForItem,
  evaluateLiveConstraints,
  forecastArrival,
  isLiveConstraintEligible,
  liveConstraintsEnabled,
  resolveLiveSubjects,
} from "../compass/CompassLiveConstraints.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = new Date("2026-09-04T20:00:00.000Z");
const NOW_MS = NOW.getTime();
const minutes = (n: number) => n * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const VIEWER_ID = "00000000-0000-0000-0000-0000000000a1";
/** A contributor id that must NEVER surface anywhere in Compass output. */
const ACTOR_ID = "deadbeef-dead-dead-dead-deadbeefdead";

const SUBJECT_A = "11111111-1111-4111-8111-111111111111";
const SUBJECT_B = "22222222-2222-4222-8222-222222222222";
const SUBJECT_C = "33333333-3333-4333-8333-333333333333";

function profile(overrides: Partial<CompassProfile> = {}): CompassProfile {
  return {
    userId: VIEWER_ID,
    preferredCities: ["Da Nang"],
    preferredLanguages: ["en"],
    budgetStyle: null,
    travelStyles: ["nightlife"],
    socialStyle: null,
    safetyPreference: "standard",
    visibilityPreference: "public",
    blockedUserIds: [],
    blockerUserIds: [],
    mutedUserIds: [],
    blockCount: 0,
    blockerCount: 0,
    trustScore: 60,
    trustLevel: "trusted_traveler",
    activeUserScore: null,
    hasActiveTrip: false,
    hasActiveBooking: false,
    upcomingTripWithin48h: false,
    hasFutureTripScheduled: false,
    currentCity: "Da Nang",
    currentCountry: "Vietnam",
    safeReturnActive: false,
    categoryWeights: null,
    ignoredItemIds: [],
    mutedHashtags: [],
    computedAt: NOW.toISOString(),
    ...overrides,
  };
}

function context(): CompassContext {
  return {
    contextState: "night_mode",
    signals: {
      hourUtc: 20,
      safeReturnActive: false,
      activeBooking: false,
      upcomingTripWithin48h: false,
      activeTripNow: false,
      hasPendingDelayedPosts: false,
      hasFutureTripScheduled: false,
    },
    computedAt: NOW.toISOString(),
  };
}

/** Three same-category bars (A > B > C by fixed score) plus one cafe. */
function candidates(): CompassItem[] {
  return [
    { id: "place:a", type: "place", category: "nightlife", contentBody: "Bar A", city: "Da Nang", visibilityScope: "public", placeId: SUBJECT_A, distanceKm: 1 },
    { id: "place:b", type: "place", category: "nightlife", contentBody: "Bar B", city: "Da Nang", visibilityScope: "public", placeId: SUBJECT_B, distanceKm: 1 },
    { id: "place:c", type: "place", category: "nightlife", contentBody: "Bar C", city: "Da Nang", visibilityScope: "public", placeId: SUBJECT_C, distanceKm: 1 },
    { id: "place:d", type: "place", category: "cafe", contentBody: "Cafe D", city: "Da Nang", visibilityScope: "public" },
  ];
}

const FIXED_SCORES: Record<string, number> = { "place:a": 90, "place:b": 70, "place:c": 50, "place:d": 40 };

/** Deterministic gates: everything passes safety/eligibility; scores are fixed. */
function baseOverrides(): PipelineTestOverrides {
  return {
    safetyFilter: () => ({ allowed: true }),
    eligibilityCheck: () => ({ eligible: true }),
    scoreItem: (item) => ({ finalScore: FIXED_SCORES[item.id] ?? 10, components: {} as any }),
  };
}

const TTL_BY_TYPE = new Map(PHASE1_CLAIM_TYPES.map((s) => [s.claimType, s.ttlSeconds] as const));

/** A synthetic served envelope. Live band by default; observed 5 min ago; valid 25 min. */
function envelope(over: Partial<LiveClaimEnvelope> & { claimType: string; value: unknown }): LiveClaimEnvelope {
  const band = over.band ?? "live";
  return {
    id: over.id ?? `snap-${over.claimType}-${Math.random().toString(36).slice(2, 8)}`,
    claimType: over.claimType,
    value: over.value,
    confidence: over.confidence ?? (band === "strong" ? 0.92 : band === "live" ? 0.8 : band === "likely_current" ? 0.6 : 0.4),
    band,
    sourceClass: over.sourceClass ?? "firsthand_unverified",
    sourceCountBucket: over.sourceCountBucket === undefined ? "few" : over.sourceCountBucket,
    observedAt: over.observedAt ?? iso(NOW_MS - minutes(5)),
    validUntil: over.validUntil ?? iso(NOW_MS + minutes(25)),
    state: over.state ?? (band === "live" || band === "strong" ? "live" : "emerging"),
  };
}

function liveOverrides(
  bySubject: Record<string, LiveClaimEnvelope[]>,
  extra: Partial<NonNullable<PipelineTestOverrides["liveIntel"]>> = {},
): PipelineTestOverrides {
  const calls: string[] = [];
  const o: PipelineTestOverrides = {
    ...baseOverrides(),
    liveIntel: {
      enabled: true,
      now: NOW,
      resolveSubjects: async (items) => {
        const m = new Map<string, string>();
        for (const i of items) if (typeof i.placeId === "string") m.set(i.id, i.placeId);
        return m;
      },
      readEnvelopes: async (subjectId) => { calls.push(subjectId); return bySubject[subjectId] ?? []; },
      ttlSecondsFor: async (ct) => TTL_BY_TYPE.get(ct) ?? null,
      ...extra,
    },
  };
  (o as any).__calls = calls;
  return o;
}

// ── Gate ──────────────────────────────────────────────────────────────────────

describe("IG-07 gate — env-guarded constant, default OFF", () => {
  it("is off unless the env var is literally 'true'", () => {
    assert.equal(liveConstraintsEnabled({}), false);
    assert.equal(liveConstraintsEnabled({ [COMPASS_LIVE_CONSTRAINTS_ENV]: "1" }), false);
    assert.equal(liveConstraintsEnabled({ [COMPASS_LIVE_CONSTRAINTS_ENV]: "yes" }), false);
    assert.equal(liveConstraintsEnabled({ [COMPASS_LIVE_CONSTRAINTS_ENV]: "TRUE" }), true);
    assert.equal(liveConstraintsEnabled({ [COMPASS_LIVE_CONSTRAINTS_ENV]: " true " }), true);
  });

  it("with the gate off the pipeline never calls the read seam and output equals the pre-IG-07 shape", async () => {
    const o = liveOverrides({ [SUBJECT_A]: [envelope({ claimType: "access.walk_in", value: { accepted: false } })] }, { enabled: false });
    const out = await runPipeline(candidates(), profile(), context(), null, o);
    assert.deepEqual((o as any).__calls, []);
    assert.equal(out.liveConstraints.ran, false);
    assert.equal(out.liveExcludedCount, 0);
    assert.deepEqual(out.results.map((r) => r.item.id), ["place:a", "place:b", "place:c", "place:d"]);
    assert.ok(out.results.every((r) => r.liveIntel === undefined));
    assert.deepEqual(out.liveConstraints.planB, []);
  });

  it("with the gate on but no reader and no DB, the stage does not run (fail-closed)", async () => {
    const o: PipelineTestOverrides = { ...baseOverrides(), liveIntel: { enabled: true, now: NOW } };
    const out = await runPipeline(candidates(), profile(), context(), null, o);
    assert.equal(out.liveConstraints.ran, false);
    assert.equal(out.results.length, 4);
  });
});

// ── AT-14: hard constraint before ranking ─────────────────────────────────────

describe("AT-14 — a Live walk-in denial is a hard constraint ranking cannot override", () => {
  it("excludes the top-scoring pick and surfaces the next-best same-category Plan B", async () => {
    const denied = envelope({ id: "snap-walkin-a", claimType: "access.walk_in", value: { accepted: false } });
    const o = liveOverrides({ [SUBJECT_A]: [denied] });
    const out = await runPipeline(candidates(), profile(), context(), null, o);

    assert.equal(out.liveConstraints.ran, true);
    assert.deepEqual(out.results.map((r) => r.item.id), ["place:b", "place:c", "place:d"], "A (score 90) is gone");
    assert.equal(out.liveExcludedCount, 1);
    assert.equal(out.passedCount, 3);
    const ex = out.liveConstraints.excluded[0]!;
    assert.equal(ex.itemId, "place:a");
    assert.equal(ex.decision.kind, "exclude");
    assert.equal(ex.decision.reasonCode, "walk_in_denied");
    assert.equal(ex.decision.claimRef, "snap-walkin-a");

    assert.equal(out.liveConstraints.planB.length, 1);
    const pb = out.liveConstraints.planB[0]!;
    assert.equal(pb.forItemId, "place:a");
    assert.equal(pb.alternativeItemId, "place:b", "next-best in the same category");
    assert.equal(pb.alternativeRank, 0);
    assert.equal(pb.category, "place:nightlife");
    assert.equal(pb.reasonCode, "walk_in_denied");
    assert.match(pb.reason, /walk-ins are not being accepted/i);
  });

  it("the exclusion happens BEFORE scoring — scoreItem is never called for the excluded item", async () => {
    const scoredIds: string[] = [];
    const o = liveOverrides({ [SUBJECT_A]: [envelope({ claimType: "access.walk_in", value: { accepted: false } })] });
    o.scoreItem = (item) => { scoredIds.push(item.id); return { finalScore: FIXED_SCORES[item.id] ?? 10, components: {} as any }; };
    await runPipeline(candidates(), profile(), context(), null, o);
    assert.ok(!scoredIds.includes("place:a"), "an excluded candidate must never reach the scoring engine");
    assert.deepEqual(scoredIds, ["place:b", "place:c", "place:d"]);
  });

  it("a strong-band official walk-in denial also excludes, with the official label and no cohort badge", async () => {
    const official = envelope({ claimType: "access.walk_in", value: { accepted: false }, band: "strong", sourceClass: "official_signed", sourceCountBucket: null });
    const o = liveOverrides({ [SUBJECT_A]: [official] });
    const out = await runPipeline(candidates(), profile(), context(), null, o);
    assert.equal(out.liveExcludedCount, 1);
    const ex = out.liveConstraints.excluded[0]!.decision;
    assert.equal(ex.sourceLabel, SOURCE_CLASS_LABELS.official_signed);
    assert.equal(ex.sourceCountBucket, null);
  });

  it("walk-ins ACCEPTED is not a constraint — the item stays and cites the intel", async () => {
    const ok = envelope({ claimType: "access.walk_in", value: { accepted: true } });
    const o = liveOverrides({ [SUBJECT_A]: [ok] });
    const out = await runPipeline(candidates(), profile(), context(), null, o);
    assert.deepEqual(out.results.map((r) => r.item.id), ["place:a", "place:b", "place:c", "place:d"]);
    assert.equal(out.results[0]!.liveIntel?.constraint, null);
    assert.ok(out.results[0]!.rankingFactors.some((f) => f.key === "live_intel:access.walk_in"));
    assert.deepEqual(out.liveConstraints.planB, []);
  });
});

// ── Below-Live band never excludes ────────────────────────────────────────────

describe("truth boundary — below the Live band is never a hard fact", () => {
  it("an 'emerging' (likely_current) walk-in denial does NOT exclude; it nudges by EMERGING_SOFT_PENALTY", async () => {
    const emerging = envelope({ claimType: "access.walk_in", value: { accepted: false }, band: "likely_current", confidence: 0.6, state: "emerging" });
    const o = liveOverrides({ [SUBJECT_A]: [emerging] });
    const out = await runPipeline(candidates(), profile(), context(), null, o);
    assert.equal(out.liveExcludedCount, 0);
    assert.equal(out.results[0]!.item.id, "place:a", "still the top pick");
    assert.equal(out.results[0]!.finalScore, 90 - EMERGING_SOFT_PENALTY);
    assert.equal(out.results[0]!.liveIntel?.constraint, null);
    assert.equal(out.results[0]!.liveIntel?.soft.length, 1);
    assert.equal(out.results[0]!.liveIntel?.soft[0]!.reasonCode, "walk_in_denied");
    assert.deepEqual(out.liveConstraints.planB, []);
  });

  it("a provisional/unverified envelope has no influence at all", async () => {
    const weak = envelope({ claimType: "access.walk_in", value: { accepted: false }, band: "provisional", confidence: 0.4, state: "emerging" });
    const o = liveOverrides({ [SUBJECT_A]: [weak] });
    const out = await runPipeline(candidates(), profile(), context(), null, o);
    assert.equal(out.results[0]!.item.id, "place:a");
    assert.equal(out.results[0]!.finalScore, 90);
  });

  it("a prediction or historical pattern dressed as state:'live' is never a constraint", () => {
    for (const sourceClass of ["portava_prediction", "historical_pattern"] as const) {
      const hostile = envelope({ claimType: "access.walk_in", value: { accepted: false }, band: "strong", sourceClass, state: "live" });
      assert.equal(isLiveConstraintEligible(hostile, NOW_MS), false, sourceClass);
      const ev = evaluateLiveConstraints([hostile], { maxQueueWaitMinutes: 30, intent: null }, NOW_MS);
      assert.equal(ev.exclusion, null);
      assert.deepEqual(ev.demotions, []);
      assert.deepEqual(ev.soft, []);
    }
  });

  it("an expired envelope is never a constraint, whatever its band", () => {
    const stale = envelope({ claimType: "access.walk_in", value: { accepted: false }, band: "strong", validUntil: iso(NOW_MS - 1) });
    assert.equal(isLiveConstraintEligible(stale, NOW_MS), false);
    const ev = evaluateLiveConstraints([stale], { maxQueueWaitMinutes: 30, intent: null }, NOW_MS);
    assert.equal(ev.exclusion, null);
    assert.equal(ev.penalty, 0);
  });

  it("a band/state mismatch (state 'live' on a likely_current band) is refused", () => {
    const mismatch = envelope({ claimType: "access.walk_in", value: { accepted: false }, band: "likely_current", state: "live" });
    assert.equal(isLiveConstraintEligible(mismatch, NOW_MS), false);
  });
});

// ── Demotions: queue tolerance and packed-vs-quiet ────────────────────────────

describe("demotions — queue above tolerance, packed vs quiet intent", () => {
  it("a Live queue above the viewer's tolerance demotes by LIVE_DEMOTE_PENALTY, never excludes", async () => {
    const line = envelope({ claimType: "queue.wait", value: { minMinutes: 40, maxMinutes: null } });
    const o = liveOverrides({ [SUBJECT_A]: [line] });
    const out = await runPipeline(candidates(), profile(), context(), null, o);
    assert.equal(out.liveExcludedCount, 0);
    const a = out.results.find((r) => r.item.id === "place:a")!;
    assert.equal(a.finalScore, 90 - LIVE_DEMOTE_PENALTY);
    assert.equal(a.liveIntel?.constraint?.kind, "demote");
    assert.equal(a.liveIntel?.constraint?.reasonCode, "queue_exceeds_tolerance");
    assert.match(a.liveIntel!.constraint!.reason, new RegExp(`${DEFAULT_QUEUE_TOLERANCE_MINUTES}-minute`));
    // A (75) still beats B (70): the demotion did not change the pick ⇒ no Plan B.
    assert.equal(out.results[0]!.item.id, "place:a");
    assert.deepEqual(out.liveConstraints.planB, []);
    assert.equal(out.liveConstraints.demoted.length, 1);
  });

  it("when the demotion flips the category order, Plan B names the new leader", async () => {
    const line = envelope({ claimType: "queue.wait", value: { minMinutes: 20, maxMinutes: 40 } });
    const o = liveOverrides({ [SUBJECT_A]: [line] });
    // Bring B within LIVE_DEMOTE_PENALTY of A so the demotion flips the order.
    o.scoreItem = (item) => ({ finalScore: item.id === "place:b" ? 85 : FIXED_SCORES[item.id] ?? 10, components: {} as any });
    const out = await runPipeline(candidates(), profile(), context(), null, o);
    assert.deepEqual(out.results.slice(0, 2).map((r) => r.item.id), ["place:b", "place:a"]);
    assert.equal(out.liveConstraints.planB.length, 1);
    assert.equal(out.liveConstraints.planB[0]!.forItemId, "place:a");
    assert.equal(out.liveConstraints.planB[0]!.alternativeItemId, "place:b");
    assert.equal(out.liveConstraints.planB[0]!.reasonCode, "queue_exceeds_tolerance");
  });

  it("a queue within tolerance is not a constraint", () => {
    const short = envelope({ claimType: "queue.wait", value: { minMinutes: 10, maxMinutes: 20 } });
    const ev = evaluateLiveConstraints([short], { maxQueueWaitMinutes: 30, intent: null }, NOW_MS);
    assert.deepEqual(ev.demotions, []);
    assert.equal(ev.penalty, 0);
  });

  it("'packed' demotes only for a viewer with a quiet intent", () => {
    const packed = envelope({ claimType: "crowd.level", value: { level: "packed" } });
    const quiet = evaluateLiveConstraints([packed], { maxQueueWaitMinutes: 30, intent: "quiet" }, NOW_MS);
    assert.equal(quiet.demotions.length, 1);
    assert.equal(quiet.demotions[0]!.reasonCode, "packed_vs_quiet_intent");
    assert.equal(quiet.penalty, LIVE_DEMOTE_PENALTY);
    const lively = evaluateLiveConstraints([packed], { maxQueueWaitMinutes: 30, intent: null }, NOW_MS);
    assert.deepEqual(lively.demotions, []);
    assert.equal(lively.penalty, 0);
  });

  it("quiet intent is derived from travel-style tokens", () => {
    assert.equal(deriveViewerLiveTolerances({ travelStyles: ["Quiet", "culture"] }).intent, "quiet");
    assert.equal(deriveViewerLiveTolerances({ travelStyles: ["nightlife"] }).intent, null);
    assert.equal(deriveViewerLiveTolerances({ travelStyles: [] }).maxQueueWaitMinutes, DEFAULT_QUEUE_TOLERANCE_MINUTES);
  });

  it("an exclusion wins over demotions and carries no penalty (there is nothing to score)", () => {
    const ev = evaluateLiveConstraints(
      [
        envelope({ claimType: "queue.wait", value: { minMinutes: 60, maxMinutes: null } }),
        envelope({ claimType: "access.walk_in", value: { accepted: false } }),
      ],
      { maxQueueWaitMinutes: 30, intent: null },
      NOW_MS,
    );
    assert.equal(ev.exclusion?.reasonCode, "walk_in_denied");
    assert.equal(ev.penalty, 0);
  });
});

// ── Arrival forecast ──────────────────────────────────────────────────────────

describe("arrival forecast — flips exactly at the TTL boundary, labelled a prediction", () => {
  const observedAt = iso(NOW_MS - minutes(10));
  // Projection says valid for 60 more minutes; the crowd.level TTL (45 min) says
  // observedAt + 45 = now + 35. The EARLIER horizon wins: now + 35.
  const live = envelope({ claimType: "crowd.level", value: { level: "busy" }, observedAt, validUntil: iso(NOW_MS + minutes(60)) });
  const ttl = TTL_BY_TYPE.get("crowd.level")!;

  it("arrival before the horizon ⇒ likely_still; at/after ⇒ may_have_changed", () => {
    assert.equal(forecastArrival(live, 34, NOW_MS, ttl)?.label, "likely_still");
    assert.equal(forecastArrival(live, 35, NOW_MS, ttl)?.label, "may_have_changed", "inclusive boundary (matches isStale)");
    assert.equal(forecastArrival(live, 36, NOW_MS, ttl)?.label, "may_have_changed");
    assert.equal(forecastArrival(live, 35, NOW_MS, ttl)?.horizonAt, iso(NOW_MS + minutes(35)));
  });

  it("with no policy TTL the horizon is validUntil alone", () => {
    assert.equal(forecastArrival(live, 59, NOW_MS, null)?.label, "likely_still");
    assert.equal(forecastArrival(live, 60, NOW_MS, null)?.label, "may_have_changed");
  });

  it("forecast text is labelled a Portava prediction and names the ETA", () => {
    const f = forecastArrival(live, 12, NOW_MS, ttl)!;
    assert.ok(f.text.startsWith(SOURCE_CLASS_LABELS.portava_prediction + ":"), f.text);
    assert.match(f.text, /likely still busy right now at arrival \(~12 min away\)/);
    const g = forecastArrival(live, 40, NOW_MS, ttl)!;
    assert.match(g.text, /may have changed by arrival \(~40 min away\)/);
  });

  it("no forecast for a below-Live envelope or without an ETA", () => {
    const emerging = envelope({ claimType: "crowd.level", value: { level: "busy" }, band: "likely_current", state: "emerging" });
    assert.equal(forecastArrival(emerging, 5, NOW_MS, ttl), null);
    assert.equal(etaMinutesForItem({ id: "x", type: "place" }), null);
  });

  it("ETA is a walking-speed estimate from distanceKm, or the explicit etaMinutes when set", () => {
    assert.equal(etaMinutesForItem({ id: "x", type: "place", distanceKm: 1 }), Math.ceil(60 / WALKING_SPEED_KMH));
    assert.equal(etaMinutesForItem({ id: "x", type: "place", distanceKm: 1, etaMinutes: 3 }), 3);
    assert.equal(etaMinutesForItem({ id: "x", type: "place", distanceKm: -1 }), null);
  });

  it("through the pipeline the forecast rides on the item's annotation and its 'Why this' detail", async () => {
    const o = liveOverrides({ [SUBJECT_A]: [live] });
    const out = await runPipeline(candidates(), profile(), context(), null, o);
    const a = out.results.find((r) => r.item.id === "place:a")!;
    assert.equal(a.liveIntel?.forecasts.length, 1);
    assert.equal(a.liveIntel?.forecasts[0]!.label, "likely_still"); // 1 km ⇒ 12 min < 35
    const factor = a.rankingFactors.find((f) => f.key === "live_intel:crowd.level")!;
    assert.match(factor.detail ?? "", /Portava prediction: likely still/);
  });
});

// ── Explanation ───────────────────────────────────────────────────────────────

describe("explanation — cites source-class label + cohort bucket, never identity", () => {
  it("'Why this' carries the label and cohort bucket and no actor id or raw claim ref", async () => {
    const env = envelope({ id: "snap-ref-0001", claimType: "access.walk_in", value: { accepted: true }, sourceCountBucket: "several" });
    // A hostile envelope that smuggles identity fields: none may reach any text.
    (env as any).actorId = ACTOR_ID;
    (env as any).contributor = { id: ACTOR_ID, handle: "@someone" };
    const o = liveOverrides({ [SUBJECT_A]: [env] });
    const out = await runPipeline(candidates(), profile(), context(), null, o);
    const a = out.results.find((r) => r.item.id === "place:a")!;

    const why = buildWhyThisText(a.rankingFactors)!;
    assert.ok(why.includes(SOURCE_CLASS_LABELS.firsthand_unverified.toLowerCase()) || why.includes(SOURCE_CLASS_LABELS.firsthand_unverified), why);
    assert.match(why, /several recent traveler reports/i);

    const allText = [why, ...a.liveIntel!.lines, ...a.rankingFactors.map((f) => `${f.label} ${f.detail ?? ""}`)].join("\n");
    assert.ok(!allText.includes(ACTOR_ID), "actor id leaked into explanation text");
    assert.ok(!allText.includes("@someone"), "contributor handle leaked into explanation text");
    assert.ok(!allText.includes("snap-ref-0001"), "raw claim ref must be a field, not prose");
    assert.equal(a.liveIntel!.factors[0]!.key, "live_intel:access.walk_in");
    assert.equal(a.liveIntel!.forecasts[0]!.claimRef, "snap-ref-0001", "provenance ref is carried as a field");
  });

  it("official / sponsored sources get their label and NO cohort phrase", () => {
    assert.equal(describeLiveIntelSource({ sourceClass: "official_signed", sourceCountBucket: null }), SOURCE_CLASS_LABELS.official_signed);
    assert.equal(describeLiveIntelSource({ sourceClass: "sponsored", sourceCountBucket: null }), SOURCE_CLASS_LABELS.sponsored);
    assert.equal(
      describeLiveIntelSource({ sourceClass: "verified_firsthand", sourceCountBucket: "many" }),
      `${SOURCE_CLASS_LABELS.verified_firsthand} · many recent traveler reports`,
    );
  });

  it("an unrecognised source class is 'Source not attributed', never a traveler", () => {
    assert.equal(describeLiveIntelSource({ sourceClass: "made_up" as any, sourceCountBucket: null }), "Source not attributed");
  });

  it("a demotion adds a 'Heads-up' caveat factor and line", async () => {
    const line = envelope({ claimType: "queue.wait", value: { minMinutes: 40, maxMinutes: null } });
    const o = liveOverrides({ [SUBJECT_A]: [line] });
    const out = await runPipeline(candidates(), profile(), context(), null, o);
    const a = out.results.find((r) => r.item.id === "place:a")!;
    assert.ok(a.rankingFactors.some((f) => f.key === "live_caveat:queue_exceeds_tolerance"));
    assert.ok(a.liveIntel!.lines.some((l) => /^Heads-up: 40\+ min line reported/.test(l)), a.liveIntel!.lines.join(" | "));
  });
});

// ── Plan B (pure) ─────────────────────────────────────────────────────────────

describe("Plan B — same category first, type as fallback, capped", () => {
  const decision = {
    kind: "exclude" as const, reasonCode: "walk_in_denied" as const, reason: "r", penalty: 0,
    claimRef: "s", claimType: "access.walk_in", sourceClass: "firsthand_unverified" as const,
    sourceLabel: SOURCE_CLASS_LABELS.firsthand_unverified, band: "live" as const, sourceCountBucket: "few" as const,
    observedAt: iso(NOW_MS), validUntil: iso(NOW_MS + 1),
  };

  it("falls back to the coarse type when no fine-category alternative exists", () => {
    const bar: CompassItem = { id: "bar", type: "place", category: "nightlife" };
    const cafe: CompassItem = { id: "cafe", type: "place", category: "cafe" };
    const out = computePlanB(
      [{ item: bar, decision, finalScore: null, unconstrainedScore: null }],
      [{ item: cafe, finalScore: 10, hasHardConstraint: false }],
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]!.alternativeItemId, "cafe");
  });

  it("never proposes a hard-constrained item as the alternative", () => {
    const a: CompassItem = { id: "a", type: "place", category: "nightlife" };
    const b: CompassItem = { id: "b", type: "place", category: "nightlife" };
    const out = computePlanB(
      [{ item: a, decision, finalScore: null, unconstrainedScore: null }],
      [{ item: b, finalScore: 10, hasHardConstraint: true }],
    );
    assert.deepEqual(out, []);
  });

  it("a demotion that did not change the pick yields no Plan B", () => {
    const a: CompassItem = { id: "a", type: "place", category: "nightlife" };
    const b: CompassItem = { id: "b", type: "place", category: "nightlife" };
    const out = computePlanB(
      [{ item: a, decision: { ...decision, kind: "demote", penalty: LIVE_DEMOTE_PENALTY }, finalScore: 75, unconstrainedScore: 90 }],
      [{ item: a, finalScore: 75, hasHardConstraint: true }, { item: b, finalScore: 70, hasHardConstraint: false }],
    );
    assert.deepEqual(out, []);
  });
});

// ── Subject resolution + containment ──────────────────────────────────────────

describe("subject resolution — canonical places(id) only", () => {
  const DP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const CANON_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const POST_PLACE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  function db(rows: Array<{ id: string; canonical_location_id: string | null }>, opts: { throws?: boolean } = {}) {
    const seen: { table?: string; ids?: string[] } = {};
    return {
      seen,
      from(table: string) {
        seen.table = table;
        return {
          select: () => ({
            in: async (_col: string, ids: string[]) => {
              seen.ids = ids;
              if (opts.throws) throw new Error("boom");
              return { data: rows, error: null };
            },
          }),
        };
      },
    };
  }

  it("bridges place / discovery items through discovery_places.canonical_location_id and passes posts through", async () => {
    const d = db([{ id: DP_A, canonical_location_id: CANON_A }]);
    const out = await resolveLiveSubjects(d as any, [
      { id: "place:x", type: "place", placeId: DP_A },
      { id: `discovery:${DP_A}`, type: "suggestion" },
      { id: "post:1", type: "post", placeId: POST_PLACE },
      { id: "gem:1", type: "hidden_gem", placeId: DP_A },
      { id: "explicit", type: "event", canonicalPlaceId: CANON_A },
    ]);
    assert.equal(out.get("place:x"), CANON_A);
    assert.equal(out.get(`discovery:${DP_A}`), CANON_A);
    assert.equal(out.get("post:1"), POST_PLACE);
    assert.equal(out.get("gem:1"), undefined, "hidden_gems have no canonical link");
    assert.equal(out.get("explicit"), CANON_A);
    assert.equal(d.seen.table, "discovery_places");
    assert.deepEqual(d.seen.ids, [DP_A]);
  });

  it("an unreadable bridge resolves to no subject (no constraint), never a wrong one", async () => {
    const out = await resolveLiveSubjects(db([], { throws: true }) as any, [{ id: "place:x", type: "place", placeId: DP_A }]);
    assert.equal(out.size, 0);
    const none = await resolveLiveSubjects(db([{ id: DP_A, canonical_location_id: null }]) as any, [{ id: "place:x", type: "place", placeId: DP_A }]);
    assert.equal(none.size, 0);
  });

  it("a throwing read seam is contained per subject — the item is 'unknown', the pipeline survives", async () => {
    const o = liveOverrides({ [SUBJECT_B]: [envelope({ claimType: "access.walk_in", value: { accepted: false } })] }, {
      readEnvelopes: async (subjectId) => {
        if (subjectId === SUBJECT_A) throw new Error("seam down");
        return subjectId === SUBJECT_B ? [envelope({ claimType: "access.walk_in", value: { accepted: false } })] : [];
      },
    });
    const out = await runPipeline(candidates(), profile(), context(), null, o);
    assert.equal(out.liveConstraints.ran, true);
    assert.ok(out.results.some((r) => r.item.id === "place:a"), "A is unknown, not excluded");
    assert.ok(!out.results.some((r) => r.item.id === "place:b"), "B's Live denial still excludes");
    assert.equal(out.liveConstraints.planB[0]?.forItemId, "place:b");
    assert.equal(out.liveConstraints.planB[0]?.alternativeItemId, "place:a");
  });
});
