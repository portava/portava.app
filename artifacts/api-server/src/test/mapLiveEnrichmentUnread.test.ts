/**
 * census-discovery §114 (DV-83 round 17, lane W11-X2; sweep SW4): an object whose live claims were not read carries
 * that fact to the client.
 *
 * `enrichWithLiveClaims` reads live claims for at most LIVE_ENRICHMENT_MAX_SUBJECTS eligible objects and fails a
 * throwing read closed to "no claim". It reported the cap only as the aggregate `liveEnrichment.skipped` — which no
 * client renders — so the place sheet said "No live activity has been observed here" for a place nobody looked at.
 * The skipped objects, and an object whose read threw, now carry `liveUnread: true`.
 *
 *   LE1  past the cap: the skipped objects carry liveUnread; the ones read do not
 *   LE2  a throwing read → the object carries liveUnread (still no claim, never a stale one)
 *   LE0  CONTROL: within the cap, a read that answers no claim → the object is unchanged (byte-identical)
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { enrichWithLiveClaims, projectGem } from "../lib/mapProjection.js";

const GEM = { id: "g1", canonical_place_id: "place-uuid-for-g1", name: "Rooftop stairwell", category: "viewpoint", city: "Da Nang", status: "active", image_url: null, verification_level: "community", coordsPrecision: "exact", lat: 16.06, lng: 108.21 };
const gems = (n: number) => Array.from({ length: n }, (_, i) => projectGem({ ...GEM, id: `g${i}`, canonical_place_id: `place-${i}` })!);
const NOW = Date.parse("2026-09-30T12:00:00.000Z");

describe("§114 SW4: an object whose live claims were not read says so", () => {
  test("LE1 past the cap, the skipped objects carry liveUnread; the ones read do not", async () => {
    const res = await enrichWithLiveClaims(gems(5), async () => [], { max: 3, now: NOW });
    assert.equal(res.skipped, 2);
    assert.deepEqual(res.objects.map((o) => (o as { liveUnread?: true }).liveUnread === true), [false, false, false, true, true]);
  });

  test("LE2 a throwing read → liveUnread, and still no claim", async () => {
    const res = await enrichWithLiveClaims(gems(2), async (id) => { if (id === "place-1") throw new Error("db down"); return []; }, { now: NOW });
    assert.deepEqual(res.objects.map((o) => (o as { liveUnread?: true }).liveUnread === true), [false, true]);
    assert.equal(res.objects[1]!.activity, undefined);
  });

  test("LE0 CONTROL: within the cap, no claim → every object unchanged", async () => {
    const input = gems(3);
    const res = await enrichWithLiveClaims(input, async () => [], { now: NOW });
    assert.deepEqual(res.objects, input);
  });
});
