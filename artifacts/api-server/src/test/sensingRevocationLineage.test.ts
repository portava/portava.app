/**
 * sensingRevocationLineage — §18.4 defined and proven for the anonymous path.
 *
 * Revocation REMOVES raw rows, PREVENTS the contributor from counting in a
 * future aggregation, and RETAINS the already-published aggregate — which is
 * honest only because that aggregate carries nothing a revocation could find.
 * Census S112.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SENSING_LINEAGE_STAGES,
  SENSING_REVOCATION_EFFECT,
  SENSING_REVOCATION_SCOPE,
  aggregateCarriesIdentity,
  modelSensingRevocation,
} from "../lib/sensingRevocationLineage.js";
import {
  deriveContributorToken,
  deriveEpochSecret,
  revocationCommitment,
  rotationEpochFor,
  sensingTimeBucket,
  type SensingContributionRow,
} from "../lib/sensingAnonStore.js";
import { aggregateSensingCohort } from "../lib/sensingCoverageAggregate.js";
import { buildSensingPresenceState } from "../lib/sensingPresenceState.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_TS = readFileSync(join(SRC, "lib", "sensingRevocationLineage.ts"), "utf8");

process.env.SENSING_CONTRIBUTOR_PEPPER ??= "p".repeat(40);

const NOW = Date.UTC(2026, 8, 7, 22, 0, 0);
const EPOCH = rotationEpochFor(NOW);
const BUCKET = sensingTimeBucket(NOW - 20 * 60_000);

function cohort(n: number, groups: number): SensingContributionRow[] {
  const rows: SensingContributionRow[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      contributor_token: deriveContributorToken(EPOCH, revocationCommitment(deriveEpochSecret(`device-${i}`, EPOCH))),
      rotation_epoch: EPOCH,
      group_token: `grp-${i % groups}-${"y".repeat(16)}`,
      zone_id: "zone-alpha",
      time_bucket: BUCKET,
      cohort_key: "v1|zone-alpha|bucket",
      signal_bucket: i % 5,
      reduction_version: 1,
      created_at: new Date(NOW - 15 * 60_000).toISOString(),
      expires_at: new Date(NOW + 3600_000).toISOString(),
    });
  }
  return rows;
}

describe("the definition", () => {
  it("names every §18.4 stage and states one effect per stage", () => {
    assert.deepEqual([...SENSING_LINEAGE_STAGES], ["raw", "aggregate", "inference", "session", "memory"]);
    for (const s of SENSING_LINEAGE_STAGES) assert.ok(SENSING_REVOCATION_EFFECT[s], s);
    assert.equal(SENSING_REVOCATION_EFFECT.raw, "removed");
    assert.equal(SENSING_REVOCATION_EFFECT.aggregate, "retained_deidentified");
    assert.equal(SENSING_REVOCATION_EFFECT.inference, "retained_deidentified");
    assert.equal(SENSING_REVOCATION_EFFECT.session, "prevented");
    assert.equal(SENSING_REVOCATION_EFFECT.memory, "prevented");
    assert.equal(SENSING_REVOCATION_SCOPE, "per_epoch");
    assert.ok(Object.isFrozen(SENSING_REVOCATION_EFFECT));
  });

  it("'prevented' is true in the tree: nothing sensing reaches a session or memory module", () => {
    assert.doesNotMatch(MODULE_TS, /from "\.\/(memory|[a-zA-Z]*[Ss]ession)/);
  });
});

describe("the executable definition", () => {
  it("removes the revoked device's raw rows, and a future aggregation no longer counts it", () => {
    const rows = cohort(30, 6);
    const published = aggregateSensingCohort({ ok: true, complete: true, rows }, { nowMs: NOW });
    assert.equal(published.publishable, true, published.reason ?? "");
    const outcome = modelSensingRevocation(rows, published, { rotationEpoch: EPOCH, epochSecret: deriveEpochSecret("device-3", EPOCH) }, NOW);
    assert.equal(outcome.removed, 1);
    assert.equal(outcome.after.distinctActors, 29);
    assert.equal(published.distinctActors, 30, "the published value is not rewritten");
  });

  it("the scope is one epoch: a secret for another epoch removes nothing", () => {
    const rows = cohort(30, 6);
    const published = aggregateSensingCohort({ ok: true, complete: true, rows }, { nowMs: NOW });
    const outcome = modelSensingRevocation(rows, published, { rotationEpoch: EPOCH - 1, epochSecret: deriveEpochSecret("device-3", EPOCH - 1) }, NOW);
    assert.equal(outcome.removed, 0);
  });

  it("the published aggregate carries no contributor or group token — so 'retained' is de-identified, not a euphemism", () => {
    const rows = cohort(30, 6);
    const published = aggregateSensingCohort({ ok: true, complete: true, rows }, { nowMs: NOW });
    assert.equal(aggregateCarriesIdentity(published, rows), null);
    const outcome = modelSensingRevocation(rows, published, { rotationEpoch: EPOCH, epochSecret: deriveEpochSecret("device-0", EPOCH) }, NOW);
    assert.equal(outcome.publishedAggregateCarriedIdentity, null);
  });

  it("the detector really detects: an aggregate that smuggled a token is caught", () => {
    const rows = cohort(30, 6);
    const published = aggregateSensingCohort({ ok: true, complete: true, rows }, { nowMs: NOW });
    const leaky = { ...published, debug: rows[4].contributor_token } as any;
    assert.equal(aggregateCarriesIdentity(leaky, rows), "contributor_token");
    const leakyGroup = { ...published, g: rows[4].group_token } as any;
    assert.equal(aggregateCarriesIdentity(leakyGroup, rows), "group_token");
  });

  it("the inference stage retains nothing identifying either: the presence state built from the aggregate names no token", () => {
    const rows = cohort(30, 6);
    const published = aggregateSensingCohort({ ok: true, complete: true, rows }, { nowMs: NOW });
    const state = buildSensingPresenceState({ zoneId: "zone-alpha", timeBucket: BUCKET, aggregate: published, nowMs: NOW });
    const json = JSON.stringify(state);
    for (const r of rows) {
      assert.ok(!json.includes(r.contributor_token));
      assert.ok(!json.includes(r.group_token as string));
    }
  });

  it("revoking below k turns the future aggregate UNPUBLISHABLE rather than into a smaller number", () => {
    const rows = cohort(15, 5); // exactly at the actor floor
    const published = aggregateSensingCohort({ ok: true, complete: true, rows }, { nowMs: NOW });
    assert.equal(published.publishable, true, published.reason ?? "");
    const outcome = modelSensingRevocation(rows, published, { rotationEpoch: EPOCH, epochSecret: deriveEpochSecret("device-1", EPOCH) }, NOW);
    assert.equal(outcome.after.publishable, false);
    assert.equal(outcome.after.medianSignalBucket, null);
  });
});
