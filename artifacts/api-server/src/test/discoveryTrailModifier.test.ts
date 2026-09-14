/**
 * Trails as a MODIFIER — `02_Trails.md` §9/§10/§11 and the one number Trails is
 * allowed to hand the ranker.
 *
 * THE RULING THIS FILE EXISTS TO ENFORCE, VERBATIM
 * ===============================================
 * `docs/discovery/ROADMAP.md:148` — "Anything assuming the six P1 components
 * are **peer scoring systems**: STALE — must be re-scoped before
 * implementation." `docs/architecture/02_Trails.md:5-12` records the re-scope:
 * "ROADMAP step 7 keeps trails only as a future MODIFIER to the ranker, never a
 * parallel engine."
 *
 * The strongest test of "modifier, never a parallel engine" is not a comment —
 * it is a CAP that a test can break. So this file proves, by arithmetic:
 *
 *   • a fully saturated trail affinity contributes at most
 *     TRAIL_AFFINITY_MAX_CONTRIBUTION, and that constant is strictly below
 *     every taste weight in portavaRank's DEFAULT_WEIGHTS and at or below the
 *     momentum cap ROADMAP step 7 already set;
 *   • the cap holds however large a weight is passed in — exactly the way
 *     portavaRank clamps localMomentum, so an admin weight override cannot turn
 *     a modifier into a driver;
 *   • Trail momentum (DV-25) is computed by the EXISTING momentum kernel
 *     (lib/discoveryLocalMomentum.computeLocalMomentum) over the Trail's member
 *     items — a second velocity model would be the parallel engine the ruling
 *     forbids;
 *   • Trail health (DC-05) scales ranking but has a FLOOR above zero, because
 *     §11 says health "should influence ranking but not silently erase
 *     legitimate content".
 *
 * Also proved here: §10 saturation control (DV-23) and the §10 creator-
 * domination bound (DV-13); §9 fair exposure with denominators (DV-22); §12's
 * user-facing status labels carrying no score (DV-27 preserved).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_WEIGHTS, LOCAL_MOMENTUM_MAX_CONTRIBUTION } from "../lib/portavaRank.js";
import {
  TRAIL_AFFINITY_MAX_CONTRIBUTION,
  TRAIL_AFFINITY_SIGNAL_KEY,
  RELATIONSHIP_AFFINITY,
  trailAffinityMap,
  trailAffinityContribution,
  trailMomentumFromRankEvents,
  type TrailMembershipRow,
} from "../lib/discoveryTrailAffinity.js";
import {
  TRAIL_HEALTH_METRICS,
  TRAIL_HEALTH_MIN_SCALE,
  TRAIL_HEALTH_MODEL_VERSION,
  MAX_PER_CONTRIBUTOR_PER_PAGE,
  MAX_PER_PLACE_PER_PAGE,
  computeTrailHealth,
  trailHealthScale,
  trailStatusLabel,
  diversifyTrailPage,
  fairExposureSlots,
} from "../lib/discoveryTrailHealth.js";

const NOW = Date.parse("2026-09-14T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

// ── The cap: "modifier, never a parallel engine" ─────────────────────────────

describe("ROADMAP step 7 — the Trail term is a capped MODIFIER, proved by arithmetic", () => {
  it("the cap is at or below the momentum cap step 7 already set", () => {
    assert.ok(TRAIL_AFFINITY_MAX_CONTRIBUTION <= LOCAL_MOMENTUM_MAX_CONTRIBUTION,
      `${TRAIL_AFFINITY_MAX_CONTRIBUTION} must not exceed the momentum cap ${LOCAL_MOMENTUM_MAX_CONTRIBUTION}`);
  });

  it("the cap is strictly below EVERY taste-side weight in the shipping ranker", () => {
    const taste = [
      DEFAULT_WEIGHTS.categoryAffinity, DEFAULT_WEIGHTS.interestTag,
      DEFAULT_WEIGHTS.cityMatch, DEFAULT_WEIGHTS.actionability,
      DEFAULT_WEIGHTS.neighborhoodMatch, DEFAULT_WEIGHTS.followedAuthor,
      DEFAULT_WEIGHTS.distance, DEFAULT_WEIGHTS.availabilityFit,
    ];
    for (const w of taste) {
      assert.ok(TRAIL_AFFINITY_MAX_CONTRIBUTION < w,
        `trail cap ${TRAIL_AFFINITY_MAX_CONTRIBUTION} must be < taste weight ${w}`);
    }
  });

  it("a saturated affinity contributes exactly the cap and never more", () => {
    assert.equal(trailAffinityContribution(1), TRAIL_AFFINITY_MAX_CONTRIBUTION);
    assert.equal(trailAffinityContribution(5), TRAIL_AFFINITY_MAX_CONTRIBUTION);
  });

  it("an OVERRIDDEN weight cannot lift the contribution past the cap (portavaRank's own clamp shape)", () => {
    assert.equal(trailAffinityContribution(1, 100), TRAIL_AFFINITY_MAX_CONTRIBUTION);
    assert.equal(trailAffinityContribution(0.5, 100), TRAIL_AFFINITY_MAX_CONTRIBUTION);
  });

  it("no affinity, a negative affinity or a NaN contributes nothing — never a negative score", () => {
    assert.equal(trailAffinityContribution(0), 0);
    assert.equal(trailAffinityContribution(-1), 0);
    assert.equal(trailAffinityContribution(Number.NaN), 0);
  });

  it("the signal key is the one lib/discoveryReasonCodes.ts can map to trail_affinity", () => {
    assert.equal(TRAIL_AFFINITY_SIGNAL_KEY, "trailAffinity");
  });
});

// ── The affinity map: viewer's Trails → per-place [0,1] ─────────────────────

const M = (over: Partial<TrailMembershipRow>): TrailMembershipRow => ({
  trail_id: "tr-1", source_type: "place", source_id: "p1",
  relationship: "primary", confidence: 1, ...over,
});

describe("trailAffinityMap — bounded, per place, and never invented", () => {
  it("a place in a followed Trail as PRIMARY scores the relationship's full weight", () => {
    const m = trailAffinityMap(["tr-1"], [M({})]);
    assert.equal(m.p1, RELATIONSHIP_AFFINITY.primary);
  });

  it("supporting and signal memberships are worth strictly less than primary", () => {
    assert.ok(RELATIONSHIP_AFFINITY.supporting < RELATIONSHIP_AFFINITY.primary);
    assert.ok(RELATIONSHIP_AFFINITY.signal < RELATIONSHIP_AFFINITY.supporting);
    const m = trailAffinityMap(["tr-1"], [M({ relationship: "supporting" }), M({ source_id: "p2", relationship: "signal" })]);
    assert.equal(m.p1, RELATIONSHIP_AFFINITY.supporting);
    assert.equal(m.p2, RELATIONSHIP_AFFINITY.signal);
  });

  it("a place in a Trail the viewer does NOT follow scores nothing", () => {
    assert.deepEqual(trailAffinityMap(["tr-other"], [M({})]), {});
  });

  it("memberships are combined by MAX, not summed — ten weak Trails cannot beat one strong one", () => {
    const many = Array.from({ length: 10 }, (_, i) => M({ trail_id: `t${i}`, relationship: "signal" }));
    const followed = many.map((r) => r.trail_id);
    const m = trailAffinityMap(followed, many);
    assert.equal(m.p1, RELATIONSHIP_AFFINITY.signal,
      "summing would make membership count a driver, which is the parallel-engine failure");
    assert.ok(m.p1 <= 1);
  });

  it("row confidence scales the affinity and is clamped into [0,1]", () => {
    assert.equal(trailAffinityMap(["tr-1"], [M({ confidence: 0.5 })]).p1,
      Math.round(RELATIONSHIP_AFFINITY.primary * 0.5 * 1000) / 1000);
    assert.equal(trailAffinityMap(["tr-1"], [M({ confidence: 99 })]).p1, RELATIONSHIP_AFFINITY.primary);
    assert.equal(trailAffinityMap(["tr-1"], [M({ confidence: -3 })]).p1, undefined);
  });

  it("Trail momentum, when supplied, SCALES affinity and can never raise it", () => {
    const hot = trailAffinityMap(["tr-1"], [M({})], { trailMomentum: { "tr-1": 1 } });
    const cold = trailAffinityMap(["tr-1"], [M({})], { trailMomentum: { "tr-1": 0 } });
    const none = trailAffinityMap(["tr-1"], [M({})]);
    assert.equal(hot.p1, none.p1, "full momentum is the unscaled value, never a bonus");
    assert.ok((cold.p1 ?? 0) < (none.p1 ?? 0), "no momentum damps, it does not zero the object");
    assert.ok((cold.p1 ?? 0) > 0);
  });

  it("only place memberships enter the map — a post membership has no place id to score", () => {
    const m = trailAffinityMap(["tr-1"], [M({ source_type: "post", source_id: "post-1" })]);
    assert.deepEqual(m, {});
  });

  it("garbage in produces an EMPTY map, never a throw and never a default score", () => {
    assert.deepEqual(trailAffinityMap([], []), {});
    assert.deepEqual(trailAffinityMap(null as any, null as any), {});
    assert.deepEqual(trailAffinityMap(["tr-1"], [{ } as any]), {});
  });
});

// ── DV-25: behaviour influences Trail momentum, through the EXISTING kernel ──

describe("DV-25 — user behaviour influences Trail momentum via the shipping momentum kernel", () => {
  const member = (trailId: string, itemId: string): TrailMembershipRow =>
    M({ trail_id: trailId, source_id: itemId });

  it("recent activity on a Trail's member items gives the TRAIL momentum, unsaturated", () => {
    const events = [{ item_id: "p1", outcome: "save", served_at: hoursAgo(4), outcome_at: hoursAgo(4) }];
    const m = trailMomentumFromRankEvents(events, [member("tr-1", "p1")], NOW);
    assert.ok((m["tr-1"] ?? 0) > 0, JSON.stringify(m));
    assert.ok(m["tr-1"] < 1, "one save is a signal, not a saturation");
  });

  it("events on items in NO Trail contribute to no Trail", () => {
    const events = Array.from({ length: 8 }, () => ({ item_id: "loose", outcome: "save", served_at: hoursAgo(4), outcome_at: hoursAgo(4) }));
    assert.deepEqual(trailMomentumFromRankEvents(events, [member("tr-1", "p1")], NOW), {});
  });

  it("a Trail whose activity only matches its own baseline has NO momentum", () => {
    // Steady historic activity, nothing recent: no surge, so no momentum.
    const events = Array.from({ length: 40 }, (_, i) => ({
      item_id: "p1", outcome: "impression", served_at: daysAgo(3 + (i % 20)), outcome_at: null,
    }));
    const m = trailMomentumFromRankEvents(events, [member("tr-1", "p1")], NOW);
    assert.equal(m["tr-1"], undefined);
  });

  it("two member items of one Trail are pooled onto the Trail, not scored separately", () => {
    const events = [
      ...Array.from({ length: 4 }, () => ({ item_id: "p1", outcome: "impression", served_at: hoursAgo(3), outcome_at: null })),
      ...Array.from({ length: 4 }, () => ({ item_id: "p2", outcome: "impression", served_at: hoursAgo(3), outcome_at: null })),
    ];
    const pooled = trailMomentumFromRankEvents(events, [member("tr-1", "p1"), member("tr-1", "p2")], NOW);
    const split = trailMomentumFromRankEvents(events, [member("tr-1", "p1")], NOW);
    assert.ok((pooled["tr-1"] ?? 0) > (split["tr-1"] ?? 0), JSON.stringify({ pooled, split }));
  });
});

// ── DC-05: §11's nine health metrics, and the non-erasure floor ─────────────

const HEALTHY = {
  members: [
    { source_id: "p1", contributor_id: "a", confidence: 0.9, content_state: "featured", created_at: hoursAgo(2) },
    { source_id: "p2", contributor_id: "b", confidence: 0.8, content_state: "growing", created_at: hoursAgo(5) },
    { source_id: "p3", contributor_id: "c", confidence: 0.7, content_state: "just_arrived", created_at: hoursAgo(9) },
    { source_id: "p4", contributor_id: "d", confidence: 0.9, content_state: "evergreen", created_at: daysAgo(3) },
  ],
  reportCount: 0,
  nowMs: NOW,
};

describe("DC-05 — §11's nine Trail-health metrics", () => {
  it("all nine §11 metrics are named, in the spec's order", () => {
    assert.deepEqual([...TRAIL_HEALTH_METRICS], [
      "contributor_concentration", "new_creator_exposure", "content_freshness",
      "duplicate_density", "report_rate", "place_diversity",
      "geographic_diversity", "quality_to_noise_ratio", "stale_object_ratio",
    ]);
  });

  it("a healthy Trail reports every measurable metric, and every value is bounded [0,1]", () => {
    const h = computeTrailHealth(HEALTHY);
    for (const k of TRAIL_HEALTH_METRICS) {
      const v = h.metrics[k];
      if (v === null) continue;
      assert.ok(v >= 0 && v <= 1, `${k} = ${v} out of [0,1]`);
    }
    assert.equal(h.modelVersion, TRAIL_HEALTH_MODEL_VERSION);
  });

  it("geographic diversity is UNMEASURED without a geo cell per item — reported null, never defaulted to 0", () => {
    const h = computeTrailHealth(HEALTHY);
    assert.equal(h.metrics.geographic_diversity, null);
    assert.ok(h.unmeasured.includes("geographic_diversity"));
    const withGeo = computeTrailHealth({ ...HEALTHY, geoCellByItem: { p1: "g1", p2: "g1", p3: "g2", p4: "g3" } });
    assert.equal(withGeo.metrics.geographic_diversity, 0.75);
    assert.ok(!withGeo.unmeasured.includes("geographic_diversity"));
  });

  // PARTIAL geo data is the realistic case and it is the one that could go
  // wrong quietly: three of four items in a cell would compute a diversity of
  // 0.75 over a denominator of 3, which is a different Trail's number. Refusing
  // to measure is the only honest answer, and a mutation that defaults the
  // partial case to 0 must be caught here rather than in production.
  it("PARTIAL geo cells are still UNMEASURED — a metric is never computed over a different denominator", () => {
    const partial = computeTrailHealth({ ...HEALTHY, geoCellByItem: { p1: "g1", p2: "g2" } });
    assert.equal(partial.metrics.geographic_diversity, null);
    assert.ok(partial.unmeasured.includes("geographic_diversity"));
  });

  it("one contributor owning the whole Trail reads as total concentration (§10, DV-13)", () => {
    const h = computeTrailHealth({
      ...HEALTHY,
      members: HEALTHY.members.map((m) => ({ ...m, contributor_id: "a" })),
    });
    assert.equal(h.metrics.contributor_concentration, 1);
    assert.equal(h.metrics.new_creator_exposure, 0);
  });

  it("repeated postings about one place read as duplicate density and low place diversity", () => {
    const h = computeTrailHealth({
      ...HEALTHY,
      members: HEALTHY.members.map((m, i) => ({ ...m, source_id: "p1", contributor_id: `c${i}` })),
    });
    assert.equal(h.metrics.place_diversity, 0.25);
    assert.equal(h.metrics.duplicate_density, 0.75);
  });

  it("an EMPTY Trail measures nothing rather than scoring perfect health", () => {
    const h = computeTrailHealth({ members: [], reportCount: 0, nowMs: NOW });
    for (const k of TRAIL_HEALTH_METRICS) assert.equal(h.metrics[k], null, k);
    assert.equal(h.unmeasured.length, TRAIL_HEALTH_METRICS.length);
  });
});

describe("DC-05 — health influences ranking but CANNOT silently erase content (§11)", () => {
  it("the healthiest possible Trail scales by exactly 1", () => {
    const h = computeTrailHealth({ ...HEALTHY, geoCellByItem: { p1: "g1", p2: "g2", p3: "g3", p4: "g4" } });
    assert.equal(trailHealthScale(h), 1);
  });

  it("the WORST possible health still scales by the floor, never 0", () => {
    const worst = computeTrailHealth({
      members: Array.from({ length: 8 }, (_, i) => ({
        source_id: "p1", contributor_id: "a", confidence: 0, content_state: "archived_from_active_rotation",
        created_at: daysAgo(200), ...(i === -1 ? {} : {}),
      })),
      reportCount: 999,
      nowMs: NOW,
    });
    const s = trailHealthScale(worst);
    assert.equal(s, TRAIL_HEALTH_MIN_SCALE);
    assert.ok(s > 0, "§11: health must not silently ERASE legitimate content");
    assert.ok(TRAIL_HEALTH_MIN_SCALE >= 0.5, "a floor that low is erasure by another name");
  });

  it("an unmeasurable Trail scales by 1 — absence of health evidence is not evidence of ill health", () => {
    assert.equal(trailHealthScale(computeTrailHealth({ members: [], reportCount: 0, nowMs: NOW })), 1);
  });

  it("the scale is monotone: worse health never scales HIGHER", () => {
    const good = computeTrailHealth(HEALTHY);
    const bad = computeTrailHealth({ ...HEALTHY, reportCount: 4 });
    assert.ok(trailHealthScale(bad) <= trailHealthScale(good));
  });
});

// ── DV-27 preserved: §12 status is a LABEL, never a score ───────────────────

describe("§12 Trail status — user-facing words, no opaque quality score (DV-27)", () => {
  it("every label is from the §12 vocabulary and contains no digit", () => {
    const cases = [
      trailStatusLabel("active", computeTrailHealth(HEALTHY)),
      trailStatusLabel("needs_update", computeTrailHealth(HEALTHY)),
      trailStatusLabel("stale", computeTrailHealth(HEALTHY)),
      trailStatusLabel("proposed", computeTrailHealth(HEALTHY)),
      trailStatusLabel("archived", computeTrailHealth(HEALTHY)),
    ];
    for (const c of cases) {
      assert.match(c, /^(Active|Fresh today|Needs updates|Seasonal|Quiet right now)$/, c);
      assert.ok(!/\d/.test(c), `a status label must carry no number: ${c}`);
    }
  });

  it("fresh content in an active Trail reads 'Fresh today'; an inert one reads 'Quiet right now'", () => {
    assert.equal(trailStatusLabel("active", computeTrailHealth(HEALTHY)), "Fresh today");
    const quiet = computeTrailHealth({
      ...HEALTHY,
      members: HEALTHY.members.map((m) => ({ ...m, created_at: daysAgo(60) })),
    });
    assert.equal(trailStatusLabel("active", quiet), "Quiet right now");
  });
});

// ── DV-23 / DV-13: §10 saturation control ───────────────────────────────────

describe("DV-23 + DV-13 — §10 saturation: diversify creators and places, preserve access", () => {
  const item = (id: string, placeId: string | null, contributorId: string | null, mediaType = "photo") =>
    ({ id, placeId, contributorId, mediaType });

  it("one creator cannot take more than MAX_PER_CONTRIBUTOR_PER_PAGE slots (DV-13)", () => {
    const items = Array.from({ length: 9 }, (_, i) => item(`i${i}`, `p${i}`, "hog"));
    const r = diversifyTrailPage(items, { pageSize: 9 });
    assert.equal(r.page.length, MAX_PER_CONTRIBUTOR_PER_PAGE);
    assert.equal(r.suppressed.length, 9 - MAX_PER_CONTRIBUTOR_PER_PAGE);
    assert.ok(r.suppressed.every((s) => s.reason === "contributor_cap"));
  });

  it("near-duplicates about one place are capped and the rest stay REACHABLE via moreFromThisPlace", () => {
    const items = Array.from({ length: 6 }, (_, i) => item(`i${i}`, "same-place", `c${i}`));
    const r = diversifyTrailPage(items, { pageSize: 6 });
    assert.equal(r.page.length, MAX_PER_PLACE_PER_PAGE);
    assert.equal(r.moreFromThisPlace["same-place"], 6 - MAX_PER_PLACE_PER_PAGE,
      "§10: 'preserve access through more from this place' — the remainder is counted, not deleted");
  });

  it("media is diversified — a page of one media type gives way to the other when one exists", () => {
    const items = [
      item("v1", "p1", "c1", "video"), item("v2", "p2", "c2", "video"),
      item("v3", "p3", "c3", "video"), item("t1", "p4", "c4", "text"),
    ];
    const r = diversifyTrailPage(items, { pageSize: 3, maxPerMediaType: 2 });
    assert.equal(r.page.filter((i) => i.mediaType === "video").length, 2);
    assert.ok(r.page.some((i) => i.mediaType === "text"));
  });

  it("items with no place and no contributor are NOT silently dropped — an unknown is not a cap hit", () => {
    const items = Array.from({ length: 4 }, (_, i) => item(`i${i}`, null, null));
    const r = diversifyTrailPage(items, { pageSize: 4 });
    assert.equal(r.page.length, 4);
    assert.deepEqual(r.suppressed, []);
  });

  it("a diverse page is returned in its input order, untouched", () => {
    const items = [item("a", "p1", "c1"), item("b", "p2", "c2"), item("c", "p3", "c3")];
    const r = diversifyTrailPage(items, { pageSize: 3 });
    assert.deepEqual(r.page.map((i) => i.id), ["a", "b", "c"]);
  });
});

// ── DV-22: §9 fair exposure with denominators ───────────────────────────────

describe("DV-22 — §9 every eligible NEW item gets a bounded exploration opportunity", () => {
  const cand = (id: string, state: string, impressions: number, positives: number) =>
    ({ id, state, impressions, positives });

  it("a brand-new item qualifies for a reserved slot; an established one does not", () => {
    const r = fairExposureSlots([
      cand("new", "just_arrived", 0, 0),
      cand("old", "evergreen", 5000, 500),
    ], { pageSize: 10 });
    assert.deepEqual(r.slots, ["new"]);
  });

  it("the exploration budget is BOUNDED — a page of new items cannot become all-exploration", () => {
    const items = Array.from({ length: 50 }, (_, i) => cand(`n${i}`, "just_arrived", 0, 0));
    const r = fairExposureSlots(items, { pageSize: 10 });
    assert.ok(r.slots.length <= 10 * 0.25, `${r.slots.length} slots exceeds §9's bounded opportunity`);
    assert.ok(r.slots.length >= 1);
  });

  it("§9 uses EXPOSURE DENOMINATORS — every evaluated item reports the denominator it was judged on", () => {
    const r = fairExposureSlots([
      cand("a", "growing", 100, 10),
      cand("b", "growing", 0, 0),
    ], { pageSize: 10 });
    assert.equal(r.denominators.a, 100);
    assert.equal(r.denominators.b, 0);
  });

  it("§9 step 4 — a normalized response above the floor EXPANDS, below it TAPERS, thin evidence is still EVALUATING", () => {
    const r = fairExposureSlots([
      cand("strong", "growing", 200, 40),
      cand("weak", "growing", 200, 0),
      cand("thin", "growing", 3, 1),
    ], { pageSize: 10 });
    assert.equal(r.decisions.strong, "expand");
    assert.equal(r.decisions.weak, "taper");
    assert.equal(r.decisions.thin, "evaluating",
      "a rate over three impressions is noise, and calling it a verdict is the over-claim §9 guards against");
  });

  it("§9 step 5 — a tapered item stays RETESTABLE rather than being permanently excluded", () => {
    const r = fairExposureSlots([cand("cooled", "archived_from_active_rotation", 500, 1)], { pageSize: 10 });
    assert.ok(r.retestable.includes("cooled"),
      "§9: 'periodically retest promising items' — exclusion must be reversible");
  });

  it("nothing here promises a number of impressions to any caller — §9's public prohibition", () => {
    const r = fairExposureSlots([cand("n", "just_arrived", 0, 0)], { pageSize: 10 });
    assert.deepEqual(Object.keys(r).sort(), ["decisions", "denominators", "retestable", "slots"]);
  });
});
