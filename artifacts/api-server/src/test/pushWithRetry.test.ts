/**
 * sendPushWithRetry tests
 *
 * The shared helper used by direct push callers (trips, events, meetups,
 * memories, availability, schedulers) so transient Expo failures are enqueued
 * on the PushRetryQueue instead of dropped.
 *
 *   1. success → push sent once, nothing enqueued
 *   2. Expo 5xx (retryable) → one push_retry_queue row per recipient
 *   3. network error (retryable) → enqueued
 *   4. per-token error (DeviceNotRegistered) → NOT enqueued
 *   5. no valid tokens → no Expo call, nothing enqueued
 *   6. null db on retryable failure → no throw
 *
 * Run: node --import tsx/esm --test src/test/pushWithRetry.test.ts
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";

import { _setTestFetch } from "../lib/push.js";
import { sendPushWithRetry, _setTestClearDeadTokens } from "../lib/pushWithRetry.js";

const USER1 = "aa000000-0001-0001-0001-000000000001";
const USER2 = "aa000000-0002-0002-0002-000000000002";
const TOKEN1 = "ExponentPushToken[user1]";
const TOKEN2 = "ExponentPushToken[user2]";

const PAYLOAD = {
  title: "Trip update",
  body: "Something happened",
  data: { type: "trip_update", tripId: "trip-1" },
};

// ── Fakes ─────────────────────────────────────────────────────────────────────

let pushCalls: Array<{ messages: any[] }> = [];
let ticketFor: (to: string) => any = () => ({ status: "ok", id: "t" });

function okFetch(): typeof fetch {
  return (async (_url: any, init: any) => {
    const messages = JSON.parse(init.body);
    pushCalls.push({ messages });
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: messages.map((m: any) => ticketFor(m.to)) }),
    } as any;
  }) as any;
}

function fetch503(): typeof fetch {
  return (async () => ({ ok: false, status: 503, json: async () => ({}) })) as any;
}

function makeFakeDb() {
  const inserted: Record<string, any[]> = {};
  const updates: Array<{ table: string; values: any; filter: { column: string; values: any[] } }> = [];
  const deletes: Array<{ table: string; filter: { column: string; values: any[] } }> = [];
  return {
    __inserted: inserted,
    __updates: updates,
    __deletes: deletes,
    from(table: string) {
      return {
        insert(row: any) {
          if (!inserted[table]) inserted[table] = [];
          inserted[table].push(row);
          return Promise.resolve({ error: null });
        },
        update(values: any) {
          return {
            in(column: string, vals: any[]) {
              updates.push({ table, values, filter: { column, values: vals } });
              return Promise.resolve({ error: null });
            },
          };
        },
        delete() {
          return {
            in(column: string, vals: any[]) {
              deletes.push({ table, filter: { column, values: vals } });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  } as any;
}

before(() => { _setTestFetch(okFetch()); });
after(() => { _setTestFetch(null); });
afterEach(() => {
  pushCalls = [];
  ticketFor = () => ({ status: "ok", id: "t" });
  _setTestFetch(okFetch());
  _setTestClearDeadTokens(null);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("sendPushWithRetry", () => {
  it("sends the push and enqueues nothing on success", async () => {
    const db = makeFakeDb();
    const result = await sendPushWithRetry(
      db,
      [{ userId: USER1, tokens: [TOKEN1] }, { userId: USER2, tokens: [TOKEN2] }],
      PAYLOAD,
    );
    assert.equal(result.sent, 2);
    assert.equal(pushCalls.length, 1);
    assert.deepEqual(pushCalls[0].messages.map((m: any) => m.to).sort(), [TOKEN1, TOKEN2].sort());
    assert.equal((db.__inserted["push_retry_queue"] ?? []).length, 0);
  });

  it("enqueues one retry row per recipient when Expo returns a 5xx", async () => {
    _setTestFetch(fetch503());
    const db = makeFakeDb();
    const result = await sendPushWithRetry(
      db,
      [{ userId: USER1, tokens: [TOKEN1] }, { userId: USER2, tokens: [TOKEN2] }],
      PAYLOAD,
    );
    assert.equal(result.retryable, true);

    const rows = db.__inserted["push_retry_queue"] ?? [];
    assert.equal(rows.length, 2, "one retry-queue row per recipient");
    const byUser = new Map(rows.map((r: any) => [r.user_id, r]));
    assert.deepEqual(byUser.get(USER1)?.tokens, [TOKEN1]);
    assert.deepEqual(byUser.get(USER2)?.tokens, [TOKEN2]);
    for (const row of rows) {
      assert.equal(row.status, "queued");
      assert.equal(row.payload.title, PAYLOAD.title);
      assert.equal(row.payload.data.type, "trip_update");
    }
  });

  it("enqueues on a network error", async () => {
    _setTestFetch((async () => { throw new Error("ECONNRESET"); }) as any);
    const db = makeFakeDb();
    const result = await sendPushWithRetry(db, { userId: USER1, tokens: [TOKEN1] }, PAYLOAD);
    assert.equal(result.retryable, true);
    assert.equal((db.__inserted["push_retry_queue"] ?? []).length, 1);
  });

  it("does not enqueue on per-token errors (DeviceNotRegistered)", async () => {
    ticketFor = () => ({ status: "error", message: "gone", details: { error: "DeviceNotRegistered" } });
    const db = makeFakeDb();
    const result = await sendPushWithRetry(db, { userId: USER1, tokens: [TOKEN1] }, PAYLOAD);
    assert.equal(result.sent, 0);
    assert.equal(result.errors.length, 1);
    assert.equal((db.__inserted["push_retry_queue"] ?? []).length, 0);
  });

  it("does not enqueue on per-token errors (InvalidCredentials)", async () => {
    ticketFor = () => ({ status: "error", message: "creds bad", details: { error: "InvalidCredentials" } });
    const db = makeFakeDb();
    const result = await sendPushWithRetry(db, { userId: USER1, tokens: [TOKEN1] }, PAYLOAD);
    assert.equal(result.sent, 0);
    assert.equal(result.errors.length, 1);
    assert.equal((db.__inserted["push_retry_queue"] ?? []).length, 0);
  });

  it("clears dead tokens from all three tables on DeviceNotRegistered", async () => {
    ticketFor = (to: string) =>
      to === TOKEN1
        ? { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }
        : { status: "ok", id: "t" };
    const db = makeFakeDb();
    await sendPushWithRetry(
      db,
      [{ userId: USER1, tokens: [TOKEN1] }, { userId: USER2, tokens: [TOKEN2] }],
      PAYLOAD,
    );

    const profileUpdate = db.__updates.find((u: any) => u.table === "profiles");
    assert.ok(profileUpdate, "profiles.expo_push_token cleared");
    assert.deepEqual(profileUpdate.values, { expo_push_token: null });
    assert.deepEqual(profileUpdate.filter, { column: "expo_push_token", values: [TOKEN1] });

    const rentBuddyUpdate = db.__updates.find((u: any) => u.table === "rent_buddy_profiles");
    assert.ok(rentBuddyUpdate, "rent_buddy_profiles.expo_push_token cleared");
    assert.deepEqual(rentBuddyUpdate.filter, { column: "expo_push_token", values: [TOKEN1] });

    const deviceDelete = db.__deletes.find((d: any) => d.table === "notification_devices");
    assert.ok(deviceDelete, "notification_devices row deleted");
    assert.deepEqual(deviceDelete.filter, { column: "push_token", values: [TOKEN1] });
  });

  it("clears dead tokens from all three tables on InvalidCredentials", async () => {
    ticketFor = (to: string) =>
      to === TOKEN1
        ? { status: "error", message: "creds bad", details: { error: "InvalidCredentials" } }
        : { status: "ok", id: "t" };
    const db = makeFakeDb();
    await sendPushWithRetry(
      db,
      [{ userId: USER1, tokens: [TOKEN1] }, { userId: USER2, tokens: [TOKEN2] }],
      PAYLOAD,
    );

    const profileUpdate = db.__updates.find((u: any) => u.table === "profiles");
    assert.ok(profileUpdate, "profiles.expo_push_token cleared");
    assert.deepEqual(profileUpdate.values, { expo_push_token: null });
    assert.deepEqual(profileUpdate.filter, { column: "expo_push_token", values: [TOKEN1] });

    const rentBuddyUpdate = db.__updates.find((u: any) => u.table === "rent_buddy_profiles");
    assert.ok(rentBuddyUpdate, "rent_buddy_profiles.expo_push_token cleared");
    assert.deepEqual(rentBuddyUpdate.filter, { column: "expo_push_token", values: [TOKEN1] });

    const deviceDelete = db.__deletes.find((d: any) => d.table === "notification_devices");
    assert.ok(deviceDelete, "notification_devices row deleted");
    assert.deepEqual(deviceDelete.filter, { column: "push_token", values: [TOKEN1] });
  });

  it("clears both DeviceNotRegistered and InvalidCredentials tokens in one pass", async () => {
    const TOKEN3 = "ExponentPushToken[user3]";
    ticketFor = (to: string) => {
      if (to === TOKEN1) return { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } };
      if (to === TOKEN3) return { status: "error", message: "creds bad", details: { error: "InvalidCredentials" } };
      return { status: "ok", id: "t" };
    };
    const USER3 = "aa000000-0003-0003-0003-000000000003";
    const db = makeFakeDb();
    await sendPushWithRetry(
      db,
      [
        { userId: USER1, tokens: [TOKEN1] },
        { userId: USER2, tokens: [TOKEN2] },
        { userId: USER3, tokens: [TOKEN3] },
      ],
      PAYLOAD,
    );

    const profileUpdate = db.__updates.find((u: any) => u.table === "profiles");
    assert.ok(profileUpdate, "profiles.expo_push_token cleared for both bad tokens");
    assert.deepEqual(
      [...profileUpdate.filter.values].sort(),
      [TOKEN1, TOKEN3].sort(),
    );

    const deviceDelete = db.__deletes.find((d: any) => d.table === "notification_devices");
    assert.ok(deviceDelete, "notification_devices rows deleted for both bad tokens");
    assert.deepEqual(
      [...deviceDelete.filter.values].sort(),
      [TOKEN1, TOKEN3].sort(),
    );
  });

  /**
   * Mixed dead-token batch: 2 ok + 1 DeviceNotRegistered + 1 InvalidCredentials
   *
   * Verifies that the initial push path (sendPushWithRetry / push.ts) collects
   * BOTH dead-token codes in a single clearDeadTokens call — matching the
   * guarantee already tested for PushRetryQueue.processQueue.
   *
   * Requirements:
   *   - profiles and rent_buddy_profiles each receive exactly ONE update whose
   *     .in filter contains both dead tokens and neither live token.
   *   - notification_devices receives exactly ONE delete whose .in filter
   *     contains both dead tokens and neither live token.
   */
  it("collects DeviceNotRegistered and InvalidCredentials dead tokens in one clearDeadTokens call on the initial send path", async () => {
    const TOKEN3 = "ExponentPushToken[user3-dead-dnr]";
    const TOKEN4 = "ExponentPushToken[user4-dead-ic]";
    const USER3  = "aa000000-0003-0003-0003-000000000003";
    const USER4  = "aa000000-0004-0004-0004-000000000004";

    // TOKEN1 ok, TOKEN2 ok, TOKEN3 DeviceNotRegistered, TOKEN4 InvalidCredentials
    ticketFor = (to: string) => {
      if (to === TOKEN3) return { status: "error", message: "gone",      details: { error: "DeviceNotRegistered" } };
      if (to === TOKEN4) return { status: "error", message: "creds bad", details: { error: "InvalidCredentials"  } };
      return { status: "ok", id: "t" };
    };

    const db = makeFakeDb();
    const result = await sendPushWithRetry(
      db,
      [
        { userId: USER1, tokens: [TOKEN1] },
        { userId: USER2, tokens: [TOKEN2] },
        { userId: USER3, tokens: [TOKEN3] },
        { userId: USER4, tokens: [TOKEN4] },
      ],
      PAYLOAD,
    );

    // Two ok tickets delivered
    assert.equal(result.sent, 2);
    // Two per-token errors surfaced
    assert.equal(result.errors.length, 2);

    // ── Exactly one clearDeadTokens call (= one update per cleared table + one delete) ──

    const profileUpdates = db.__updates.filter((u: any) => u.table === "profiles");
    assert.equal(profileUpdates.length, 1, "profiles: exactly one .in() update (single clearDeadTokens call)");
    const profileTokens = [...profileUpdates[0].filter.values].sort();
    assert.deepEqual(profileTokens, [TOKEN3, TOKEN4].sort(), "profiles filter must contain both dead tokens");
    assert.ok(!profileTokens.includes(TOKEN1), "live TOKEN1 must NOT appear in profiles filter");
    assert.ok(!profileTokens.includes(TOKEN2), "live TOKEN2 must NOT appear in profiles filter");

    const deviceDeletes = db.__deletes.filter((d: any) => d.table === "notification_devices");
    assert.equal(deviceDeletes.length, 1, "notification_devices: exactly one .in() delete (single clearDeadTokens call)");
    const deviceTokens = [...deviceDeletes[0].filter.values].sort();
    assert.deepEqual(deviceTokens, [TOKEN3, TOKEN4].sort(), "notification_devices filter must contain both dead tokens");
    assert.ok(!deviceTokens.includes(TOKEN1), "live TOKEN1 must NOT appear in notification_devices filter");
    assert.ok(!deviceTokens.includes(TOKEN2), "live TOKEN2 must NOT appear in notification_devices filter");

    const rentUpdates = db.__updates.filter((u: any) => u.table === "rent_buddy_profiles");
    assert.equal(rentUpdates.length, 1, "rent_buddy_profiles: exactly one .in() update (single clearDeadTokens call)");
    const rentTokens = [...rentUpdates[0].filter.values].sort();
    assert.deepEqual(rentTokens, [TOKEN3, TOKEN4].sort(), "rent_buddy_profiles filter must contain both dead tokens");
    assert.ok(!rentTokens.includes(TOKEN1), "live TOKEN1 must NOT appear in rent_buddy_profiles filter");
    assert.ok(!rentTokens.includes(TOKEN2), "live TOKEN2 must NOT appear in rent_buddy_profiles filter");

    // Nothing enqueued for retry — dead-token errors are non-retryable
    assert.equal((db.__inserted["push_retry_queue"] ?? []).length, 0);
  });

  /**
   * Multi-token user: one dead token among live siblings.
   *
   * USER1 carries two tokens: TOKEN1 (ok) and TOKEN1_DEAD (DeviceNotRegistered).
   * USER2 carries a single token: TOKEN2 (ok).
   *
   * Requirements:
   *   - clearDeadTokens fires with only TOKEN1_DEAD in its filter.
   *   - TOKEN1 (live sibling of the same user) must NOT appear in any
   *     profiles update, rent_buddy_profiles update, or notification_devices
   *     delete filter.
   *   - TOKEN2 (live token of a different user) must also NOT appear.
   *   - result.sent must equal 3 (three ok tickets: TOKEN1, TOKEN2, TOKEN1 again
   *     is one token — actually 3 ok: TOKEN1, TOKEN2... wait TOKEN1_DEAD is dead).
   *     Actually sent = 2 (TOKEN1 ok + TOKEN2 ok), errors = 1 (TOKEN1_DEAD).
   */
  it("clears only the dead sibling token when one user has multiple tokens and one is DeviceNotRegistered", async () => {
    const TOKEN1_DEAD = "ExponentPushToken[user1-dead]";

    // TOKEN1 ok, TOKEN1_DEAD DeviceNotRegistered, TOKEN2 ok
    ticketFor = (to: string) =>
      to === TOKEN1_DEAD
        ? { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }
        : { status: "ok", id: "t" };

    const db = makeFakeDb();
    const result = await sendPushWithRetry(
      db,
      [
        { userId: USER1, tokens: [TOKEN1, TOKEN1_DEAD] }, // multi-token user
        { userId: USER2, tokens: [TOKEN2] },              // single-token user
      ],
      PAYLOAD,
    );

    // Two ok tickets, one dead-token error
    assert.equal(result.sent, 2, "two ok tickets: TOKEN1 and TOKEN2");
    assert.equal(result.errors.length, 1, "one dead-token error: TOKEN1_DEAD");
    assert.equal(result.errors[0].token, TOKEN1_DEAD);

    // profiles: only TOKEN1_DEAD in the filter — not the live TOKEN1 or TOKEN2
    const profileUpdates = db.__updates.filter((u: any) => u.table === "profiles");
    assert.equal(profileUpdates.length, 1, "profiles: exactly one .in() update");
    assert.deepEqual(profileUpdates[0].filter.values, [TOKEN1_DEAD], "profiles filter must contain only TOKEN1_DEAD");
    assert.ok(!profileUpdates[0].filter.values.includes(TOKEN1), "live TOKEN1 must NOT appear in profiles filter");
    assert.ok(!profileUpdates[0].filter.values.includes(TOKEN2), "live TOKEN2 must NOT appear in profiles filter");

    // rent_buddy_profiles: only TOKEN1_DEAD
    const rentUpdates = db.__updates.filter((u: any) => u.table === "rent_buddy_profiles");
    assert.equal(rentUpdates.length, 1, "rent_buddy_profiles: exactly one .in() update");
    assert.deepEqual(rentUpdates[0].filter.values, [TOKEN1_DEAD], "rent_buddy_profiles filter must contain only TOKEN1_DEAD");
    assert.ok(!rentUpdates[0].filter.values.includes(TOKEN1), "live TOKEN1 must NOT appear in rent_buddy_profiles filter");
    assert.ok(!rentUpdates[0].filter.values.includes(TOKEN2), "live TOKEN2 must NOT appear in rent_buddy_profiles filter");

    // notification_devices: only TOKEN1_DEAD deleted
    const deviceDeletes = db.__deletes.filter((d: any) => d.table === "notification_devices");
    assert.equal(deviceDeletes.length, 1, "notification_devices: exactly one .in() delete");
    assert.deepEqual(deviceDeletes[0].filter.values, [TOKEN1_DEAD], "notification_devices filter must contain only TOKEN1_DEAD");
    assert.ok(!deviceDeletes[0].filter.values.includes(TOKEN1), "live TOKEN1 must NOT appear in notification_devices filter");
    assert.ok(!deviceDeletes[0].filter.values.includes(TOKEN2), "live TOKEN2 must NOT appear in notification_devices filter");

    // No retry enqueue
    assert.equal((db.__inserted["push_retry_queue"] ?? []).length, 0, "nothing enqueued for retry");
  });

  it("does not throw on InvalidCredentials with a null db client", async () => {
    ticketFor = () => ({ status: "error", message: "creds bad", details: { error: "InvalidCredentials" } });
    const result = await sendPushWithRetry(null, { userId: USER1, tokens: [TOKEN1] }, PAYLOAD);
    assert.equal(result.sent, 0);
    assert.equal(result.errors.length, 1);
  });

  it("does not touch token tables when all tickets are ok", async () => {
    const db = makeFakeDb();
    await sendPushWithRetry(db, { userId: USER1, tokens: [TOKEN1] }, PAYLOAD);
    assert.equal(db.__updates.length, 0);
    assert.equal(db.__deletes.length, 0);
  });

  /**
   * All-ok batch: clearDeadTokens must be skipped entirely.
   *
   * Sends a two-recipient batch where every Expo ticket comes back "ok".
   * Asserts that no .in() filter hits any of the three token tables
   * (profiles, notification_devices, rent_buddy_profiles) — confirming
   * clearDeadTokens is not called at all, not just that the filter is empty.
   *
   * Complements the skeleton above by exercising a multi-recipient batch
   * and explicitly naming rent_buddy_profiles.
   */
  it("skips clearDeadTokens entirely — no DB writes to any token table — when all tickets are ok", async () => {
    const db = makeFakeDb();
    const result = await sendPushWithRetry(
      db,
      [{ userId: USER1, tokens: [TOKEN1] }, { userId: USER2, tokens: [TOKEN2] }],
      PAYLOAD,
    );

    assert.equal(result.sent, 2, "both tickets must be counted as sent");
    assert.equal(result.errors.length, 0, "no errors expected");

    // No update must have hit profiles or rent_buddy_profiles
    assert.equal(
      db.__updates.filter((u: any) => u.table === "profiles").length,
      0,
      "profiles must not be updated when all tickets are ok",
    );
    assert.equal(
      db.__updates.filter((u: any) => u.table === "rent_buddy_profiles").length,
      0,
      "rent_buddy_profiles must not be updated when all tickets are ok",
    );

    // No delete must have hit notification_devices
    assert.equal(
      db.__deletes.filter((d: any) => d.table === "notification_devices").length,
      0,
      "notification_devices must not be deleted when all tickets are ok",
    );

    // Aggregate guard: zero writes of any kind
    assert.equal(db.__updates.length, 0, "total DB updates must be zero when all tickets are ok");
    assert.equal(db.__deletes.length, 0, "total DB deletes must be zero when all tickets are ok");
  });

  it("does not throw on DeviceNotRegistered with a null db client", async () => {
    ticketFor = () => ({ status: "error", message: "gone", details: { error: "DeviceNotRegistered" } });
    const result = await sendPushWithRetry(null, { userId: USER1, tokens: [TOKEN1] }, PAYLOAD);
    assert.equal(result.sent, 0);
    assert.equal(result.errors.length, 1);
  });

  it("skips Expo entirely when no recipient has a valid token", async () => {
    const db = makeFakeDb();
    const result = await sendPushWithRetry(
      db,
      [{ userId: USER1, tokens: [null, undefined, "not-a-token"] }],
      PAYLOAD,
    );
    assert.equal(result.sent, 0);
    assert.equal(pushCalls.length, 0);
    assert.equal((db.__inserted["push_retry_queue"] ?? []).length, 0);
  });

  it("does not throw when db is null and the failure is retryable", async () => {
    _setTestFetch(fetch503());
    const result = await sendPushWithRetry(null, { userId: USER1, tokens: [TOKEN1] }, PAYLOAD);
    assert.equal(result.retryable, true);
  });

  // ── 7: Transient 5xx must not touch rent_buddy_profiles ───────────────────
  /**
   * When Expo returns a transient 5xx (retryable: true) during sendPushWithRetry,
   * the call enqueues the job for later retry.  No token is permanently dead, so
   * rent_buddy_profiles must NOT be updated — mirroring the guard confirmed for
   * PushRetryQueue.processQueue() in pushRetryQueue.test.ts section 14.
   */
  it("does not null rent_buddy_profiles.expo_push_token on a transient 5xx", async () => {
    _setTestFetch(fetch503());
    const db = makeFakeDb();
    const result = await sendPushWithRetry(
      db,
      [{ userId: USER1, tokens: [TOKEN1] }, { userId: USER2, tokens: [TOKEN2] }],
      PAYLOAD,
    );

    assert.equal(result.retryable, true, "5xx must be reported as retryable");

    const rentUpdate = db.__updates.find(
      (u: any) => u.table === "rent_buddy_profiles" && u.values.expo_push_token === null,
    );
    assert.ok(
      !rentUpdate,
      "transient 5xx must NOT null rent_buddy_profiles.expo_push_token",
    );

    const profileUpdate = db.__updates.find(
      (u: any) => u.table === "profiles",
    );
    assert.ok(
      !profileUpdate,
      "transient 5xx must NOT touch profiles",
    );

    const deviceDelete = db.__deletes.find(
      (d: any) => d.table === "notification_devices",
    );
    assert.ok(
      !deviceDelete,
      "transient 5xx must NOT touch notification_devices",
    );
  });

  /**
   * Initial push path: partial success + clearDeadTokens throws
   *
   * Expo returns a mixed batch: TOKEN1 ok, TOKEN2 DeviceNotRegistered.
   * The injected clearDeadTokens mock throws synchronously.
   *
   * Requirements:
   *   - sendPushWithRetry must not throw.
   *   - result.sent must equal 1 (the ok ticket is preserved).
   *   - result.errors must contain the DeviceNotRegistered entry.
   *   - Nothing must be enqueued on push_retry_queue (dead-token errors are
   *     non-retryable; the clearDeadTokens failure must not change that).
   */
  it("preserves partial-success result when clearDeadTokens throws on the initial send path", async () => {
    // TOKEN1 ok, TOKEN2 DeviceNotRegistered
    ticketFor = (to: string) =>
      to === TOKEN2
        ? { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }
        : { status: "ok", id: "t" };

    _setTestClearDeadTokens(async () => {
      throw new Error("DB connection lost");
    });

    const db = makeFakeDb();
    let threw = false;
    let result: Awaited<ReturnType<typeof sendPushWithRetry>> | undefined;
    try {
      result = await sendPushWithRetry(
        db,
        [{ userId: USER1, tokens: [TOKEN1] }, { userId: USER2, tokens: [TOKEN2] }],
        PAYLOAD,
      );
    } catch {
      threw = true;
    }

    assert.ok(!threw, "sendPushWithRetry must not throw when clearDeadTokens throws");
    assert.ok(result !== undefined, "result must be defined");
    assert.equal(result!.sent, 1, "one ok ticket must still be recorded as sent");
    assert.equal(result!.errors.length, 1, "one per-token error must be surfaced");
    assert.equal(result!.errors[0].error, "DeviceNotRegistered");
    assert.equal(result!.retryable, undefined, "result must not be marked retryable");
    assert.equal(
      (db.__inserted["push_retry_queue"] ?? []).length,
      0,
      "nothing must be enqueued for retry when clearDeadTokens throws",
    );
  });
});
