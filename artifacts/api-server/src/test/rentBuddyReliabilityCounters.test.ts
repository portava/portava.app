/**
 * rentBuddyReliabilityCounters.test.ts
 *
 * Unit tests for the reliability counter helpers that keep
 * rent_buddy_profiles.completed_count / cancel_count / no_show_count /
 * favorites_count in sync with booking lifecycle and saved-buddy events.
 *
 * Runtime: node:test + node:assert/strict
 * Run: node --import tsx/esm --test src/test/rentBuddyReliabilityCounters.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  adjustBuddyCounter,
  syncFavoritesCount,
} from "../services/rentBuddy/ReliabilityCounters.js";

const BP_ID = "cccccccc-0000-0000-0000-000000000003";

// ── Fake supabase client ───────────────────────────────────────────────────────
// Minimal thenable query builder: records update payloads per table, serves
// canned rows for selects.

type TableData = Record<string, any>;

function makeFakeClient(opts: {
  profileRow?: TableData | null;
  savedRows?: TableData[];
}) {
  const updates: Array<{ table: string; payload: TableData; eqs: Array<[string, any]> }> = [];

  function makeBuilder(table: string): any {
    let op: "select" | "update" = "select";
    let payload: TableData = {};
    const eqs: Array<[string, any]> = [];

    const b: any = {
      select: () => { op = "select"; return b; },
      update: (p: TableData) => { op = "update"; payload = p; return b; },
      eq: (col: string, val: any) => { eqs.push([col, val]); return b; },
      maybeSingle: async () => {
        if (op === "update") { updates.push({ table, payload, eqs }); return { data: null, error: null }; }
        if (table === "rent_buddy_profiles") return { data: opts.profileRow ?? null, error: null };
        return { data: null, error: null };
      },
      then: (resolve: any, reject: any) => {
        let result: any;
        if (op === "update") {
          updates.push({ table, payload, eqs });
          result = { data: null, error: null };
        } else if (table === "rent_buddy_saved") {
          result = { data: opts.savedRows ?? [], error: null };
        } else {
          result = { data: opts.profileRow ? [opts.profileRow] : [], error: null };
        }
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return b;
  }

  return {
    client: { from: (table: string) => makeBuilder(table) },
    updates,
  };
}

// ── adjustBuddyCounter ─────────────────────────────────────────────────────────

describe("adjustBuddyCounter", () => {
  it("increments completed_count from the current value", async () => {
    const { client, updates } = makeFakeClient({ profileRow: { completed_count: 4 } });
    await adjustBuddyCounter(client, BP_ID, "completed_count", 1);

    assert.equal(updates.length, 1);
    assert.equal(updates[0].table, "rent_buddy_profiles");
    assert.equal(updates[0].payload.completed_count, 5);
    assert.deepEqual(updates[0].eqs, [["id", BP_ID]]);
  });

  it("treats a missing/null counter as 0", async () => {
    const { client, updates } = makeFakeClient({ profileRow: { cancel_count: null } });
    await adjustBuddyCounter(client, BP_ID, "cancel_count", 1);
    assert.equal(updates[0].payload.cancel_count, 1);
  });

  it("clamps at zero on negative deltas", async () => {
    const { client, updates } = makeFakeClient({ profileRow: { no_show_count: 0 } });
    await adjustBuddyCounter(client, BP_ID, "no_show_count", -1);
    assert.equal(updates[0].payload.no_show_count, 0);
  });

  it("is a no-op for missing client, id, or zero delta", async () => {
    const { client, updates } = makeFakeClient({ profileRow: { cancel_count: 2 } });
    await adjustBuddyCounter(null, BP_ID, "cancel_count", 1);
    await adjustBuddyCounter(client, "", "cancel_count", 1);
    await adjustBuddyCounter(client, BP_ID, "cancel_count", 0);
    assert.equal(updates.length, 0);
  });

  it("never throws when the client errors", async () => {
    const throwing = { from: () => { throw new Error("boom"); } };
    await assert.doesNotReject(() => adjustBuddyCounter(throwing, BP_ID, "cancel_count", 1));
  });
});

// ── syncFavoritesCount ─────────────────────────────────────────────────────────

describe("syncFavoritesCount", () => {
  it("sets favorites_count to the number of saved rows", async () => {
    const { client, updates } = makeFakeClient({
      savedRows: [{ user_id: "u1" }, { user_id: "u2" }, { user_id: "u3" }],
    });
    await syncFavoritesCount(client, BP_ID);

    assert.equal(updates.length, 1);
    assert.equal(updates[0].table, "rent_buddy_profiles");
    assert.equal(updates[0].payload.favorites_count, 3);
    assert.deepEqual(updates[0].eqs, [["id", BP_ID]]);
  });

  it("sets favorites_count to 0 when the last save is removed", async () => {
    const { client, updates } = makeFakeClient({ savedRows: [] });
    await syncFavoritesCount(client, BP_ID);
    assert.equal(updates[0].payload.favorites_count, 0);
  });

  it("leaves the counter untouched when rows are unavailable", async () => {
    // Simulates a partial/fake client that does not return a data array.
    const b: any = {
      select: () => b,
      eq: () => b,
      update: () => { throw new Error("should not update"); },
      then: (resolve: any) => Promise.resolve({ data: null, error: null }).then(resolve),
    };
    const client = { from: () => b };
    await assert.doesNotReject(() => syncFavoritesCount(client, BP_ID));
  });

  it("never throws when the client errors", async () => {
    const throwing = { from: () => { throw new Error("boom"); } };
    await assert.doesNotReject(() => syncFavoritesCount(throwing, BP_ID));
  });
});

// ── Atomic RPC path ────────────────────────────────────────────────────────────

describe("atomic RPC path (rb_adjust_buddy_counter / rb_sync_favorites_count)", () => {
  it("prefers the atomic RPC over read-modify-write for counter adjustments", async () => {
    const rpcCalls: Array<[string, any]> = [];
    const client = {
      rpc: async (fn: string, args: any) => { rpcCalls.push([fn, args]); return { data: null, error: null }; },
      from: () => { throw new Error("should not fall back to read-modify-write"); },
    };
    await adjustBuddyCounter(client, BP_ID, "cancel_count", 1);
    assert.deepEqual(rpcCalls, [
      ["rb_adjust_buddy_counter", { p_buddy_id: BP_ID, p_column: "cancel_count", p_delta: 1 }],
    ]);
  });

  it("prefers the atomic RPC for favorites recount", async () => {
    const rpcCalls: Array<[string, any]> = [];
    const client = {
      rpc: async (fn: string, args: any) => { rpcCalls.push([fn, args]); return { data: null, error: null }; },
      from: () => { throw new Error("should not fall back to client-side recount"); },
    };
    await syncFavoritesCount(client, BP_ID);
    assert.deepEqual(rpcCalls, [["rb_sync_favorites_count", { p_buddy_id: BP_ID }]]);
  });

  it("falls back to read-modify-write when the RPC errors", async () => {
    const { client, updates } = makeFakeClient({ profileRow: { cancel_count: 2 } });
    (client as any).rpc = async () => ({ data: null, error: { message: "function does not exist" } });
    await adjustBuddyCounter(client, BP_ID, "cancel_count", 1);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].payload.cancel_count, 3);
  });

  it("does not lose increments under concurrent updates (atomic semantics)", async () => {
    // Simulates the DB-side atomicity of rb_adjust_buddy_counter: each RPC is
    // a single atomic `col = GREATEST(0, col + delta)`. 25 parallel events on
    // the same buddy must land exactly +25 — no read-modify-write races.
    const store: Record<string, number> = { completed_count: 0 };
    const client = {
      rpc: async (fn: string, args: any) => {
        assert.equal(fn, "rb_adjust_buddy_counter");
        await new Promise((r) => setTimeout(r, Math.random() * 5)); // jitter
        store[args.p_column] = Math.max(0, (store[args.p_column] ?? 0) + args.p_delta);
        return { data: null, error: null };
      },
      from: () => { throw new Error("should not fall back"); },
    };
    await Promise.all(
      Array.from({ length: 25 }, () => adjustBuddyCounter(client, BP_ID, "completed_count", 1)),
    );
    assert.equal(store.completed_count, 25);
  });
});
