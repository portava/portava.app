/**
 * discoveryCandidateSources — census-discovery §85 (lane W10-R3), DC-12 and
 * DV-49: `06` §2's candidate sources on the PDE path, behind
 * `discovery_candidate_sources_enabled` (3480, seeded FALSE).
 *
 * CONTROLLED DATA (helpers/candidateWorld.ts). These tests prove the code does
 * what it says over a fixed corpus; they are not production evidence and claim
 * nothing about effectiveness.
 *
 *   S1  each built retrieval returns exactly the rows its source names
 *   S2  generated rows reach the ranked output on the served path; pool rows a
 *       retrieval names are CLAIMED, not duplicated
 *   S3  eligibility: blocked, inactive, demo, other-city and off-tab rows are
 *       never generated
 *   S4  the Map reader and shadow runs (served:false) never add a row
 *   S5  graph (DV-49): a place needs two distinct travellers
 *   S6  circle context runs only under its own consent-gated flag
 *   S7  a failed read is reported per source and the others still run
 *   S8  every scored row carries its sources to rank_events (record_metadata)
 *   S9  the flag is read from feature_flags, fail-closed
 *   M1–M3  a generated row is the route's row, field for field
 *
 * Runtime: node:test + node:assert/strict.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rankForViewer } from "../lib/discoveryPde.js";
import { invalidateDiscoveryModifiersFlagCache } from "../lib/discoveryModifiers.js";
import { PIPELINE_FLAGS_OFF, loadPipelineFlags, type PipelineFlags } from "../lib/discoveryCandidates/pipelineFlags.js";
import { generateCandidates, MAX_GENERATED } from "../lib/discoveryCandidates/generate.js";
import {
  retrieveFollowedCreators, retrieveCurrentTrail, retrieveRelatedTrails, retrieveTripDestination, retrieveSavedSimilar,
  retrieveTrendingLocal, retrieveEmergingDiscoveries, retrieveExplorationPool, retrieveGraphRelated, retrieveCircleContext,
  type RetrievalContext,
} from "../lib/discoveryCandidates/retrievals.js";
import { DISCOVERY_PLACES_SELECT, CANONICAL_PLACES_SELECT, DEMO_SOURCES, mapDiscoveryPlacesRow } from "../lib/discoveryCandidates/materialize.js";
import { DISCOVERY_CANDIDATE_SOURCES, SPEC_06_CANDIDATE_SOURCES } from "../lib/discoveryCandidates/candidateSources.js";
import { pdeFeatureProvenanceFeatures, PDE_ITEM_PIPELINE_KEYS } from "../lib/discoveryRankProvenance.js";
import { DISCOVERY_FEATURE_KEY_CLASSES } from "../lib/discoveryRecommendationRecord.js";
import { makeFakeCandidateDb, flagRow } from "./helpers/fakeCandidateDb.js";
import { NOW, P, VIEWER, pool, viewer, world } from "./helpers/candidateWorld.js";

const ON: PipelineFlags = { ...PIPELINE_FLAGS_OFF, candidateSources: true };
const db = (over: Parameters<typeof makeFakeCandidateDb>[1] = {}) => makeFakeCandidateDb(world(), over);
const ctxOf = (sc: unknown): RetrievalContext => ({
  sc, userId: VIEWER, cityPrefix: "miami", followedIds: viewer().followedIds,
  viewedPlaceIds: Object.keys(viewer().placeAffinities ?? {}), nowMs: NOW, memo: new Map(),
});

beforeEach(() => invalidateDiscoveryModifiersFlagCache());

describe("S1 — each §85 retrieval returns what its source names", () => {
  it("followed creators: the followed authors' active Miami rows (eligibility is materialisation's)", async () => {
    const r = await retrieveFollowedCreators(ctxOf(db()));
    assert.equal(r.status, "ok");
    assert.ok(r.ids.includes(`db/${P.FOLLOWED}`));
    assert.ok(!r.ids.includes(`db/${P.OTHER_CITY}`), "the city filter is in the read");
  });
  it("current Trail: members of followed, non-archived Trails", async () => {
    const r = await retrieveCurrentTrail(ctxOf(db()));
    assert.deepEqual(r.ids, [`db/${P.TRAIL_MEMBER}`]);
  });
  it("related Trails: members of Trails related to a followed one, never the followed one's", async () => {
    const r = await retrieveRelatedTrails(ctxOf(db()));
    assert.deepEqual(r.ids, [`db/${P.RELATED_MEMBER}`]);
  });
  it("trip destination: the viewer's own saved trip ideas, in served id space", async () => {
    const r = await retrieveTripDestination(ctxOf(db()));
    assert.deepEqual(r.ids, [`db/${P.TRIP_IDEA}`, "node/5"]);
  });
  it("saved-similar: same category as a saved place, the saved place itself excluded", async () => {
    const r = await retrieveSavedSimilar(ctxOf(db()));
    assert.ok(r.ids.includes(`db/${P.SIMILAR}`));
    assert.ok(!r.ids.includes(`db/${P.SAVED}`));
    assert.equal(r.ids[0], `db/${P.SIMILAR}`, "ordered by saved_count");
  });
  it("trending local / emerging: the LATEST run's claims only", async () => {
    const t = await retrieveTrendingLocal(ctxOf(db()));
    const e = await retrieveEmergingDiscoveries(ctxOf(db()));
    assert.deepEqual(t.ids, [`db/${P.TRENDING}`, "node/101"]);
    assert.deepEqual(e.ids, [`db/${P.EMERGING}`]);
    assert.ok(!t.ids.includes(`db/${P.STALE_RUN}`), "an older run's claim is not current");
  });
  it("exploration pool: Miami places first submitted inside the window", async () => {
    const r = await retrieveExplorationPool(ctxOf(db()));
    assert.ok(r.ids.includes(`db/${P.NEW_PLACE}`));
    assert.ok(!r.ids.includes(`db/${P.SIMILAR}`), "an old place is not new");
  });
  it("the registry names all eleven `06` §2 sources, and each is built or the caller's", () => {
    assert.equal(SPEC_06_CANDIDATE_SOURCES.length, 11);
    for (const s of SPEC_06_CANDIDATE_SOURCES) assert.ok(DISCOVERY_CANDIDATE_SOURCES[s], s);
    assert.ok(DISCOVERY_CANDIDATE_SOURCES["graph_related"], "DV-49's graph retrieval is declared");
  });
});

describe("S2–S4 — generation on the PDE path", () => {
  it("S2. with the flag on, served: generated rows are ranked and returned; a claimed pool row is not duplicated", async () => {
    const o = await rankForViewer(pool(), viewer(), { sc: db(), served: true, nowMs: NOW, pipelineFlags: ON, category: "food" });
    const ids = o.ranked.map((p) => p.id);
    for (const id of [P.FOLLOWED, P.TRAIL_MEMBER, P.RELATED_MEMBER, P.TRIP_IDEA, P.SIMILAR, P.TRENDING, P.EMERGING, P.NEW_PLACE, P.GRAPH_TWO]) {
      assert.ok(ids.includes(`db/${id}`), `db/${id} generated`);
    }
    assert.equal(ids.filter((i) => i === `db/${P.POOL_DB}`).length, 1, "the pool row appears once");
    const poolDb = o.candidateSources?.get(`db/${P.POOL_DB}`) ?? [];
    assert.equal(poolDb[0], "caller_pool", "a pool row is attributed to the caller's reads first");
    assert.ok(poolDb.includes("followed_creators"), "…and claimed by every retrieval that named it");
    assert.deepEqual(o.candidateSources?.get("node/5"), ["caller_pool", "trip_destination"], "an OSM id can only CLAIM a pool row");
    assert.ok(o.scoredById.has(`db/${P.FOLLOWED}`), "a generated row is SCORED like any other");
    assert.equal(o.stages.candidateGeneration?.sources.followed_creators?.added, 1);
  });

  it("S3. eligibility: blocked, inactive, demo, other-city and off-tab rows are never generated", async () => {
    const o = await rankForViewer(pool(), viewer(), { sc: db(), served: true, nowMs: NOW, pipelineFlags: ON, category: "food" });
    const ids = new Set(o.ranked.map((p) => p.id));
    // (An archived Trail's member, an older run's claim and a one-traveller graph
    // place are excluded by their RETRIEVALS — S1 and S5; other sources, such as
    // saved-similar, may still name them legitimately.)
    for (const id of [P.BLOCKED, P.INACTIVE, P.DEMO, P.OTHER_CITY, P.NIGHTLIFE]) {
      assert.ok(!ids.has(`db/${id}`), `db/${id} must not be generated`);
    }
    const g = o.stages.candidateGeneration!;
    assert.equal(g.refused.blocked, 1);
    assert.equal(g.refused.standing, 1);
    assert.equal(g.refused.demo, 1);
    assert.ok(g.refused.category >= 1, "the nightlife row is refused on the food tab");
  });

  it("S3b. an unreadable block set drops every authored generated row (fail closed)", async () => {
    const o = await rankForViewer(pool(), viewer(), { sc: db({ erroring: ["blocks"] }), served: true, nowMs: NOW, pipelineFlags: ON, category: "food" });
    const ids = new Set(o.ranked.map((p) => p.id));
    assert.ok(!ids.has(`db/${P.FOLLOWED}`), "an authored row is not served when blocks cannot be read");
    assert.ok(ids.has(`db/${P.NEW_PLACE}`), "an authorless venue fact still is");
    assert.ok(o.stages.candidateGeneration!.materialiseFailedReads.includes("blocks"));
  });

  it("S4. served:false (the Map reader, shadow runs) never adds a row", async () => {
    const o = await rankForViewer(pool(), viewer(), { sc: db(), served: false, nowMs: NOW, pipelineFlags: ON, category: "food" });
    assert.deepEqual(o.ranked.map((p) => p.id).sort(), pool().map((p) => p.id).sort());
    assert.equal(o.stages.candidateGeneration?.skipped, "not_served");
    assert.equal(o.candidateSources, undefined);
  });

  it("S4b. with the flag OFF nothing is generated and no §85 stage key is written", async () => {
    const o = await rankForViewer(pool(), viewer(), { sc: db(), served: true, nowMs: NOW, pipelineFlags: { ...PIPELINE_FLAGS_OFF }, category: "food" });
    assert.deepEqual(o.ranked.map((p) => p.id).sort(), pool().map((p) => p.id).sort());
    for (const k of ["candidateGeneration", "coldStart", "explorationInventory", "integrity", "outcomeLearning"]) assert.ok(!(k in o.stages), k);
    assert.ok(!("candidateSources" in o));
    for (const s of o.scoredById.values()) for (const k of PDE_ITEM_PIPELINE_KEYS) assert.ok(!(k in pdeFeatureProvenanceFeatures(s)), k);
  });

  it("cap: at most MAX_GENERATED rows are added", async () => {
    const w = world();
    for (let i = 0; i < 150; i++) w["discovery_places"]!.push({ ...w["discovery_places"]![1]!, id: `00000000-0000-4000-9000-${String(i).padStart(12, "0")}`, name: `bulk ${i}`, lat: 20 + i / 10, created_at: new Date(NOW - 1000 * i).toISOString() });
    const g = await generateCandidates(makeFakeCandidateDb(w), pool(), viewer(), { nowMs: NOW, category: "food", circle: false });
    assert.ok(g.report.generated <= MAX_GENERATED);
  });
});

describe("S5–S7 — the graph, the circle, and failure", () => {
  it("S5. graph (DV-49): the graph GENERATES a place two travellers reached from the viewer's seed; one traveller is not enough", async () => {
    const r = await retrieveGraphRelated(ctxOf(db()));
    assert.deepEqual(r.ids, [`db/${P.GRAPH_TWO}`]);
  });
  it("S6. circle context: nothing without its own flag; with it, places ≥2 circle mates publicly experienced", async () => {
    const off = await generateCandidates(db(), pool(), viewer(), { nowMs: NOW, category: "food", circle: false });
    assert.equal(off.report.sources.social_circle?.status, "flag_off");
    const r = await retrieveCircleContext(ctxOf(db()));
    assert.deepEqual(r.ids.sort(), [`db/${P.GRAPH_SEED}`, `db/${P.GRAPH_TWO}`].sort());
  });
  it("S7. a failed read is named on its source; the other sources still run", async () => {
    const g = await generateCandidates(db({ erroring: ["trail_follows"] }), pool(), viewer(), { nowMs: NOW, category: "food", circle: false });
    assert.equal(g.report.sources.current_trail?.status, "read_failed");
    assert.equal(g.report.sources.current_trail?.failedRead, "trail_follows");
    assert.equal(g.report.sources.related_trails?.status, "read_failed");
    assert.equal(g.report.sources.followed_creators?.status, "ok");
    assert.ok(g.report.generated > 0);
  });
});

describe("S8–S9 — the record and the flag", () => {
  it("S8. every scored row carries its candidate sources as record_metadata", async () => {
    const o = await rankForViewer(pool(), viewer(), { sc: db(), served: true, nowMs: NOW, pipelineFlags: ON, category: "food" });
    const s = o.scoredById.get(`db/${P.FOLLOWED}`)!;
    const srcs = pdeFeatureProvenanceFeatures(s)["candidateSources"] as string[];
    assert.equal(srcs[0], "followed_creators", "the source that ADDED the row comes first");
    assert.ok(!srcs.includes("caller_pool"), "a generated row was not the caller's");
    assert.deepEqual(pdeFeatureProvenanceFeatures(o.scoredById.get("node/100")!)["candidateSources"], ["caller_pool"]);
    for (const k of PDE_ITEM_PIPELINE_KEYS) assert.equal(DISCOVERY_FEATURE_KEY_CLASSES[k], "record_metadata", k);
  });
  it("S9. the flag row turns generation on; an unreadable flag read is off", async () => {
    const w = world(); w["feature_flags"] = [flagRow("discovery_candidate_sources_enabled", true)];
    const on = await rankForViewer(pool(), viewer(), { sc: makeFakeCandidateDb(w), served: true, nowMs: NOW, category: "food" });
    assert.ok((on.stages.candidateGeneration?.generated ?? 0) > 0);
    const bad = await rankForViewer(pool(), viewer(), { sc: makeFakeCandidateDb(w, { erroring: ["feature_flags"] }), served: true, nowMs: NOW, category: "food" });
    assert.equal(bad.stages.candidateGeneration, undefined);
    const bare = world(); bare["feature_flags"] = [{ enabled: true }];
    const b = await rankForViewer(pool(), viewer(), { sc: makeFakeCandidateDb(bare), served: true, nowMs: NOW, category: "food" });
    assert.equal(b.stages.candidateGeneration, undefined, "a row that does not name the flag turns nothing on");
    // A client (a view, a stub, a proxy) that ignores the `in(flag, …)` filter
    // and answers a bare `{ enabled: true }`, or a truthy non-boolean, must still turn nothing on.
    const careless = { from: () => ({ select: () => ({ in: async () => ({ data: [{ enabled: true }, { flag: "some_other_flag", enabled: true }, { flag: "discovery_candidate_sources_enabled", enabled: "false" }], error: null }) }) }) };
    assert.deepEqual(await loadPipelineFlags(careless, NOW), { ...PIPELINE_FLAGS_OFF });
  });
});

describe("M — a generated row is the route's row", () => {
  const route = readFileSync(new URL("../routes/discovery.ts", import.meta.url), "utf8");
  it("M1. the two selects are the route's, verbatim", () => {
    assert.ok(route.includes(`.select("${DISCOVERY_PLACES_SELECT}")`), "queryDbPlaces select");
    assert.ok(route.includes(`.select("${CANONICAL_PLACES_SELECT}")`), "queryCanonicalPlaces select");
  });
  it("M2. the demo sources are the route's", async () => {
    const { DEMO_DISCOVERY_SOURCES } = await import("../routes/discovery.js");
    assert.deepEqual([...DEMO_SOURCES].sort(), [...DEMO_DISCOVERY_SOURCES].sort());
  });
  it("M3. every field queryDbPlaces maps is mapped, and no other", () => {
    const start = route.indexOf(".map((row: any): DiscoveryPlace => {", route.indexOf("async function queryDbPlaces("));
    const body = route.slice(start, route.indexOf("});", start));
    const routeKeys = new Set([
      ...[...body.matchAll(/^\s+([a-zA-Z]+):/gm)].map((m) => m[1]!),
      ...[...body.matchAll(/, ([a-zA-Z]+): \(/g)].map((m) => m[1]!),
      ...[...body.matchAll(/^\s+([a-zA-Z]+),\s*$/gm)].map((m) => m[1]!),   // shorthand `lat,`
    ]);
    const ours = new Set(Object.keys(mapDiscoveryPlacesRow(world()["discovery_places"]![1])));
    assert.deepEqual([...ours].sort(), [...routeKeys].sort());
  });
});
