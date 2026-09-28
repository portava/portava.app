/**
 * discoveryColdStart — census-discovery §85 (lane W10-R3), DV-55: `06` §9's
 * cold start, behind `discovery_cold_start_enabled` (3482, seeded FALSE).
 *
 * CONTROLLED DATA. ranker-hold-designs.md design 3's tests, and the three
 * `06` §9 cases:
 *
 *   C1  new user: onboarding interests reach the ranker as stated interests,
 *       and a place matching one earns the interestTag feature
 *   C2  a viewer at or above the observation floor is untouched
 *   C3  an unreadable profile degrades to today's behaviour and says so
 *   C4  nothing is written back — not to profiles, not to Compass preferences
 *   C5  destination/trip context: the place types the viewer saved as trip
 *       ideas are stated interests too; local context is the destination
 *   C6  new creator / new Trail / new place ride DV-53's buckets and the
 *       exploration-pool source (their own suites); here, that a cold viewer
 *       with all three flags on is ranked with every one of them recorded
 *
 * Runtime: node:test + node:assert/strict.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rankForViewer } from "../lib/discoveryPde.js";
import { invalidateDiscoveryModifiersFlagCache } from "../lib/discoveryModifiers.js";
import { applyColdStart } from "../lib/discoveryCandidates/viewerColdStart.js";
import { PIPELINE_FLAGS_OFF, type PipelineFlags } from "../lib/discoveryCandidates/pipelineFlags.js";
import { makeFakeCandidateDb } from "./helpers/fakeCandidateDb.js";
import { NOW, pool, viewer, world } from "./helpers/candidateWorld.js";

const COLD: PipelineFlags = { ...PIPELINE_FLAGS_OFF, coldStart: true };
const newUser = () => viewer({ categoryAffinities: undefined, interestTags: new Set(), followedIds: new Set(), placeAffinities: {} });

beforeEach(() => invalidateDiscoveryModifiersFlagCache());

describe("DV-55 — cold start for a new viewer", () => {
  it("C1. onboarding interests become stated interests, and a matching place earns interestTag", async () => {
    const places = pool().map((p) => (p.id === "node/103" ? { ...p, tags: ["rooftop"] } : p));
    const before = await rankForViewer(places, newUser(), { sc: makeFakeCandidateDb(world()), served: true, nowMs: NOW, pipelineFlags: { ...PIPELINE_FLAGS_OFF } });
    const after = await rankForViewer(places, newUser(), { sc: makeFakeCandidateDb(world()), served: true, nowMs: NOW, pipelineFlags: COLD });
    assert.equal(before.scoredById.get("node/103")!.features["interestTag"], 0);
    assert.ok(after.scoredById.get("node/103")!.features["interestTag"]! > 0, "\"Rooftop\" from profiles.interests matched");
    const cs = after.stages.coldStart!;
    assert.equal(cs.cold, true); assert.equal(cs.applied, true);
    assert.equal(cs.seeded.onboarding, 4, "rooftop, live_music, foodie, slow");
  });

  it("C2. a viewer at or above the observation floor is untouched", async () => {
    const v = viewer();   // categoryAffinities present ⇒ not cold
    const r = await applyColdStart(makeFakeCandidateDb(world()), v);
    assert.equal(r.report.cold, false);
    assert.equal(r.viewer, v, "the same object back — nothing read, nothing changed");
  });

  it("C3. an unreadable profile degrades to today's behaviour and says so", async () => {
    const db = makeFakeCandidateDb(world(), { erroring: ["profiles", "trip_saved_places"] });
    const v = newUser();
    const r = await applyColdStart(db, v);
    assert.deepEqual(r.report.degraded, ["profile", "trip_ideas"]);
    assert.equal(r.report.applied, false);
    assert.equal(r.viewer, v);
  });

  it("C4. nothing is written back", async () => {
    const db = makeFakeCandidateDb(world());
    await rankForViewer(pool(), newUser(), { sc: db, served: true, nowMs: NOW, pipelineFlags: COLD });
    assert.deepEqual(db.writes.filter((w) => ["profiles", "compass_user_preferences"].includes(w.table)), []);
  });

  it("C5. trip context: saved trip-idea place types are stated interests; local context is the destination", async () => {
    const r = await applyColdStart(makeFakeCandidateDb(world()), newUser());
    assert.ok(r.viewer.interestTags.has("rooftop bar"));
    assert.ok(r.viewer.interestTags.has("cafe"));
    assert.equal(r.report.seeded.tripContext, 2);
    assert.equal(r.report.local, "request_destination");
    assert.equal(newUser().interestTags.size, 0, "the caller's viewer is not mutated");
  });

  it("C6. a cold viewer with generation, inventory and cold start on: every stage recorded", async () => {
    const o = await rankForViewer(pool(), newUser(), {
      sc: makeFakeCandidateDb(world()), served: true, nowMs: NOW, category: "food",
      pipelineFlags: { ...PIPELINE_FLAGS_OFF, coldStart: true, candidateSources: true, explorationInventory: true },
    });
    assert.ok(o.stages.coldStart?.applied);
    assert.ok((o.stages.candidateGeneration?.sources.exploration_pool?.retrieved ?? 0) > 0, "new places are retrieved for the cold viewer");
    assert.ok((o.stages.candidateGeneration?.sources.trending_local?.retrieved ?? 0) > 0, "local context: the city's trending places");
    assert.ok(o.stages.explorationInventory, "new creators / new Trails / emerging places have reserved slots");
  });
});
