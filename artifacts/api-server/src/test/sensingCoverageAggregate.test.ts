/**
 * Behavioural proof for the anonymous sensing store's aggregation.
 *
 * Five properties the owner ruling turns on, each proved against the REAL
 * modules — lib/privacyGate.evaluatePrivacy and lib/intelContracts
 * .PRIVACY_THRESHOLD_V1 are imported, never re-implemented or stubbed, so a
 * change to the shared threshold moves these tests with it:
 *
 *   1. a contribution EXPIRES, and an expired one cannot pad a cohort;
 *   2. revocation works WITHOUT AN IDENTITY;
 *   3. the aggregation REFUSES below the existing privacy threshold;
 *   4. a FAILED read never inflates a cohort;
 *   5. contributors are counted, never rows.
 *
 * No database. Everything here is the pure half of the contract, which is where
 * the counting — the part the privacy gate cannot check for you — actually lives.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PRIVACY_THRESHOLD_V1 } from "../lib/intelContracts.js";
import { evaluatePrivacy } from "../lib/privacyGate.js";
import {
  SENSING_DEFAULT_TTL_SECONDS,
  SENSING_MAX_TTL_SECONDS,
  SENSING_ROTATION_PERIOD_SECONDS,
  applySensingRevocation,
  buildSensingContributionRow,
  deriveEpochSecret,
  isSensingContributionExpired,
  revocationCommitment,
  revocationTargetToken,
  rotationEpochFor,
  sensingCohortKey,
  sensingTimeBucket,
  type SensingContributionRow,
  type SensingReadResult,
} from "../lib/sensingAnonStore.js";
import { aggregateSensingCohort } from "../lib/sensingCoverageAggregate.js";

// Static imports are safe because lib/sensingAnonStore reads the pepper LAZILY,
// inside each derivation, and refuses (throws) rather than falling back to a
// constant — so this assignment lands long before the first call.
process.env.SENSING_CONTRIBUTOR_PEPPER ??= "test-pepper-sensing-anon-store";

// ── Fixture ──────────────────────────────────────────────────────────────────

/** An hour-aligned instant, so the rotation epoch and the time bucket are exact. */
const T0 = Date.UTC(2026, 8, 6, 12, 0, 0);
const EPOCH = rotationEpochFor(T0);
const MINUTE = 60_000;

/** One device: a secret, its epoch secret, and the commitment it would transmit. */
function device(name: string, epoch = EPOCH) {
  const deviceSecret = `device-secret-${name}`;
  const epochSecret = deriveEpochSecret(deviceSecret, epoch);
  return { deviceSecret, epochSecret, commitment: revocationCommitment(epochSecret) };
}

function row(opts: {
  name: string;
  groupTag?: string | null;
  atMs?: number;
  epoch?: number;
  ttlSeconds?: number;
}): SensingContributionRow {
  const epoch = opts.epoch ?? EPOCH;
  const atMs = opts.atMs ?? T0;
  const built = buildSensingContributionRow(
    {
      commitment: device(opts.name, epoch).commitment,
      rotationEpoch: epoch,
      groupTag: opts.groupTag ?? null,
      zoneId: "zone-da-nang-my-khe",
      observedAtMs: atMs,
      signalBucket: 3,
      ttlSeconds: opts.ttlSeconds,
    },
    atMs,
  );
  assert.equal(built.ok, true, `fixture row failed to build: ${built.ok ? "" : built.error}`);
  return (built as { ok: true; row: SensingContributionRow }).row;
}

/** `groups` parties of `perGroup` distinct contributors each, plus `solo` ungrouped. */
function cohort(groups: number, perGroup: number, solo = 0): SensingContributionRow[] {
  const rows: SensingContributionRow[] = [];
  for (let g = 0; g < groups; g++) {
    for (let m = 0; m < perGroup; m++) {
      rows.push(row({ name: `g${g}-m${m}`, groupTag: `party-${g}` }));
    }
  }
  for (let s = 0; s < solo; s++) rows.push(row({ name: `solo-${s}`, groupTag: null }));
  return rows;
}

const okRead = (rows: readonly SensingContributionRow[]): SensingReadResult => ({
  ok: true,
  complete: true,
  rows,
});

/** Evaluated far enough after T0 that the publication delay has elapsed. */
const AFTER_DELAY = T0 + (PRIVACY_THRESHOLD_V1.publicationDelayMinutes + 5) * MINUTE;

// ── 0. The fixture actually publishes, or every refusal below proves nothing ──

describe("sensing aggregation — a well-formed cohort does publish", () => {
  it("20 contributors in 5 parties, none over 20%, after the publication delay", () => {
    const agg = aggregateSensingCohort(okRead(cohort(5, 4)), { nowMs: AFTER_DELAY });
    assert.equal(agg.publishable, true, `expected publishable, got ${agg.reason}`);
    assert.equal(agg.reason, null);
    assert.equal(agg.distinctActors, 20);
    assert.equal(agg.distinctGroups, 5);
    assert.equal(agg.maxGroupShare, 0.2);
  });

  it("routes the SAME numbers through the real gate — the verdicts agree", () => {
    const agg = aggregateSensingCohort(okRead(cohort(5, 4)), { nowMs: AFTER_DELAY });
    const direct = evaluatePrivacy(
      {
        distinctActors: agg.distinctActors,
        distinctGroups: agg.distinctGroups,
        maxGroupShare: agg.maxGroupShare,
        observedAt: agg.observedAt!,
        now: AFTER_DELAY,
      },
      PRIVACY_THRESHOLD_V1,
    );
    assert.equal(agg.publishable, direct.publishable);
    assert.equal(agg.reason, direct.reason);
  });
});

// ── 1. A contribution expires ────────────────────────────────────────────────

describe("sensing aggregation — TTL", () => {
  it("a contribution expires when its TTL runs out", () => {
    const r = row({ name: "a" });
    assert.equal(isSensingContributionExpired(r, T0 + MINUTE), false);
    assert.equal(isSensingContributionExpired(r, T0 + SENSING_DEFAULT_TTL_SECONDS * 1000), true);
    assert.equal(isSensingContributionExpired(r, T0 + SENSING_DEFAULT_TTL_SECONDS * 1000 + MINUTE), true);
  });

  it("an unreadable expiry reads as EXPIRED, not as fresh", () => {
    assert.equal(isSensingContributionExpired({ ...row({ name: "a" }), expires_at: "not-a-date" }, T0), true);
    assert.equal(isSensingContributionExpired({ ...row({ name: "a" }), expires_at: "" }, T0), true);
  });

  it("expired contributions cannot pad a cohort past the threshold", () => {
    const rows = cohort(5, 4);
    const fresh = aggregateSensingCohort(okRead(rows), { nowMs: AFTER_DELAY });
    assert.equal(fresh.publishable, true);

    const afterTtl = T0 + SENSING_DEFAULT_TTL_SECONDS * 1000 + MINUTE;
    const stale = aggregateSensingCohort(okRead(rows), { nowMs: afterTtl });
    assert.equal(stale.publishable, false);
    assert.equal(stale.distinctActors, 0, "an expired row must not be counted");
    assert.equal(stale.contributions, 0);
    assert.equal(stale.reason, "below_actor_threshold");
  });

  it("a mixed cohort counts only the unexpired half", () => {
    const shortTtl = 60 * 60; // one hour
    const rows = [
      ...cohort(5, 4),
      ...Array.from({ length: 40 }, (_, i) => row({ name: `expiring-${i}`, groupTag: "party-x", ttlSeconds: shortTtl })),
    ];
    const later = T0 + 2 * 60 * MINUTE; // past the one-hour TTL, inside the 24h one
    const agg = aggregateSensingCohort(okRead(rows), { nowMs: later });
    assert.equal(agg.distinctActors, 20, "the 40 expired contributors must be gone");
    assert.equal(agg.distinctGroups, 5, "the expired party must not be counted as a group");
  });

  it("the TTL ceiling is refused before the round trip", () => {
    const tooLong = buildSensingContributionRow(
      {
        commitment: device("a").commitment,
        rotationEpoch: EPOCH,
        zoneId: "z",
        observedAtMs: T0,
        signalBucket: 1,
        ttlSeconds: SENSING_MAX_TTL_SECONDS + 1,
      },
      T0,
    );
    assert.equal(tooLong.ok, false);
    assert.equal((tooLong as { ok: false; error: string }).error, "ttl_exceeds_maximum");
  });
});

// ── 2. Revocation without an identity ────────────────────────────────────────

describe("sensing revocation — no identity is ever presented", () => {
  it("the revocation input has exactly two fields, neither an identity", () => {
    const d = device("a");
    const revocation = { rotationEpoch: EPOCH, epochSecret: d.epochSecret };
    assert.deepEqual(Object.keys(revocation).sort(), ["epochSecret", "rotationEpoch"]);
    // Belt and braces: nothing account-shaped appears anywhere in the request.
    const serialized = JSON.stringify(revocation);
    for (const forbidden of ["user", "actor", "profile", "account", "device", "session", "auth"]) {
      assert.ok(!serialized.toLowerCase().includes(forbidden), `revocation leaked "${forbidden}"`);
    }
  });

  it("a device revokes its own contributions by revealing only its epoch secret", () => {
    const mine = device("mine");
    const rows = [
      ...cohort(5, 4),
      row({ name: "mine", groupTag: "party-0" }),
      row({ name: "mine", groupTag: "party-0", atMs: T0 + MINUTE }),
      row({ name: "mine", groupTag: "party-0", atMs: T0 + 2 * MINUTE }),
    ];
    assert.equal(new Set(rows.map((r) => r.contributor_token)).size, 21);

    const after = applySensingRevocation(rows, { rotationEpoch: EPOCH, epochSecret: mine.epochSecret });
    assert.equal(after.length, rows.length - 3, "all three of this device's rows must go");
    assert.equal(new Set(after.map((r) => r.contributor_token)).size, 20, "and nobody else's");
  });

  it("the revocation target is derivable from the secret ALONE — no lookup, no id", () => {
    const mine = device("mine");
    const r = row({ name: "mine" });
    assert.equal(
      revocationTargetToken({ rotationEpoch: EPOCH, epochSecret: mine.epochSecret }),
      r.contributor_token,
    );
  });

  it("another device's secret revokes nothing", () => {
    const rows = [...cohort(5, 4), row({ name: "mine" })];
    const after = applySensingRevocation(rows, {
      rotationEpoch: EPOCH,
      epochSecret: device("someone-else").epochSecret,
    });
    assert.equal(after.length, rows.length);
  });

  it("knowing a stored token is NOT enough to revoke — the preimage is required", () => {
    const mine = device("mine");
    const r = row({ name: "mine" });
    // An attacker holding only what the table stores tries it as the secret.
    const attacker = applySensingRevocation([r], {
      rotationEpoch: EPOCH,
      epochSecret: r.contributor_token,
    });
    assert.equal(attacker.length, 1, "a stored token must not authorise its own deletion");
    // And the commitment (the only thing transmitted) is equally useless.
    const withCommitment = applySensingRevocation([r], {
      rotationEpoch: EPOCH,
      epochSecret: mine.commitment,
    });
    assert.equal(withCommitment.length, 1);
  });

  it("revoking one epoch reveals nothing about, and does not erase, another", () => {
    const nextEpoch = EPOCH + 1;
    const atNext = (nextEpoch + 0.25) * SENSING_ROTATION_PERIOD_SECONDS * 1000;
    const now = row({ name: "mine" });
    const next = row({ name: "mine", epoch: nextEpoch, atMs: atNext });
    assert.notEqual(now.contributor_token, next.contributor_token, "the id must ROTATE across epochs");

    const after = applySensingRevocation([now, next], {
      rotationEpoch: EPOCH,
      epochSecret: device("mine").epochSecret,
    });
    assert.deepEqual(after.map((r) => r.contributor_token), [next.contributor_token]);
  });

  it("revocation shrinks the cohort it contributed to", () => {
    const rows = [...cohort(5, 4), ...Array.from({ length: 4 }, (_, i) => row({ name: `extra-${i}`, groupTag: "party-5" }))];
    const before = aggregateSensingCohort(okRead(rows), { nowMs: AFTER_DELAY });
    assert.equal(before.distinctActors, 24);
    assert.equal(before.distinctGroups, 6);

    let remaining = rows;
    for (let i = 0; i < 4; i++) {
      remaining = applySensingRevocation(remaining, {
        rotationEpoch: EPOCH,
        epochSecret: device(`extra-${i}`).epochSecret,
      });
    }
    const after = aggregateSensingCohort(okRead(remaining), { nowMs: AFTER_DELAY });
    assert.equal(after.distinctActors, 20);
    assert.equal(after.distinctGroups, 5, "the emptied party must stop counting as a group");
  });
});

// ── 3. The aggregation refuses below the existing privacy threshold ──────────

describe("sensing aggregation — refuses below the SHARED privacy threshold", () => {
  it("too few contributors", () => {
    const agg = aggregateSensingCohort(okRead(cohort(7, 2)), { nowMs: AFTER_DELAY });
    assert.equal(agg.distinctActors, 14);
    assert.ok(agg.distinctActors < PRIVACY_THRESHOLD_V1.minUniqueActors);
    assert.equal(agg.publishable, false);
    assert.equal(agg.reason, "below_actor_threshold");
  });

  it("enough contributors, too few independent parties", () => {
    const agg = aggregateSensingCohort(okRead(cohort(4, 5)), { nowMs: AFTER_DELAY });
    assert.equal(agg.distinctActors, 20);
    assert.equal(agg.distinctGroups, 4);
    assert.ok(agg.distinctGroups < PRIVACY_THRESHOLD_V1.minIndependentGroups);
    assert.equal(agg.publishable, false);
    assert.equal(agg.reason, "below_group_threshold");
  });

  it("one party dominates the cohort", () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => row({ name: `big-${i}`, groupTag: "party-big" })),
      ...cohort(4, 3),
    ];
    const agg = aggregateSensingCohort(okRead(rows), { nowMs: AFTER_DELAY });
    assert.equal(agg.distinctActors, 20);
    assert.equal(agg.distinctGroups, 5);
    assert.ok(agg.maxGroupShare > PRIVACY_THRESHOLD_V1.maxSingleGroupShare);
    assert.equal(agg.publishable, false);
    assert.equal(agg.reason, "single_group_dominates");
  });

  it("an ungrouped crowd earns NO group credit — separate contributors are not separate parties", () => {
    const agg = aggregateSensingCohort(okRead(cohort(0, 0, 40)), { nowMs: AFTER_DELAY });
    assert.equal(agg.distinctActors, 40);
    assert.equal(agg.distinctGroups, 0);
    assert.equal(agg.maxGroupShare, 0);
    assert.equal(agg.publishable, false);
    assert.equal(agg.reason, "below_group_threshold");
  });

  it("a cohort that has only just formed is held back by the publication delay", () => {
    const agg = aggregateSensingCohort(okRead(cohort(5, 4)), { nowMs: T0 + MINUTE });
    assert.equal(agg.publishable, false);
    assert.equal(agg.reason, "publication_delay_not_elapsed");
  });

  it("the delay is measured from the FRESHEST arrival, so a live cohort cannot publish", () => {
    // The cohort would otherwise publish at this instant: 20 contributors, five
    // parties, none over 20%, and the original arrivals are well past the delay.
    // The one late arrival is deliberately ungrouped so it moves NO other clause,
    // isolating the publication delay as the only thing that can refuse.
    const settled = aggregateSensingCohort(okRead(cohort(5, 4)), { nowMs: AFTER_DELAY + MINUTE });
    assert.equal(settled.publishable, true, "premise: without the latecomer this cohort publishes");

    const rows = [...cohort(5, 4), row({ name: "latecomer", groupTag: null, atMs: AFTER_DELAY })];
    const agg = aggregateSensingCohort(okRead(rows), { nowMs: AFTER_DELAY + MINUTE });
    assert.equal(agg.distinctActors, 21);
    assert.equal(agg.maxGroupShare, 0.2, "the ungrouped latecomer moves no group clause");
    assert.equal(agg.publishable, false);
    assert.equal(agg.reason, "publication_delay_not_elapsed");
  });

  it("a sensitive subject is refused before any arithmetic", () => {
    const agg = aggregateSensingCohort(okRead(cohort(10, 10)), { nowMs: AFTER_DELAY, sensitiveSubject: true });
    assert.equal(agg.publishable, false);
    assert.equal(agg.reason, "sensitive_subject");
  });

  it("an empty cohort refuses on the actor threshold, not on a malformed input", () => {
    const agg = aggregateSensingCohort(okRead([]), { nowMs: AFTER_DELAY });
    assert.equal(agg.publishable, false);
    assert.equal(agg.reason, "below_actor_threshold");
    assert.equal(agg.observedAt, null);
  });
});

// ── 4. A failed read never inflates a cohort ─────────────────────────────────

describe("sensing aggregation — a failed read never inflates a cohort", () => {
  it("a read error counts NOTHING, however large a count the transport claims", () => {
    const agg = aggregateSensingCohort(
      { ok: false, complete: false, rows: [], error: "connection reset", reportedCount: 900 },
      { nowMs: AFTER_DELAY },
    );
    assert.equal(agg.publishable, false);
    assert.equal(agg.reason, "read_failed");
    assert.equal(agg.distinctActors, 0, "the transport's count must never become a cohort size");
    assert.equal(agg.distinctGroups, 0);
    assert.equal(agg.maxGroupShare, 0);
    assert.equal(agg.contributions, 0);
  });

  it("a failure that still carries rows counts none of them", () => {
    const agg = aggregateSensingCohort(
      { ok: false, complete: false, rows: cohort(5, 4), error: "partial failure", reportedCount: 20 },
      { nowMs: AFTER_DELAY },
    );
    assert.equal(agg.reason, "read_failed");
    assert.equal(agg.distinctActors, 0);
  });

  it("an INCOMPLETE read is refused, not aggregated — a truncated page is not a cohort", () => {
    const agg = aggregateSensingCohort({ ok: true, complete: false, rows: cohort(5, 4) }, { nowMs: AFTER_DELAY });
    assert.equal(agg.publishable, false);
    assert.equal(agg.reason, "read_incomplete");
    assert.equal(agg.distinctActors, 0);
  });

  it("'could not look' and 'too few people' are never the same answer", () => {
    const failed = aggregateSensingCohort(
      { ok: false, complete: false, rows: [], error: "boom", reportedCount: null },
      { nowMs: AFTER_DELAY },
    );
    const empty = aggregateSensingCohort(okRead([]), { nowMs: AFTER_DELAY });
    assert.notEqual(failed.reason, empty.reason);
  });

  it("a truncated read cannot understate a dominant party into publishability", () => {
    // The first 20 rows look like five balanced parties; the unread tail is one
    // party of 40. Counting the page would publish; refusing does not.
    const visible = cohort(5, 4);
    const agg = aggregateSensingCohort({ ok: true, complete: false, rows: visible }, { nowMs: AFTER_DELAY });
    assert.equal(agg.publishable, false);
    assert.equal(agg.reason, "read_incomplete");
  });
});

// ── 5. Contributors, never rows ──────────────────────────────────────────────

describe("sensing aggregation — counts contributors, never rows", () => {
  it("one device submitting forty readings is one contributor", () => {
    const rows = Array.from({ length: 40 }, (_, i) => row({ name: "chatty", groupTag: "party-0", atMs: T0 + i * 1000 }));
    const agg = aggregateSensingCohort(okRead(rows), { nowMs: AFTER_DELAY });
    assert.equal(agg.contributions, 40);
    assert.equal(agg.distinctActors, 1);
    assert.equal(agg.publishable, false);
    assert.equal(agg.reason, "below_actor_threshold");
  });

  it("a contributor in several parties cannot dilute the dominant party's share", () => {
    // 5 parties of 4. One contributor from the big party also appears in each of
    // the others; the union denominator keeps the share honest.
    const rows = cohort(5, 4);
    for (let g = 1; g < 5; g++) rows.push(row({ name: "g0-m0", groupTag: `party-${g}` }));
    const agg = aggregateSensingCohort(okRead(rows), { nowMs: AFTER_DELAY });
    assert.equal(agg.distinctActors, 20, "the shared contributor is still ONE person");
    assert.equal(agg.distinctGroups, 5);
    assert.equal(agg.maxGroupShare, 0.25, "5 of the 20 grouped contributors, not 5 of 24");
    assert.equal(agg.reason, "single_group_dominates");
  });

  it("a tokenless row is not a countable contributor", () => {
    const rows = [...cohort(5, 4), { ...row({ name: "ghost" }), contributor_token: "" }];
    const agg = aggregateSensingCohort(okRead(rows), { nowMs: AFTER_DELAY });
    assert.equal(agg.distinctActors, 20);
  });
});

// ── Rotation and cohort keying ───────────────────────────────────────────────

describe("sensing rotation and cohort keying", () => {
  it("rotation is a whole multiple of the privacy time bucket — a cohort never straddles it", () => {
    const bucketSeconds = PRIVACY_THRESHOLD_V1.timeBucketMinutes * 60;
    assert.equal(
      SENSING_ROTATION_PERIOD_SECONDS % bucketSeconds,
      0,
      "a bucket straddling a rotation boundary would split one contributor into two and INFLATE the count",
    );
  });

  it("the same device is one token within an epoch and a different one across epochs", () => {
    const within = row({ name: "d", atMs: T0 + 20 * MINUTE });
    const same = row({ name: "d", atMs: T0 + 40 * MINUTE });
    assert.equal(within.contributor_token, same.contributor_token);

    const nextEpoch = EPOCH + 1;
    const later = row({ name: "d", epoch: nextEpoch, atMs: (nextEpoch + 0.5) * SENSING_ROTATION_PERIOD_SECONDS * 1000 });
    assert.notEqual(within.contributor_token, later.contributor_token);
  });

  it("a contribution cannot claim an epoch it was not sensed in", () => {
    const built = buildSensingContributionRow(
      { commitment: device("d").commitment, rotationEpoch: EPOCH + 5, zoneId: "z", observedAtMs: T0, signalBucket: 1 },
      T0,
    );
    assert.equal(built.ok, false);
    assert.equal((built as { ok: false; error: string }).error, "epoch_does_not_match_observation");
  });

  it("the time bucket floors the instant — the precise moment is never stored", () => {
    const bucket = sensingTimeBucket(T0 + 17 * MINUTE + 43_000);
    assert.equal(bucket, new Date(T0).toISOString());
    assert.equal(sensingTimeBucket(T0 + 31 * MINUTE), new Date(T0 + 30 * MINUTE).toISOString());
  });

  it("the cohort key is canonical, so writer and reader cannot disagree", () => {
    const bucket = sensingTimeBucket(T0);
    assert.equal(sensingCohortKey("Zone-A", bucket), sensingCohortKey("  zone-a ", bucket));
    assert.notEqual(sensingCohortKey("zone-a", bucket), sensingCohortKey("zone-b", bucket));
    assert.notEqual(sensingCohortKey("zone-a", bucket, 1), sensingCohortKey("zone-a", bucket, 2));
  });

  it("the stored row carries no coordinate, no identity and no claim", () => {
    const r = row({ name: "d", groupTag: "party-0" });
    const keys = Object.keys(r).sort();
    assert.deepEqual(keys, [
      "cohort_key",
      "contributor_token",
      "created_at",
      "expires_at",
      "group_token",
      "reduction_version",
      "rotation_epoch",
      "signal_bucket",
      "time_bucket",
      "zone_id",
    ]);
    const serialized = JSON.stringify(r).toLowerCase();
    for (const forbidden of ["lat", "lng", "user_id", "actor_id", "profile", "claim", "status", "snapshot"]) {
      assert.ok(!serialized.includes(forbidden), `the row leaked "${forbidden}"`);
    }
  });

  it("the ordinal band is enforced", () => {
    for (const bucketValue of [-1, 5, 1.5]) {
      const built = buildSensingContributionRow(
        { commitment: device("d").commitment, rotationEpoch: EPOCH, zoneId: "z", observedAtMs: T0, signalBucket: bucketValue },
        T0,
      );
      assert.equal(built.ok, false, `signalBucket ${bucketValue} must be refused`);
    }
  });
});
