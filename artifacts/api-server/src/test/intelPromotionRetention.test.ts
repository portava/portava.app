/**
 * The two new schedulers, same fail-closed contract as the snapshot sweep: an
 * irreversible DELETE and a claim-promoting INSERT each run only when explicitly
 * enabled, and an error is reported as skipped — never as a silent success.
 * (The SQL functions themselves are verified against real Postgres in the
 * certification; here we prove the gating + the exact RPC calls.)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runIntelContributionRetentionSweep } from "../lib/intelRetentionScheduler.js";
import { runIntelPromotionPass } from "../lib/intelPromotionScheduler.js";
import { INTEL_IDENTIFIABLE_RETENTION_SECONDS } from "../lib/locationPurposes.js";

function client(opts: { flag: boolean | null; rpcData?: any; rpcError?: boolean }) {
  const state = { rpcCalled: false, rpcName: "", rpcArgs: null as any };
  return {
    state,
    from(table: string) {
      if (table === "feature_flags") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({
          data: opts.flag === null ? null : { enabled: opts.flag }, error: null }) }) }) };
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc: async (name: string, args: any) => {
      state.rpcCalled = true; state.rpcName = name; state.rpcArgs = args;
      return opts.rpcError ? { data: null, error: { message: "boom" } } : { data: opts.rpcData ?? null, error: null };
    },
  };
}

describe("contribution retention sweep (180-day) — fail-closed", () => {
  it("does nothing when the flag row is missing", async () => {
    const c = client({ flag: null });
    const r = await runIntelContributionRetentionSweep({ client: c });
    assert.equal(r.skipped, true);
    assert.equal(r.reason, "disabled");
    assert.equal(c.state.rpcCalled, false, "no irreversible delete without the flag");
  });
  it("does nothing when the flag is off", async () => {
    const c = client({ flag: false });
    const r = await runIntelContributionRetentionSweep({ client: c });
    assert.equal(r.reason, "disabled");
    assert.equal(c.state.rpcCalled, false);
  });
  it("purges with cutoff = now − 180 days and reports per-table counts", async () => {
    const now = new Date("2026-08-27T00:00:00.000Z");
    const c = client({ flag: true, rpcData: [
      { table_name: "intel_evidence", deleted_count: 2 },
      { table_name: "intel_confirmations", deleted_count: 1 },
      { table_name: "intel_observations", deleted_count: 3 },
    ] });
    const r = await runIntelContributionRetentionSweep({ client: c, now });
    assert.equal(c.state.rpcName, "purge_intel_contributions_older_than");
    const expected = new Date(now.getTime() - INTEL_IDENTIFIABLE_RETENTION_SECONDS * 1000).toISOString();
    assert.equal(c.state.rpcArgs.p_cutoff, expected, "cutoff is exactly 180 days before now");
    assert.deepEqual({ e: r.evidence, c: r.confirmations, o: r.observations }, { e: 2, c: 1, o: 3 });
    assert.equal(r.skipped, false);
    assert.equal(r.reason, null);
  });
  it("an rpc error reports skipped, not a false success", async () => {
    const r = await runIntelContributionRetentionSweep({ client: client({ flag: true, rpcError: true }) });
    assert.equal(r.skipped, true);
    assert.equal(r.reason, "error");
    assert.equal(r.observations, 0);
  });
  it("no client is no_client", async () => {
    const r = await runIntelContributionRetentionSweep({ client: null });
    assert.equal(r.reason, "no_client");
  });
});

describe("system claim promotion pass — fail-closed", () => {
  it("does not promote when the projection flag is missing or off", async () => {
    for (const flag of [null, false] as const) {
      const c = client({ flag });
      const r = await runIntelPromotionPass({ client: c });
      assert.equal(r.skipped, true);
      assert.equal(r.reason, "disabled");
      assert.equal(c.state.rpcCalled, false, "no promotion without the flag");
    }
  });
  it("calls the service-owned promotion RPC and reports the count (bigint-as-string safe)", async () => {
    const c = client({ flag: true, rpcData: "4" }); // int8 can arrive as a string over PostgREST
    const r = await runIntelPromotionPass({ client: c });
    assert.equal(c.state.rpcName, "system_promote_admissible_intel_claims");
    assert.equal(r.promoted, 4);
    assert.equal(r.skipped, false);
    assert.equal(r.reason, null);
  });
  it("an rpc error reports skipped, not success", async () => {
    const r = await runIntelPromotionPass({ client: client({ flag: true, rpcError: true }) });
    assert.equal(r.skipped, true);
    assert.equal(r.reason, "error");
    assert.equal(r.promoted, 0);
  });
  it("no client is no_client", async () => {
    const r = await runIntelPromotionPass({ client: null });
    assert.equal(r.reason, "no_client");
  });
});
