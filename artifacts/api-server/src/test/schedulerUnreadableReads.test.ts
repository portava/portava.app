/**
 * Two schedulers that read "we could not look" as "there is nothing there".
 *
 * THE CLASS
 * ---------
 * supabase-js RESOLVES on a database error: the promise settles with
 * `{ data: null, error: {...} }`. A read that destructures only `data` therefore
 * produces an EMPTY RESULT for a broken table, and every downstream branch is
 * then reasoning about a fact nobody established. In a background job the cost
 * is not a wrong answer to a user; it is work silently not done, on a schedule,
 * with a clean log.
 *
 * WHAT WAS FOUND, AND WHAT IT COST
 * --------------------------------
 * 1. tripReminderScheduler.sendReminderForTrip discarded the error on BOTH of
 *    its recipient reads.
 *
 *      trip_members unreadable → the crew vanished from the recipient list, the
 *        reminder went to the OWNER ONLY, and markDelivered() then ran — so the
 *        two-phase outbox recorded a delivery that never reached the members
 *        and would never be retried.
 *      profiles unreadable → `recipients` came out empty, the function returned
 *        `true` under the comment "nothing to send; don't block delivery mark",
 *        markDelivered() ran, and the reminder was permanently lost for
 *        EVERYONE on the trip.
 *
 *    Both now throw. That is not a new failure path: the call sites already
 *    wrap this in try/catch, `reminder_delivered_at` stays NULL, and the
 *    recovery sweep retries — which is exactly what the outbox exists for.
 *
 * 2. creatorActivityScoreScheduler's seed anti-join discarded the error on its
 *    base read of creator_activity_scores. An unreadable table produced an
 *    EMPTY "already scored" set, so every profile looked never-scored; the
 *    batch filled with users who already had fresh rows and starved the stale
 *    half — the job's actual work — for as long as the table stayed broken.
 *
 * HOW THIS IS MEASURED
 * --------------------
 * The stub is a THENABLE builder like the real PostgrestBuilder, and it records
 * the query only in `then()`. So "markDelivered was not called" is a counted
 * absence of a settled write, not an inference from a return value; and a
 * builder that a fix accidentally stopped awaiting would show up as a missing
 * request rather than as a silent pass.
 *
 * Every test asserts a non-zero count of the queries it means to have driven,
 * so a stub that stops matching the code cannot leave an assertion vacuous.
 *
 * Runtime: node:test + node:assert/strict (NOT vitest).
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/schedulerUnreadableReads.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { runOnce, clearReminderDedup } from "../lib/tripReminderScheduler.js";
import {
  runActivityScoreJob,
  _setTestClient as _setActivityClient,
  _setTestCalculateFn,
} from "../lib/creatorActivityScoreScheduler.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const DB_ERROR = { message: "connection terminated unexpectedly", code: "57P01" };

const TRIP_ID  = "aa000000-0001-4001-8001-000000000001";
const OWNER_ID = "bb000000-0001-4001-8001-000000000001";

// ── Stub ─────────────────────────────────────────────────────────────────────

interface Settled {
  table: string;
  ops: string[];
  payload: any;
}

type Resolver = (q: Settled) => { data: any; error: any } | null;

function stubClient(resolve: Resolver) {
  const settled: Settled[] = [];

  function builder(table: string, ops: string[], payload: any): any {
    const b: any = {};
    for (const op of ["select", "eq", "neq", "lt", "lte", "gt", "gte", "in", "is", "limit", "order", "not"]) {
      // The first argument is kept in the recorded op so a resolver can tell
      // two reads of the same table apart — the trip sweep's window query and
      // its recovery query differ only in their column list and filters.
      b[op] = (...args: any[]) =>
        builder(table, [...ops, typeof args[0] === "string" ? `${op}:${args[0]}` : op], payload);
    }
    for (const op of ["insert", "update", "upsert", "delete"]) {
      b[op] = (body: any) => builder(table, [...ops, "update"], body ?? payload);
    }
    const settle = (single: boolean) => (onOk: any, onErr: any) => {
      const q: Settled = { table, ops: [...ops], payload };
      settled.push(q);
      const r = resolve(q);
      return Promise.resolve({ count: null, ...(r ?? { data: single ? null : [], error: null }) })
        .then(onOk, onErr);
    };
    b.maybeSingle = () => ({ then: settle(true) });
    b.single = () => ({ then: settle(true) });
    b.then = settle(false);
    return b;
  }

  return {
    settled,
    /** Writes that actually reached the database, by table and payload key. */
    writes(table: string, key: string) {
      return settled.filter(
        (s) => s.table === table && s.ops.includes("update") &&
          s.payload && Object.prototype.hasOwnProperty.call(s.payload, key),
      ).length;
    },
    reads(table: string) {
      return settled.filter((s) => s.table === table && !s.ops.includes("update")).length;
    },
    from(table: string) {
      return builder(table, [], null);
    },
    rpc() {
      return Promise.resolve({ data: null, error: null });
    },
  } as any;
}

/** A trip inside the 22–26 h reminder window, unclaimed. */
function tripRow() {
  return { id: TRIP_ID, title: "Lisbon", owner_id: OWNER_ID };
}

/**
 * The trip reminder sweep's happy plumbing: the window query returns one trip,
 * the CAS claim succeeds. Recipient reads are left to the caller.
 */
function reminderStub(recipients: Resolver) {
  return stubClient((q) => {
    if (q.table === "trips" && q.ops.includes("update")) {
      // Both the claim (reminder_sent_at) and markDelivered (reminder_delivered_at).
      return { data: [{ id: TRIP_ID }], error: null };
    }
    if (q.table === "trips") {
      // The recovery sweep selects reminder_retry_count; leave it with nothing
      // to do so each test drives exactly one send through the main sweep.
      const isRecovery = q.ops.some((o) => o.startsWith("select:") && o.includes("reminder_retry_count"));
      return { data: isRecovery ? [] : [tripRow()], error: null };
    }
    return recipients(q);
  });
}

beforeEach(() => {
  clearReminderDedup(TRIP_ID);
});

afterEach(() => {
  _setTestServiceClient(null as any);
  _setActivityClient(null);
  _setTestCalculateFn(null);
  clearReminderDedup(TRIP_ID);
});

// ═══════════════════════════════════════════════════════════════════════════
// tripReminderScheduler
// ═══════════════════════════════════════════════════════════════════════════

describe("trip reminder: an unreadable recipient list must not be marked delivered", () => {
  it("trip_members unreadable → the reminder is NOT confirmed delivered", async () => {
    const c = reminderStub((q) => {
      if (q.table === "trip_members") return { data: null, error: DB_ERROR };
      return null;
    });
    _setTestServiceClient(c);

    await runOnce();

    assert.equal(
      c.writes("trips", "reminder_sent_at"),
      1,
      "vacuity check: the sweep must have claimed the trip, or nothing below is exercised",
    );
    assert.equal(c.reads("trip_members"), 1, "vacuity check: the crew read must have happened");
    assert.equal(
      c.writes("trips", "reminder_delivered_at"),
      0,
      "an owner-only reminder sent because the crew table was unreadable must NOT be recorded as delivered",
    );
  });

  it("profiles unreadable → the reminder is NOT confirmed delivered", async () => {
    const c = reminderStub((q) => {
      if (q.table === "trip_members") return { data: [], error: null };
      if (q.table === "profiles") return { data: null, error: DB_ERROR };
      return null;
    });
    _setTestServiceClient(c);

    await runOnce();

    assert.equal(c.writes("trips", "reminder_sent_at"), 1);
    assert.equal(c.reads("profiles"), 1, "vacuity check: the profiles read must have happened");
    assert.equal(
      c.writes("trips", "reminder_delivered_at"),
      0,
      "'we could not read profiles' must not be filed as 'nobody has a push token'",
    );
  });

  it("CONTROL: readable tables with genuinely no push tokens IS delivered", async () => {
    // The other side of the distinction. Without this, a fix that simply never
    // marked anything delivered would pass both tests above.
    const c = reminderStub((q) => {
      if (q.table === "trip_members") return { data: [], error: null };
      if (q.table === "profiles") return { data: [{ id: OWNER_ID, expo_push_token: null }], error: null };
      return null;
    });
    _setTestServiceClient(c);

    await runOnce();

    assert.equal(c.writes("trips", "reminder_sent_at"), 1);
    assert.equal(
      c.writes("trips", "reminder_delivered_at"),
      1,
      "an empty recipient list read from a HEALTHY table is a real answer and must complete the outbox",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// creatorActivityScoreScheduler
// ═══════════════════════════════════════════════════════════════════════════

describe("creator activity score: an unreadable scores table is not 'nobody is scored'", () => {
  const P1 = "cc000000-0001-4001-8001-000000000001";
  const P2 = "cc000000-0002-4002-8002-000000000002";

  function activityStub(scoresResult: { data: any; error: any }) {
    return stubClient((q) => {
      if (q.table === "feature_flags") return { data: { enabled: true }, error: null };
      // The stale half: no user is stale, so everything the job does comes from
      // the seed half — which is the half under test.
      if (q.table === "creator_activity_scores" && q.ops.some((o) => o.startsWith("lt:"))) {
        return { data: [], error: null };
      }
      if (q.table === "creator_activity_scores") return scoresResult;
      if (q.table === "profiles") return { data: [{ id: P1 }, { id: P2 }], error: null };
      return null;
    });
  }

  it("scores read fails → the seed half declines rather than treating every profile as unscored", async () => {
    const scored: string[] = [];
    _setTestCalculateFn((async (_db: any, userId: string) => {
      scored.push(userId);
      return null as any;
    }) as any);

    const c = activityStub({ data: null, error: DB_ERROR });
    _setActivityClient(c);

    const summary = await runActivityScoreJob();

    assert.ok(c.reads("creator_activity_scores") >= 1, "vacuity check: the scores table was read");
    assert.deepEqual(
      scored,
      [],
      "with the anti-join base unreadable, every profile looks never-scored — the job must decline, not recompute everyone",
    );
    assert.equal(summary.usersProcessed, 0);
  });

  it("CONTROL: a readable and empty scores table DOES seed the never-scored profiles", async () => {
    // Proves the test above is about the ERROR, not about the seed half being
    // broken outright.
    const scored: string[] = [];
    _setTestCalculateFn((async (_db: any, userId: string) => {
      scored.push(userId);
      return null as any;
    }) as any);

    const c = activityStub({ data: [], error: null });
    _setActivityClient(c);

    await runActivityScoreJob();

    assert.deepEqual(scored.sort(), [P1, P2].sort());
  });
});
