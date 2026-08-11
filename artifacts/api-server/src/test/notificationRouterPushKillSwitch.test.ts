/**
 * NotificationRouter — push_notifications_enabled admin kill-switch
 *
 * Red-proof for the kill switch on the NotificationRouter.sendPush() call
 * site specifically (a separate gate from sendPushWithRetry's — see
 * pushWithRetry.test.ts for that one). Confirms:
 *
 *   - flag OFF:  the send path refuses before touching tokens or Expo;
 *                exactly one delivery-attempt row is written and it is
 *                'suppressed', never 'sent' — i.e. no delivery attempt is
 *                recorded as having happened.
 *   - flag ON:   the gate lets the notification proceed to token lookup and
 *                Expo dispatch as normal.
 *   - flag DB error: fails closed (treated the same as OFF), matching
 *                isFlagEnabled's documented fail-closed contract.
 *
 * Run: node --import tsx/esm --test src/test/notificationRouterPushKillSwitch.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { _setTestFetch } from "../lib/push.js";
import { NotificationRouter, _resetCleanupFailureCount } from "../services/notifications/NotificationRouter.js";
import type { NotificationRow } from "../services/notifications/NotificationService.js";

const USER_ID  = "dd000000-0001-0001-0001-000000000001";
const TOKEN    = "ExponentPushToken[kill-switch-test-device]";
const NOTIF_ID = "ee000000-0002-0002-0002-000000000002";

// Category "safety" maps to the highest Compass priority level, which
// bypasses quiet-hours/DB checks inside evaluateNotification — isolates the
// assertions to the push_notifications_enabled gate itself.
const BASE_NOTIF: NotificationRow = {
  id:        NOTIF_ID,
  userId:    USER_ID,
  title:     "Test push",
  body:      "Kill-switch test",
  category:  "safety",
  eventType: "test_kill_switch",
  priority:  "urgent",
  isRead:    false,
  actionUrl: null,
  sourceId:  null,
  metadata:  null,
  expiresAt: null,
  createdAt: new Date().toISOString(),
};

const okFetch: typeof fetch = (async (_url: any, init: any) => {
  const messages: Array<{ to: string }> = JSON.parse((init as any).body);
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: messages.map(() => ({ status: "ok", id: "t1" })) }),
  } as any;
}) as any;

interface FakeDbOpts {
  /** push_notifications_enabled row value. undefined = flagError below decides. */
  pushEnabled?: boolean;
  /** Simulate the feature_flags SELECT itself erroring. */
  flagError?: boolean;
}

function makeFakeDb(opts: FakeDbOpts = {}) {
  const { pushEnabled = true, flagError = false } = opts;

  const deliveryAttempts: any[] = [];
  let devicesQueried = false;

  const client: any = {
    from(table: string) {
      return {
        select(_cols?: string) {
          const resolve = (): any => {
            if (table === "notification_preferences") return { data: null, error: null };
            if (table === "notification_category_preferences") return { data: [], error: null };
            if (table === "notification_devices") {
              devicesQueried = true;
              return { data: [{ push_token: TOKEN }], error: null };
            }
            if (table === "profiles") return { data: null, error: null };
            if (table === "blocks") return { data: null, error: null };
            if (table === "feature_flags") {
              if (flagError) return { data: null, error: { message: "db down" } };
              return { data: { enabled: pushEnabled }, error: null };
            }
            return { data: null, error: null };
          };
          const chain: any = {
            eq() { return chain; },
            in() { return chain; },
            maybeSingle() { return Promise.resolve(resolve()); },
            single() { return Promise.resolve(resolve()); },
            then(onF: any, onR: any) { return Promise.resolve(resolve()).then(onF, onR); },
          };
          return chain;
        },
        insert(row: any) {
          if (table === "notification_delivery_attempts") deliveryAttempts.push(row);
          const insertResult = { data: { id: "attempt-1" }, error: null };
          const p = Promise.resolve(insertResult);
          return Object.assign(p, {
            select() { return { single() { return Promise.resolve(insertResult); } }; },
          });
        },
        delete() { return { eq() { return { in() { return Promise.resolve({ error: null }); } }; } }; },
        update() { return { eq() { return Promise.resolve({ error: null }); }, in() { return Promise.resolve({ error: null }); } }; },
      };
    },
  };

  return { client, deliveryAttempts, devicesQueried: () => devicesQueried };
}

beforeEach(() => {
  _resetCleanupFailureCount();
  _setTestFetch(okFetch);
});

afterEach(() => {
  _setTestFetch(null);
});

describe("NotificationRouter — push_notifications_enabled kill switch", () => {
  it("refuses to send and records no delivery attempt when the flag is OFF", async () => {
    const { client, deliveryAttempts, devicesQueried } = makeFakeDb({ pushEnabled: false });
    let expoWasCalled = false;
    _setTestFetch((async (...args: any[]) => {
      expoWasCalled = true;
      return okFetch(...(args as [any, any]));
    }) as any);

    const router = new NotificationRouter(client);
    await router.route(BASE_NOTIF);

    assert.equal(expoWasCalled, false, "Expo push API must never be called when the flag is off");
    assert.equal(devicesQueried(), false, "push tokens must not even be looked up when the flag is off");

    const pushAttempts = deliveryAttempts.filter((a) => a.channel === "push");
    assert.equal(pushAttempts.length, 1, "exactly one push delivery-attempt row is written");
    assert.equal(pushAttempts[0].status, "suppressed", "the recorded row must be 'suppressed', never 'sent'");
    assert.ok(
      String(pushAttempts[0].error_message ?? "").includes("push_notifications_enabled"),
      "the suppression reason should name the kill switch",
    );
  });

  it("fails closed (same as OFF) when the feature_flags read errors", async () => {
    const { client, deliveryAttempts, devicesQueried } = makeFakeDb({ flagError: true });
    let expoWasCalled = false;
    _setTestFetch((async (...args: any[]) => {
      expoWasCalled = true;
      return okFetch(...(args as [any, any]));
    }) as any);

    const router = new NotificationRouter(client);
    await router.route(BASE_NOTIF);

    assert.equal(expoWasCalled, false, "Expo push API must not be called when the flag read errors (fail-closed)");
    assert.equal(devicesQueried(), false, "push tokens must not be looked up when the flag read errors");

    const pushAttempts = deliveryAttempts.filter((a) => a.channel === "push");
    assert.equal(pushAttempts.length, 1, "exactly one push delivery-attempt row is written");
    assert.equal(pushAttempts[0].status, "suppressed", "fail-closed must record 'suppressed', not 'sent'");
  });

  it("proceeds past the gate to token lookup and Expo dispatch when the flag is ON", async () => {
    const { client, devicesQueried } = makeFakeDb({ pushEnabled: true });
    let expoWasCalled = false;
    _setTestFetch((async (url: any, init: any) => {
      expoWasCalled = true;
      return okFetch(url, init);
    }) as any);

    const router = new NotificationRouter(client);
    await router.route(BASE_NOTIF);

    assert.equal(devicesQueried(), true, "push tokens must be looked up when the flag is on");
    assert.equal(expoWasCalled, true, "Expo push API must be called when the flag is on");
  });
});
