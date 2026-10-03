/**
 * census-discovery §118 (DV-83 round 21, lane W11-X2; the round-20 verifier's mutation survivor R2, fixture LZ0/LZ1):
 * `liveEventCounters` writes the live count onto EVERY event row it was asked about, 0 included.
 *
 * An event whose live read answers whole with no rows has a live count of 0. Its cached counter (here 3 going and 2
 * waiting, the stale value a failed recount leaves by design, D-W11X2-160) must be overwritten with 0, not kept and
 * served as measured. Writing only the events that have rows (`counts.has(row.id)`, R2) kept it; no round-20 suite had
 * an event whose live count is 0 beside a non-zero cached counter, so R2 survived.
 *
 *   LZ0  CONTROL: one going row → going_count 1, nothing named
 *   LZ1  no live rows (a whole, empty answer) → going_count 0 and waitlist_count 0, nothing named
 *   LZ2  two events, one with rows and one without → the one without is 0, the other its live count
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { liveEventCounters } from "../lib/eventRowReads.js";

const E = "e1000000-0000-4000-8000-000000000001";
const F = "e2000000-0000-4000-8000-000000000002";
function sc(going: Array<{ event_id: string; user_id: string }>) {
  return { from: (t: string) => { const rows = t === "event_rsvps" ? going : []; let r: [number, number] = [0, 999];
    const q: any = { select: () => q, in: () => q, eq: () => q, gt: () => q, or: () => q, order: () => q, range: (a: number, b: number) => { r = [a, b]; return q; },
      then: (res: any, rej: any) => Promise.resolve({ data: rows.slice(r[0], r[1] + 1), error: null, count: rows.length }).then(res, rej) };
    return q; } };
}

describe("census-discovery §118 (R2): liveEventCounters over a whole, empty live read", () => {
  it("LZ0 CONTROL: one going row → going_count 1", async () => {
    const rows = [{ id: E, going_count: 3, waitlist_count: 2 }];
    assert.deepEqual(await liveEventCounters(sc([{ event_id: E, user_id: "u1" }]), rows), []);
    assert.equal(rows[0].going_count, 1);
  });
  it("LZ1 no live rows → 0 going, 0 waiting (never the cached 3 and 2 as measured)", async () => {
    const rows = [{ id: E, going_count: 3, waitlist_count: 2 }];
    const failed = await liveEventCounters(sc([]), rows);
    assert.deepEqual({ failed, going: rows[0].going_count, waiting: rows[0].waitlist_count }, { failed: [], going: 0, waiting: 0 });
  });
  it("LZ2 two events, one with rows and one without → 0 for the one without", async () => {
    const rows = [{ id: E, going_count: 7, waitlist_count: 0 }, { id: F, going_count: 4, waitlist_count: 0 }];
    const failed = await liveEventCounters(sc([{ event_id: E, user_id: "u1" }, { event_id: E, user_id: "u2" }]), rows, { going: true });
    assert.deepEqual({ failed, e: rows[0].going_count, f: rows[1].going_count }, { failed: [], e: 2, f: 0 });
  });
});
