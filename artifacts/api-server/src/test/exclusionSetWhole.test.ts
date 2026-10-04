/**
 * census-discovery §123 (DV-83 round 24, lane DISC-DV83; the sweep beside the round-23 verifier's B43):
 * `readBlockExclusions` and `readGroupBlockExclusions` (lib/exclusionSet.ts) answer the WHOLE exclusion set, or say it
 * is unreadable. Never the first page PostgREST cut.
 *
 * lib/exclusionSet.ts replaced the nullable `Set` with a discriminated `ExclusionSet` so that an unreadable table
 * excludes everybody. Its unscoped read (one `.or()` over every block row touching the viewer) and its group read made
 * one unbounded request each: PostgREST cuts a response at db-max-rows (1000 here) with no error, so `ok: true` came
 * back holding the first 1000 counter-parties, and `isExcluded` answered false for everyone in the rows past the cut.
 * GET /hashtags/:tag/feed, which Discovery's hashtag surfaces read, filters all seven tabs on that set.
 *
 * Both reads now carry their exact count; a cut answer is read again whole, by key, and one that cannot be read whole
 * is `ok: false` (the module's own fail-closed answer). The `among` form is bounded by its candidate list and unchanged.
 *
 *   XE0  CONTROL: a few rows in both directions → every counter-party
 *   XE1  1200 people blocked the viewer → the one past the cap is excluded
 *   XE2  the viewer blocked 1200 people → the one past the cap is excluded
 *   XE3  the set is cut and its keyed re-read FAILS → `ok: false`, and everybody is excluded
 *   XE4  the set is cut and its keyed re-read THROWS → `ok: false`
 *   XE5  CONTROL: the `among` form reads only the candidates (two reads, both under the cap)
 *   XE6  CONTROL: a set under the cap costs one read
 *   XG0  CONTROL: the group read over a few rows → both members' counter-parties, never a member
 *   XG1  1200 people blocked a member → the one past the cap is excluded for the group
 *   XG2  the group read is cut and its keyed re-read FAILS → `ok: false`
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readBlockExclusions, readGroupBlockExclusions, isExcluded } from "../lib/exclusionSet.js";
import { cappedClient, seqId, type Row, type SeenRead } from "./helpers/cappedPostgrest.js";

const VIEWER = "a1a1a1a1-aaaa-4aaa-8aaa-000000000001";
const MEMBER2 = "a2a2a2a2-aaaa-4aaa-8aaa-000000000002";
const TARGET = "b2b2b2b2-bbbb-4bbb-8bbb-000000000002";
const BYSTANDER = "d4d4d4d4-dddd-4ddd-8ddd-000000000004";

function rows(n: number, dir: "in" | "out", target: string | null, at: number, who = VIEWER, prefix = "c0000000"): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < n; i++) {
    const other = target !== null && i === at ? target : seqId(prefix, i);
    out.push(dir === "in" ? { blocker_id: other, blocked_id: who } : { blocker_id: who, blocked_id: other });
  }
  return out;
}
type Opts = { fail?: (r: SeenRead) => boolean | "throw"; reads?: SeenRead[] };
const one = (blocks: Row[], opts: Opts = {}, among?: string[]) => readBlockExclusions(cappedClient({ blocks }, opts) as any, VIEWER, among ? { among } : undefined);
const group = (blocks: Row[], opts: Opts = {}) => readGroupBlockExclusions(cappedClient({ blocks }, opts) as any, [VIEWER, MEMBER2]);

describe("census-discovery §123: readBlockExclusions answers the whole set or says it is unreadable", () => {
  it("XE0 CONTROL: a few rows in both directions → every counter-party", async () => {
    const set = await one([...rows(2, "in", TARGET, 0), ...rows(1, "out", null, -1, VIEWER, "d0000000")]);
    assert.equal(set.ok, true);
    assert.deepEqual([isExcluded(set, TARGET), isExcluded(set, seqId("c0000000", 1)), isExcluded(set, seqId("d0000000", 0)), isExcluded(set, BYSTANDER)], [true, true, true, false]);
  });
  it("XE1 1200 people blocked the viewer → the one past the cap is excluded", async () => {
    const set = await one(rows(1200, "in", TARGET, 1100));
    assert.equal(set.ok, true, JSON.stringify(set));
    assert.equal(isExcluded(set, TARGET), true, "someone who blocked the viewer is not excluded");
    assert.equal(isExcluded(set, BYSTANDER), false);
  });
  it("XE2 the viewer blocked 1200 people → the one past the cap is excluded", async () => {
    const set = await one(rows(1200, "out", TARGET, 1100));
    assert.equal(set.ok, true, JSON.stringify(set));
    assert.equal(isExcluded(set, TARGET), true, "someone the viewer blocked is not excluded");
  });
  it("XE3 the set is cut and its keyed re-read FAILS → ok false, everybody excluded", async () => {
    const set = await one(rows(1200, "in", TARGET, 1100), { fail: (r) => r.ordered });
    assert.equal(set.ok, false);
    assert.equal(isExcluded(set, BYSTANDER), true);
  });
  it("XE4 the set is cut and its keyed re-read THROWS → ok false", async () => {
    const set = await one(rows(1200, "in", TARGET, 1100), { fail: (r) => (r.ordered ? "throw" : false) });
    assert.equal(set.ok, false);
  });
  it("XE5 CONTROL: the `among` form reads only the candidates", async () => {
    const reads: SeenRead[] = [];
    const set = await one(rows(1200, "in", TARGET, 1100), { reads }, [TARGET, BYSTANDER]);
    assert.equal(set.ok, true);
    assert.deepEqual([isExcluded(set, TARGET), isExcluded(set, BYSTANDER)], [true, false]);
    assert.equal(reads.length, 2);
  });
  it("XE6 CONTROL: a set under the cap costs one read", async () => {
    const reads: SeenRead[] = [];
    const set = await one(rows(40, "in", TARGET, 3), { reads });
    assert.equal(set.ok && set.ids.size, 40);
    assert.equal(reads.length, 1);
  });
});

describe("census-discovery §123: readGroupBlockExclusions answers the whole set or says it is unreadable", () => {
  it("XG0 CONTROL: a few rows → both members' counter-parties, never a member", async () => {
    const set = await group([...rows(1, "in", TARGET, 0), ...rows(1, "out", null, -1, MEMBER2, "d0000000"), { blocker_id: VIEWER, blocked_id: MEMBER2 }]);
    assert.equal(set.ok, true);
    assert.deepEqual([isExcluded(set, TARGET), isExcluded(set, seqId("d0000000", 0)), isExcluded(set, VIEWER), isExcluded(set, MEMBER2), isExcluded(set, BYSTANDER)], [true, true, false, false, false]);
  });
  it("XG1 1200 people blocked a member → the one past the cap is excluded for the group", async () => {
    const set = await group(rows(1200, "in", TARGET, 1100, MEMBER2));
    assert.equal(set.ok, true, JSON.stringify(set));
    assert.equal(isExcluded(set, TARGET), true, "someone who blocked a member is not excluded");
    assert.equal(isExcluded(set, BYSTANDER), false);
  });
  it("XG2 the group read is cut and its keyed re-read FAILS → ok false", async () => {
    const set = await group(rows(1200, "in", TARGET, 1100, MEMBER2), { fail: (r) => r.ordered });
    assert.equal(set.ok, false);
    assert.equal(isExcluded(set, BYSTANDER), true);
  });
});
