/**
 * Sensing §5 — the CROWD engine's `CrowdState` (census-sensing S40) and the
 * FORECAST engine's `ForecastState` (S45).
 *
 * Every rule is pinned on its own so a mutation of one cannot hide behind
 * another: the three axes are three and never borrow from each other; a
 * safety level is never a density; nothing in the state is a quality score;
 * truth and time are the evidence's own; a forecast refuses rather than
 * invents; and a forecast is always PREDICTED, always carries predicted_for,
 * and can never climb into a Live slot on calibration it does not have.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CROWD_STATE_CLAIM_TYPES,
  CROWD_STATE_VALUE_KEYS,
  DENSITY_LADDER,
  NET_ARRIVAL_OF,
  buildCrowdState,
  crowdStateForeignKeys,
  crowdStateIsEmpty,
  type CrowdState,
} from "../lib/crowdState.js";
import {
  DIRECTION_OF_TRAJECTORY,
  MAX_FORECAST_HORIZON_MINUTES,
  UNCALIBRATED_BAND_CEILING,
  bandFromCalibration,
  buildForecastState,
  forecastMayRenderAsLive,
  stepDensity,
  type ForecastCalibration,
} from "../lib/forecastState.js";
import { temporalIncoherence } from "../lib/experienceTruth.js";
import { CROWD_LEVELS, MIN_BAND_FOR_LIVE_STATE, TRAJECTORIES, CROWD_DIRECTIONS } from "../lib/intelContracts.js";
import type { LiveClaimEnvelope } from "../lib/liveClaimRead.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.parse("2026-09-12T20:00:00.000Z");
const iso = (offsetMinutes: number) => new Date(NOW + offsetMinutes * 60_000).toISOString();

let seq = 0;
function env(over: Partial<LiveClaimEnvelope> = {}): LiveClaimEnvelope {
  seq += 1;
  return {
    id: `snap-${seq}`,
    claimType: "crowd.level",
    value: { level: "busy" },
    confidence: 0.85,
    band: "live",
    sourceClass: "firsthand_unverified",
    sourceCountBucket: "few",
    observedAt: iso(-3),
    validUntil: iso(27),
    state: "live",
    conflictState: "none",
    conflict: null,
    ...over,
  };
}
const level = (l: string, over: Partial<LiveClaimEnvelope> = {}) => env({ claimType: "crowd.level", value: { level: l }, ...over });
const traj = (t: string, over: Partial<LiveClaimEnvelope> = {}) => env({ claimType: "crowd.trajectory", value: { trajectory: t }, ...over });
const dir = (d: string, over: Partial<LiveClaimEnvelope> = {}) => env({ claimType: "crowd.direction", value: { direction: d }, ...over });
const build = (envelopes: LiveClaimEnvelope[]): CrowdState => buildCrowdState({ envelopes }, NOW);

describe("CrowdState — the three axes", () => {
  it("reads exactly crowd.level / crowd.trajectory / crowd.direction, and nothing else is crowd evidence", () => {
    assert.deepEqual([...CROWD_STATE_CLAIM_TYPES], ["crowd.level", "crowd.trajectory", "crowd.direction"]);
    const s = build([level("busy"), traj("building"), dir("arriving"), env({ claimType: "vibe.state", value: { state: "going_off" } })]);
    assert.equal(s.density, "busy");
    assert.equal(s.momentum, "building");
    assert.deepEqual(s.balance, { direction: "arriving", netArrival: "positive" });
    assert.equal(s.claimRefs.length, 3, "the vibe claim fed nothing");
  });

  it("a missing axis is null with NO refusal — nothing was declined", () => {
    const s = build([level("quiet")]);
    assert.equal(s.momentum, null);
    assert.equal(s.balance, null);
    assert.deepEqual(s.refusals, []);
    assert.equal(crowdStateIsEmpty(s), false);
    assert.equal(crowdStateIsEmpty(build([])), true);
  });

  it("trajectory is never read as direction and direction never as trajectory", () => {
    const onlyDirection = build([dir("holding")]);
    assert.equal(onlyDirection.momentum, null, "holding is not a trajectory");
    const onlyTrajectory = build([traj("stable")]);
    assert.equal(onlyTrajectory.balance, null, "stable is not a direction");
  });

  it("every direction maps to a net arrival, and passing_through accumulates nothing", () => {
    for (const d of CROWD_DIRECTIONS) assert.ok(NET_ARRIVAL_OF[d], `${d} has a net arrival`);
    assert.equal(NET_ARRIVAL_OF.arriving, "positive");
    assert.equal(NET_ARRIVAL_OF.dispersing, "negative");
    assert.equal(NET_ARRIVAL_OF.passing_through, "neutral");
  });

  it("the NEWEST claim of an axis wins", () => {
    const s = build([level("quiet", { observedAt: iso(-30) }), level("packed", { observedAt: iso(-2) })]);
    assert.equal(s.density, "packed");
  });

  it("an unrecognised value leaves the axis null WITH a named refusal — never a guess", () => {
    const s = build([level("rammed"), traj("exploding"), dir("sideways")]);
    assert.deepEqual(s, {
      ...s,
      density: null,
      momentum: null,
      balance: null,
      refusals: ["unrecognised_density", "unrecognised_trajectory", "unrecognised_direction"],
    });
  });
});

describe("CrowdState — must not claim safety or quality (§2, §5)", () => {
  it("unsafe_density is REFUSED as a density, not promoted to the top of the ladder", () => {
    const s = build([level("unsafe_density")]);
    assert.equal(s.density, null);
    assert.deepEqual(s.refusals, ["unsafe_density_is_a_safety_claim"]);
    assert.equal(s.claimRefs.length, 0, "a refused claim feeds nothing");
  });
  it("the density ladder does not contain the safety level, and is the crowd vocabulary otherwise", () => {
    assert.ok(!DENSITY_LADDER.includes("unsafe_density" as never));
    assert.deepEqual([...DENSITY_LADDER], CROWD_LEVELS.filter((l) => l !== "unsafe_density"));
  });
  it("the state carries no quality, score, safety or headcount key — the value keys are the three axes", () => {
    assert.deepEqual([...CROWD_STATE_VALUE_KEYS], ["density", "momentum", "balance"]);
    const s = build([level("packed"), traj("peaking"), dir("arriving")]);
    assert.deepEqual(crowdStateForeignKeys(s as unknown as Record<string, unknown>), []);
    const json = JSON.stringify(s);
    for (const forbidden of ["score", "quality", "rating", "recommend", "safe", "unsafe", "count", "actor"]) {
      assert.doesNotMatch(json, new RegExp(forbidden, "i"), `no ${forbidden} on a CrowdState`);
    }
  });
});

describe("CrowdState — truth and time are the evidence's own", () => {
  it("the §5.1 block is composed from the claims that populated an axis, weakest on every axis", () => {
    const s = build([level("busy", { band: "live", sourceClass: "firsthand_unverified" }), traj("building", { band: "provisional" })]);
    assert.equal(s.truth.confidence, "provisional", "weakest band, never the strongest");
    assert.equal(s.truth.freshness, "live");
  });
  it("no claim at all ⇒ the floor, not a confident emptiness", () => {
    const s = build([]);
    assert.deepEqual(s.truth, { truthClass: "unknown", confidence: "unverified", freshness: "unknown", coverage: "unknown", provenance: [] });
    assert.deepEqual(s.temporal, { observedAt: null, effectiveFrom: null, effectiveUntil: null, expiresAt: null, freshness: "unknown", predictedFor: null });
  });
  it("the §18.2 envelope takes the newest observation and the EARLIEST expiry, and is coherent", () => {
    const s = build([level("busy", { observedAt: iso(-10), validUntil: iso(50) }), traj("building", { observedAt: iso(-2), validUntil: iso(20) })]);
    assert.equal(s.temporal.observedAt, iso(-2));
    assert.equal(s.temporal.effectiveUntil, iso(20), "the window closes with its first support");
    assert.equal(s.temporal.expiresAt, iso(20));
    assert.equal(s.temporal.predictedFor, null, "an observation has no predicted_for");
    assert.equal(temporalIncoherence(s.temporal, s.truth.truthClass), null);
  });
  it("is pure: no clock of its own and no database", () => {
    const code = readFileSync(join(SRC, "lib", "crowdState.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.doesNotMatch(code, /Date\.now\(|new Date\(\)/);
    assert.doesNotMatch(code, /supabase|getServiceClient|\.from\(/);
  });
});

describe("ForecastState — it refuses rather than invents", () => {
  const crowdOf = (envelopes: LiveClaimEnvelope[]) => build(envelopes);
  const forecast = (envelopes: LiveClaimEnvelope[], horizonMinutes = 60, calibration: ForecastCalibration | null = null) =>
    buildForecastState({ crowd: crowdOf(envelopes), horizonMinutes, calibration }, NOW);

  it("no trajectory evidence ⇒ NO forecast: silence is not 'steady'", () => {
    const r = forecast([level("busy")]);
    assert.equal(r.forecast, null);
    assert.deepEqual(r.refused, { refusal: "no_trajectory_evidence", horizonMinutes: 60 });
  });
  it("a safety reading ⇒ NO forecast for the subject at all", () => {
    const r = forecast([level("unsafe_density"), traj("building")]);
    assert.equal(r.forecast, null);
    assert.equal(r.refused?.refusal, "safety_level_not_forecastable");
  });
  it("a horizon past the evidence's usable life is refused, and the bound is the module's", () => {
    const stale = [traj("building", { observedAt: iso(-170), validUntil: iso(-140) }), level("busy", { observedAt: iso(-170), validUntil: iso(-140) })];
    assert.equal(forecast(stale, 30).refused?.refusal, "horizon_exceeds_evidence");
    assert.equal(forecast([traj("building")], 0).refused?.refusal, "invalid_horizon");
    assert.equal(forecast([traj("building")], MAX_FORECAST_HORIZON_MINUTES + 1).refused?.refusal, "invalid_horizon");
  });

  it("one rung, never two, never off the end, never onto the safety level", () => {
    assert.equal(stepDensity("busy", "rising"), "packed");
    assert.equal(stepDensity("packed", "rising"), "packed", "the ladder ends below the safety level");
    assert.equal(stepDensity("dead", "falling"), "dead");
    assert.equal(stepDensity("moderate", "steady"), "moderate");
    const f = forecast([level("moderate"), traj("building")]).forecast!;
    assert.equal(f.expectedDensity, "busy");
    assert.equal(f.fromDensity, "moderate");
    assert.equal(f.direction, "rising");
    assert.equal(f.fromTrajectory, "building");
  });
  it("every trajectory has a direction, and peaking claims no decay it cannot see", () => {
    for (const t of TRAJECTORIES) assert.ok(Object.prototype.hasOwnProperty.call(DIRECTION_OF_TRAJECTORY, t), `${t} is mapped`);
    assert.equal(DIRECTION_OF_TRAJECTORY.peaking, "steady");
    assert.equal(DIRECTION_OF_TRAJECTORY.declining, "falling");
  });
  it("a trajectory without a level forecasts a DIRECTION and no density", () => {
    const f = forecast([traj("declining")]).forecast!;
    assert.equal(f.direction, "falling");
    assert.equal(f.expectedDensity, null);
    assert.equal(f.fromDensity, null);
  });
});

describe("ForecastState — prediction is never observation (§5.1, §20)", () => {
  const forecast = (envelopes: LiveClaimEnvelope[], calibration: ForecastCalibration | null = null) =>
    buildForecastState({ crowd: build(envelopes), horizonMinutes: 60, calibration }, NOW).forecast!;

  it("the truth class is ASSIGNED `predicted`, whatever the evidence was", () => {
    const f = forecast([level("busy", { sourceClass: "verified_firsthand", band: "strong", sourceCountBucket: "many" }), traj("building", { sourceClass: "verified_firsthand", band: "strong" })]);
    assert.equal(f.truth.truthClass, "predicted");
    assert.ok(f.truth.provenance.includes("portava_prediction"));
  });
  it("predicted_for is set, the window ends there, and the envelope is coherent", () => {
    const f = forecast([level("busy"), traj("building")]);
    assert.equal(f.predictedFor, iso(60));
    assert.equal(f.temporal.predictedFor, iso(60));
    assert.equal(f.temporal.effectiveUntil, iso(60));
    assert.equal(f.temporal.expiresAt, iso(60));
    assert.equal(temporalIncoherence(f.temporal, f.truth.truthClass), null);
  });
  it("UNCALIBRATED is capped strictly below the Live floor, and cannot be rendered live", () => {
    const f = forecast([level("busy", { band: "strong" }), traj("building", { band: "strong" })]);
    assert.equal(f.calibration, null);
    assert.equal(f.calibrated, false);
    assert.equal(f.truth.confidence, UNCALIBRATED_BAND_CEILING);
    assert.equal(forecastMayRenderAsLive(f), false);
    assert.notEqual(UNCALIBRATED_BAND_CEILING, MIN_BAND_FOR_LIVE_STATE);
  });
  it("a MEASURED calibration lifts the ceiling but never past the evidence's own band", () => {
    const measured: ForecastCalibration = { method: "intel_calibration_daily", sampleSize: 400, accuracy: 0.95, measuredAt: iso(-1440) };
    assert.equal(bandFromCalibration(measured), "strong");
    const strong = forecast([level("busy", { band: "strong" }), traj("building", { band: "strong" })], measured);
    assert.equal(strong.calibrated, true);
    assert.equal(strong.truth.confidence, "strong");
    const weakEvidence = forecast([level("busy", { band: "provisional" }), traj("building", { band: "provisional" })], measured);
    assert.equal(weakEvidence.truth.confidence, "provisional", "the weakest of the two, never the calibration alone");
  });
  it("an EMPTY sample or a missing accuracy is not a calibration", () => {
    assert.equal(bandFromCalibration({ method: "m", sampleSize: 0, accuracy: 0.99, measuredAt: iso(0) }), UNCALIBRATED_BAND_CEILING);
    assert.equal(bandFromCalibration({ method: "m", sampleSize: 10, accuracy: null, measuredAt: iso(0) }), UNCALIBRATED_BAND_CEILING);
    assert.equal(bandFromCalibration(null), UNCALIBRATED_BAND_CEILING);
    const f = forecast([level("busy"), traj("building")], { method: "m", sampleSize: 0, accuracy: 0.99, measuredAt: iso(0) });
    assert.equal(f.calibrated, false);
  });
  it("is pure: no clock of its own and no database", () => {
    const code = readFileSync(join(SRC, "lib", "forecastState.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.doesNotMatch(code, /Date\.now\(|new Date\(\)/);
    assert.doesNotMatch(code, /supabase|getServiceClient|sc\.from\(|client\.from\(/);
  });
});
