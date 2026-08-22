/**
 * intelRetentionScheduler — the same fail-closed contract as the GPS purge.
 * An irreversible DELETE runs only when explicitly permitted.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  runIntelRetentionSweep, startIntelRetentionScheduler, stopIntelRetentionScheduler,
} from "../lib/intelRetentionScheduler.js";

function client(opts: { flag: boolean | null; purged?: number; rpcError?: boolean }) {
  const state = { rpcCalled: false, rpcName: "" };
  return {
    state,
    from(table: string) {
      if (table === "feature_flags") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({
          data: opts.flag === null ? null : { enabled: opts.flag }, error: null }) }) }) };
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc: async (name: string) => {
      state.rpcCalled = true; state.rpcName = name;
      return opts.rpcError ? { data: null, error: { message: "boom" } } : { data: opts.purged ?? 0, error: null };
    },
  };
}

describe("intel retention sweep — fail-closed", () => {
  it("does not sweep when the flag is absent", async () => {
    const c = client({ flag: null, purged: 99 });
    const r = await runIntelRetentionSweep({ client: c });
    assert.equal(r.skipped, true);
    assert.equal(c.state.rpcCalled, false, "attempted a purge with no flag row");
  });

  it("does not sweep when the flag is false", async () => {
    const c = client({ flag: false, purged: 99 });
    await runIntelRetentionSweep({ client: c });
    assert.equal(c.state.rpcCalled, false);
  });

  it("does not sweep without a client", async () => {
    assert.equal((await runIntelRetentionSweep({ client: null })).skipped, true);
  });

  it("sweeps through the SECURITY DEFINER function, not a raw delete", async () => {
    const c = client({ flag: true, purged: 7 });
    const r = await runIntelRetentionSweep({ client: c });
    assert.equal(r.purged, 7);
    assert.equal(c.state.rpcName, "purge_expired_intel_snapshots",
      "must go through the declared-erasure function so append-only tables stay reachable");
  });

  it("an rpc error reports skipped rather than a false success", async () => {
    const r = await runIntelRetentionSweep({ client: client({ flag: true, rpcError: true }) });
    assert.equal(r.skipped, true);
    assert.equal(r.purged, 0);
  });
});

describe("intel retention scheduler — lifecycle", () => {
  beforeEach(() => stopIntelRetentionScheduler());
  it("start is idempotent and stop is safe twice", () => {
    startIntelRetentionScheduler();
    startIntelRetentionScheduler();
    stopIntelRetentionScheduler();
    stopIntelRetentionScheduler();
  });
});
