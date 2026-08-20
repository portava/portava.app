/**
 * freshnessPolicy — the seeded TTLs, the staleness boundary, and the
 * fail-closed treatment of an unknown claim_type, tested without a database.
 *
 * The migration (2102) and this module share SEED_FRESHNESS_POLICIES as one
 * source of truth, so pinning the seed here pins what the migration inserts too.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  SEED_FRESHNESS_POLICIES,
  getPolicy,
  isStale,
  expiresAt,
  invalidateFreshnessPolicyCache,
} from "../lib/freshnessPolicy.js";

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

/** A fake client whose load errors — exercises the fail-closed path. */
function erroringClient() {
  return {
    from() {
      return { select: async () => ({ data: null, error: { message: "boom" } }) };
    },
  };
}

describe("freshnessPolicy — seeded TTLs", () => {
  beforeEach(() => invalidateFreshnessPolicyCache());

  it("seeds the four blueprint TTLs exactly", () => {
    const byType = Object.fromEntries(SEED_FRESHNESS_POLICIES.map((p) => [p.claim_type, p.ttl_seconds]));
    assert.equal(byType.crowd, 900);        // 15 minutes
    assert.equal(byType.vibe, 1800);        // 30 minutes
    assert.equal(byType.price, 172800);     // 48 hours
    assert.equal(byType.structural, 15552000); // 180 days
  });

  it("getPolicy returns each seeded TTL", async () => {
    const sc = policyClient();
    assert.equal((await getPolicy(sc, "crowd"))?.ttlSeconds, 900);
    assert.equal((await getPolicy(sc, "vibe"))?.ttlSeconds, 1800);
    assert.equal((await getPolicy(sc, "price"))?.ttlSeconds, 172800);
    assert.equal((await getPolicy(sc, "structural"))?.ttlSeconds, 15552000);
  });
});

describe("freshnessPolicy — the staleness boundary at ttl", () => {
  beforeEach(() => invalidateFreshnessPolicyCache());

  it("is fresh just before ttl, stale at and after ttl (inclusive boundary)", async () => {
    const sc = policyClient();
    const observed = 1_000_000_000_000; // fixed epoch ms
    const ttlMs = 900 * 1000; // crowd

    assert.equal(await isStale(sc, "crowd", observed, observed + ttlMs - 1), false, "just before ttl → fresh");
    assert.equal(await isStale(sc, "crowd", observed, observed + ttlMs), true, "exactly ttl → stale");
    assert.equal(await isStale(sc, "crowd", observed, observed + ttlMs + 1), true, "past ttl → stale");
  });

  it("expiresAt is observedAt + ttl", async () => {
    const sc = policyClient();
    const observed = new Date("2026-08-19T00:00:00.000Z");
    const exp = await expiresAt(sc, "price", observed); // 172800s = 48h
    assert.equal(exp, "2026-08-21T00:00:00.000Z");
  });
});

describe("freshnessPolicy — unknown claim_type is fail-closed", () => {
  beforeEach(() => invalidateFreshnessPolicyCache());

  it("an unknown claim_type is treated as stale", async () => {
    const sc = policyClient();
    assert.equal(await isStale(sc, "made_up", Date.now()), true);
  });

  it("an unknown claim_type has no live label (expiresAt null)", async () => {
    const sc = policyClient();
    assert.equal(await expiresAt(sc, "made_up", Date.now()), null);
    assert.equal(await getPolicy(sc, "made_up"), null);
  });

  it("a DB error treats every claim_type as stale (fail-closed)", async () => {
    const sc = erroringClient();
    assert.equal(await isStale(sc, "crowd", Date.now()), true);
    assert.equal(await expiresAt(sc, "crowd", Date.now()), null);
  });
});
