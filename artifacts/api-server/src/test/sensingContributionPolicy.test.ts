/**
 * sensingContributionPolicy — the S1 privacy contract.
 *
 * §4.2's IntelligenceContributionSession properties, each bound to the
 * primitive that owns it; §3's seven verbs as DISTINCT permissions with the
 * ungranted four refused by default; pure admission. No issuer, no route.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTRIBUTION_PURPOSE_SCOPES,
  SENSING_ANON_GRANTED_SCOPES,
  SENSING_ANON_POLICY_V1,
  admitSensingContribution,
  isContributionPurposeScope,
  sessionIsActive,
  type IssuedContributionSession,
} from "../lib/sensingContributionPolicy.js";
import {
  SENSING_DEFAULT_TTL_SECONDS,
  SENSING_MAX_OBSERVATION_AGE_SECONDS,
  SENSING_MAX_TTL_SECONDS,
  SENSING_REDUCTION_VERSION,
  SENSING_ROTATION_PERIOD_SECONDS,
  deriveEpochSecret,
  revocationCommitment,
  rotationEpochFor,
} from "../lib/sensingAnonStore.js";
import { PRIVACY_THRESHOLD_V1 } from "../lib/intelContracts.js";
import { FEATURE_PRECISION_CEILING, PRECISION_LADDER, precisionRank } from "../presence/domain/types.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_TS = readFileSync(join(SRC, "lib", "sensingContributionPolicy.ts"), "utf8");

const NOW = Date.UTC(2026, 8, 7, 22, 0, 0);
const DEVICE_SECRET = "device-secret-that-never-leaves-the-device";

process.env.SENSING_CONTRIBUTOR_PEPPER ??= "p".repeat(40);

function input(over: Record<string, unknown> = {}) {
  const observedAtMs = (over.observedAtMs as number | undefined) ?? NOW - 60_000;
  const epoch = rotationEpochFor(observedAtMs);
  return {
    commitment: revocationCommitment(deriveEpochSecret(DEVICE_SECRET, epoch)),
    rotationEpoch: epoch,
    zoneId: "zone-alpha",
    observedAtMs,
    signalBucket: 2,
    ...over,
  } as any;
}

describe("§3's seven verbs are distinct permissions", () => {
  it("the vocabulary is the spec's, verbatim and in order", () => {
    assert.deepEqual([...CONTRIBUTION_PURPOSE_SCOPES], ["collect", "retain", "aggregate", "infer", "personalize", "surface", "share"]);
    assert.ok(isContributionPurposeScope("share"));
    assert.equal(isContributionPurposeScope("track"), false);
  });

  it("the anonymous store is granted exactly collect / retain / aggregate — the ruling's enumeration", () => {
    assert.deepEqual([...SENSING_ANON_GRANTED_SCOPES], ["collect", "retain", "aggregate"]);
    for (const s of SENSING_ANON_GRANTED_SCOPES) assert.ok(isContributionPurposeScope(s));
  });

  it("requesting an ungranted verb is refused, before any arithmetic", () => {
    for (const scope of ["infer", "personalize", "surface", "share"]) {
      const r = admitSensingContribution(input({ purposeScopes: ["collect", scope], signalBucket: 99 }), NOW);
      assert.deepEqual(r, { admitted: false, reason: "scope_not_granted", scope });
    }
  });

  it("an unknown verb is refused as unknown, not silently dropped", () => {
    const r = admitSensingContribution(input({ purposeScopes: ["collect", "track"] }), NOW);
    assert.deepEqual(r, { admitted: false, reason: "scope_unknown", scope: "track" });
  });
});

describe("the policy binds every §4.2 property to the primitive that owns it", () => {
  const p = SENSING_ANON_POLICY_V1;
  it("retention: 2315's ceiling and the store's default", () => {
    assert.equal(p.retention.maxTtlSeconds, SENSING_MAX_TTL_SECONDS);
    assert.equal(p.retention.defaultTtlSeconds, SENSING_DEFAULT_TTL_SECONDS);
  });
  it("sampling: the shared privacy bucket, one contribution per cohort (2340)", () => {
    assert.equal(p.sampling.cohortMinutes, PRIVACY_THRESHOLD_V1.timeBucketMinutes);
    assert.equal(p.sampling.maxContributionsPerCohort, 1);
  });
  it("credential: the store's rotation period; validity equals the observation-age ceiling in epochs", () => {
    assert.equal(p.credential.rotationPeriodSeconds, SENSING_ROTATION_PERIOD_SECONDS);
    assert.equal(p.credential.validityEpochsBack, Math.ceil(SENSING_MAX_OBSERVATION_AGE_SECONDS / SENSING_ROTATION_PERIOD_SECONDS));
    assert.equal(p.credential.kind, "rotating_commitment");
  });
  it("precision: a contribution is stored at `zone`; no individual is ever rendered above the ladder's crowd ceiling", () => {
    assert.equal(p.precision.contribution, "zone");
    assert.equal(p.precision.renderedIndividual, FEATURE_PRECISION_CEILING.crowd_intelligence);
    assert.ok(PRECISION_LADDER.includes(p.precision.contribution));
    // Note for the owner, pinned rather than hidden: the store holds MORE
    // precision (zone) than the ladder lets a consumer render for an individual
    // (presence_only). Only k-gated aggregates leave the store, which is why
    // this is acceptable; the test makes the relationship visible.
    assert.ok(precisionRank(p.precision.contribution) > precisionRank(p.precision.renderedIndividual));
  });
  it("the two undecided things are recorded as undecided, not defaulted", () => {
    assert.equal(p.captureMode, "not_decided");
    assert.equal(p.privacyBudget.maxCohortsPerEpoch, null);
  });
  it("revocation is per-epoch by secret reveal; capability pins the reduction version", () => {
    assert.deepEqual(p.revocation, { kind: "epoch_secret_reveal", scope: "per_epoch" });
    assert.equal(p.clientCapability.reductionVersion, SENSING_REDUCTION_VERSION);
  });
  it("the policy object is frozen", () => {
    assert.ok(Object.isFrozen(p));
  });
});

describe("admission", () => {
  it("a well-formed contribution under the default scopes is admitted and becomes the store's row", () => {
    const r = admitSensingContribution(input(), NOW);
    assert.ok(r.admitted, JSON.stringify(r));
    assert.equal(r.row.zone_id, "zone-alpha");
    assert.equal(r.row.signal_bucket, 2);
    // No identity-shaped key on the admitted row.
    for (const k of Object.keys(r.row)) assert.doesNotMatch(k, /user|actor|profile|account|device|session|installation/i);
  });

  it("a coordinate pair smuggled into the zone label is refused", () => {
    for (const zoneId of ["40.7128,-74.0060", " 51.5 / -0.12 ", "48.85;2.35", "-33.9 151.2"]) {
      assert.deepEqual(admitSensingContribution(input({ zoneId }), NOW), { admitted: false, reason: "zone_looks_like_coordinates" }, zoneId);
    }
    assert.ok(admitSensingContribution(input({ zoneId: "soho-3" }), NOW).admitted);
  });

  it("a TTL past the retention policy is refused naming the POLICY", () => {
    const r = admitSensingContribution(input({ ttlSeconds: SENSING_MAX_TTL_SECONDS + 1 }), NOW);
    assert.deepEqual(r, { admitted: false, reason: "ttl_exceeds_retention_policy" });
  });

  it("an unsupported reduction version is refused", () => {
    assert.deepEqual(admitSensingContribution(input({ reductionVersion: 2 }), NOW), { admitted: false, reason: "reduction_version_unsupported" });
  });

  it("a credential from a future epoch, or one older than the validity window, is refused", () => {
    const current = rotationEpochFor(NOW);
    const future = admitSensingContribution(input({ rotationEpoch: current + 1 }), NOW);
    assert.deepEqual(future, { admitted: false, reason: "credential_epoch_future" });
    const staleEpoch = current - SENSING_ANON_POLICY_V1.credential.validityEpochsBack - 1;
    const staleObserved = staleEpoch * SENSING_ROTATION_PERIOD_SECONDS * 1000 + 1000;
    const stale = admitSensingContribution(input({ rotationEpoch: staleEpoch, observedAtMs: staleObserved }), NOW);
    assert.deepEqual(stale, { admitted: false, reason: "credential_epoch_stale" });
  });

  it("the store's own refusals pass through by name", () => {
    assert.deepEqual(admitSensingContribution(input({ signalBucket: 9 }), NOW), { admitted: false, reason: "signal_bucket_out_of_range" });
    assert.deepEqual(admitSensingContribution(input({ observedAtMs: NOW + 5 * 60_000 }), NOW), { admitted: false, reason: "observed_at_in_future" });
  });

  it("refuses without a policy or input, and never reads a clock", () => {
    assert.deepEqual(admitSensingContribution(input(), NOW, null as never), { admitted: false, reason: "policy_required" });
    assert.deepEqual(admitSensingContribution(null as never, NOW), { admitted: false, reason: "input_required" });
    assert.doesNotMatch(MODULE_TS, /Date\.now\(/);
    assert.doesNotMatch(MODULE_TS, /supabase|getServiceClient|\.from\(|\.rpc\(/);
  });
});

describe("issued sessions — a type and a predicate, no issuer", () => {
  const session = (over: Partial<IssuedContributionSession> = {}): IssuedContributionSession => ({
    sessionId: "s1",
    policy: SENSING_ANON_POLICY_V1,
    startsAt: new Date(NOW - 60_000).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
    revokedAt: null,
    ...over,
  });
  it("active only inside its window and while unrevoked; bad dates are inactive", () => {
    assert.equal(sessionIsActive(session(), NOW), true);
    assert.equal(sessionIsActive(session({ revokedAt: new Date(NOW).toISOString() }), NOW), false);
    assert.equal(sessionIsActive(session(), NOW + 120_000), false);
    assert.equal(sessionIsActive(session(), NOW - 120_000), false);
    assert.equal(sessionIsActive(session({ expiresAt: "not-a-date" }), NOW), false);
  });
  it("nothing in the module issues one — no id generation, no insert", () => {
    assert.doesNotMatch(MODULE_TS, /randomUUID|crypto|\.insert\(/);
  });
  it("the issued type has no field an account, device or installation id could occupy", () => {
    const m = MODULE_TS.match(/export interface IssuedContributionSession \{([\s\S]*?)\n\}/);
    assert.ok(m);
    assert.doesNotMatch(m[1], /user|actor|profile|account|device|installation/i);
  });
});
