/**
 * intel_reward_ledger — "reversals are possible" (`09` §11), on the ledger the
 * product actually books contributor earnings to.
 *
 * ── THE VIOLATION THIS CLOSES ───────────────────────────────────────────────
 * `2170` grants service_role INSERT + SELECT only, so an entry is immutable —
 * correct, and the reason `09` §1.5 calls this "the one thing in the tree built
 * like a ledger". But `2170:38-39` also carry `CHECK (qiu >= 0)` and
 * `CHECK (earned_units >= 0)`. Immutable rows plus a non-negativity CHECK make a
 * COMPENSATING ENTRY STRUCTURALLY IMPOSSIBLE: there is no UPDATE, no DELETE, and
 * no representable opposite. A credit booked in error stands forever.
 *
 * That is not hypothetical here. `lib/intelRewardScheduler.ts` books a credit
 * when a contributor's observation reaches the SERVED live state, and skips any
 * contribution already in the ledger (the `alreadyRewarded` anti-join). With
 * `intel_outcome_attribution_enabled` ON, a traveller can afterwards report an
 * outcome that CONTRADICTS the served state — `classifyAttribution` returns
 * `"contradicted"` (`services/intel/RewardOracle.ts:142`). Today the credit for
 * a contribution later contradicted by the real world cannot be taken back,
 * because the table cannot express taking it back.
 *
 * Migration 2900 supersedes the two CHECKs with a SIGN-BY-ROLE constraint: an
 * ORIGINAL entry is still non-negative, and only a row that NAMES the entry it
 * reverses may be negative. Nothing becomes mutable; the reversal is a new row.
 * `CHECK (cash_amount = 0)` is untouched — reversing a non-cash credit is still
 * non-cash.
 *
 * Run: node --import tsx/esm --test src/test/creatorLedgerRewardReversal.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  reconstructRewardBalance,
  reverseEarnedReward,
} from "../services/ledger/RewardReversal.js";

const ORIGINAL = {
  id: "11111111-1111-4111-8111-111111111111",
  actor_id: "aaaaaaaa-1111-4111-8111-111111111111",
  source: "served",
  qiu: 0.8,
  earned_units: 80,
  cash_amount: 0,
  ledger_version: "intel-reward/v1",
  commercial_use_permission: true,
  idempotency_key: "observation:obs-1",
  reverses_entry_id: null,
};

interface Write { table: string; op: string; payload: any }

/**
 * A fake PostgREST client that models the parts that matter: the flag read, a
 * by-id select, and an INSERT that can raise a 23505 the way the partial unique
 * index on (reverses_entry_id) will.
 */
function fakeClient(opts: {
  flagOn?: boolean;
  row?: any | null;
  existingReversal?: any | null;
  insertError?: any;
  readError?: any;
} = {}) {
  const writes: Write[] = [];
  const flagOn = opts.flagOn !== false;
  const table = (t: string) => {
    const state: any = {
      _t: t, _filters: [] as Array<[string, any]>, _payload: null as any,
      select() { return this; },
      eq(c: string, v: any) { this._filters.push([c, v]); return this; },
      insert(p: any) { this._payload = p; writes.push({ table: t, op: "insert", payload: p }); return this; },
      single() { return this; },
      maybeSingle() { return this; },
      async then(res: (v: any) => void) {
        if (t === "feature_flags") return res({ data: flagOn ? { enabled: true } : null, error: null });
        if (t !== "intel_reward_ledger") return res({ data: null, error: null });
        if (this._payload !== null) {
          // An INSERT.
          if (opts.insertError) return res({ data: null, error: opts.insertError });
          return res({ data: { id: "rev-new", ...this._payload }, error: null });
        }
        // A SELECT. Distinguish the by-id read from the by-reversal-link read.
        const byLink = this._filters.find(([c]) => c === "reverses_entry_id");
        if (byLink) return res({ data: opts.existingReversal ?? null, error: opts.readError ?? null });
        return res({ data: opts.row === undefined ? ORIGINAL : opts.row, error: opts.readError ?? null });
      },
    };
    return state;
  };
  return { client: { from: table }, writes };
}

const inserted = (writes: Write[]) =>
  writes.find((w) => w.table === "intel_reward_ledger" && w.op === "insert")?.payload;

// ═══════════════════════════════════════════════════════════════════════════
// The reversal arm
// ═══════════════════════════════════════════════════════════════════════════
describe("reverseEarnedReward — a compensating entry is expressible", () => {
  it("appends a NEGATED row that names the entry it reverses", async () => {
    const { client, writes } = fakeClient();
    const res = await reverseEarnedReward(client, {
      originalEntryId: ORIGINAL.id, reason: "attribution_contradicted",
    });
    assert.equal(res.ok, true, JSON.stringify(res));

    const row = inserted(writes);
    assert.ok(row, "no compensating row written");
    assert.equal(row.reverses_entry_id, ORIGINAL.id, "an unlinked reversal is an unexplained entry");
    assert.equal(row.earned_units, -80);
    assert.equal(Number(row.qiu), -0.8);
    assert.equal(row.actor_id, ORIGINAL.actor_id, "the credit must come back off the SAME contributor");
  });

  it("keeps the non-cash boundary: a reversal is still cash_amount = 0", async () => {
    const { client, writes } = fakeClient();
    await reverseEarnedReward(client, { originalEntryId: ORIGINAL.id, reason: "attribution_contradicted" });
    assert.equal(inserted(writes).cash_amount, 0, "`2170:40` is not relaxed by 2900");
  });

  it("books the reversal under the ORIGINAL entry's ledger version", async () => {
    const { client, writes } = fakeClient();
    await reverseEarnedReward(client, { originalEntryId: ORIGINAL.id, reason: "attribution_contradicted" });
    assert.equal(inserted(writes).ledger_version, "intel-reward/v1",
      "a reversal is a fact about the computation it undoes, not about today's rules");
  });

  it("derives the idempotency key from the ENTRY, not the attempt", async () => {
    const a = fakeClient(), b = fakeClient();
    await reverseEarnedReward(a.client, { originalEntryId: ORIGINAL.id, reason: "attribution_contradicted" });
    await reverseEarnedReward(b.client, { originalEntryId: ORIGINAL.id, reason: "attribution_contradicted" });
    assert.equal(inserted(a.writes).idempotency_key, inserted(b.writes).idempotency_key);
    assert.equal(inserted(a.writes).idempotency_key, `reversal:${ORIGINAL.id}`);
  });

  it("records WHY, so a reversal is never an unexplained debit", async () => {
    const { client, writes } = fakeClient();
    await reverseEarnedReward(client, { originalEntryId: ORIGINAL.id, reason: "attribution_contradicted" });
    assert.match(inserted(writes).source, /attribution_contradicted/);
  });

  it("treats a unique violation as a REPLAY and returns the original reversal", async () => {
    const existing = { id: "rev-1", earned_units: -80, reverses_entry_id: ORIGINAL.id };
    const { client } = fakeClient({ insertError: { code: "23505" }, existingReversal: existing });
    const res = await reverseEarnedReward(client, {
      originalEntryId: ORIGINAL.id, reason: "attribution_contradicted",
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal((res as any).replayed, true, "a redelivered reversal must not double-debit");
    assert.equal((res as any).ledgerEntry.id, "rev-1");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The refusal arms
// ═══════════════════════════════════════════════════════════════════════════
describe("reverseEarnedReward — refusals", () => {
  it("is a fail-closed no-op while intel_rewards is off", async () => {
    const { client, writes } = fakeClient({ flagOn: false });
    const res = await reverseEarnedReward(client, { originalEntryId: ORIGINAL.id, reason: "x" });
    assert.equal(res.ok, false);
    assert.equal((res as any).reason, "disabled");
    assert.equal(writes.length, 0, "the off state must write nothing at all");
  });

  it("REFUSES when the entry it was asked to reverse does not exist", async () => {
    const { client, writes } = fakeClient({ row: null });
    const res = await reverseEarnedReward(client, { originalEntryId: ORIGINAL.id, reason: "x" });
    assert.equal(res.ok, false);
    assert.equal((res as any).reason, "not_found");
    assert.equal(writes.filter((w) => w.op === "insert").length, 0);
  });

  it("REFUSES to reverse a reversal — that re-credits money earned once", async () => {
    const { client, writes } = fakeClient({
      row: { ...ORIGINAL, earned_units: -80, qiu: -0.8, reverses_entry_id: "some-other-entry" },
    });
    const res = await reverseEarnedReward(client, { originalEntryId: ORIGINAL.id, reason: "x" });
    assert.equal(res.ok, false);
    assert.equal((res as any).reason, "not_reversible");
    assert.equal(writes.filter((w) => w.op === "insert").length, 0);
  });

  it("REFUSES a row that carries cash — this ledger never books platform cash", async () => {
    const { client, writes } = fakeClient({ row: { ...ORIGINAL, cash_amount: 5 } });
    const res = await reverseEarnedReward(client, { originalEntryId: ORIGINAL.id, reason: "x" });
    assert.equal(res.ok, false);
    assert.equal((res as any).reason, "not_reversible");
    assert.equal(writes.filter((w) => w.op === "insert").length, 0);
  });

  it("REFUSES without an id rather than guessing one", async () => {
    const { client, writes } = fakeClient();
    const res = await reverseEarnedReward(client, { originalEntryId: "", reason: "x" });
    assert.equal(res.ok, false);
    assert.equal((res as any).reason, "not_found");
    assert.equal(writes.length, 0);
  });

  it("surfaces a read failure as a db_error, never as 'nothing to reverse'", async () => {
    const { client } = fakeClient({ readError: { message: "permission denied" } });
    const res = await reverseEarnedReward(client, { originalEntryId: ORIGINAL.id, reason: "x" });
    assert.equal(res.ok, false);
    assert.equal((res as any).reason, "db_error");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The derived balance — "no balance depends on mutable totals" (`09` §11)
// ═══════════════════════════════════════════════════════════════════════════
describe("reconstructRewardBalance", () => {
  const rows = [
    { earned_units: 80, qiu: 0.8, reverses_entry_id: null },
    { earned_units: 20, qiu: 0.2, reverses_entry_id: null },
    { earned_units: -80, qiu: -0.8, reverses_entry_id: "11111111-1111-4111-8111-111111111111" },
  ];

  it("is a fold over the rows — never a stored total", () => {
    assert.equal(reconstructRewardBalance(rows).earnedUnits, 20);
  });

  it("is order-independent over every permutation", () => {
    const perms: typeof rows[] = [];
    const go = (acc: typeof rows, rest: typeof rows) => {
      if (rest.length === 0) { perms.push(acc); return; }
      rest.forEach((r, i) => go([...acc, r], [...rest.slice(0, i), ...rest.slice(i + 1)]));
    };
    go([], rows);
    assert.equal(perms.length, 6);
    for (const p of perms) assert.equal(reconstructRewardBalance(p).earnedUnits, 20);
  });

  it("counts reversed credits out, so a contradicted contribution nets to zero", () => {
    assert.equal(reconstructRewardBalance([rows[0], rows[2]]).earnedUnits, 0);
  });

  it("never reports a cash balance — cash_amount is 0 by CHECK", () => {
    assert.equal(reconstructRewardBalance(rows).cashAmount, 0);
  });
});
