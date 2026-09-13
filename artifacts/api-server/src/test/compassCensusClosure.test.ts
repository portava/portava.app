/**
 * compassCensusClosure — the census-compass BUILT-BUT-WRONG rows this lane
 * closed, each pinned by the sentence its census row makes false.
 *
 *   A. CT-11 (Trips §17) — "`safety_mode` reaches ranking only as a context
 *      boost for `notification`-type items; nothing suppresses paid/featured
 *      items when `safeReturnActive`", and the later re-measurement's "it reads
 *      TRIP HEALTH, not `safeReturnActive` — the safe-return leg is still
 *      unguarded". `compass/CompassSafetyAttention.ts` guards it, ungated, and
 *      these cases pin BOTH directions: it withholds while a Safe Return
 *      session is active AND it withholds nothing when the state is off or
 *      unreadable. A switch that fires when it cannot read its input is worse
 *      than no switch, so the fail-open-on-read case is load-bearing.
 *
 *   B. CM-03 (Media §32) — "'where should we go after' and 'quieter/cheaper'
 *      have no comparator or sequencing concept in `CompassMediaContext.ts`".
 *      They do now, and the cases pin that neither invents a fact: an absent
 *      baseline is reported absent, never guessed.
 *
 *   C. CP-01 (Passport `:94`) — "the traveler recommendation list builds
 *      `sharedInterests` reason codes and reads no window". It reads one now,
 *      and the weighting is pinned to rank explicit current intent ABOVE
 *      generic interests — including the case that proves it changes ordering
 *      only when an explicit window exists.
 *
 * Runtime: node:test + node:assert. No DB, no network.
 * Run: node --import tsx/esm --test src/test/compassCensusClosure.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  SAFE_RETURN_SUPPRESSED,
  SUPPRESSIBLE_ITEM_TYPES,
  applySafetyAttention,
  readSafetyAttention,
  safetyAttentionFrom,
  safetyAttentionNotConsulted,
  safetyAttentionOnTheWire,
} from "../compass/CompassSafetyAttention.js";
import { runPipeline, type PipelineTestOverrides } from "../compass/CompassPipeline.js";
import type { CompassContext, CompassItem, CompassProfile } from "../compass/types.js";
import {
  COMPARATOR_AXIS_CLAIM,
  SEQUENCING_CLAIM,
  buildComparatorBaselines,
  buildSequencingAnchor,
  formatMediaContextLines,
  type CompassMediaContext,
  type ComparatorCandidateClaim,
} from "../compass/CompassMediaContext.js";
import {
  applyExplicitIntentWeighting,
  buildTravelerReasonText,
  type ExplicitIntentWeightable,
} from "../routes/compass.js";
import {
  GENERIC_WEIGHT_PER_MATCH,
  INTENT_WEIGHT_PER_MATCH,
  genericInterestWeight,
  explicitIntentBoost,
} from "../services/passport/PassportConsumerProjections.js";
import { readFileSync } from "node:fs";
import {
  ALGORITHM_VERSION_KEY,
  ALGORITHM_VERSION_SHAPE,
  COMPASS_AUTOPILOT_ALGORITHM_VERSION,
  COMPASS_RANKING_ALGORITHM_VERSION,
  isAlgorithmVersion,
} from "../compass/CompassAlgorithmVersion.js";
import { rankingSnapshot } from "../routes/compass.js";
import { buildRepairProposals } from "../compass/CompassAutopilotEngine.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = new Date("2026-09-13T20:00:00.000Z");
const VIEWER = "00000000-0000-0000-0000-0000000000a1";

function profile(over: Partial<CompassProfile> = {}): CompassProfile {
  return {
    userId: VIEWER,
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
    ...over,
  };
}

function context(safeReturnActive = false): CompassContext {
  return {
    contextState: safeReturnActive ? "safety_mode" : "night_mode",
    signals: {
      hourUtc: 20,
      safeReturnActive,
      activeBooking: false,
      upcomingTripWithin48h: false,
      activeTripNow: false,
      hasPendingDelayedPosts: false,
      hasFutureTripScheduled: false,
    },
    computedAt: NOW.toISOString(),
  };
}

/**
 * A mixed batch: two commercial candidates, one that names a logistics need,
 * one notification, one post. The post and the notification are NOT governed by
 * the switch and must survive it whatever they are called.
 */
function candidates(): CompassItem[] {
  return [
    { id: "place:bar",      type: "place",        category: "nightlife", city: "Da Nang" } as CompassItem,
    { id: "event:market",   type: "event",        category: "night_market", city: "Da Nang" } as CompassItem,
    { id: "place:pharmacy", type: "place",        category: "pharmacy", city: "Da Nang" } as CompassItem,
    { id: "note:checkin",   type: "notification", category: "safe_return_prompt" } as CompassItem,
    { id: "post:party",     type: "post",         interestTags: ["party"] } as CompassItem,
  ];
}

const SCORES: Record<string, number> = {
  "place:bar": 90, "event:market": 80, "place:pharmacy": 40, "note:checkin": 30, "post:party": 20,
};

function baseOverrides(scored?: string[]): PipelineTestOverrides {
  return {
    safetyFilter: () => ({ allowed: true }),
    eligibilityCheck: () => ({ eligible: true }),
    scoreItem: (item) => {
      scored?.push(item.id);
      return { finalScore: SCORES[item.id] ?? 10, components: {} as never };
    },
  };
}

/** A supabase-js-shaped fake for the one table readSafetyAttention reads. */
function fakeDb(rows: unknown[] | null, error: unknown = null) {
  const b: Record<string, unknown> = {};
  const chain = new Proxy(b, {
    get(_t, prop: string) {
      if (prop === "then") {
        return (resolve: (v: unknown) => unknown) => resolve({ data: rows, error });
      }
      return () => chain;
    },
  });
  return { from: () => chain } as never;
}

// ── A. CT-11 — the safe-return leg of the §17 priority switch ────────────────

describe("A. CT-11 — commercial recommendations are withheld while a severe safety state holds attention", () => {
  it("A1: with a Safe Return session active, the pipeline withholds the commercial candidates and keeps the safety/logistics one", async () => {
    const out = await runPipeline(candidates(), profile({ safeReturnActive: true }), context(true), null, baseOverrides());
    const ids = out.results.map((r) => r.item.id);
    assert.ok(!ids.includes("place:bar"), "a bar must not be recommended while a Safe Return session is running");
    assert.ok(!ids.includes("event:market"), "a night market must not be recommended either");
    assert.ok(ids.includes("place:pharmacy"), "a pharmacy names a safety need and is kept");
    assert.equal(out.safetyAttention.suppressed, true);
    assert.equal(out.safetyAttention.reason, SAFE_RETURN_SUPPRESSED);
    assert.equal(out.safetyAttention.withheld, 2);
  });

  it("A2: a withheld candidate is never SCORED — the exclusion happens before the scoring engine", async () => {
    const scored: string[] = [];
    await runPipeline(candidates(), profile({ safeReturnActive: true }), context(true), null, baseOverrides(scored));
    assert.ok(!scored.includes("place:bar"), "a suppressed candidate must never reach scoreItem");
    assert.ok(!scored.includes("event:market"));
    assert.deepEqual(scored.sort(), ["note:checkin", "place:pharmacy", "post:party"]);
  });

  it("A3: types that are not a commercial recommendation pass untouched — the feed does not empty", async () => {
    const out = await runPipeline(candidates(), profile({ safeReturnActive: true }), context(true), null, baseOverrides());
    const ids = out.results.map((r) => r.item.id);
    assert.ok(ids.includes("note:checkin"), "a notification is not a commercial recommendation");
    assert.ok(ids.includes("post:party"), "a post tagged 'party' is still not a commercial recommendation");
  });

  it("A4: with no Safe Return session the switch withholds nothing and the batch is unchanged", async () => {
    const out = await runPipeline(candidates(), profile(), context(false), null, baseOverrides());
    assert.equal(out.results.length, 5);
    assert.equal(out.safetyAttention.suppressed, false);
    assert.equal(out.safetyAttention.consulted, true);
    assert.equal(out.safetyAttention.withheld, 0);
  });

  it("A5: FAIL-CLOSED ON CLASSIFICATION — a candidate naming nothing safety-shaped is withheld under suppression", () => {
    const items = [{ cat: "cocktail_bar" }, { cat: null }, { cat: "pharmacy" }];
    const held = applySafetyAttention(items, safetyAttentionFrom(true), (i) => [i.cat]);
    assert.deepEqual(held.kept, [{ cat: "pharmacy" }]);
    assert.equal(held.withheld, 2, "the unclassifiable candidate is withheld, not kept");
    assert.match(String(held.detail), /Safe Return/);
  });

  it("A6: FAIL-OPEN ON THE READ — a switch that could not be consulted suppresses nothing", () => {
    const items = [{ cat: "cocktail_bar" }];
    const held = applySafetyAttention(items, safetyAttentionNotConsulted("unreadable"), (i) => [i.cat]);
    assert.deepEqual(held.kept, items);
    assert.equal(held.withheld, 0);
    assert.equal(held.reason, null);
  });

  it("A7: readSafetyAttention BINDS error — an unreadable safe_return_sessions is 'not consulted', never 'no session'", async () => {
    const r = await readSafetyAttention(fakeDb(null, { message: "boom" }), VIEWER);
    assert.equal(r.consulted, false, "an unreadable table must not be read as a confident 'no session'");
    assert.equal(r.suppressed, false);
    assert.ok(r.info && r.info.length > 0, "the reason must travel, not be swallowed");
  });

  it("A8: readSafetyAttention reports an active session as suppressed, and an empty read as not suppressed", async () => {
    const active = await readSafetyAttention(fakeDb([{ id: "s1" }]), VIEWER);
    assert.equal(active.consulted, true);
    assert.equal(active.suppressed, true);
    assert.equal(active.reason, SAFE_RETURN_SUPPRESSED);

    const none = await readSafetyAttention(fakeDb([]), VIEWER);
    assert.equal(none.consulted, true);
    assert.equal(none.suppressed, false);
    assert.equal(none.reason, null);
  });

  it("A9: the wire shape carries the count and the reason, so a suppressed answer can say so", () => {
    const wire = safetyAttentionOnTheWire(safetyAttentionFrom(true), 3);
    assert.deepEqual(Object.keys(wire).sort(), ["consulted", "detail", "info", "reason", "suppressed", "withheld"]);
    assert.equal(wire.withheld, 3);
    assert.equal(wire.reason, SAFE_RETURN_SUPPRESSED);
  });

  it("A10: the governed type set is the 'go out and spend' types and nothing else", () => {
    for (const t of ["place", "hidden_gem", "event", "suggestion", "buddy"] as const) {
      assert.ok(SUPPRESSIBLE_ITEM_TYPES.has(t), `${t} must be governed by the switch`);
    }
    for (const t of ["notification", "user", "trip", "post", "stamp", "traveler"] as const) {
      assert.ok(!SUPPRESSIBLE_ITEM_TYPES.has(t), `${t} is not a commercial recommendation`);
    }
  });
});

// ── B. CM-03 — the two §32 questions that had no concept ────────────────────

const NOW_MS = NOW.getTime();
const claim = (t: string, over: Partial<ComparatorCandidateClaim> = {}): ComparatorCandidateClaim => ({
  claimType: t,
  band: "live",
  sourceClass: "firsthand_unverified",
  observedAt: new Date(NOW_MS - 5 * 60_000).toISOString(),
  validUntil: new Date(NOW_MS + 20 * 60_000).toISOString(),
  ...over,
});

function mediaCtx(over: Partial<CompassMediaContext> = {}): CompassMediaContext {
  return {
    mediaAssetId: "m1",
    entityRefs: [{ kind: "media", id: "m1", label: null } as never],
    viewerContext: { viewerCountry: "VN", subjectCity: "Da Nang" },
    permittedIntelligenceRefs: [],
    comparator: buildComparatorBaselines([], NOW_MS),
    sequencing: buildSequencingAnchor(null, "Da Nang", [], NOW_MS),
    ...over,
  };
}

describe("B. CM-03 — 'quieter or cheaper' has a baseline and 'where after this' has an anchor", () => {
  it("B1: both comparator axes are ALWAYS reported, so an absent baseline is a printed 'not grounded'", () => {
    const axes = buildComparatorBaselines([], NOW_MS);
    assert.deepEqual(axes.map((a) => a.axis), ["quieter", "cheaper"]);
    assert.deepEqual(axes.map((a) => a.grounded), [false, false]);
    assert.equal(axes[0]!.claimType, COMPARATOR_AXIS_CLAIM.quieter);
    assert.equal(axes[1]!.claimType, COMPARATOR_AXIS_CLAIM.cheaper);
  });

  it("B2: an axis grounds only on ITS OWN claim type — a crowd reading does not make 'cheaper' answerable", () => {
    const axes = buildComparatorBaselines([claim("crowd.level")], NOW_MS);
    assert.equal(axes.find((a) => a.axis === "quieter")!.grounded, true);
    assert.equal(axes.find((a) => a.axis === "cheaper")!.grounded, false);
  });

  it("B3: an EXPIRED claim is not a baseline — a stale reading must not license a comparison", () => {
    const stale = claim("price.cover", { validUntil: new Date(NOW_MS - 60_000).toISOString() });
    const axes = buildComparatorBaselines([stale], NOW_MS);
    assert.equal(axes.find((a) => a.axis === "cheaper")!.grounded, false);
  });

  it("B4: a grounded axis carries PROVENANCE and never the claim value", () => {
    const axes = buildComparatorBaselines([claim("crowd.level", { band: "strong", sourceClass: "official_signed" })], NOW_MS);
    const q = axes.find((a) => a.axis === "quieter")!;
    assert.equal(q.band, "strong");
    assert.equal(q.sourceClass, "official_signed");
    assert.ok(!Object.prototype.hasOwnProperty.call(q, "value"), "a baseline must never carry the value");
    assert.deepEqual(Object.keys(q).sort(), ["axis", "band", "claimType", "grounded", "observedAt", "sourceClass"]);
  });

  it("B5: with no anchor place the sequencing question is NOT chainable and carries no city", () => {
    const seq = buildSequencingAnchor(null, "Da Nang", [claim(SEQUENCING_CLAIM)], NOW_MS);
    assert.equal(seq.chainable, false);
    assert.equal(seq.anchorPlaceId, null);
    assert.equal(seq.city, null, "a withheld place must not leak its city through the sequencing block");
    assert.equal(seq.nextMoveGrounded, false, "a next-move claim with no anchor grounds nothing");
  });

  it("B6: with an anchor, the city is carried and the next-move claim grounds the ordering", () => {
    const seq = buildSequencingAnchor("place-1", "Da Nang", [claim(SEQUENCING_CLAIM)], NOW_MS);
    assert.deepEqual(seq, { anchorPlaceId: "place-1", city: "Da Nang", nextMoveGrounded: true, chainable: true });
    const bare = buildSequencingAnchor("place-1", "Da Nang", [], NOW_MS);
    assert.equal(bare.chainable, true);
    assert.equal(bare.nextMoveGrounded, false);
  });

  it("B7: the prompt states both axes and refuses an ungrounded comparison in words", () => {
    const lines = formatMediaContextLines(mediaCtx({
      comparator: buildComparatorBaselines([claim("crowd.level")], NOW_MS),
    })).join("\n");
    assert.match(lines, /grounded axes: quieter/);
    assert.match(lines, /ungrounded: cheaper/);
    assert.match(lines, /cannot\s+be\s+made/i);
    assert.match(lines, /never estimate/i);
  });

  it("B8: with no anchor the prompt says the question cannot be answered rather than offering a city", () => {
    const lines = formatMediaContextLines(mediaCtx()).join("\n");
    assert.match(lines, /NO ANCHOR/);
    assert.match(lines, /cannot be\s+answered/i);
    assert.ok(!/A next stop must be a DIFFERENT place/.test(lines), "no chaining instruction without an anchor");
  });

  it("B9: with an anchor the prompt names it and bounds the next stop to the same city", () => {
    const lines = formatMediaContextLines(mediaCtx({
      sequencing: buildSequencingAnchor("place-1", "Da Nang", [], NOW_MS),
    })).join("\n");
    assert.match(lines, /anchor: place place-1/);
    assert.match(lines, /stay in that city/);
    assert.match(lines, /No aggregate next-move reading is permitted/);
  });
});

// ── C. CP-01 — explicit current intent outranks generic interests in the list ─

interface Trav extends ExplicitIntentWeightable { sharedInterests: string[] }
const trav = (id: string, score: number, reasonCode = "shared_interests"): Trav => ({
  id, score, reasonCode, sharedInterests: [], sharedExplicitIntents: [], intentBoost: 0,
});
const read = (intents: string[], hasActiveWindow = true) => ({ intents, hasActiveWindow });

describe("C. CP-01 — the traveler list weights explicit current intent above generic interests", () => {
  it("C1: one shared EXPLICIT intent outweighs one shared GENERIC interest, by construction", () => {
    assert.ok(INTENT_WEIGHT_PER_MATCH > GENERIC_WEIGHT_PER_MATCH);
    assert.ok(explicitIntentBoost(1, true) > genericInterestWeight(1));
  });

  it("C2: an explicit match promotes a traveler over one who only shares generic interests", () => {
    // B leads on generic overlap alone; A shares nothing generic at all.
    const a = trav("a", genericInterestWeight(0));
    const b = trav("b", genericInterestWeight(2));
    assert.ok(b.score > a.score, "B must start ahead on generic interests alone");
    const out = applyExplicitIntentWeighting([a, b], ["live_music"], new Map([["a", read(["live_music"])]]));
    assert.deepEqual(out.map((e) => e.id), ["a", "b"], "the explicit-intent match must rank first");
    assert.equal(out[0]!.reasonCode, "explicit_intent");
    assert.deepEqual(out[0]!.sharedExplicitIntents, ["live_music"]);
    assert.equal(out[0]!.intentBoost, INTENT_WEIGHT_PER_MATCH);
  });

  it("C3: NO active open-to-plans window ⇒ no boost, no reason change, no reorder", () => {
    const a = trav("a", 10);
    const b = trav("b", 20);
    const out = applyExplicitIntentWeighting([a, b], ["live_music"], new Map([["a", read(["live_music"], false)]]));
    assert.deepEqual(out.map((e) => e.id), ["b", "a"]);
    assert.equal(out.find((e) => e.id === "a")!.intentBoost, 0);
    assert.equal(out.find((e) => e.id === "a")!.reasonCode, "shared_interests");
    assert.deepEqual(out.find((e) => e.id === "a")!.sharedExplicitIntents, []);
  });

  it("C4: a VIEWER with no explicit intent leaves the list byte-identical — the whole pass is inert", () => {
    const entries = [trav("a", 10), trav("b", 20)];
    const before = JSON.parse(JSON.stringify(entries));
    const out = applyExplicitIntentWeighting(entries, [], new Map([["a", read(["live_music"])]]));
    assert.deepEqual(out, before, "with no viewer intent nothing is read, scored, reordered or relabelled");
  });

  it("C5: a traveler with no read at all is untouched — a degraded window read cannot demote anyone", () => {
    const a = trav("a", 10);
    const out = applyExplicitIntentWeighting([a], ["live_music"], new Map());
    assert.equal(out[0]!.score, 10);
    assert.equal(out[0]!.reasonCode, "shared_interests");
  });

  it("C6: the boost is CAPPED — explicit intent nudges the order, it does not own it", () => {
    const a = trav("a", 0);
    applyExplicitIntentWeighting([a], ["x1", "x2", "x3", "x4", "x5"], new Map([["a", read(["x1", "x2", "x3", "x4", "x5"])]]));
    assert.equal(a.intentBoost, explicitIntentBoost(5, true));
    assert.ok(a.intentBoost <= 36, "the §8 cap must hold");
    assert.equal(a.sharedExplicitIntents.length, 3, "at most three intents are echoed back");
  });

  it("C7: the reason text names the explicit intent, and falls back when there is none", () => {
    assert.match(buildTravelerReasonText("explicit_intent", ["hiking"], "Cebu", ["live_music"]), /Open to plans right now: live_music/);
    assert.match(buildTravelerReasonText("explicit_intent", ["hiking"], "Cebu", []), /Shared interests|Similar travel style|Also travels/);
    assert.equal(buildTravelerReasonText("shared_interests", ["hiking"], "Cebu", ["live_music"]), "Shared interests: hiking");
  });

  it("C8: the traveler branch of the route actually READS a window and scores generics on the shared weight", () => {
    // What this asserts and what it does not: the pure rule above is proven by
    // C1-C7; this case proves only that the route is WIRED to it — that the
    // list no longer reads zero windows, which is the sentence census-compass
    // CP-01 makes. It cannot prove the read returns the right thing.
    const src = readFileSync(new URL("../routes/compass.ts", import.meta.url), "utf8");
    const branch = src.slice(
      src.indexOf("// Shared GENERIC interest overlap"),
      src.indexOf("void logCompassImpression(travelerRecommendations"),
    );
    assert.ok(branch.length > 0, "the traveler branch must be locatable");
    assert.match(branch, /readVisibleExplicitIntent\(sc, user\.id, "self"/, "the viewer's own explicit intent must be read");
    assert.match(branch, /readVisibleExplicitIntent\(sc, entry\.id/, "each candidate's visible explicit intent must be read");
    assert.match(branch, /applyExplicitIntentWeighting\(/, "the weighting must be applied to the pool");
    assert.match(branch, /genericInterestWeight\(sharedInterests\.length\)/, "generics must use the shared weight, not a local ratio");
    assert.ok(!/score \+= overlapRatio/.test(branch), "the old local ratio term must no longer be added to the score");
  });
});

// ── D. CT-13 — a stored automated suggestion names its algorithm ─────────────

describe("D. CT-13 — automated suggestions are explainable from stored inputs AND a versioned algorithm", () => {
  it("D1: both version constants parse as the intel layer's component/N grammar", () => {
    assert.ok(isAlgorithmVersion(COMPASS_RANKING_ALGORITHM_VERSION), COMPASS_RANKING_ALGORITHM_VERSION);
    assert.ok(isAlgorithmVersion(COMPASS_AUTOPILOT_ALGORITHM_VERSION), COMPASS_AUTOPILOT_ALGORITHM_VERSION);
    assert.match(COMPASS_RANKING_ALGORITHM_VERSION, ALGORITHM_VERSION_SHAPE);
    assert.notEqual(COMPASS_RANKING_ALGORITHM_VERSION, COMPASS_AUTOPILOT_ALGORITHM_VERSION,
      "the two rule sets must be distinguishable in a stored row");
  });

  it("D2: a shape that is not component/N is refused — the constant cannot drift into free text", () => {
    for (const bad of ["", "v1", "compass ranking/1", "Compass/1", "compass-ranking/", "compass-ranking/1+"]) {
      assert.equal(isAlgorithmVersion(bad), false, `"${bad}" must not pass as a version`);
    }
  });

  it("D3: a served recommendation's stored snapshot carries the ranking version beside its inputs", () => {
    const snap = rankingSnapshot({ compassMatch: 71, communityScore: 40, rankingFactors: [{ key: "k" }] });
    assert.ok(snap, "a scored item must produce a snapshot");
    assert.equal(snap![ALGORITHM_VERSION_KEY], COMPASS_RANKING_ALGORITHM_VERSION);
    assert.equal(snap!["compassMatch"], 71, "the stored INPUTS are unchanged by the stamp");
    assert.deepEqual(snap!["factors"], [{ key: "k" }]);
  });

  it("D4: an unscored item still produces NO snapshot — the stamp must not invent a row", () => {
    assert.equal(rankingSnapshot({ rankingFactors: [{ key: "k" }] }), null);
  });

  it("D5: EVERY change on EVERY autopilot proposal carries the autopilot version", () => {
    const items = [
      { id: "i1", title: "Museum", category: "activity", startsAt: "2026-09-13T09:00:00Z", endsAt: "2026-09-13T11:00:00Z", dayDate: "2026-09-13", lockType: "flexible", status: "planned", sourceId: null, sortOrder: 0 },
      { id: "i2", title: "Lunch",  category: "activity", startsAt: "2026-09-13T10:00:00Z", endsAt: "2026-09-13T12:00:00Z", dayDate: "2026-09-13", lockType: "flexible", status: "planned", sourceId: null, sortOrder: 1 },
    ] as never[];
    const issues = [
      {
        type: "timing_conflict", severity: "attention", itemIds: ["i1", "i2"],
        reason: "They overlap.", dedupeKey: "timing:i1:i2",
        meta: { shortfallMin: 30, laterItemId: "i2", earlierItemId: "i1" },
      },
    ] as never[];
    const settings = { enabled: true, allowMoveFlexible: true, allowMoveOptional: true, allowRemoveOptional: false } as never;
    // A cancellation recovery, which produces a MULTI-change proposal (cancel
    // the broken item AND pull its successor up). The multi-change case is the
    // load-bearing one: a fixture with one change per proposal cannot tell
    // "stamp every change" apart from "stamp the first", and the mutation that
    // stamps only `changes[0]` stayed GREEN until this case existed.
    const cancelIssues = [
      {
        type: "item_cancelled", severity: "high", itemIds: ["i1"],
        reason: "The museum closed.", dedupeKey: "cancel:i1", meta: { itemId: "i1" },
      },
    ] as never[];

    const proposals = [
      ...buildRepairProposals(items, issues, settings),
      ...buildRepairProposals(items, cancelIssues, settings),
    ];
    assert.ok(proposals.length > 0, "the fixture must actually produce a proposal");
    assert.ok(proposals.some((p) => p.changes.length > 1), "one proposal must carry MORE THAN ONE change");
    for (const p of proposals) {
      assert.ok(p.changes.length > 0);
      for (const c of p.changes) {
        assert.equal(c.algorithmVersion, COMPASS_AUTOPILOT_ALGORITHM_VERSION,
          "a change with no version makes its proposal unexplainable");
      }
    }
  });

  it("D6: /compass/why echoes the STORED version, never the current constant", () => {
    // The stored value is the one that explains the pick; substituting today's
    // constant would claim a recommendation was made by rules that did not
    // exist when it was served. Asserted on the route source because the
    // branch is inside an Express handler with a DB read either side.
    const src = readFileSync(new URL("../routes/compass.ts", import.meta.url), "utf8");
    const why = src.slice(src.indexOf("compass/why: served-recommendation lookup unavailable"), src.indexOf("// ── POST /api/compass/ask"));
    assert.ok(why.length > 0, "the /compass/why branch must be locatable");
    assert.match(why, /algorithmVersion: snapshot\.algorithmVersion \?\? null/);
    assert.ok(!/algorithmVersion: COMPASS_RANKING_ALGORITHM_VERSION/.test(why),
      "the answer must not substitute the current constant for the stored one");
  });
});
