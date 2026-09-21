/**
 * `intel_rewards` is ON in production and its code names a column production
 * does not have.
 *
 * ── THE FINDING ─────────────────────────────────────────────────────────────
 * `scripts/checkFlagSchemaPrerequisites.ts` reports, against the committed
 * production snapshot:
 *
 *   NEW INSTANCE OF THE CLASS: intel_rewards is ON in production and its code
 *   names intel_reward_ledger.reverses_entry_id which production lacks.
 *
 * Both halves were checked rather than assumed. `reverses_entry_id` is created
 * by `migrations/2900_intel_reward_ledger_reversals.sql`, and 2900 appears
 * NOWHERE in `lib/capability/production-applied-migrations.json` — whose own
 * header says an entry must be committed in the same change that applies the
 * migration. So the repository's record is that production does not have the
 * column, while the snapshot's flag rows say `intel_rewards` is on.
 *
 * ── WHY "IT ALREADY FAILS CLOSED" IS NOT THE ANSWER ─────────────────────────
 * It does fail closed. `reverseEarnedReward` selects `reverses_entry_id` by
 * name, PostgREST answers 42703, the `readErr` branch is taken and nothing is
 * written. No money moves and no ledger row is booked — this is not a
 * correctness hole.
 *
 * It is a DIAGNOSIS hole, and this corpus has decided that question before: a
 * refusal that cannot say WHY is the defect. `db_error` says "the database
 * broke", and an operator reading it looks at connectivity, at grants, at the
 * ledger's health — at everything except the one true cause, which is that a
 * migration was never applied to the database the flag is on in. The same
 * distinction runs through this tree as deny-vs-unknown: ABSENT IS UNKNOWN,
 * NOT "NO REF"; an outage is not a finding; a refusal names what it refused.
 *
 * ── AND `isFlagEnabled` IS THE WRONG GATE ───────────────────────────────────
 * `lib/capability/registry.ts` states the contract: "`enabled` iff the flag is
 * `on` AND the schema is `ready`." A bare `isFlagEnabled` answers only the
 * first half, which is precisely the founding case that registry records —
 * `media_canonical_enabled` TRUE in production over a `media_assets` without
 * 2250's columns, every upsert PGRST204, every rejection swallowed, three
 * weeks. This is that shape again on the ledger.
 *
 * WHAT IS ASSERTED, and why each is separate:
 *  (1) The flag ON + the column ABSENT must refuse with a reason that names
 *      the SCHEMA. This is the one the checker's finding is about.
 *  (2) It must still write nothing. A fix that reported the right reason and
 *      then booked a row would be far worse than the bug.
 *  (3) The refusal must name the migration to apply, or the operator has a
 *      diagnosis and no action.
 *  (4) A genuine database fault must STILL be `db_error`. Without this, a fix
 *      that returned `schema_absent` unconditionally passes (1)-(3) while
 *      destroying the ability to see a real outage.
 *  (5) The flag OFF is still `disabled`, and must not probe the schema — a
 *      dark feature makes no database contact beyond the flag read.
 *  (6) The happy path is unchanged.
 *
 * Run: node --import tsx/esm --test src/test/rewardReversalSchemaCapability.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reverseEarnedReward } from "../services/ledger/RewardReversal.js";

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

/** Exactly what PostgREST answers for a column the table does not have. */
const UNDEFINED_COLUMN = {
  code: "42703",
  message: `column intel_reward_ledger.reverses_entry_id does not exist`,
  details: null,
  hint: null,
};

/** A real fault: the database is there, the schema is fine, the read failed. */
const REAL_FAULT = {
  code: "57014",
  message: "canceling statement due to statement timeout",
  details: null,
  hint: null,
};

interface Write { table: string; op: string; payload: unknown }

function fakeClient(opts: { flagOn?: boolean; ledgerError?: unknown } = {}) {
  const writes: Write[] = [];
  const reads: string[] = [];
  const flagOn = opts.flagOn !== false;
  const from = (t: string) => {
    const filters: Array<[string, unknown]> = [];
    const state: any = {
      _t: t, _payload: null as unknown,
      select(list?: string) { reads.push(`${t}:${list ?? "*"}`); return this; },
      eq(c: string, v: unknown) { filters.push([c, v]); return this; },
      insert(p: unknown) { this._payload = p; writes.push({ table: t, op: "insert", payload: p }); return this; },
      single() { return this; },
      maybeSingle() { return this; },
      async then(res: (v: unknown) => void) {
        if (t === "feature_flags") return res({ data: flagOn ? { enabled: true } : null, error: null });
        if (t !== "intel_reward_ledger") return res({ data: null, error: null });
        // The schema fault is a property of the TABLE, so it answers every
        // read of it — the capability probe and the by-id read alike. A fake
        // that failed only the one the test happens to care about would be
        // modelling the assertion rather than the database.
        if (opts.ledgerError) return res({ data: null, error: opts.ledgerError });
        if (state._payload !== null) return res({ data: { id: "rev-new", ...(state._payload as object) }, error: null });
        const byLink = filters.find(([c]) => c === "reverses_entry_id");
        if (byLink) return res({ data: null, error: null });
        return res({ data: ORIGINAL, error: null });
      },
    };
    return state;
  };
  return { client: { from }, writes, reads };
}

describe("reverseEarnedReward — a flag ON over an absent column", () => {
  it("(1) refuses with a reason that names the SCHEMA, not the database", async () => {
    const { client } = fakeClient({ ledgerError: UNDEFINED_COLUMN });
    const res = await reverseEarnedReward(client, {
      originalEntryId: ORIGINAL.id, reason: "attribution_contradicted",
    });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.notEqual(
      (res as any).reason, "db_error",
      "`db_error` sends the operator to look at a database that is perfectly healthy",
    );
    assert.equal((res as any).reason, "schema_absent");
  });

  it("(2) writes NOTHING", async () => {
    const { client, writes } = fakeClient({ ledgerError: UNDEFINED_COLUMN });
    await reverseEarnedReward(client, { originalEntryId: ORIGINAL.id, reason: "attribution_contradicted" });
    assert.deepEqual(writes, [], "a refusal that still books a row is worse than the bug");
  });

  it("(3) names the migration to apply", async () => {
    const { client } = fakeClient({ ledgerError: UNDEFINED_COLUMN });
    const res = await reverseEarnedReward(client, { originalEntryId: ORIGINAL.id, reason: "x" });
    assert.match(
      String((res as any).detail ?? ""), /2900/,
      "a diagnosis with no action is half a refusal",
    );
  });

  it("(4) a REAL database fault is still db_error", async () => {
    const { client } = fakeClient({ ledgerError: REAL_FAULT });
    const res = await reverseEarnedReward(client, { originalEntryId: ORIGINAL.id, reason: "x" });
    assert.equal(res.ok, false);
    assert.equal(
      (res as any).reason, "db_error",
      "collapsing every failure into `schema_absent` loses the outage this reason exists for",
    );
  });

  it("(5) the flag OFF is `disabled`, and the ledger is never touched", async () => {
    const { client, reads, writes } = fakeClient({ flagOn: false });
    const res = await reverseEarnedReward(client, { originalEntryId: ORIGINAL.id, reason: "x" });
    assert.equal((res as any).reason, "disabled");
    assert.deepEqual(writes, []);
    assert.equal(
      reads.filter((r) => r.startsWith("intel_reward_ledger")).length, 0,
      "a dark feature makes no database contact beyond the flag read",
    );
  });

  it("(6) the happy path is unchanged — a healthy schema still books the reversal", async () => {
    const { client, writes } = fakeClient();
    const res = await reverseEarnedReward(client, {
      originalEntryId: ORIGINAL.id, reason: "attribution_contradicted",
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    const row = writes.find((w) => w.op === "insert")?.payload as any;
    assert.equal(row.reverses_entry_id, ORIGINAL.id);
    assert.equal(row.earned_units, -80);
  });
});
