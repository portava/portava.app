/**
 * intelProjection (IG-04) — claims become live state only when both the
 * confidence formula and the privacy gate allow it.
 *
 * The key property: a suppressed aggregate is still RECORDED (with
 * privacy_eligible=false) rather than silently dropped, so the suppression is
 * auditable — but it can never be shown, because the reader filters on that
 * column in the query.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { projectClaim, projectAndStore } from "../lib/intelProjection.js";
import { SEED_FRESHNESS_POLICIES, invalidateFreshnessPolicyCache } from "../lib/freshnessPolicy.js";
import { PRIVACY_THRESHOLD_V1, CLAIM_TYPES } from "../lib/intelContracts.js";

const NOW = new Date("2026-08-22T12:00:00.000Z");
const OBSERVED = new Date(NOW.getTime() - 20 * 60_000).toISOString(); // 20 min ago

/** Policies include the dotted crowd.level type 2128 seeds. */
const POLICY_ROWS = [
  ...SEED_FRESHNESS_POLICIES.map((p) => ({ claim_type: p.claim_type, ttl_seconds: p.ttl_seconds, note: p.note })),
  ...CLAIM_TYPES.map((c) => ({ claim_type: c.claimType, ttl_seconds: c.ttlSeconds, note: c.note })),
];

function client(opts: { flag?: boolean; upsertError?: boolean } = {}) {
  const upserts: any[] = [];
  return {
    upserts,
    from(table: string) {
      if (table === "freshness_policies") return { select: async () => ({ data: POLICY_ROWS, error: null }) };
      if (table === "feature_flags") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({
          data: opts.flag === undefined ? null : { enabled: opts.flag }, error: null }) }) }) };
      }
      if (table === "intel_state_snapshots") {
        return { upsert: async (row: any) => { upserts.push(row); return opts.upsertError ? { error: { message: "boom" } } : { error: null }; } };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

/** Enough distinct actors/groups to clear the privacy gate. */
const passing = {
  claimType: "crowd.level",
  value: { level: "busy" },
  observedAt: OBSERVED,
  distinctActors: PRIVACY_THRESHOLD_V1.minUniqueActors,
  distinctGroups: PRIVACY_THRESHOLD_V1.minIndependentGroups,
  maxGroupShare: PRIVACY_THRESHOLD_V1.maxSingleGroupShare,
  components: { presence: 1, freshness: 1, independence: 1, sourceReliability: 1, evidenceQuality: 1, agreement: 1, specificity: 1 },
};

describe("intelProjection — projectClaim", () => {
  beforeEach(() => invalidateFreshnessPolicyCache());

  it("produces a publishable snapshot when confidence and privacy both pass", async () => {
    const r = await projectClaim(client(), "place-1", passing, { now: NOW });
    assert.ok(r.snapshot);
    assert.equal(r.snapshot!.privacy_eligible, true);
    assert.equal(r.snapshot!.confidence_band, "strong");
    assert.equal(r.snapshot!.claim_type, "crowd.level");
  });

  it("derives expiry from the claim's TTL policy, not a hardcoded window", async () => {
    const r = await projectClaim(client(), "place-1", passing, { now: NOW });
    const ttl = CLAIM_TYPES.find((c) => c.claimType === "crowd.level")!.ttlSeconds;
    assert.equal(r.snapshot!.expires_at, new Date(Date.parse(OBSERVED) + ttl * 1000).toISOString());
  });

  it("RECORDS a suppressed aggregate rather than dropping it", async () => {
    const r = await projectClaim(client(), "place-1", { ...passing, distinctActors: 2 }, { now: NOW });
    assert.ok(r.snapshot, "a suppressed aggregate should still be recorded");
    assert.equal(r.snapshot!.privacy_eligible, false);
    assert.equal(r.privacy.reason, "below_actor_threshold");
  });

  it("skips a claim type with no TTL policy rather than inventing one", async () => {
    const r = await projectClaim(client(), "place-1", { ...passing, claimType: "not.a.real.type" }, { now: NOW });
    assert.equal(r.snapshot, null);
    assert.equal(r.skippedReason, "no_ttl_policy");
  });

  it("a sensitive subject is never publishable regardless of cohort", async () => {
    const r = await projectClaim(client(), "place-1", { ...passing, distinctActors: 10_000, sensitiveSubject: true }, { now: NOW });
    assert.equal(r.snapshot!.privacy_eligible, false);
    assert.equal(r.privacy.reason, "sensitive_subject");
  });

  it("weak evidence lowers the band even when privacy passes", async () => {
    const r = await projectClaim(client(), "place-1", { ...passing, components: { presence: 0.2 } }, { now: NOW });
    assert.equal(r.snapshot!.privacy_eligible, true);
    assert.equal(r.snapshot!.confidence_band, "unverified");
  });
});

describe("intelProjection — projectAndStore", () => {
  beforeEach(() => invalidateFreshnessPolicyCache());

  it("writes nothing when the projection flag is off", async () => {
    const c = client({ flag: false });
    const t = await projectAndStore(c, "place-1", [passing], { now: NOW });
    assert.deepEqual(t, { written: 0, suppressed: 0, skipped: 0 });
    assert.equal(c.upserts.length, 0);
  });

  it("writes nothing when the flag row is absent", async () => {
    const c = client({});
    await projectAndStore(c, "place-1", [passing], { now: NOW });
    assert.equal(c.upserts.length, 0, "an absent flag must not enable projection");
  });

  it("upserts on the unique key from 2130", async () => {
    const c = client({ flag: true });
    const t = await projectAndStore(c, "place-1", [passing], { now: NOW });
    assert.equal(t.written, 1);
    assert.equal(c.upserts.length, 1);
    assert.equal(c.upserts[0].subject_id, "place-1");
  });

  it("counts suppressed separately from written", async () => {
    const c = client({ flag: true });
    const t = await projectAndStore(c, "place-1", [passing, { ...passing, claimType: "queue.wait", distinctActors: 1 }], { now: NOW });
    assert.equal(t.written, 1);
    assert.equal(t.suppressed, 1);
    assert.equal(c.upserts.length, 2, "the suppressed row is still persisted, for audit");
    assert.equal(c.upserts[1].privacy_eligible, false);
  });

  it("an upsert failure skips that claim without aborting the rest", async () => {
    const c = client({ flag: true, upsertError: true });
    const t = await projectAndStore(c, "place-1", [passing], { now: NOW });
    assert.equal(t.skipped, 1);
    assert.equal(t.written, 0);
  });
});
