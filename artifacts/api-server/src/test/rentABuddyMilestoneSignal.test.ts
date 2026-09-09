/**
 * The two Telegraph booking emitters must leave a TRACE when a milestone is lost.
 *
 * ── WHY THIS SUITE EXISTS ────────────────────────────────────────────────────
 * `emitBookingMilestone` and `emitBookingCard` are fire-and-forget: they insert
 * a system message into a booking's Telegraph thread after a state transition,
 * and they must never fail the booking transition itself. Until 2026-09-08 they
 * achieved that by dropping every failure on the floor — neither the
 * `rent_buddy_bookings` read nor the `messages` insert bound `.error`, and the
 * enclosing `catch {}` named nothing.
 *
 * Measured before the fix, by running verbatim copies of both bodies against an
 * instrumented client: the healthy path issued 2 requests and produced 0
 * observable outputs, and so did every failure mode. The writes WERE issued —
 * this was never the un-awaited-thenable defect, since both are real async
 * functions — so a booking could silently never get its "Buddy accepted" card,
 * leaving two people looking at a thread that does not say what happened, with
 * nothing anywhere recording that it should have.
 *
 * Non-fatal was right. Silent was not. Those are different properties, and this
 * suite pins the second one.
 *
 * ── WHY IT ASSERTS ON A LOG ──────────────────────────────────────────────────
 * Because the log is the entire output. There is no response to inspect (the
 * callers use `void`), no row to count (the write is what failed), and no return
 * value (both return `Promise<void>`). A test that asserted anything else here
 * would be asserting something these functions do not do.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { logger } from "../lib/logger.js";
import { emitBookingMilestone, emitBookingCard } from "../routes/rentABuddy.js";

type Logged = { obj: any; msg: string };

let logged: Logged[] = [];
let realError: any;

beforeEach(() => {
  logged = [];
  realError = (logger as any).error;
  (logger as any).error = (obj: any, msg?: string) => {
    logged.push(typeof obj === "string" ? { obj: {}, msg: obj } : { obj, msg: String(msg ?? "") });
  };
});
afterEach(() => {
  (logger as any).error = realError;
});

const DB_ERROR = { code: "57P01", message: "terminating connection due to administrator command" };
const BOOKING = "bk-1";
const THREAD = "th-1";

/**
 * A client whose two calls can each be made to fail INDEPENDENTLY, because the
 * two failure modes have different consequences and must be distinguishable.
 * `requests` is recorded so a case cannot pass by the emitter never reaching the
 * call at all.
 */
function client(opts: { readError?: any; insertError?: any; threadId?: string | null; throwOn?: "read" | "insert" }) {
  const requests: string[] = [];
  return {
    requests,
    sc: {
      from(table: string) {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => {
            requests.push(`select ${table}`);
            if (opts.throwOn === "read") throw new Error("socket hang up");
            if (opts.readError) return { data: null, error: opts.readError };
            return {
              data: {
                telegraph_thread_id: opts.threadId === undefined ? THREAD : opts.threadId,
                booking_date: "2026-09-09", start_time: "18:00", duration_h: 2,
                city: "Lisbon", category: "city", total_usd: 80,
              },
              error: null,
            };
          },
          insert: async (_row: any) => {
            requests.push(`insert ${table}`);
            if (opts.throwOn === "insert") throw new Error("socket hang up");
            return { data: null, error: opts.insertError ?? null };
          },
        };
      },
    },
  };
}

const errorsMentioning = (needle: string) => logged.filter((l) => l.msg.includes(needle));

describe("emitBookingMilestone", () => {
  it("the HEALTHY path is silent — the signal must mean something", async () => {
    const c = client({});
    await emitBookingMilestone(c.sc as any, BOOKING, "u1", "rent_buddy_accepted", "Buddy accepted!");
    assert.deepEqual(c.requests, ["select rent_buddy_bookings", "insert messages"], "it must reach both calls");
    assert.deepEqual(logged, [], "a successful milestone must log nothing at error level");
  });

  it("an unreadable booking is reported as LOST, not skipped", async () => {
    const c = client({ readError: DB_ERROR });
    await emitBookingMilestone(c.sc as any, BOOKING, "u1", "rent_buddy_accepted", "Buddy accepted!");
    assert.deepEqual(c.requests, ["select rent_buddy_bookings"], "it must not attempt the insert");
    const hits = errorsMentioning("could not read the booking's thread id");
    assert.equal(hits.length, 1, `expected one error log, got ${JSON.stringify(logged)}`);
    assert.equal(hits[0].obj.bookingId, BOOKING, "the log must name the booking");
    assert.equal(hits[0].obj.subtype, "rent_buddy_accepted", "the log must name what was lost");
    assert.equal(hits[0].obj.err, DB_ERROR, "the log must carry the database's own error");
  });

  it("a booking with NO thread is silent — absence is not failure", async () => {
    const c = client({ threadId: null });
    await emitBookingMilestone(c.sc as any, BOOKING, "u1", "rent_buddy_accepted", "Buddy accepted!");
    assert.deepEqual(c.requests, ["select rent_buddy_bookings"]);
    assert.deepEqual(logged, [], "a booking with no Telegraph thread has nowhere to put the message");
  });

  it("a refused INSERT is reported, and names the thread", async () => {
    const c = client({ insertError: DB_ERROR });
    await emitBookingMilestone(c.sc as any, BOOKING, "u1", "rent_buddy_started", "Meetup started!");
    assert.deepEqual(c.requests, ["select rent_buddy_bookings", "insert messages"]);
    const hits = errorsMentioning("system message INSERT refused");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].obj.threadId, THREAD);
    assert.equal(hits[0].obj.subtype, "rent_buddy_started");
  });

  it("a THROWN transport failure is reported rather than swallowed", async () => {
    const c = client({ throwOn: "read" });
    await emitBookingMilestone(c.sc as any, BOOKING, "u1", "rent_buddy_completed", "Done!");
    assert.equal(errorsMentioning("threw — milestone LOST").length, 1);
  });

  it("it still never throws — a lost milestone must not fail the booking transition", async () => {
    const c = client({ throwOn: "insert" });
    await assert.doesNotReject(() => emitBookingMilestone(c.sc as any, BOOKING, "u1", "s", "b"));
  });
});

describe("emitBookingCard", () => {
  it("the HEALTHY path is silent and writes the card", async () => {
    const c = client({});
    await emitBookingCard(c.sc as any, BOOKING, "u1", "scheduled");
    assert.deepEqual(c.requests, ["select rent_buddy_bookings", "insert messages"]);
    assert.deepEqual(logged, []);
  });

  it("an unreadable booking is reported, and the log says the thread keeps the PREVIOUS card", async () => {
    const c = client({ readError: DB_ERROR });
    await emitBookingCard(c.sc as any, BOOKING, "u1", "cancelled");
    const hits = errorsMentioning("card LOST, not skipped");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].obj.newStatus, "cancelled", "the log must name the status that never reached the thread");
    // The consequence is worse than an absent message and the log says so: the
    // thread goes on displaying the last card that DID land, which is now a
    // false statement about the booking rather than a missing one.
    assert.match(hits[0].msg, /PREVIOUS status card/);
  });

  it("a refused INSERT is reported with the status that was lost", async () => {
    const c = client({ insertError: DB_ERROR });
    await emitBookingCard(c.sc as any, BOOKING, "u1", "disputed");
    const hits = errorsMentioning("booking card INSERT refused");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].obj.newStatus, "disputed");
    assert.equal(hits[0].obj.threadId, THREAD);
  });

  it("it still never throws", async () => {
    const c = client({ throwOn: "insert" });
    await assert.doesNotReject(() => emitBookingCard(c.sc as any, BOOKING, "u1", "completed"));
    assert.equal(errorsMentioning("emitBookingCard threw").length, 1);
  });
});

describe("the suite is not vacuous", () => {
  it("the log spy actually intercepts — otherwise every assertion above is about an empty array", () => {
    logged = [];
    (logger as any).error({ probe: true }, "spy check");
    assert.equal(logged.length, 1, "logger.error was not intercepted; the cases above prove nothing");
    assert.equal(logged[0].msg, "spy check");
  });
});
