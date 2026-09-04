/**
 * IG-10 reward PRODUCER + eligibility ORACLE — the driver that makes
 * intel_reward_ledger stop being dead code.
 *
 * Mutation-proves:
 *   (a) the ORACLE derives eligibility from seeded DB state, not caller input —
 *       withdrawn consent, a suppressed observation, or a non-served snapshot each
 *       flip the outcome, driven only by the row's real fields;
 *   (b) the PRODUCER books exactly ONE ledger row for a qualifying served
 *       contribution and ZERO on a second run (idempotent per observation);
 *   (c) it writes NOTHING when the flag is off, when eligibility fails, or when the
 *       served snapshot has no positive confidence.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRewardEligibilityContext,
  candidateQiu,
  classifyAttribution,
  evaluateCandidate,
  CURRENT_REWARD_LEDGER_VERSION,
  type EarningCandidate,
} from "../services/intel/RewardOracle.js";
import { ATTRIBUTION_FLAG } from "../lib/intelAttributionScheduler.js";
import { QIU_TO_CREDITS } from "../lib/rewardEarnings.js";
import { runIntelRewardPass } from "../lib/intelRewardScheduler.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const ACTOR2 = "22222222-2222-4222-8222-222222222222";
const SUBJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OBS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const SERVED_CANDIDATE: EarningCandidate = {
  actorId: ACTOR, observationId: OBS,
  served: true, servedConfidence: 0.8, outcomeAttribution: "not_required",
  moderationState: "allowed", consentEnabled: true, consentWithdrawn: false,
};

// ── A small in-memory Supabase double covering the producer's reads + the
//    ledger insert (with the partial-unique idempotency behaviour). ───────────
interface Seed {
  flags: Record<string, boolean>;
  snapshots: any[];
  observations: any[];
  consent: any[];
  /** I4a attribution ledger rows (intel_attributions) — the honest oracle's input. */
  attributions?: any[];
}
function makeDb(seed: Seed) {
  const flags = seed.flags;
  const tables: Record<string, any[]> = {
    feature_flags: Object.entries(flags).map(([flag, enabled]) => ({ flag, enabled })),
    intel_state_snapshots: [...seed.snapshots],
    intel_observations: [...seed.observations],
    intel_contribution_consent: [...seed.consent],
    intel_reward_ledger: [],
    intel_attributions: [...(seed.attributions ?? [])],
  };
  let seq = 0;

  function builder(table: string) {
    let op: "select" | "insert" | "insert_select" = "select";
    let payload: any = null;
    let single = false;
    const eqs: [string, any][] = [];
    const gts: [string, any][] = [];
    const ins: [string, any[]][] = [];

    function readRows() {
      let rows = tables[table] ?? [];
      for (const [c, v] of eqs) rows = rows.filter((r) => r[c] === v);
      for (const [c, v] of gts) rows = rows.filter((r) => r[c] > v);
      for (const [c, vals] of ins) rows = rows.filter((r) => vals.includes(r[c]));
      return rows;
    }

    function run() {
      if (op === "insert" || op === "insert_select") {
        const store = tables[table];
        const key = payload?.idempotency_key ?? null;
        if (key !== null && store.some((r) => r.actor_id === payload.actor_id && r.idempotency_key === key)) {
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        }
        const row = { id: `r-${++seq}`, created_at: "t", ...payload };
        store.push(row);
        return { data: op === "insert_select" ? row : null, error: null };
      }
      const rows = readRows();
      if (single) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    }

    const b: any = {
      select() { if (op === "insert") op = "insert_select"; return b; },
      insert(row: any) { op = "insert"; payload = row; return b; },
      eq(c: string, v: any) { eqs.push([c, v]); return b; },
      gt(c: string, v: any) { gts.push([c, v]); return b; },
      in(c: string, vals: any[]) { ins.push([c, vals]); return b; },
      limit() { return b; },
      maybeSingle() { single = true; return Promise.resolve(run()); },
      single() { single = true; return Promise.resolve(run()); },
      then(resolve: (r: any) => any) { return Promise.resolve(run()).then(resolve); },
    };
    return b;
  }

  return { _tables: tables, from: (t: string) => builder(t) };
}

function servedWorld(overrides: Partial<Seed> = {}): Seed {
  return {
    flags: { intel_rewards: true },
    snapshots: [{ subject_id: SUBJECT, zone_id: null, claim_type: "crowd.level", confidence: 0.8, privacy_eligible: true, expires_at: "2999-01-01T00:00:00Z" }],
    observations: [{ id: OBS, actor_id: ACTOR, subject_id: SUBJECT, zone_id: null, claim_type: "crowd.level", moderation_state: "allowed", observed_at: "2026-08-31T00:00:00Z" }],
    consent: [{ user_id: ACTOR, enabled: true, withdrawn_at: null }],
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
describe("reward oracle — eligibility is DERIVED from real state, not caller input", () => {
  it("a served, consented, admissible candidate is eligible", () => {
    const ctx = buildRewardEligibilityContext(SERVED_CANDIDATE);
    assert.deepEqual(ctx, {
      outcomeFinalized: true, commercialUsePermission: true, fundingSourceKnown: true,
      ledgerVersion: CURRENT_REWARD_LEDGER_VERSION, fraudHold: false,
    });
    assert.equal(evaluateCandidate(SERVED_CANDIDATE).eligible, true);
  });

  it("a NON-served snapshot ⇒ outcome not finalized (from state)", () => {
    const r = evaluateCandidate({ ...SERVED_CANDIDATE, served: false });
    assert.equal(r.eligible, false);
    assert.deepEqual(r.reasons, ["outcome_not_finalized"]);
  });

  it("WITHDRAWN consent ⇒ no commercial-use permission (from state)", () => {
    const r = evaluateCandidate({ ...SERVED_CANDIDATE, consentWithdrawn: true });
    assert.equal(r.eligible, false);
    assert.deepEqual(r.reasons, ["no_commercial_use_permission"]);
  });

  it("a SUPPRESSED moderation state ⇒ fraud hold (from state)", () => {
    for (const m of ["restricted", "blocked", "removed"]) {
      const r = evaluateCandidate({ ...SERVED_CANDIDATE, moderationState: m });
      assert.equal(r.eligible, false, `${m} should hold`);
      assert.deepEqual(r.reasons, ["fraud_hold"]);
    }
  });

  it("QIU is the served confidence, 0 when absent/non-positive (fail-closed)", () => {
    assert.equal(candidateQiu(SERVED_CANDIDATE), 0.8);
    assert.equal(candidateQiu({ ...SERVED_CANDIDATE, servedConfidence: null }), 0);
    assert.equal(candidateQiu({ ...SERVED_CANDIDATE, servedConfidence: 0 }), 0);
    assert.equal(candidateQiu({ ...SERVED_CANDIDATE, servedConfidence: Number.NaN }), 0);
  });
});

describe("reward producer — books earnings from served state, idempotently", () => {
  it("books exactly ONE ledger row for a qualifying served contribution, ZERO on re-run", async () => {
    const db = makeDb(servedWorld());
    const first = await runIntelRewardPass({ client: db });
    assert.equal(first.reason, null);
    assert.equal(first.booked, 1, "one contribution booked");
    assert.equal(db._tables.intel_reward_ledger.length, 1);

    const row = db._tables.intel_reward_ledger[0];
    assert.equal(row.actor_id, ACTOR);
    assert.equal(row.cash_amount, 0, "never cash");
    assert.equal(row.earned_units, Math.round(0.8 * QIU_TO_CREDITS));
    assert.equal(row.idempotency_key, `observation:${OBS}`);
    assert.equal(row.ledger_version, CURRENT_REWARD_LEDGER_VERSION);

    // Second run: the anti-join skips the already-booked contribution, so it is not
    // even reconsidered — zero new rows.
    const second = await runIntelRewardPass({ client: db });
    assert.equal(second.booked, 0, "no double-credit on re-run");
    assert.equal(second.candidates, 0, "already-rewarded contribution is not reconsidered");
    assert.equal(db._tables.intel_reward_ledger.length, 1, "still exactly one row");
  });

  it("books each distinct contributor once", async () => {
    const db = makeDb(servedWorld({
      observations: [
        { id: OBS, actor_id: ACTOR, subject_id: SUBJECT, zone_id: null, claim_type: "crowd.level", moderation_state: "allowed", observed_at: "t" },
        { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", actor_id: ACTOR2, subject_id: SUBJECT, zone_id: null, claim_type: "crowd.level", moderation_state: "allowed", observed_at: "t" },
      ],
      consent: [
        { user_id: ACTOR, enabled: true, withdrawn_at: null },
        { user_id: ACTOR2, enabled: true, withdrawn_at: null },
      ],
    }));
    const r = await runIntelRewardPass({ client: db });
    assert.equal(r.booked, 2);
    assert.equal(db._tables.intel_reward_ledger.length, 2);
  });
});

describe("reward producer — writes NOTHING when it must not", () => {
  it("flag off ⇒ inert no-op (no scan, no writes)", async () => {
    const db = makeDb(servedWorld({ flags: { intel_rewards: false } }));
    const r = await runIntelRewardPass({ client: db });
    assert.equal(r.reason, "disabled");
    assert.equal(r.booked, 0);
    assert.equal(db._tables.intel_reward_ledger.length, 0);
  });

  it("withdrawn consent ⇒ ineligible, nothing booked", async () => {
    const db = makeDb(servedWorld({ consent: [{ user_id: ACTOR, enabled: true, withdrawn_at: "2026-08-30T00:00:00Z" }] }));
    const r = await runIntelRewardPass({ client: db });
    assert.equal(r.ineligible, 1);
    assert.equal(r.booked, 0);
    assert.equal(db._tables.intel_reward_ledger.length, 0);
  });

  it("a suppressed observation earns nothing off a served snapshot", async () => {
    const db = makeDb(servedWorld({ observations: [{ id: OBS, actor_id: ACTOR, subject_id: SUBJECT, zone_id: null, claim_type: "crowd.level", moderation_state: "blocked", observed_at: "t" }] }));
    const r = await runIntelRewardPass({ client: db });
    assert.equal(r.ineligible, 1);
    assert.equal(db._tables.intel_reward_ledger.length, 0);
  });

  it("no served snapshot ⇒ no candidates, no writes", async () => {
    const db = makeDb(servedWorld({ snapshots: [] }));
    const r = await runIntelRewardPass({ client: db });
    assert.equal(r.candidates, 0);
    assert.equal(db._tables.intel_reward_ledger.length, 0);
  });

  it("served but zero-confidence snapshot ⇒ no earning booked", async () => {
    const db = makeDb(servedWorld({ snapshots: [{ subject_id: SUBJECT, zone_id: null, claim_type: "crowd.level", confidence: 0, privacy_eligible: true, expires_at: "2999-01-01T00:00:00Z" }] }));
    const r = await runIntelRewardPass({ client: db });
    assert.equal(r.candidates, 1, "it is a candidate");
    assert.equal(r.booked, 0, "but earns nothing with no realized confidence");
    assert.equal(db._tables.intel_reward_ledger.length, 0);
  });

  it("an observation NOT behind a served snapshot is ignored", async () => {
    const db = makeDb(servedWorld({
      observations: [{ id: OBS, actor_id: ACTOR, subject_id: SUBJECT, zone_id: null, claim_type: "queue.wait", moderation_state: "allowed", observed_at: "t" }],
    }));
    const r = await runIntelRewardPass({ client: db });
    assert.equal(r.candidates, 0, "its (subject,zone,type) has no served snapshot");
    assert.equal(db._tables.intel_reward_ledger.length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// I4a — the HONEST oracle: a finalized attribution row, not "served snapshot exists"
// ═══════════════════════════════════════════════════════════════════════════
const ATTR = (over: Record<string, unknown> = {}) => ({
  observation_id: OBS, actor_id: ACTOR, outcome: "same", outcome_score: 1, contradiction: false, ...over,
});

describe("reward oracle — outcomeAttribution is part of outcomeFinalized (I4a)", () => {
  it("classifyAttribution: absent / ungraded / finalized / contradicted, contradiction never outvoted", () => {
    assert.equal(classifyAttribution([]), "absent");
    assert.equal(classifyAttribution([{ contradiction: false, outcome_score: null }]), "ungraded", "did_not_go only");
    assert.equal(classifyAttribution([{ contradiction: false, outcome_score: 1 }]), "finalized");
    assert.equal(classifyAttribution([{ contradiction: false, outcome_score: "0.85" }]), "finalized", "PostgREST numeric string");
    assert.equal(classifyAttribution([{ contradiction: false, outcome_score: 1 }, { contradiction: false, outcome_score: 1 }, { contradiction: true, outcome_score: 0.1 }]), "contradicted");
  });
  it("not_required (loop OFF) ⇒ served alone finalizes — the pre-I4a oracle, unchanged", () => {
    assert.equal(buildRewardEligibilityContext({ ...SERVED_CANDIDATE, outcomeAttribution: "not_required" }).outcomeFinalized, true);
    assert.equal(buildRewardEligibilityContext({ ...SERVED_CANDIDATE, outcomeAttribution: "not_required", served: false }).outcomeFinalized, false);
  });
  it("loop ON ⇒ only a finalized attribution finalizes; absent/ungraded/contradicted do not, even when served", () => {
    assert.equal(buildRewardEligibilityContext({ ...SERVED_CANDIDATE, outcomeAttribution: "finalized" }).outcomeFinalized, true);
    for (const a of ["absent", "ungraded", "contradicted"] as const) {
      const r = evaluateCandidate({ ...SERVED_CANDIDATE, outcomeAttribution: a });
      assert.equal(r.eligible, false, a);
      assert.deepEqual(r.reasons, ["outcome_not_finalized"], a);
    }
    assert.equal(buildRewardEligibilityContext({ ...SERVED_CANDIDATE, outcomeAttribution: "finalized", served: false }).outcomeFinalized, false, "an attribution cannot outrank served-ness");
  });
});

describe("reward producer — honest oracle, both flag states", () => {
  it("attribution flag OFF ⇒ books off the served snapshot exactly as before; the ledger is not read", async () => {
    const db = makeDb(servedWorld({ flags: { intel_rewards: true, [ATTRIBUTION_FLAG]: false } }));
    const r = await runIntelRewardPass({ client: db });
    assert.equal(r.booked, 1);
    assert.equal(db._tables.intel_reward_ledger.length, 1);
  });

  it("attribution flag ON + no attribution row ⇒ ineligible, nothing booked, reconsidered next pass", async () => {
    const db = makeDb(servedWorld({ flags: { intel_rewards: true, [ATTRIBUTION_FLAG]: true } }));
    const r = await runIntelRewardPass({ client: db });
    assert.equal(r.candidates, 1);
    assert.equal(r.ineligible, 1);
    assert.equal(r.booked, 0);
    assert.equal(db._tables.intel_reward_ledger.length, 0);
    // Still a candidate on the next pass (nothing was booked, nothing anti-joined).
    const again = await runIntelRewardPass({ client: db });
    assert.equal(again.candidates, 1);
  });

  it("attribution flag ON + a finalized, non-contradicting, graded row ⇒ books exactly once", async () => {
    const db = makeDb(servedWorld({ flags: { intel_rewards: true, [ATTRIBUTION_FLAG]: true }, attributions: [ATTR()] }));
    const r = await runIntelRewardPass({ client: db });
    assert.equal(r.booked, 1);
    assert.equal(db._tables.intel_reward_ledger.length, 1);
    assert.equal(db._tables.intel_reward_ledger[0].idempotency_key, `observation:${OBS}`);
    const again = await runIntelRewardPass({ client: db });
    assert.equal(again.booked, 0); assert.equal(db._tables.intel_reward_ledger.length, 1);
  });

  it("attribution flag ON + a contradiction ⇒ never booked, even beside successes", async () => {
    const db = makeDb(servedWorld({
      flags: { intel_rewards: true, [ATTRIBUTION_FLAG]: true },
      attributions: [ATTR(), ATTR({ outcome: "worse", outcome_score: 0.1, contradiction: true })],
    }));
    const r = await runIntelRewardPass({ client: db });
    assert.equal(r.ineligible, 1); assert.equal(r.booked, 0);
    assert.equal(db._tables.intel_reward_ledger.length, 0);
  });

  it("attribution flag ON + only did_not_go (ungraded) ⇒ not finalized, nothing booked", async () => {
    const db = makeDb(servedWorld({
      flags: { intel_rewards: true, [ATTRIBUTION_FLAG]: true },
      attributions: [ATTR({ outcome: "did_not_go", outcome_score: null })],
    }));
    const r = await runIntelRewardPass({ client: db });
    assert.equal(r.ineligible, 1); assert.equal(r.booked, 0);
    assert.equal(db._tables.intel_reward_ledger.length, 0);
  });

  it("attribution rows for ANOTHER observation do not finalize this one", async () => {
    const db = makeDb(servedWorld({
      flags: { intel_rewards: true, [ATTRIBUTION_FLAG]: true },
      attributions: [ATTR({ observation_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" })],
    }));
    const r = await runIntelRewardPass({ client: db });
    assert.equal(r.ineligible, 1); assert.equal(db._tables.intel_reward_ledger.length, 0);
  });
});
