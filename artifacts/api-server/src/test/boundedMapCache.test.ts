/**
 * pruneAndBound — the reclaim the discovery caches never had.
 *
 * THE DEFECT THIS IS WRITTEN AGAINST (2026-08-28)
 * ----------------------------------------------
 * Three Maps in routes/discovery.ts had no size bound and no sweeper, and their
 * TTLs were consulted ONLY on read. An entry nobody asked for again was never
 * freed, so the process retained every distinct key it had ever seen until
 * restart. `_compassCandidateCache` is keyed `userId:destination:...`, so it
 * grew with users x destinations — the quantity that goes UP at launch.
 *
 * The tests below assert the two properties that make this a fix rather than a
 * gesture: expired entries are dropped even under the cap, and eviction is
 * oldest-FIRST rather than insertion-order-first.
 *
 * Pure and offline.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pruneAndBound } from "../lib/boundedMapCache.js";

type E = { at: number; v: string };
const ts = (e: E) => e.at;

describe("pruneAndBound", () => {
  it("drops expired entries even when the map is well under the cap", () => {
    // The original defect exactly: a small map that is never re-read still has
    // to give its memory back.
    const m = new Map<string, E>([
      ["fresh", { at: 1_000, v: "a" }],
      ["stale", { at: 0, v: "b" }],
    ]);
    const r = pruneAndBound(m, { max: 100, ttlMs: 500, timestampOf: ts, now: 1_100 });
    assert.equal(r.expired, 1);
    assert.equal(r.evicted, 0);
    assert.deepEqual([...m.keys()], ["fresh"]);
  });

  it("expires FIRST, so a map full of dead entries evicts nothing live", () => {
    // If the order were reversed, live entries would be discarded to make room
    // for entries that were about to be dropped anyway.
    const m = new Map<string, E>();
    for (let i = 0; i < 5; i += 1) m.set(`dead${i}`, { at: 0, v: "d" });
    m.set("live", { at: 10_000, v: "l" });

    const r = pruneAndBound(m, { max: 2, ttlMs: 1_000, timestampOf: ts, now: 10_000 });
    assert.equal(r.expired, 5);
    assert.equal(r.evicted, 0, "nothing live should have been evicted");
    assert.deepEqual([...m.keys()], ["live"]);
  });

  it("evicts OLDEST first when still over the cap", () => {
    const m = new Map<string, E>([
      ["oldest", { at: 1, v: "a" }],
      ["middle", { at: 2, v: "b" }],
      ["newest", { at: 3, v: "c" }],
    ]);
    const r = pruneAndBound(m, { max: 2, ttlMs: 0, timestampOf: ts, now: 100 });
    assert.equal(r.evicted, 1);
    assert.deepEqual([...m.keys()].sort(), ["middle", "newest"]);
  });

  it("orders eviction by WRITE TIME, not by Map insertion order", () => {
    // The subtle one. Overwriting a key in place keeps its ORIGINAL position in
    // Map iteration order, so iterating the Map would evict a freshly-rewritten
    // entry while keeping an older one. Only the stored timestamp is correct.
    const m = new Map<string, E>();
    m.set("first_inserted", { at: 1, v: "x" });
    m.set("second", { at: 2, v: "y" });
    m.set("first_inserted", { at: 99, v: "x-updated" }); // rewritten, still position 0
    m.set("third", { at: 3, v: "z" });

    pruneAndBound(m, { max: 2, ttlMs: 0, timestampOf: ts, now: 100 });
    assert.ok(m.has("first_inserted"), "the most recently WRITTEN entry must survive");
    assert.ok(m.has("third"));
    assert.ok(!m.has("second"), "the genuinely oldest write is the one to go");
  });

  it("ttlMs = 0 disables expiry without disabling the cap", () => {
    const m = new Map<string, E>([["a", { at: 0, v: "a" }], ["b", { at: 1, v: "b" }]]);
    const r = pruneAndBound(m, { max: 1, ttlMs: 0, timestampOf: ts, now: 1e9 });
    assert.equal(r.expired, 0, "ttlMs 0 must not expire everything");
    assert.equal(r.evicted, 1);
    assert.deepEqual([...m.keys()], ["b"]);
  });

  it("is a no-op on a healthy map, and reports the surviving size", () => {
    const m = new Map<string, E>();
    m.set("a", { at: 90, v: "a" });
    m.set("b", { at: 95, v: "b" });
    const r = pruneAndBound(m, { max: 10, ttlMs: 1_000, timestampOf: ts, now: 100 });
    assert.deepEqual({ expired: r.expired, evicted: r.evicted, size: r.size }, { expired: 0, evicted: 0, size: 2 });
  });

  it("handles an empty map", () => {
    const m = new Map<string, E>();
    const r = pruneAndBound(m, { max: 10, ttlMs: 1_000, timestampOf: ts, now: 100 });
    assert.deepEqual({ expired: r.expired, evicted: r.evicted, size: r.size }, { expired: 0, evicted: 0, size: 0 });
  });
});
