/**
 * DSV2-04 server leg — `whyNowValidForMs` on the served DiscoveryCandidate.
 *
 * `02-DISCOVERY-v2.md` DSV2-04 asks that an expired why-now claim "disappear or
 * become explicitly stale" on the client. The client (census-discovery §50)
 * expires a claim at receipt time + `whyNowValidForMs`; this suite pins what
 * the server sends: the duration from THIS serve (`ctx.nowMs`) until the
 * grade's own horizon (`interception.horizonAt`), 0 once that horizon has
 * passed, and null whenever there is no claim or no finite horizon — so the
 * client never shows an un-expirable claim as current.
 *
 * Run: node --import tsx/esm --test src/test/discoveryCandidateWhyNowValidity.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  projectDiscoveryCandidate,
  whyNowValidForMsOf,
  type CandidateServeContext,
} from "../lib/discoveryCandidate.js";

// Deliberately far from the wall clock: the duration must come from ctx.nowMs.
const NOW = Date.parse("2030-01-01T12:00:00.000Z");
const ID = "db/whynow-1";

function grade(over: Record<string, unknown> = {}): any {
  return {
    id: ID,
    mode: "right_now",
    evidence: "reading",
    axes: {},
    opportunityValue: 0.5,
    influence: 0.1,
    safety: { unsafe: false, demoted: false },
    truth: null,
    interception: { reachable: true, etaMinutes: 5, arrivalAt: null, horizonAt: new Date(NOW + 90_000).toISOString(), marginMinutes: 1 },
    whyNow: ["crowd_rising"],
    claimRefs: ["env-1"],
    ...over,
  };
}

function ctx(g: any | null, nowMs = NOW): CandidateServeContext {
  return {
    cacheLevel: "L1",
    cachedAt: nowMs - 1_000,
    scoredById: null,
    rankedBy: "none",
    nowMs,
    liveRankById: g ? new Map([[ID, g]]) : null,
  };
}

describe("DSV2-04 — the server sends how long a why-now claim is good for", () => {
  it("W1 the validity is the grade's horizon minus THIS serve's time, and it rides the projected candidate", () => {
    const c = projectDiscoveryCandidate({ id: ID }, ctx(grade()));
    assert.deepEqual(c.whyNow, ["crowd_rising"]);
    assert.equal(c.whyNowValidForMs, 90_000);
    assert.equal(whyNowValidForMsOf(ID, ctx(grade()), NOW), 90_000);
  });

  it("W2 no grade: no claim, so nothing to expire — both null", () => {
    const c = projectDiscoveryCandidate({ id: ID }, ctx(null));
    assert.equal(c.whyNow, null);
    assert.equal(c.whyNowValidForMs, null);
  });

  it("W3 a grade that observed nothing carries no claim, even with a horizon — both null", () => {
    for (const evidence of ["none", "unreadable"]) {
      const c = projectDiscoveryCandidate({ id: ID }, ctx(grade({ evidence })));
      assert.equal(c.whyNow, null, evidence);
      assert.equal(c.whyNowValidForMs, null, evidence);
    }
    const empty = projectDiscoveryCandidate({ id: ID }, ctx(grade({ whyNow: [] })));
    assert.equal(empty.whyNow, null);
    assert.equal(empty.whyNowValidForMs, null);
  });

  it("W4 a horizon already behind the serve is 0, never negative", () => {
    const g = grade({ interception: { ...grade().interception, horizonAt: new Date(NOW - 5_000).toISOString() } });
    assert.equal(projectDiscoveryCandidate({ id: ID }, ctx(g)).whyNowValidForMs, 0);
  });

  it("W5 a claim with no finite horizon is sent with validity null (the client then does not show it as current)", () => {
    for (const horizonAt of [null, "not-a-date"]) {
      const g = grade({ interception: { ...grade().interception, horizonAt } });
      const c = projectDiscoveryCandidate({ id: ID }, ctx(g));
      assert.deepEqual(c.whyNow, ["crowd_rising"], String(horizonAt));
      assert.equal(c.whyNowValidForMs, null, String(horizonAt));
    }
  });

  it("W6 the same grade served later is valid for less — the duration is anchored to each serve", () => {
    const g = grade();
    assert.equal(projectDiscoveryCandidate({ id: ID }, ctx(g, NOW + 30_000)).whyNowValidForMs, 60_000);
    assert.equal(projectDiscoveryCandidate({ id: ID }, ctx(g, NOW + 90_000)).whyNowValidForMs, 0);
  });
});
