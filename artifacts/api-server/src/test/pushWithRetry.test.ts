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
import { sendPushWithRetry } from "../lib/pushWithRetry.js";

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
  });
});
