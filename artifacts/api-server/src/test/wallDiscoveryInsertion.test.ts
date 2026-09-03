/**
 * WallDiscoveryInsertionService — social-explained discovery for For You (§13).
 *
 * Proves discovery insertions are ALWAYS explained (never a naked directory
 * listing), that the explanation ladder is relationship/relevance-first, and —
 * critically — that creator popularity is the reason of LAST resort so it never
 * dominates contributor reliability or real-world relevance (spec §13).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  explainDiscovery,
  type DiscoveryCandidateSignals,
  type DiscoveryViewerSignals,
} from "../services/wall/WallDiscoveryInsertionService.js";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const RECENT = "2026-08-28T00:00:00.000Z";
const OLD = "2026-01-01T00:00:00.000Z";

function viewer(over: Partial<DiscoveryViewerSignals> = {}): DiscoveryViewerSignals {
  return { now: NOW, ...over };
}

function cand(over: Partial<DiscoveryCandidateSignals> = {}): DiscoveryCandidateSignals {
  return { authorId: "author-x", createdAt: RECENT, ...over };
}

describe("explainDiscovery — every insertion is socially explained (§13)", () => {
  it("followed_by wins first (second-degree social proof)", () => {
    const ex = explainDiscovery(
      cand({ authorId: "a2", placeCity: "Bangkok", likeCount: 100 }),
      viewer({ mutualFollowedAuthorIds: new Set(["a2"]), tripCities: new Set(["bangkok"]) }),
    );
    assert.equal(ex?.key, "followed_by");
    assert.match(ex!.reason, /Followed by people you follow/);
  });

  it("trip relevance (real-world, forward-looking)", () => {
    const ex = explainDiscovery(
      cand({ placeCity: "Bangkok" }),
      viewer({ tripCities: new Set(["bangkok"]) }),
    );
    assert.equal(ex?.key, "trip_relevance");
    assert.match(ex!.reason, /heading to Bangkok/);
  });

  it("destination fit (current / preferred city)", () => {
    const ex = explainDiscovery(cand({ placeCity: "Da Nang" }), viewer({ currentCity: "Da Nang" }));
    assert.equal(ex?.key, "destination");
  });

  it("interest fit (category matches viewer interest)", () => {
    const ex = explainDiscovery(
      cand({ placeCity: "Somewhere", category: "food" }),
      viewer({ interests: new Set(["food"]) }),
    );
    assert.equal(ex?.key, "interest");
    assert.match(ex!.reason, /food/);
  });

  it("permitted hidden gem", () => {
    const ex = explainDiscovery(cand({ isPermittedHiddenGem: true }), viewer());
    assert.equal(ex?.key, "hidden_gem");
  });
});

describe("explainDiscovery — popularity is the reason of LAST resort", () => {
  it("a popular AND recent post with no social/real-world tie ⇒ missed", () => {
    const ex = explainDiscovery(
      cand({ likeCount: 20, saveCount: 5, commentCount: 3, createdAt: RECENT }),
      viewer(),
    );
    assert.equal(ex?.key, "missed");
  });

  it("popularity NEVER overrides a real-world reason (trip beats missed)", () => {
    const ex = explainDiscovery(
      cand({ placeCity: "Bangkok", likeCount: 9999, saveCount: 9999, commentCount: 9999, createdAt: RECENT }),
      viewer({ tripCities: new Set(["bangkok"]) }),
    );
    assert.equal(ex?.key, "trip_relevance", "a wildly popular post is still explained by the trip tie, not popularity");
  });

  it("popular but STALE ⇒ not 'missed' ⇒ dropped (popularity alone never earns insertion)", () => {
    const ex = explainDiscovery(
      cand({ likeCount: 500, saveCount: 500, commentCount: 500, createdAt: OLD }),
      viewer(),
    );
    assert.equal(ex, null);
  });

  it("low-engagement recent post with no tie ⇒ dropped", () => {
    const ex = explainDiscovery(cand({ likeCount: 1, createdAt: RECENT }), viewer());
    assert.equal(ex, null);
  });
});

describe("explainDiscovery — never a naked directory listing (§13)", () => {
  it("an unexplained outside-graph candidate returns null (caller drops it)", () => {
    const ex = explainDiscovery(cand({ placeCity: "Elsewhere", category: "misc" }), viewer());
    assert.equal(ex, null);
  });
});
