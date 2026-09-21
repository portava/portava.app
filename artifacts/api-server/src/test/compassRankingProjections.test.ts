/**
 * census-compass CCL-05 — the shared projections reach the RANKING owner.
 *
 * `docs/specs/upgrades-v2/01-COMPASS-v2.md:13`: authorized request → EXISTING
 * context assembly → shared world/experience/forecast/opportunity projections
 * → EXISTING decision/ranking owner → grounded explanation → EXISTING
 * UI/action contract.
 *
 * §26.3 of the census closed the first half and named what was left, verbatim:
 * "The shared projections now sit between context assembly and the MODEL …
 * *The ranking owner, `CompassPipeline`, still ranks without them.*" This suite
 * is about that sentence and nothing else: the kernel — and, behind its own
 * flag, the opportunity projections — must reach `runPipeline` and CHANGE the
 * order it returns, as a named, bounded ranking factor of the same shape the
 * pipeline already consumes from `worldModelBoostForItem`.
 *
 * TEST-FIRST. Written and run before a line of the implementation existed. The
 * first run failed at import — `runWithAskProjections`, `currentAskProjections`,
 * `kernelRankingForItem` and `KERNEL_WORLD_BOOST_MAX` did not exist — and the
 * state it was failing ON was measured directly against the ranker as it then
 * stood: the two candidates below came back from `runPipeline` at 87.5339 and
 * 87.5339, identical to eight decimal places, carrying only interest_match /
 * city_match / language_match, under every kernel. M1 below re-creates exactly
 * that state and the suite goes red again.
 *
 * What each block pins:
 *   1. BEHAVIOUR  the same candidate set, ranked under two kernels that differ
 *      only in the declared intent, comes back in the OPPOSITE order — the
 *      proof that the projections reach the ranker and not merely the prompt.
 *   2. HONESTY    no projections, an unreadable world, a subject the kernel
 *      does not carry, or no declared crowd preference ⇒ zero boost and NO
 *      factor. A fabricated "why" is worse than a missing one.
 *   3. SAFETY     a safety-suppressed subject is never promoted (Sensing §20:
 *      "Safety suppression/constraint must win over opportunity promotion").
 *   4. FORECAST   the forecast projection ranks too, and says it is predicted.
 *   5. FLAG       the opportunity half moves the rank only when the caller
 *      supplied opportunities, which the route does only behind the literal
 *      `opportunity_engine_enabled`; the kernel half is NOT behind it.
 *   6. WIRING     end to end: inside `/compass/ask`'s tool-calling loop — the
 *      exact async depth where CompassTools calls `runPipeline` — the shared
 *      projections are ambient, carrying the place the ranker named.
 *
 * Mutation log (each applied ALONE, whole suite run, source restored):
 *   M1 kernel boost dropped from the pipeline's finalScore            → red (4)
 *   M2 the `readable` guard removed — a reading the gates did not
 *      allow becomes a ranking factor                                 → red (1)
 *   M3 the safety-suppression guard removed from the annotation       → red (1)
 *   M4 the forecast addend dropped (forecastFit forced to null)       → red (1)
 *   M5 the route builds the opportunity half without reading
 *      `opportunity_engine_enabled`                                   → red (2)
 *   M6 the route stops establishing the projections around the
 *      tool-calling loop (withAskProjections → fn())                  → red (3)
 *   M7 the world boost unbounded (× 40 instead of the stated max)     → red (2)
 *   M8 any decision promotes, not only GO_NOW / GO_SOON               → GREEN
 *      first, then red. Reported as run: the Opportunity Engine REFUSES a
 *      subject it will not promote rather than projecting it, so the engine's
 *      own output never exercised the filter. The suite now also pins it on a
 *      constructed WAIT projection, and the same mutation is red.
 *   M9 the `reachable` guard removed — a GO the viewer cannot reach
 *      still promotes                                                 → red (1)
 *
 * NOT mutation-detectable, and stated rather than claimed: the `place:` prefix
 * strip in `subjectKeysFor` (today's ask path hands the ranker bare place ids,
 * so it is defence for the feed's item keys, not a live seam).
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/compassRankingProjections.test.ts
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestOpenAI } from "../lib/openai.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import { _clearCompassHomeCache } from "../routes/compassHome.js";

import { runPipeline } from "../compass/CompassPipeline.js";
import {
  currentAskProjections,
  runWithAskProjections,
  type AskRankingProjections,
} from "../compass/CompassPlatformContext.js";
import {
  KERNEL_FORECAST_BOOST_MAX,
  KERNEL_OPPORTUNITY_BOOST_MAX,
  KERNEL_WORLD_BOOST_MAX,
  kernelRankingForItem,
} from "../compass/CompassScoringEngine.js";
import { assembleContextKernel, type ContextKernel, type SubjectWorldContext } from "../lib/contextKernel.js";
import { buildCrowdState, envelopeTemporal } from "../lib/crowdState.js";
import { buildForecastState } from "../lib/forecastState.js";
import { truthOfEnvelopes } from "../lib/liveEnvelopeTruth.js";
import { buildOpportunities, projectForSurface } from "../lib/opportunityEngine.js";
import { isEmergingInfluenceEligible, isLiveConstraintEligible } from "../compass/CompassLiveConstraints.js";
import type { LiveClaimEnvelope } from "../lib/liveClaimRead.js";
import type { DecisionIntent } from "../lib/compassDecision.js";
import type { CompassContext, CompassItem, CompassProfile } from "../compass/types.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const NOW = Date.now();
const iso = (offsetMinutes: number) => new Date(NOW + offsetMinutes * 60_000).toISOString();

const QUIET_SUBJECT  = "11111111-1111-4111-8111-111111111111";
const PACKED_SUBJECT = "22222222-2222-4222-8222-222222222222";
const ALICE_ID       = "00000000-0000-0000-0000-0000000000a1";
const CAROL_ID       = "00000000-0000-0000-0000-0000000000c3";

// ── Fixtures: the shape lib/contextKernelRead builds, without a database ─────

let seq = 0;
function env(over: Partial<LiveClaimEnvelope> = {}): LiveClaimEnvelope {
  seq += 1;
  return {
    id: `snap-${seq}`,
    claimType: "crowd.level",
    value: { level: "busy" },
    confidence: 0.85,
    band: "live",
    sourceClass: "firsthand_unverified",
    sourceCountBucket: "few",
    observedAt: iso(-3),
    validUntil: iso(27),
    state: "live",
    conflictState: "none",
    conflict: null,
    ...over,
  };
}
const level = (l: string) => env({ claimType: "crowd.level", value: { level: l } });
const traj  = (t: string) => env({ claimType: "crowd.trajectory", value: { trajectory: t } });

function world(subjectId: string, envelopes: LiveClaimEnvelope[], readable = true): SubjectWorldContext {
  const crowd = buildCrowdState({ envelopes: readable ? envelopes : [], qualifies: isLiveConstraintEligible }, NOW);
  const f = buildForecastState({ crowd, horizonMinutes: 60, calibration: null }, NOW);
  const usable = (readable ? envelopes : []).filter(
    (e) => isLiveConstraintEligible(e, NOW) || isEmergingInfluenceEligible(e, NOW),
  );
  return {
    subjectId,
    readable,
    crowd,
    forecast: f.forecast,
    forecastRefused: f.refused,
    envelopes: readable ? envelopes : [],
    truth: truthOfEnvelopes(usable, NOW),
    evidenceWindow: envelopeTemporal(usable, NOW),
  };
}

function kernelFor(subjects: SubjectWorldContext[], intent: DecisionIntent | null): ContextKernel {
  const etaMinutesBySubject: Record<string, number | null> = {};
  for (const s of subjects) etaMinutesBySubject[s.subjectId] = 10;
  return assembleContextKernel(
    {
      user: { intent, queueToleranceMinutes: null, relevance: "saved" },
      utcOffsetMinutes: 540,
      spatial: { viewerPositionKnown: true, etaMinutesBySubject },
      attention: { available: true, deliveredInWindow: 0, budgetPerWindow: 3, seenIds: [] },
      subjects,
    },
    NOW,
  );
}

/** The two candidates differ ONLY in which subject they are, so the kernel decides. */
const TWO_PLACES: SubjectWorldContext[] = [world(QUIET_SUBJECT, [level("quiet")]), world(PACKED_SUBJECT, [level("packed")])];

function projections(intent: DecisionIntent | null, over: Partial<AskRankingProjections> = {}): AskRankingProjections {
  return { kernel: kernelFor(TWO_PLACES, intent), readable: true, ...over };
}

function baseProfile(overrides: Partial<CompassProfile> = {}): CompassProfile {
  return {
    userId: ALICE_ID,
    preferredCities: ["Tokyo"],
    preferredLanguages: ["en"],
    budgetStyle: null,
    travelStyles: ["adventure", "culture"],
    socialStyle: "solo",
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
    currentCity: "Tokyo",
    currentCountry: "Japan",
    safeReturnActive: false,
    computedAt: new Date(NOW).toISOString(),
    ...overrides,
  } as CompassProfile;
}

function baseContext(): CompassContext {
  return {
    contextState: "exploring_now" as CompassContext["contextState"],
    signals: {
      hourUtc: 14,
      safeReturnActive: false,
      activeBooking: false,
      upcomingTripWithin48h: false,
      activeTripNow: false,
      hasPendingDelayedPosts: false,
      hasFutureTripScheduled: false,
    },
    computedAt: new Date(NOW).toISOString(),
  } as CompassContext;
}

/** Identical in every scored field — id (the kernel's subject) is the only difference. */
function candidate(id: string): CompassItem {
  return {
    id,
    type: "suggestion",
    authorId: CAROL_ID,
    city: "Tokyo",
    createdAt: new Date(NOW - 86_400_000).toISOString(),
    interestTags: ["adventure"],
    languageCode: "en",
    qualityScore: 7,
    authorTrustScore: 60,
  } as CompassItem;
}

const CANDIDATES = () => [candidate(QUIET_SUBJECT), candidate(PACKED_SUBJECT)];

async function rankUnder(p: AskRankingProjections | null) {
  const items = CANDIDATES();
  const run = () => runPipeline(items, baseProfile(), baseContext(), null);
  const summary = p ? await runWithAskProjections(p, run) : await run();
  return summary;
}

const factorKeys = (fs: { key: string }[]) => fs.map((f) => f.key);
const scoreOf = (s: Awaited<ReturnType<typeof rankUnder>>, id: string) =>
  s.results.find((r) => r.item.id === id)!.finalScore;

// ─────────────────────────────────────────────────────────────────────────────
// 1. The behaviour the row is about
// ─────────────────────────────────────────────────────────────────────────────

describe("CCL-05 — the shared projections change what the ranking owner returns", () => {
  it("the SAME candidates rank in the opposite order under two kernels that differ only in the declared intent", async () => {
    const quiet = await rankUnder(projections("quiet"));
    const loud  = await rankUnder(projections("high_energy"));

    assert.equal(quiet.passedCount, 2);
    assert.equal(loud.passedCount, 2);
    assert.equal(quiet.results[0].item.id, QUIET_SUBJECT, "a quiet intent must rank the quiet place first");
    assert.equal(loud.results[0].item.id, PACKED_SUBJECT, "a high-energy intent must rank the packed place first");

    // Not a tie broken by input order: the scores themselves moved.
    assert.ok(scoreOf(quiet, QUIET_SUBJECT) > scoreOf(quiet, PACKED_SUBJECT));
    assert.ok(scoreOf(loud, PACKED_SUBJECT) > scoreOf(loud, QUIET_SUBJECT));
  });

  it("the same candidates ranked with NO projections keep the base order and carry no kernel factor", async () => {
    const none = await rankUnder(null);
    assert.equal(none.passedCount, 2);
    for (const r of none.results) {
      assert.ok(!factorKeys(r.rankingFactors).includes("shared_context_kernel"), factorKeys(r.rankingFactors).join(","));
    }
    // The base score is the pre-CCL-05 score: the kernel run must be strictly above it.
    const quiet = await rankUnder(projections("quiet"));
    assert.ok(scoreOf(quiet, QUIET_SUBJECT) > scoreOf(none, QUIET_SUBJECT), "the kernel must raise the fitting candidate");
    // Indistinguishable without the kernel: the only difference between the two
    // base scores is the sub-millisecond freshness drift between two scoreItem
    // calls, orders of magnitude below any boost this suite asserts.
    assert.ok(
      Math.abs(scoreOf(none, QUIET_SUBJECT) - scoreOf(none, PACKED_SUBJECT)) < 1e-4,
      "without the kernel the two candidates must be indistinguishable",
    );
  });

  it("the ranking owner EXPOSES what the projections did, and never conflates 'flag off' with 'nothing promoted'", async () => {
    const none = await rankUnder(null);
    assert.deepEqual(none.sharedProjections, { consumed: false, subjectsMatched: 0, boosted: 0, opportunitiesSeen: null });

    const quiet = await rankUnder(projections("quiet"));
    assert.equal(quiet.sharedProjections.consumed, true);
    assert.equal(quiet.sharedProjections.subjectsMatched, 2, "both candidates are kernel subjects");
    assert.equal(quiet.sharedProjections.boosted, 1, "only the one that fits the declared intent moved");
    assert.equal(quiet.sharedProjections.opportunitiesSeen, null, "the flag-gated half was never supplied");

    const flagOnNothingPromoted = await rankUnder({ ...projections("quiet"), opportunities: [] });
    assert.equal(flagOnNothingPromoted.sharedProjections.opportunitiesSeen, 0, "flag ON with nothing promoted is 0, not null");
  });

  it("the boost arrives as a NAMED, BOUNDED ranking factor, grounded in the kernel's own reading", async () => {
    const quiet = await rankUnder(projections("quiet"));
    const top = quiet.results.find((r) => r.item.id === QUIET_SUBJECT)!;
    const factor = top.rankingFactors.find((f) => f.key === "shared_context_kernel");
    assert.ok(factor, `no shared_context_kernel factor in ${factorKeys(top.rankingFactors).join(",")}`);
    assert.ok(factor!.weight > 0 && factor!.weight <= 1, `weight out of contract: ${factor!.weight}`);
    assert.match(String(factor!.label), /quiet/);
    assert.match(String(factor!.detail ?? ""), /shared context kernel/);

    // Bounded: the whole kernel contribution can never exceed the documented ceiling.
    const none = await rankUnder(null);
    // EPS absorbs the sub-millisecond freshness drift between two pipeline runs.
    const EPS = 1e-3;
    const delta = scoreOf(quiet, QUIET_SUBJECT) - scoreOf(none, QUIET_SUBJECT);
    const ceiling = KERNEL_WORLD_BOOST_MAX + KERNEL_FORECAST_BOOST_MAX + KERNEL_OPPORTUNITY_BOOST_MAX;
    assert.ok(delta > 0 && delta <= ceiling + EPS, `kernel contribution ${delta} is outside 0..${ceiling}`);
    assert.ok(delta <= KERNEL_WORLD_BOOST_MAX + EPS, `world-only contribution ${delta} exceeded ${KERNEL_WORLD_BOOST_MAX}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Honest degradation — the pure annotation, pinned directly
// ─────────────────────────────────────────────────────────────────────────────

describe("CCL-05 — no projection, no boost, and never an invented factor", () => {
  it("no projections at all: zero boost, zero factors", () => {
    const a = kernelRankingForItem(candidate(QUIET_SUBJECT), null);
    assert.equal(a.boost, 0);
    assert.deepEqual(a.factors, []);
  });

  it("a subject the kernel does not carry: zero boost, zero factors", () => {
    const a = kernelRankingForItem(candidate("99999999-9999-4999-8999-999999999999"), projections("quiet"));
    assert.equal(a.boost, 0);
    assert.deepEqual(a.factors, []);
  });

  it("the world could not be READ (Live gates closed): zero boost, and no factor claiming it is quiet", () => {
    const unreadable = [world(QUIET_SUBJECT, [level("quiet")], false)];
    const a = kernelRankingForItem(candidate(QUIET_SUBJECT), {
      kernel: kernelFor(unreadable, "quiet"),
      readable: false,
    });
    assert.equal(a.boost, 0, "could not look is not a reading");
    assert.deepEqual(a.factors, []);

    // And with the `readable` flag OFF but a density somehow present. Today's
    // fold cannot produce that pair (an unreadable subject is read with no
    // envelopes), so this state is CONSTRUCTED: the point is that the gate
    // decides, not the leftover value. "Could not look" can never become a
    // reason to show something.
    const withStaleDensity = world(QUIET_SUBJECT, [level("quiet")]);
    const b = kernelRankingForItem(candidate(QUIET_SUBJECT), {
      kernel: kernelFor([{ ...withStaleDensity, readable: false }], "quiet"),
      readable: false,
    });
    assert.equal(b.boost, 0, "a reading the gates did not allow must not rank");
    assert.deepEqual(b.factors, []);
  });

  it("no declared crowd preference (no intent, or `explore`): the kernel has nothing to rank by and says nothing", () => {
    for (const intent of [null, "explore"] as const) {
      const a = kernelRankingForItem(candidate(QUIET_SUBJECT), projections(intent as DecisionIntent | null));
      assert.equal(a.boost, 0, `intent ${String(intent)} invented a preference`);
      assert.deepEqual(a.factors, [], `intent ${String(intent)} invented a factor`);
    }
  });

  it("a candidate the intent CONFLICTS with gets no boost and no factor — a factor is a reason to show, never a reason not to", () => {
    const a = kernelRankingForItem(candidate(PACKED_SUBJECT), projections("quiet"));
    assert.equal(a.boost, 0);
    assert.deepEqual(a.factors, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Safety suppression wins over promotion
// ─────────────────────────────────────────────────────────────────────────────

describe("CCL-05 — a safety-suppressed subject is never promoted by the shared projections", () => {
  it("a subject the kernel's SafetyContext suppresses gets no boost, however well it fits the intent", async () => {
    // A subject that carries BOTH a usable density and a safety suppression.
    // The crowd fold as it stands today cannot emit that pair (an unsafe
    // reading nulls the density), so the state is CONSTRUCTED from its own
    // parts: the rule under test is the precedence — Sensing §20, "safety
    // suppression must win over opportunity promotion" — not the fold's
    // current ordering, which a later fold could change.
    const readable = world(QUIET_SUBJECT, [level("quiet")]);
    const suppressed: SubjectWorldContext = {
      ...readable,
      crowd: { ...readable.crowd, refusals: [...readable.crowd.refusals, "unsafe_density_is_a_safety_claim"] },
    };
    const kernel = kernelFor([suppressed, world(PACKED_SUBJECT, [level("quiet")])], "quiet");
    assert.ok(kernel.safety.suppressedSubjectIds.includes(QUIET_SUBJECT), "fixture: the subject must be suppressed");
    assert.equal(suppressed.crowd.density, "quiet", "fixture: it must otherwise fit the intent perfectly");

    const a = kernelRankingForItem(candidate(QUIET_SUBJECT), { kernel, readable: true });
    assert.equal(a.boost, 0, "a suppressed subject must never be promoted");
    assert.deepEqual(a.factors, []);
    assert.equal(a.subjectId, QUIET_SUBJECT, "it was matched — it was refused, not missed");

    const summary = await runWithAskProjections({ kernel, readable: true }, () =>
      runPipeline(CANDIDATES(), baseProfile(), baseContext(), null),
    );
    assert.equal(summary.results[0].item.id, PACKED_SUBJECT, "suppression must not out-rank the unsuppressed candidate");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The forecast projection ranks, and says it is predicted
// ─────────────────────────────────────────────────────────────────────────────

describe("CCL-05 — the forecast projection reaches the ranker as its own factor", () => {
  it("a forecast that fits the intent adds a bounded factor that declares itself predicted", () => {
    const subject = world(QUIET_SUBJECT, [level("busy"), traj("building")]);
    assert.ok(subject.forecast, "fixture: the subject must carry a forecast");
    const a = kernelRankingForItem(candidate(QUIET_SUBJECT), { kernel: kernelFor([subject], "high_energy"), readable: true });
    const f = a.factors.find((x) => x.key === "shared_forecast_projection");
    assert.ok(f, `no forecast factor in ${factorKeys(a.factors).join(",")}`);
    assert.match(String(f!.detail ?? ""), /predicted/, "a forecast must never be stated as an observation");
    assert.ok(f!.weight > 0 && f!.weight <= 1);
    const worldFactor = a.factors.find((x) => x.key === "shared_context_kernel");
    assert.ok(a.boost <= KERNEL_WORLD_BOOST_MAX + KERNEL_FORECAST_BOOST_MAX, `boost ${a.boost} unbounded`);
    assert.ok(worldFactor, "the live reading is still its own factor");
  });

  it("no forecast (refused or absent): no forecast factor", () => {
    const subject = world(QUIET_SUBJECT, [level("quiet")]);
    const a = kernelRankingForItem(candidate(QUIET_SUBJECT), { kernel: kernelFor([subject], "quiet"), readable: true });
    if (subject.forecast === null) {
      assert.ok(!factorKeys(a.factors).includes("shared_forecast_projection"), "a refused forecast must not become a factor");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The opportunity half, and only it, is behind the pilot flag
// ─────────────────────────────────────────────────────────────────────────────

describe("CCL-05 / CX-11 — the opportunity half moves the rank only when the flag admitted it", () => {
  const busy = () => world(PACKED_SUBJECT, [level("busy"), traj("building")]);

  function withOpportunities(intent: DecisionIntent): AskRankingProjections {
    const kernel = kernelFor([busy(), world(QUIET_SUBJECT, [level("quiet")])], intent);
    const { opportunities } = buildOpportunities(kernel, NOW);
    return { kernel, readable: true, opportunities: projectForSurface(opportunities, "compass") };
  }

  it("the flag OFF (no opportunities supplied): no opportunity factor, and the kernel half still ranks", async () => {
    const p = projections("quiet");
    assert.equal(p.opportunities, undefined, "fixture: the flag-gated half is absent");
    const summary = await rankUnder(p);
    for (const r of summary.results) {
      assert.ok(!factorKeys(r.rankingFactors).includes("shared_opportunity"));
    }
    assert.equal(summary.results[0].item.id, QUIET_SUBJECT, "the kernel half is NOT behind the opportunity flag");
  });

  it("the flag ON (opportunities supplied): a promoted opportunity is a bounded factor of its own", () => {
    const p = withOpportunities("high_energy");
    const promoted = (p.opportunities ?? []).filter((o) => o.decision === "GO_NOW" || o.decision === "GO_SOON");
    assert.ok(promoted.length > 0, "fixture: the engine must promote at least one opportunity");
    const a = kernelRankingForItem(candidate(String(promoted[0].subjectId)), p);
    const f = a.factors.find((x) => x.key === "shared_opportunity");
    assert.ok(f, `no opportunity factor in ${factorKeys(a.factors).join(",")}`);
    assert.ok(f!.weight > 0 && f!.weight <= 1);
    const withoutOpp = kernelRankingForItem(candidate(String(promoted[0].subjectId)), { kernel: p.kernel, readable: true });
    const delta = a.boost - withoutOpp.boost;
    assert.ok(delta > 0 && delta <= KERNEL_OPPORTUNITY_BOOST_MAX, `opportunity contribution ${delta} outside 0..${KERNEL_OPPORTUNITY_BOOST_MAX}`);
  });

  it("an opportunity that was REFUSED for a subject boosts nothing", () => {
    const p = withOpportunities("quiet"); // a busy place under a quiet intent → SKIP, not GO
    const promotedIds = new Set((p.opportunities ?? []).filter((o) => String(o.decision).startsWith("GO")).map((o) => o.subjectId));
    assert.ok(!promotedIds.has(PACKED_SUBJECT), "fixture: the busy place must not be promoted under a quiet intent");
    const a = kernelRankingForItem(candidate(PACKED_SUBJECT), p);
    assert.ok(!factorKeys(a.factors).includes("shared_opportunity"));

    // The engine REFUSES an unpromotable subject rather than projecting it, so
    // the two guards below are unexercised by the engine's own output. They are
    // pinned on constructed projections: a decision that is not a GO, and a GO
    // the viewer cannot reach, must each promote nothing however relevant.
    const kernel = p.kernel;
    for (const projection of [
      { subjectId: PACKED_SUBJECT, kind: "wait" as const, decision: "WAIT" as const, relevance: 0.9, reachable: true },
      { subjectId: PACKED_SUBJECT, kind: "go_now" as const, decision: "GO_NOW" as const, relevance: 0.9, reachable: false },
    ]) {
      const b = kernelRankingForItem(candidate(PACKED_SUBJECT), {
        kernel,
        readable: true,
        opportunities: [projection as unknown as NonNullable<AskRankingProjections["opportunities"]>[number]],
      });
      assert.ok(
        !factorKeys(b.factors).includes("shared_opportunity"),
        `decision ${projection.decision} / reachable ${projection.reachable} must not promote`,
      );
    }
  });

  it("the route reads the flag by its LITERAL name, and only the opportunity half sits inside that read", () => {
    const route = strip(readFileSync(join(SRC, "routes", "compass.ts"), "utf8"));
    assert.match(route, /isPlatformFlagEnabled\(sc, "opportunity_engine_enabled"\)/);
    const gate = route.indexOf('isPlatformFlagEnabled(sc, "opportunity_engine_enabled")');
    const kernelSet = route.indexOf("askProjections = ");
    const oppSet = route.indexOf("opportunities:");
    assert.ok(kernelSet > 0 && kernelSet < gate, "the kernel half must be established BEFORE (outside) the flag read");
    assert.ok(oppSet > gate, "the opportunity half must be established INSIDE the flag read");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. End to end: the projections are ambient where the ranker runs
// ─────────────────────────────────────────────────────────────────────────────

const ALICE = "a1a1a1a1-aaaa-4aaa-8aaa-000000000001";
const CONV_ID = "cccc0000-cccc-4ccc-8ccc-000000000001";
const PLACE_ID = "88888888-bbbb-4bbb-8bbb-888888888888";

const LIVE_GATES_OPEN = [
  { flag: "intel_live_label_crowd", enabled: true },
  { flag: "intel_claim_projection_crowd", enabled: true },
  { flag: "intel_capture_quick_signal", enabled: true },
  { flag: "intel_limited_live", enabled: true },
];

function makeClient(state: { opportunityFlag?: boolean } = {}) {
  const db: Record<string, any[]> = {
    feature_flags: [
      { flag: "COMPASS_ENABLED", enabled: true },
      ...LIVE_GATES_OPEN,
      ...(state.opportunityFlag === undefined ? [] : [{ flag: "opportunity_engine_enabled", enabled: state.opportunityFlag }]),
    ],
    compass_conversations: [],
    compass_conversation_messages: [],
    compass_user_preferences: [],
    user_hashtag_follows: [],
    profiles: [{ id: ALICE, current_city: "Da Nang", display_name: "Alice" }],
    user_location_state: [{ user_id: ALICE, city: "Da Nang", country: "VN" }],
    trips: [], trip_members: [], trip_plan_items: [], blocks: [], user_follows: [],
    events: [{
      id: "ev-1", title: "RANKING-PROJECTION-CANARY", city: "Da Nang", country: "VN",
      starts_at: iso(180), category: "music", host_id: "host-1", state: "open", visibility: "public",
    }],
    discovery_places: [{
      id: PLACE_ID, city: "Da Nang", name: "Han Market", category: "market", status: "active", rating: 4.5,
      created_at: iso(-10_000), submitted_by: null, latitude: 16.0678, longitude: 108.2208,
    }],
    intel_live_promoted_scopes: [{ scope_key: "|crowd.level" }, { scope_key: "|crowd.trajectory" }],
    intel_state_snapshots: [{
      id: "snap-e2e", subject_id: PLACE_ID, zone_id: null, claim_type: "crowd.level", value: { level: "busy" },
      confidence: 0.85, source_count: 30, observed_at: iso(-3), expires_at: iso(27),
      privacy_eligible: true, conflict_state: "none", source_class: "firsthand_unverified", computed_at: iso(-3),
    }],
    notifications: [],
    notification_preferences: [],
  };

  function builder(table: string, rows: any[]) {
    let filtered = [...rows];
    let insertPayload: any = null;
    const b: any = {
      select: (_c?: string) => b,
      eq: (col: string, val: any) => { filtered = filtered.filter((r) => r[col] === val); return b; },
      is: (col: string, val: any) => { filtered = filtered.filter((r) => (val === null ? r[col] == null : r[col] === val)); return b; },
      in: (col: string, vals: any[]) => { filtered = filtered.filter((r) => vals.includes(r[col])); return b; },
      neq: (col: string, val: any) => { filtered = filtered.filter((r) => r[col] !== val); return b; },
      ilike: (col: string, pat: string) => {
        const re = new RegExp("^" + pat.replace(/%/g, ".*") + "$", "i");
        filtered = filtered.filter((r) => re.test(String(r[col] ?? "")));
        return b;
      },
      like: () => b, or: () => b, not: () => b, gte: () => b, lte: () => b, gt: () => b, lt: () => b,
      contains: () => b, limit: () => b, order: () => b,
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      single: () => {
        if (insertPayload !== null) {
          const row = { id: CONV_ID, ...(insertPayload as object), created_at: new Date().toISOString(), last_active_at: new Date().toISOString() };
          db[table] = db[table] ?? []; db[table].push(row);
          return Promise.resolve({ data: row, error: null });
        }
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      then: (res: any) => res({ data: filtered, error: null, count: filtered.length }),
      update: () => b,
    };
    b.insert = (payload: any) => {
      insertPayload = payload;
      const row = { id: `row_${Math.random()}`, ...((Array.isArray(payload) ? payload[0] : payload) as object), created_at: new Date().toISOString() };
      db[table] = db[table] ?? []; db[table].push(row);
      return { ...b, select: () => ({ ...b, single: () => Promise.resolve({ data: row, error: null }) }) };
    };
    return b;
  }

  return {
    from: (table: string) => builder(table, db[table] ?? []),
    auth: {
      getUser: async (token: string) =>
        token === "test-token" ? { data: { user: { id: ALICE } }, error: null } : { data: { user: null }, error: { message: "not authed" } },
    },
  } as any;
}

interface Seen { inLoop: AskRankingProjections | null | undefined }

/** Reads the ambient projections from INSIDE the tool-calling loop — the depth CompassTools ranks at. */
function capturingOpenAI(seen: Seen) {
  return {
    chat: { completions: { create: async (opts: any) => {
      if (opts.max_completion_tokens === 256) {
        return { choices: [{ message: { content: JSON.stringify({ intent: "conversation", confidence: 0.9 }), role: "assistant" } }] };
      }
      seen.inLoop = currentAskProjections();
      return { choices: [{ message: { content: JSON.stringify({ message: "ok", payload: null, quickActions: [] }), role: "assistant" } }] };
    } } },
  };
}

let app: Express; let server: Server; let port: number;
before(async () => {
  const { default: compassRouter } = await import("../routes/compass.js");
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info() {}, error() {}, warn() {}, debug() {} }; next(); });
  app.use("/api", compassRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as any).port;
});
after(() => { server.close(); _setTestClient(null as any, false); _setTestOpenAI(null); });
beforeEach(() => { invalidateFlagsCache(); _clearPromotedScopeCache(); _clearCompassHomeCache(); });
afterEach(() => _setTestOpenAI(null));

async function askAndSee(state: { opportunityFlag?: boolean } = {}): Promise<Seen> {
  _setTestClient(makeClient(state), true);
  const seen: Seen = { inLoop: undefined };
  _setTestOpenAI(capturingOpenAI(seen) as any);
  const r = await fetch(`http://127.0.0.1:${port}/api/compass/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
    body: JSON.stringify({ prompt: "what should I do right now?", intentMode: "social", tzOffsetMinutes: 420 }),
  });
  assert.equal(r.status, 200);
  return seen;
}

describe("CCL-05 — /compass/ask makes the shared projections ambient where the ranker runs", () => {
  it("inside the tool-calling loop the kernel is present, carrying the place the existing ranker named", async () => {
    const seen = await askAndSee();
    assert.ok(seen.inLoop, "the ranking owner ran with NO shared projections — CCL-05's open sentence");
    const ids = seen.inLoop!.kernel.world.subjects.map((s) => s.subjectId);
    assert.ok(ids.includes(PLACE_ID), `kernel subjects ${ids.join(",")} do not include the ranked place`);
    assert.equal(seen.inLoop!.kernel.user.intent, "social", "the declared §8 intent mode must reach the ranker's kernel");
  });

  it("with the opportunity flag ABSENT (production's state) the ranker sees the kernel and NO opportunities", async () => {
    const seen = await askAndSee();
    assert.equal(seen.inLoop!.opportunities, undefined, "the flag-gated half must not reach the ranker while the flag is off");
  });

  it("with the opportunity flag ON the ranker also sees the opportunity projections", async () => {
    const seen = await askAndSee({ opportunityFlag: true });
    assert.ok(Array.isArray(seen.inLoop!.opportunities), "the flag is on: the opportunity half must reach the ranker");
  });

  it("the pipeline — the ranking owner — is the module that consumes them", () => {
    const pipeline = strip(readFileSync(join(SRC, "compass", "CompassPipeline.ts"), "utf8"));
    assert.match(pipeline, /currentAskProjections\(\)/);
    assert.match(pipeline, /kernelRankingForItem\(/);
    assert.match(pipeline, /kernelRank\.boost/);
  });
});
