/**
 * The nine §4.1 features reach the anonymous store and the vibe engine
 * (census-sensing S21 / S28 / S42 / S51 / S52 — the SERVER half, §26).
 *
 * ── THE CONTRACT, SHARED WITH THE CLIENT ─────────────────────────────────────
 * `docs/contracts/sensing-contribution-wire-v1.json` is read from the
 * repository root. travel-buddy-standalone's wireContribution.test.ts asserts
 * its mapper PRODUCES that fixture's `body`; this file asserts the server
 * ACCEPTS it — schema, store, aggregate, engine. Change the fixture and one
 * side turns red until the other follows. That is the whole point of a
 * fixture in neither package's tree.
 *
 * ── WHAT IS PROVED ───────────────────────────────────────────────────────────
 *   1. `contributionSchema` accepts the fixture body verbatim and refuses a
 *      body with one extra key, at both nesting levels (`.strict()`).
 *   2. `buildSensingContributionRow` spells the features as 3312's columns,
 *      one to one, and refuses a value outside its band by name.
 *   3. `aggregateSensingCohort` folds them PER CONTRIBUTOR under the same
 *      k-gate as the count: a sub-k cohort reports `features: null`, and a
 *      contributor's LATEST row is the one that counts.
 *   4. `aggregateSensingWindow` → `windowToVibeFeatures` hands the engine
 *      motionEnergy, periodicity, density and acousticEnergy — the four
 *      fields the producer used to leave null — and `acousticPermissionGranted`
 *      only when the cohort actually held the permission.
 *   5. What it still does NOT do: read `motionEnergy` off `signal_bucket`.
 *      The ordinal's meaning stays unpinned; a cohort with signal buckets and
 *      no features leaves motionEnergy null.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { contributionSchema } from "../routes/sensingIngest.js";
import {
  SENSING_FEATURE_COLUMNS,
  buildSensingContributionRow,
  normalizeSensingFeatures,
  deriveEpochSecret,
  revocationCommitment,
  rotationEpochFor,
  type SensingContributionFeatures,
  type SensingContributionRow,
  type SensingReadResult,
} from "../lib/sensingAnonStore.js";
import { aggregateSensingCohort, cohortFeatures } from "../lib/sensingCoverageAggregate.js";
import { aggregateSensingWindow, windowToVibeFeatures } from "../lib/sensingWindowAggregate.js";
import { PRIVACY_THRESHOLD_V1 } from "../lib/intelContracts.js";

process.env.SENSING_CONTRIBUTOR_PEPPER ??= "p".repeat(64);

const here = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT = JSON.parse(
  readFileSync(path.resolve(here, "../../../../docs/contracts/sensing-contribution-wire-v1.json"), "utf8"),
) as { body: Record<string, unknown> & { features: SensingContributionFeatures } };

// Read 20 minutes after the newest bucket: past the 10-minute publication
// delay the k-gate enforces, inside the observation-age bound.
const NOW = Date.UTC(2026, 8, 26, 12, 20, 0);
const T0 = Date.UTC(2026, 8, 26, 12, 0, 0);
const HOUR = 3_600_000;
const G = PRIVACY_THRESHOLD_V1.minIndependentGroups;
const K = PRIVACY_THRESHOLD_V1.minUniqueActors;

function features(over: Partial<SensingContributionFeatures> = {}): SensingContributionFeatures {
  return { ...CONTRACT.body.features, ...over };
}

function row(name: string, over: { features?: SensingContributionFeatures | null; atMs?: number; group?: string } = {}): SensingContributionRow {
  const atMs = over.atMs ?? T0;
  // The epoch is the OBSERVATION's hour (the store refuses a mismatch), so an
  // earlier bucket across the hour boundary gets its own epoch and commitment.
  const epoch = rotationEpochFor(atMs);
  const built = buildSensingContributionRow(
    {
      commitment: revocationCommitment(deriveEpochSecret(`device-${name}`, epoch)),
      rotationEpoch: epoch,
      groupTag: over.group ?? `g-${name}`,
      zoneId: "dr5ru7",
      observedAtMs: atMs,
      signalBucket: 1,
      features: over.features === undefined ? features() : over.features,
    },
    atMs,
  );
  assert.ok(built.ok, `fixture row refused: ${!built.ok && built.error}`);
  return { ...built.row, created_at: new Date(atMs).toISOString(), expires_at: new Date(atMs + 24 * HOUR).toISOString() };
}

/** k contributors across enough groups to pass the share cap. */
function cohort(n: number, per: (i: number) => Partial<Parameters<typeof row>[1]> = () => ({})): SensingReadResult {
  const cap = Math.floor(n * PRIVACY_THRESHOLD_V1.maxSingleGroupShare);
  const groups = Math.max(G, cap > 0 ? Math.ceil(n / cap) : G);
  const rows = Array.from({ length: n }, (_, i) => row(`c${i}`, { group: `grp-${i % groups}`, ...per(i) }));
  return { ok: true, complete: true, rows };
}

// ── 1. the schema ────────────────────────────────────────────────────────────

describe("the wire contract: the server accepts exactly what the client sends", () => {
  it("the fixture body parses, verbatim", () => {
    const r = contributionSchema.safeParse(CONTRACT.body);
    assert.equal(r.success, true, r.success ? "" : JSON.stringify(r.error.issues[0]));
  });

  it("one extra key at either level is refused — nothing rides in under a new name", () => {
    assert.equal(contributionSchema.safeParse({ ...CONTRACT.body, lat: 51.5 }).success, false);
    assert.equal(contributionSchema.safeParse({ ...CONTRACT.body, features: { ...CONTRACT.body.features, latitude: 51.5 } }).success, false);
    assert.equal(contributionSchema.safeParse({ ...CONTRACT.body, features: { ...CONTRACT.body.features, acoustic: { ...CONTRACT.body.features.acoustic, samples: [1] } } }).success, false);
  });

  it("the legacy shape — no features at all — still parses", () => {
    const { features: _f, ...legacy } = CONTRACT.body;
    void _f;
    assert.equal(contributionSchema.safeParse(legacy).success, true);
  });

  it("a value outside its band is refused by the schema AND by the store, by name", () => {
    assert.equal(contributionSchema.safeParse({ ...CONTRACT.body, features: { ...CONTRACT.body.features, motionEnergyCenti: 101 } }).success, false);
    const r = normalizeSensingFeatures(features({ motionEnergyCenti: 101 }));
    assert.deepEqual(r, { ok: false, error: "features_invalid:motionEnergyCenti" });
    assert.deepEqual(normalizeSensingFeatures(features({ density: "packed_tight" as never })), { ok: false, error: "features_invalid:density" });
    assert.deepEqual(normalizeSensingFeatures(features({ acoustic: { energyBucket: 9, rhythmBucket: "steady", confidenceCenti: 50 } })), { ok: false, error: "features_invalid:acoustic.energyBucket" });
  });
});

// ── 2. the store ─────────────────────────────────────────────────────────────

describe("the store spells the features as 3312's columns", () => {
  it("one to one, and the acoustic pair travels together", () => {
    const r = row("a");
    assert.equal(r.zone_precision, 6);
    assert.equal(r.place_candidate, "place-9f2a");
    assert.equal(r.movement_class, "pedestrian");
    assert.equal(r.motion_energy_centi, 35);
    assert.equal(r.periodicity_centi, 61);
    assert.equal(r.dwell_bucket, 2);
    assert.equal(r.transition_kind, "arrival");
    assert.equal(r.transport_mode, "pedestrian");
    assert.equal(r.transport_mode_centi, 80);
    assert.equal(r.density_bucket, "moderate");
    assert.equal(r.bounded_movement, true);
    assert.equal(r.sensor_health_centi, 80);
    assert.equal(r.acoustic_energy_bucket, 2);
    assert.equal(r.acoustic_rhythm, "steady");
    assert.equal(r.acoustic_health_centi, 70);
    for (const col of SENSING_FEATURE_COLUMNS) assert.ok(col in r, `${col} missing from the row`);
  });

  it("without the acoustic pair all three acoustic columns are null; without features none of the columns is set", () => {
    const { acoustic: _a, ...noAcoustic } = features();
    void _a;
    const r = row("b", { features: noAcoustic });
    assert.equal(r.acoustic_energy_bucket, null);
    assert.equal(r.acoustic_rhythm, null);
    assert.equal(r.acoustic_health_centi, null);
    const legacy = row("c", { features: null });
    for (const col of SENSING_FEATURE_COLUMNS) assert.equal(col in legacy, false, `${col} set on a legacy row`);
  });

  it("no feature column is person-shaped, and no raw sample or coordinate has a column", () => {
    for (const col of SENSING_FEATURE_COLUMNS) {
      assert.doesNotMatch(col, /user|actor|profile|account|device|session|installation|token|lat|lng|sample|coord/i);
    }
  });
});

// ── 3. the cohort ────────────────────────────────────────────────────────────

describe("the cohort folds the features per contributor under the k-gate", () => {
  it("a k-passing cohort reports per-contributor medians and the plurality density", () => {
    const read = cohort(K, (i) => ({
      features: features({ motionEnergyCenti: 10 + i, density: i % 3 === 0 ? "busy" : "moderate" }),
    }));
    const a = aggregateSensingCohort(read, { nowMs: NOW });
    assert.equal(a.publishable, true);
    assert.ok(a.features);
    assert.equal(a.features.contributorsWithFeatures, K);
    assert.equal(a.features.motionEnergyCenti, 10 + Math.floor((K - 1) / 2), "lower median over contributors");
    assert.equal(a.features.densityBucket, "moderate", "plurality, not the loudest");
    assert.equal(a.features.acousticContributors, K);
    assert.equal(a.features.acousticEnergyBucket, 2);
  });

  it("a sub-k cohort reports NO feature statistic — a median of three people is a fact about three people", () => {
    const a = aggregateSensingCohort(cohort(3), { nowMs: NOW });
    assert.equal(a.publishable, false);
    assert.equal(a.features, null);
  });

  it("a contributor's LATEST row is the one that counts, so a prolific device weighs one", () => {
    const base = cohort(K, () => ({ features: features({ motionEnergyCenti: 20 }) }));
    const rows = [...(base.ok ? base.rows : [])];
    // The first contributor writes again, later, with a very different energy.
    const again = row("c0", { group: "grp-0", atMs: T0 + 60_000, features: features({ motionEnergyCenti: 90 }) });
    rows.push(again);
    const a = aggregateSensingCohort({ ok: true, complete: true, rows }, { nowMs: NOW });
    assert.ok(a.features);
    assert.equal(a.features.contributorsWithFeatures, K, "one weight per contributor");
    assert.equal(a.features.motionEnergyCenti, 20, "one outlier row cannot move the median past the crowd");
  });

  it("`unknown` density does not vote, and a tie keeps the lower band", () => {
    const f = cohortFeatures([
      { ...features(), density_bucket: "unknown", movement_class: "unknown" } as never,
      { movement_class: "pedestrian", density_bucket: "busy" } as never,
      { movement_class: "pedestrian", density_bucket: "sparse" } as never,
    ]);
    assert.equal(f.densityBucket, "sparse");
    assert.equal(cohortFeatures([{ movement_class: "unknown", density_bucket: "unknown" } as never]).densityBucket, null);
    assert.equal(cohortFeatures([]).contributorsWithFeatures, 0);
  });
});

// ── 4. the window and the engine ─────────────────────────────────────────────

describe("the window hands the engine the four features it used to leave null", () => {
  const bucketAt = (n: number) => new Date(T0 - n * PRIVACY_THRESHOLD_V1.timeBucketMinutes * 60_000).toISOString();
  function windowOf(per: (i: number) => Partial<Parameters<typeof row>[1]>) {
    const prev = cohort(K, (i) => ({ atMs: Date.parse(bucketAt(1)), ...per(i) }));
    const cur = cohort(K, (i) => ({ atMs: Date.parse(bucketAt(0)), ...per(i) }));
    return aggregateSensingWindow(
      [{ timeBucket: bucketAt(1), read: prev }, { timeBucket: bucketAt(0), read: cur }],
      { nowMs: NOW, timeBucketMinutes: PRIVACY_THRESHOLD_V1.timeBucketMinutes },
    );
  }

  it("motionEnergy, periodicity, density and acousticEnergy are populated from the reduced features", () => {
    const w = windowOf(() => ({}));
    assert.equal(w.reason, null);
    assert.equal(w.reducedFeatures.bucketsWithFeatures, 2);
    const v = windowToVibeFeatures(w, null);
    assert.equal(v.motionEnergy, 0.35);
    assert.equal(v.periodicity, 0.61);
    assert.equal(v.density, "several", "moderate → several on the engine's ladder");
    assert.equal(v.acousticEnergy, 0.5, "bucket 2 of 4");
    assert.equal(v.acousticPermissionGranted, true);
  });

  it("acousticPermissionGranted is false, and acousticEnergy null, when no contributor held the permission", () => {
    const { acoustic: _a, ...noAcoustic } = features();
    void _a;
    const v = windowToVibeFeatures(windowOf(() => ({ features: noAcoustic })), null);
    assert.equal(v.acousticEnergy, null);
    assert.equal(v.acousticPermissionGranted, false);
    assert.equal(v.motionEnergy, 0.35, "the rest still flows");
  });

  it("a cohort with signal buckets but NO features leaves all four null — the ordinal is still not read as motion", () => {
    const w = windowOf(() => ({ features: null }));
    assert.equal(w.reason, null);
    assert.equal(w.medianSignalBucket, 1, "the ordinal is still carried out");
    const v = windowToVibeFeatures(w, null);
    assert.equal(v.motionEnergy, null);
    assert.equal(v.periodicity, null);
    assert.equal(v.density, null);
    assert.equal(v.acousticEnergy, null);
    assert.equal(v.acousticPermissionGranted, false);
  });

  it("the device dwell estimate answers only when the window measured no persistence itself", () => {
    const w = windowOf(() => ({}));
    // Two buckets with the same contributors: persistence dwell is measured (>= 1) and wins.
    assert.ok(w.dwellBucket !== null);
    assert.equal(windowToVibeFeatures(w, null).dwellBucket, w.dwellBucket);
    // A single bucket measures no persistence; the devices' own estimate stands in.
    const single = aggregateSensingWindow(
      [{ timeBucket: bucketAt(0), read: cohort(K, () => ({ atMs: Date.parse(bucketAt(0)) })) }],
      { nowMs: NOW, timeBucketMinutes: PRIVACY_THRESHOLD_V1.timeBucketMinutes },
    );
    assert.equal(single.reducedFeatures.reducedDwellBucket, 2);
    assert.equal(windowToVibeFeatures(single, null).dwellBucket, single.dwellBucket ?? 2);
  });

  it("no field on the window or its reduced features is person-shaped", () => {
    const w = windowOf(() => ({}));
    for (const key of [...Object.keys(w), ...Object.keys(w.reducedFeatures)]) {
      assert.ok(!/token|actor|contributor(?!s$)|device|user|profile/i.test(key) || key === "bucketsPublishable", key);
    }
  });
});
