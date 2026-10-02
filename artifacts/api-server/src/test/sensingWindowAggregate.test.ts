/**
 * sensingWindowAggregate — the S42/S52 producer, red-proofed.
 *
 * The point of this file is not that the arithmetic works. It is that the four
 * properties the module's privacy argument RESTS on are each provable by a case
 * that fails when the property is removed. Each is labelled Wn and the mutation
 * that turns it red is named in the case itself, because a control nobody has
 * watched go red is indistinguishable from no control.
 *
 *   W1  a sub-k bucket contributes NOTHING — not a rate, not coverage, not dwell
 *   W2  a broken pair yields NULL rates, never 0: "no coverage ≠ quiet"
 *   W3  no contributor token, set or count-of-one survives onto the result
 *   W4  a single arrival cannot move the rate by more than 1/k
 *   W5  a failed read is not an empty bucket
 *   W6  non-adjacent buckets are refused rather than averaged across the gap
 *   W7  the four unsupported features stay NULL, and the engine answers
 *       accordingly: sociality and momentum real, energy and dance unknown
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/sensingWindowAggregate.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  aggregateSensingWindow,
  asVenueContext,
  inferVibeForWindow,
  sensingWindowCohortKeys,
  windowToVibeFeatures,
  type SensingWindowInput,
} from "../lib/sensingWindowAggregate.js";
import type { SensingContributionRow, SensingReadResult } from "../lib/sensingAnonStore.js";
import { PRIVACY_THRESHOLD_V1 } from "../lib/intelContracts.js";

const K = PRIVACY_THRESHOLD_V1.minUniqueActors;          // 15
const G = PRIVACY_THRESHOLD_V1.minIndependentGroups;     // 5
const WIDTH_MIN = PRIVACY_THRESHOLD_V1.timeBucketMinutes; // 30

const NOW = Date.parse("2026-09-25T12:00:00.000Z");
const HOUR = 3_600_000;

/**
 * A bucket floor `i` widths before `NOW`, newest first when i = 0 — plus a
 * LAG of two widths, because `PRIVACY_THRESHOLD_V1.publicationDelayMinutes`
 * refuses a cohort whose freshest arrival is less than ten minutes old. That
 * delay is a real control (it stops a contribution being published while the
 * contributor is still standing there), so these fixtures respect it rather
 * than dodge it; the case below proves it is still enforced.
 */
const LAG = 2;
const bucketAt = (i: number) => new Date(NOW - (i + LAG) * WIDTH_MIN * 60_000).toISOString();

/**
 * Build one cohort that PASSES the gate: `n` contributors spread over `G`
 * groups so no group holds more than the permitted share. Tokens are supplied
 * so a caller can make two buckets overlap exactly as much as it wants.
 */
function cohort(tokens: readonly string[], opts: { bucket: string; signal?: number } ): SensingReadResult {
  // Enough groups that the LARGEST one stays within maxSingleGroupShare. G
  // groups is only sufficient when n divides evenly: 26 contributors over 5
  // groups leaves one group of 6, which is 0.23 and is correctly refused. The
  // fixture adds groups until the largest is within the share, because a cohort
  // that passes the gate is the PREMISE of these cases, not the thing under
  // test — the cases that exercise the gate build their cohorts explicitly.
  const n = tokens.length;
  const cap = Math.floor(n * PRIVACY_THRESHOLD_V1.maxSingleGroupShare);
  const groups = Math.max(G, cap > 0 ? Math.ceil(n / cap) : G);
  const rows: SensingContributionRow[] = tokens.map((t, idx) => ({
    contributor_token: t,
    rotation_epoch: 1,
    group_token: `g${idx % groups}`,
    zone_id: "zone-A",
    time_bucket: opts.bucket,
    cohort_key: `v1|zone-a|${opts.bucket}`,
    signal_bucket: opts.signal ?? 2,
    reduction_version: 1,
    created_at: opts.bucket,
    expires_at: new Date(NOW + HOUR).toISOString(),
  }));
  return { ok: true, complete: true, rows };
}

const tokens = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => `tok-${from + i}`);

/** Two adjacent, k-passing buckets with a controllable overlap. */
function twoBuckets(prevTokens: readonly string[], curTokens: readonly string[]): SensingWindowInput[] {
  return [
    { timeBucket: bucketAt(1), read: cohort(prevTokens, { bucket: bucketAt(1) }) },
    { timeBucket: bucketAt(0), read: cohort(curTokens, { bucket: bucketAt(0) }) },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────

describe("the premise — a k-passing pair produces real rates", () => {
  it("counts the pair and buckets coverage from DISTINCT CONTRIBUTORS", () => {
    // 20 carried over, 5 new, 5 gone: union 30, arrivals 5, departures 5.
    const prev = tokens(0, 25);
    const cur = [...tokens(5, 20), ...tokens(100, 5)];
    const w = aggregateSensingWindow(twoBuckets(prev, cur), { nowMs: NOW, timeBucketMinutes: WIDTH_MIN });

    assert.equal(w.reason, null);
    assert.equal(w.bucketsPublishable, 2, "premise: both buckets pass the gate");
    assert.equal(w.pairsCounted, 1);
    assert.equal(w.arrivalVelocity, 5 / 30);
    assert.equal(w.departureVelocity, 5 / 30);
    // 30 distinct contributors across the window -> `several` (25..99).
    assert.equal(w.coverage, "several");
  });

  it("momentum is arrivals minus departures, and it survives to the engine", () => {
    const prev = tokens(0, 20);                       // all 20 stay
    const cur = [...tokens(0, 20), ...tokens(50, 10)]; // plus 10 arrivals
    const r = inferVibeForWindow(twoBuckets(prev, cur), null, { nowMs: NOW, timeBucketMinutes: WIDTH_MIN });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.window.arrivalVelocity, 10 / 30);
    assert.equal(r.window.departureVelocity, 0);
    assert.ok((r.state.momentum ?? 0) > 0, "arrivals outnumber departures, so momentum is positive");
  });
});

describe("W1 — a sub-k bucket contributes NOTHING", () => {
  /**
   * MUTATION THAT TURNS THIS RED: count a bucket the gate refused. Drop the
   * `if (!decision.publishable) { tokenSets.push(null); continue; }` guard in
   * aggregateSensingWindow and the three people below are counted, the pair is
   * formed, and a rate about three identifiable people is published.
   */
  it("neither its people nor its rate reach the result", () => {
    const tiny = tokens(900, 3);
    const inputs: SensingWindowInput[] = [
      { timeBucket: bucketAt(1), read: cohort(tiny, { bucket: bucketAt(1) }) },
      { timeBucket: bucketAt(0), read: cohort(tokens(0, 25), { bucket: bucketAt(0) }) },
    ];
    const w = aggregateSensingWindow(inputs, { nowMs: NOW, timeBucketMinutes: WIDTH_MIN });

    assert.equal(w.bucketsSupplied, 2);
    assert.equal(w.bucketsPublishable, 1, "the three-person bucket was refused");
    assert.equal(w.pairsCounted, 0, "a pair needs BOTH buckets to have passed");
    assert.equal(w.arrivalVelocity, null);
    assert.equal(w.departureVelocity, null);
    // Coverage counts only the surviving bucket's 25, never 28.
    assert.equal(w.coverage, "several");
    const json = JSON.stringify(w);
    for (const t of tiny) assert.ok(!json.includes(t), `the refused bucket's token ${t} must not appear`);
  });

  it("every bucket refused means no features at all, and it says why", () => {
    const inputs: SensingWindowInput[] = [
      { timeBucket: bucketAt(1), read: cohort(tokens(900, 3), { bucket: bucketAt(1) }) },
      { timeBucket: bucketAt(0), read: cohort(tokens(910, 4), { bucket: bucketAt(0) }) },
    ];
    const w = aggregateSensingWindow(inputs, { nowMs: NOW, timeBucketMinutes: WIDTH_MIN });
    assert.equal(w.reason, "no_publishable_bucket");
    assert.equal(w.coverage, "unknown");
    assert.equal(w.dwellBucket, null);
    assert.equal(w.medianSignalBucket, null);
    // The per-bucket decisions are still reported, so an operator can see the
    // gate refused rather than that the world was empty.
    assert.equal(w.buckets.length, 2);
    assert.ok(w.buckets.every((b) => b.publishable === false));
  });
});

describe("W2 — a broken pair is NULL, never zero", () => {
  /**
   * MUTATION THAT TURNS THIS RED: `arrivalVelocity: pairs === 0 ? 0 : …`.
   * Zero means "nobody arrived", which is a claim about the world; null means
   * "we could not look", which is a claim about us. §2's "no coverage ≠ quiet"
   * is exactly this distinction, and it only survives if the type does.
   */
  it("an unpublishable neighbour yields null rates, and null is not 0", () => {
    const inputs: SensingWindowInput[] = [
      { timeBucket: bucketAt(1), read: cohort(tokens(900, 2), { bucket: bucketAt(1) }) },
      { timeBucket: bucketAt(0), read: cohort(tokens(0, 25), { bucket: bucketAt(0) }) },
    ];
    const w = aggregateSensingWindow(inputs, { nowMs: NOW, timeBucketMinutes: WIDTH_MIN });
    assert.equal(w.arrivalVelocity, null);
    assert.notEqual(w.arrivalVelocity, 0);
    // And the engine must carry the unknown through rather than inventing calm.
    const f = windowToVibeFeatures(w, null);
    assert.equal(f.arrivalVelocity, null);
    assert.equal(f.departureVelocity, null);
    const r = inferVibeForWindow(inputs, null, { nowMs: NOW, timeBucketMinutes: WIDTH_MIN });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.state.momentum, null, "unknown movement is unknown momentum, not stillness");
    assert.equal(r.state.volatility, null);
  });
});

describe("W3 — nothing identifying survives onto the result", () => {
  /**
   * MUTATION THAT TURNS THIS RED: add `contributorTokens` (or any per-person
   * field) to SensingWindowFeatures. The module must hold tokens to difference
   * them; the whole safety argument is that they do not come back out.
   */
  it("no contributor token appears anywhere in the returned value", () => {
    const prev = tokens(0, 25);
    const cur = [...tokens(5, 20), ...tokens(300, 6)];
    const w = aggregateSensingWindow(twoBuckets(prev, cur), { nowMs: NOW, timeBucketMinutes: WIDTH_MIN });
    const json = JSON.stringify(w);
    for (const t of [...prev, ...cur]) {
      assert.ok(!json.includes(t), `token ${t} leaked onto the window result`);
    }
    assert.ok(!json.includes("g0"), "a group token must not leak either");
  });

  it("the shape carries no per-contributor field at all", () => {
    const w = aggregateSensingWindow(twoBuckets(tokens(0, 25), tokens(0, 25)), {
      nowMs: NOW,
      timeBucketMinutes: WIDTH_MIN,
    });
    for (const key of Object.keys(w)) {
      assert.ok(
        !/token|actor|contributor(?!s$)|device|user|profile/i.test(key) || key === "bucketsPublishable",
        `field ${key} names a person-shaped thing`,
      );
    }
  });
});

describe("W4 — one arrival cannot move the rate by more than 1/k", () => {
  /**
   * MUTATION THAT TURNS THIS RED: use `cur.size` (or the smaller set) as the
   * denominator instead of the UNION. A small current bucket next to a large
   * previous one would then let one person swing the rate arbitrarily.
   */
  it("the denominator is the UNION, named exactly, not the smaller of the two buckets", () => {
    // Deliberately LOPSIDED: 40 before, 16 after (15 of them carried over plus
    // one arrival). union 41, current 16. Asserting the bound alone would not
    // catch `cur.size` here — 1/16 is still under 1/k — so the denominator is
    // named outright. A rate whose denominator can shrink toward k is a rate
    // one person can move, and lopsided windows are the normal case at the
    // edges of an evening.
    const prev = tokens(0, 40);
    const cur = [...tokens(0, 15), "tok-one-more"];
    const w = aggregateSensingWindow(twoBuckets(prev, cur), { nowMs: NOW, timeBucketMinutes: WIDTH_MIN });
    assert.equal(w.bucketsPublishable, 2, "premise: both buckets pass the gate");
    assert.equal(w.pairsCounted, 1);
    assert.equal(w.arrivalVelocity, 1 / 41, "one arrival over the union of 41");
    assert.equal(w.departureVelocity, 25 / 41, "25 of the 40 were not seen again");
  });

  it("and the quantum a single arrival can move is at most 1/k", () => {
    const base = tokens(0, K);
    const a = aggregateSensingWindow(twoBuckets(base, base), { nowMs: NOW, timeBucketMinutes: WIDTH_MIN });
    const b = aggregateSensingWindow(twoBuckets(base, [...base, "tok-one-more"]), {
      nowMs: NOW,
      timeBucketMinutes: WIDTH_MIN,
    });
    assert.equal(a.pairsCounted, 1);
    assert.equal(b.pairsCounted, 1);
    const delta = Math.abs((b.arrivalVelocity ?? 0) - (a.arrivalVelocity ?? 0));
    assert.ok(delta <= 1 / K + 1e-12, `one arrival moved the rate by ${delta}, more than 1/${K}`);
  });
});

describe("W5 — a failed read is not an empty bucket", () => {
  /**
   * MUTATION THAT TURNS THIS RED: treat `{ ok: false }` as zero rows. The
   * window would then report a confident "everybody left" during an outage.
   */
  it("a read that failed is refused, and a read that was truncated is too", () => {
    const failed: SensingReadResult = {
      ok: false, complete: false, rows: [], error: "boom", reportedCount: 4000,
    };
    const truncated: SensingReadResult = {
      ok: true, complete: false, rows: cohort(tokens(0, 25), { bucket: bucketAt(0) }).rows,
    };
    const w = aggregateSensingWindow(
      [
        { timeBucket: bucketAt(1), read: failed },
        { timeBucket: bucketAt(0), read: truncated },
      ],
      { nowMs: NOW, timeBucketMinutes: WIDTH_MIN },
    );
    assert.equal(w.reason, "no_publishable_bucket");
    assert.equal(w.buckets[0]?.reason, "read_failed");
    assert.equal(w.buckets[1]?.reason, "read_incomplete");
    assert.equal(w.arrivalVelocity, null);
    assert.equal(w.departureVelocity, null);
  });
});

describe("W6 — buckets must actually be adjacent", () => {
  /**
   * MUTATION THAT TURNS THIS RED: drop the contiguity loop. A "rate" between
   * two buckets four hours apart is not a rate, and averaging across a gap
   * reports movement that no pair of neighbours ever showed.
   */
  it("a gap of more than one width is refused outright", () => {
    const inputs: SensingWindowInput[] = [
      { timeBucket: bucketAt(8), read: cohort(tokens(0, 25), { bucket: bucketAt(8) }) },
      { timeBucket: bucketAt(0), read: cohort(tokens(0, 25), { bucket: bucketAt(0) }) },
    ];
    const w = aggregateSensingWindow(inputs, { nowMs: NOW, timeBucketMinutes: WIDTH_MIN });
    assert.equal(w.reason, "buckets_not_contiguous");
    assert.equal(w.pairsCounted, 0);
  });

  it("out-of-order or duplicate buckets are refused, not sorted", () => {
    const inputs: SensingWindowInput[] = [
      { timeBucket: bucketAt(0), read: cohort(tokens(0, 25), { bucket: bucketAt(0) }) },
      { timeBucket: bucketAt(1), read: cohort(tokens(0, 25), { bucket: bucketAt(1) }) },
    ];
    assert.equal(
      aggregateSensingWindow(inputs, { nowMs: NOW, timeBucketMinutes: WIDTH_MIN }).reason,
      "buckets_not_contiguous",
    );
  });

  it("the cohort keys a window needs come from the writer's own key function", () => {
    const keys = sensingWindowCohortKeys("zone-A", NOW, 3, WIDTH_MIN);
    assert.equal(keys.length, 3);
    // oldest first, exactly one width apart
    const ts = keys.map((k) => Date.parse(k.timeBucket));
    assert.equal(ts[1]! - ts[0]!, WIDTH_MIN * 60_000);
    assert.equal(ts[2]! - ts[1]!, WIDTH_MIN * 60_000);
    // and they are accepted by the window itself
    const inputs = keys.map((k) => ({
      timeBucket: k.timeBucket,
      read: cohort(tokens(0, 25), { bucket: k.timeBucket }),
    }));
    assert.equal(aggregateSensingWindow(inputs, { nowMs: NOW, timeBucketMinutes: WIDTH_MIN }).reason, null);
  });
});

describe("W7 — the four unsupported features stay unknown", () => {
  /**
   * MUTATION THAT TURNS THIS RED: set `motionEnergy: (median ?? 0) / 4` or
   * `density: window.coverage` in windowToVibeFeatures. Either one publishes a
   * number the anonymous store cannot support: the first assigns a meaning to
   * `signal_bucket` that `reduction_version` has not pinned, the second renders
   * "we have a lot of data" as "a lot of people are here".
   */
  it("motionEnergy, periodicity, density and acoustic energy are all null", () => {
    const w = aggregateSensingWindow(twoBuckets(tokens(0, 25), tokens(0, 25)), {
      nowMs: NOW,
      timeBucketMinutes: WIDTH_MIN,
    });
    const f = windowToVibeFeatures(w, "nightlife");
    assert.equal(f.motionEnergy, null);
    assert.equal(f.periodicity, null);
    assert.equal(f.density, null);
    assert.equal(f.acousticEnergy, null);
    assert.equal(f.acousticPermissionGranted, false);
    // the median ordinal is carried OUT rather than interpreted
    assert.equal(w.medianSignalBucket, 2);
    // `Object.keys` rather than a cast: `w as Record<string, unknown>` is a
    // TS2352 because the two types do not overlap, and the point of that
    // diagnostic is the same point this assertion makes — SensingWindowFeatures
    // has no such field. Asserting it through a cast that TypeScript rejects
    // would be proving it by silencing the compiler that already knows.
    assert.ok(!Object.keys(w).includes("motionEnergy"));
  });

  it("so the engine answers sociality and momentum, and NOT energy or dance", () => {
    const prev = tokens(0, 25);
    const cur = [...tokens(0, 25), ...tokens(400, 5)];
    const r = inferVibeForWindow(twoBuckets(prev, cur), "nightlife", {
      nowMs: NOW,
      timeBucketMinutes: WIDTH_MIN,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.state.energy, null, "no motion source, so no energy — not zero energy");
    assert.equal(r.state.danceLikelihood, null, "a nightlife tag is a nudge, never a source of evidence");
    assert.ok(r.state.sociality !== null);
    assert.ok(r.state.momentum !== null);
    assert.equal(r.state.truth.truthClass, "inferred");
    assert.equal(r.state.truth.coverage, "several");
    assert.deepEqual([...r.state.contextTags], ["nightlife"]);
  });

  it("an off-vocabulary venue context becomes unknown rather than a default", () => {
    assert.equal(asVenueContext("venue"), null, "geo_zones.zone_type is not a VenueContext");
    assert.equal(asVenueContext("neighborhood"), null);
    assert.equal(asVenueContext(null), null);
    assert.equal(asVenueContext("nightlife"), "nightlife");
    assert.equal(asVenueContext("none"), "none");
  });
});

describe("dwell is derived from presence across buckets, and only where there is evidence", () => {
  it("a contributor in both buckets dwells; boundedMovement is true, never false", () => {
    const base = tokens(0, 25);
    const w = aggregateSensingWindow(twoBuckets(base, base), { nowMs: NOW, timeBucketMinutes: WIDTH_MIN });
    assert.equal(w.dwellBucket, 1, "seen in 2 of 2 buckets");
    assert.equal(w.boundedMovement, true);
  });

  it("a fully-replaced cohort claims NO bounded movement rather than claiming transit", () => {
    const w = aggregateSensingWindow(twoBuckets(tokens(0, 25), tokens(500, 25)), {
      nowMs: NOW,
      timeBucketMinutes: WIDTH_MIN,
    });
    assert.equal(w.dwellBucket, 0, "nobody was seen twice");
    assert.equal(w.boundedMovement, null, "null, not false — one sighting does not prove transit");
    // and `false` is load-bearing in the engine, so never emitting it matters
    const f = windowToVibeFeatures(w, null);
    assert.notEqual(f.boundedMovement, false);
  });

  it("expired rows are dropped before anyone is counted", () => {
    const stale = cohort(tokens(0, 25), { bucket: bucketAt(1) });
    const expired: SensingReadResult = {
      ok: true,
      complete: true,
      rows: stale.rows.map((r) => ({ ...r, expires_at: new Date(NOW - 1).toISOString() })),
    };
    const w = aggregateSensingWindow(
      [
        { timeBucket: bucketAt(1), read: expired },
        { timeBucket: bucketAt(0), read: cohort(tokens(0, 25), { bucket: bucketAt(0) }) },
      ],
      { nowMs: NOW, timeBucketMinutes: WIDTH_MIN },
    );
    assert.equal(w.bucketsPublishable, 1, "an all-expired cohort cannot pass the gate");
    assert.equal(w.pairsCounted, 0);
  });
});

describe("degenerate input", () => {
  it("no buckets is a named refusal, not a crash", () => {
    const w = aggregateSensingWindow([], { nowMs: NOW });
    assert.equal(w.reason, "no_buckets");
    assert.equal(w.coverage, "unknown");
  });

  it("a single publishable bucket gives coverage and dwell but no rate", () => {
    const w = aggregateSensingWindow(
      [{ timeBucket: bucketAt(0), read: cohort(tokens(0, 25), { bucket: bucketAt(0) }) }],
      { nowMs: NOW, timeBucketMinutes: WIDTH_MIN },
    );
    assert.equal(w.reason, null);
    assert.equal(w.bucketsPublishable, 1);
    assert.equal(w.pairsCounted, 0);
    assert.equal(w.coverage, "several");
    assert.equal(w.arrivalVelocity, null, "one bucket is not a rate");
  });

  it("a non-finite or malformed bucket stamp is refused", () => {
    const w = aggregateSensingWindow(
      [{ timeBucket: "not-a-date", read: cohort(tokens(0, 25), { bucket: bucketAt(0) }) }],
      { nowMs: NOW, timeBucketMinutes: WIDTH_MIN },
    );
    assert.equal(w.reason, "buckets_not_contiguous");
  });

  it("the publication delay is still enforced — a cohort that is too fresh is refused", () => {
    const fresh = new Date(NOW).toISOString();
    const w = aggregateSensingWindow(
      [{ timeBucket: fresh, read: cohort(tokens(0, 25), { bucket: fresh }) }],
      { nowMs: NOW, timeBucketMinutes: WIDTH_MIN },
    );
    assert.equal(w.bucketsPublishable, 0);
    assert.equal(w.buckets[0]?.reason, "publication_delay_not_elapsed");
  });

  it("the group threshold is real: one group of 25 is refused", () => {
    const oneGroup: SensingReadResult = {
      ok: true,
      complete: true,
      rows: tokens(0, 25).map((t) => ({
        contributor_token: t,
        rotation_epoch: 1,
        group_token: "only-group",
        zone_id: "zone-A",
        time_bucket: bucketAt(0),
        cohort_key: `v1|zone-a|${bucketAt(0)}`,
        signal_bucket: 2,
        reduction_version: 1,
        created_at: bucketAt(0),
        expires_at: new Date(NOW + HOUR).toISOString(),
      })),
    };
    const w = aggregateSensingWindow([{ timeBucket: bucketAt(0), read: oneGroup }], {
      nowMs: NOW,
      timeBucketMinutes: WIDTH_MIN,
    });
    assert.equal(w.bucketsPublishable, 0, `25 people in 1 group must fail minIndependentGroups=${G}`);
    assert.equal(w.reason, "no_publishable_bucket");
  });
});
