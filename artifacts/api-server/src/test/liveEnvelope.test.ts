/**
 * liveEnvelope — the three envelope fields it actually computes
 * (sourceCount, freshnessSeconds, expiresAt) and the two it deliberately
 * leaves null (confidence, privacyEligible), tested without a database.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SEED_SOURCES, invalidateSourceRegistryCache } from "../lib/sourceRegistry.js";
import { SEED_FRESHNESS_POLICIES, invalidateFreshnessPolicyCache } from "../lib/freshnessPolicy.js";
import { computeSourceCount, computeFreshnessSeconds, computeLiveEnvelope } from "../lib/liveEnvelope.js";

/** A fake service client backing both `sources` and `freshness_policies`. */
function envelopeClient() {
  const sourceRows = SEED_SOURCES.map((s, i) => ({ id: `id-${i}-${s.key}`, key: s.key }));
  const policyRows = SEED_FRESHNESS_POLICIES.map((p) => ({
    claim_type: p.claim_type,
    ttl_seconds: p.ttl_seconds,
    note: p.note,
  }));
  return {
    from(table: string) {
      if (table === "sources") return { select: async () => ({ data: sourceRows, error: null }) };
      if (table === "freshness_policies") return { select: async () => ({ data: policyRows, error: null }) };
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

function beforeEachReset() {
  invalidateSourceRegistryCache();
  invalidateFreshnessPolicyCache();
}

describe("liveEnvelope — computeFreshnessSeconds", () => {
  it("returns elapsed seconds between observedAt and now", () => {
    const observedAt = "2026-08-20T00:00:00Z";
    const now = "2026-08-20T00:05:00Z";
    assert.equal(computeFreshnessSeconds(observedAt, now), 300);
  });

  it("clamps a future observedAt (clock skew) to 0, never negative", () => {
    const observedAt = "2026-08-20T00:05:00Z";
    const now = "2026-08-20T00:00:00Z";
    assert.equal(computeFreshnessSeconds(observedAt, now), 0);
  });

  it("defaults now to the current time", () => {
    const observedAt = new Date(Date.now() - 10_000).toISOString();
    const seconds = computeFreshnessSeconds(observedAt);
    assert.ok(seconds >= 9 && seconds <= 15, `expected ~10s, got ${seconds}`);
  });
});

describe("liveEnvelope — computeSourceCount", () => {
  beforeEach(beforeEachReset);

  it("counts distinct registry-known keys", async () => {
    const sc = envelopeClient();
    assert.equal(await computeSourceCount(sc, ["fsq", "osm"]), 2);
  });

  it("de-duplicates repeated keys", async () => {
    const sc = envelopeClient();
    assert.equal(await computeSourceCount(sc, ["fsq", "fsq", "fsq"]), 1);
  });

  it("does not count an unknown key (fail-closed)", async () => {
    const sc = envelopeClient();
    assert.equal(await computeSourceCount(sc, ["fsq", "mock", "seed_script"]), 1);
  });

  it("returns 0 for empty or missing input", async () => {
    const sc = envelopeClient();
    assert.equal(await computeSourceCount(sc, []), 0);
    assert.equal(await computeSourceCount(sc, undefined), 0);
  });
});

describe("liveEnvelope — computeLiveEnvelope", () => {
  beforeEach(beforeEachReset);

  it("computes sourceCount, freshnessSeconds and expiresAt from 2101 + 2102", async () => {
    const sc = envelopeClient();
    const observedAt = "2026-08-20T00:00:00Z";
    const now = "2026-08-20T00:10:00Z"; // 600s after observedAt

    const envelope = await computeLiveEnvelope(sc, {
      claimType: "crowd", // 900s TTL
      observedAt,
      sourceKeys: ["fsq", "osm"],
      now,
    });

    assert.equal(envelope.sourceCount, 2);
    assert.equal(envelope.freshnessSeconds, 600);
    assert.equal(envelope.expiresAt, new Date("2026-08-20T00:15:00Z").toISOString());
  });

  it("leaves confidence and privacyEligible null — never invents a value", async () => {
    const sc = envelopeClient();
    const envelope = await computeLiveEnvelope(sc, {
      claimType: "vibe",
      observedAt: "2026-08-20T00:00:00Z",
      sourceKeys: ["google"],
    });

    assert.equal(envelope.confidence, null);
    assert.equal(envelope.privacyEligible, null);
  });

  it("an unknown claim_type yields null expiresAt (fail-closed), same as freshnessPolicy", async () => {
    const sc = envelopeClient();
    const envelope = await computeLiveEnvelope(sc, {
      claimType: "not_a_real_claim_type",
      observedAt: "2026-08-20T00:00:00Z",
    });

    assert.equal(envelope.expiresAt, null);
    assert.equal(envelope.sourceCount, 0);
  });
});
