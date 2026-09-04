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

// ── I1: the spec §9 curve and the Table-16 extension rules ───────────────────
import {
  freshnessScore,
  freshnessFromRatio,
  FRESHNESS_CURVE_VERSION,
  FRESHNESS_CURVE_EXPONENT,
  mayExtendFreshness,
  claimFamilyOf,
  isQualifyingExtensionSource,
  TRAJECTORY_MIN_SEPARATION_SECONDS,
} from "../lib/freshnessPolicy.js";

describe("freshnessPolicy — the §9 curve: max(0, 1 − (age/ttl)^1.5)", () => {
  const TTL = 2700; // crowd.level, 45 min

  it("is the power curve, not the linear one it replaced", () => {
    assert.equal(FRESHNESS_CURVE_EXPONENT, 1.5);
    assert.equal(FRESHNESS_CURVE_VERSION, "pow1.5");
  });

  it("age 0 → exactly 1", () => {
    assert.equal(freshnessScore(0, TTL), 1);
  });

  it("age ttl/2 → 1 − 0.5^1.5 ≈ 0.6464 (NOT 0.5, which the linear curve gave)", () => {
    const v = freshnessScore(TTL / 2, TTL);
    assert.ok(Math.abs(v - (1 - Math.pow(0.5, 1.5))) < 1e-12, `got ${v}`);
    assert.ok(v > 0.6 && v < 0.7);
  });

  it("age ttl → exactly 0, the same instant isStale() flips", () => {
    assert.equal(freshnessScore(TTL, TTL), 0);
  });

  it("age > ttl → 0, never negative", () => {
    assert.equal(freshnessScore(TTL * 3, TTL), 0);
    assert.equal(freshnessFromRatio(2), 0);
  });

  it("is monotone non-increasing and above the linear curve everywhere inside the TTL", () => {
    let prev = 1;
    for (let r = 0; r <= 1; r += 0.05) {
      const v = freshnessFromRatio(r);
      assert.ok(v <= prev + 1e-12, `not monotone at ${r}`);
      assert.ok(v >= 1 - r - 1e-12, `below linear at ${r}`);
      prev = v;
    }
  });

  it("fails closed on a missing/zero TTL or a non-finite age", () => {
    assert.equal(freshnessScore(10, 0), 0);
    assert.equal(freshnessScore(10, -5), 0);
    assert.equal(freshnessScore(Number.NaN, TTL), 0);
    assert.equal(freshnessFromRatio(Number.POSITIVE_INFINITY), 0);
    assert.equal(freshnessScore(-30, TTL), 1, "a negative age (skew already clamped upstream) reads as now");
  });
});

describe("freshnessPolicy — Table 16 col. 3: which observation kinds may EXTEND which family", () => {
  const T0 = Date.parse("2026-08-26T11:00:00.000Z");
  const later = (s: number) => T0 + s * 1000;
  const base = { sourceClass: "firsthand_unverified", presenceLevel: "P0", actorId: "a2", observedAt: later(300), anchorObservedAt: T0, anchorActorId: "a1" };

  it("maps every registry type Table 16 names to its family, and the rest to a stated default", () => {
    assert.equal(claimFamilyOf("queue.wait"), "queue");
    assert.equal(claimFamilyOf("crowd.level"), "crowd_level");
    assert.equal(claimFamilyOf("crowd.trajectory"), "trajectory");
    assert.equal(claimFamilyOf("crowd.mix"), "crowd_mix_music");
    assert.equal(claimFamilyOf("music.current"), "crowd_mix_music");
    assert.equal(claimFamilyOf("transit.condition"), "transit_disruption");
    assert.equal(claimFamilyOf("price.cover"), "price_access_policy");
    assert.equal(claimFamilyOf("access.dress"), "price_access_policy");
    assert.equal(claimFamilyOf("access.reservation"), "price_access_policy");
    assert.equal(claimFamilyOf("not.a.type"), "unlisted");
  });

  it("only firsthand and signed-official sources qualify — hearsay, sponsored, prediction, historical never extend anything", () => {
    for (const cls of ["hearsay", "sponsored", "portava_prediction", "historical_pattern", "imported_owned", null, undefined, ""]) {
      assert.equal(isQualifyingExtensionSource(cls as any), false, `${cls} must not qualify`);
      const d = mayExtendFreshness("queue.wait", { ...base, sourceClass: cls as any });
      assert.equal(d.allowed, false);
      assert.equal((d as any).reason, "unqualified_source");
    }
  });

  it("an observation not AFTER the anchor cannot extend it", () => {
    assert.equal((mayExtendFreshness("queue.wait", { ...base, observedAt: T0 }) as any).reason, "not_after_anchor");
    assert.equal((mayExtendFreshness("queue.wait", { ...base, observedAt: T0 - 1 }) as any).reason, "not_after_anchor");
  });

  it("Queue: a new qualified observation extends — even from the same person", () => {
    assert.equal(mayExtendFreshness("queue.wait", { ...base, actorId: "a1" }).allowed, true);
  });

  it("REFUSAL — Crowd level needs an INDEPENDENT reconfirmation: the anchoring person tapping again does not extend", () => {
    const d = mayExtendFreshness("crowd.level", { ...base, actorId: "a1" });
    assert.equal(d.allowed, false);
    assert.equal((d as any).reason, "not_independent");
    assert.equal(mayExtendFreshness("crowd.level", { ...base, actorId: "a2" }).allowed, true, "a different person does");
    assert.equal(mayExtendFreshness("crowd.level", { ...base, actorId: "a1", sourceClass: "official_signed" }).allowed, true, "an official statement is a different party by construction");
    assert.equal((mayExtendFreshness("crowd.level", { ...base, actorId: null }) as any).reason, "not_independent", "an actor-less firsthand row cannot prove independence");
  });

  it("Crowd mix / music: independent confirmation, same rule as crowd level", () => {
    assert.equal((mayExtendFreshness("music.current", { ...base, actorId: "a1" }) as any).reason, "not_independent");
    assert.equal(mayExtendFreshness("crowd.mix", base).allowed, true);
  });

  it("Trajectory: a new TIME-SEPARATED observation — under the separation it is one observation of a trend", () => {
    const tooSoon = mayExtendFreshness("crowd.trajectory", { ...base, observedAt: later(TRAJECTORY_MIN_SEPARATION_SECONDS - 1) });
    assert.equal((tooSoon as any).reason, "not_time_separated");
    assert.equal(mayExtendFreshness("crowd.trajectory", { ...base, observedAt: later(TRAJECTORY_MIN_SEPARATION_SECONDS) }).allowed, true);
  });

  it("Transit disruption: official, or two qualified reports", () => {
    assert.equal((mayExtendFreshness("transit.condition", { ...base, qualifiedReporters: 1 }) as any).reason, "needs_official_or_two_reports");
    assert.equal(mayExtendFreshness("transit.condition", { ...base, qualifiedReporters: 2 }).allowed, true);
    assert.equal(mayExtendFreshness("transit.condition", { ...base, sourceClass: "official_signed", qualifiedReporters: 0 }).allowed, true);
  });

  it("Price / access policy: a transaction (P3+) or an official update — a plain tap does not extend a 7–21 day fact", () => {
    assert.equal((mayExtendFreshness("price.cover", { ...base, presenceLevel: "P2" }) as any).reason, "needs_transaction_or_official");
    assert.equal(mayExtendFreshness("price.cover", { ...base, presenceLevel: "P3" }).allowed, true);
    assert.equal(mayExtendFreshness("access.dress", { ...base, sourceClass: "official_signed" }).allowed, true);
  });
});
