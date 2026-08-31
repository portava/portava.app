/**
 * Account deletion — intel_mission_candidates.accepted_by (IG residual identifier)
 *
 * Under test: services/accountDeletion/AccountDeletionService.ts
 *
 * THE DEFECT this proves is closed:
 *   intel_mission_candidates.accepted_by (migration 2167) is declared
 *   `uuid REFERENCES profiles(id) ON DELETE SET NULL`. The SET NULL never fires,
 *   because executeAccountDeletion keeps an anonymised TOMBSTONE profile rather
 *   than deleting profiles(id) — so a departed user's uuid would survive in
 *   accepted_by as a residual identifier in an ops record. The service now
 *   performs the SET NULL by hand (step `null_intel_mission_accepted_by`).
 *
 * The mock APPLIES the update to seeded rows, so the property proven is literal:
 * the accepting user's row is NULLed, and a DIFFERENT user's row is untouched.
 * Mutation proof: delete the `null_intel_mission_accepted_by` step from
 * AccountDeletionService and the "row is now NULL" assertion goes RED (the update
 * op never runs, so the seeded uuid survives).
 *
 * Run: node --import tsx/esm --test src/test/accountDeletionAcceptedBy.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeAccountDeletion } from "../services/accountDeletion/AccountDeletionService.js";
import { ANONYMISED_FK_NULLED } from "../lib/deletionDispositions.js";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "22222222-2222-2222-2222-222222222222";

interface Op { table: string; op: string; filters: any[]; values?: any }

/**
 * A fake supabase client that, unlike the record-only client used elsewhere,
 * APPLIES `.update(...).eq(...)` to an in-memory store so row-level effects are
 * observable. Everything else (select/delete/rpc/storage/auth) returns success
 * so executeAccountDeletion runs to completion.
 */
function makeClient(seed: Record<string, any[]> = {}) {
  const store: Record<string, any[]> = {};
  for (const [t, rows] of Object.entries(seed)) store[t] = rows.map((r) => ({ ...r }));
  const ops: Op[] = [];
  const authDeleted: string[] = [];

  function builder(table: string) {
    const q: any = {
      _op: "select",
      _filters: [] as any[],
      _values: undefined as any,
      _single: false,
      _limit: undefined as number | undefined,
      select() { q._op = "select"; return q; },
      delete() { q._op = "delete"; return q; },
      update(v: any) { q._op = "update"; q._values = v; return q; },
      upsert(v: any) { q._op = "upsert"; q._values = v; return q; },
      insert(v: any) { q._op = "insert"; q._values = v; return q; },
      eq(c: string, v: any) { q._filters.push(["eq", c, v]); return q; },
      neq(c: string, v: any) { q._filters.push(["neq", c, v]); return q; },
      not(c: string, op: string, v: any) { q._filters.push(["not", c, op, v]); return q; },
      lte(c: string, v: any) { q._filters.push(["lte", c, v]); return q; },
      in(c: string, v: any[]) { q._filters.push(["in", c, v]); return q; },
      or(expr: string) { q._filters.push(["or", expr]); return q; },
      order() { return q; },
      limit(n: number) { q._limit = n; return q; },
      maybeSingle() { q._single = true; return q._run(); },
      then(resolve: any, reject: any) { return q._run().then(resolve, reject); },
      _run() {
        ops.push({ table, op: q._op, filters: q._filters, values: q._values });
        const rows = store[table] ?? [];
        if (q._op === "update") {
          const eqs = q._filters.filter((f: any[]) => f[0] === "eq");
          for (const row of rows) {
            if (eqs.every(([, c, v]: any[]) => row[c] === v)) Object.assign(row, q._values);
          }
        }
        let data: any = rows;
        if (q._limit) data = data.slice(0, q._limit);
        if (q._single) data = data.length > 0 ? data[0] : null;
        return Promise.resolve({ data, error: null });
      },
    };
    return q;
  }

  return {
    _ops: ops,
    _store: store,
    _authDeleted: authDeleted,
    from: (t: string) => builder(t),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      ops.push({ table: `rpc:${fn}`, op: "rpc", filters: [], values: args });
      return { data: null, error: null };
    },
    storage: {
      from: () => ({ remove: async (paths: string[]) => ({ data: paths.map((p) => ({ name: p })), error: null }) }),
    },
    auth: {
      admin: {
        deleteUser: async (id: string) => { authDeleted.push(id); return { data: {}, error: null }; },
      },
    },
  };
}

const opFor = (c: any, table: string, op: string) =>
  c._ops.find((o: Op) => o.table === table && o.op === op);

describe("executeAccountDeletion — intel_mission_candidates.accepted_by", () => {
  it("NULLs the accepting user's accepted_by and leaves a different user's row untouched", async () => {
    const c = makeClient({
      intel_mission_candidates: [
        { id: "m-own",   accepted_by: USER_ID,  status: "accepted" },
        { id: "m-other", accepted_by: OTHER_ID, status: "accepted" },
        { id: "m-free",  accepted_by: null,     status: "candidate" },
      ],
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: "admin-1" });
    assert.equal(out.ok, true, JSON.stringify(out.steps));

    const rows = c._store.intel_mission_candidates as any[];
    const own = rows.find((r) => r.id === "m-own")!;
    const other = rows.find((r) => r.id === "m-other")!;
    const free = rows.find((r) => r.id === "m-free")!;

    // The departed user's residual identifier is gone (this is the mutation anchor:
    // without the deletion step, no update runs and own.accepted_by stays USER_ID).
    assert.equal(own.accepted_by, null, "the deleted user's accepted_by must be NULLed");
    // A DIFFERENT user's accepted mission is untouched.
    assert.equal(other.accepted_by, OTHER_ID, "another user's accepted_by must NOT change");
    // An already-free candidate is untouched.
    assert.equal(free.accepted_by, null);
    // The row itself is retained — this is a SET NULL, not a row erasure.
    assert.equal(own.status, "accepted", "the ops row must be kept, only the identifier removed");
  });

  it("runs the null_intel_mission_accepted_by step, scoped to the user by accepted_by, as a SET NULL", async () => {
    const c = makeClient();
    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.ok, true, JSON.stringify(out.steps));

    const upd = opFor(c, "intel_mission_candidates", "update");
    assert.ok(upd, "the cascade must UPDATE intel_mission_candidates");
    assert.deepEqual(upd!.values, { accepted_by: null }, "it must SET accepted_by = NULL, not delete the row");
    assert.deepEqual(upd!.filters, [["eq", "accepted_by", USER_ID]],
      "the update must be scoped to rows this user accepted, by accepted_by");

    assert.ok(out.steps.some((s) => s.step === "null_intel_mission_accepted_by" && s.ok),
      "the null_intel_mission_accepted_by step must run and succeed");
    // It is never a DELETE on this table.
    assert.equal(opFor(c, "intel_mission_candidates", "delete"), undefined,
      "the mission-candidate row must be retained, not deleted");
  });

  it("surfaces a warning (non-fatal) when the SET NULL fails, matching the surrounding intel steps", async () => {
    // Override intel_mission_candidates.update to error, like the reward-ledger /
    // consent steps: a failure records its step and warns, but never aborts the run.
    const c: any = makeClient();
    const inner = c.from;
    c.from = (t: string) => {
      const q = inner(t);
      if (t === "intel_mission_candidates") {
        const run = q._run.bind(q);
        q._run = () => {
          if (q._op === "update") return Promise.resolve({ data: null, error: { message: "permission denied" } });
          return run();
        };
      }
      return q;
    };

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.ok(out.steps.some((s) => s.step === "null_intel_mission_accepted_by" && !s.ok),
      "the failing step must be recorded");
    assert.ok(out.warnings.some((w) => w.includes("intel_mission_candidates")),
      "the residual-identifier risk must be surfaced as a warning: " + JSON.stringify(out.warnings));
    // The run still completes — the deleted user's content and auth user are gone.
    assert.equal(out.ok, true, "a failed non-fatal step must not abort the deletion");
    assert.deepEqual(c._authDeleted, [USER_ID]);
  });

  it("is classified in the deletion-coverage manifest as anonymised / FK nulled (not row deleted)", () => {
    assert.ok(ANONYMISED_FK_NULLED.includes("intel_mission_candidates"),
      "intel_mission_candidates must be recorded in ANONYMISED_FK_NULLED so the coverage guard accounts for it");
  });
});
