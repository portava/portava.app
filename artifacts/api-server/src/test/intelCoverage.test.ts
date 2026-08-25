/**
 * IG-08 Coverage — the coverage score, the mission trigger/safety/budget rules,
 * and the service's flag-gated non-cash mission lifecycle.
 *
 * Pure math runs in memory; the service cases run against a fake client that
 * supports guarded update...select().maybeSingle() so the atomic
 * commit-before-dispatch and honored-accept rules are exercised for real.
 * Proves: the §16 coverage product; every mission trigger; missions are
 * non-cash; generation/dispatch are flag-gated while accept is not; and a
 * budget cannot dispatch without an atomic commit.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeCoverageScore, claimImportance } from "../lib/coverageScore.js";
import {
  evaluateMissionTriggers, shouldGenerateMission, buildMissionCandidate,
  canDispatch, isHonoredCommitment, MISSION_SAFETY_CONSTRAINTS,
  type MissionTriggerContext,
} from "../lib/missionGeneration.js";
import { generateMissions, commitAndDispatch, acceptMission, computeCoverage } from "../services/intel/CoverageService.js";

const CONTRIB = "11111111-1111-4111-8111-111111111111";

/** Fake client supporting the guarded update...select().maybeSingle() the service uses. */
function makeMissionDb(flags: Record<string, boolean>, seedRows: any[] = []) {
  const rows: any[] = [...seedRows];
  let seq = 0;
  return {
    _rows: rows,
    from(table: string) {
      let op: "select" | "insert" | "insert_select" | "update" = "select";
      let payload: any = null;
      const filters: [string, any][] = [];
      const match = (r: any) => filters.every(([c, v]) => r[c] === v);
      function exec() {
        if (table === "feature_flags") {
          const flag = filters.find(([c]) => c === "flag")?.[1];
          return { data: { enabled: Boolean(flags[flag]) }, error: null };
        }
        if (op === "insert" || op === "insert_select") {
          const row = { id: `m-${++seq}`, created_at: "t", updated_at: "t", ...payload };
          rows.push(row);
          return { data: op === "insert_select" ? row : null, error: null };
        }
        if (op === "update") {
          const hit = rows.find(match);
          if (!hit) return { data: null, error: null };
          Object.assign(hit, payload);
          return { data: hit, error: null };
        }
        return { data: rows.filter(match), error: null };
      }
      const b: any = {
        select() { if (op === "insert") op = "insert_select"; else if (op !== "update") op = "select"; return b; },
        insert(row: any) { op = "insert"; payload = row; return b; },
        update(patch: any) { op = "update"; payload = patch; return b; },
        eq(c: string, v: any) { filters.push([c, v]); return b; },
        order() { return b; },
        limit() { return Promise.resolve(exec()); },
        maybeSingle() { return Promise.resolve(exec()); },
        single() { return Promise.resolve(exec()); },
        then(resolve: (r: any) => any) { return Promise.resolve(exec()).then(resolve); },
      };
      return b;
    },
  };
}

describe("IG-08 — coverage score (§16)", () => {
  it("is the product of the five gap factors", () => {
    const b = computeCoverageScore({
      demandEvents: 10, claimMissing: true, currentConfidence: 0,
      requiredConfidence: 0.65, topContributorShare: 1, claimFamily: "crowd.level",
    });
    // demand 1 · freshness 1 · importance 0.8 · confidence 1 · diversity 1 = 0.8
    assert.equal(b.demandWeight, 1);
    assert.equal(b.freshnessGap, 1);
    assert.equal(b.claimImportance, 0.8);
    assert.equal(b.confidenceGap, 1);
    assert.equal(b.sourceDiversityGap, 1);
    assert.equal(b.score, 0.8);
  });
  it("a well-covered cell scores ~0, and unknown families get a neutral importance", () => {
    const covered = computeCoverageScore({
      demandEvents: 10, claimMissing: false, freshestAgeRatio: 0.1, currentConfidence: 0.9,
      topContributorShare: 0.1, claimFamily: "crowd.level",
    });
    assert.ok(covered.score < 0.05);
    assert.equal(claimImportance("some.new.family"), 0.5);
  });
  it("ranks cells by descending gap", () => {
    const ranked = computeCoverage([
      { claimFamily: "music.current", zoneId: "z", demandEvents: 1, claimMissing: true, currentConfidence: 0, topContributorShare: 1 },
      { claimFamily: "transit.condition", zoneId: "z", demandEvents: 10, claimMissing: true, currentConfidence: 0, topContributorShare: 1 },
    ]);
    assert.equal(ranked[0].claimFamily, "transit.condition");
    assert.equal(computeCoverage([]).length, 0);
  });
});

describe("IG-08 — mission trigger v1, safety, budget", () => {
  const base: MissionTriggerContext = {
    qualifiedDemandEvents6h: 0, requiredLiveFamilyMissing: false,
    pendingDecisionsAffectedByContradiction: 0, criticalClaimStale: false,
    criticalClaimInActivePlan: false, campaignHasExplicitBudget: false, campaignHasAcceptanceContract: false,
  };
  it("fires each trigger only under its condition", () => {
    assert.deepEqual(evaluateMissionTriggers(base), []);
    assert.deepEqual(evaluateMissionTriggers({ ...base, qualifiedDemandEvents6h: 10, requiredLiveFamilyMissing: true }), ["demand_spike_missing_family"]);
    assert.equal(shouldGenerateMission({ ...base, qualifiedDemandEvents6h: 10, requiredLiveFamilyMissing: false }), false, "demand alone, family present → no mission");
    assert.deepEqual(evaluateMissionTriggers({ ...base, pendingDecisionsAffectedByContradiction: 5 }), ["material_contradiction"]);
    assert.deepEqual(evaluateMissionTriggers({ ...base, criticalClaimStale: true, criticalClaimInActivePlan: true }), ["stale_critical_in_plan"]);
    assert.deepEqual(evaluateMissionTriggers({ ...base, campaignHasExplicitBudget: true, campaignHasAcceptanceContract: true }), ["funded_campaign"]);
  });
  it("safety constraints are declared; a candidate is non-cash and uncommitted", () => {
    assert.ok(MISSION_SAFETY_CONSTRAINTS.includes("no covert recording"));
    assert.ok(MISSION_SAFETY_CONSTRAINTS.includes("negative results are fully valid"));
    const m = buildMissionCandidate({ city: "lis", claimFamily: "crowd.level", trigger: "material_contradiction", coverageScore: 0.5, question: "How busy now?", budgetUnits: 3 });
    assert.equal(m.cashAmount, 0);
    assert.equal(m.budgetCommitted, false);
    assert.equal(m.status, "candidate");
    assert.equal(canDispatch(m), false, "uncommitted budget cannot dispatch");
    assert.equal(canDispatch({ ...m, budgetCommitted: true }), true);
    assert.equal(isHonoredCommitment({ status: "accepted" }), true);
  });
});

describe("IG-08 — service: non-cash lifecycle, gating", () => {
  const spec = {
    ctx: { qualifiedDemandEvents6h: 10, requiredLiveFamilyMissing: true,
      pendingDecisionsAffectedByContradiction: 0, criticalClaimStale: false, criticalClaimInActivePlan: false,
      campaignHasExplicitBudget: false, campaignHasAcceptanceContract: false } as MissionTriggerContext,
    mission: { city: "lis", claimFamily: "crowd.level", trigger: "demand_spike_missing_family" as const, coverageScore: 0.7, question: "How busy?", budgetUnits: 2 },
  };

  it("generateMissions is flag-gated (off → nothing)", async () => {
    const db = makeMissionDb({ intel_missions: false });
    const out = await generateMissions(db as any, [spec]);
    assert.equal(out.ok, false);
    assert.equal(out.reason, "disabled");
    assert.equal(db._rows.length, 0);
  });

  it("generates a non-cash candidate when the trigger fires and the flag is on", async () => {
    const db = makeMissionDb({ intel_missions: true });
    const out = await generateMissions(db as any, [spec]);
    assert.equal(out.ok, true);
    assert.equal(out.created.length, 1);
    assert.equal(out.created[0].cash_amount, 0);
    assert.equal(out.created[0].status, "candidate");
    assert.equal(out.created[0].budget_committed, false);
  });

  it("dispatch commits budget atomically and only from a candidate; accept survives the flag going off", async () => {
    const db = makeMissionDb({ intel_missions: true }, [
      { id: "mm-1", status: "candidate", budget_committed: false, cash_amount: 0 },
    ]);
    const disp = await commitAndDispatch(db as any, "mm-1");
    assert.equal(disp.ok, true);
    const row = db._rows.find((r) => r.id === "mm-1");
    assert.equal(row.status, "dispatched");
    assert.equal(row.budget_committed, true, "budget committed atomically with dispatch");

    // Double dispatch is a no-op (guard on status='candidate').
    const again = await commitAndDispatch(db as any, "mm-1");
    assert.equal(again.ok, false);
    assert.equal(again.reason, "not_dispatchable");

    // Flag OFF now — an already-dispatched commitment can still be accepted (§26 honor commitments).
    const off = makeMissionDb({ intel_missions: false }, [
      { id: "mm-2", status: "dispatched", budget_committed: true, cash_amount: 0 },
    ]);
    const acc = await acceptMission(off as any, "mm-2", CONTRIB);
    assert.equal(acc.ok, true);
    assert.equal(off._rows.find((r) => r.id === "mm-2").status, "accepted");

    // A never-dispatched mission cannot be accepted.
    const bad = await acceptMission(off as any, "mm-404", CONTRIB);
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, "not_acceptable");
  });
});
