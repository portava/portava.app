/**
 * IG-10 internal — the QIU shadow calculation and the field-licensing projection
 * that decides which intel columns may ever leave Portava.
 *
 * Proves: the §23 QIU product and its two zero-outs (integrity 0, expired-before-
 * action) plus fail-closed on bad inputs; and that the API projection emits only
 * redistributable fields, never a restricted one (actor_id, distinct_actors), and
 * refuses a snapshot that is not privacy-eligible or has expired.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeQiu } from "../lib/qiuShadow.js";
import { projectRedistributable, projectSnapshotForApi } from "../lib/intelApiProjection.js";

const ONES = {
  baseOutcome: 1, evidence: 1, freshness: 1, scopedTrust: 1,
  originality: 1, scarcity: 1, outcome: 1, integrity: 1, claimExpiredBeforeAction: false,
};

describe("IG-10 — QIU shadow (§23)", () => {
  it("is the product of the eight factors", () => {
    assert.equal(computeQiu({ ...ONES, evidence: 0.5, scopedTrust: 0.5 }), 0.25);
    assert.equal(computeQiu(ONES), 1);
  });
  it("is 0 when integrity is 0 or the claim expired before the action", () => {
    assert.equal(computeQiu({ ...ONES, integrity: 0 }), 0);
    assert.equal(computeQiu({ ...ONES, claimExpiredBeforeAction: true }), 0, "an expired-before-action claim earns nothing");
  });
  it("fails closed to 0 on a non-finite or negative factor", () => {
    assert.equal(computeQiu({ ...ONES, evidence: Number.NaN }), 0);
    assert.equal(computeQiu({ ...ONES, scarcity: -1 }), 0);
    assert.equal(computeQiu({ ...ONES, outcome: Infinity }), 0);
  });
});

const snapshot = {
  id: "snap-1",
  subject_id: "22222222-2222-4222-8222-222222222222",
  claim_type: "crowd.level",
  value: { level: "busy" },
  confidence: 0.8,
  confidence_band: "live",
  source_count: 20,
  distinct_actors: 20,          // restricted_no_redistribution
  privacy_eligible: true,
  observed_at: "2026-08-25T21:00:00.000Z",
  expires_at: "2999-01-01T00:00:00.000Z",
};

describe("IG-10 — field-licensing projection (§22)", () => {
  it("emits only redistributable columns and never a restricted one", () => {
    const proj = projectRedistributable("intel_observations", {
      actor_id: "secret-person", subject_id: "place", claim_type: "crowd.level",
      value: { level: "busy" }, visibility: "private", presence_attestation: { x: 1 },
    });
    assert.ok(!("actor_id" in proj), "the contributor id never leaves");
    assert.ok(!("visibility" in proj), "the audience choice never leaves");
    assert.ok(!("presence_attestation" in proj), "presence facts never leave");
    assert.equal(proj.subject_id, "place");
    assert.equal(proj.claim_type, "crowd.level");
    assert.deepEqual(proj.value, { level: "busy" });
  });

  it("projects a live snapshot to redistributable fields, dropping distinct_actors", () => {
    const proj = projectSnapshotForApi(snapshot, new Date("2026-08-25T21:30:00Z"));
    assert.ok(proj);
    assert.ok(!("distinct_actors" in proj!), "the cohort size is the privacy parameter — never redistributed");
    assert.ok(!("id" in proj!), "internal bookkeeping is never a field");
    assert.deepEqual(proj!.value, { level: "busy" });
    assert.equal(proj!.expires_at, "2999-01-01T00:00:00.000Z", "expiry must travel with live state");
  });

  it("AT-01 / AT-16: the API refuses a snapshot that is not privacy-eligible or has expired", () => {
    assert.equal(projectSnapshotForApi({ ...snapshot, privacy_eligible: false }, new Date("2026-08-25T21:30:00Z")), null);
    assert.equal(projectSnapshotForApi({ ...snapshot, expires_at: "2020-01-01T00:00:00.000Z" }, new Date("2026-08-25T21:30:00Z")), null);
    assert.equal(projectSnapshotForApi(null), null);
  });
});
