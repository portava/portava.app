/**
 * liveEnvelope (Phase 0 item 4) — composes the 2100 five-column envelope from
 * the source registry (2101) and freshness policies (2102), tested without a
 * database. Pins the two behaviours that matter most: the deterministic columns
 * are computed here, and the two owner-decision columns (confidence,
 * privacy_eligible) are pass-through and fail-closed — never invented.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  SEED_FRESHNESS_POLICIES,
  invalidateFreshnessPolicyCache,
} from "../lib/freshnessPolicy.js";
import {
  countSources,
  freshnessSeconds,
  computeLiveEnvelope,
  isEnvelopeLive,
  toCanonicalEnvelopeFields,
} from "../lib/liveEnvelope.js";

/** A fake service client whose freshness_policies table is the seed. */
function policyClient() {
  const rows = SEED_FRESHNESS_POLICIES.map((p) => ({
    claim_type: p.claim_type,
    ttl_seconds: p.ttl_seconds,
    note: p.note,
  }));
  return {
    from(table: string) {
      assert.equal(table, "freshness_policies");
      return { select: async () => ({ data: rows, error: null }) };
    },
  };
}

const OBSERVED = "2026-08-20T00:00:00.000Z";
const NOW = "2026-08-20T00:01:00.000Z"; // +60s
const CROWD_EXPIRES = "2026-08-20T00:15:00.000Z"; // OBSERVED + 900s

describe("liveEnvelope — countSources (deterministic)", () => {
  it("null when no keys are supplied at all", () => {
    assert.equal(countSources(undefined), null);
  });
  it("null when every supplied key is empty/whitespace", () => {
    assert.equal(countSources(["", "   ", null, undefined]), null);
  });
  it("counts distinct non-empty keys, collapsing duplicates", () => {
    assert.equal(countSources(["fsq", "fsq", "osm", "", null]), 2);
  });
});

describe("liveEnvelope — freshnessSeconds (deterministic)", () => {
  it("is the whole-second age of the observation", () => {
    assert.equal(freshnessSeconds(OBSERVED, NOW), 60);
  });
  it("floors a future observation at 0 (never negative)", () => {
    assert.equal(freshnessSeconds(NOW, OBSERVED), 0);
  });
  it("null on an unparseable timestamp", () => {
    assert.equal(freshnessSeconds("not-a-date", NOW), null);
  });
});

describe("liveEnvelope — computeLiveEnvelope", () => {
  beforeEach(() => invalidateFreshnessPolicyCache());

  it("derives source_count / freshness_seconds / expires_at for a known claim_type", async () => {
    const env = await computeLiveEnvelope(policyClient(), {
      claimType: "crowd",
      observedAt: OBSERVED,
      now: NOW,
      sourceKeys: ["fsq", "osm", "fsq"],
    });
    assert.equal(env.source_count, 2);
    assert.equal(env.freshness_seconds, 60);
    assert.equal(env.expires_at, CROWD_EXPIRES);
  });

  it("fail-closed expires_at (null) for an unknown claim_type", async () => {
    const env = await computeLiveEnvelope(policyClient(), {
      claimType: "no_such_type",
      observedAt: OBSERVED,
      now: NOW,
    });
    assert.equal(env.expires_at, null);
  });

  it("passes confidence through, defaulting to null — never invented", async () => {
    const withScore = await computeLiveEnvelope(policyClient(), {
      claimType: "crowd", observedAt: OBSERVED, now: NOW, confidence: 0.42,
    });
    assert.equal(withScore.confidence, 0.42);
    const without = await computeLiveEnvelope(policyClient(), {
      claimType: "crowd", observedAt: OBSERVED, now: NOW,
    });
    assert.equal(without.confidence, null);
  });

  it("privacy_eligible is fail-closed: only exactly true is eligible", async () => {
    const base = { claimType: "crowd", observedAt: OBSERVED, now: NOW } as const;
    assert.equal((await computeLiveEnvelope(policyClient(), { ...base, privacyEligible: true })).privacy_eligible, true);
    assert.equal((await computeLiveEnvelope(policyClient(), { ...base, privacyEligible: false })).privacy_eligible, false);
    assert.equal((await computeLiveEnvelope(policyClient(), { ...base, privacyEligible: null })).privacy_eligible, false);
    assert.equal((await computeLiveEnvelope(policyClient(), { ...base })).privacy_eligible, false);
  });
});

describe("liveEnvelope — isEnvelopeLive", () => {
  it("live while now is before expiry", () => {
    assert.equal(isEnvelopeLive({ expires_at: CROWD_EXPIRES }, NOW), true);
  });
  it("not live once expiry has passed", () => {
    assert.equal(isEnvelopeLive({ expires_at: CROWD_EXPIRES }, "2026-08-20T00:20:00.000Z"), false);
  });
  it("fail-closed: no expiry => not live", () => {
    assert.equal(isEnvelopeLive({ expires_at: null }, NOW), false);
  });
});

describe("liveEnvelope — toCanonicalEnvelopeFields", () => {
  it("maps snake_case envelope onto the camelCase event input fields", () => {
    const fields = toCanonicalEnvelopeFields({
      source_count: 2,
      freshness_seconds: 60,
      confidence: 0.42,
      privacy_eligible: true,
      expires_at: CROWD_EXPIRES,
    });
    assert.deepEqual(fields, {
      sourceCount: 2,
      freshnessSeconds: 60,
      confidence: 0.42,
      privacyEligible: true,
      expiresAt: CROWD_EXPIRES,
    });
  });
});
