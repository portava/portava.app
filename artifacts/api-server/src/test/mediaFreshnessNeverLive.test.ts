/**
 * census-media MD71 — "may a photo ever be labelled live?" Lead ruling D-26b
 * (docs/ops/lead-rulings-20261007-media.md): NO. The media freshness class is
 * capped at `fresh`, and the spec's §10 union is amended to match for media.
 *
 * Two places could put "live" on a media item:
 *   A. the writer — mediaEvidenceEligibility.computeFreshnessClass, which stamps
 *      `media_assets.intelligence_eligibility` — must never compute it;
 *   B. the reader — mediaAssetContract.toMediaAsset, which maps that stored jsonb
 *      to the §6 MediaAsset every canonical surface serves — must never pass a
 *      stored "live" through. Before D-26b it did (`fc === "live" || …`), so any
 *      row written with "live" by any path was served as live.
 *
 * Run: node --import tsx/esm --test src/test/mediaFreshnessNeverLive.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeFreshnessClass } from "../lib/media/mediaEvidenceEligibility.js";
import { toMediaAsset } from "../lib/media/mediaAssetContract.js";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const MIN = 60 * 1000;

function assetRow(freshnessClass: unknown): Record<string, unknown> {
  return {
    id: "a1", owner_user_id: "u1", storage_bucket: "post-media", storage_path: "u1/a1.jpg", media_type: "image",
    intelligence_eligibility: { eligible: true, reasons: [], freshnessClass, captureConfidence: 0.9, locationConfidence: 0.5, provenanceConfidence: 0.5 },
  };
}

describe("A. the writer never computes 'live'", () => {
  it("over ages from the future to a year old, and over unreadable capture times", () => {
    const seen = new Set<string>();
    for (const ageMin of [-60, -1, 0, 1, 30, 59, 60, 61, 600, 1439, 1440, 1441, 60 * 24 * 365]) {
      seen.add(computeFreshnessClass(new Date(NOW - ageMin * MIN).toISOString(), NOW));
    }
    for (const bad of [null, undefined, "", "not-a-date"]) seen.add(computeFreshnessClass(bad as any, NOW));
    assert.ok(!seen.has("live"), `computed: ${[...seen].join(", ")}`);
    assert.deepEqual([...seen].sort(), ["fresh", "historical", "recent"], "precondition: every class the media side does emit is exercised");
  });
});

describe("B. the reader never serves 'live'", () => {
  it("a stored 'live' is served at the cap, 'fresh'", () => {
    const a = toMediaAsset(assetRow("live"));
    assert.ok(a && a.intelligenceEligibility);
    assert.equal(a!.intelligenceEligibility!.freshnessClass, "fresh");
  });

  it("every other stored value is served exactly as before ('fresh', 'recent'; anything else 'historical')", () => {
    const served = (v: unknown) => toMediaAsset(assetRow(v))!.intelligenceEligibility!.freshnessClass;
    assert.equal(served("fresh"), "fresh");
    assert.equal(served("recent"), "recent");
    assert.equal(served("historical"), "historical");
    assert.equal(served("LIVE"), "historical");
    assert.equal(served(undefined), "historical");
    assert.equal(served(42), "historical");
  });
});
