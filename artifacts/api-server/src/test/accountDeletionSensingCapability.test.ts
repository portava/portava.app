/**
 * Account deletion must erase SENSING CAPABILITY STATE (migration 2956).
 *
 * WHY THE CASCADE CANNOT DO THIS. Deletion here ends in a TOMBSTONE profile —
 * `anonymise_profile` rewrites the row, it does not remove it — so
 * `profiles.id` is still a valid FK target afterwards and nothing cascades.
 * intel_sensing_credentials (actor_id, device_id, token_digest, nonce_digest)
 * and intel_sensing_device_eligibility therefore survive account deletion
 * intact: a device-linked credential belonging to an account that no longer
 * exists.
 *
 * Both tables are live in production and CI (applied 2026-09-16 by the
 * out-of-band writer as `privacy_safe_sensing_credentials`), so this is a real
 * residue, not a hypothetical one. Neither table appears in
 * deletionGraph.snapshot.json, which is why the coverage guards never caught it.
 *
 * Run: node --import tsx/esm --test src/test/accountDeletionSensingCapability.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeAccountDeletion } from "../services/accountDeletion/AccountDeletionService.js";

const USER_ID = "22222222-2222-2222-2222-222222222222";
const SENSING_TABLES = ["intel_sensing_credentials", "intel_sensing_device_eligibility"];

function makeStub(opts: { sensingError?: Record<string, any> } = {}) {
  const deletes: { table: string; filters: any[] }[] = [];
  const authDeleted: string[] = [];

  function builder(table: string) {
    const q: any = {
      _op: "select", _filters: [] as any[], _limit: undefined as number | undefined, _single: false,
      select() { q._op = "select"; return q; },
      delete() { q._op = "delete"; return q; },
      update() { q._op = "update"; return q; },
      insert() { q._op = "insert"; return q; },
      upsert() { q._op = "upsert"; return q; },
      eq(c: string, v: any) { q._filters.push(["eq", c, v]); return q; },
      neq() { return q; }, not() { return q; }, in() { return q; }, or() { return q; },
      lte() { return q; }, gte() { return q; }, lt() { return q; }, is() { return q; },
      order() { return q; },
      limit(n: number) { q._limit = n; return q; },
      maybeSingle() { q._single = true; return q._run(); },
      then(resolve: any, reject: any) { return q._run().then(resolve, reject); },
      _run() {
        if (q._op === "delete") {
          deletes.push({ table, filters: q._filters.slice() });
          if (SENSING_TABLES.includes(table) && opts.sensingError) {
            return Promise.resolve({ data: null, error: opts.sensingError });
          }
          return Promise.resolve({ data: null, error: null });
        }
        if (q._op !== "select") return Promise.resolve({ data: null, error: null });
        if (q._single) return Promise.resolve({ data: null, error: null });
        return Promise.resolve({ data: [], error: null });
      },
    };
    return q;
  }

  return {
    _deletes: deletes,
    _authDeleted: authDeleted,
    from: (t: string) => builder(t),
    rpc: async () => ({ data: null, error: null }),
    storage: { from: () => ({ remove: async () => ({ data: [], error: null }) }) },
    auth: { admin: { deleteUser: async (id: string) => { authDeleted.push(id); return { data: {}, error: null }; } } },
  };
}

const sensingDeletes = (c: ReturnType<typeof makeStub>) =>
  c._deletes.filter((d) => SENSING_TABLES.includes(d.table));

describe("executeAccountDeletion — sensing capability state", () => {
  it("erases both 2956 tables, scoped to the departing actor", async () => {
    const c = makeStub();
    const out = await executeAccountDeletion(c as any, USER_ID, { actorId: null });

    const tables = sensingDeletes(c).map((d) => d.table).sort();
    assert.deepEqual(tables, [...SENSING_TABLES].sort(),
      `sensing capability state survived account deletion: ${JSON.stringify(tables)}`);
    for (const d of sensingDeletes(c)) {
      assert.deepEqual(d.filters, [["eq", "actor_id", USER_ID]],
        `${d.table} was deleted unscoped — that would erase other actors' credentials`);
    }
    const stepResult = out.steps.find((s) => s.step === "erase_sensing_credentials_and_devices");
    assert.ok(stepResult?.ok, "the erasure step must be recorded and must succeed");
  });

  it("aborts before profile anonymisation when the erasure is refused", async () => {
    // FATAL, like erase_derived_memory: a live credential behind a deleted
    // account is a privacy failure, and the request must stay retryable rather
    // than be marked complete.
    const c = makeStub({ sensingError: { code: "42501", message: "permission denied" } });
    const out = await executeAccountDeletion(c as any, USER_ID, { actorId: null });

    assert.equal(out.ok, false);
    assert.equal(out.steps.find((s) => s.step === "erase_sensing_credentials_and_devices")?.ok, false);
    assert.equal(out.steps.find((s) => s.step === "anonymise_profile"), undefined,
      "the profile was anonymised even though sensing state could not be erased");
    assert.deepEqual(c._authDeleted, [], "the auth user was removed with capability state still live");
    assert.ok(out.warnings.some((w) => w.includes("sensing capability state may remain")));
  });

  it("treats a database without 2956 as nothing to erase, not as a failure", async () => {
    // PGRST205 / 42P01 = the relation does not exist here. That is an
    // under-migrated environment, not a refused erasure, and must not abort a
    // deletion that is otherwise complete.
    for (const code of ["PGRST205", "42P01"]) {
      const c = makeStub({ sensingError: { code, message: "relation does not exist" } });
      const out = await executeAccountDeletion(c as any, USER_ID, { actorId: null });
      assert.equal(out.steps.find((s) => s.step === "erase_sensing_credentials_and_devices")?.ok, true,
        `${code} was treated as an erasure failure`);
      assert.ok(out.steps.some((s) => s.step === "anonymise_profile"),
        `${code} aborted the deletion before anonymisation`);
    }
  });
});
