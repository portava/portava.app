/**
 * mediaExperienceConfidence — §23 `confidence` on `MediaExperienceProjection`
 * (census-media MD169).
 *
 * MD169 graded the field **W**: *"the field exists on the shape but no
 * experience-level confidence is computed — the only confidence in the media
 * path is the per-forecast band in `mediaTimeBands`. A declared-but-unfilled
 * field."*
 *
 * THE THING THAT MAKES THIS CLOSABLE WITHOUT INVENTING A SIGNAL. Confidence is
 * defined once in this tree — `lib/confidenceScore`, whose header states the
 * formula is the specification's and that the module "never invents" one — and
 * the two honest inputs a set of photographs can supply already exist as
 * shipped, tested code: `buildVisualConsensus` (§18) turns perspectives into an
 * INDEPENDENT-SOURCE count with the anti-manipulation clustering already applied,
 * and reads the canonical conflict engine's state off the gated live claims. So
 * `buildExperienceConfidence` is an assembler over two existing engines, not a
 * third scorer.
 *
 * The properties pinned here are the ones that would let it drift into being a
 * vanity number:
 *
 *   1. NO PERSPECTIVES ⇒ NO CONFIDENCE. An experience nobody photographed
 *      scores 0 in the 'unverified' band — never a mid default.
 *   2. POPULARITY IS NOT EVIDENCE. Eight photographs from ONE account do not
 *      out-score two photographs from two accounts: independence is counted in
 *      SOURCES, inherited from §18's clustering.
 *   3. STALE PERSPECTIVES DO NOT CORROBORATE THE PRESENT. The same
 *      `FRESH_WINDOW_MS` the rest of the media tree uses bounds presence,
 *      freshness and agreement.
 *   4. A MATERIAL CONTRADICTION LOWERS IT. The conflict state already riding on
 *      the gated live claims is a PENALTY, in the direction §18 requires.
 *   5. THE TWO COMPONENTS MEDIA CANNOT SUPPLY ARE NAMED, NOT SILENTLY ZERO.
 *      `sourceReliability` and `evidenceQuality` need asset provenance, which
 *      census-media family F5 records as dark: `media_assets` is not read on any
 *      projection path. A zero that nobody can see is how a structural absence
 *      turns into an apparently-measured low score.
 *   6. IT IS REPLAYABLE. The components come back with the number, per
 *      `lib/confidenceScore`'s "a score you cannot reconstruct is a number
 *      nobody can audit".
 *
 * Pure inputs only — no DB, no network.
 *
 * Run:
 *   node --import tsx/esm --test src/test/mediaExperienceConfidence.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildExperienceConfidence,
  EXPERIENCE_CONFIDENCE_ABSENT_COMPONENTS,
} from "../services/media/MediaExperienceResolver.js";
import type { MediaProjection } from "../lib/media/mediaProjection.js";
import type { LiveClaimEnvelope } from "../lib/liveClaimRead.js";

const NOW = Date.parse("2026-09-15T12:00:00.000Z");
const MIN = 60_000;

function media(o: {
  id: string;
  contributorId: string;
  ageMs?: number;
  placeId?: string | null;
}): MediaProjection {
  return {
    id: o.id,
    mediaType: "image",
    url: `https://cdn.example/${o.id}.jpg`,
    thumbnailUrl: null,
    width: 1080,
    height: 1080,
    durationSeconds: null,
    capturedAt: new Date(NOW - (o.ageMs ?? 5 * MIN)).toISOString(),
    placeId: o.placeId === undefined ? "place-1" : o.placeId,
    placeLabel: "An Thuong Bar",
    neighborhood: "An Thuong",
    city: "Da Nang",
    country: "Vietnam",
    category: "nightlife",
    freshness: "fresh",
    contributor: {
      id: o.contributorId,
      username: o.contributorId,
      name: o.contributorId,
      avatarUrl: null,
      verified: false,
      isOfficial: false,
    },
  } as MediaProjection;
}

/** A gated live claim carrying a conflict state, as `readLiveClaimEnvelopes` returns one. */
function claim(conflictState: string): LiveClaimEnvelope {
  return {
    claimType: "crowd_level",
    value: "busy",
    conflictState,
    observedAt: new Date(NOW - 2 * MIN).toISOString(),
  } as unknown as LiveClaimEnvelope;
}

describe("MD169 — §23 experience-level confidence", () => {
  it("an experience with NO perspectives scores 0 in the unverified band", () => {
    const c = buildExperienceConfidence([], [], NOW);
    assert.equal(c.score, 0);
    assert.equal(c.band, "unverified");
    assert.equal(c.independentSourceCount, 0);
    assert.equal(c.freshPerspectiveCount, 0);
  });

  it("EIGHT photographs from one account do not out-score TWO from two accounts", () => {
    const oneLoudAccount = buildExperienceConfidence(
      Array.from({ length: 8 }, (_, i) => media({ id: `a${i}`, contributorId: "amy" })),
      [],
      NOW,
    );
    const twoWitnesses = buildExperienceConfidence(
      [media({ id: "b1", contributorId: "amy" }), media({ id: "b2", contributorId: "ben" })],
      [],
      NOW,
    );
    assert.equal(oneLoudAccount.independentSourceCount, 1);
    assert.equal(twoWitnesses.independentSourceCount, 2);
    assert.ok(
      twoWitnesses.score > oneLoudAccount.score,
      `two independent witnesses (${twoWitnesses.score}) must beat one loud account ` +
        `(${oneLoudAccount.score}) — volume is not evidence`,
    );
  });

  it("ONE source is not independent of itself — `independence` is 0, not a small credit", () => {
    // Mutation MD169-M8 (`sources / SATURATION` instead of `(sources - 1) /
    // (SATURATION - 1)`) survived the test above, because two witnesses still
    // beat one either way. What that mutation actually changes is the FLOOR: it
    // hands a lone account a positive independence term. This is the case that
    // pins it.
    const alone = buildExperienceConfidence(
      [media({ id: "i1", contributorId: "amy" }), media({ id: "i2", contributorId: "amy" })],
      [],
      NOW,
    );
    assert.equal(alone.independentSourceCount, 1);
    assert.equal(alone.components.independence, 0, "a single witness corroborates nobody");
    const pair = buildExperienceConfidence(
      [media({ id: "i3", contributorId: "amy" }), media({ id: "i4", contributorId: "ben" })],
      [],
      NOW,
    );
    assert.ok(pair.components.independence > 0);
  });

  it("STALE perspectives corroborate nothing about the present", () => {
    const stale = buildExperienceConfidence(
      [
        media({ id: "s1", contributorId: "amy", ageMs: 72 * 60 * MIN }),
        media({ id: "s2", contributorId: "ben", ageMs: 80 * 60 * MIN }),
      ],
      [],
      NOW,
    );
    assert.equal(stale.freshPerspectiveCount, 0);
    assert.equal(stale.independentSourceCount, 0);
    assert.equal(stale.score, 0, "an experience last seen three days ago is not evidenced NOW");
  });

  it("a MATERIAL contradiction lowers the score; agreement does not", () => {
    const perspectives = [
      media({ id: "c1", contributorId: "amy" }),
      media({ id: "c2", contributorId: "ben" }),
    ];
    const clean = buildExperienceConfidence(perspectives, [], NOW);
    const disputed = buildExperienceConfidence(perspectives, [claim("material")], NOW);
    const minor = buildExperienceConfidence(perspectives, [claim("minor")], NOW);
    assert.ok(
      disputed.score < clean.score,
      `a material contradiction must lower confidence (${disputed.score} vs ${clean.score})`,
    );
    assert.equal(disputed.penalties.materialConflict > 0, true);
    assert.equal(
      minor.penalties.materialConflict,
      0,
      "a sub-threshold disagreement is not a material conflict — §18 uses one threshold",
    );
  });

  it("NAMES the components media structurally cannot supply", () => {
    const c = buildExperienceConfidence(
      [media({ id: "d1", contributorId: "amy" })],
      [],
      NOW,
    );
    assert.deepEqual(
      [...c.absentComponents].sort(),
      ["evidenceQuality", "sourceReliability"],
      "a structural absence must be visible, not an apparently-measured zero",
    );
    assert.equal(c.components.sourceReliability, 0);
    assert.equal(c.components.evidenceQuality, 0);
    assert.deepEqual(
      [...EXPERIENCE_CONFIDENCE_ABSENT_COMPONENTS].sort(),
      ["evidenceQuality", "sourceReliability"],
    );
  });

  it("is REPLAYABLE — the components come back with the number", () => {
    const c = buildExperienceConfidence(
      [media({ id: "e1", contributorId: "amy" }), media({ id: "e2", contributorId: "ben" })],
      [],
      NOW,
    );
    assert.equal(typeof c.components.presence, "number");
    assert.equal(typeof c.components.independence, "number");
    assert.equal(typeof c.components.freshness, "number");
    assert.equal(typeof c.components.agreement, "number");
    assert.equal(typeof c.components.specificity, "number");
    assert.equal(c.formulaVersion, 1);
    // …and the number is the formula applied to those components.
    assert.ok(c.score > 0 && c.score <= 1);
  });

  it("an experience whose places were WITHHELD scores no specificity", () => {
    // The location/gem choke point nulls `placeId` when the viewer may not be
    // told where this is. An unnameable place is not a specific observation.
    const anonymous = buildExperienceConfidence(
      [
        media({ id: "f1", contributorId: "amy", placeId: null }),
        media({ id: "f2", contributorId: "ben", placeId: null }),
      ],
      [],
      NOW,
    );
    const named = buildExperienceConfidence(
      [media({ id: "g1", contributorId: "amy" }), media({ id: "g2", contributorId: "ben" })],
      [],
      NOW,
    );
    assert.equal(anonymous.components.specificity, 0);
    assert.ok(named.components.specificity > 0);
    assert.ok(named.score > anonymous.score);
  });
});
