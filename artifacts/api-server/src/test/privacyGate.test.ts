/**
 * privacyGate — the suppression contract.
 *
 * The property under test is that publication requires ALL clauses to pass and
 * that every ambiguous input suppresses. A gate that publishes on a missing
 * count is worse than no gate, because it looks like protection.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluatePrivacy, mayPublishAggregate, UNROUTED_PUBLISHERS } from "../lib/privacyGate.js";
import { PRIVACY_THRESHOLD_V1 } from "../lib/intelContracts.js";

const T = PRIVACY_THRESHOLD_V1;
const OLD = Date.parse("2026-08-22T12:00:00.000Z");
const NOW = OLD + 20 * 60_000; // 20 min later — past the 10-min delay

/** A shape that satisfies every clause. */
const ok = {
  distinctActors: T.minUniqueActors,
  distinctGroups: T.minIndependentGroups,
  maxGroupShare: T.maxSingleGroupShare,
  observedAt: OLD,
  now: NOW,
};

describe("privacyGate — publishes only when every clause passes", () => {
  it("publishes at exactly the thresholds", () => {
    assert.deepEqual(evaluatePrivacy(ok), { publishable: true, reason: null });
  });

  it("suppresses one actor below the actor threshold", () => {
    const d = evaluatePrivacy({ ...ok, distinctActors: T.minUniqueActors - 1 });
    assert.equal(d.publishable, false);
    assert.equal(d.reason, "below_actor_threshold");
  });

  it("suppresses the k=1 case that is live today", () => {
    // The CompassGraphEngine shape: 3 events from ONE person.
    const d = evaluatePrivacy({ ...ok, distinctActors: 1 });
    assert.equal(d.publishable, false);
    assert.equal(d.reason, "below_actor_threshold");
  });

  it("suppresses too few independent groups", () => {
    assert.equal(evaluatePrivacy({ ...ok, distinctGroups: T.minIndependentGroups - 1 }).reason,
      "below_group_threshold");
  });

  it("suppresses when one group dominates", () => {
    assert.equal(evaluatePrivacy({ ...ok, maxGroupShare: T.maxSingleGroupShare + 0.01 }).reason,
      "single_group_dominates");
  });

  it("suppresses before the publication delay elapses", () => {
    assert.equal(evaluatePrivacy({ ...ok, now: OLD + 60_000 }).reason, "publication_delay_not_elapsed");
  });

  it("suppresses a sensitive subject regardless of cohort size", () => {
    const d = evaluatePrivacy({ ...ok, distinctActors: 10_000, sensitiveSubject: true });
    assert.equal(d.publishable, false);
    assert.equal(d.reason, "sensitive_subject");
  });
});

describe("privacyGate — fail-closed on ambiguity", () => {
  it("refuses a missing distinct-actor count rather than assuming one", () => {
    assert.equal(evaluatePrivacy({ ...ok, distinctActors: undefined as never }).reason, "invalid_input");
  });

  it("refuses when a group threshold is set but no group count is supplied", () => {
    const { distinctGroups, ...noGroups } = ok;
    assert.equal(evaluatePrivacy(noGroups as never).reason, "invalid_input");
  });

  it("refuses non-finite and negative counts", () => {
    for (const v of [NaN, Infinity, -1]) {
      assert.equal(evaluatePrivacy({ ...ok, distinctActors: v }).publishable, false);
    }
  });

  it("refuses an unusable threshold", () => {
    assert.equal(evaluatePrivacy(ok, { ...T, minUniqueActors: 0 }).reason, "invalid_input");
  });

  it("mayPublishAggregate agrees with evaluatePrivacy", () => {
    assert.equal(mayPublishAggregate(ok), true);
    assert.equal(mayPublishAggregate({ ...ok, distinctActors: 2 }), false);
  });
});

describe("privacyGate — the remaining gap is recorded, not implied", () => {
  it("names the publisher that cannot yet be routed through the gate", () => {
    assert.ok(UNROUTED_PUBLISHERS.length > 0);
    assert.match(UNROUTED_PUBLISHERS[0], /CompassGraphEngine/);
    assert.match(UNROUTED_PUBLISHERS[0], /distinct-actor/);
  });
});
