/**
 * Independence clustering (IG unit I2, spec §11 / Table 30 / AT-04) — the pure
 * detector that collapses coordinated reports into one cluster so they cannot
 * count as independent corroboration. Each signal (shared media, common source,
 * synchronized behaviour) must COLLAPSE the count; an honest independent pair
 * must NOT.
 *
 * The clustering runs over INDEPENDENCE UNITS (a group_key, or a solo actor), so
 * distinctGroups still counts group_key units and a null group_key earns zero
 * group credit — the detectors only ever merge units on top of that.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clusterByIndependence,
  SYNC_WINDOW_SECONDS,
  type IndependenceObservation,
} from "../lib/intelIndependence.js";

const T = (minutesAgo: number) => Date.now() - minutesAgo * 60_000;

/** One observation; each actor defaults to its own verified group_key. */
function ob(p: Partial<IndependenceObservation> & { actorId: string }): IndependenceObservation {
  return {
    groupKey: `g-${p.actorId}`,
    valueKey: '{"level":"busy"}',
    observedAtMs: T(5),
    mediaRefs: [],
    sourceRefs: [],
    ...p,
  };
}
/** Cluster id for an actor whose group_key follows the default `g-<actor>` shape. */
const cl = (r: ReturnType<typeof clusterByIndependence>, actor: string, groupKey = `g-${actor}`) =>
  r.clusterForUnit(groupKey, actor);

describe("intelIndependence — clusterByIndependence", () => {
  it("honest independent pair (distinct groups, no shared artifacts, not synchronized) does NOT collapse", () => {
    const r = clusterByIndependence([
      ob({ actorId: "a", valueKey: '{"level":"quiet"}', observedAtMs: T(20) }),
      ob({ actorId: "b", valueKey: '{"level":"packed"}', observedAtMs: T(5) }),
    ]);
    assert.equal(r.clusterCount, 2);
    assert.equal(r.distinctGroups, 2);
    assert.equal(r.maxGroupShare, 0.5);
    assert.notEqual(cl(r, "a"), cl(r, "b"));
  });

  it("SHARED EVIDENCE MEDIA collapses distinct units — even across different group_keys (AT-04)", () => {
    const r = clusterByIndependence([
      ob({ actorId: "a", mediaRefs: ["hash-XYZ"] }),
      ob({ actorId: "b", mediaRefs: ["hash-XYZ"] }),
      ob({ actorId: "c", mediaRefs: ["hash-XYZ"] }),
    ]);
    assert.equal(r.clusterCount, 1);
    assert.equal(r.distinctGroups, 1, "three copies are one independence cluster");
    assert.equal(r.maxGroupShare, 1);
    assert.equal(cl(r, "a"), cl(r, "c"));
  });

  it("distinct media assets do NOT collapse honest reporters", () => {
    const r = clusterByIndependence([
      ob({ actorId: "a", mediaRefs: ["hash-1"], valueKey: '{"level":"quiet"}', observedAtMs: T(20) }),
      ob({ actorId: "b", mediaRefs: ["hash-2"], valueKey: '{"level":"packed"}', observedAtMs: T(5) }),
    ]);
    assert.equal(r.distinctGroups, 2);
  });

  it("COMMON SOURCE (same official feed) collapses the echoing units", () => {
    const r = clusterByIndependence([
      ob({ actorId: "a", sourceRefs: ["feed:citygov"], valueKey: '{"level":"quiet"}', observedAtMs: T(30) }),
      ob({ actorId: "b", sourceRefs: ["feed:citygov"], valueKey: '{"level":"busy"}', observedAtMs: T(20) }),
      ob({ actorId: "c", sourceRefs: ["feed:other"], valueKey: '{"level":"packed"}', observedAtMs: T(5) }),
    ]);
    assert.equal(r.distinctGroups, 2);
    assert.equal(cl(r, "a"), cl(r, "b"));
    assert.notEqual(cl(r, "a"), cl(r, "c"));
  });

  it("UNUSUALLY SYNCHRONIZED behaviour (identical value, within the tight window) collapses", () => {
    const base = T(5);
    const r = clusterByIndependence([
      ob({ actorId: "a", valueKey: '{"level":"packed"}', observedAtMs: base }),
      ob({ actorId: "b", valueKey: '{"level":"packed"}', observedAtMs: base + 10_000 }),
    ]);
    assert.equal(r.distinctGroups, 1);
    assert.equal(cl(r, "a"), cl(r, "b"));
  });

  it("the same two actors reporting the same value MINUTES apart are NOT synchronized", () => {
    const base = T(30);
    const r = clusterByIndependence([
      ob({ actorId: "a", valueKey: '{"level":"packed"}', observedAtMs: base }),
      ob({ actorId: "b", valueKey: '{"level":"packed"}', observedAtMs: base + (SYNC_WINDOW_SECONDS + 60) * 1000 }),
    ]);
    assert.equal(r.distinctGroups, 2);
    assert.notEqual(cl(r, "a"), cl(r, "b"));
  });

  it("synchronized detection is per-VALUE: near-simultaneous DIFFERENT values stay distinct", () => {
    const base = T(5);
    const r = clusterByIndependence([
      ob({ actorId: "a", valueKey: '{"level":"quiet"}', observedAtMs: base }),
      ob({ actorId: "b", valueKey: '{"level":"packed"}', observedAtMs: base + 5_000 }),
    ]);
    assert.equal(r.distinctGroups, 2);
  });

  it("an unattested solo unit (null group_key) is a cluster but NOT a verified group", () => {
    const r = clusterByIndependence([
      ob({ actorId: "a", groupKey: null, valueKey: '{"level":"quiet"}', observedAtMs: T(20) }),
      ob({ actorId: "b", groupKey: null, valueKey: '{"level":"packed"}', observedAtMs: T(5) }),
    ]);
    assert.equal(r.clusterCount, 2);
    assert.equal(r.distinctGroups, 0, "no group_key ⇒ no verified independent group");
    assert.equal(r.maxGroupShare, 0);
    assert.equal(r.attestedForUnit(null, "a"), false);
  });

  it("a merged attested+unattested cluster counts as ONE verified group", () => {
    const r = clusterByIndependence([
      ob({ actorId: "a", mediaRefs: ["h"] }),
      ob({ actorId: "b", groupKey: null, mediaRefs: ["h"] }), // solo unit pulled in by shared media
    ]);
    assert.equal(r.clusterCount, 1);
    assert.equal(r.distinctGroups, 1);
    assert.equal(r.attestedForUnit(null, "b"), true, "membership in an attested cluster is attested");
  });

  it("overlapping crews that share members are NOT merged by shared actors (share stays 1.0)", () => {
    // 3 actors each in 3 crews → 3 group_key units, each holding all 3 actors. No
    // detector fires, so the units stay distinct (matching the prior aggregator),
    // and the actor-based share over the distinct-actor union is 1.0.
    const obs: IndependenceObservation[] = [];
    for (const a of ["a0", "a1", "a2"]) for (const g of ["g0", "g1", "g2"]) {
      obs.push({ actorId: a, groupKey: g, valueKey: '{"level":"busy"}', observedAtMs: Number.NaN, mediaRefs: [], sourceRefs: [] });
    }
    const r = clusterByIndependence(obs);
    assert.equal(r.distinctGroups, 3);
    assert.equal(r.maxGroupShare, 1);
  });

  it("is deterministic and order-independent", () => {
    const obs = [
      ob({ actorId: "c", mediaRefs: ["h"], valueKey: '{"level":"quiet"}', observedAtMs: T(30) }),
      ob({ actorId: "a", mediaRefs: ["h"], valueKey: '{"level":"busy"}', observedAtMs: T(20) }),
      ob({ actorId: "b", valueKey: '{"level":"packed"}', observedAtMs: T(5) }),
    ];
    const r1 = clusterByIndependence(obs);
    const r2 = clusterByIndependence([...obs].reverse());
    assert.equal(cl(r1, "a"), cl(r2, "a"));
    assert.equal(cl(r1, "c"), cl(r2, "c"));
    assert.equal(r1.distinctGroups, r2.distinctGroups);
  });

  it("empty input is well-defined (no groups, no clusters)", () => {
    const r = clusterByIndependence([]);
    assert.equal(r.clusterCount, 0);
    assert.equal(r.distinctGroups, 0);
    assert.equal(r.maxGroupShare, 0);
  });
});
