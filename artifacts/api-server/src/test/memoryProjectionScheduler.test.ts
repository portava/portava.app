/**
 * Memory projection scheduler — the driver for the memory system (spec §22).
 * Proves the pass is flag-gated and fail-closed: no client → no_client; flag off
 * → disabled and the projector is never called; flag on → project_all_memory +
 * memory_sweep_expired run and their counts are returned; an RPC error is
 * swallowed into reason=error, never thrown.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runMemoryProjectionPass } from "../lib/memoryProjectionScheduler.js";

function makeDb(cfg: { enabled: boolean; projected?: number; swept?: number; rpcError?: string }) {
  const calls: string[] = [];
  const db: any = {
    from(_table: string) {
      const b: any = {
        select() { return b; },
        eq() { return b; },
        maybeSingle() { return Promise.resolve({ data: { enabled: cfg.enabled }, error: null }); },
      };
      return b;
    },
    rpc(name: string, _params: any) {
      calls.push(name);
      if (cfg.rpcError === name) return Promise.resolve({ data: null, error: { message: "boom" } });
      if (name === "project_all_memory") return Promise.resolve({ data: cfg.projected ?? 0, error: null });
      if (name === "memory_sweep_expired") return Promise.resolve({ data: cfg.swept ?? 0, error: null });
      return Promise.resolve({ data: null, error: null });
    },
    _calls: calls,
  };
  return db;
}

describe("memory projection scheduler", () => {
  it("no client → no_client, writes nothing", async () => {
    const r = await runMemoryProjectionPass({ client: null });
    assert.equal(r.reason, "no_client");
    assert.equal(r.skipped, true);
    assert.equal(r.projected, 0);
  });

  it("flag disabled → disabled, never calls the projector", async () => {
    const db = makeDb({ enabled: false });
    const r = await runMemoryProjectionPass({ client: db });
    assert.equal(r.reason, "disabled");
    assert.equal(r.skipped, true);
    assert.deepEqual(db._calls, []);
  });

  it("flag enabled → runs projector + sweep, returns their counts", async () => {
    const db = makeDb({ enabled: true, projected: 6, swept: 2 });
    const r = await runMemoryProjectionPass({ client: db });
    assert.equal(r.skipped, false);
    assert.equal(r.reason, null);
    assert.equal(r.projected, 6);
    assert.equal(r.swept, 2);
    assert.deepEqual(db._calls, ["project_all_memory", "memory_sweep_expired"]);
  });

  it("projector RPC error → error, does not throw and does not sweep", async () => {
    const db = makeDb({ enabled: true, rpcError: "project_all_memory" });
    const r = await runMemoryProjectionPass({ client: db });
    assert.equal(r.reason, "error");
    assert.deepEqual(db._calls, ["project_all_memory"]);
  });
});
