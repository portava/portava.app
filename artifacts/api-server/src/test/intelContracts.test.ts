/**
 * IG-01 contracts — acceptance tests (T-01 … T-10 of the A0 packet).
 *
 * These prove behaviour, not coverage. Several assert properties of the
 * migration TEXT rather than a live database, because the property being
 * protected IS textual: "the seed uses DO NOTHING" is what stops a re-apply
 * clobbering owner-tuned TTLs, and no DB is reachable from unit tests.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  SOURCE_CLASSES, SOURCE_CLASS_LABELS, LEGACY_SOURCE_CLASSES, LEGACY_SOURCE_CLASS_MAP,
  mayRenderAsLive, mayCountAsConsensus,
  VISIBILITIES, CLAIM_STATUSES, MODERATION_STATES, CAPTURE_SURFACES,
  COMMERCIAL_DISCLOSURES, CROWD_LEVELS, TRAJECTORIES,
  PRESENCE_LEVELS, PRESENCE_LEVEL_MEANING,
  CONFIDENCE_BANDS, CONFIDENCE_BAND_FLOOR, confidenceBand,
  CLAIM_TYPES, PHASE1_CLAIM_TYPES, isModerationEligible, isPilotClaimable,
  clampObservedAt, MAX_OBSERVED_AT_SKEW_MS,
  isValidIdempotencyKey, IDEMPOTENCY_KEY_MAX_LENGTH,
  INTEL_FLAGS, INTEL_FLAG_DEPENDENCIES,
  PRIVACY_THRESHOLD_V1,
  type IntelFlag,
} from "../lib/intelContracts.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(join(HERE, "../migrations/2128_intel_contracts_seed.sql"), "utf8");

// ── T-01 · every enum value carries a label / meaning ───────────────────────
describe("T-01 enum coverage", () => {
  it("every source class has a user-facing label", () => {
    for (const c of SOURCE_CLASSES) {
      assert.ok(SOURCE_CLASS_LABELS[c], `source class '${c}' has no label`);
    }
    assert.equal(Object.keys(SOURCE_CLASS_LABELS).length, SOURCE_CLASSES.length,
      "SOURCE_CLASS_LABELS has entries for classes that do not exist");
  });

  it("every presence level has a stated meaning", () => {
    for (const p of PRESENCE_LEVELS) assert.ok(PRESENCE_LEVEL_MEANING[p], `presence '${p}' undocumented`);
  });

  it("every confidence band has a floor, and the floors are strictly ordered", () => {
    const floors = CONFIDENCE_BANDS.map((b) => CONFIDENCE_BAND_FLOOR[b]);
    for (const f of floors) assert.equal(typeof f, "number");
    for (let i = 1; i < floors.length; i++) {
      assert.ok(floors[i] > floors[i - 1], "confidence band floors must strictly increase");
    }
  });

  it("no enum contains duplicates", () => {
    const sets: Array<readonly string[]> = [
      SOURCE_CLASSES, VISIBILITIES, CLAIM_STATUSES, MODERATION_STATES,
      CAPTURE_SURFACES, COMMERCIAL_DISCLOSURES, CROWD_LEVELS, TRAJECTORIES,
      PRESENCE_LEVELS, CONFIDENCE_BANDS, INTEL_FLAGS,
    ];
    for (const s of sets) assert.equal(new Set(s).size, s.length, `duplicate in ${s.join(",")}`);
  });
});

// ── T-02 · the seed cannot clobber owner-tuned values ──────────────────────
describe("T-02 seed idempotence", () => {
  it("every INSERT in the seed migration uses ON CONFLICT DO NOTHING", () => {
    // Slice each INSERT to the start of the next top-level statement rather than
    // to the first ';' — note strings legitimately contain semicolons, and a
    // non-greedy match would truncate before the ON CONFLICT clause.
    const starts = [...MIGRATION.matchAll(/^INSERT INTO/gm)].map((m) => m.index!);
    const bounds = [...MIGRATION.matchAll(/^(INSERT INTO|DO \$\$|COMMIT;|ALTER TABLE)/gm)].map((m) => m.index!);
    const inserts = starts.map((s) => {
      const next = bounds.find((b) => b > s) ?? MIGRATION.length;
      return MIGRATION.slice(s, next);
    });
    assert.ok(inserts.length >= 1, "expected the claim-type insert");
    for (const stmt of inserts) {
      assert.match(stmt, /ON CONFLICT[\s\S]*DO NOTHING/,
        "an INSERT does not use DO NOTHING — a re-apply would clobber owner-tuned values");
      assert.doesNotMatch(stmt, /DO UPDATE/, "DO UPDATE reintroduces the 2122 clobber defect");
    }
  });

  it("the migration is additive — it drops no table and deletes no rows", () => {
    const body = MIGRATION.split("-- REVERSAL")[0];
    assert.doesNotMatch(body, /\bDROP TABLE\b/i);
    assert.doesNotMatch(body, /\bDELETE FROM\b/i);
    assert.doesNotMatch(body, /\bTRUNCATE\b/i);
  });
});

// ── T-03 · claim registry ──────────────────────────────────────────────────
describe("T-03 claim-type registry", () => {
  it("declares exactly the thirteen Phase-1 claim types", () => {
    // The §22 map-contribution types added later are a SEPARATE list
    // (MAP_CONTRIBUTION_CLAIM_TYPES, seeded by 2220 and pinned by
    // mapContributionClaimTypes.test.ts) precisely so this count keeps meaning
    // "the Phase-1 cut 2128 owns" instead of drifting into "however many claim
    // types exist".
    assert.equal(PHASE1_CLAIM_TYPES.length, 13);
    assert.ok(CLAIM_TYPES.length >= PHASE1_CLAIM_TYPES.length,
      "CLAIM_TYPES must contain the Phase-1 cut");
    for (const c of PHASE1_CLAIM_TYPES) {
      assert.ok(CLAIM_TYPES.some((x) => x.claimType === c.claimType),
        `${c.claimType} dropped out of CLAIM_TYPES`);
    }
  });

  it("every claim type is dotted family.type and has a coherent ceiling", () => {
    for (const c of CLAIM_TYPES) {
      assert.match(c.claimType, /^[a-z_]+\.[a-z_]+$/, `'${c.claimType}' is not a dotted key`);
      assert.ok(c.ttlSeconds > 0, `${c.claimType} ttl must be positive`);
      assert.ok(c.hardExpirySeconds >= c.ttlSeconds,
        `${c.claimType}: hard expiry must be >= ttl`);
    }
  });

  it("the migration seeds exactly the claim types the module declares", () => {
    // 2128 owns the Phase-1 cut and only it; 2220 owns the map-contribution
    // types. Scoping this to PHASE1_CLAIM_TYPES keeps each migration answerable
    // for its own rows.
    for (const c of PHASE1_CLAIM_TYPES) {
      assert.ok(MIGRATION.includes(`'${c.claimType}'`), `${c.claimType} missing from 2128`);
      assert.ok(MIGRATION.includes(String(c.ttlSeconds)), `${c.claimType} ttl not in 2128`);
    }
  });

  it("corrects the two TTLs that contradicted the spec", () => {
    const crowd = CLAIM_TYPES.find((c) => c.claimType === "crowd.level");
    const price = CLAIM_TYPES.find((c) => c.claimType === "price.cover");
    assert.equal(crowd?.ttlSeconds, 2700, "crowd.level must be 45 min, not the seeded 900s");
    assert.equal(price?.ttlSeconds, 604800, "price.cover must be 7 days, not the seeded 48h");
  });
});

// ── T-04 · one source vocabulary ───────────────────────────────────────────
describe("T-04 source class", () => {
  it("declares the eight canonical classes", () => {
    assert.equal(SOURCE_CLASSES.length, 8);
    assert.ok(SOURCE_CLASSES.includes("sponsored"));
    assert.ok(SOURCE_CLASSES.includes("portava_prediction"));
  });

  it("maps every legacy value onto a canonical one", () => {
    for (const l of LEGACY_SOURCE_CLASSES) {
      const mapped = LEGACY_SOURCE_CLASS_MAP[l];
      assert.ok(mapped, `legacy '${l}' has no canonical destination`);
      assert.ok(SOURCE_CLASSES.includes(mapped), `'${l}' maps to non-canonical '${mapped}'`);
    }
  });

  it("does not promote unverified community reports to verified", () => {
    assert.equal(LEGACY_SOURCE_CLASS_MAP.community_reported, "firsthand_unverified",
      "mapping community_reported to a verified class manufactures verification");
  });
});

// ── T-05 · temporal contract ───────────────────────────────────────────────
describe("T-05 observed_at clamping", () => {
  const NOW = Date.parse("2026-08-22T12:00:00.000Z");

  it("passes a past observation through unchanged", () => {
    const r = clampObservedAt(new Date(NOW - 60_000), NOW);
    assert.equal(r?.clamped, false);
    assert.equal(r?.observedAt, new Date(NOW - 60_000).toISOString());
  });

  it("clamps small future skew to now (device clocks drift)", () => {
    const r = clampObservedAt(new Date(NOW + 5_000), NOW);
    assert.equal(r?.clamped, true);
    assert.equal(r?.observedAt, new Date(NOW).toISOString());
  });

  it("rejects a far-future observation instead of trusting it", () => {
    assert.equal(clampObservedAt(new Date(NOW + MAX_OBSERVED_AT_SKEW_MS + 1), NOW), null);
  });

  it("closes the fail-open hole: a clamped time can never produce a negative age", () => {
    // freshnessPolicy.isStale computes (now - observedAt); a negative age made
    // `age >= ttl` false, so a future timestamp read as fresh indefinitely.
    const r = clampObservedAt(new Date(NOW + 30_000), NOW);
    const age = NOW - Date.parse(r!.observedAt);
    assert.ok(age >= 0, "clamped observation still yields a negative age");
  });

  it("rejects unparseable input rather than defaulting", () => {
    assert.equal(clampObservedAt("not-a-date", NOW), null);
  });
});

// ── T-06 · idempotency ─────────────────────────────────────────────────────
describe("T-06 idempotency key", () => {
  it("accepts the shape journey_observations already enforces", () => {
    assert.ok(isValidIdempotencyKey("abc123"));
    assert.ok(isValidIdempotencyKey("obs:2026-08-22.quick-signal_1"));
  });
  it("rejects empty, over-long, and leading-punctuation keys", () => {
    assert.equal(isValidIdempotencyKey(""), false);
    assert.equal(isValidIdempotencyKey("_leading"), false);
    assert.equal(isValidIdempotencyKey("a".repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1)), false);
  });
  it("rejects non-strings rather than coercing", () => {
    for (const v of [null, undefined, 42, {}]) assert.equal(isValidIdempotencyKey(v), false);
  });
});

// ── T-07 · the two fail-closed truth rules ─────────────────────────────────
describe("T-07 truth boundary", () => {
  it("a prediction or historical pattern can never render as live", () => {
    assert.equal(mayRenderAsLive("portava_prediction"), false);
    assert.equal(mayRenderAsLive("historical_pattern"), false);
    assert.equal(mayRenderAsLive("verified_firsthand"), true);
  });

  it("official, sponsored and imported sources never count as community consensus", () => {
    assert.equal(mayCountAsConsensus("official_signed"), false);
    assert.equal(mayCountAsConsensus("sponsored"), false);
    assert.equal(mayCountAsConsensus("imported_owned"), false);
    assert.equal(mayCountAsConsensus("verified_firsthand"), true);
  });

  it("confidence banding fails closed on absent or invalid scores", () => {
    assert.equal(confidenceBand(null), "unverified");
    assert.equal(confidenceBand(undefined), "unverified");
    assert.equal(confidenceBand(NaN), "unverified");
    assert.equal(confidenceBand(-1), "unverified");
    assert.equal(confidenceBand(0.34), "unverified");
    assert.equal(confidenceBand(0.35), "provisional");
    assert.equal(confidenceBand(0.75), "live");
    assert.equal(confidenceBand(0.9), "strong");
  });

  it("only 'allowed' moderation backs a claim", () => {
    for (const s of MODERATION_STATES) {
      assert.equal(isModerationEligible(s), s === "allowed");
    }
  });

  it("the PILOT rule claims pending + allowed, excludes every invalidated state (fail-closed)", () => {
    for (const s of MODERATION_STATES) {
      assert.equal(isPilotClaimable(s), s === "pending" || s === "allowed", `${s}`);
    }
    // Fail-closed on unknown / missing states.
    assert.equal(isPilotClaimable("quarantined"), false);
    assert.equal(isPilotClaimable(null), false);
    assert.equal(isPilotClaimable(undefined), false);
  });
});

// ── T-08 · flags ───────────────────────────────────────────────────────────
describe("T-08 feature flags", () => {
  it("declares the eight named flags", () => {
    assert.equal(INTEL_FLAGS.length, 8);
  });

  it("declares the flag names WITHOUT seeding rows — a flag with no reader is dead config", () => {
    // scripts/check-flag-polarity.mjs rejects "SEEDED BUT NEVER READ". IG-01 has
    // no readers by design, so each flag row is seeded by the unit that adds its
    // first reader. This test pins that split so a future edit does not quietly
    // reintroduce the rows here and break the guard.
    assert.doesNotMatch(MIGRATION, /INSERT INTO public\.feature_flags/,
      "2128 must not seed feature_flags rows — seed them with their first reader");
    for (const f of INTEL_FLAGS) {
      assert.match(MIGRATION, new RegExp(`intel_`), "flag vocabulary should still be documented in the migration");
      assert.ok(typeof f === "string" && f.startsWith("intel_"));
    }
  });

  it("every dependency names a real flag, and the chain is acyclic", () => {
    for (const f of INTEL_FLAGS) {
      const deps = INTEL_FLAG_DEPENDENCIES[f];
      assert.ok(deps, `${f} has no dependency entry`);
      for (const d of deps) assert.ok(INTEL_FLAGS.includes(d), `${f} depends on unknown '${d}'`);
      assert.ok(!deps.includes(f), `${f} depends on itself`);
    }
    // walk each chain to a fixed point; a cycle would not terminate
    for (const f of INTEL_FLAGS) {
      const seen = new Set<string>();
      let frontier = [...INTEL_FLAG_DEPENDENCIES[f]];
      while (frontier.length) {
        const next = frontier.pop()!;
        assert.notEqual(next, f, `dependency cycle: ${f} transitively depends on itself`);
        if (seen.has(next)) continue;
        seen.add(next);
        frontier = frontier.concat(INTEL_FLAG_DEPENDENCIES[next as IntelFlag] ?? []);
      }
    }
  });

  it("the user-facing live label depends on projection, which depends on capture", () => {
    assert.deepEqual(INTEL_FLAG_DEPENDENCIES.intel_live_label_crowd, ["intel_claim_projection_crowd"]);
    assert.deepEqual(INTEL_FLAG_DEPENDENCIES.intel_claim_projection_crowd, ["intel_capture_quick_signal"]);
  });
});

// ── T-10 · runtime no-op ───────────────────────────────────────────────────
describe("T-10 runtime no-op", () => {
  it("the contracts module opens no client and reads no environment", () => {
    const src = readFileSync(join(HERE, "../lib/intelContracts.ts"), "utf8");
    assert.doesNotMatch(src, /process\.env/, "contracts must not read environment");
    assert.doesNotMatch(src, /createClient|getServiceClient|fetch\(/, "contracts must not open a client");
    assert.doesNotMatch(src, /^import .*(supabase|http)/m, "contracts must not import IO modules");
  });

  it("records the privacy thresholds as data without applying them", () => {
    assert.equal(PRIVACY_THRESHOLD_V1.minUniqueActors, 15);
    assert.equal(PRIVACY_THRESHOLD_V1.minIndependentGroups, 5);
    assert.equal(PRIVACY_THRESHOLD_V1.publicationDelayMinutes, 10);
  });
});
