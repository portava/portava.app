/**
 * attachUniversalArtwork — proves that AI universal artwork URLs survive the
 * v2-definition -> legacy PassportStamp enrichment used by GET /me/stamps,
 * and that stamps without matching artwork are returned unchanged.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { attachUniversalArtwork } from "../lib/stampArtworkEnrichment.js";

const ART = "https://cdn.example/art/cebu.png";

describe("attachUniversalArtwork", () => {
  it("attaches artwork to a city stamp matched by stamp_type + city", () => {
    const out = attachUniversalArtwork(
      [{ id: "1", kind: "city", label: "CEBU" }],
      [{ city: "Cebu", stampType: "city", universalArtworkUrl: ART }],
    );
    assert.equal(out[0].universalArtworkUrl, ART);
  });

  it("falls back to stamp_type-only match for non-city kinds", () => {
    const out = attachUniversalArtwork(
      [{ id: "1", kind: "gem", label: "HIDDEN GEM" }],
      [{ city: null, stampType: "hidden_gem", universalArtworkUrl: ART }],
    );
    assert.equal(out[0].universalArtworkUrl, ART);
  });

  it("leaves stamps without matching artwork unchanged", () => {
    const out = attachUniversalArtwork(
      [{ id: "1", kind: "host", label: "FIRST HOST" }],
      [{ city: null, stampType: "city", universalArtworkUrl: ART }],
    );
    assert.equal(out[0].universalArtworkUrl, undefined);
  });

  it("ignores source rows with null artwork", () => {
    const out = attachUniversalArtwork(
      [{ id: "1", kind: "city", label: "CEBU" }],
      [{ city: "Cebu", stampType: "city", universalArtworkUrl: null }],
    );
    assert.equal(out[0].universalArtworkUrl, undefined);
  });

  it("preserves all original legacy fields", () => {
    const stamp = { id: "1", kind: "city", label: "CEBU", earnedAt: "2026-01-01", locked: false };
    const out = attachUniversalArtwork(
      [stamp],
      [{ city: "cebu", stampType: "city", universalArtworkUrl: ART }],
    );
    assert.deepEqual(out[0], { ...stamp, universalArtworkUrl: ART });
  });
});
