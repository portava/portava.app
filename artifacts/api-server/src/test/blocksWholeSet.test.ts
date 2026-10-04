/**
 * census-discovery §123 (DV-83 round 24, lane DISC-DV83; the sweep beside the round-23 verifier's B43):
 * `fetchBlockedSet` (lib/blocks.ts) answers the WHOLE block set, or null — never the first page PostgREST cut.
 *
 * `fetchBlockedSet` is the one place the app resolves "who is blocked, in either direction"; every Discovery read that
 * withholds a blocked submitter's place, post or profile filters on its answer. It made ONE unbounded read. PostgREST
 * caps a response at db-max-rows (1000 here) with no error, so a viewer with more than 1000 block rows (their own
 * blocks plus everyone who blocked them) got a set missing every row past the cap, and the people in those rows were
 * served to them. The plain read now asks for its exact count; when the count says rows were left out, both directions
 * are read again whole, by key. A set that cannot be read whole is null, which every caller already treats as "show
 * nobody" (fail-closed).
 *
 *   FB0  CONTROL: a few rows in both directions → every counter-party, neither the viewer themself
 *   FB1  1200 people blocked the viewer → the one past the cap is in the set
 *   FB2  the viewer blocked 1200 people → the one past the cap is in the set
 *   FB3  700 + 700 rows across both directions (each under the cap, 1400 together) → both tails are in the set
 *   FB4  the set is cut and a keyed re-read FAILS → null (fail-closed)
 *   FB5  CONTROL: the plain read FAILS → null; it THROWS → null
 *   FB6  the server's max-rows (300) is below the page size → still the whole set
 *   FB7  CONTROL: a set under the cap costs ONE read (no keyed re-read)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchBlockedSet } from "../lib/blocks.js";
import { cappedClient, seqId, type Row, type SeenRead } from "./helpers/cappedPostgrest.js";

const VIEWER = "a1a1a1a1-aaaa-4aaa-8aaa-000000000001";
const TARGET = "b2b2b2b2-bbbb-4bbb-8bbb-000000000002";
const TARGET2 = "b3b3b3b3-bbbb-4bbb-8bbb-000000000003";

function rows(n: number, dir: "in" | "out", target: string | null, at: number, prefix = "c0000000"): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < n; i++) {
    const other = target !== null && i === at ? target : seqId(prefix, i);
    out.push(dir === "in" ? { blocker_id: other, blocked_id: VIEWER } : { blocker_id: VIEWER, blocked_id: other });
  }
  return out;
}
const read = (blocks: Row[], opts: { fail?: (r: SeenRead) => boolean | "throw"; dbMaxRows?: number; reads?: SeenRead[] } = {}) =>
  fetchBlockedSet(cappedClient({ blocks }, opts) as any, VIEWER);

describe("census-discovery §123: fetchBlockedSet answers the whole block set or null", () => {
  it("FB0 CONTROL: a few rows in both directions → every counter-party, never the viewer", async () => {
    const set = await read([...rows(2, "in", TARGET, 0), ...rows(2, "out", TARGET2, 1, "d0000000"), { blocker_id: seqId("e0000000", 1), blocked_id: seqId("e0000000", 2) }]);
    assert.ok(set !== null);
    assert.deepEqual([...set].sort(), [TARGET, TARGET2, seqId("c0000000", 1), seqId("d0000000", 0)].sort());
    assert.equal(set.has(VIEWER), false);
  });
  it("FB1 1200 people blocked the viewer → the one past the cap is in the set", async () => {
    const set = await read(rows(1200, "in", TARGET, 1100));
    assert.ok(set !== null, "the set was answered null");
    assert.equal(set.size, 1200, `the set holds ${set.size} of 1200 counter-parties`);
    assert.equal(set.has(TARGET), true, "someone who blocked the viewer is missing from the set");
  });
  it("FB2 the viewer blocked 1200 people → the one past the cap is in the set", async () => {
    const set = await read(rows(1200, "out", TARGET, 1100));
    assert.ok(set !== null, "the set was answered null");
    assert.equal(set.has(TARGET), true, "someone the viewer blocked is missing from the set");
    assert.equal(set.size, 1200);
  });
  it("FB3 700 + 700 rows across both directions → both tails are in the set", async () => {
    const set = await read([...rows(700, "in", TARGET, 699), ...rows(700, "out", TARGET2, 699, "d0000000")]);
    assert.ok(set !== null, "the set was answered null");
    assert.equal(set.has(TARGET) && set.has(TARGET2), true, `missing: ${[TARGET, TARGET2].filter((t) => !set.has(t)).join(", ")}`);
    assert.equal(set.size, 1400);
  });
  it("FB4 the set is cut and a keyed re-read FAILS → null (fail-closed)", async () => {
    assert.equal(await read(rows(1200, "in", TARGET, 1100), { fail: (r) => r.ordered && r.eqs.blocked_id === VIEWER }), null);
    assert.equal(await read(rows(1200, "in", TARGET, 1100), { fail: (r) => r.ordered && r.eqs.blocker_id === VIEWER }), null);
    assert.equal(await read(rows(1200, "in", TARGET, 1100), { fail: (r) => (r.ordered ? "throw" : false) }), null);
  });
  it("FB5 CONTROL: the plain read FAILS → null; it THROWS → null", async () => {
    assert.equal(await read(rows(2, "in", TARGET, 0), { fail: () => true }), null);
    assert.equal(await read(rows(2, "in", TARGET, 0), { fail: () => "throw" }), null);
  });
  it("FB6 the server's max-rows (300) is below the page size → still the whole set", async () => {
    const set = await read(rows(1200, "in", TARGET, 1100), { dbMaxRows: 300 });
    assert.ok(set !== null, "the set was answered null");
    assert.equal(set.size, 1200, `the set holds ${set.size} of 1200 counter-parties`);
  });
  it("FB7 CONTROL: a set under the cap costs one read", async () => {
    const reads: SeenRead[] = [];
    const set = await read(rows(40, "in", TARGET, 3), { reads });
    assert.equal(set?.size, 40);
    assert.equal(reads.length, 1, JSON.stringify(reads.map((r) => r.eqs)));
  });
});
