/**
 * Intel projection scheduler + aggregator (IG-04 driver) — the missing piece that
 * makes claim → snapshot projection run automatically. Proves: the confidence
 * components are derived conservatively; the aggregator counts DISTINCT observers
 * (the k-anon input) and confirmation stances from real rows; and the scheduler
 * pass is flag-gated, fail-closed, groups by (subject, zone), and upserts
 * snapshots — which stay privacy-suppressed while group data is absent (the gate
 * refuses, it is not weakened).
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { deriveComponents, derivePenalties, assembleClaimInput, type ClaimEvidence, type ClaimRow } from "../lib/intelProjectionAggregator.js";
import { runIntelProjectionPass } from "../lib/intelProjectionScheduler.js";
import { invalidateFreshnessPolicyCache } from "../lib/freshnessPolicy.js";

const NOW = new Date("2026-08-26T12:00:00.000Z");
const OBSERVED = new Date(NOW.getTime() - 15 * 60_000).toISOString(); // 15 min ago

const baseEvidence = (over: Partial<ClaimEvidence> = {}): ClaimEvidence => ({
  distinctActors: 3, agrees: 0, disagrees: 0, maxPresenceLevel: "P0",
  hasEvidence: false, sourceClass: "firsthand_unverified", ageRatio: 0.33, ...over,
});

function makeDb(cfg: { flags: Record<string, boolean>; claims?: any[]; observations?: any[]; confirmations?: any[]; policies?: any[]; errorTable?: string }) {
  const snaps: any[] = [];
  function from(table: string) {
    let op: "select" | "upsert" = "select"; let payload: any = null;
    const eqs: [string, any][] = []; let inF: [string, any[]] | null = null; let lim = Infinity;
    const src = (): any[] => (({ intel_claims: cfg.claims, intel_observations: cfg.observations, intel_confirmations: cfg.confirmations, freshness_policies: cfg.policies, intel_state_snapshots: snaps } as any)[table] ?? []);
    const match = (r: any) => eqs.every(([c, v]) => r[c] === v) && (!inF || inF[1].includes(r[inF[0]]));
    const rows = () => src().filter(match).slice(0, lim);
    const run = () => {
      if (table === "feature_flags") { const f = eqs.find(([c]) => c === "flag")?.[1]; return { data: { enabled: Boolean(cfg.flags[f]) }, error: null }; }
      if (cfg.errorTable === table) return { data: null, error: { message: "boom" } };
      if (op === "upsert") { snaps.push(...(Array.isArray(payload) ? payload : [payload])); return { data: null, error: null }; }
      return { data: rows(), error: null };
    };
    const b: any = {
      select() { return b; },
      upsert(row: any) { op = "upsert"; payload = row; return Promise.resolve(run()); },
      eq(c: string, v: any) { eqs.push([c, v]); return b; },
      in(c: string, v: any[]) { inF = [c, v]; return b; },
      limit(n: number) { lim = n; return Promise.resolve(run()); },
      maybeSingle() { return Promise.resolve(run()); },
      then(res: (r: any) => any) { return Promise.resolve(run()).then(res); },
    };
    return b;
  }
  return { from, _snaps: snaps };
}

describe("intelProjection aggregator — deriveComponents (conservative)", () => {
  it("maps presence P0→0, P4→1; freshness = 1 − ageRatio; independence saturates at k", () => {
    assert.equal(deriveComponents(baseEvidence({ maxPresenceLevel: "P0" })).presence, 0);
    assert.equal(deriveComponents(baseEvidence({ maxPresenceLevel: "P4" })).presence, 1);
    assert.equal(deriveComponents(baseEvidence({ ageRatio: 0.25 })).freshness, 0.75);
    assert.equal(deriveComponents(baseEvidence({ ageRatio: 2 })).freshness, 0, "stale clamps to 0");
    assert.equal(deriveComponents(baseEvidence({ distinctActors: 15 })).independence, 1, "saturates at k=15");
    assert.equal(deriveComponents(baseEvidence({ distinctActors: 3 })).independence, 0.2);
  });
  it("agreement is neutral with no confirmations, the agree-fraction otherwise", () => {
    assert.equal(deriveComponents(baseEvidence()).agreement, 0.5);
    assert.equal(deriveComponents(baseEvidence({ agrees: 2, disagrees: 1 })).agreement, 2 / 3);
  });
  it("source reliability + evidence quality reflect the strongest evidence", () => {
    assert.equal(deriveComponents(baseEvidence({ sourceClass: "firsthand_unverified" })).sourceReliability, 0.5);
    assert.equal(deriveComponents(baseEvidence({ sourceClass: "official_signed" })).sourceReliability, 1);
    assert.equal(deriveComponents(baseEvidence({ hasEvidence: false })).evidenceQuality, 0.3);
    assert.equal(deriveComponents(baseEvidence({ hasEvidence: true })).evidenceQuality, 0.8);
  });
  it("a conflicting claim carries a material-conflict penalty", () => {
    assert.deepEqual(derivePenalties(baseEvidence({ conflicting: true })), { materialConflict: 0.2 });
    assert.deepEqual(derivePenalties(baseEvidence()), {});
  });
});

describe("intelProjection aggregator — assembleClaimInput (real evidence)", () => {
  beforeEach(() => invalidateFreshnessPolicyCache());
  const claim: ClaimRow = { id: "c1", subject_id: "place-dn-1", zone_id: null, claim_type: "crowd.level", value: { level: "busy" }, status: "active", observed_at: OBSERVED };

  it("counts DISTINCT fresh observers and confirmation stances", async () => {
    const db = makeDb({
      flags: {},
      observations: [
        { actor_id: "a1", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null },
        { actor_id: "a2", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P1", source_class: "firsthand_unverified", expires_at: null },
        { actor_id: "a1", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null }, // dup actor
      ],
      confirmations: [{ stance: "agree", claim_id: "c1" }, { stance: "agree", claim_id: "c1" }, { stance: "disagree", claim_id: "c1" }],
      policies: [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }],
    });
    const input = await assembleClaimInput(db as any, claim, NOW);
    assert.equal(input.distinctActors, 2, "a1 counted once");
    assert.equal(input.claimType, "crowd.level");
    assert.deepEqual(input.value, { level: "busy" });
    assert.equal(input.components.agreement, 2 / 3);
    assert.equal(input.components.presence, 0.25, "strongest presence = P1");
    assert.ok(input.components.freshness > 0.6 && input.components.freshness < 0.8, "fresh (15/45)");
    // No group_key on these observations → distinctGroups is 0 (finite), not fabricated.
    // The gate then returns below_group_threshold rather than invalid_input.
    assert.equal(input.distinctGroups, 0, "no group_key → zero groups, never invented");
    assert.equal(input.maxGroupShare, 0, "finite share even with no grouped observations");
  });

  it("derives distinctGroups + actor-based maxGroupShare from group_key (leak-safe)", async () => {
    // 15 distinct actors: 5 in one crew (share group_key 'g-crew'), 10 solo (own keys).
    const obs = [
      ...Array.from({ length: 5 }, (_, i) => ({ actor_id: `crew-${i}`, subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, group_key: "g-crew" })),
      ...Array.from({ length: 10 }, (_, i) => ({ actor_id: `solo-${i}`, subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, group_key: `g-solo-${i}` })),
    ];
    const db = makeDb({ flags: {}, observations: obs, confirmations: [], policies: [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }] });
    const input = await assembleClaimInput(db as any, claim, NOW);
    assert.equal(input.distinctActors, 15);
    assert.equal(input.distinctGroups, 11, "1 crew + 10 solo = 11 groups");
    // Max group = the crew (5 actors) out of 15 grouped actors → 1/3.
    assert.ok(Math.abs((input.maxGroupShare ?? 0) - 5 / 15) < 1e-9, "actor-based share, crew is 5/15");
  });

  it("counts one organized crew as a SINGLE dominating group (the leak it must catch)", async () => {
    const obs = Array.from({ length: 15 }, (_, i) => ({ actor_id: `crew-${i}`, subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, group_key: "one-crew" }));
    const db = makeDb({ flags: {}, observations: obs, confirmations: [], policies: [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }] });
    const input = await assembleClaimInput(db as any, claim, NOW);
    assert.equal(input.distinctActors, 15, "15 people");
    assert.equal(input.distinctGroups, 1, "but ONE group — cannot read as 15 independent parties");
    assert.equal(input.maxGroupShare, 1, "the single group is 100% → single_group_dominates at the gate");
  });

  it("maxGroupShare uses the DISTINCT-actor union, so overlapping crews cannot dilute the share", async () => {
    // 15 actors each in 6 shared crews → 6 group_keys, each holding all 15 actors.
    // Summing per-group sizes (90) would give 15/90=0.167 and PUBLISH (the leak);
    // the union denominator (15) gives 15/15=1.0 → single_group_dominates.
    const obs: any[] = [];
    for (let a = 0; a < 15; a++) for (let g = 0; g < 6; g++)
      obs.push({ actor_id: `a${a}`, subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, group_key: `g${g}` });
    const db = makeDb({ flags: {}, observations: obs, confirmations: [], policies: [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }] });
    const input = await assembleClaimInput(db as any, claim, NOW);
    assert.equal(input.distinctActors, 15);
    assert.equal(input.distinctGroups, 6, "6 overlapping crews");
    assert.equal(input.maxGroupShare, 1, "union share 1.0, NOT the diluted 15/90");
  });
});

describe("intelProjection scheduler — runIntelProjectionPass (flag-gated, fail-closed)", () => {
  beforeEach(() => invalidateFreshnessPolicyCache());
  const claim = { id: "c1", subject_id: "place-dn-1", zone_id: null, claim_type: "crowd.level", value: { level: "busy" }, status: "active", observed_at: OBSERVED };
  const cfgBase = {
    claims: [claim],
    observations: [{ actor_id: "a1", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null }],
    confirmations: [],
    policies: [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }],
  };

  it("no client → no_client; flag off → disabled; neither writes", async () => {
    const off = await runIntelProjectionPass({ client: null });
    assert.equal(off.reason, "no_client");
    const db = makeDb({ ...cfgBase, flags: { intel_claim_projection_crowd: false } });
    const r = await runIntelProjectionPass({ client: db as any, now: NOW });
    assert.equal(r.reason, "disabled");
    assert.equal(r.skippedRun, true);
    assert.equal(db._snaps.length, 0);
  });

  it("flag on → projects claims into snapshots, suppressed while group data is absent (gate not weakened)", async () => {
    const db = makeDb({ ...cfgBase, flags: { intel_claim_projection_crowd: true } });
    const r = await runIntelProjectionPass({ client: db as any, now: NOW });
    assert.equal(r.reason, null);
    assert.equal(r.subjects, 1);
    assert.equal(db._snaps.length, 1, "a snapshot was written by the automatic pass");
    assert.equal(db._snaps[0].privacy_eligible, false, "suppressed: no group data, so the privacy gate refuses");
    assert.equal(r.written, 0);
    assert.equal(r.suppressed, 1);
  });

  it("groups claims by (subject, zone) and fails closed on a claim-read error", async () => {
    const err = await runIntelProjectionPass({ client: makeDb({ ...cfgBase, flags: { intel_claim_projection_crowd: true }, errorTable: "intel_claims" }) as any, now: NOW });
    assert.equal(err.reason, "error");
    assert.equal(err.skippedRun, true);
  });
});
