/**
 * intelProjection (IG-04) — claims become live state only when both the
 * confidence formula and the privacy gate allow it.
 *
 * The key property: a suppressed aggregate is still RECORDED (with
 * privacy_eligible=false) rather than silently dropped, so the suppression is
 * auditable — but it can never be shown, because the reader filters on that
 * column in the query.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { projectClaim, projectAndStore, PROJECTION_ALGORITHM_VERSION } from "../lib/intelProjection.js";
import { SEED_FRESHNESS_POLICIES, invalidateFreshnessPolicyCache, FRESHNESS_CURVE_VERSION } from "../lib/freshnessPolicy.js";
import { PRIVACY_THRESHOLD_V1, CLAIM_TYPES } from "../lib/intelContracts.js";

const NOW = new Date("2026-08-22T12:00:00.000Z");
const OBSERVED = new Date(NOW.getTime() - 20 * 60_000).toISOString(); // 20 min ago

/** Policies include the dotted crowd.level type 2128 seeds. */
const POLICY_ROWS = [
  ...SEED_FRESHNESS_POLICIES.map((p) => ({ claim_type: p.claim_type, ttl_seconds: p.ttl_seconds, note: p.note })),
  ...CLAIM_TYPES.map((c) => ({ claim_type: c.claimType, ttl_seconds: c.ttlSeconds, note: c.note })),
];

function client(opts: { flag?: boolean; upsertError?: boolean; versionError?: boolean } = {}) {
  const upserts: any[] = [];
  const versions: any[] = [];
  return {
    upserts,
    versions,
    from(table: string) {
      if (table === "freshness_policies") return { select: async () => ({ data: POLICY_ROWS, error: null }) };
      if (table === "feature_flags") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({
          data: opts.flag === undefined ? null : { enabled: opts.flag }, error: null }) }) }) };
      }
      if (table === "intel_state_snapshots") {
        return { upsert: async (row: any) => { upserts.push(row); return opts.upsertError ? { error: { message: "boom" } } : { error: null }; } };
      }
      if (table === "intel_state_snapshot_versions") {
        return { insert: async (row: any) => { if (opts.versionError) return { error: { message: "version boom" } }; versions.push(row); return { error: null }; } };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient & { upserts: typeof upserts; versions: typeof versions };
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

  it("keys the publication delay to publicationAnchorAt, not the newest observedAt (H3)", async () => {
    const freshObserved = new Date(NOW.getTime() - 2 * 60_000).toISOString();  // 2 min ago (< 10-min delay)
    const stableAnchor = new Date(NOW.getTime() - 30 * 60_000).toISOString();  // 30 min ago (> delay)

    // Measured from the stable earliest anchor, the 10-minute delay has elapsed.
    const withAnchor = await projectClaim(
      client(), "place-1", { ...passing, observedAt: freshObserved, publicationAnchorAt: stableAnchor }, { now: NOW });
    assert.equal(withAnchor.snapshot!.privacy_eligible, true,
      "delay measured from the stable anchor, not the 2-min-old newest observation");

    // With no anchor it falls back to the 2-min-old observedAt and is still delayed —
    // proving the delay really is keyed to the anchor when present.
    const withoutAnchor = await projectClaim(
      client(), "place-1", { ...passing, observedAt: freshObserved }, { now: NOW });
    assert.equal(withoutAnchor.snapshot!.privacy_eligible, false);
    assert.equal(withoutAnchor.privacy.reason, "publication_delay_not_elapsed");
  });

  it("caps the snapshot expires_at at the hard-expiry ceiling (finding 5)", async () => {
    const ttl = CLAIM_TYPES.find((c) => c.claimType === "crowd.level")!.ttlSeconds;
    const ttlExpiry = new Date(Date.parse(OBSERVED) + ttl * 1000).toISOString(); // OBSERVED + 45m = NOW + 25m

    // A ceiling BEFORE the TTL horizon collapses expires_at onto it. Here the
    // ceiling is already in the past, so the snapshot is born expired → the reader
    // (expires_at > now) drops it: the absolute age cap is enforced.
    const ceiling = new Date(NOW.getTime() - 5 * 60_000).toISOString();
    const capped = await projectClaim(client(), "place-1", { ...passing, hardExpiresAt: ceiling }, { now: NOW });
    assert.equal(capped.snapshot!.expires_at, ceiling, "expires_at collapses to the hard ceiling");
    assert.ok(Date.parse(capped.snapshot!.expires_at) <= NOW.getTime(), "a past ceiling makes it already expired");

    // A ceiling BEYOND the TTL horizon changes nothing — ordinary TTL expiry stands.
    const farCeiling = new Date(NOW.getTime() + 100 * 60_000).toISOString();
    const uncapped = await projectClaim(client(), "place-1", { ...passing, hardExpiresAt: farCeiling }, { now: NOW });
    assert.equal(uncapped.snapshot!.expires_at, ttlExpiry, "a ceiling past the TTL leaves expires_at at the TTL horizon");
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

describe("intelProjection — replayability (I1: §8 store every component, §11 Table 17)", () => {
  beforeEach(() => invalidateFreshnessPolicyCache());

  it("projectClaim persists the WHOLE confidence record, the algorithm version and the claim lineage — not just the number", async () => {
    const lineage = [{ claim_id: "claim-1", updated_at: "2026-08-22T11:30:00.000Z", version: 3, status: "active" }];
    const r = await projectClaim(client(), "place-1",
      { ...passing, components: { presence: 0.5, freshness: 0.8 }, penalties: { instability: 0.1 }, freshness: { ageSeconds: 300, ttlSeconds: 2700 }, inputClaimVersions: lineage },
      { now: NOW });
    const s = r.snapshot!;
    assert.equal(s.algorithm_version, PROJECTION_ALGORITHM_VERSION);
    assert.deepEqual(s.input_claim_versions, lineage);
    assert.equal(s.conflict_state, null, "I1 writes the column NULL; unit I2 populates it");
    const rec = s.confidence_components;
    assert.equal(rec.formulaVersion, 1);
    assert.equal(rec.components.presence, 0.5);
    assert.equal(rec.components.freshness, 0.8);
    assert.equal(rec.components.independence, 0, "an absent component is stored as the zero it scored as");
    assert.equal(rec.penalties.instability, 0.1);
    assert.deepEqual(rec.freshness, { ageSeconds: 300, ttlSeconds: 2700, curve: FRESHNESS_CURVE_VERSION });
    assert.ok(Math.abs(rec.raw - rec.penalty - s.confidence) < 1e-9, "raw − penalty reproduces the stored confidence");
  });

  it("records an EMPTY lineage array, never an invented one, when the caller supplies no claim identity", async () => {
    const r = await projectClaim(client(), "place-1", passing, { now: NOW });
    assert.deepEqual(r.snapshot!.input_claim_versions, []);
  });

  it("appends ONE immutable version row per snapshot write, BEFORE the upsert, carrying the same lineage", async () => {
    const c = client({ flag: true });
    const order: string[] = [];
    const inner = c.from.bind(c);
    c.from = (table: string) => { order.push(table); return inner(table); };
    const t = await projectAndStore(c, "place-1", [passing, { ...passing, claimType: "queue.wait", distinctActors: 1 }], { now: NOW });
    assert.equal(t.written + t.suppressed, 2);
    assert.equal(c.versions.length, 2, "one version row per write — the suppressed one too");
    assert.equal(c.upserts.length, 2);
    const v = c.versions[0];
    assert.match(v.id, /^[0-9a-f-]{36}$/, "the version id is minted by the writer so the lineage log can name it");
    assert.equal(v.generated_at, NOW.toISOString());
    assert.equal(v.algorithm_version, PROJECTION_ALGORITHM_VERSION);
    assert.deepEqual(v.confidence_components, c.upserts[0].confidence_components, "version row and current row carry the same replay record");
    assert.equal(v.privacy_reason, null);
    assert.equal(c.versions[1].privacy_reason, "below_actor_threshold", "the suppression reason is part of the record");
    const firstVersion = order.indexOf("intel_state_snapshot_versions");
    const firstUpsert = order.indexOf("intel_state_snapshots");
    assert.ok(firstVersion !== -1 && firstVersion < firstUpsert, "the version row is appended BEFORE the current state is touched");
  });

  it("a failed version append leaves the current state UNTOUCHED (fail-closed: a state that cannot be replayed is never served)", async () => {
    const c = client({ flag: true, versionError: true });
    const t = await projectAndStore(c, "place-1", [passing], { now: NOW });
    assert.equal(t.skipped, 1);
    assert.equal(t.written, 0);
    assert.equal(c.upserts.length, 0, "no upsert after a version-append failure");
  });
});
