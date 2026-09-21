/**
 * Sensing §8 — the live ranking engine (lib/discoveryLiveRank), exercised
 * directly. No mock stands in for the engine: every assertion runs the real
 * `gradeLiveRow` / `rankDiscoveryLive` over real `LiveClaimEnvelope` shapes and
 * the real §5.1 derivation the Wall and Compass use.
 *
 * The five refusals the module's header names are the load-bearing cases, and
 * each was watched red under its own deliberate mutation before being left
 * green (the mutations are listed in census-sensing §7.3):
 *   safety demotes and never promotes · absence is not quiet · "could not look"
 *   is not "saw nothing" · busy is not good without a declared intent ·
 *   a sponsored or merely-emerging claim is not a current reading.
 *
 * Run: node --import tsx/esm --test src/test/discoveryLiveRank.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { LiveClaimEnvelope } from "../lib/liveClaimRead.js";
import {
  DISCOVERY_INTENT_MODES,
  INTENT_MODE_PROFILES,
  LIVE_RANK_MAX_POSITIONS,
  LIVE_RANK_WINDOW,
  etaMinutesOf,
  gradeLiveRow,
  intentForMode,
  opportunityValueOf,
  rankDiscoveryLive,
  whyNowFrom,
  type DiscoveryIntentMode,
  type LiveRankRow,
} from "../lib/discoveryLiveRank.js";

const NOW = Date.parse("2026-09-12T12:00:00.000Z");
const iso = (min: number) => new Date(NOW + min * 60_000).toISOString();

let seq = 0;
function env(over: Partial<LiveClaimEnvelope> = {}): LiveClaimEnvelope {
  seq += 1;
  return {
    id: `env-${seq}`,
    claimType: "crowd.level",
    value: { level: "busy" },
    confidence: 0.9,
    band: "live",
    sourceClass: "firsthand_unverified",
    sourceCountBucket: "several",
    observedAt: iso(-3),
    validUntil: iso(30),
    state: "live",
    conflictState: "none",
    conflict: null,
    ...over,
  } as LiveClaimEnvelope;
}

function row(id: string, envelopes: LiveClaimEnvelope[], over: Partial<LiveRankRow> = {}): LiveRankRow {
  return { id, subjectId: `subj-${id}`, envelopes, readable: true, distanceKm: 0.5, ...over };
}

describe("Sensing §8 — the eight intent modes are the spec's, over one engine", () => {
  it("the vocabulary is §8's eight, in the spec's order", () => {
    assert.deepEqual([...DISCOVERY_INTENT_MODES], [
      "right_now", "tonight", "explore", "quiet", "social", "high_energy", "nearby", "trip",
    ]);
  });

  it("every mode is a weight vector over the SAME axes — no mode has an axis of its own", () => {
    const axes = Object.keys(INTENT_MODE_PROFILES.right_now.weights).sort();
    for (const mode of DISCOVERY_INTENT_MODES) {
      assert.deepEqual(Object.keys(INTENT_MODE_PROFILES[mode].weights).sort(), axes, `${mode} invents an axis`);
    }
  });

  it("only quiet/social/high_energy/explore declare a crowd preference to experienceValue", () => {
    const declaring = DISCOVERY_INTENT_MODES.filter((m) => intentForMode(m) !== null);
    assert.deepEqual([...declaring], ["explore", "quiet", "social", "high_energy"]);
    // And 'explore' is the one that declares an intent with NO crowd table, so
    // experienceValue answers null for it too — five modes, no crowd value.
    assert.equal(intentForMode("explore"), "explore");
  });
});

describe("Sensing §7/§16 — safety outranks opportunity, and only ever downward", () => {
  it("a Live-qualified unsafe_density demotes: value 0, no influence, and behind every other row", () => {
    const unsafe = row("u", [env({ value: { level: "unsafe_density" } })]);
    const good   = row("g", [env({ value: { level: "quiet" } })]);
    const plain  = row("p", []);
    const out = rankDiscoveryLive([unsafe, good, plain], { mode: "quiet", nowMs: NOW });
    assert.deepEqual(out.ranked.map((r) => r.id), ["g", "p", "u"]);
    assert.equal(out.demoted, 1);
    const grade = out.byId.get("u")!;
    assert.equal(grade.safety.unsafe, true);
    assert.equal(grade.safety.demoted, true);
    assert.equal(grade.opportunityValue, 0);
    assert.equal(grade.influence, 0);
    assert.deepEqual(grade.whyNow, ["crowd_unsafe_density"]);
  });

  it("no mode and no weight can promote an unsafe row above a safe one", () => {
    for (const mode of DISCOVERY_INTENT_MODES) {
      const out = rankDiscoveryLive(
        [row("safe", []), row("unsafe", [env({ value: { level: "unsafe_density" } })])],
        { mode, nowMs: NOW },
      );
      assert.deepEqual(out.ranked.map((r) => r.id), ["safe", "unsafe"], `mode ${mode} promoted an unsafe place`);
    }
  });

  it("an unsafe row that was FIRST is still demoted — safety is not a tie-break", () => {
    const out = rankDiscoveryLive(
      [row("unsafe", [env({ value: { level: "unsafe_density" } })]), row("a", []), row("b", [])],
      { mode: "social", nowMs: NOW },
    );
    assert.equal(out.ranked[out.ranked.length - 1]!.id, "unsafe");
  });
});

describe("Sensing §2/§20 — absence, and the difference between two kinds of it", () => {
  it("a place with NO live evidence is not scored and does not move", () => {
    const rows = [row("a", []), row("b", []), row("c", [])];
    const out = rankDiscoveryLive(rows, { mode: "social", nowMs: NOW });
    assert.deepEqual(out.ranked.map((r) => r.id), ["a", "b", "c"]);
    for (const id of ["a", "b", "c"]) {
      const g = out.byId.get(id)!;
      assert.equal(g.influence, 0, `${id} moved on absence`);
      assert.equal(g.opportunityValue, null, `${id} was scored on absence`);
      assert.equal(g.evidence, "none");
      assert.deepEqual(g.whyNow, []);
    }
  });

  it("'could not look' (gates closed) is labelled apart from 'looked and saw nothing'", () => {
    const closed = gradeLiveRow(row("x", [], { readable: false }), { mode: "social", nowMs: NOW });
    const empty  = gradeLiveRow(row("y", [], { readable: true }),  { mode: "social", nowMs: NOW });
    assert.equal(closed.evidence, "unreadable");
    assert.equal(empty.evidence, "none");
    assert.notEqual(closed.evidence, empty.evidence);
    assert.equal(closed.influence, 0);
    assert.equal(empty.influence, 0);
  });

  it("a row with no canonical subject can be graded but is never scored from its distance alone", () => {
    const near = gradeLiveRow(row("near", [], { distanceKm: 0.05, readable: false }), { mode: "nearby", nowMs: NOW });
    const far  = gradeLiveRow(row("far",  [], { distanceKm: 40,   readable: false }), { mode: "nearby", nowMs: NOW });
    assert.equal(near.influence, 0);
    assert.equal(far.influence, 0);
    assert.equal(near.opportunityValue, null);
  });
});

describe("Sensing §2 — busy is not good, and only a declared intent makes a crowd mean anything", () => {
  it("under a mode with no crowd preference, how crowded a place is changes NOTHING", () => {
    for (const mode of ["right_now", "tonight", "explore", "nearby", "trip"] as DiscoveryIntentMode[]) {
      const busy  = gradeLiveRow(row("b", [env({ value: { level: "busy" } })]),  { mode, nowMs: NOW });
      const calm  = gradeLiveRow(row("b", [env({ value: { level: "quiet" } })]), { mode, nowMs: NOW });
      const dead  = gradeLiveRow(row("b", [env({ value: { level: "dead" } })]),  { mode, nowMs: NOW });
      assert.equal(busy.axes.compatibility, null, `${mode} valued a crowd level`);
      assert.equal(busy.influence, calm.influence, `${mode} ranked busy above quiet`);
      assert.equal(busy.influence, dead.influence, `${mode} ranked busy above dead`);
    }
  });

  it("and the ORDER of two rows differing only in crowd level is unchanged under those modes", () => {
    const rows = [row("calm", [env({ value: { level: "quiet" } })]), row("busy", [env({ value: { level: "busy" } })])];
    for (const mode of ["right_now", "tonight", "explore", "nearby", "trip"] as DiscoveryIntentMode[]) {
      assert.deepEqual(rankDiscoveryLive(rows, { mode, nowMs: NOW }).ranked.map((r) => r.id), ["calm", "busy"], mode);
    }
  });

  it("the same busy reading raises for 'social' and lowers for 'quiet' — one table, two viewers", () => {
    const social = gradeLiveRow(row("b", [env({ value: { level: "busy" } })]), { mode: "social", nowMs: NOW });
    const quiet  = gradeLiveRow(row("b", [env({ value: { level: "busy" } })]), { mode: "quiet",  nowMs: NOW });
    assert.ok((social.axes.compatibility ?? 0) > (quiet.axes.compatibility ?? 1));
    assert.ok(social.influence > quiet.influence);
  });

  it("a quiet place outranks a packed one for a quiet viewer, and the reverse for high energy", () => {
    const rows = [row("packed", [env({ value: { level: "packed" } })]), row("calm", [env({ value: { level: "quiet" } })])];
    assert.deepEqual(rankDiscoveryLive(rows, { mode: "quiet", nowMs: NOW }).ranked.map((r) => r.id), ["calm", "packed"]);
    assert.deepEqual(rankDiscoveryLive(rows, { mode: "high_energy", nowMs: NOW }).ranked.map((r) => r.id), ["packed", "calm"]);
  });
});

describe("Sensing §2 — a promotional or predicted claim is not a current reading", () => {
  it("a SPONSORED claim is Live-qualified but not a reading: no crowd axis, no whyNow", () => {
    const g = gradeLiveRow(row("s", [env({ sourceClass: "sponsored", value: { level: "busy" } })]), { mode: "social", nowMs: NOW });
    assert.equal(g.evidence, "none");
    assert.equal(g.axes.compatibility, null);
    assert.equal(g.opportunityValue, null);
    assert.equal(g.influence, 0);
    assert.deepEqual(g.whyNow, []);
  });

  it("a MATERIALLY CONFLICTING claim is not a reading either", () => {
    const g = gradeLiveRow(row("c", [env({ conflictState: "material" })]), { mode: "social", nowMs: NOW });
    assert.equal(g.evidence, "none");
    assert.equal(g.influence, 0);
  });

  it("an EMERGING trajectory reaches the forecast axis at half weight and is labelled forecast", () => {
    const building = env({ claimType: "crowd.trajectory", value: { trajectory: "building" }, state: "emerging", band: "likely_current" });
    const g = gradeLiveRow(row("e", [building]), { mode: "tonight", nowMs: NOW });
    assert.equal(g.evidence, "forecast");
    assert.equal(g.axes.forecast, 0.5);
    assert.deepEqual(g.whyNow, ["forecast_building"]);
    // A LIVE trajectory of the same value counts double — the forecast is never
    // presented as the observation.
    const live = env({ claimType: "crowd.trajectory", value: { trajectory: "building" } });
    const gl = gradeLiveRow(row("l", [live]), { mode: "tonight", nowMs: NOW });
    assert.equal(gl.axes.forecast, 1);
    assert.ok(gl.influence > g.influence);
  });

  it("an expired claim is neither a reading nor a forecast", () => {
    const g = gradeLiveRow(row("x", [env({ validUntil: iso(-1) })]), { mode: "social", nowMs: NOW });
    assert.equal(g.evidence, "none");
    assert.equal(g.influence, 0);
  });
});

describe("Sensing §8 — friction, travel time, interception and freshness reach the score", () => {
  it("a refused walk-in is the strongest non-safety negative", () => {
    const refused = row("r", [env(), env({ claimType: "access.walk_in", value: { accepted: false } })]);
    const open    = row("o", [env(), env({ claimType: "access.walk_in", value: { accepted: true } })]);
    const out = rankDiscoveryLive([refused, open], { mode: "social", nowMs: NOW });
    assert.deepEqual(out.ranked.map((r) => r.id), ["o", "r"]);
    assert.equal(out.byId.get("r")!.axes.friction, -1);
    assert.deepEqual(out.byId.get("r")!.whyNow.slice(-1), ["walk_in_refused"]);
  });

  it("a queue past the mode's tolerance lowers; one inside it does not", () => {
    const tol = INTENT_MODE_PROFILES.right_now.queueToleranceMinutes;
    const over  = gradeLiveRow(row("over",  [env(), env({ claimType: "queue.wait", value: { minMinutes: tol * 2 } })]), { mode: "right_now", nowMs: NOW });
    const under = gradeLiveRow(row("under", [env(), env({ claimType: "queue.wait", value: { minMinutes: 1 } })]),       { mode: "right_now", nowMs: NOW });
    assert.equal(over.axes.friction, -1);
    assert.equal(under.axes.friction, 0);
    assert.ok(over.influence < under.influence);
  });

  it("travel time decays to zero at the horizon and an unknown distance is a null axis", () => {
    const near = gradeLiveRow(row("n", [env()], { distanceKm: 0 }), { mode: "nearby", nowMs: NOW });
    const far  = gradeLiveRow(row("f", [env()], { distanceKm: 100 }), { mode: "nearby", nowMs: NOW });
    const unk  = gradeLiveRow(row("u", [env()], { distanceKm: null }), { mode: "nearby", nowMs: NOW });
    assert.equal(near.axes.travel, 1);
    assert.equal(far.axes.travel, 0);
    assert.equal(unk.axes.travel, null);
    assert.ok(near.influence > far.influence);
  });

  it("peak interception: arriving after the window's horizon is a negative, unknowable is a null", () => {
    const short = env({ validUntil: iso(5) });
    const late  = gradeLiveRow(row("late", [short], { distanceKm: null, etaMinutes: 120 }), { mode: "right_now", nowMs: NOW });
    const early = gradeLiveRow(row("early", [short], { distanceKm: null, etaMinutes: 1 }),  { mode: "right_now", nowMs: NOW });
    assert.equal(late.interception.reachable, false);
    assert.equal(late.axes.interception, -1);
    assert.equal(early.interception.reachable, true);
    assert.equal(early.axes.interception, 0);
    assert.ok(late.influence < early.influence);
    const unknown = gradeLiveRow(row("u", [short], { distanceKm: null, etaMinutes: null }), { mode: "right_now", nowMs: NOW });
    assert.equal(unknown.interception.reachable, null);
    assert.equal(unknown.axes.interception, null);
  });

  it("freshness is the §5.1 block's, and the truth block travels with the grade", () => {
    const g = gradeLiveRow(row("f", [env()]), { mode: "social", nowMs: NOW });
    assert.equal(g.truth?.freshness, "live");
    assert.equal(g.truth?.truthClass, "corroborated");
    assert.equal(g.truth?.coverage, "several");
    assert.equal(g.axes.freshness, 1);
  });

  it("'trip' prefers the durable window over the momentary one; 'right_now' does not", () => {
    const longWindow  = row("long",  [env({ validUntil: iso(170) })]);
    const shortWindow = row("short", [env({ validUntil: iso(10) })]);
    const trip = rankDiscoveryLive([shortWindow, longWindow], { mode: "trip", nowMs: NOW });
    assert.deepEqual(trip.ranked.map((r) => r.id), ["long", "short"]);
    assert.equal(INTENT_MODE_PROFILES.right_now.weights.durability, 0);
  });
});

describe("Sensing §8 — whyNow is grounded, and the influence is bounded", () => {
  it("every whyNow entry names a value that qualified; nothing is composed", () => {
    const g = gradeLiveRow(row("w", [
      env({ value: { level: "busy" } }),
      env({ claimType: "crowd.trajectory", value: { trajectory: "building" } }),
      env({ claimType: "vibe.state", value: { state: "going_off" } }),
    ]), { mode: "high_energy", nowMs: NOW });
    assert.deepEqual(g.whyNow, ["crowd_busy", "trajectory_building", "reported_vibe_going_off"]);
    assert.ok(g.claimRefs.length === 3);
  });

  it("whyNowFrom emits nothing when nothing is live and nothing is emerging", () => {
    const empty = whyNowFrom(
      { live: false, liveNonObservational: false, emerging: false, unsafe: false, crowdLevel: "busy",
        trajectory: "building", vibe: "going_off", walkIn: false, queueMinMinutes: 90, horizonAt: null,
        truth: { truthClass: "unknown", confidence: "unverified", freshness: "unknown", coverage: "unknown", provenance: [] },
        claimRefs: [] },
      { compatibility: null, forecast: null, travel: null, friction: null, freshness: null, interception: null, durability: null },
      null,
    );
    assert.deepEqual(empty, []);
  });

  it("the influence is a signed −1..1, and it is spent in at most LIVE_RANK_MAX_POSITIONS places", () => {
    const bestEnvs  = [env({ value: { level: "quiet" } }), env({ claimType: "crowd.trajectory", value: { trajectory: "building" } })];
    const worstEnvs = [env({ value: { level: "packed" } }), env({ claimType: "access.walk_in", value: { accepted: false } }), env({ claimType: "crowd.trajectory", value: { trajectory: "fading" } })];
    const best  = gradeLiveRow(row("best",  bestEnvs,  { distanceKm: 0 }),   { mode: "quiet", nowMs: NOW });
    const worst = gradeLiveRow(row("worst", worstEnvs, { distanceKm: 100 }), { mode: "quiet", nowMs: NOW });
    assert.ok(best.influence > 0 && best.influence <= 1);
    assert.ok(worst.influence < 0 && worst.influence >= -1);

    // A perfectly-evidenced row placed LAST in a long window cannot reach the
    // top: it moves at most LIVE_RANK_MAX_POSITIONS places. This is the claim
    // "a place nobody reported on cannot be pushed off page one".
    const n = LIVE_RANK_MAX_POSITIONS * 3;
    const rows = [...Array.from({ length: n - 1 }, (_, i) => row(`plain${i}`, [])), row("best", bestEnvs, { distanceKm: 0 })];
    const ranked = rankDiscoveryLive(rows, { mode: "quiet", nowMs: NOW }).ranked.map((r) => r.id);
    const moved = (n - 1) - ranked.indexOf("best");
    assert.ok(moved > 0, "a fully-evidenced row did not move at all");
    assert.ok(moved <= LIVE_RANK_MAX_POSITIONS, `moved ${moved} places, cap is ${LIVE_RANK_MAX_POSITIONS}`);
    assert.notEqual(ranked[0], "best", "live evidence carried a row from last to first");
  });

  it("the window is bounded: rows past LIVE_RANK_WINDOW are never graded and never move", () => {
    const rows = Array.from({ length: LIVE_RANK_WINDOW + 5 }, (_, i) =>
      row(`r${i}`, i >= LIVE_RANK_WINDOW ? [env({ value: { level: "quiet" } })] : []));
    const out = rankDiscoveryLive(rows, { mode: "quiet", nowMs: NOW });
    assert.equal(out.windowSize, LIVE_RANK_WINDOW);
    assert.equal(out.byId.size, LIVE_RANK_WINDOW);
    assert.equal(out.byId.has(`r${LIVE_RANK_WINDOW}`), false);
    assert.deepEqual(out.ranked.slice(LIVE_RANK_WINDOW).map((r) => r.id),
      rows.slice(LIVE_RANK_WINDOW).map((r) => r.id), "the tail was re-ordered");
  });

  it("the sort is stable: ungraded rows keep their incoming order among themselves", () => {
    const rows = Array.from({ length: 8 }, (_, i) => row(`s${i}`, []));
    const out = rankDiscoveryLive(rows, { mode: "explore", nowMs: NOW });
    assert.deepEqual(out.ranked.map((r) => r.id), rows.map((r) => r.id));
  });

  it("opportunityValueOf answers null when no weighted axis is known", () => {
    const none = opportunityValueOf(
      { compatibility: null, forecast: null, travel: null, friction: null, freshness: null, interception: null, durability: null },
      INTENT_MODE_PROFILES.social,
    );
    assert.equal(none, null);
  });

  it("etaMinutesOf prefers the caller's estimate and falls back to walking over the distance", () => {
    assert.equal(etaMinutesOf({ id: "a", subjectId: null, envelopes: [], readable: true, distanceKm: 10, etaMinutes: 7 }, 5), 7);
    assert.equal(etaMinutesOf({ id: "a", subjectId: null, envelopes: [], readable: true, distanceKm: 5 }, 5), 60);
    assert.equal(etaMinutesOf({ id: "a", subjectId: null, envelopes: [], readable: true, distanceKm: null }, 5), null);
  });
});
