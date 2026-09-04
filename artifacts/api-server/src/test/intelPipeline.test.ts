/**
 * Intelligence Gathering — end-to-end composition.
 *
 * Every other intel test exercises one module. This one asserts the modules
 * COMPOSE: an observation's signals become a confidence score, the score and the
 * cohort become a privacy decision, the decision becomes a snapshot, and the
 * snapshot becomes (or does not become) something a surface will show.
 *
 * It runs entirely in memory against a fake client. There is no capture path yet
 * — IG-03 is blocked on the lawful-basis decision — so observations are injected
 * directly, which is the point: the pipeline downstream of capture is provable
 * today, and this is the harness that will still be here when capture lands.
 *
 * THE PROPERTY THAT MATTERS MOST: the writer and the reader disagree safely. A
 * suppressed aggregate is written (privacy_eligible=false) and the reader refuses
 * it. Neither side depends on the other being correct.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { projectAndStore } from "../lib/intelProjection.js";
import { readLiveClaims, readLiveCrowdLevel, _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import { SEED_FRESHNESS_POLICIES, invalidateFreshnessPolicyCache } from "../lib/freshnessPolicy.js";
import { PRIVACY_THRESHOLD_V1, CLAIM_TYPES, clampObservedAt, isValidIdempotencyKey } from "../lib/intelContracts.js";
import { mayRedistribute } from "../lib/dataRights.js";

const NOW = new Date("2026-08-22T12:00:00.000Z");
const OBSERVED = new Date(NOW.getTime() - 20 * 60_000).toISOString();

const POLICIES = [
  ...SEED_FRESHNESS_POLICIES.map((p) => ({ claim_type: p.claim_type, ttl_seconds: p.ttl_seconds, note: p.note })),
  ...CLAIM_TYPES.map((c) => ({ claim_type: c.claimType, ttl_seconds: c.ttlSeconds, note: c.note })),
];

/**
 * A fake database that stores snapshots and serves them back through the same
 * filters the real reader applies — so the read side is genuinely exercised.
 */
function makeDb(flags: Record<string, boolean>) {
  // The per-scope allowlist is cached module-side keyed by the read clock; reset
  // it per db so a fixed test clock never serves a prior test's promoted set.
  _clearPromotedScopeCache();
  const snapshots: any[] = [];
  const versions: any[] = [];
  return {
    snapshots,
    versions,
    from(table: string) {
      if (table === "freshness_policies") return { select: async () => ({ data: POLICIES, error: null }) };
      if (table === "intel_live_promoted_scopes") {
        // Promote exactly the scopes that were actually stored, so these cases
        // keep testing the privacy/flag/expiry gates rather than promotion. The
        // per-scope promotion gate itself is covered in liveClaimRead.test.ts.
        const pq: any = { select: () => pq };
        return Object.assign(pq, {
          then: (res: any) => res({
            data: snapshots.map((s) => ({ scope_key: `${s.zone_id ?? ""}|${s.claim_type}` })),
            error: null,
          }),
        });
      }
      if (table === "feature_flags") {
        return { select: () => ({ eq: (_c: string, flag: string) => ({ maybeSingle: async () => {
          // IG-09 read-path gates default to the live-allowed state (pilot on,
          // emergency stop clear) so these pipeline cases keep exercising the
          // read path; an explicit entry in `flags` still overrides the default.
          if (!(flag in flags)) {
            if (flag === "intel_limited_live") return { data: { enabled: true }, error: null };
            if (flag === "disable_intel_live_labels") return { data: { enabled: false }, error: null };
          }
          return { data: flag in flags ? { enabled: flags[flag] } : null, error: null };
        } }) }) };
      }
      if (table === "intel_state_snapshot_versions") {
        // I1: the writer appends an immutable version row before every upsert.
        return { insert: async (row: any) => { versions.push(row); return { error: null }; } };
      }
      if (table === "intel_state_snapshots") {
        const q: any = {
          _subject: null as string | null, _types: null as string[] | null, _after: null as string | null,
          upsert: async (row: any) => {
            const i = snapshots.findIndex((s) => s.subject_id === row.subject_id && s.claim_type === row.claim_type);
            if (i >= 0) snapshots[i] = row; else snapshots.push(row);
            return { error: null };
          },
          select: () => q,
          eq: (k: string, v: any) => { if (k === "subject_id") q._subject = v; if (k === "privacy_eligible") q._eligible = v; return q; },
          gt: (k: string, v: any) => { if (k === "expires_at") q._after = v; return q; },
          in: (_k: string, v: string[]) => { q._types = v; return q; },
          then: (res: any) => res({
            data: snapshots.filter((s) =>
              (q._subject === null || s.subject_id === q._subject) &&
              (q._eligible === undefined || s.privacy_eligible === q._eligible) &&
              (q._after === null || s.expires_at > q._after) &&
              (q._types === null || q._types.includes(s.claim_type))),
            error: null,
          }),
        };
        return q;
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

const strongEvidence = {
  presence: 1, freshness: 1, independence: 1, sourceReliability: 1,
  evidenceQuality: 1, agreement: 1, specificity: 1,
};

const busyClaim = {
  claimType: "crowd.level",
  value: { level: "busy" },
  observedAt: OBSERVED,
  distinctActors: PRIVACY_THRESHOLD_V1.minUniqueActors,
  distinctGroups: PRIVACY_THRESHOLD_V1.minIndependentGroups,
  maxGroupShare: PRIVACY_THRESHOLD_V1.maxSingleGroupShare,
  components: strongEvidence,
};

describe("IG pipeline — a well-evidenced claim reaches the surface", () => {
  beforeEach(() => invalidateFreshnessPolicyCache());

  it("projects, stores, and is readable end to end", async () => {
    const db = makeDb({ intel_capture_quick_signal: true, intel_claim_projection_crowd: true, intel_live_label_crowd: true });
    const t = await projectAndStore(db, "place-1", [busyClaim], { now: NOW });
    assert.equal(t.written, 1);

    const claims = await readLiveClaims(db, "place-1", { now: NOW });
    assert.equal(claims.length, 1);
    assert.equal(claims[0].band, "strong");
    assert.equal(await readLiveCrowdLevel(db, "place-1", { now: NOW }), "busy");
  });
});

describe("IG pipeline — the writer and the reader disagree safely", () => {
  beforeEach(() => invalidateFreshnessPolicyCache());

  it("a suppressed aggregate is STORED but never served", async () => {
    const db = makeDb({ intel_capture_quick_signal: true, intel_claim_projection_crowd: true, intel_live_label_crowd: true });
    const t = await projectAndStore(db, "place-2", [{ ...busyClaim, distinctActors: 2 }], { now: NOW });

    assert.equal(t.suppressed, 1, "suppression should be counted");
    assert.equal(db.snapshots.length, 1, "the suppressed aggregate must still be recorded, for audit");
    assert.equal(db.snapshots[0].privacy_eligible, false);

    // The reader refuses it independently of why it was suppressed.
    assert.deepEqual(await readLiveClaims(db, "place-2", { now: NOW }), []);
    assert.equal(await readLiveCrowdLevel(db, "place-2", { now: NOW }), null);
  });

  it("turning the read flag off hides even an eligible snapshot", async () => {
    const db = makeDb({ intel_capture_quick_signal: true, intel_claim_projection_crowd: true, intel_live_label_crowd: false });
    await projectAndStore(db, "place-3", [busyClaim], { now: NOW });
    assert.equal(db.snapshots[0].privacy_eligible, true, "it was publishable…");
    assert.deepEqual(await readLiveClaims(db, "place-3", { now: NOW }), [], "…but the surface flag still governs");
  });
});

describe("IG pipeline — time is enforced end to end", () => {
  beforeEach(() => invalidateFreshnessPolicyCache());

  it("a snapshot goes dark once its claim TTL elapses", async () => {
    const db = makeDb({ intel_capture_quick_signal: true, intel_claim_projection_crowd: true, intel_live_label_crowd: true });
    await projectAndStore(db, "place-4", [busyClaim], { now: NOW });
    assert.equal((await readLiveClaims(db, "place-4", { now: NOW })).length, 1);

    const ttl = CLAIM_TYPES.find((c) => c.claimType === "crowd.level")!.ttlSeconds;
    const afterExpiry = new Date(Date.parse(OBSERVED) + (ttl + 60) * 1000);
    assert.deepEqual(await readLiveClaims(db, "place-4", { now: afterExpiry }), [],
      "an expired snapshot must stop being live without anyone deleting it");
  });

  it("a future observed_at cannot buy permanent freshness", () => {
    // The bug this closes: freshnessPolicy.isStale computes age = now - observedAt
    // and returns age >= ttl, so a negative age read as never-stale forever.
    const far = new Date(NOW.getTime() + 10 * 60_000);
    assert.equal(clampObservedAt(far, NOW), null, "a far-future observation must be rejected outright");
    const slight = clampObservedAt(new Date(NOW.getTime() + 5_000), NOW);
    assert.ok(NOW.getTime() - Date.parse(slight!.observedAt) >= 0, "clamping must never leave a negative age");
  });
});

describe("IG pipeline — the contracts hold at the boundaries", () => {
  beforeEach(() => invalidateFreshnessPolicyCache());

  it("an unknown claim type is skipped rather than given an invented TTL", async () => {
    const db = makeDb({ intel_capture_quick_signal: true, intel_claim_projection_crowd: true, intel_live_label_crowd: true });
    const t = await projectAndStore(db, "place-5", [{ ...busyClaim, claimType: "invented.type" }], { now: NOW });
    assert.equal(t.skipped, 1);
    assert.equal(db.snapshots.length, 0);
  });

  it("the fields a surface reads are the fields rights allow to leave", async () => {
    const db = makeDb({ intel_capture_quick_signal: true, intel_claim_projection_crowd: true, intel_live_label_crowd: true });
    await projectAndStore(db, "place-6", [busyClaim], { now: NOW });
    const claim = (await readLiveClaims(db, "place-6", { now: NOW }))[0];
    // Everything the reader surfaces must be redistributable…
    for (const col of ["value", "confidence", "confidence_band", "source_count", "observed_at", "expires_at"]) {
      assert.equal(mayRedistribute("intel_state_snapshots", col), true, `${col} is surfaced but not redistributable`);
    }
    // …and the cohort size, which the reader does NOT surface, must not be.
    assert.equal(mayRedistribute("intel_state_snapshots", "distinct_actors"), false);
    assert.equal((claim as any).distinctActors, undefined, "the reader must not expose the cohort size");
  });

  it("idempotency keys are validated by the same rule the database enforces", () => {
    assert.equal(isValidIdempotencyKey("obs:2026-08-22.crowd_1"), true);
    assert.equal(isValidIdempotencyKey("_bad"), false);
  });
});
