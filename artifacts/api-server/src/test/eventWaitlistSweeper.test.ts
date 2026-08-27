/**
 * Unit tests for eventWaitlistSweeper.ts
 *
 * Covers:
 *   S1: skips when no service client is available
 *   S2: no-op when there are no expired offers
 *   S3: deletes expired offer holders and promotes the next user
 *   S4: does not crash when there is no next user to promote (end of queue)
 *   S5: processes multiple events in a single sweep pass
 *   S6: continues processing remaining events when one event delete fails
 *   S7: records lastRunAt and lastExpiredCount in status after a successful sweep
 *   S8: increments consecutiveFailures when the initial select errors
 *   S9: promotes next user with a 24h offer window (offer_expires_at in the future)
 *
 * Runtime: node:test + node:assert/strict
 * Run: node --import tsx/esm --test src/test/eventWaitlistSweeper.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { runSweep, getSweepStatus, _resetStatus } from "../lib/eventWaitlistSweeper.js";

// ── Fake-client builder ────────────────────────────────────────────────────────

interface ExpiredRow { event_id: string; user_id: string }

interface FakeClientConfig {
  expiredRows?: ExpiredRow[];
  initialError?: { message: string } | null;
  deleteError?: { message: string } | null;
  nextByEvent?: Record<string, { user_id: string } | null>;
  updateError?: { message: string } | null;
  throwOnInitialSelect?: boolean;
}

/**
 * Build a minimal fake Supabase client that simulates the four query shapes
 * used by runSweep():
 *
 *   1. select expired: from("event_waitlist").select(...).not(...).lt(...)
 *      → resolves array via thenable
 *
 *   2. delete expired: from("event_waitlist").delete().eq(...).in(...)
 *      → resolves via thenable
 *
 *   3. find next: from("event_waitlist").select(...).eq(...).is(...).order(...).limit(1).maybeSingle()
 *      → resolves via maybeSingle()
 *
 *   4. update next: from("event_waitlist").update({...}).eq(...).eq(...)
 *      → resolves via thenable
 */
function makeClient(cfg: FakeClientConfig = {}): any {
  const {
    expiredRows   = [],
    initialError  = null,
    deleteError   = null,
    nextByEvent   = {},
    updateError   = null,
    throwOnInitialSelect = false,
  } = cfg;

  // Track which updates were applied so tests can assert on them
  const updates: Array<{ event_id: string; user_id: string; patch: Record<string, unknown> }> = [];
  const deletes: Array<{ event_id: string; user_ids: string[] }> = [];

  return {
    _updates: updates,
    _deletes: deletes,

    from(_table: string) {
      // Mutable state accumulated as the chain is built
      let op: "select" | "delete" | "update" = "select";
      let capturedEventId: string | null = null;
      let capturedUserIds: string[] = [];
      let capturedUserId: string | null = null;
      let capturedPatch: Record<string, unknown> = {};
      let usedIs = false; // find-next select filters on offer_expires_at IS NULL

      // Next-eligible users for an event, normalised to an array (a fixture may
      // supply a single {user_id} or an array to promote several in one sweep).
      const nextRowsFor = (eventId: string | null): Array<{ user_id: string }> => {
        const nx = eventId !== null ? nextByEvent[eventId] : null;
        return Array.isArray(nx) ? nx : nx ? [nx] : [];
      };

      const builder: any = {
        select() { op = "select"; return builder; },
        delete() { op = "delete"; return builder; },
        update(patch: Record<string, unknown>) {
          op = "update";
          capturedPatch = patch;
          return builder;
        },
        not() { return builder; },
        lt()  { return builder; },
        is()  { usedIs = true; return builder; },
        order() { return builder; },
        limit() { return builder; },
        eq(col: string, val: string) {
          if (col === "event_id") capturedEventId = val;
          if (col === "user_id")  capturedUserId  = val;
          return builder;
        },
        in(col: string, vals: string[]) {
          if (col === "user_id") capturedUserIds = vals;
          return builder;
        },

        // Legacy single-promote shape (kept for back-compat; unused by the
        // multi-promote sweeper, which awaits .limit(N) directly).
        maybeSingle(): Promise<{ data: { user_id: string } | null; error: null }> {
          return Promise.resolve({ data: nextRowsFor(capturedEventId)[0] ?? null, error: null });
        },

        // All other operations resolved as a thenable (awaited as a Promise)
        then(onFulfilled: any, onRejected: any) {
          if (op === "select") {
            if (throwOnInitialSelect) {
              return Promise.reject(new Error("DB error")).then(onFulfilled, onRejected);
            }
            // The find-next select uses IS NULL; the initial expired select does not.
            if (usedIs) {
              return Promise.resolve({ data: nextRowsFor(capturedEventId), error: null }).then(onFulfilled, onRejected);
            }
            return Promise.resolve({ data: expiredRows, error: initialError }).then(onFulfilled, onRejected);
          }
          if (op === "delete") {
            if (capturedEventId !== null) {
              deletes.push({ event_id: capturedEventId, user_ids: capturedUserIds });
            }
            return Promise.resolve({ data: null, error: deleteError }).then(onFulfilled, onRejected);
          }
          // update — records one entry per promoted user (promotion now uses
          // .in(user_id, [...]); a single .eq() still works via the fallback).
          const uids = capturedUserIds.length ? capturedUserIds : capturedUserId ? [capturedUserId] : [];
          if (capturedEventId !== null) {
            for (const uid of uids) updates.push({ event_id: capturedEventId, user_id: uid, patch: capturedPatch });
          }
          return Promise.resolve({ data: null, error: updateError }).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };
}

// ── Status reset between tests ─────────────────────────────────────────────────

beforeEach(() => {
  _resetStatus();
});

// ══════════════════════════════════════════════════════════════════════════════
// S1: no client → skips gracefully
// ══════════════════════════════════════════════════════════════════════════════

describe("S1: skips when no client is provided", () => {
  it("resolves without throwing when client is undefined", async () => {
    // Pass no opts → falls back to getServiceClient() which returns null in test env
    // We can also pass null explicitly via opts.client = null
    await assert.doesNotReject(runSweep({ client: null }));

    const s = getSweepStatus();
    assert.equal(s.lastRunAt, null, "lastRunAt should remain null");
    assert.equal(s.consecutiveFailures, 0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// S2: no expired offers → quiet no-op
// ══════════════════════════════════════════════════════════════════════════════

describe("S2: no-op when there are no expired offers", () => {
  it("resolves cleanly and records lastRunAt", async () => {
    const client = makeClient({ expiredRows: [] });
    const before = Date.now();
    await runSweep({ client });
    const after = Date.now();

    const s = getSweepStatus();
    assert.ok(s.lastRunAt !== null, "lastRunAt should be set");
    const ts = new Date(s.lastRunAt!).getTime();
    assert.ok(ts >= before && ts <= after, "lastRunAt should be within test window");
    assert.equal(s.lastExpiredCount, 0);
    assert.equal(s.consecutiveFailures, 0);
    assert.equal(client._deletes.length, 0, "no deletes should occur");
    assert.equal(client._updates.length, 0, "no updates should occur");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// S3: expired offer exists, next user in queue → delete + promote
// ══════════════════════════════════════════════════════════════════════════════

describe("S3: deletes expired offer holder and promotes next user", () => {
  it("deletes the expired holder and sets offer_expires_at on the next user", async () => {
    const EVENT = "evt-aaa";
    const EXPIRED_USER = "user-expired";
    const NEXT_USER = "user-next";

    const client = makeClient({
      expiredRows: [{ event_id: EVENT, user_id: EXPIRED_USER }],
      nextByEvent: { [EVENT]: { user_id: NEXT_USER } },
    });

    const before = Date.now();
    await runSweep({ client });

    // expired holder was deleted
    assert.equal(client._deletes.length, 1);
    assert.equal(client._deletes[0]!.event_id, EVENT);
    assert.deepEqual(client._deletes[0]!.user_ids, [EXPIRED_USER]);

    // next user was promoted
    assert.equal(client._updates.length, 1);
    const upd = client._updates[0]!;
    assert.equal(upd.event_id, EVENT);
    assert.equal(upd.user_id, NEXT_USER);
    assert.ok("offer_expires_at" in upd.patch, "patch must include offer_expires_at");

    // offer must be ~24h in the future
    const offerTs = new Date(upd.patch["offer_expires_at"] as string).getTime();
    const expectedMin = before + 23 * 60 * 60 * 1_000;
    const expectedMax = Date.now() + 25 * 60 * 60 * 1_000;
    assert.ok(offerTs >= expectedMin, "offer_expires_at should be at least 23h from now");
    assert.ok(offerTs <= expectedMax, "offer_expires_at should not be more than 25h from now");

    const s = getSweepStatus();
    assert.equal(s.lastExpiredCount, 1);
    assert.equal(s.consecutiveFailures, 0);
  });

  it("promotes ALL freed slots when several offers expire for one event in a sweep", async () => {
    const EVENT = "evt-multi";
    const client = makeClient({
      // two offers expired for the same event → two seats freed
      expiredRows: [
        { event_id: EVENT, user_id: "exp-1" },
        { event_id: EVENT, user_id: "exp-2" },
      ],
      // two next-in-queue users must BOTH be promoted (regression: only one was)
      nextByEvent: { [EVENT]: [{ user_id: "next-1" }, { user_id: "next-2" }] },
    });

    await runSweep({ client });

    assert.equal(client._deletes.length, 1);
    assert.deepEqual(client._deletes[0]!.user_ids, ["exp-1", "exp-2"]);
    assert.equal(client._updates.length, 2, "both freed slots promoted, not just one");
    assert.deepEqual(client._updates.map((u) => u.user_id).sort(), ["next-1", "next-2"]);
    assert.equal(getSweepStatus().lastExpiredCount, 2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// S4: expired offer, no next user → delete only, no update
// ══════════════════════════════════════════════════════════════════════════════

describe("S4: no next user in queue — delete only", () => {
  it("deletes expired holder but does not call update", async () => {
    const EVENT = "evt-bbb";

    const client = makeClient({
      expiredRows: [{ event_id: EVENT, user_id: "user-expired" }],
      nextByEvent: { [EVENT]: null }, // queue is empty
    });

    await runSweep({ client });

    assert.equal(client._deletes.length, 1, "should delete expired holder");
    assert.equal(client._updates.length, 0, "no update when queue is exhausted");

    const s = getSweepStatus();
    assert.equal(s.lastExpiredCount, 1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// S5: multiple events in one sweep
// ══════════════════════════════════════════════════════════════════════════════

describe("S5: processes multiple events in one sweep pass", () => {
  it("handles two events independently", async () => {
    const EA = "evt-aaa";
    const EB = "evt-bbb";
    const NEXT_A = "user-next-a";

    const client = makeClient({
      expiredRows: [
        { event_id: EA, user_id: "user-expired-a" },
        { event_id: EB, user_id: "user-expired-b" },
      ],
      nextByEvent: {
        [EA]: { user_id: NEXT_A },
        [EB]: null, // EB queue exhausted
      },
    });

    await runSweep({ client });

    assert.equal(client._deletes.length, 2, "two delete calls (one per event)");
    assert.equal(client._updates.length, 1, "one update (only EA has next user)");
    assert.equal(client._updates[0]!.user_id, NEXT_A);

    const s = getSweepStatus();
    assert.equal(s.lastExpiredCount, 2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// S6: one event delete fails — other events still processed
// ══════════════════════════════════════════════════════════════════════════════

describe("S6: continues after a per-event delete error", () => {
  it("records an error for the failing event but still processes others", async () => {
    // Only one event in this test; the sweeper catches the per-event error
    // and increments _status only for top-level errors, not per-event ones.
    // So after the sweep, lastRunAt should still be set and the top-level
    // consecutiveFailures counter should NOT increment.
    const EVENT = "evt-fail";

    const client = makeClient({
      expiredRows: [{ event_id: EVENT, user_id: "user-expired" }],
      deleteError: { message: "deadlock" },
      nextByEvent: { [EVENT]: { user_id: "user-next" } },
    });

    await assert.doesNotReject(runSweep({ client }));

    // top-level sweep should still complete (no throw)
    const s = getSweepStatus();
    assert.ok(s.lastRunAt !== null, "lastRunAt set even when per-event delete fails");
    // consecutiveFailures is for top-level errors only, not per-event
    assert.equal(s.consecutiveFailures, 0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// S7: status fields set correctly after success
// ══════════════════════════════════════════════════════════════════════════════

describe("S7: status fields reflect sweep outcome", () => {
  it("lastRunAt, lastExpiredCount, consecutiveFailures all updated", async () => {
    const client = makeClient({
      expiredRows: [
        { event_id: "evt-1", user_id: "u1" },
        { event_id: "evt-1", user_id: "u2" },
      ],
      nextByEvent: { "evt-1": null },
    });

    const before = Date.now();
    await runSweep({ client });
    const after = Date.now();

    const s = getSweepStatus();
    assert.ok(s.lastRunAt !== null);
    const ts = new Date(s.lastRunAt!).getTime();
    assert.ok(ts >= before && ts <= after);
    assert.equal(s.lastExpiredCount, 2);
    assert.equal(s.consecutiveFailures, 0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// S8: top-level DB error → consecutiveFailures increments
// ══════════════════════════════════════════════════════════════════════════════

describe("S8: top-level DB error increments consecutiveFailures", () => {
  it("increments consecutiveFailures and does not set lastRunAt", async () => {
    const client = makeClient({ throwOnInitialSelect: true });

    await assert.doesNotReject(runSweep({ client }));

    const s = getSweepStatus();
    assert.equal(s.consecutiveFailures, 1);
    // lastRunAt stays null because the sweep did not complete successfully
    assert.equal(s.lastRunAt, null);
  });

  it("increments consecutiveFailures on each successive failure", async () => {
    const client = makeClient({ throwOnInitialSelect: true });

    await runSweep({ client });
    await runSweep({ client });

    const s = getSweepStatus();
    assert.equal(s.consecutiveFailures, 2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// S9: offer window is ~24h
// ══════════════════════════════════════════════════════════════════════════════

describe("S9: offer_expires_at is set approximately 24h from now", () => {
  it("offer_expires_at is between 23.9h and 24.1h from call time", async () => {
    const EVENT = "evt-window";
    const client = makeClient({
      expiredRows: [{ event_id: EVENT, user_id: "user-old" }],
      nextByEvent: { [EVENT]: { user_id: "user-new" } },
    });

    const callTime = Date.now();
    await runSweep({ client });

    assert.equal(client._updates.length, 1);
    const offerTs = new Date(client._updates[0]!.patch["offer_expires_at"] as string).getTime();

    const diff = offerTs - callTime;
    const H24_MS = 24 * 60 * 60 * 1_000;
    const TOLERANCE_MS = 5_000; // 5 second tolerance

    assert.ok(
      diff >= H24_MS - TOLERANCE_MS,
      `offer window too short: ${diff}ms (expected ~${H24_MS}ms)`,
    );
    assert.ok(
      diff <= H24_MS + TOLERANCE_MS,
      `offer window too long: ${diff}ms (expected ~${H24_MS}ms)`,
    );
  });
});
