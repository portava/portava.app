/**
 * census-discovery §117 (DV-83 round 20, lane W11-X2; B21): every paged event row read orders its pages by the key that
 * partitions them and asks for an exact count, so pages neither overlap nor skip rows and a cut read is known.
 *
 * `readAllPages` pages with `.range()`; without an ORDER BY over a unique key PostgreSQL may return rows in a different
 * order per page, and without `count: "exact"` a server whose max-rows is below the page size ends the read early.
 * `event_rsvps` and `event_waitlist` are unique on (event_id, user_id).
 *
 *   ER1  readGoingRsvpsForEvents → count exact; order event_id, user_id; then range
 *   ER2  readWaitlistForEvents   → count exact; order event_id, user_id; then range
 *   ER3  readEventRsvps          → count exact; order user_id; then range
 *   ER4  readEventWaitlist       → count exact; order user_id; then range
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readGoingRsvpsForEvents, readWaitlistForEvents, readEventRsvps, readEventWaitlist } from "../lib/eventRowReads.js";

async function calls(read: (sc: any) => Promise<unknown>): Promise<string[]> {
  const out: string[] = [];
  const q: any = new Proxy({}, { get: (_t, k: string) => k === "then"
    ? (res: any) => Promise.resolve({ data: [], error: null, count: 0 }).then(res)
    : (...a: unknown[]) => { out.push(`${k}(${JSON.stringify(a)})`); return q; } });
  await read({ from: (t: string) => { out.push(`from(${t})`); return q; } });
  return out;
}
function ordered(c: string[], keys: string[]) {
  assert.ok(c.some((x) => x.startsWith("select(") && x.includes('{"count":"exact"}')), c.join(" "));
  const range = c.findIndex((x) => x.startsWith("range("));
  assert.ok(range > 0, c.join(" "));
  const orders = c.filter((x) => x.startsWith("order(")).map((x) => JSON.parse(x.slice(6, -1))[0]);
  assert.deepEqual(orders, keys, c.join(" "));
  assert.ok(c.findIndex((x) => x.startsWith("order(")) < range, c.join(" "));
}

describe("census-discovery §117 (B21): the paged event row reads are ordered by their partition key", () => {
  it("ER1 readGoingRsvpsForEvents", async () => ordered(await calls((sc) => readGoingRsvpsForEvents(sc, ["e1"])), ["event_id", "user_id"]));
  it("ER2 readWaitlistForEvents", async () => ordered(await calls((sc) => readWaitlistForEvents(sc, ["e1"])), ["event_id", "user_id"]));
  it("ER3 readEventRsvps", async () => ordered(await calls((sc) => readEventRsvps(sc, "e1", { status: "going" })), ["user_id"]));
  it("ER4 readEventWaitlist", async () => ordered(await calls((sc) => readEventWaitlist(sc, "e1")), ["user_id"]));
});
