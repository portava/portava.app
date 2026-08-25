/**
 * Rewards internal — eligibility gates, QIU→credits conversion, and the flag-
 * gated non-cash ledger recording.
 *
 * Proves: every §23 eligibility gate (funding source, ledger version, commercial-
 * use permission, no fraud, finalized outcome); earnings are QIU-derived and
 * never cash; and recordEarnedReward is flag-gated, refuses the ineligible with
 * reasons, and books a non-cash ledger entry for the eligible.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateRewardEligibility, type RewardEligibilityContext } from "../lib/rewardEligibility.js";
import { computeEarnedReward, QIU_TO_CREDITS } from "../lib/rewardEarnings.js";
import { recordEarnedReward } from "../services/intel/RewardService.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";

const ELIGIBLE: RewardEligibilityContext = {
  commercialUsePermission: true, fundingSourceKnown: true, ledgerVersion: "v1",
  fraudHold: false, outcomeFinalized: true,
};

function makeDb(flags: Record<string, boolean>) {
  const rows: any[] = [];
  let seq = 0;
  return {
    _rows: rows,
    from(table: string) {
      let op: "select" | "insert" | "insert_select" = "select";
      let payload: any = null;
      const filters: [string, any][] = [];
      function run() {
        if (table === "feature_flags") {
          const flag = filters.find(([c]) => c === "flag")?.[1];
          return { data: { enabled: Boolean(flags[flag]) }, error: null };
        }
        if (op === "insert" || op === "insert_select") {
          const row = { id: `r-${++seq}`, created_at: "t", ...payload };
          rows.push(row);
          return { data: op === "insert_select" ? row : null, error: null };
        }
        return { data: rows, error: null };
      }
      const b: any = {
        select() { if (op === "insert") op = "insert_select"; return b; },
        insert(row: any) { op = "insert"; payload = row; return b; },
        eq(c: string, v: any) { filters.push([c, v]); return b; },
        maybeSingle() { return Promise.resolve(run()); },
        single() { return Promise.resolve(run()); },
        then(resolve: (r: any) => any) { return Promise.resolve(run()).then(resolve); },
      };
      return b;
    },
  };
}

describe("rewards — eligibility (§23)", () => {
  it("passes only when every gate is met", () => {
    assert.deepEqual(evaluateRewardEligibility(ELIGIBLE), { eligible: true, reasons: [] });
  });
  it("names each failing gate", () => {
    assert.deepEqual(evaluateRewardEligibility({ ...ELIGIBLE, outcomeFinalized: false }).reasons, ["outcome_not_finalized"]);
    assert.deepEqual(evaluateRewardEligibility({ ...ELIGIBLE, commercialUsePermission: false }).reasons, ["no_commercial_use_permission"]);
    assert.deepEqual(evaluateRewardEligibility({ ...ELIGIBLE, fundingSourceKnown: false }).reasons, ["no_funding_source"]);
    assert.deepEqual(evaluateRewardEligibility({ ...ELIGIBLE, ledgerVersion: null }).reasons, ["no_ledger_version"]);
    assert.deepEqual(evaluateRewardEligibility({ ...ELIGIBLE, fraudHold: true }).reasons, ["fraud_hold"]);
  });
});

describe("rewards — earnings are QIU-derived and never cash (§23/§30)", () => {
  it("converts positive QIU to credits, zero otherwise", () => {
    assert.deepEqual(computeEarnedReward(1.5), { unit: "credit", earnedUnits: Math.round(1.5 * QIU_TO_CREDITS), cashAmount: 0 });
    assert.equal(computeEarnedReward(0).earnedUnits, 0, "a QIU of 0 earns nothing");
    assert.equal(computeEarnedReward(-1).earnedUnits, 0);
    assert.equal(computeEarnedReward(Number.NaN).earnedUnits, 0);
    assert.equal(computeEarnedReward(2).cashAmount, 0, "never cash");
  });
});

describe("rewards — recordEarnedReward (flag-gated, non-cash)", () => {
  it("is an inert no-op when the flag is off", async () => {
    const db = makeDb({ intel_rewards: false });
    const r = await recordEarnedReward(db as any, ACTOR, { qiu: 2, eligibility: ELIGIBLE, source: "outcome", ledgerVersion: "v1" });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "disabled");
    assert.equal(db._rows.length, 0);
  });
  it("refuses the ineligible with reasons and books nothing", async () => {
    const db = makeDb({ intel_rewards: true });
    const r = await recordEarnedReward(db as any, ACTOR, { qiu: 2, eligibility: { ...ELIGIBLE, fraudHold: true }, source: "outcome", ledgerVersion: "v1" });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "ineligible");
    assert.deepEqual((r as any).reasons, ["fraud_hold"]);
    assert.equal(db._rows.length, 0);
  });
  it("books a non-cash ledger entry for the eligible", async () => {
    const db = makeDb({ intel_rewards: true });
    const r = await recordEarnedReward(db as any, ACTOR, { qiu: 2, eligibility: ELIGIBLE, source: "outcome", ledgerVersion: "v1" });
    assert.equal(r.ok, true);
    assert.equal((r as any).earnedUnits, 2 * QIU_TO_CREDITS);
    assert.equal(db._rows.length, 1);
    assert.equal(db._rows[0].cash_amount, 0, "the ledger entry is never cash");
    assert.equal(db._rows[0].actor_id, ACTOR);
  });
});
