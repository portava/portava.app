/**
 * intelReplay (I1) — a stored snapshot version replays to an identical result,
 * and a changed algorithm/formula version is REPORTED, never silently re-scored.
 *
 * The version rows under test are produced by the real writer (projectClaim +
 * projectAndStore through a fake client), so what is replayed is exactly what
 * production would persist — not a hand-built fixture asserting a shape the
 * writer never emits.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { projectAndStore, PROJECTION_ALGORITHM_VERSION } from "../lib/intelProjection.js";
import {
  replayVersion, replaySnapshotVersion, parseReplayRecord,
  auditSnapshotReplays, tallyReplayResults, REPLAY_AUDIT_DEFAULT_LIMIT,
  type ReplayResult,
} from "../lib/intelReplay.js";
import { SEED_FRESHNESS_POLICIES, invalidateFreshnessPolicyCache, FRESHNESS_CURVE_VERSION, freshnessScore } from "../lib/freshnessPolicy.js";
import { PRIVACY_THRESHOLD_V1, CLAIM_TYPES } from "../lib/intelContracts.js";

const NOW = new Date("2026-08-22T12:00:00.000Z");
const OBSERVED = new Date(NOW.getTime() - 20 * 60_000).toISOString();

const POLICY_ROWS = [
  ...SEED_FRESHNESS_POLICIES.map((p) => ({ claim_type: p.claim_type, ttl_seconds: p.ttl_seconds, note: p.note })),
  ...CLAIM_TYPES.map((c) => ({ claim_type: c.claimType, ttl_seconds: c.ttlSeconds, note: c.note })),
];

/** A fake client that stores version rows and serves them back by id. */
function client(opts: { readError?: boolean } = {}) {
  const versions: any[] = [];
  return {
    versions,
    from(table: string) {
      if (table === "freshness_policies") return { select: async () => ({ data: POLICY_ROWS, error: null }) };
      if (table === "feature_flags") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { enabled: true }, error: null }) }) }) };
      }
      if (table === "intel_state_snapshots") return { upsert: async () => ({ error: null }) };
      if (table === "intel_state_snapshot_versions") {
        return {
          insert: async (row: any) => { versions.push(row); return { error: null }; },
          select: () => ({
            eq: (_c: string, id: string) => ({
              maybeSingle: async () => opts.readError
                ? { data: null, error: { message: "boom" } }
                : { data: versions.find((v) => v.id === id) ?? null, error: null },
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient & { versions: typeof versions };
}

// The freshness component is DERIVED from the same curve the aggregator uses
// (freshnessScore over the stored age/ttl), never hand-written: a hand value
// asserts a shape the producer does not emit, and the replay would — correctly —
// report it as freshness_component_mismatch.
const FRESHNESS_INPUTS = { ageSeconds: 810, ttlSeconds: 2700 };
const input = {
  claimType: "crowd.level",
  value: { level: "busy" },
  observedAt: OBSERVED,
  distinctActors: PRIVACY_THRESHOLD_V1.minUniqueActors,
  distinctGroups: PRIVACY_THRESHOLD_V1.minIndependentGroups,
  maxGroupShare: PRIVACY_THRESHOLD_V1.maxSingleGroupShare,
  components: { presence: 0.5, freshness: freshnessScore(FRESHNESS_INPUTS.ageSeconds, FRESHNESS_INPUTS.ttlSeconds), independence: 1, sourceReliability: 0.5, evidenceQuality: 0.3, agreement: 0.5, specificity: 0.5 },
  penalties: { materialConflict: 0.2 },
  freshness: FRESHNESS_INPUTS,
  inputClaimVersions: [{ claim_id: "claim-1", updated_at: "2026-08-22T11:40:00.000Z", version: 2, status: "active" }],
};

async function storedVersion(c = client()) {
  const t = await projectAndStore(c, "place-1", [input], { now: NOW });
  assert.equal(t.written, 1);
  assert.equal(c.versions.length, 1);
  return c.versions[0];
}

describe("intelReplay — a stored version replays to identical output", () => {
  beforeEach(() => invalidateFreshnessPolicyCache());

  it("replayVersion (pure) reproduces the stored confidence and band exactly", async () => {
    const v = await storedVersion();
    const r = replayVersion(v);
    assert.equal(r.status, "equal", `expected equal, got ${r.reasons.join(",")}`);
    assert.deepEqual(r.reasons, []);
    assert.equal(r.recomputed.confidence, v.confidence);
    assert.equal(r.recomputed.band, v.confidence_band);
    assert.equal(r.stored.algorithmVersion, PROJECTION_ALGORITHM_VERSION);
  });

  it("replaySnapshotVersion reads the row by id and reports equal; not_found and error are distinct from diverged", async () => {
    const c = client();
    const v = await storedVersion(c);
    const r = await replaySnapshotVersion(c, v.id);
    assert.equal(r.status, "equal");
    assert.equal((await replaySnapshotVersion(c, "no-such-version")).status, "not_found");
    assert.equal((await replaySnapshotVersion(client({ readError: true }), v.id)).status, "error");
    assert.equal((await replaySnapshotVersion(null, v.id)).status, "error", "no client is an error, never a silent equal");
  });

  it("the replay record survives a JSON round-trip (what PostgREST hands back is a plain object, numerics may be strings)", async () => {
    const v = await storedVersion();
    const roundTripped = { ...JSON.parse(JSON.stringify(v)), confidence: String(v.confidence) };
    const r = replayVersion(roundTripped);
    assert.equal(r.status, "equal");
    assert.ok(parseReplayRecord(roundTripped.confidence_components));
  });
});

describe("intelReplay — a changed formula/algorithm version is REPORTED as divergence", () => {
  beforeEach(() => invalidateFreshnessPolicyCache());

  it("a row stamped with a different algorithm_version diverges with algorithm_version_changed, even though the numbers still agree", async () => {
    const v = await storedVersion();
    const r = replayVersion({ ...v, algorithm_version: "projection/1+confidence/1+freshness/linear" });
    assert.equal(r.status, "diverged");
    assert.deepEqual(r.reasons, ["algorithm_version_changed"]);
    assert.equal(r.recomputed.confidence, v.confidence, "the recomputation is still reported, it just is not the same computation");
  });

  it("replaying 'as of' a newer running version diverges the same way", async () => {
    const v = await storedVersion();
    const r = replayVersion(v, { algorithmVersion: "projection/3+confidence/1+freshness/linear" });
    assert.equal(r.status, "diverged");
    assert.ok(r.reasons.includes("algorithm_version_changed"));
  });

  it("a different formulaVersion inside the record is its own reason", async () => {
    const v = await storedVersion();
    const r = replayVersion({ ...v, confidence_components: { ...v.confidence_components, formulaVersion: 99 } });
    assert.ok(r.reasons.includes("formula_version_changed"), r.reasons.join(","));
  });

  it("a different freshness curve tag is reported, and the freshness component is then NOT re-derived under the new curve", async () => {
    const v = await storedVersion();
    const rec = { ...v.confidence_components, freshness: { ...v.confidence_components.freshness, curve: "not-" + FRESHNESS_CURVE_VERSION } };
    const r = replayVersion({ ...v, confidence_components: rec });
    assert.deepEqual(r.reasons, ["freshness_curve_changed"]);
  });

  it("a freshness component that does not come from the stored (age, ttl) under the current curve is freshness_component_mismatch", async () => {
    // A row whose component was produced by the OLD linear curve but stamped
    // with the current curve tag: the replay recomputes 1 − (810/2700)^1.5 and
    // finds the stored 0.7 (= 1 − 810/2700) does not match.
    const v = await storedVersion();
    const rec = { ...v.confidence_components, components: { ...v.confidence_components.components, freshness: 1 - 810 / 2700 } };
    const r = replayVersion({ ...v, confidence_components: rec });
    assert.equal(r.status, "diverged");
    assert.ok(r.reasons.includes("freshness_component_mismatch"), r.reasons.join(","));
  });

  it("a tampered stored confidence is confidence_mismatch — same versions, different answer", async () => {
    const v = await storedVersion();
    const r = replayVersion({ ...v, confidence: (v.confidence as number) + 0.05 });
    assert.equal(r.status, "diverged");
    assert.ok(r.reasons.includes("confidence_mismatch"));
    assert.ok(!r.reasons.includes("algorithm_version_changed"), "versions still match — this is a data defect, not a code change");
  });

  it("a row with no replay record is unreplayable and says so (fail-closed)", () => {
    const r = replayVersion({ id: "v", subject_id: "p", zone_id: "", claim_type: "crowd.level", confidence: 0.5, confidence_band: "provisional", confidence_components: null, algorithm_version: PROJECTION_ALGORITHM_VERSION });
    assert.equal(r.status, "diverged");
    assert.deepEqual(r.reasons, ["replay_record_missing"]);
  });
});

// ── The lineage AUDIT: the driver 2273 was written for and never had ─────────
//
// `replayVersion` had no non-test caller, so the lineage every projection writes
// was never once checked. `auditSnapshotReplays` is the batch driver behind
// `report:intel-lineage-audit` (spec §21 "lineage and correction consistency
// audit nightly"). The rows it replays here are produced by the REAL writer
// (projectAndStore), never hand-built.

/** The fake client above, extended with the batch read the audit performs. */
function auditClient(opts: { readError?: boolean } = {}) {
  const base = client() as any;
  const inner = base.from.bind(base);
  base.from = (table: string) => {
    if (table !== "intel_state_snapshot_versions") return inner(table);
    const single = inner(table);
    return {
      ...single,
      select: (_cols?: string) => {
        const rows = () => (opts.readError
          ? { data: null, error: { message: "boom" } }
          : { data: [...base.versions], error: null });
        const chain: any = {
          eq: (_c: string, id: string) => ({
            maybeSingle: async () => opts.readError
              ? { data: null, error: { message: "boom" } }
              : { data: base.versions.find((v: any) => v.id === id) ?? null, error: null },
            // the audit narrows by subject_id, then orders/limits
            order: () => chain,
            limit: async () => rows(),
          }),
          gte: () => chain,
          order: () => chain,
          limit: async () => rows(),
        };
        return chain;
      },
    };
  };
  return base;
}

describe("auditSnapshotReplays — the nightly lineage audit", () => {
  beforeEach(() => invalidateFreshnessPolicyCache());

  it("replays every stored version and reports CLEAN when they all reproduce", async () => {
    const c = auditClient();
    await projectAndStore(c, "place-1", [input], { now: NOW });
    await projectAndStore(c, "place-2", [input], { now: NOW });
    const r = await auditSnapshotReplays(c);
    assert.equal(r.readError, null);
    assert.equal(r.scanned, 2);
    assert.equal(r.equal, 2);
    assert.equal(r.diverged, 0);
    assert.deepEqual(r.reasons, {});
    assert.equal(r.clean, true);
  });

  it("AN EMPTY TABLE IS NOT A PASS — absence of evidence is not evidence of absence", async () => {
    const r = await auditSnapshotReplays(auditClient());
    assert.equal(r.scanned, 0);
    assert.equal(r.diverged, 0);
    assert.equal(r.clean, false, "zero rows scanned proves nothing and must never report clean");
  });

  it("a read failure is reported, never dressed as a clean audit", async () => {
    const r = await auditSnapshotReplays(auditClient({ readError: true }));
    assert.equal(r.clean, false);
    assert.ok(r.readError);
    assert.equal(r.scanned, 0);
  });

  it("no client is an error, never a silent pass", async () => {
    const r = await auditSnapshotReplays(null);
    assert.equal(r.clean, false);
    assert.ok(r.readError);
  });

  it("catches a row whose stored confidence disagrees with a replay of its own inputs", async () => {
    const c = auditClient();
    await projectAndStore(c, "place-1", [input], { now: NOW });
    await projectAndStore(c, "place-2", [input], { now: NOW });
    // Corrupt ONE stored row the way a hand edit or a non-deterministic formula would.
    (c as any).versions[1].confidence = Number((c as any).versions[1].confidence) + 0.05;
    const r = await auditSnapshotReplays(c);
    assert.equal(r.scanned, 2);
    assert.equal(r.equal, 1);
    assert.equal(r.diverged, 1);
    assert.equal(r.reasons.confidence_mismatch, 1);
    assert.equal(r.clean, false);
    assert.deepEqual(r.divergedVersionIds, [(c as any).versions[1].id]);
  });

  it("reports a version bump as a version change, distinct from a data defect", async () => {
    const c = auditClient();
    await projectAndStore(c, "place-1", [input], { now: NOW });
    const r = await auditSnapshotReplays(c, { algorithmVersion: `${PROJECTION_ALGORITHM_VERSION}+next` });
    assert.equal(r.diverged, 1);
    assert.equal(r.reasons.algorithm_version_changed, 1);
    assert.equal(r.reasons.confidence_mismatch ?? 0, 0, "the stored answer still reproduces — only the version moved");
    assert.equal(r.clean, false);
  });
});

describe("tallyReplayResults — the audit arithmetic, on its own", () => {
  const eq = (id: string): ReplayResult => ({
    status: "equal", versionId: id, reasons: [],
    stored: { confidence: 1, band: "strong", algorithmVersion: "a", formulaVersion: 1 },
    recomputed: { confidence: 1, band: "strong", algorithmVersion: "a", formulaVersion: 1 },
  });
  const bad = (id: string, reasons: ReplayResult["reasons"]): ReplayResult => ({ ...eq(id), status: "diverged", reasons });

  it("counts each reason a diverged row raises, and a row may raise several", () => {
    const t = tallyReplayResults([
      eq("a"),
      bad("b", ["confidence_mismatch", "band_mismatch"]),
      bad("c", ["confidence_mismatch"]),
    ]);
    assert.equal(t.scanned, 3);
    assert.equal(t.equal, 1);
    assert.equal(t.diverged, 2);
    assert.equal(t.reasons.confidence_mismatch, 2);
    assert.equal(t.reasons.band_mismatch, 1);
    assert.equal(t.clean, false);
  });

  it("caps the reported id list and SAYS it was truncated", () => {
    const rows = Array.from({ length: 5 }, (_, i) => bad(`v${i}`, ["confidence_mismatch"]));
    const t = tallyReplayResults(rows, 2);
    assert.equal(t.diverged, 5, "the COUNT is never truncated, only the id list");
    assert.deepEqual(t.divergedVersionIds, ["v0", "v1"]);
    assert.equal(t.divergedTruncated, true);
  });

  it("an empty batch is not clean", () => {
    assert.equal(tallyReplayResults([]).clean, false);
    assert.equal(tallyReplayResults([eq("a")]).clean, true);
  });

  it("the default batch limit is a positive integer the script can rely on", () => {
    assert.ok(Number.isInteger(REPLAY_AUDIT_DEFAULT_LIMIT) && REPLAY_AUDIT_DEFAULT_LIMIT > 0);
  });
});
