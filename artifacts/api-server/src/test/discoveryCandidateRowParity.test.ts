/**
 * discoveryCandidateRowParity.test.ts — census-discovery §95 (lane W11-X3;
 * register D-W11X3-3): the two differences §85 (D-W10-R3-1) stated between a
 * GENERATED Discovery row and one the route read — `distanceKm` null, and the
 * vote/review aggregates absent — are closed.
 *
 *   R1  the restated helpers are the route's, token for token (haversineKm,
 *       batchFetchVoteAndRatingAggregates)
 *   R2  with a centre, a generated curated row and a generated canonical row
 *       carry the route's distanceKm; with none, null (as queryDbPlaces)
 *   R3  a generated curated row carries the route's aggregates; a canonical
 *       row, and a curated row with no votes or reviews, carry no aggregate key
 *   R4  an unreadable aggregate read serves the rows without counts, as the route
 *   R5  through rankForViewer (the PDE serve path, 3480 on): the centre option
 *       reaches every generated row; without it the rows are §85's exactly
 *
 * Controlled data only.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { haversineKm, servedDistanceKm } from "../lib/discoveryPlaceAggregates.js";
import { materialiseCandidates } from "../lib/discoveryCandidates/materialize.js";
import { rankForViewer } from "../lib/discoveryPde.js";
import { invalidateDiscoveryModifiersFlagCache } from "../lib/discoveryModifiers.js";
import { PIPELINE_FLAGS_OFF, type PipelineFlags } from "../lib/discoveryCandidates/pipelineFlags.js";
import { makeFakeCandidateDb, type Row } from "./helpers/fakeCandidateDb.js";
import { NOW, P, VIEWER, pool, viewer, world } from "./helpers/candidateWorld.js";

const ROUTE = readFileSync(new URL("../routes/discovery.ts", import.meta.url), "utf8");
const LIB = readFileSync(new URL("../lib/discoveryPlaceAggregates.ts", import.meta.url), "utf8");
const ON: PipelineFlags = { ...PIPELINE_FLAGS_OFF, candidateSources: true };
const CENTER = { lat: 25.76, lng: -80.2 };

/** One top-level function's text, from its signature to the closing brace at column 0. */
function fnText(src: string, signature: string): string {
  const at = src.indexOf(signature);
  assert.ok(at >= 0, signature);
  const end = src.indexOf("\n}\n", at);
  return src.slice(at, end + 2).replace(/^export /, "").replace(/\s+/g, " ");
}

function withAggregates(): Record<string, Row[]> {
  const w = world();
  w["place_votes"] = [
    { entity_type: "place", entity_id: P.FOLLOWED, vote: "worth_it" },
    { entity_type: "place", entity_id: P.FOLLOWED, vote: "worth_it" },
    { entity_type: "place", entity_id: P.FOLLOWED, vote: "not_worth_it" },
    { entity_type: "gem", entity_id: P.FOLLOWED, vote: "worth_it" },
  ];
  w["reviews"] = [
    { entity_type: "place", entity_id: P.FOLLOWED, rating: 4, state: "published" },
    { entity_type: "place", entity_id: P.FOLLOWED, rating: "4.6", state: "published" },
    { entity_type: "place", entity_id: P.FOLLOWED, rating: 1, state: "draft" },
  ];
  return w;
}

beforeEach(() => invalidateDiscoveryModifiersFlagCache());

describe("R — a generated row is the route's row, distance and aggregates included", () => {
  it("R1 the restated helpers are the route's, token for token", () => {
    assert.equal(fnText(LIB, "export function haversineKm("), fnText(ROUTE, "function haversineKm("));
    const route = fnText(ROUTE, "async function batchFetchVoteAndRatingAggregates(").replace("sc: ReturnType<typeof getServiceClient>,", "sc: any,");
    assert.equal(fnText(LIB, "export async function batchFetchVoteAndRatingAggregates("), route);
    // The route's rounding, used at each of its distance sites.
    assert.ok(ROUTE.includes("Math.round(haversineKm(centerLat, centerLng, lat, lng) * 10) / 10"));
    assert.equal(servedDistanceKm({ lat: 0, lng: 0 }, 0, 1), Math.round(haversineKm(0, 0, 0, 1) * 10) / 10);
    assert.equal(servedDistanceKm({ lat: 0, lng: 0 }, 0, 1), 111.2);
  });

  it("R2 with a centre, curated and canonical rows carry the route's distanceKm; without one, null", async () => {
    const ids = [`db/${P.FOLLOWED}`, `db/${P.GRAPH_TWO}`];
    const on = await materialiseCandidates(makeFakeCandidateDb(world()), ids, { viewerId: VIEWER, cityPrefix: "miami", admitted: null, center: CENTER });
    const curated = on.rows.get(`db/${P.FOLLOWED}`)!, canonical = on.rows.get(`db/${P.GRAPH_TWO}`)!;
    assert.ok(curated && canonical, "both kinds materialised");
    for (const r of [curated, canonical]) {
      assert.notEqual(r.lat, null);
      assert.equal(r.distanceKm, Math.round(haversineKm(CENTER.lat, CENTER.lng, r.lat!, r.lng!) * 10) / 10);
    }
    const off = await materialiseCandidates(makeFakeCandidateDb(world()), ids, { viewerId: VIEWER, cityPrefix: "miami", admitted: null });
    for (const r of off.rows.values()) assert.equal(r.distanceKm, null);
  });

  it("R3 curated rows carry the route's aggregates; canonical and aggregate-less rows carry no key", async () => {
    const ids = [`db/${P.FOLLOWED}`, `db/${P.SIMILAR}`, `db/${P.GRAPH_TWO}`];
    const out = await materialiseCandidates(makeFakeCandidateDb(withAggregates()), ids, { viewerId: VIEWER, cityPrefix: "miami", admitted: null });
    const f = out.rows.get(`db/${P.FOLLOWED}`)!;
    assert.deepEqual([f.worthItCount, f.avgRating, f.reviewCount], [2, 4.3, 2]);
    assert.deepEqual(Object.keys(f).slice(-3), ["worthItCount", "avgRating", "reviewCount"], "merged after the row's own keys, as the route spreads them");
    for (const id of [`db/${P.SIMILAR}`, `db/${P.GRAPH_TWO}`]) {
      const r = out.rows.get(id)!;
      assert.ok(r, id);
      assert.ok(!("worthItCount" in r) && !("avgRating" in r) && !("reviewCount" in r), id);
    }
  });

  it("R4 an unreadable aggregate read serves the rows without counts", async () => {
    const ids = [`db/${P.FOLLOWED}`];
    const throwing = makeFakeCandidateDb(withAggregates());
    const from = throwing.from.bind(throwing);
    (throwing as { from: (t: string) => unknown }).from = (t: string) => { if (t === "place_votes") throw new Error("down"); return from(t); };
    const out = await materialiseCandidates(throwing, ids, { viewerId: VIEWER, cityPrefix: "miami", admitted: null });
    const f = out.rows.get(`db/${P.FOLLOWED}`)!;
    assert.ok(f);
    assert.ok(!("worthItCount" in f));
    assert.deepEqual(out.failedReads, []);
  });

  it("R5 through rankForViewer with 3480 on: the centre reaches every generated row; without it, §85's rows", async () => {
    const withC = await rankForViewer(pool(), viewer(), { sc: makeFakeCandidateDb(world()), served: true, nowMs: NOW, pipelineFlags: ON, category: "food", center: CENTER });
    const without = await rankForViewer(pool(), viewer(), { sc: makeFakeCandidateDb(world()), served: true, nowMs: NOW, pipelineFlags: ON, category: "food" });
    const poolIds = new Set(pool().map((p) => p.id));
    const gen = withC.ranked.filter((p) => !poolIds.has(p.id));
    assert.ok(gen.length > 0, "generation added rows");
    for (const p of gen) {
      assert.notEqual(p.distanceKm, null, p.id);
      assert.equal(p.distanceKm, servedDistanceKm(CENTER, p.lat ?? null, p.lng ?? null));
    }
    for (const p of without.ranked.filter((q) => !poolIds.has(q.id))) assert.equal(p.distanceKm, null, p.id);
    // Pool rows are the caller's, untouched either way.
    for (const p of withC.ranked.filter((q) => poolIds.has(q.id))) assert.equal(p.distanceKm, pool().find((q) => q.id === p.id)!.distanceKm);
  });
});
