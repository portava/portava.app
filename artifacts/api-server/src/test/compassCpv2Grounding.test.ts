/**
 * compassCpv2Grounding — CPV2-02's `conflicting` fixture class, pinned.
 *
 * `docs/specs/upgrades-v2/01-COMPASS-v2.md:24` requires that "predicted,
 * inferred, conflicting, stale and unknown fixtures retain their qualification
 * in tool output, UI and generated explanation".
 *
 * Four of the five survive the Compass boundary already:
 *   - predicted / inferred  → `sourceClass` on the live-claim envelope
 *   - stale                 → `validUntil`, which `unexpired()` enforces
 *   - unknown               → `grounded: false`, always printed for both axes
 *
 * CONFLICTING did not. `lib/liveClaimRead.ts:132` states that a 'material'
 * conflict means the client renders "Reports differ" wherever it would have
 * rendered a Live label, and `readLiveClaims` caps the band for one — but a
 * capped band is indistinguishable from a merely weak single-source reading.
 * `CompassMediaContext`'s §32 comparator dropped `conflictState` on the floor,
 * so an axis whose reports materially disagree reached `/compass/ask`'s prompt
 * as a plain grounded baseline the model was told to compare against.
 *
 * That path is REACHABLE and UNGATED: `routes/compass.ts:1567` builds the media
 * context and `:1568` pushes its lines into the prompt.
 *
 * WHAT TURNS THESE RED: dropping `conflictState` from the baseline, dropping
 * the conflicted axis from the prompt line, or reading an unrecognised conflict
 * marker as anything other than 'material'. A3 is the control — it fails if the
 * guard ever passes by declaring every axis conflicted.
 *
 * Runtime: node:test + node:assert. No DB, no network.
 * Run: node --import tsx/esm --test src/test/compassCpv2Grounding.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildComparatorBaselines,
  buildSequencingAnchor,
  formatMediaContextLines,
  type CompassMediaContext,
  type ComparatorCandidateClaim,
} from "../compass/CompassMediaContext.js";

const NOW_MS = Date.parse("2026-09-14T12:00:00.000Z");

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

describe("CPV2-02 — a conflicting fixture keeps its qualification through the Compass boundary", () => {
  it("A1: a materially conflicted claim reaches the comparator baseline AS conflicted", () => {
    const axes = buildComparatorBaselines(
      [claim("crowd.level", { conflictState: "material" })],
      NOW_MS,
    );
    const quieter = axes.find((a) => a.axis === "quieter")!;
    assert.equal(quieter.grounded, true, "the claim is permitted and unexpired, so it still grounds the axis");
    assert.equal(
      quieter.conflictState,
      "material",
      "the conflict qualification must survive the reduction, not be flattened into the band",
    );
  });

  it("A2: the prompt states the conflicted axis as conflicted, not as a settled comparison", () => {
    const lines = formatMediaContextLines(mediaCtx({
      comparator: buildComparatorBaselines(
        [claim("crowd.level", { conflictState: "material" }), claim("price.cover")],
        NOW_MS,
      ),
    })).join("\n");
    assert.match(lines, /conflicted axes \(reports differ\): quieter/);
    assert.doesNotMatch(
      lines,
      /grounded axes: [^;]*quieter/,
      "a conflicted axis must not be offered as an ordinary grounded baseline",
    );
    assert.match(lines, /grounded axes: [^;]*cheaper/, "the unconflicted axis is still grounded");
    assert.match(lines, /reports about this place materially disagree/i);
  });

  it("A3 (control): with no conflict, nothing is declared conflicted and the axis stays grounded", () => {
    const lines = formatMediaContextLines(mediaCtx({
      comparator: buildComparatorBaselines([claim("crowd.level", { conflictState: "none" })], NOW_MS),
    })).join("\n");
    assert.match(lines, /grounded axes: [^;]*quieter/);
    assert.match(lines, /conflicted axes \(reports differ\): none/);
  });

  it("A4: an UNRECOGNISED conflict marker reads as material — fail-closed, never ignored", () => {
    const axes = buildComparatorBaselines(
      [claim("price.cover", { conflictState: "something-the-reader-does-not-know" })],
      NOW_MS,
    );
    assert.equal(axes.find((a) => a.axis === "cheaper")!.conflictState, "material");
  });

  it("A5: an ungrounded axis invents no conflict fact — it carries null, not 'none'", () => {
    const axes = buildComparatorBaselines([], NOW_MS);
    assert.deepEqual(axes.map((a) => a.conflictState), [null, null]);
  });
});
