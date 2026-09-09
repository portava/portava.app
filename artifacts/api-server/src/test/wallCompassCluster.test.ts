/**
 * §21 — "Interpret a cluster of social signals ONLY WHEN EVIDENCE AND PRIVACY
 * RULES ALLOW", and "never present inference as verified fact".
 *
 * WHAT WAS MISSING. The §9 gate existed and the Compass thread ran through it,
 * but there was no CLUSTER interpretation at all: the compass thread was a
 * per-object prompt about one place ("Ask Compass about X"). The affordance was
 * safe — a question asserts nothing — but the behaviour the spec names was
 * absent.
 *
 * THE TWO CONDITIONS ARE ENFORCED LITERALLY.
 *   EVIDENCE — a member must pass `shouldAttachContextThread` ON ITS OWN, and
 *              two or more members must come from DISTINCT signal kinds, so one
 *              system talking twice is not a cluster and a below-floor fact
 *              contributes nothing.
 *   PRIVACY  — a member the viewer is not authorized for, or one carrying a
 *              sensitive disclosure, is excluded BEFORE it is counted. It cannot
 *              be laundered into the aggregate by the presence of other signals.
 *
 * And the result never asserts the interpretation: the label lists the KINDS of
 * signal present and offers to ask, the truth class is `inferred`, and the
 * confidence is the weakest member's.
 *
 * MUTATION PROOF (each verified: revert → RED, restore → GREEN)
 *   • drop the `sensitiveDisclosure` term from the member filter AND neutralise
 *     it inside the `passesOnItsOwn` gate → the protected-gem privacy test RED.
 *   • the same for `viewerAuthorized` → the unauthorized-member test RED.
 *     (Removing only the explicit exclusion leaves the §9 gate holding — the two
 *     privacy checks are deliberately redundant, and the test bites when BOTH
 *     are gone, which is the failure the redundancy exists to prevent.)
 *   • drop the `passesOnItsOwn` gate → the below-floor-evidence test RED.
 *   • key the member map by candidate instead of by kind → the
 *     one-system-twice test RED.
 *   • raise the cluster's expectedUtility above the live_place fact's 0.85 →
 *     the "never outranks the observation" test RED.
 *   • change `truthClass` to "observed" → the not-a-fact test RED.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCompassClusterCandidate,
  selectContextThread,
  shouldAttachContextThread,
  CLUSTER_MIN_SIGNALS,
  DEFAULT_CONTEXT_THREAD_POLICY,
  type ContextThreadCandidate,
  type ContextThreadGateInput,
} from "../services/wall/ContextThreadService.js";
import type { ContextThreadKind } from "../lib/wallProjection.js";

const PASS: ContextThreadGateInput = {
  viewerAuthorized: true,
  contextRelevant: true,
  confidence: 0.8,
  freshnessAgeMs: 60_000,
  sensitiveDisclosure: false,
  duplicatesLiveStrip: false,
  visualOverload: false,
  expectedUtility: 0.7,
};

function signal(
  kind: ContextThreadKind,
  gateOver: Partial<ContextThreadGateInput> = {},
): ContextThreadCandidate {
  return {
    thread: { kind, label: `${kind} label`, confidence: 0.8, truthClass: "observed" },
    gate: { ...PASS, ...gateOver },
  };
}

const BARE_COMPASS: ContextThreadCandidate = {
  thread: {
    kind: "compass",
    label: "Ask Compass about An Thuong",
    freshness: "recent",
    confidence: 0.7,
    reason: "Ask Compass",
    truthClass: "unknown",
    coverage: "unknown",
    action: { type: "ask_compass", label: "Ask Compass", targetType: "place", targetId: "place-1" },
  },
  gate: { ...PASS, confidence: 0.7, freshnessAgeMs: 0, expectedUtility: 0.5 },
};

describe("§21 cluster — it forms only when the evidence is really there", () => {
  it("two distinct, individually-eligible signals make a cluster", () => {
    const cluster = buildCompassClusterCandidate(BARE_COMPASS, [
      signal("live_place"),
      signal("social_presence"),
    ]);
    assert.ok(cluster, "two eligible signals must cluster");
    assert.equal(cluster!.thread.kind, "compass");
    assert.match(cluster!.thread.label, /live activity/);
    assert.match(cluster!.thread.label, /people you follow/);
    assert.equal(cluster!.thread.reason, "2 signals here");
  });

  it("ONE signal is not a cluster", () => {
    assert.equal(CLUSTER_MIN_SIGNALS, 2);
    assert.equal(buildCompassClusterCandidate(BARE_COMPASS, [signal("live_place")]), null);
  });

  it("no signals at all is not a cluster", () => {
    assert.equal(buildCompassClusterCandidate(BARE_COMPASS, []), null);
  });

  it("the SAME system twice is not a cluster — distinct kinds are required", () => {
    assert.equal(
      buildCompassClusterCandidate(BARE_COMPASS, [signal("live_place"), signal("live_place")]),
      null,
    );
  });

  it("navigation affordances are not social signals", () => {
    // map + memory are links and a private record, not claims about the world.
    assert.equal(
      buildCompassClusterCandidate(BARE_COMPASS, [signal("map"), signal("memory")]),
      null,
    );
  });

  it("no bare compass candidate ⇒ no cluster (the flag still governs)", () => {
    assert.equal(
      buildCompassClusterCandidate(null, [signal("live_place"), signal("social_presence")]),
      null,
    );
  });

  // ── EVIDENCE ──────────────────────────────────────────────────────────────
  it("a member below the confidence floor contributes nothing", () => {
    const weak = signal("social_presence", {
      confidence: DEFAULT_CONTEXT_THREAD_POLICY.minConfidence - 0.01,
    });
    assert.equal(shouldAttachContextThread(weak.gate), false, "control: it would not stand alone");
    assert.equal(buildCompassClusterCandidate(BARE_COMPASS, [signal("live_place"), weak]), null);
  });

  it("a member past the freshness horizon contributes nothing", () => {
    const stale = signal("social_presence", {
      freshnessAgeMs: DEFAULT_CONTEXT_THREAD_POLICY.maxAgeMs + 1,
    });
    assert.equal(buildCompassClusterCandidate(BARE_COMPASS, [signal("live_place"), stale]), null);
  });

  it("a member that is present but not contextually relevant contributes nothing", () => {
    const irrelevant = signal("social_presence", { contextRelevant: false });
    assert.equal(
      buildCompassClusterCandidate(BARE_COMPASS, [signal("live_place"), irrelevant]),
      null,
    );
  });

  it("but a fact suppressed only for PRESENTATION reasons still counts as evidence", () => {
    // Already on the live strip / the window is visually full: the fact is still
    // true, and an interpretation over it is still grounded.
    const onStrip = signal("live_place", { duplicatesLiveStrip: true });
    const crowded = signal("social_presence", { visualOverload: true });
    assert.ok(buildCompassClusterCandidate(BARE_COMPASS, [onStrip, crowded]));
  });

  // ── PRIVACY ───────────────────────────────────────────────────────────────
  it("a SENSITIVE member is excluded, not aggregated (a protected Gem)", () => {
    const protectedGem = signal("hidden_gem", { sensitiveDisclosure: true });
    // With only the gem + one other, excluding the gem drops below the floor.
    assert.equal(
      buildCompassClusterCandidate(BARE_COMPASS, [signal("live_place"), protectedGem]),
      null,
    );
  });

  it("an UNAUTHORIZED member is excluded", () => {
    const unauthorized = signal("social_presence", { viewerAuthorized: false });
    assert.equal(
      buildCompassClusterCandidate(BARE_COMPASS, [signal("live_place"), unauthorized]),
      null,
    );
  });

  it("a sensitive member cannot ride along inside an otherwise valid cluster", () => {
    const cluster = buildCompassClusterCandidate(BARE_COMPASS, [
      signal("live_place"),
      signal("social_presence"),
      signal("hidden_gem", { sensitiveDisclosure: true }),
    ]);
    assert.ok(cluster);
    assert.equal(cluster!.thread.reason, "2 signals here", "the gem must not be counted");
    assert.equal(/Hidden Gem/i.test(cluster!.thread.label), false, "and must not be named");
  });

  it("the label discloses only the KIND of each signal, never its content", () => {
    const cluster = buildCompassClusterCandidate(BARE_COMPASS, [
      { ...signal("social_presence"), thread: { kind: "social_presence", label: "3 people you follow were here recently" } },
      signal("live_place"),
    ]);
    assert.ok(cluster);
    assert.equal(/3 people/.test(cluster!.thread.label), false, "no counts leak into the cluster");
  });
});

describe("§21 cluster — it interprets, and says so", () => {
  it("is `inferred`, never an observation", () => {
    const cluster = buildCompassClusterCandidate(BARE_COMPASS, [
      signal("live_place"),
      signal("social_presence"),
    ])!;
    assert.equal(cluster.thread.truthClass, "inferred");
  });

  it("offers to ask rather than asserting a conclusion", () => {
    const cluster = buildCompassClusterCandidate(BARE_COMPASS, [
      signal("live_place"),
      signal("social_presence"),
    ])!;
    assert.match(cluster.thread.label, /ask Compass/i);
    assert.equal(cluster.thread.action?.type, "ask_compass");
  });

  it("is bounded by its WEAKEST member's confidence and freshness", () => {
    const cluster = buildCompassClusterCandidate(BARE_COMPASS, [
      signal("live_place", { confidence: 0.9, freshnessAgeMs: 1_000 }),
      signal("social_presence", { confidence: 0.6, freshnessAgeMs: 500_000 }),
    ])!;
    assert.equal(cluster.thread.confidence, 0.6);
    assert.equal(cluster.gate.confidence, 0.6);
    assert.equal(cluster.gate.freshnessAgeMs, 500_000);
  });

  it("beats the bare Compass prompt but NEVER the observation it was built from", () => {
    const live = signal("live_place", { expectedUtility: 0.85 });
    const cluster = buildCompassClusterCandidate(BARE_COMPASS, [live, signal("social_presence")])!;
    assert.ok(cluster.gate.expectedUtility > BARE_COMPASS.gate.expectedUtility);
    assert.ok(cluster.gate.expectedUtility < live.gate.expectedUtility);
    // And selection agrees: the concrete live fact still wins the single slot.
    const chosen = selectContextThread([live, cluster]);
    assert.equal(chosen?.kind, "live_place");
  });

  it("wins the slot when the concrete facts are only presentation-suppressed", () => {
    const onStrip = signal("live_place", { expectedUtility: 0.85, duplicatesLiveStrip: true });
    const crowdedOut = signal("social_presence", { expectedUtility: 0.8, duplicatesLiveStrip: true });
    const cluster = buildCompassClusterCandidate(BARE_COMPASS, [onStrip, crowdedOut])!;
    const chosen = selectContextThread([onStrip, crowdedOut, cluster]);
    assert.equal(chosen?.kind, "compass");
    assert.equal(chosen?.truthClass, "inferred");
  });
});
