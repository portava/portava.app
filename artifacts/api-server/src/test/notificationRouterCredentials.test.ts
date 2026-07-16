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
import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { _setTestFetch } from "../lib/push.js";
import {
  NotificationRouter,
  _resetCleanupFailureCount,
  _getCleanupFailureCount,
  _notificationRouterLogger,
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

  it("mixed batch — DeviceNotRegistered and InvalidCredentials both land in a single DELETE call", async () => {
    const DNR_TOKEN  = "ExponentPushToken[device-not-registered]";
    const CRED_TOKEN = "ExponentPushToken[invalid-credentials]";

    // One token → DeviceNotRegistered, the other → InvalidCredentials.
    _setTestFetch(
      makeTicketFetch((to) =>
        to === DNR_TOKEN
          ? { status: "error", message: "DeviceNotRegistered", details: { error: "DeviceNotRegistered" } }
          : { status: "error", message: "InvalidCredentials",  details: { error: "InvalidCredentials"  } },
      ),
    );

    const { deletedDeviceTokens, retryQueueInserts, client } = makeFakeDb({
      deviceTokens: [DNR_TOKEN, CRED_TOKEN],
      legacyToken: null,
    });

    const router = new NotificationRouter(client);
    await router.route(BASE_NOTIF);

    // Both stale-error codes must land in a single DELETE call, not two.
    assert.equal(deletedDeviceTokens.length, 1, "exactly one DELETE call on notification_devices");
    assert.ok(
      deletedDeviceTokens[0].includes(DNR_TOKEN),
      `DELETE IN list must include the DeviceNotRegistered token (${DNR_TOKEN})`,
    );
    assert.ok(
      deletedDeviceTokens[0].includes(CRED_TOKEN),
      `DELETE IN list must include the InvalidCredentials token (${CRED_TOKEN})`,
    );

    // Neither stale token warrants a retry-queue entry.
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

  it("resets the cleanup failure counter to 0 after rent_buddy_profiles UPDATE succeeds following prior failures", async () => {
    // Drive _consecutiveCleanupFailures up via rent_buddy_profiles UPDATE
    // failures (Step 3) — using fewer than CLEANUP_ERROR_THRESHOLD (3) calls so
    // the counter is elevated but the threshold hasn't been crossed yet.
    _setTestFetch(invalidCredFetch);
    const DB_ERROR = new Error("rent_buddy db down");
    const { client: errorClient } = makeFakeDb({
      deviceToken: TOKEN,
      legacyToken: null,
      rentBuddyUpdateError: DB_ERROR,
    });
    const errorRouter = new NotificationRouter(errorClient);

    await errorRouter.route(BASE_NOTIF);
    await errorRouter.route(BASE_NOTIF);

    assert.ok(
      _getCleanupFailureCount() >= 1,
      `pre-condition: counter should be elevated after two failing routes, got ${_getCleanupFailureCount()}`,
    );

    // Now switch to a healthy DB where rent_buddy_profiles UPDATE succeeds.
    // All three cleanup steps pass, so anyFailure stays false and the router
    // must reset _consecutiveCleanupFailures to 0.
    const { client: healthyClient } = makeFakeDb({
      deviceToken: TOKEN,
      legacyToken: null,
    });
    const healthyRouter = new NotificationRouter(healthyClient);

    await healthyRouter.route(BASE_NOTIF);

    assert.equal(
      _getCleanupFailureCount(),
      0,
      "cleanup failure counter must reset to 0 after rent_buddy_profiles UPDATE succeeds",
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

  it("resets the cleanup failure counter to 0 after profiles UPDATE (legacy token) succeeds following prior failures", async () => {
    // Drive _consecutiveCleanupFailures up via profiles UPDATE failures (Step 2)
    // — using fewer than CLEANUP_ERROR_THRESHOLD (3) calls so the counter is
    // elevated but the threshold hasn't been crossed yet.
    // LEGACY_TOKEN is set as both deviceToken and legacyToken so that Step 2 is
    // always attempted; Step 1 (DELETE) and Step 3 (rent_buddy) both succeed.
    _setTestFetch(invalidCredFetch);
    const PROFILES_ERROR = new Error("profiles table unavailable");
    const { client: errorClient } = makeFakeDb({
      deviceToken: LEGACY_TOKEN,
      legacyToken: LEGACY_TOKEN,
      profilesUpdateError: PROFILES_ERROR,
    });
    const errorRouter = new NotificationRouter(errorClient);

    await errorRouter.route(BASE_NOTIF);
    await errorRouter.route(BASE_NOTIF);

    assert.ok(
      _getCleanupFailureCount() >= 1,
      `pre-condition: counter should be elevated after two failing routes, got ${_getCleanupFailureCount()}`,
    );

    // Switch to a healthy DB where profiles UPDATE succeeds.  All three cleanup
    // steps pass, so anyFailure stays false and the router must reset
    // _consecutiveCleanupFailures to 0.
    const { client: healthyClient } = makeFakeDb({
      deviceToken: LEGACY_TOKEN,
      legacyToken: LEGACY_TOKEN,
    });
    const healthyRouter = new NotificationRouter(healthyClient);

    await healthyRouter.route(BASE_NOTIF);

    assert.equal(
      _getCleanupFailureCount(),
      0,
      "cleanup failure counter must reset to 0 after profiles UPDATE (legacy token) succeeds",
    );
  });

  it("counter increments twice per call when both step 1 and step 2 fail in the same cleanup", async () => {
    // Use LEGACY_TOKEN as both the device token and the legacy profile token so
    // that step 2 (profiles UPDATE) is always attempted alongside step 1 (DELETE).
    // With deleteDeviceError AND profilesUpdateError both set, each route() call
    // contributes 2 increments.  Two calls → 4 total, well above
    // CLEANUP_ERROR_THRESHOLD (3), so the escalation check is valid even before
    // a third call.
    _setTestFetch(invalidCredFetch);
    const STEP1_ERROR = new Error("notification_devices unavailable");
    const STEP2_ERROR = new Error("profiles table unavailable");
    const { client } = makeFakeDb({
      deviceToken: LEGACY_TOKEN,
      legacyToken: LEGACY_TOKEN,
      deleteDeviceError: STEP1_ERROR,
      profilesUpdateError: STEP2_ERROR,
    });

    const router = new NotificationRouter(client);

    await router.route(BASE_NOTIF);
    await router.route(BASE_NOTIF);

    assert.ok(
      _getCleanupFailureCount() >= 3,
      `counter should reach CLEANUP_ERROR_THRESHOLD (3) after two calls with two failures each, got ${_getCleanupFailureCount()}`,
    );
  });

  it("resets the cleanup failure counter to 0 after a healthy call that follows a dual-step failure run", async () => {
    // Drive _consecutiveCleanupFailures above CLEANUP_ERROR_THRESHOLD (3) by
    // running two calls where both step 1 (notification_devices DELETE) and
    // step 2 (profiles UPDATE) fail in the same cleanup.  Using LEGACY_TOKEN as
    // both the device token and the legacy profile token ensures step 2 is
    // always attempted.  Each call contributes 2 increments, so after two calls
    // the counter is ≥ 4 — safely above the threshold.
    _setTestFetch(invalidCredFetch);
    const STEP1_ERROR = new Error("notification_devices unavailable");
    const STEP2_ERROR = new Error("profiles table unavailable");
    const { client: errorClient } = makeFakeDb({
      deviceToken: LEGACY_TOKEN,
      legacyToken: LEGACY_TOKEN,
      deleteDeviceError: STEP1_ERROR,
      profilesUpdateError: STEP2_ERROR,
    });
    const errorRouter = new NotificationRouter(errorClient);

    await errorRouter.route(BASE_NOTIF);
    await errorRouter.route(BASE_NOTIF);

    assert.ok(
      _getCleanupFailureCount() >= 3,
      `pre-condition: counter should be above CLEANUP_ERROR_THRESHOLD (3) after two dual-failure calls, got ${_getCleanupFailureCount()}`,
    );

    // Third call: healthy DB where both steps succeed.  legacyToken === deviceToken
    // so step 2 is exercised alongside step 1 and step 3.  anyFailure stays false,
    // so the router must reset _consecutiveCleanupFailures to 0.
    const { client: healthyClient } = makeFakeDb({
      deviceToken: LEGACY_TOKEN,
      legacyToken: LEGACY_TOKEN,
    });
    const healthyRouter = new NotificationRouter(healthyClient);

    await healthyRouter.route(BASE_NOTIF);

    assert.equal(
      _getCleanupFailureCount(),
      0,
      "cleanup failure counter must reset to 0 after a fully-successful cleanup following a dual-step failure run",
    );
  });

  it("resets the cleanup failure counter to 0 after a healthy call that follows a triple-step failure run", async () => {
    // Drive _consecutiveCleanupFailures above CLEANUP_ERROR_THRESHOLD (3) by
    // running a single call where all three cleanup steps fail together:
    //   Step 1 — notification_devices DELETE        (deleteDeviceError)
    //   Step 2 — profiles UPDATE (null legacy token) (profilesUpdateError, triggered because legacyToken === deviceToken)
    //   Step 3 — rent_buddy_profiles UPDATE          (rentBuddyUpdateError)
    // Each step increments the counter independently, so one call contributes 3
    // increments — reaching CLEANUP_ERROR_THRESHOLD (3) immediately.  Two calls
    // push it to 6, safely above the threshold.
    _setTestFetch(invalidCredFetch);
    const STEP1_ERROR = new Error("notification_devices unavailable");
    const STEP2_ERROR = new Error("profiles table unavailable");
    const STEP3_ERROR = new Error("rent_buddy_profiles unavailable");
    const { client: errorClient } = makeFakeDb({
      deviceToken: LEGACY_TOKEN,
      legacyToken: LEGACY_TOKEN,
      deleteDeviceError: STEP1_ERROR,
      profilesUpdateError: STEP2_ERROR,
      rentBuddyUpdateError: STEP3_ERROR,
    });
    const errorRouter = new NotificationRouter(errorClient);

    await errorRouter.route(BASE_NOTIF);
    await errorRouter.route(BASE_NOTIF);

    assert.ok(
      _getCleanupFailureCount() >= 3,
      `pre-condition: counter should be above CLEANUP_ERROR_THRESHOLD (3) after two triple-failure calls, got ${_getCleanupFailureCount()}`,
    );

    // Subsequent call: healthy DB where all three steps succeed.
    // legacyToken === deviceToken ensures step 2 is exercised alongside steps 1
    // and 3.  anyFailure stays false, so the router must reset
    // _consecutiveCleanupFailures to 0.
    const { client: healthyClient } = makeFakeDb({
      deviceToken: LEGACY_TOKEN,
      legacyToken: LEGACY_TOKEN,
    });
    const healthyRouter = new NotificationRouter(healthyClient);

    await healthyRouter.route(BASE_NOTIF);

    assert.equal(
      _getCleanupFailureCount(),
      0,
      "cleanup failure counter must reset to 0 after a fully-successful cleanup following a triple-step failure run",
    );
  });

  it("counter increments three times in a single call when all three cleanup steps fail together", async () => {
    // Use LEGACY_TOKEN as both the device token and the legacy profile token so
    // that all three cleanup steps are attempted:
    //   Step 1 — notification_devices DELETE        (deleteDeviceError)
    //   Step 2 — profiles UPDATE (null legacy token) (profilesUpdateError, triggered because legacyToken === deviceToken)
    //   Step 3 — rent_buddy_profiles UPDATE          (rentBuddyUpdateError)
    // Each of the three steps catches its error and increments
    // _consecutiveCleanupFailures independently, so a single route() call
    // must produce exactly 3 increments — reaching CLEANUP_ERROR_THRESHOLD (3).
    // Three calls would therefore reach 9, well past any future threshold bump.
    _setTestFetch(invalidCredFetch);
    const STEP1_ERROR = new Error("notification_devices unavailable");
    const STEP2_ERROR = new Error("profiles table unavailable");
    const STEP3_ERROR = new Error("rent_buddy_profiles unavailable");
    const { client } = makeFakeDb({
      deviceToken: LEGACY_TOKEN,
      legacyToken: LEGACY_TOKEN,
      deleteDeviceError: STEP1_ERROR,
      profilesUpdateError: STEP2_ERROR,
      rentBuddyUpdateError: STEP3_ERROR,
    });

    const router = new NotificationRouter(client);
    await router.route(BASE_NOTIF);

    assert.ok(
      _getCleanupFailureCount() >= 3,
      `all three steps failing in one call should drive the counter to CLEANUP_ERROR_THRESHOLD (3), got ${_getCleanupFailureCount()}`,
    );
  });

  it("profiles and rent_buddy_profiles cleanup still run when notification_devices DELETE fails", async () => {
    // Step 1 (notification_devices DELETE) throws a DB error.
    // Steps 2 and 3 must still execute despite that failure —
    // confirming anyFailure does NOT short-circuit remaining cleanup.
    _setTestFetch(invalidCredFetch);
    const DB_ERROR = new Error("notification_devices table unavailable");

    // TOKEN is both the device token and the legacy token on profiles,
    // so both step 2 (profiles UPDATE) and step 3 (rent_buddy_profiles UPDATE)
    // are exercised in this call.
    const { profilesNulled, rentBuddyTokensNulled, deletedDeviceTokens, client } = makeFakeDb({
      deviceToken: TOKEN,
      legacyToken: TOKEN,          // causes step 2 to be attempted
      deleteDeviceError: DB_ERROR, // step 1 fails
    });

    const router = new NotificationRouter(client);
    await router.route(BASE_NOTIF);

    // Step 1 must have errored — nothing should have been recorded
    assert.equal(
      deletedDeviceTokens.length,
      0,
      "notification_devices DELETE failed — no tokens recorded as deleted",
    );

    // Step 2 must still have run and nulled the profile
    assert.ok(
      profilesNulled.includes(USER_ID),
      `profiles.expo_push_token must be nulled for user ${USER_ID} even when step 1 fails`,
    );

    // Step 3 must still have run and nulled the rent_buddy row
    assert.equal(rentBuddyTokensNulled.length, 1, "rent_buddy_profiles UPDATE must still be called");
    assert.ok(
      rentBuddyTokensNulled[0].includes(TOKEN),
      `rent_buddy_profiles must include stale token ${TOKEN} even when step 1 fails`,
    );
  });

  it("rent_buddy_profiles cleanup still runs when both step 1 (notification_devices DELETE) and step 2 (profiles UPDATE) fail", async () => {
    // This covers the symmetric gap to the step-1-only failure test:
    // if profiles UPDATE (step 2) also throws, step 3 must still execute so
    // stale tokens in rent_buddy_profiles are cleared regardless.
    _setTestFetch(invalidCredFetch);
    const STEP1_ERROR = new Error("notification_devices table unavailable");
    const STEP2_ERROR = new Error("profiles table unavailable");

    // TOKEN is both the device token and the legacy profile token so that
    // step 2 is actually attempted (legacyToken && staleTokens.includes(legacyToken)).
    const { deletedDeviceTokens, profilesNulled, rentBuddyTokensNulled, client } = makeFakeDb({
      deviceToken: TOKEN,
      legacyToken: TOKEN,           // causes step 2 to be attempted
      deleteDeviceError: STEP1_ERROR,  // step 1 fails
      profilesUpdateError: STEP2_ERROR, // step 2 fails
      // rentBuddyUpdateError intentionally not set — step 3 must succeed
    });

    const router = new NotificationRouter(client);
    await router.route(BASE_NOTIF);

    // Step 1 errored — no deletions recorded
    assert.equal(
      deletedDeviceTokens.length,
      0,
      "notification_devices DELETE failed — no tokens recorded as deleted",
    );

    // Step 2 errored — profile should NOT be nulled
    assert.equal(
      profilesNulled.length,
      0,
      "profiles UPDATE failed — profilesNulled must be empty",
    );

    // Step 3 must still have run despite both step 1 and step 2 failing
    assert.equal(
      rentBuddyTokensNulled.length,
      1,
      "rent_buddy_profiles UPDATE must still be called when steps 1 and 2 both fail",
    );
    assert.ok(
      rentBuddyTokensNulled[0].includes(TOKEN),
      `rent_buddy_profiles must include the stale token ${TOKEN} even when steps 1 and 2 both fail`,
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

  it("success log IS emitted when all cleanup steps succeed", async () => {
    // All DB steps succeed → anyFailure stays false → the info log must fire.
    _setTestFetch(invalidCredFetch);
    const { client } = makeFakeDb({ deviceToken: TOKEN, legacyToken: null });

    const infoSpy = mock.method(_notificationRouterLogger, "info", () => {});
    try {
      const router = new NotificationRouter(client);
      await router.route(BASE_NOTIF);

      const calls = infoSpy.mock.calls.map((c) => c.arguments[1] as string | undefined);
      const emitted = calls.some((msg) => msg?.includes("removed stale push tokens"));
      assert.ok(
        emitted,
        "info log 'removed stale push tokens' must be emitted when all cleanup steps succeed",
      );
    } finally {
      infoSpy.mock.restore();
    }
  });

  it("mixed batch — live token is absent from DELETE when DeviceNotRegistered and InvalidCredentials share a batch with an ok token", async () => {
    const DNR_TOKEN  = "ExponentPushToken[dead-device-not-registered]";
    const CRED_TOKEN = "ExponentPushToken[dead-invalid-credentials]";
    const LIVE_TOKEN = "ExponentPushToken[live-ok-device]";

    // DNR_TOKEN → DeviceNotRegistered, CRED_TOKEN → InvalidCredentials, LIVE_TOKEN → ok
    _setTestFetch(
      makeTicketFetch((to) => {
        if (to === DNR_TOKEN)  return { status: "error", message: "DeviceNotRegistered", details: { error: "DeviceNotRegistered" } };
        if (to === CRED_TOKEN) return { status: "error", message: "InvalidCredentials",  details: { error: "InvalidCredentials"  } };
        return { status: "ok", id: "ticket-live" };
      }),
    );

    const { deletedDeviceTokens, retryQueueInserts, client } = makeFakeDb({
      deviceTokens: [DNR_TOKEN, CRED_TOKEN, LIVE_TOKEN],
      legacyToken: null,
    });

    const router = new NotificationRouter(client);
    await router.route(BASE_NOTIF);

    // Exactly one DELETE call containing both stale tokens
    assert.equal(deletedDeviceTokens.length, 1, "exactly one DELETE call on notification_devices");
    assert.ok(
      deletedDeviceTokens[0].includes(DNR_TOKEN),
      `DELETE IN list must include the DeviceNotRegistered token (${DNR_TOKEN})`,
    );
    assert.ok(
      deletedDeviceTokens[0].includes(CRED_TOKEN),
      `DELETE IN list must include the InvalidCredentials token (${CRED_TOKEN})`,
    );

    // The live (ok) token must NOT appear in the DELETE IN list
    assert.ok(
      !deletedDeviceTokens[0].includes(LIVE_TOKEN),
      `live token (${LIVE_TOKEN}) must NOT appear in the DELETE IN list`,
    );

    // No retry-queue inserts for either stale error code
    assert.equal(retryQueueInserts.length, 0, "must NOT enqueue on push_retry_queue");
  });

  it("rent_buddy_profiles cleanup still runs when only profiles UPDATE fails — step 1 (notification_devices DELETE) succeeds", async () => {
    // Scenario: step 1 (notification_devices DELETE) succeeds, but step 2
    // (profiles UPDATE — null legacy expo_push_token) throws a DB error.
    // Step 3 (rent_buddy_profiles UPDATE) must still execute despite step 2
    // failing, so stale tokens are not left behind due to a targeted profiles
    // table outage.
    _setTestFetch(invalidCredFetch);
    const PROFILES_ERROR = new Error("profiles table unavailable");

    // LEGACY_TOKEN is both the device token and the legacy profile token so
    // that the condition `legacyToken && staleTokens.includes(legacyToken)` is
    // true, ensuring step 2 is always attempted.
    const {
      deletedDeviceTokens,
      profilesNulled,
      rentBuddyTokensNulled,
      client,
    } = makeFakeDb({
      deviceToken: LEGACY_TOKEN,
      legacyToken: LEGACY_TOKEN,
      // Step 1 (DELETE notification_devices) intentionally NOT set → succeeds
      profilesUpdateError: PROFILES_ERROR, // step 2 fails
      // Step 3 (rent_buddy_profiles UPDATE) intentionally NOT set → succeeds
    });

    const router = new NotificationRouter(client);
    await router.route(BASE_NOTIF);

    // Step 1 succeeded — the stale token must appear in the DELETE call
    assert.equal(
      deletedDeviceTokens.length,
      1,
      "step 1 succeeded — exactly one DELETE call on notification_devices",
    );
    assert.ok(
      deletedDeviceTokens[0].includes(LEGACY_TOKEN),
      `step 1 succeeded — deleted tokens should include ${LEGACY_TOKEN}`,
    );

    // Step 2 errored — no profile should have been nulled
    assert.equal(
      profilesNulled.length,
      0,
      "step 2 errored — profilesNulled must be empty",
    );

    // Step 3 must still have run and nulled the rent_buddy row
    assert.equal(
      rentBuddyTokensNulled.length,
      1,
      "step 3 must still run when only step 2 fails — one IN-update call on rent_buddy_profiles",
    );
    assert.ok(
      rentBuddyTokensNulled[0].includes(LEGACY_TOKEN),
      `rent_buddy_profiles must include the stale token ${LEGACY_TOKEN} even when step 2 fails`,
    );
  });

  it("success log is NOT emitted when a cleanup step fails (deleteDeviceError)", async () => {
    // notification_devices DELETE fails → anyFailure is set → the success info
    // log must be suppressed, preventing operators from seeing a false "all-clear".
    _setTestFetch(invalidCredFetch);
    const DB_ERROR = new Error("notification_devices unavailable");
    const { client } = makeFakeDb({ deviceToken: TOKEN, legacyToken: null, deleteDeviceError: DB_ERROR });

    const infoSpy = mock.method(_notificationRouterLogger, "info", () => {});
    try {
      const router = new NotificationRouter(client);
      await router.route(BASE_NOTIF);

      const calls = infoSpy.mock.calls.map((c) => c.arguments[1] as string | undefined);
      const emitted = calls.some((msg) => msg?.includes("removed stale push tokens"));
      assert.ok(
        !emitted,
        "info log 'removed stale push tokens' must NOT be emitted when a cleanup step fails",
      );
    } finally {
      infoSpy.mock.restore();
    }
  });

  it("logger.error fires — not just warn — when all three cleanup steps fail past the threshold in one call", async () => {
    // Use LEGACY_TOKEN as both the device token and the legacy profile token so
    // that all three cleanup steps are attempted in a single route() call:
    //   Step 1 — notification_devices DELETE        (deleteDeviceError, counter → 1, warn)
    //   Step 2 — profiles UPDATE (null legacy token) (profilesUpdateError, counter → 2, warn)
    //   Step 3 — rent_buddy_profiles UPDATE          (rentBuddyUpdateError, counter → 3, ≥ threshold → error)
    //
    // The threshold check happens inside each catch block independently, so step 3
    // must cross CLEANUP_ERROR_THRESHOLD (3) and emit logger.error rather than warn.
    _setTestFetch(invalidCredFetch);
    const STEP1_ERROR = new Error("notification_devices unavailable");
    const STEP2_ERROR = new Error("profiles table unavailable");
    const STEP3_ERROR = new Error("rent_buddy_profiles unavailable");
    const { client } = makeFakeDb({
      deviceToken: LEGACY_TOKEN,
      legacyToken: LEGACY_TOKEN,
      deleteDeviceError: STEP1_ERROR,
      profilesUpdateError: STEP2_ERROR,
      rentBuddyUpdateError: STEP3_ERROR,
    });

    const errorSpy = mock.method(_notificationRouterLogger, "error", () => {});
    try {
      const router = new NotificationRouter(client);
      await router.route(BASE_NOTIF);

      assert.ok(
        errorSpy.mock.calls.length >= 1,
        `logger.error must be called at least once when all three cleanup steps fail in one call (got ${errorSpy.mock.calls.length} error calls)`,
      );
    } finally {
      errorSpy.mock.restore();
    }
  });

  it("success log is NOT emitted when only the rent_buddy_profiles UPDATE step fails", async () => {
    // Step 1 (notification_devices DELETE) succeeds and step 2 (profiles UPDATE)
    // is skipped (no legacyToken), but step 3 (rent_buddy_profiles UPDATE) fails.
    // anyFailure is set to true via the step-3 catch block, so the success info
    // log must be suppressed — preventing a false "all-clear" while zombie
    // rent_buddy tokens remain.
    _setTestFetch(invalidCredFetch);
    const RENT_BUDDY_ERROR = new Error("rent_buddy_profiles unavailable");
    const { client } = makeFakeDb({
      deviceToken: TOKEN,
      legacyToken: null,            // step 2 skipped — not the source of the failure
      rentBuddyUpdateError: RENT_BUDDY_ERROR,
    });

    const infoSpy = mock.method(_notificationRouterLogger, "info", () => {});
    try {
      const router = new NotificationRouter(client);
      await router.route(BASE_NOTIF);

      const calls = infoSpy.mock.calls.map((c) => c.arguments[1] as string | undefined);
      const emitted = calls.some((msg) => msg?.includes("removed stale push tokens"));
      assert.ok(
        !emitted,
        "info log 'removed stale push tokens' must NOT be emitted when only the rent_buddy_profiles UPDATE step fails",
      );
    } finally {
      infoSpy.mock.restore();
    }
  });

  it("success log is NOT emitted when only the legacy-profile null step (step 2) fails", async () => {
    // Step 1 (notification_devices DELETE) succeeds; step 3 (rent_buddy_profiles
    // UPDATE) succeeds; only step 2 (profiles UPDATE — null legacy expo_push_token)
    // fails.  anyFailure must still be set to true by step 2's catch block, so the
    // "removed stale push tokens" info log must be suppressed.  Without this, a
    // zombie legacy profile token would be invisible to operators (false all-clear).
    _setTestFetch(invalidCredFetch);
    const PROFILES_ERROR = new Error("profiles table unavailable");
    const { client } = makeFakeDb({
      // TOKEN is both the device token and the legacy profile token so that step 2
      // (legacyToken && staleTokens.includes(legacyToken)) is always attempted.
      deviceToken: TOKEN,
      legacyToken: TOKEN,
      // Step 1 succeeds — deleteDeviceError intentionally absent
      profilesUpdateError: PROFILES_ERROR,
      // Step 3 succeeds — rentBuddyUpdateError intentionally absent
    });

    const infoSpy = mock.method(_notificationRouterLogger, "info", () => {});
    try {
      const router = new NotificationRouter(client);
      await router.route(BASE_NOTIF);

      const calls = infoSpy.mock.calls.map((c) => c.arguments[1] as string | undefined);
      const emitted = calls.some((msg) => msg?.includes("removed stale push tokens"));
      assert.ok(
        !emitted,
        "info log 'removed stale push tokens' must NOT be emitted when only the legacy-profile null step fails",
      );
    } finally {
      infoSpy.mock.restore();
    }
  });

  it("profiles UPDATE failure with no rent_buddy entry increments the counter by exactly 1 — not 2", async () => {
    // Step 2 (profiles UPDATE — null legacy expo_push_token) fails.
    // Step 3 (rent_buddy_profiles UPDATE) succeeds because rentBuddyUpdateError
    // is absent, so only one increment should occur per route() call.
    // This guards against double-counting: if the router mistakenly also
    // counted a Step 3 path for this token, the counter would reach 2 instead
    // of 1 on the first call.
    _setTestFetch(invalidCredFetch);
    const PROFILES_ERROR = new Error("profiles table unavailable");
    const { client: errorClient } = makeFakeDb({
      // LEGACY_TOKEN as the device token so Step 2 (profiles UPDATE) is attempted
      deviceToken: LEGACY_TOKEN,
      legacyToken: LEGACY_TOKEN,
      // Step 2 fails; Step 3 succeeds (rentBuddyUpdateError is absent)
      profilesUpdateError: PROFILES_ERROR,
    });
    const errorRouter = new NotificationRouter(errorClient);

    // First call — only Step 2 fails, so the counter must be exactly 1
    await errorRouter.route(BASE_NOTIF);
    assert.equal(
      _getCleanupFailureCount(),
      1,
      `profiles UPDATE failure with no rent_buddy error must increment the counter by exactly 1 (got ${_getCleanupFailureCount()})`,
    );

    // Second call — another lone Step 2 failure, counter must be exactly 2
    await errorRouter.route(BASE_NOTIF);
    assert.equal(
      _getCleanupFailureCount(),
      2,
      `second profiles UPDATE failure must increment the counter to exactly 2 — not 4 (got ${_getCleanupFailureCount()})`,
    );

    // Healthy call — all steps pass, so the counter must reset to 0
    const { client: healthyClient } = makeFakeDb({
      deviceToken: LEGACY_TOKEN,
      legacyToken: LEGACY_TOKEN,
    });
    const healthyRouter = new NotificationRouter(healthyClient);

    await healthyRouter.route(BASE_NOTIF);
    assert.equal(
      _getCleanupFailureCount(),
      0,
      "cleanup failure counter must reset to 0 after a healthy call following lone Step 2 failures",
    );
  });
});
