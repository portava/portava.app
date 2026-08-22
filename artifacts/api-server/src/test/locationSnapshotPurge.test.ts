/**
 * location_snapshots purge scheduler — the fail-closed contract.
 *
 * The property under test is that an irreversible DELETE only ever runs when it
 * is explicitly permitted. Every ambiguous state — absent flag, unreadable
 * table, thrown error, no client — must mean DO NOT DELETE.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  runLocationSnapshotPurge,
  startLocationSnapshotPurgeScheduler,
  stopLocationSnapshotPurgeScheduler,
} from "../lib/locationSnapshotPurgeScheduler.js";

/**
 * Fake client. `flag` is what feature_flags returns (true/false/null=absent);
 * `flagError` makes the read fail. `deleted` counts rows the purge would remove.
 * `deleteCalled` records whether a DELETE was attempted at all — the assertion
 * that matters most.
 */
function client(opts: { flag: boolean | null; flagError?: boolean; deleted?: number }) {
  const state = { deleteCalled: false };
  const api = {
    state,
    from(table: string) {
      if (table === "feature_flags") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () =>
                opts.flagError
                  ? { data: null, error: { message: "unreadable" } }
                  : { data: opts.flag === null ? null : { enabled: opts.flag }, error: null },
            }),
          }),
        };
      }
      if (table === "location_snapshots") {
        return {
          delete: () => {
            state.deleteCalled = true;
            return { lt: async () => ({ count: opts.deleted ?? 0, error: null }) };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return api;
}

describe("location snapshot purge — fail-closed gating", () => {
  it("does not delete when the flag is absent", async () => {
    const c = client({ flag: null });
    const r = await runLocationSnapshotPurge({ client: c });
    assert.equal(r.skipped, true);
    assert.equal(r.purged, 0);
    assert.equal(c.state.deleteCalled, false, "attempted a DELETE with no flag row");
  });

  it("does not delete when the flag is explicitly false", async () => {
    const c = client({ flag: false, deleted: 999 });
    const r = await runLocationSnapshotPurge({ client: c });
    assert.equal(r.skipped, true);
    assert.equal(c.state.deleteCalled, false, "attempted a DELETE while disabled");
  });

  it("does not delete when the flag read errors", async () => {
    const c = client({ flag: true, flagError: true, deleted: 999 });
    const r = await runLocationSnapshotPurge({ client: c });
    assert.equal(r.skipped, true);
    assert.equal(c.state.deleteCalled, false, "a purge that cannot confirm permission still deleted");
  });

  it("does not delete when there is no client", async () => {
    const r = await runLocationSnapshotPurge({ client: null });
    assert.equal(r.skipped, true);
    assert.equal(r.purged, 0);
  });

  it("deletes only when the flag is explicitly true", async () => {
    const c = client({ flag: true, deleted: 42 });
    const r = await runLocationSnapshotPurge({ client: c });
    assert.equal(r.skipped, false);
    assert.equal(r.purged, 42);
    assert.equal(c.state.deleteCalled, true);
  });
});

describe("location snapshot purge — scheduler lifecycle", () => {
  beforeEach(() => stopLocationSnapshotPurgeScheduler());

  it("start is idempotent and stop is safe to call twice", () => {
    startLocationSnapshotPurgeScheduler();
    startLocationSnapshotPurgeScheduler(); // must not double-schedule
    stopLocationSnapshotPurgeScheduler();
    stopLocationSnapshotPurgeScheduler(); // must not throw
  });
});
