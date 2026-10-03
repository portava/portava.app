/**
 * census-discovery §117 (DV-83 round 20, lane W11-X2; sweep SW19): the review recount reads every rating, never a page
 * PostgREST's db-max-rows cut.
 *
 * POST /events/:id/reviews recomputed `events.review_count` and `events.avg_rating` from one unbounded
 * `event_reviews` read. Past 1000 reviews the read is cut silently, so the counter was stamped 1000 and the average was
 * the average of whichever 1000 came back — B21's shape on a write path. The read now goes through `readAllPages`
 * (`readEventRatings`, lib/eventRowReads.ts): a whole read stamps the whole count, and a cut read is an error, so the
 * round-19 rule (SW11: a failed ratings read writes neither column) leaves both alone.
 *
 *   RV1  1200 reviews (1000 of 5, 200 of 1), the server caps at 1000 → the stamp is the uncapped one (count and average)
 *   RV0  CONTROL: 3 reviews, capped at 1000 → the stamp equals the uncapped one
 *   RV2  the pages are ordered by `reviewer_id`, the key that partitions them, and ask for an exact count (and select it: §118's
 *        keyed pages start after the last reviewer received)
 *   RV3  a server whose cap (500) is below the page size → still the uncapped stamp (the count, not a short page, ends it)
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { world, eventsServer, stamps, EVENT, W1 } from "./helpers/eventsWorld.js";
import { readEventRatings } from "../lib/eventRowReads.js";

const reviews = (n5: number, n1: number) => [
  ...Array.from({ length: n5 }, (_, i) => ({ event_id: EVENT, reviewer_id: `r5-${String(i).padStart(5, "0")}`, rating: 5 })),
  ...Array.from({ length: n1 }, (_, i) => ({ event_id: EVENT, reviewer_id: `r1-${String(i).padStart(5, "0")}`, rating: 1 })),
];
const done = (rows: Record<string, any>[], dbMaxRows?: number) => world({
  ev: { state: "completed" }, dbMaxRows,
  extra: { event_attendee_states: [{ event_id: EVENT, user_id: W1, confirmed_at: "2026-09-01T00:00:00.000Z" }], event_reviews: rows },
});

describe("census-discovery §117 (SW19): the review recount reads every rating", () => {
  let srv: Awaited<ReturnType<typeof eventsServer>>;
  before(async () => { srv = await eventsServer(); });
  after(() => srv.close());

  const stamped = async (rows: Record<string, any>[], dbMaxRows?: number) => {
    const w = done(rows, dbMaxRows);
    const r = await srv.req("t-w1", "POST", `/events/${EVENT}/reviews`, { rating: 5 });
    assert.equal(r.status, 201, r.text);
    return { count: stamps(w.writes, "review_count"), avg: stamps(w.writes, "avg_rating") };
  };

  it("RV1 1200 reviews, the server caps every answer at 1000 → review_count and avg_rating are the uncapped ones", async () => {
    const whole = await stamped(reviews(1000, 200));
    assert.equal(whole.count.length, 1, JSON.stringify(whole));
    assert.ok((whole.count[0] as number) >= 1200, JSON.stringify(whole));
    const capped = await stamped(reviews(1000, 200), 1000);
    assert.deepEqual(capped, whole, `a ratings read cut at db-max-rows was stamped: ${JSON.stringify({ capped, whole })}`);
  });
  it("RV0 CONTROL: 3 reviews, capped at 1000 → the same stamp as uncapped", async () => {
    const whole = await stamped(reviews(2, 1));
    assert.equal(whole.count.length, 1, JSON.stringify(whole));
    assert.deepEqual(await stamped(reviews(2, 1), 1000), whole);
  });
  it("RV2 the pages are ordered by reviewer_id and ask for an exact count", async () => {
    const calls: string[] = [];
    const q: any = new Proxy({}, { get: (_t, k: string) => k === "then"
      ? (res: any) => Promise.resolve({ data: [{ rating: 4 }], error: null, count: 1 }).then(res)
      : (...a: unknown[]) => { calls.push(`${k}(${JSON.stringify(a)})`); return q; } });
    const r = await readEventRatings({ from: (t: string) => { calls.push(`from(${t})`); return q; } }, EVENT);
    assert.deepEqual(r, { data: [{ rating: 4 }], error: null });
    assert.ok(calls.includes('select(["reviewer_id, rating",{"count":"exact"}])'), calls.join(" "));  // §118 (B23): the read selects the key it pages by
    assert.ok(calls.includes('order(["reviewer_id"])'), calls.join(" "));
    assert.ok(calls.indexOf('order(["reviewer_id"])') < calls.findIndex((c) => c.startsWith("range(")), calls.join(" "));
  });
  it("RV3 a server whose cap (500) is below the page size → the uncapped stamp", async () => {
    const whole = await stamped(reviews(1000, 200));
    assert.deepEqual(await stamped(reviews(1000, 200), 500), whole);
  });
});
