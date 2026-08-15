/**
 * P1 Stage 2 shadow observation (lib/discoveryShadow.ts).
 *
 * WHAT MUST HOLD
 * ==============
 * Shadow mode's promise is that it observes and changes nothing. Two halves:
 *
 *   1. The comparison must mean what a reader will assume it means. It compares
 *      the SERVED PAGES, not the full ranked lists — a reordering below the
 *      fold changed nothing anybody saw, and counting it would inflate every
 *      figure the table produces.
 *
 *   2. The write must never be able to damage a request. It is issued after the
 *      response has left, so its only possible failure mode is being lost; that
 *      is acceptable and is logged. Throwing is not acceptable.
 *
 * The row shape is asserted too. A column silently dropped from the insert is
 * how a table ends up "instrumented" and holding nulls in the column the whole
 * analysis turns on.
 *
 * Runtime: node:test + node:assert/strict.
 * Run: node --import tsx/esm --test src/test/discoveryShadow.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compareServedOrders, logDiscoveryShadowServe } from "../lib/discoveryShadow.js";

function captureClient(result: { error?: unknown } = {}) {
  const rows: any[] = [];
  const client: any = {
    from(table: string) {
      return {
        insert: async (row: any) => { rows.push({ table, row }); return { error: result.error ?? null }; },
      };
    },
  };
  return { client, rows };
}

const BASE = {
  userId: "u-1",
  destination: "Paris, France",
  category: "food",
  radiusKm: 10,
  page: 1,
  pageSize: 20,
  sortBy: null,
  servePoint: 1,
  cacheLevel: "L1",
  legacyIds: ["a", "b", "c"],
  legacyTotal: 3,
  legacyMs: 12,
  pdeIds: ["c", "a", "b"],
  pdeTotal: 3,
  pdeMs: 40,
  pdeStages: { portavaRank: true, drs: true, analytics: false, suppressedWrites: 6 },
  pdeSuppressedWrites: 6,
  engineMode: "shadow",
  modeReason: "resolved",
};

describe("shadow comparison", () => {
  it("A. identical pages diverge in nothing", () => {
    const c = compareServedOrders(["a", "b", "c"], ["a", "b", "c"]);
    assert.deepEqual(c, { overlapCount: 3, displacedCount: 0, topChanged: false });
  });

  it("B. a reordering is displacement, not a change of membership", () => {
    const c = compareServedOrders(["a", "b", "c"], ["c", "b", "a"]);
    assert.equal(c.overlapCount, 3, "the same three items are on both pages");
    assert.equal(c.displacedCount, 2, "b kept position 1; a and c moved");
    assert.equal(c.topChanged, true);
  });

  it("C. items PDE would have promoted onto the page are not counted as overlap", () => {
    const c = compareServedOrders(["a", "b"], ["z", "a"]);
    assert.equal(c.overlapCount, 1);
    assert.equal(c.displacedCount, 1, "a moved from 0 to 1");
    assert.equal(c.topChanged, true);
  });

  it("D. two empty pages agree; an empty page against a populated one does not", () => {
    assert.deepEqual(
      compareServedOrders([], []),
      { overlapCount: 0, displacedCount: 0, topChanged: false },
    );
    const c = compareServedOrders([], ["a"]);
    assert.equal(c.topChanged, true, "empty vs populated must never read as agreement");
    assert.equal(c.overlapCount, 0);
  });

  it("E. total disagreement overlaps in nothing", () => {
    const c = compareServedOrders(["a", "b"], ["x", "y"]);
    assert.deepEqual(c, { overlapCount: 0, displacedCount: 0, topChanged: true });
  });

  it("F. a duplicated id resolves to its first position, not its last", () => {
    // Defensive: ids should be unique per page, but if a merge bug ever produced
    // a duplicate, the comparison must stay deterministic rather than depending
    // on iteration order.
    const c = compareServedOrders(["a"], ["a", "a"]);
    assert.equal(c.overlapCount, 1);
    assert.equal(c.displacedCount, 0);
  });
});

describe("shadow write", () => {
  it("G. writes exactly one row, to discovery_shadow_serves", async () => {
    const { client, rows } = captureClient();
    await logDiscoveryShadowServe(client, BASE);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].table, "discovery_shadow_serves");
  });

  it("H. the row carries every column the analysis depends on", async () => {
    const { client, rows } = captureClient();
    await logDiscoveryShadowServe(client, BASE);
    const row = rows[0].row;

    // Both orders and the serve point — the packet's stated deliverable.
    assert.deepEqual(row.legacy_ids, ["a", "b", "c"]);
    assert.deepEqual(row.pde_ids,    ["c", "a", "b"]);
    assert.equal(row.serve_point, 1);
    // Both timings.
    assert.equal(row.legacy_ms, 12);
    assert.equal(row.pde_ms,    40);
    // Provenance — "shadow by configuration" must stay distinguishable from a
    // fallback that happens to look the same.
    assert.equal(row.engine_mode, "shadow");
    assert.equal(row.mode_reason, "resolved");
    // The precomputed comparison.
    assert.equal(row.overlap_count, 3);
    // a 0→1, b 1→2, c 2→0 — a rotation displaces every item.
    assert.equal(row.displaced_count, 3);
    assert.equal(row.top_changed, true);
    // The suppression counter, which is how the write guard stays observable.
    assert.equal(row.pde_suppressed_writes, 6);
    // Request shape.
    assert.equal(row.destination, "Paris, France");
    assert.equal(row.category, "food");
    assert.equal(row.radius_km, 10);
    assert.equal(row.page, 1);
    assert.equal(row.page_size, 20);
  });

  it("I. it writes to no other table", async () => {
    const { client, rows } = captureClient();
    await logDiscoveryShadowServe(client, BASE);
    assert.deepEqual([...new Set(rows.map((r) => r.table))], ["discovery_shadow_serves"]);
  });

  it("J. a rejected insert is survived, not thrown", async () => {
    const { client } = captureClient({ error: { message: "column does not exist" } });
    await logDiscoveryShadowServe(client, BASE); // must not reject
  });

  it("K. a client that throws is survived", async () => {
    const detonator: any = { from() { throw new Error("db down"); } };
    await logDiscoveryShadowServe(detonator, BASE);
  });

  it("L. a null client writes nothing and does not throw", async () => {
    await logDiscoveryShadowServe(null, BASE);
  });

  it("M. optional fields default rather than writing undefined", async () => {
    const { client, rows } = captureClient();
    await logDiscoveryShadowServe(client, {
      ...BASE,
      sessionId: undefined, cacheLevel: undefined, sortBy: undefined,
      legacyMs: undefined, pdeMs: undefined,
      pdeStages: undefined, pdeSuppressedWrites: undefined,
    });
    const row = rows[0].row;
    assert.equal(row.session_id, null);
    assert.equal(row.cache_level, null);
    assert.equal(row.sort_by, null);
    assert.equal(row.legacy_ms, null);
    assert.equal(row.pde_ms, null);
    assert.deepEqual(row.pde_stages, {});
    assert.equal(row.pde_suppressed_writes, 0, "NOT NULL in the schema — a default, never undefined");
  });
});
