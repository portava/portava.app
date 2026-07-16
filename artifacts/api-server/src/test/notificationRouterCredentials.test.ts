/**
 * NotificationRouter — InvalidCredentials integration test
 *
 * Confirms that when Expo returns an InvalidCredentials error for a push token,
 * NotificationRouter:
 *   1. Deletes the token from notification_devices
 *   2. Nulls the legacy expo_push_token on profiles (when it matches)
 *   3. Does NOT enqueue anything on push_retry_queue
 *
 * Also covers DeviceNotRegistered (same cleanup path) and transient failures
 * (retry-queue path, no token deletion) to confirm the two branches don't bleed
 * into each other.
 *
 * Run: node --import tsx/esm --test src/test/notificationRouterCredentials.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { _setTestFetch } from "../lib/push.js";
import {
  NotificationRouter,
  _resetCleanupFailureCount,
  _getCleanupFailureCount,
} from "../services/notifications/NotificationRouter.js";
import type { NotificationRow } from "../services/notifications/NotificationService.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const USER_ID      = "bb000000-0001-0001-0001-000000000001";
const TOKEN        = "ExponentPushToken[cred-test-device]";
const LEGACY_TOKEN = "ExponentPushToken[cred-test-legacy]";
const NOTIF_ID     = "cc000000-0002-0002-0002-000000000002";

/** A notification row whose category maps to emergency_safety (level 1).
 *  Level 1 bypasses all quiet-hours / DB checks inside evaluateNotification,
 *  so the Compass gate returns "sent" immediately without extra fake-db wiring. */
const BASE_NOTIF: NotificationRow = {
  id:        NOTIF_ID,
  userId:    USER_ID,
  title:     "Test push",
  body:      "Credential error test",
  category:  "safety",
  eventType: "test_credential_check",
  priority:  "urgent",
  isRead:    false,
  actionUrl: null,
  sourceId:  null,
  metadata:  null,
  expiresAt: null,
  createdAt:  new Date().toISOString(),
};

// ── Fake fetch factories ──────────────────────────────────────────────────────

function makeTicketFetch(
  ticketFn: (token: string) => { status: string; message?: string; details?: { error?: string }; id?: string },
): typeof fetch {
  return (async (_url: any, init: any) => {
    const messages: Array<{ to: string }> = JSON.parse((init as any).body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: messages.map((m) => ticketFn(m.to)) }),
    } as any;
  }) as any;
}

const invalidCredFetch = makeTicketFetch(() => ({
  status: "error",
  message: "InvalidCredentials",
  details: { error: "InvalidCredentials" },
}));

const deviceNotRegisteredFetch = makeTicketFetch(() => ({
  status: "error",
  message: "DeviceNotRegistered",
  details: { error: "DeviceNotRegistered" },
}));

const okFetch = makeTicketFetch(() => ({ status: "ok", id: "t1" }));

const messageRateExceededFetch = makeTicketFetch(() => ({
  status: "error",
  message: "MessageRateExceeded",
  details: { error: "MessageRateExceeded" },
}));

const transient503Fetch: typeof fetch = (async () => ({
  ok: false,
  status: 503,
  json: async () => ({}),
})) as any;

// ── Fake DB builder ───────────────────────────────────────────────────────────

interface FakeDbOpts {
  /** Token returned from notification_devices table (null = no device row). */
  deviceToken?: string | null;
  /** Multiple tokens from notification_devices (overrides deviceToken when set). */
  deviceTokens?: string[];
  /** Token returned from profiles.expo_push_token (null = no legacy token). */
  legacyToken?: string | null;
  /** When set, notification_devices DELETE returns this error instead of succeeding. */
  deleteDeviceError?: Error | null;
  /** When set, profiles UPDATE (null legacy token) returns this error instead of succeeding. */
  profilesUpdateError?: Error | null;
  /** When set, rent_buddy_profiles UPDATE returns this error instead of succeeding. */
  rentBuddyUpdateError?: Error | null;
}

interface FakeDb {
  /** Tokens passed to notification_devices DELETE … IN (…) calls. */
  deletedDeviceTokens: string[][];
  /** user_id values passed to profiles UPDATE … SET expo_push_token=null. */
  profilesNulled: string[];
  /** Token arrays passed to rent_buddy_profiles UPDATE … IN (expo_push_token, …). */
  rentBuddyTokensNulled: string[][];
  /** Rows inserted into push_retry_queue. */
  retryQueueInserts: any[];
  /** Rows inserted into notification_delivery_attempts. */
  deliveryAttempts: any[];
  /** Raw Supabase-like client. */
  client: any;
}

function makeFakeDb(opts: FakeDbOpts = {}): FakeDb {
  // deviceTokens overrides deviceToken when provided
  const resolvedTokens: string[] = opts.deviceTokens !== undefined
    ? opts.deviceTokens
    : (opts.deviceToken !== undefined
        ? (opts.deviceToken ? [opts.deviceToken] : [])
        : [TOKEN]);
  const legacyToken = opts.legacyToken !== undefined ? opts.legacyToken : null;
  const deleteDeviceError = opts.deleteDeviceError !== undefined ? opts.deleteDeviceError : null;
  const profilesUpdateError = opts.profilesUpdateError !== undefined ? opts.profilesUpdateError : null;
  const rentBuddyUpdateError = opts.rentBuddyUpdateError !== undefined ? opts.rentBuddyUpdateError : null;

  const deletedDeviceTokens: string[][] = [];
  const profilesNulled: string[] = [];
  const rentBuddyTokensNulled: string[][] = [];
  const retryQueueInserts: any[] = [];
  const deliveryAttempts: any[] = [];

  /** Return a promise-like chain that resolves when awaited. */
  function thenable(value: any) {
    const p = Promise.resolve(value);
    return Object.assign(p, {
      eq(_col: string, _val: any) { return thenable(value); },
      in(_col: string, _vals: any[]) { return thenable(value); },
      maybeSingle() { return Promise.resolve(value); },
      single() { return Promise.resolve(value); },
    });
  }

  const client: any = {
    from(table: string) {
      return {
        // ── SELECT ────────────────────────────────────────────────────────────
        select(_cols?: string) {
          // Build a chainable object; make it thenable so `await select().eq()`
          // resolves to the table's default data.
          const eqFilters: Record<string, any> = {};

          const resolve = (): any => {
            if (table === "notification_preferences") {
              // No row → service uses defaults (pushEnabled: true)
              return { data: null, error: null };
            }
            if (table === "notification_category_preferences") {
              return { data: [], error: null };
            }
            if (table === "notification_devices") {
              return {
                data: resolvedTokens.map((t) => ({ push_token: t })),
                error: null,
              };
            }
            if (table === "profiles") {
              return {
                data: legacyToken ? { expo_push_token: legacyToken } : null,
                error: null,
              };
            }
            if (table === "blocks") {
              return { data: null, error: null };
            }
            return { data: null, error: null };
          };

          const chain: any = {
            eq(_col: string, _val: any) {
              eqFilters[_col] = _val;
              return chain;
            },
            in(_col: string, _vals: any[]) {
              return chain;
            },
            maybeSingle() {
              return Promise.resolve(resolve());
            },
            single() {
              return Promise.resolve(resolve());
            },
            // Make awaitable directly (e.g. `await db.from(...).select().eq(...)`)
            then(onFulfilled: any, onRejected: any) {
              return Promise.resolve(resolve()).then(onFulfilled, onRejected);
            },
            catch(onRejected: any) {
              return Promise.resolve(resolve()).catch(onRejected);
            },
            finally(onFinally: any) {
              return Promise.resolve(resolve()).finally(onFinally);
            },
          };
          return chain;
        },

        // ── INSERT ────────────────────────────────────────────────────────────
        insert(row: any) {
          if (table === "push_retry_queue") {
            retryQueueInserts.push(row);
          } else if (table === "notification_delivery_attempts") {
            deliveryAttempts.push(row);
          }
          // Must be thenable (logDecision calls .insert({}).then(...))
          // AND support .insert(row).select('id').single() (logAttemptReturnId)
          const insertResult = { data: { id: "attempt-1" }, error: null };
          const p = Promise.resolve(insertResult);
          return Object.assign(p, {
            select(_cols: string) {
              return {
                single() {
                  return Promise.resolve(insertResult);
                },
              };
            },
          });
        },

        // ── DELETE ────────────────────────────────────────────────────────────
        delete() {
          return {
            eq(_col: string, _val: any) {
              return {
                in(_col2: string, vals: any[]) {
                  if (table === "notification_devices") {
                    if (deleteDeviceError) {
                      return Promise.resolve({ error: deleteDeviceError });
                    }
                    deletedDeviceTokens.push([...vals]);
                  }
                  return Promise.resolve({ error: null });
                },
              };
            },
          };
        },

        // ── UPDATE ────────────────────────────────────────────────────────────
        update(_vals: any) {
          return {
            eq(_col: string, val: any) {
              if (table === "profiles") {
                if (profilesUpdateError) {
                  return Promise.resolve({ error: profilesUpdateError });
                }
                profilesNulled.push(String(val));
              }
              return Promise.resolve({ error: null });
            },
            in(_col: string, vals: any[]) {
              if (table === "rent_buddy_profiles") {
                if (rentBuddyUpdateError) {
                  return Promise.resolve({ error: rentBuddyUpdateError });
                }
                rentBuddyTokensNulled.push([...vals]);
              }
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };

  return { deletedDeviceTokens, profilesNulled, rentBuddyTokensNulled, retryQueueInserts, deliveryAttempts, client };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  _resetCleanupFailureCount();
  _setTestFetch(okFetch);
});

afterEach(() => {
  _setTestFetch(null);
});

describe("NotificationRouter — InvalidCredentials handling", () => {
  it("deletes the token from notification_devices on InvalidCredentials", async () => {
    _setTestFetch(invalidCredFetch);
    const { deletedDeviceTokens, retryQueueInserts, client } = makeFakeDb({
      deviceToken: TOKEN,
      legacyToken: null,
    });

    const router = new NotificationRouter(client);
    await router.route(BASE_NOTIF);

    assert.equal(deletedDeviceTokens.length, 1, "one DELETE call on notification_devices");
    assert.ok(
      deletedDeviceTokens[0].includes(TOKEN),
      `deleted tokens should include ${TOKEN}`,
    );
    assert.equal(retryQueueInserts.length, 0, "must NOT enqueue on push_retry_queue");
  });

  it("nulls the legacy expo_push_token on profiles when the bad token is the legacy one", async () => {
    _setTestFetch(invalidCredFetch);
    // The device row holds LEGACY_TOKEN and profiles also holds LEGACY_TOKEN
    const { deletedDeviceTokens, profilesNulled, retryQueueInserts, client } = makeFakeDb({
      deviceToken: LEGACY_TOKEN,
      legacyToken: LEGACY_TOKEN,
    });

    const router = new NotificationRouter(client);
    await router.route(BASE_NOTIF);

    assert.equal(deletedDeviceTokens.length, 1, "notification_devices DELETE called");
    assert.ok(deletedDeviceTokens[0].includes(LEGACY_TOKEN), "deleted the legacy token from devices");

    assert.ok(profilesNulled.includes(USER_ID), "profiles.expo_push_token nulled for the user");
    assert.equal(retryQueueInserts.length, 0, "must NOT enqueue on push_retry_queue");
  });

  it("does not null profiles when the legacy token is different (and not stale)", async () => {
    // device token is bad, but the legacy token on profiles is a different (good) token
    const GOOD_LEGACY = "ExponentPushToken[good-legacy]";
    _setTestFetch(
      makeTicketFetch((to) =>
        to === TOKEN
          ? { status: "error", details: { error: "InvalidCredentials" } }
          : { status: "ok", id: "t1" },
      ),
    );
    const { profilesNulled, retryQueueInserts, client } = makeFakeDb({
      deviceToken: TOKEN,
      legacyToken: GOOD_LEGACY, // different token; should NOT be nulled
    });

    const router = new NotificationRouter(client);
    await router.route(BASE_NOTIF);

    assert.equal(profilesNulled.length, 0, "good legacy token must not be nulled");
    assert.equal(retryQueueInserts.length, 0, "must NOT enqueue");
  });

  it("deletes the token from notification_devices on DeviceNotRegistered (same path)", async () => {
    _setTestFetch(deviceNotRegisteredFetch);
    const { deletedDeviceTokens, retryQueueInserts, client } = makeFakeDb({
      deviceToken: TOKEN,
      legacyToken: null,
    });

    const router = new NotificationRouter(client);
    await router.route(BASE_NOTIF);

    assert.equal(deletedDeviceTokens.length, 1, "one DELETE call on notification_devices");
    assert.ok(deletedDeviceTokens[0].includes(TOKEN), "stale token was removed");
    assert.equal(retryQueueInserts.length, 0, "must NOT enqueue on push_retry_queue");
  });

  it("enqueues on a transient failure and does NOT delete tokens", async () => {
    _setTestFetch(transient503Fetch);
    const { deletedDeviceTokens, profilesNulled, rentBuddyTokensNulled, retryQueueInserts, client } = makeFakeDb({
      deviceToken: TOKEN,
      legacyToken: null,
    });

    const router = new NotificationRouter(client);
    await router.route(BASE_NOTIF);

    assert.equal(deletedDeviceTokens.length, 0, "transient failure must NOT delete tokens");
    assert.equal(profilesNulled.length, 0, "transient failure must NOT null profile token");
    assert.equal(rentBuddyTokensNulled.length, 0, "transient failure must NOT null rent_buddy_profiles token");
    assert.ok(retryQueueInserts.length > 0, "transient failure must enqueue for retry");
  });

  it("nulls expo_push_token on rent_buddy_profiles when the token goes stale", async () => {
    _setTestFetch(invalidCredFetch);
    const { deletedDeviceTokens, rentBuddyTokensNulled, retryQueueInserts, client } = makeFakeDb({
      deviceToken: TOKEN,
      legacyToken: null,
    });

    const router = new NotificationRouter(client);
    await router.route(BASE_NOTIF);

    assert.equal(deletedDeviceTokens.length, 1, "notification_devices DELETE called");
    assert.ok(deletedDeviceTokens[0].includes(TOKEN), "stale token deleted from notification_devices");

    assert.equal(rentBuddyTokensNulled.length, 1, "one IN-update call on rent_buddy_profiles");
    assert.ok(
      rentBuddyTokensNulled[0].includes(TOKEN),
      `rent_buddy_profiles update should include stale token ${TOKEN}`,
    );
    assert.equal(retryQueueInserts.length, 0, "must NOT enqueue on push_retry_queue");
  });

  it("does NOT delete tokens or enqueue when Expo returns MessageRateExceeded", async () => {
    _setTestFetch(messageRateExceededFetch);
    const { deletedDeviceTokens, profilesNulled, retryQueueInserts, client } = makeFakeDb({
      deviceToken: TOKEN,
      legacyToken: LEGACY_TOKEN,
    });

    const router = new NotificationRouter(client);
    await router.route(BASE_NOTIF);

    assert.equal(
      deletedDeviceTokens.length,
      0,
      "MessageRateExceeded must NOT delete from notification_devices",
    );
    assert.equal(
      profilesNulled.length,
      0,
      "MessageRateExceeded must NOT null profiles.expo_push_token",
    );
    assert.equal(
      retryQueueInserts.length,
      0,
      "MessageRateExceeded must NOT enqueue on push_retry_queue",
    );
  });

  it("mixed batch — stale token is deleted while rate-limited token is preserved", async () => {
    const STALE_TOKEN = "ExponentPushToken[stale-device]";
    const RATE_TOKEN  = "ExponentPushToken[rate-limited-device]";

    // DeviceNotRegistered for the stale token, MessageRateExceeded for the other.
    _setTestFetch(
      makeTicketFetch((to) =>
        to === STALE_TOKEN
          ? { status: "error", message: "DeviceNotRegistered", details: { error: "DeviceNotRegistered" } }
          : { status: "error", message: "MessageRateExceeded", details: { error: "MessageRateExceeded" } },
      ),
    );

    // Two device rows; legacy token is the rate-limited one — must NOT be nulled.
    const { deletedDeviceTokens, profilesNulled, retryQueueInserts, client } = makeFakeDb({
      deviceTokens: [STALE_TOKEN, RATE_TOKEN],
      legacyToken: RATE_TOKEN,
    });

    const router = new NotificationRouter(client);
    await router.route(BASE_NOTIF);

    // Exactly one DELETE call, containing only the stale token
    assert.equal(deletedDeviceTokens.length, 1, "exactly one DELETE call on notification_devices");
    assert.ok(
      deletedDeviceTokens[0].includes(STALE_TOKEN),
      "DELETE targets the stale (DeviceNotRegistered) token",
    );
    assert.ok(
      !deletedDeviceTokens[0].includes(RATE_TOKEN),
      "rate-limited token must NOT appear in the DELETE call",
    );

    // The legacy token on profiles is rate-limited (still valid) — must not be nulled
    assert.equal(
      profilesNulled.length,
      0,
      "profiles.expo_push_token must NOT be nulled for a rate-limited token",
    );

    // Neither token warrants a retry-queue entry
    assert.equal(retryQueueInserts.length, 0, "must NOT enqueue on push_retry_queue");
  });

  it("escalates cleanup failure log from warn to error after CLEANUP_ERROR_THRESHOLD consecutive failures", async () => {
    // Use InvalidCredentials so NotificationRouter always tries to clean up
    // the stale token (calls _cleanupStaleTokens), but the DELETE returns an
    // error each time — simulating a persistently unavailable DB.
    _setTestFetch(invalidCredFetch);
    const DB_ERROR = new Error("db down");
    const { client } = makeFakeDb({ deviceToken: TOKEN, deleteDeviceError: DB_ERROR });

    const router = new NotificationRouter(client);

    // Three consecutive failures should reach CLEANUP_ERROR_THRESHOLD (3)
    await router.route(BASE_NOTIF);
    await router.route(BASE_NOTIF);
    await router.route(BASE_NOTIF);

    assert.ok(
      _getCleanupFailureCount() >= 3,
      `cleanup failure count should reach CLEANUP_ERROR_THRESHOLD (3), got ${_getCleanupFailureCount()}`,
    );
  });

  it("resets the cleanup failure counter to 0 after a successful cleanup", async () => {
    // Drive _consecutiveCleanupFailures to CLEANUP_ERROR_THRESHOLD (3) by
    // making the notification_devices DELETE fail on every call.
    _setTestFetch(invalidCredFetch);
    const DB_ERROR = new Error("db down");
    const { client: errorClient } = makeFakeDb({ deviceToken: TOKEN, deleteDeviceError: DB_ERROR });
    const errorRouter = new NotificationRouter(errorClient);

    await errorRouter.route(BASE_NOTIF);
    await errorRouter.route(BASE_NOTIF);
    await errorRouter.route(BASE_NOTIF);

    assert.ok(
      _getCleanupFailureCount() >= 3,
      `pre-condition: counter should be at threshold (3), got ${_getCleanupFailureCount()}`,
    );

    // Switch to a healthy DB — all cleanup steps succeed, so anyFailure stays
    // false and the router should reset _consecutiveCleanupFailures to 0.
    const { client: healthyClient } = makeFakeDb({ deviceToken: TOKEN });
    const healthyRouter = new NotificationRouter(healthyClient);

    await healthyRouter.route(BASE_NOTIF);

    assert.equal(
      _getCleanupFailureCount(),
      0,
      "cleanup failure counter must reset to 0 after a fully-successful cleanup",
    );
  });

  it("escalates cleanup failure log from warn to error when rent_buddy_profiles UPDATE fails CLEANUP_ERROR_THRESHOLD times", async () => {
    // Use InvalidCredentials so cleanupStaleTokens is invoked each time.
    // Step 1 (notification_devices DELETE) succeeds; Step 2 (profiles) is
    // skipped (no legacyToken); Step 3 (rent_buddy_profiles UPDATE) fails.
    // Each call therefore increments _consecutiveCleanupFailures by exactly 1,
    // reaching CLEANUP_ERROR_THRESHOLD (3) after three routes.
    _setTestFetch(invalidCredFetch);
    const DB_ERROR = new Error("rent_buddy db down");
    const { client } = makeFakeDb({
      deviceToken: TOKEN,
      legacyToken: null,
      rentBuddyUpdateError: DB_ERROR,
    });

    const router = new NotificationRouter(client);

    await router.route(BASE_NOTIF);
    assert.ok(
      _getCleanupFailureCount() >= 1,
      `failure count should be at least 1 after first route, got ${_getCleanupFailureCount()}`,
    );

    await router.route(BASE_NOTIF);
    await router.route(BASE_NOTIF);

    assert.ok(
      _getCleanupFailureCount() >= 3,
      `cleanup failure count should reach CLEANUP_ERROR_THRESHOLD (3) via rent_buddy_profiles step, got ${_getCleanupFailureCount()}`,
    );
  });

  it("legacy-profile null failure alone also increments the escalation counter", async () => {
    // notification_devices DELETE succeeds (step 1 is healthy),
    // but profiles UPDATE (step 2 — null legacy expo_push_token) always fails.
    // Even though only step 2 is broken, the counter must still reach
    // CLEANUP_ERROR_THRESHOLD after enough calls.
    _setTestFetch(invalidCredFetch);
    const PROFILES_ERROR = new Error("profiles table unavailable");
    const { client } = makeFakeDb({
      // Use LEGACY_TOKEN for both so step 2 is always attempted
      deviceToken: LEGACY_TOKEN,
      legacyToken: LEGACY_TOKEN,
      // Step 1 (DELETE notification_devices) succeeds — no deleteDeviceError
      profilesUpdateError: PROFILES_ERROR,
    });

    const router = new NotificationRouter(client);

    // Three consecutive calls — each triggers the failing profiles UPDATE
    await router.route(BASE_NOTIF);
    await router.route(BASE_NOTIF);
    await router.route(BASE_NOTIF);

    assert.ok(
      _getCleanupFailureCount() >= 3,
      `legacy-profile null failure should drive the escalation counter to CLEANUP_ERROR_THRESHOLD (3), got ${_getCleanupFailureCount()}`,
    );
  });

  it("does nothing when there are no push tokens registered for the user", async () => {
    const { deletedDeviceTokens, retryQueueInserts, deliveryAttempts, client } = makeFakeDb({
      deviceToken: null,
      legacyToken: null,
    });

    const router = new NotificationRouter(client);
    await router.route(BASE_NOTIF);

    assert.equal(deletedDeviceTokens.length, 0, "no tokens to delete");
    assert.equal(retryQueueInserts.length, 0, "no tokens to enqueue");

    const pushAttempts = deliveryAttempts.filter((a) => a.channel === "push");
    assert.ok(
      pushAttempts.every((a) => a.status === "suppressed"),
      "push attempt logged as suppressed (no tokens)",
    );
  });
});
