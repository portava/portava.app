/**
 * intelRetentionScheduler — the same fail-closed contract as the GPS purge.
 * An irreversible DELETE runs only when explicitly permitted.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  runIntelRetentionSweep, runMapTelemetryRetentionSweep,
  startIntelRetentionScheduler, stopIntelRetentionScheduler,
  INTERVAL_MS, INTEL_RETENTION_SWEEP_INTERVAL_SECONDS,
} from "../lib/intelRetentionScheduler.js";

function client(opts: { flag: boolean | null; purged?: number | string; rpcError?: boolean }) {
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

  it("counts a bigint returned as a STRING — PostgREST may not emit int8 as a number", async () => {
    // Regression: `typeof data === "number"` silently reported 0 for every
    // successful purge, making a working sweep look like a disabled one.
    const r = await runIntelRetentionSweep({ client: client({ flag: true, purged: "5000" }) });
    assert.equal(r.purged, 5000);
    assert.equal(r.skipped, false);
  });

  it("distinguishes DISABLED from FAILED — they used to be byte-identical", async () => {
    const disabled = await runIntelRetentionSweep({ client: client({ flag: false }) });
    const failed = await runIntelRetentionSweep({ client: client({ flag: true, rpcError: true }) });
    const noClient = await runIntelRetentionSweep({ client: null });

    assert.equal(disabled.reason, "disabled");
    assert.equal(failed.reason, "error");
    assert.equal(noClient.reason, "no_client");
    // All three still skip, but an operator can now tell a broken sweep from an
    // off one — the original defect was a policy nothing enforced looking fine.
    assert.notEqual(disabled.reason, failed.reason);
  });

  it("a successful sweep carries no reason", async () => {
    const r = await runIntelRetentionSweep({ client: client({ flag: true, purged: 3 }) });
    assert.equal(r.reason, null);
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

describe("intel retention scheduler — expiry-sweep cadence (spec §21: every minute)", () => {
  it("defaults to a 60-second interval when INTEL_RETENTION_SWEEP_INTERVAL_SECONDS is unset", () => {
    // The CI test harness does not set the override, so the module-load default
    // applies. Spec §21 requires the expiry sweep to run every minute.
    assert.equal(INTEL_RETENTION_SWEEP_INTERVAL_SECONDS, 60, "default cadence is 60 seconds");
    assert.equal(INTERVAL_MS, 60_000, "60 seconds expressed in ms");
  });
});


// ── Map telemetry retention (2960) ───────────────────────────────────────────
//
// 2202 declared a 90-day expiry on map_telemetry_events / map_telemetry_drops
// and nothing ever enforced it: `expires_at` was a promise with no keeper,
// which is the same defect this module's own header records for
// location_snapshots. These pin the sweep that keeps it.

describe("map telemetry retention — the expiry 2202 declared, enforced", () => {
  it("purges through the function 2960 declares, and reports the count", async () => {
    const c = client({ flag: true, purged: "12" });
    const r = await runMapTelemetryRetentionSweep({ client: c });
    assert.equal(r.purged, 12);
    assert.equal(r.skipped, false);
    assert.equal(r.reason, null);
    assert.equal(c.state.rpcName, "purge_expired_map_telemetry");
  });

  it("coerces a bigint arriving as a STRING over PostgREST", async () => {
    // int8 exceeds JS safe-integer range, so PostgREST does not always emit a
    // JSON number. A `typeof data === 'number'` guard reported 0 for every
    // successful purge once already in this file's sibling sweep.
    const r = await runMapTelemetryRetentionSweep({ client: client({ flag: true, purged: "40000000000" }) });
    assert.equal(r.purged, 40000000000);
  });

  it("is gated INDEPENDENTLY of collection, and does not purge when off", async () => {
    // Its own flag, not map_telemetry_enabled: switching collection off must
    // not strand rows that are already past their expiry.
    const c = client({ flag: false, purged: 99 });
    const r = await runMapTelemetryRetentionSweep({ client: c });
    assert.equal(r.reason, "disabled");
    assert.equal(r.purged, 0);
    assert.equal(c.state.rpcCalled, false, "attempted a purge with the flag off");
  });

  it("does not purge when the flag row is absent", async () => {
    const c = client({ flag: null, purged: 99 });
    const r = await runMapTelemetryRetentionSweep({ client: c });
    assert.equal(r.reason, "disabled");
    assert.equal(c.state.rpcCalled, false);
  });

  it("distinguishes a failing sweep from a disabled one", async () => {
    // `skipped: true` alone would make a permanently broken job look identical
    // to a correctly idle one — the shape of the original defect.
    const failed = await runMapTelemetryRetentionSweep({ client: client({ flag: true, rpcError: true }) });
    assert.equal(failed.reason, "error");
    assert.equal(failed.purged, 0);
  });

  it("reports no_client rather than opening a socket when passed null", async () => {
    const r = await runMapTelemetryRetentionSweep({ client: null });
    assert.equal(r.reason, "no_client");
    assert.equal(r.purged, 0);
  });

  it("swallows a throwing client and reports error", async () => {
    const throwing = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { enabled: true }, error: null }) }) }) }),
      rpc: async () => { throw new Error("connection reset"); },
    };
    const r = await runMapTelemetryRetentionSweep({ client: throwing });
    assert.equal(r.reason, "error");
    assert.equal(r.purged, 0);
  });
});
