/**
 * The reward WORKER must be able to take a credit back.
 *
 * ── THE PATH, NAMED ─────────────────────────────────────────────────────────
 * Worker: `lib/intelRewardScheduler.ts#runIntelRewardPass`, started by
 * `startIntelRewardScheduler()` and re-armed every 15 minutes. No route is
 * involved; this is the only autonomous earning loop in the tree.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * The pass books a credit the moment a contributor's observation reaches the
 * SERVED live state, then anti-joins it out of every later pass
 * (`alreadyRewarded`). With `intel_outcome_attribution_enabled` ON, a traveller
 * can afterwards report an outcome that CONTRADICTS the served state —
 * `classifyAttribution` returns `"contradicted"` — and the producer already
 * refuses to book a NEW credit in that case. What it could not do is undo one it
 * had already booked, for a structural reason: `2170:38-39`'s
 * `CHECK (qiu >= 0)` / `CHECK (earned_units >= 0)` plus INSERT+SELECT-only
 * grants leave no representable opposite. `09` §11 requires exactly that
 * ("reversals are possible").
 *
 * Migration 2900 makes the compensating entry expressible;
 * `services/ledger/RewardReversal.ts` writes it; this pins that the SHIPPING
 * WORKER actually reaches it.
 *
 * ── WHAT MUST NOT CHANGE ────────────────────────────────────────────────────
 * With the attribution flag OFF the pass has no contradiction signal at all, so
 * it must sweep nothing and behave byte-for-byte as before. That is asserted
 * here, not assumed.
 *
 * Run: node --import tsx/esm --test src/test/creatorLedgerRewardReversalSweep.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runIntelRewardPass } from "../lib/intelRewardScheduler.js";
import { ATTRIBUTION_FLAG } from "../lib/intelAttributionScheduler.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const SUBJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OBS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

interface Seed {
  flags: Record<string, boolean>;
  snapshots: any[];
  observations: any[];
  consent: any[];
  attributions?: any[];
  ledger?: any[];
}

/**
 * An in-memory PostgREST double that models BOTH uniqueness rules the reward
 * ledger carries after 2900: the partial unique on (actor_id, idempotency_key)
 * from 2180, and the partial unique on (reverses_entry_id) from 2900. Both
 * raise 23505, which is the only way the writers can tell a replay from a
 * failure.
 */
function makeDb(seed: Seed, opts: { hideReversalsFromReads?: boolean } = {}) {
  const tables: Record<string, any[]> = {
    feature_flags: Object.entries(seed.flags).map(([flag, enabled]) => ({ flag, enabled })),
    intel_state_snapshots: [...seed.snapshots],
    intel_observations: [...seed.observations],
    intel_contribution_consent: [...seed.consent],
    intel_attributions: [...(seed.attributions ?? [])],
    intel_reward_ledger: [...(seed.ledger ?? [])],
  };
  let seq = 0;

  function builder(table: string) {
    let op: "select" | "insert" | "insert_select" = "select";
    let payload: any = null;
    let single = false;
    const eqs: [string, any][] = [];
    const gts: [string, any][] = [];
    const ins: [string, any[]][] = [];
    // `.is(col, null)` — PostgREST's IS NULL. Needed since the reward pass began
    // resolving payees through lib/intelConsent, which asks the consent table
    // for `withdrawn_at IS NULL` rather than filtering afterwards. Without it
    // the builder threw, the payee map came back empty, and NOTHING was booked —
    // so every case here failed at its own setup assertion rather than on the
    // reversal behaviour it exists to test.
    const iss: [string, any][] = [];

    function readRows() {
      let rows = tables[table] ?? [];
      for (const [c, v] of eqs) rows = rows.filter((r) => r[c] === v);
      for (const [c, v] of gts) rows = rows.filter((r) => r[c] > v);
      for (const [c, vals] of ins) rows = rows.filter((r) => vals.includes(r[c]));
      for (const [c, v] of iss) rows = rows.filter((r) => (v === null ? r[c] == null : r[c] === v));
      return rows;
    }

    function run() {
      if (op === "insert" || op === "insert_select") {
        const store = tables[table];
        const key = payload?.idempotency_key ?? null;
        if (key !== null && store.some((r) => r.actor_id === payload.actor_id && r.idempotency_key === key)) {
          return { data: null, error: { code: "23505", message: "intel_reward_ledger_actor_idempotency" } };
        }
        const rev = payload?.reverses_entry_id ?? null;
        if (rev !== null && store.some((r) => r.reverses_entry_id === rev)) {
          return { data: null, error: { code: "23505", message: "intel_reward_ledger_one_reversal_per_entry" } };
        }
        const row = { id: `r-${++seq}`, created_at: "t", reverses_entry_id: null, ...payload };
        store.push(row);
        return { data: op === "insert_select" ? row : null, error: null };
      }
      let rows = readRows();
      // A STALE ANTI-JOIN READ. The pass reads the ledger once, then writes; a
      // concurrent pass can therefore act on a snapshot that predates a
      // reversal another pass has already committed. Modelled here so the
      // at-most-once guarantee is proved to live in the DATABASE index
      // (23505 → replay), not in the in-process `alreadyReversed` set.
      // Narrow deliberately: ONLY the bulk anti-join read (`.in("actor_id", …)`)
      // is made stale. The writer's own by-link replay lookup
      // (`.eq("reverses_entry_id", …)`) still sees the truth, because in
      // production that read happens AFTER the 23505 and therefore after the
      // committed row exists.
      if (opts.hideReversalsFromReads && table === "intel_reward_ledger" && op === "select"
          && ins.some(([c]) => c === "actor_id")) {
        rows = rows.filter((r) => r.reverses_entry_id == null);
      }
      if (single) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    }

    const b: any = {
      select() { if (op === "insert") op = "insert_select"; return b; },
      insert(row: any) { op = "insert"; payload = row; return b; },
      eq(c: string, v: any) { eqs.push([c, v]); return b; },
      gt(c: string, v: any) { gts.push([c, v]); return b; },
      in(c: string, vals: any[]) { ins.push([c, vals]); return b; },
      is(c: string, v: any) { iss.push([c, v]); return b; },
      limit() { return b; },
      maybeSingle() { single = true; return Promise.resolve(run()); },
      single() { single = true; return Promise.resolve(run()); },
      then(resolve: (r: any) => any) { return Promise.resolve(run()).then(resolve); },
    };
    return b;
  }
  return { _tables: tables, from: (t: string) => builder(t) };
}

const ATTR = (o: Partial<any> = {}) => ({
  observation_id: OBS, contradiction: false, outcome_score: 0.9, ...o,
});

function world(overrides: Partial<Seed> = {}): Seed {
  return {
    flags: { intel_rewards: true, [ATTRIBUTION_FLAG]: true },
    snapshots: [{
      subject_id: SUBJECT, zone_id: null, claim_type: "crowd.level",
      confidence: 0.8, privacy_eligible: true, expires_at: "2999-01-01T00:00:00Z",
    }],
    observations: [{
      id: OBS, actor_id: ACTOR, subject_id: SUBJECT, zone_id: null,
      claim_type: "crowd.level", moderation_state: "allowed",
    }],
    consent: [{ user_id: ACTOR, enabled: true, withdrawn_at: null }],
    ...overrides,
  };
}

const ledgerOf = (db: any) => db._tables.intel_reward_ledger as any[];
const balance = (db: any) => ledgerOf(db).reduce((n, r) => n + Number(r.earned_units ?? 0), 0);

// ═══════════════════════════════════════════════════════════════════════════
describe("reward pass — the reversal sweep", () => {
  it("reverses a credit whose outcome LATER contradicts the served state", async () => {
    // Pass 1: a finalized, non-contradicting outcome. The credit is booked.
    const db = makeDb(world({ attributions: [ATTR()] }));
    const first = await runIntelRewardPass({ client: db });
    assert.equal(first.booked, 1, "setup: the credit must actually be booked");
    const original = ledgerOf(db)[0];
    assert.ok(balance(db) > 0);

    // The world then contradicts it.
    db._tables.intel_attributions.push(ATTR({ outcome_score: 0.1, contradiction: true }));

    // Pass 2: the credit comes back off.
    const second = await runIntelRewardPass({ client: db });
    assert.equal(second.reversed, 1, "a contradicted, already-booked credit must be compensated");
    assert.equal(ledgerOf(db).length, 2, "a reversal is a NEW ROW — never an edit or a delete");
    const rev = ledgerOf(db).find((r) => r.reverses_entry_id != null);
    assert.ok(rev, "no compensating row");
    assert.equal(rev.reverses_entry_id, original.id);
    assert.equal(rev.earned_units, -original.earned_units);
    assert.equal(rev.cash_amount, 0, "non-cash in both directions");
    assert.equal(balance(db), 0, "the derived balance is back where it started");
  });

  it("leaves the ORIGINAL row untouched — the history is still readable", async () => {
    const db = makeDb(world({ attributions: [ATTR()] }));
    await runIntelRewardPass({ client: db });
    const before = JSON.stringify(ledgerOf(db)[0]);
    db._tables.intel_attributions.push(ATTR({ contradiction: true }));
    await runIntelRewardPass({ client: db });
    assert.equal(JSON.stringify(ledgerOf(db)[0]), before,
      "`2277:36-40`: a correction is a new row under a new version, never a rewrite");
  });

  it("does NOT reverse twice, however many passes run", async () => {
    const db = makeDb(world({ attributions: [ATTR()] }));
    await runIntelRewardPass({ client: db });
    db._tables.intel_attributions.push(ATTR({ contradiction: true }));
    await runIntelRewardPass({ client: db });
    const third = await runIntelRewardPass({ client: db });
    const fourth = await runIntelRewardPass({ client: db });
    assert.equal(ledgerOf(db).length, 2, "reversing twice re-debits an earning that existed once");
    assert.equal(third.reversed, 0);
    assert.equal(fourth.reversed, 0);
    assert.equal(balance(db), 0);
  });

  it("does not double-debit even when the anti-join read is STALE", async () => {
    // The in-process `alreadyReversed` set is an efficiency filter, not the
    // safety net — exactly as the module says of `alreadyRewarded`. The real
    // guarantee is 2900's partial unique index on reverses_entry_id: a second
    // attempt raises 23505 and RewardReversal treats it as a REPLAY. Here the
    // reversal is hidden from every ledger SELECT, so the guard cannot fire and
    // only the index can save the balance.
    const db = makeDb(world({ attributions: [ATTR()] }), { hideReversalsFromReads: true });
    await runIntelRewardPass({ client: db });
    db._tables.intel_attributions.push(ATTR({ contradiction: true }));

    const second = await runIntelRewardPass({ client: db });
    assert.equal(second.reversed, 1);
    const third = await runIntelRewardPass({ client: db });

    assert.equal(ledgerOf(db).length, 2, "the index must refuse the second compensating entry");
    assert.equal(third.reversed, 0, "a REPLAY is not a new reversal and must not be counted as one");
    assert.equal(balance(db), 0, "the balance must not be debited twice");
  });

  it("does NOT reverse a credit whose attribution is still good", async () => {
    const db = makeDb(world({ attributions: [ATTR()] }));
    await runIntelRewardPass({ client: db });
    const second = await runIntelRewardPass({ client: db });
    assert.equal(second.reversed, 0);
    assert.equal(ledgerOf(db).length, 1);
    assert.ok(balance(db) > 0, "a correct contribution keeps its credit");
  });

  it("does NOT reverse when the attribution row simply goes absent", async () => {
    // Absence of evidence is not evidence of absence (ROADMAP's governing
    // invariant). A missing attribution row is an unfinalized outcome, not a
    // contradiction, and must never trigger a debit.
    const db = makeDb(world({ attributions: [ATTR()] }));
    await runIntelRewardPass({ client: db });
    db._tables.intel_attributions.length = 0;
    const second = await runIntelRewardPass({ client: db });
    assert.equal(second.reversed, 0);
    assert.equal(ledgerOf(db).length, 1);
  });

  it("sweeps NOTHING while the attribution flag is OFF — no signal, no debit", async () => {
    const db = makeDb(world({
      flags: { intel_rewards: true, [ATTRIBUTION_FLAG]: false },
      attributions: [ATTR({ contradiction: true })],
    }));
    const first = await runIntelRewardPass({ client: db });
    assert.equal(first.booked, 1, "flag off: the pre-I4a oracle books off the served snapshot");
    const second = await runIntelRewardPass({ client: db });
    assert.equal(second.reversed, 0, "with the closed loop off there is no contradiction signal to act on");
    assert.equal(ledgerOf(db).length, 1);
  });

  it("sweeps NOTHING while intel_rewards is off — fail-closed, no reads, no writes", async () => {
    const db = makeDb(world({
      flags: { intel_rewards: false, [ATTRIBUTION_FLAG]: true },
      attributions: [ATTR({ contradiction: true })],
      ledger: [{
        id: "pre-existing", actor_id: ACTOR, earned_units: 80, qiu: 0.8, cash_amount: 0,
        ledger_version: "intel-reward/v1", idempotency_key: `observation:${OBS}`,
        reverses_entry_id: null, commercial_use_permission: true,
      }],
    }));
    const r = await runIntelRewardPass({ client: db });
    assert.equal(r.skipped, true);
    assert.equal(r.reason, "disabled");
    assert.equal(r.reversed, 0);
    assert.equal(ledgerOf(db).length, 1, "the off state writes nothing at all");
  });

  it("reports the reversal in the pass result, so a silent sweep is impossible", async () => {
    const db = makeDb(world({ attributions: [ATTR()] }));
    await runIntelRewardPass({ client: db });
    db._tables.intel_attributions.push(ATTR({ contradiction: true }));
    const r = await runIntelRewardPass({ client: db });
    assert.equal(typeof r.reversed, "number");
    assert.equal(r.reversed, 1);
  });
});
