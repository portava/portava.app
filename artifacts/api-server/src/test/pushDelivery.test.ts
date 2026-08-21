/**
 * Push notification delivery pipeline tests
 *
 * Verifies the full token-registration → dispatch loop without a live DB or
 * real Expo API.  Uses the node:test + fake-client pattern established in the
 * rest of this test suite.
 *
 * Coverage:
 *   1. sendPushNotification — token format filtering (non-Expo tokens dropped)
 *   2. sendPushNotification — Expo API request shape (messages array format)
 *   3. sendPushNotification — per-token error parsing (DeviceNotRegistered)
 *   4. sendPushNotification — HTTP error from Expo API is handled gracefully
 *   5. sendPushNotification — network error is handled gracefully
 *   6. sendPushNotification — mixed ok/error tickets counted correctly
 *   7. POST /api/me/devices — token upserted into notification_devices
 *   8. POST /api/me/devices — rejects token shorter than 10 chars
 *   9. POST /api/me/devices — rejects unknown platform value
 *  10. DELETE /api/me/devices/:id — token removal
 *  11. NotificationRouter.route — sendPushNotification called with tokens from DB
 *  12. NotificationRouter.route — falls back to profiles.expo_push_token when no device rows
 *  13. NotificationRouter.route — suppresses push when no tokens exist (logs suppressed)
 *  14. NotificationRouter.route — call.incoming push uses priority "high" (background wake)
 *  15. NotificationRouter.route — non-call pushes do NOT set priority "high"
 *
 * Run: node --import tsx/esm --test src/test/pushDelivery.test.ts
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { sendPushNotification, _setTestFetch } from "../lib/push.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { NotificationRouter } from "../services/notifications/NotificationRouter.js";
import notificationsRouter from "../routes/notifications.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const FAKE_TOKEN   = "pushtest-user-token";
const USER_ID      = "aa000000-0001-0001-0001-000000000001";
const OTHER_ID     = "aa000000-0002-0002-0002-000000000002";
const DEVICE_ID    = "aa000000-0003-0003-0003-000000000003";
const NOTIF_ID     = "aa000000-0004-0004-0004-000000000004";
const PUSH_TOKEN   = "ExponentPushToken[deviceAbc123]";
const LEGACY_TOKEN = "ExponentPushToken[legacyProfile1]";

// ── HTTP helper ────────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function req(
  method: string,
  path: string,
  body?: unknown,
  token: string = FAKE_TOKEN,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url     = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: url.hostname,
        port:     Number(url.port),
        path:     url.pathname + url.search,
        method,
        headers: {
          "content-type":  "application/json",
          "authorization": `Bearer ${token}`,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ── Fake client factory ────────────────────────────────────────────────────────

interface FakeState {
  profiles?: Array<{ id: string; role?: string; expo_push_token?: string | null }>;
  notifications?: Array<Record<string, any>>;
  notificationDevices?: Array<Record<string, any>>;
  notificationPreferences?: Array<Record<string, any>>;
  notificationCategoryPreferences?: Array<Record<string, any>>;
  notificationDeliveryAttempts?: Array<Record<string, any>>;
  locationPreferences?: Array<Record<string, any>>;
  featureFlags?: Record<string, boolean>;
}

function makeFakeClient(state: FakeState = {}) {
  const inserted:      Record<string, any[]> = {};
  const deleted:       Record<string, any[]> = {};
  const updatePatches: Record<string, any[]> = {};

  function getRows(table: string): any[] {
    if (table === "profiles")                           return state.profiles ?? [];
    if (table === "notifications")                      return state.notifications ?? [];
    if (table === "notification_devices")               return state.notificationDevices ?? [];
    if (table === "notification_preferences")           return state.notificationPreferences ?? [];
    if (table === "notification_category_preferences")  return state.notificationCategoryPreferences ?? [];
    if (table === "notification_delivery_attempts")     return state.notificationDeliveryAttempts ?? [];
    if (table === "user_location_preferences")          return state.locationPreferences ?? [];
    if (table === "feature_flags")
      return Object.entries(state.featureFlags ?? {}).map(([flag, enabled]) => ({ flag, enabled }));
    return [];
  }

  function builder(table: string) {
    const rows = getRows(table);
    let pendingInsert: any = null;
    let pendingUpdate: any = null;
    let pendingDelete        = false;
    const filters: Array<(r: any) => boolean> = [];
    let countMode = false;

    const b: any = {
      select(_cols?: string, opts?: any) {
        if (opts?.count === "exact") countMode = true;
        return b;
      },
      insert(row: any) {
        pendingInsert = row;
        if (!inserted[table]) inserted[table] = [];
        if (Array.isArray(row)) inserted[table].push(...row);
        else inserted[table].push(row);
        return b;
      },
      update(patch: any) {
        pendingUpdate = patch;
        if (!updatePatches[table]) updatePatches[table] = [];
        updatePatches[table].push(patch);
        return b;
      },
      upsert(row: any, _opts?: any) { pendingInsert = row; return b; },
      delete() { pendingDelete = true; return b; },
      eq(col: string, val: any)    { filters.push((r) => r[col] === val); return b; },
      neq(col: string, val: any)   { filters.push((r) => r[col] !== val); return b; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return b; },
      is(col: string, val: any)    { filters.push((r) => val === null ? r[col] == null : r[col] === val); return b; },
      gt()    { return b; },
      lt()    { return b; },
      or()    { return b; },
      ilike() { return b; },
      order() { return b; },
      limit() { return b; },
      range() { return b; },
      head()  { return b; },
      maybeSingle() { return resolveOne(); },
      single()      { return resolveOne(); },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    function getFiltered() { return rows.filter((r) => filters.every((f) => f(r))); }

    async function resolveOne() {
      if (pendingInsert) {
        const row = Array.isArray(pendingInsert) ? pendingInsert[0] : pendingInsert;
        return { data: { id: `${table}-new`, ...row }, error: null };
      }
      if (pendingUpdate) {
        const matched = getFiltered();
        return { data: matched[0] ? { ...matched[0], ...pendingUpdate } : null, error: null };
      }
      return { data: getFiltered()[0] ?? null, error: null };
    }

    async function resolveList() {
      if (pendingInsert) {
        const row = Array.isArray(pendingInsert) ? pendingInsert[0] : pendingInsert;
        return { data: { id: `${table}-new`, ...row }, error: null, count: null };
      }
      if (pendingUpdate) {
        return { data: getFiltered(), error: null, count: null };
      }
      if (pendingDelete) {
        const matched = getFiltered();
        if (!deleted[table]) deleted[table] = [];
        deleted[table].push(...matched);
        return { data: matched, error: null, count: null };
      }
      const matched = getFiltered();
      if (countMode) return { data: matched, count: matched.length, error: null };
      return { data: matched, error: null, count: null };
    }

    return b;
  }

  const client: any = {
    from: builder,
    auth: {
      getUser: async (token: string) => {
        if (token === FAKE_TOKEN) return { data: { user: { id: USER_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
    __inserted:      inserted,
    __deleted:       deleted,
    __updatePatches: updatePatches,
  };
  return client;
}

// ── Shared server setup for route tests ───────────────────────────────────────

before(async () => {
  const state: FakeState = {
    profiles: [
      { id: USER_ID, role: "user", expo_push_token: LEGACY_TOKEN },
    ],
    notifications: [],
    notificationDevices: [
      { id: DEVICE_ID, user_id: USER_ID, push_token: PUSH_TOKEN, platform: "expo" },
    ],
    notificationPreferences: [
      {
        user_id: USER_ID, push_enabled: true, email_enabled: false,
        in_app_enabled: true, digests_enabled: false, safety_override: true,
        quiet_hours_enabled: false, quiet_start: "22:00", quiet_end: "08:00",
        message_previews: true, location_previews: false,
      },
    ],
    notificationCategoryPreferences: [],
    notificationDeliveryAttempts: [],
    locationPreferences: [],
    featureFlags: {
      notifications_enabled:      true,
      push_notifications_enabled: true,
    },
  };

  const client = makeFakeClient(state);
  _setTestClient(client, true);
  _setTestServiceClient(client);

  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => {
    r.log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });
  app.use("/api", notificationsRouter);

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => new Promise<void>((r) => server.close(r)));

// Always clean up the test fetch slot after each test that sets it
afterEach(() => _setTestFetch(null));

// ─────────────────────────────────────────────────────────────────────────────
// 1. sendPushNotification — non-Expo tokens are silently dropped
// ─────────────────────────────────────────────────────────────────────────────
describe("sendPushNotification — token format filtering", () => {
  it("drops non-Expo tokens and returns sent=0", async () => {
    let fetchCalled = false;
    _setTestFetch(async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });

    const result = await sendPushNotification(
      ["fcm://invalid-token", null, undefined, "apns://also-invalid"],
      { title: "Test", body: "Hello" },
    );

    assert.equal(fetchCalled, false, "fetch must not be called when no valid Expo tokens");
    assert.equal(result.sent, 0);
    assert.deepEqual(result.errors, []);
  });

  it("accepts only ExponentPushToken[...] format", async () => {
    const captured: any[] = [];
    _setTestFetch(async (_url, init) => {
      captured.push(JSON.parse((init?.body as string) ?? "null"));
      return new Response(JSON.stringify({ data: [{ status: "ok", id: "receipt-1" }] }), { status: 200 });
    });

    const result = await sendPushNotification(
      ["ExponentPushToken[valid1]", "invalid-token", null],
      { title: "T", body: "B" },
    );

    assert.equal(captured.length, 1, "fetch must be called once");
    const messages = captured[0] as any[];
    assert.equal(messages.length, 1, "only 1 valid token should be in the request");
    assert.equal(messages[0].to, "ExponentPushToken[valid1]");
    assert.equal(result.sent, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. sendPushNotification — Expo API request shape
// ─────────────────────────────────────────────────────────────────────────────
describe("sendPushNotification — Expo API request shape", () => {
  it("sends correct message format to Expo Push API", async () => {
    let capturedBody: any = null;
    _setTestFetch(async (_url, init) => {
      capturedBody = JSON.parse((init?.body as string) ?? "null");
      return new Response(
        JSON.stringify({ data: [{ status: "ok", id: "abc" }, { status: "ok", id: "def" }] }),
        { status: 200 },
      );
    });

    await sendPushNotification(
      ["ExponentPushToken[device1]", "ExponentPushToken[device2]"],
      { title: "Trip invite", body: "Alice accepted your invite", data: { tripId: "trip-123" } },
    );

    assert.ok(Array.isArray(capturedBody), "body must be an array of messages");
    assert.equal(capturedBody.length, 2, "one message per valid token");
    const msg = capturedBody[0];
    assert.equal(msg.to, "ExponentPushToken[device1]");
    assert.equal(msg.title, "Trip invite");
    assert.equal(msg.body, "Alice accepted your invite");
    assert.equal(msg.sound, "default");
    assert.deepEqual(msg.data, { tripId: "trip-123" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. sendPushNotification — per-token DeviceNotRegistered error
// ─────────────────────────────────────────────────────────────────────────────
describe("sendPushNotification — per-token error parsing", () => {
  it("parses DeviceNotRegistered errors from the Expo response body", async () => {
    _setTestFetch(async () => {
      return new Response(
        JSON.stringify({
          data: [
            { status: "ok", id: "receipt-ok" },
            {
              status: "error",
              message: "The device cannot receive push notifications",
              details: { error: "DeviceNotRegistered" },
            },
          ],
        }),
        { status: 200 },
      );
    });

    const result = await sendPushNotification(
      ["ExponentPushToken[good]", "ExponentPushToken[stale]"],
      { title: "T", body: "B" },
    );

    assert.equal(result.sent, 1, "one token delivered successfully");
    assert.equal(result.errors.length, 1, "one per-token error");
    assert.equal(result.errors[0].token, "ExponentPushToken[stale]");
    assert.equal(result.errors[0].error, "DeviceNotRegistered");
  });

  it("treats all tokens as sent when response body is unparseable JSON", async () => {
    _setTestFetch(async () => new Response("not-json", { status: 200 }));

    const result = await sendPushNotification(
      ["ExponentPushToken[t1]"],
      { title: "T", body: "B" },
    );

    assert.equal(result.errors.length, 0, "no per-token errors when body parse fails");
    assert.equal(result.sent, 1, "token count used as fallback sent count");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. sendPushNotification — HTTP error response
// ─────────────────────────────────────────────────────────────────────────────
describe("sendPushNotification — HTTP error handling", () => {
  it("returns sent=0 on non-2xx HTTP status", async () => {
    _setTestFetch(async () => new Response("Service Unavailable", { status: 503 }));

    const result = await sendPushNotification(
      ["ExponentPushToken[tok]"],
      { title: "T", body: "B" },
    );

    assert.equal(result.sent, 0);
    assert.deepEqual(result.errors, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. sendPushNotification — network error
// ─────────────────────────────────────────────────────────────────────────────
describe("sendPushNotification — network error handling", () => {
  it("returns sent=0 on fetch rejection (network error)", async () => {
    _setTestFetch(async () => { throw new Error("ECONNREFUSED"); });

    const result = await sendPushNotification(
      ["ExponentPushToken[tok]"],
      { title: "T", body: "B" },
    );

    assert.equal(result.sent, 0);
    assert.deepEqual(result.errors, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. sendPushNotification — mixed ok/error tickets
// ─────────────────────────────────────────────────────────────────────────────
describe("sendPushNotification — mixed ok/error tickets", () => {
  it("correctly counts sent and errors when tickets are mixed", async () => {
    _setTestFetch(async () => {
      return new Response(
        JSON.stringify({
          data: [
            { status: "ok",    id: "r1" },
            { status: "ok",    id: "r2" },
            { status: "error", message: "Invalid token", details: { error: "InvalidCredentials" } },
            { status: "ok",    id: "r3" },
          ],
        }),
        { status: 200 },
      );
    });

    const result = await sendPushNotification(
      [
        "ExponentPushToken[t1]",
        "ExponentPushToken[t2]",
        "ExponentPushToken[t3]",
        "ExponentPushToken[t4]",
      ],
      { title: "T", body: "B" },
    );

    assert.equal(result.sent, 3);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].error, "InvalidCredentials");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7–9. POST /api/me/devices — device registration
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/me/devices — device registration", () => {
  it("returns 201 with deviceId and saves token", async () => {
    const r = await req("POST", "/api/me/devices", {
      pushToken: "ExponentPushToken[newdeviceXYZ]",
      platform:  "expo",
    });
    assert.equal(r.status, 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, true);
    assert.ok(r.body.deviceId, "should return a deviceId");
  });

  it("accepts optional label field", async () => {
    const r = await req("POST", "/api/me/devices", {
      pushToken: "ExponentPushToken[labelledDevice]",
      platform:  "expo",
      label:     "iPhone 15",
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.ok, true);
  });

  it("rejects push token shorter than 10 characters (400)", async () => {
    const r = await req("POST", "/api/me/devices", { pushToken: "abc" });
    assert.equal(r.status, 400);
  });

  it("rejects unknown platform value (400)", async () => {
    const r = await req("POST", "/api/me/devices", {
      pushToken: "ExponentPushToken[validtok]",
      platform:  "gcm",
    });
    assert.equal(r.status, 400);
  });

  it("returns 401 for unauthenticated request", async () => {
    const r = await req(
      "POST", "/api/me/devices",
      { pushToken: "ExponentPushToken[tok]" },
      "bad-token",
    );
    assert.equal(r.status, 401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. DELETE /api/me/devices/:id — token removal
// ─────────────────────────────────────────────────────────────────────────────
describe("DELETE /api/me/devices/:id — token removal", () => {
  it("returns 200 ok for device deletion", async () => {
    const r = await req("DELETE", `/api/me/devices/${DEVICE_ID}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: build a minimal notification row for router tests
// ─────────────────────────────────────────────────────────────────────────────
function makeNotification(overrides: Record<string, any> = {}) {
  return {
    id:          NOTIF_ID,
    userId:      USER_ID,
    category:    "trips",
    eventType:   "trip.invite_accepted",
    priority:    "important",
    title:       "Alice accepted your invite",
    body:        "Alice is now part of Thailand Adventure",
    actionUrl:   "/trip/trip-123",
    metadata:    {},
    read_at:     null,
    dismissed_at: null,
    expires_at:  null,
    created_at:  new Date().toISOString(),
    privacy_level: "standard",
    source_type: "trip",
    source_id:   "trip-123",
    actor_id:    OTHER_ID,
    image_url:   null,
    ...overrides,
  };
}

function basePrefs() {
  return [{
    user_id: USER_ID, push_enabled: true, email_enabled: false,
    in_app_enabled: true, digests_enabled: false, safety_override: true,
    quiet_hours_enabled: false, quiet_start: "22:00", quiet_end: "08:00",
    message_previews: true, location_previews: false,
  }];
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. NotificationRouter — dispatches push to notification_devices tokens
// ─────────────────────────────────────────────────────────────────────────────
describe("NotificationRouter — push dispatch end-to-end", () => {
  it("calls Expo API with tokens from notification_devices", async () => {
    const capturedTokens: string[] = [];
    let expoCallCount = 0;

    _setTestFetch(async (_url, init) => {
      expoCallCount++;
      const messages = JSON.parse((init?.body as string) ?? "null") as any[];
      capturedTokens.push(...messages.map((m: any) => m.to as string));
      return new Response(
        JSON.stringify({ data: messages.map(() => ({ status: "ok", id: "r" })) }),
        { status: 200 },
      );
    });

    const state: FakeState = {
      profiles: [{ id: USER_ID, role: "user", expo_push_token: null }],
      notificationDevices: [
        { id: "dev-a", user_id: USER_ID, push_token: "ExponentPushToken[devA]", platform: "expo" },
        { id: "dev-b", user_id: USER_ID, push_token: "ExponentPushToken[devB]", platform: "expo" },
      ],
      notificationPreferences: basePrefs(),
      notificationCategoryPreferences: [],
      notificationDeliveryAttempts: [],
      locationPreferences: [],
      featureFlags: { notifications_enabled: true, push_notifications_enabled: true },
    };
    const client = makeFakeClient(state);

    const router = new NotificationRouter(client);
    await router.route(makeNotification() as any);

    assert.equal(expoCallCount, 1, "Expo API should be called exactly once");
    assert.ok(capturedTokens.includes("ExponentPushToken[devA]"), "devA token must be sent");
    assert.ok(capturedTokens.includes("ExponentPushToken[devB]"), "devB token must be sent");
    assert.equal(capturedTokens.length, 2, "exactly two device tokens sent");
  });

  it("falls back to profiles.expo_push_token when notification_devices is empty", async () => {
    const capturedTokens: string[] = [];

    _setTestFetch(async (_url, init) => {
      const messages = JSON.parse((init?.body as string) ?? "null") as any[];
      capturedTokens.push(...messages.map((m: any) => m.to as string));
      return new Response(JSON.stringify({ data: [{ status: "ok", id: "r" }] }), { status: 200 });
    });

    const state: FakeState = {
      profiles: [{ id: USER_ID, role: "user", expo_push_token: LEGACY_TOKEN }],
      notificationDevices: [], // empty — must fall back to profile column
      notificationPreferences: basePrefs(),
      notificationCategoryPreferences: [],
      notificationDeliveryAttempts: [],
      locationPreferences: [],
      featureFlags: { notifications_enabled: true, push_notifications_enabled: true },
    };
    const client = makeFakeClient(state);

    const router = new NotificationRouter(client);
    await router.route(makeNotification() as any);

    assert.ok(
      capturedTokens.includes(LEGACY_TOKEN),
      "legacy profiles.expo_push_token must be used as fallback",
    );
  });

  it("logs suppressed delivery attempt when user has no push tokens at all", async () => {
    let fetchCalled = false;
    _setTestFetch(async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });

    const state: FakeState = {
      profiles: [{ id: USER_ID, role: "user", expo_push_token: null }],
      notificationDevices: [], // no tokens at all
      notificationPreferences: basePrefs(),
      notificationCategoryPreferences: [],
      notificationDeliveryAttempts: [],
      locationPreferences: [],
      featureFlags: { notifications_enabled: true, push_notifications_enabled: true },
    };
    const client = makeFakeClient(state);

    const router = new NotificationRouter(client);
    await router.route(makeNotification() as any);

    assert.equal(fetchCalled, false, "Expo API must not be called when no tokens exist");

    const attempts = client.__inserted["notification_delivery_attempts"] ?? [];
    const pushAttempt = attempts.find((a: any) => a.channel === "push");
    assert.ok(pushAttempt, "a push delivery attempt must be logged");
    assert.equal(pushAttempt.status, "suppressed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. NotificationRouter — DeviceNotRegistered removes token from notification_devices
// ─────────────────────────────────────────────────────────────────────────────
describe("NotificationRouter — stale token cleanup on DeviceNotRegistered", () => {
  it("deletes the stale device row from notification_devices", async () => {
    const STALE_TOKEN = "ExponentPushToken[staleDevice]";
    const GOOD_TOKEN  = "ExponentPushToken[goodDevice]";

    _setTestFetch(async (_url, init) => {
      const messages = JSON.parse((init?.body as string) ?? "null") as any[];
      return new Response(
        JSON.stringify({
          data: messages.map((m: any) =>
            m.to === STALE_TOKEN
              ? { status: "error", message: "Not registered", details: { error: "DeviceNotRegistered" } }
              : { status: "ok", id: "receipt-good" },
          ),
        }),
        { status: 200 },
      );
    });

    const state: FakeState = {
      profiles: [{ id: USER_ID, role: "user", expo_push_token: null }],
      notificationDevices: [
        { id: "dev-good",  user_id: USER_ID, push_token: GOOD_TOKEN,  platform: "expo" },
        { id: "dev-stale", user_id: USER_ID, push_token: STALE_TOKEN, platform: "expo" },
      ],
      notificationPreferences: basePrefs(),
      notificationCategoryPreferences: [],
      notificationDeliveryAttempts: [],
      locationPreferences: [],
      featureFlags: { notifications_enabled: true, push_notifications_enabled: true },
    };
    const client = makeFakeClient(state);

    const router = new NotificationRouter(client);
    await router.route(makeNotification() as any);

    const deletedDevices = client.__deleted["notification_devices"] ?? [];
    const staleDeleted = deletedDevices.some((d: any) => d.push_token === STALE_TOKEN);
    assert.ok(staleDeleted, "the stale device row must be removed from notification_devices");

    const goodDeleted = deletedDevices.some((d: any) => d.push_token === GOOD_TOKEN);
    assert.equal(goodDeleted, false, "the healthy device must not be deleted");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 15. NotificationRouter — DeviceNotRegistered also clears profiles.expo_push_token
  // ─────────────────────────────────────────────────────────────────────────
  it("clears profiles.expo_push_token when the legacy token is the stale one", async () => {
    const STALE_LEGACY = "ExponentPushToken[legacyStale]";

    _setTestFetch(async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              status: "error",
              message: "Not registered",
              details: { error: "DeviceNotRegistered" },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const state: FakeState = {
      profiles: [{ id: USER_ID, role: "user", expo_push_token: STALE_LEGACY }],
      notificationDevices: [], // no device rows — legacy path
      notificationPreferences: basePrefs(),
      notificationCategoryPreferences: [],
      notificationDeliveryAttempts: [],
      locationPreferences: [],
      featureFlags: { notifications_enabled: true, push_notifications_enabled: true },
    };
    const client = makeFakeClient(state);

    const router = new NotificationRouter(client);
    await router.route(makeNotification() as any);

    const profilePatches = client.__updatePatches["profiles"] ?? [];
    const clearedLegacy = profilePatches.some(
      (p: any) => "expo_push_token" in p && p.expo_push_token === null,
    );
    assert.ok(clearedLegacy, "profiles.expo_push_token must be set to null for the stale legacy token");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 16. NotificationRouter — InvalidCredentials deletes the token (same as DeviceNotRegistered)
// ─────────────────────────────────────────────────────────────────────────────
describe("NotificationRouter — stale token cleanup on InvalidCredentials", () => {
  it("deletes the token from notification_devices on InvalidCredentials", async () => {
    const INVALID_TOKEN = "ExponentPushToken[invalidCreds]";
    const GOOD_TOKEN    = "ExponentPushToken[goodDevice2]";

    _setTestFetch(async (_url, init) => {
      const messages = JSON.parse((init?.body as string) ?? "null") as any[];
      return new Response(
        JSON.stringify({
          data: messages.map((m: any) =>
            m.to === INVALID_TOKEN
              ? { status: "error", message: "Invalid credentials", details: { error: "InvalidCredentials" } }
              : { status: "ok", id: "receipt-good" },
          ),
        }),
        { status: 200 },
      );
    });

    const state: FakeState = {
      profiles: [{ id: USER_ID, role: "user", expo_push_token: null }],
      notificationDevices: [
        { id: "dev-good2",   user_id: USER_ID, push_token: GOOD_TOKEN,    platform: "expo" },
        { id: "dev-invalid", user_id: USER_ID, push_token: INVALID_TOKEN, platform: "expo" },
      ],
      notificationPreferences: basePrefs(),
      notificationCategoryPreferences: [],
      notificationDeliveryAttempts: [],
      locationPreferences: [],
      featureFlags: { notifications_enabled: true, push_notifications_enabled: true },
    };
    const client = makeFakeClient(state);

    const router = new NotificationRouter(client);
    await router.route(makeNotification() as any);

    const deletedDevices = client.__deleted["notification_devices"] ?? [];
    assert.ok(
      deletedDevices.some((d: any) => d.push_token === INVALID_TOKEN),
      "the InvalidCredentials token must be removed from notification_devices",
    );
    assert.equal(
      deletedDevices.some((d: any) => d.push_token === GOOD_TOKEN),
      false,
      "the healthy token must not be deleted",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 17. NotificationRouter — MessageRateExceeded does NOT delete the token
// ─────────────────────────────────────────────────────────────────────────────
describe("NotificationRouter — token preserved on MessageRateExceeded", () => {
  it("does not delete the token from notification_devices on MessageRateExceeded", async () => {
    const RATE_TOKEN = "ExponentPushToken[rateLimited]";

    _setTestFetch(async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              status: "error",
              message: "Too many messages sent to this device",
              details: { error: "MessageRateExceeded" },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const state: FakeState = {
      profiles: [{ id: USER_ID, role: "user", expo_push_token: null }],
      notificationDevices: [
        { id: "dev-rate", user_id: USER_ID, push_token: RATE_TOKEN, platform: "expo" },
      ],
      notificationPreferences: basePrefs(),
      notificationCategoryPreferences: [],
      notificationDeliveryAttempts: [],
      locationPreferences: [],
      featureFlags: { notifications_enabled: true, push_notifications_enabled: true },
    };
    const client = makeFakeClient(state);

    const router = new NotificationRouter(client);
    await router.route(makeNotification() as any);

    const deletedDevices = client.__deleted["notification_devices"] ?? [];
    assert.equal(
      deletedDevices.some((d: any) => d.push_token === RATE_TOKEN),
      false,
      "a rate-limited token must not be deleted — the device is still valid",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 18. POST /api/me/devices — stale token cleanup on re-registration
//
//   When a user reinstalls the app a new Expo push token is issued.  The old
//   token row must be removed immediately at registration time so the table
//   stays bounded.  Tokens for a different platform must not be affected.
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/me/devices — stale token cleanup on re-registration", () => {
  let cleanupSrv: http.Server;
  let cleanupBase: string;
  let cleanupClient: ReturnType<typeof makeFakeClient>;

  const OLD_TOKEN_A = "ExponentPushToken[installOne111abc]";
  const OLD_TOKEN_B = "ExponentPushToken[installTwo222abc]";
  const NEW_EXPO    = "ExponentPushToken[freshInstall333abc]";

  before(async () => {
    const state: FakeState = {
      profiles: [{ id: USER_ID, role: "user", expo_push_token: OLD_TOKEN_A }],
      notificationDevices: [
        { id: "stale-a", user_id: USER_ID, push_token: OLD_TOKEN_A, platform: "expo" },
        { id: "stale-b", user_id: USER_ID, push_token: OLD_TOKEN_B, platform: "expo" },
      ],
      notificationPreferences:         [],
      notificationCategoryPreferences: [],
      notificationDeliveryAttempts:    [],
      locationPreferences:             [],
      featureFlags: { notifications_enabled: true, push_notifications_enabled: true },
    };

    cleanupClient = makeFakeClient(state);
    _setTestClient(cleanupClient, true);
    _setTestServiceClient(cleanupClient);

    const app = express();
    app.use(express.json());
    app.use((r: any, _res: any, next: any) => {
      r.log = { error: () => {}, info: () => {}, warn: () => {} };
      next();
    });
    app.use("/api", notificationsRouter);

    cleanupSrv = http.createServer(app);
    await new Promise<void>((resolve) => cleanupSrv.listen(0, "127.0.0.1", resolve));
    const addr = cleanupSrv.address() as { port: number };
    cleanupBase = `http://127.0.0.1:${addr.port}`;
  });

  after(() => new Promise<void>((r) => cleanupSrv.close(r)));

  function reqTo(
    method: string,
    path: string,
    body?: unknown,
    token: string = FAKE_TOKEN,
  ): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const url     = new URL(path, cleanupBase);
      const payload = body ? JSON.stringify(body) : undefined;
      const r = http.request(
        {
          hostname: url.hostname,
          port:     Number(url.port),
          path:     url.pathname + url.search,
          method,
          headers: {
            "content-type":  "application/json",
            "authorization": `Bearer ${token}`,
          },
        },
        (res) => {
          let raw = "";
          res.on("data", (c) => (raw += c));
          res.on("end", () => {
            let parsed: any;
            try { parsed = JSON.parse(raw); } catch { parsed = raw; }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      r.on("error", reject);
      if (payload) r.write(payload);
      r.end();
    });
  }

  it("deletes all existing expo tokens for the user when a new expo token is registered", async () => {
    const r = await reqTo("POST", "/api/me/devices", { pushToken: NEW_EXPO, platform: "expo" });
    assert.equal(r.status, 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.deviceId, "should return a deviceId");

    const deleted      = cleanupClient.__deleted["notification_devices"] ?? [];
    const deletedTokens: string[] = deleted.map((d: any) => d.push_token);

    assert.ok(deletedTokens.includes(OLD_TOKEN_A), "first stale token must be deleted");
    assert.ok(deletedTokens.includes(OLD_TOKEN_B), "second stale token must be deleted");
    assert.ok(!deletedTokens.includes(NEW_EXPO),   "the newly registered token must not be deleted");
  });

  it("does not delete tokens belonging to a different platform", async () => {
    const EXISTING_FCM  = "ExponentPushToken[fcmDeviceExisting]";
    const EXISTING_EXPO = "ExponentPushToken[expoDeviceExisting]";
    const NEW_FCM       = "ExponentPushToken[fcmDeviceNew555]";

    const state2: FakeState = {
      profiles: [{ id: USER_ID, role: "user", expo_push_token: null }],
      notificationDevices: [
        { id: "cross-expo", user_id: USER_ID, push_token: EXISTING_EXPO, platform: "expo" },
        { id: "cross-fcm",  user_id: USER_ID, push_token: EXISTING_FCM,  platform: "fcm" },
      ],
      notificationPreferences:         [],
      notificationCategoryPreferences: [],
      notificationDeliveryAttempts:    [],
      locationPreferences:             [],
      featureFlags: { notifications_enabled: true, push_notifications_enabled: true },
    };

    const crossClient = makeFakeClient(state2);
    _setTestClient(crossClient, true);
    _setTestServiceClient(crossClient);

    const r = await reqTo("POST", "/api/me/devices", { pushToken: NEW_FCM, platform: "fcm" });
    assert.equal(r.status, 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);

    const deleted      = crossClient.__deleted["notification_devices"] ?? [];
    const deletedTokens: string[] = deleted.map((d: any) => d.push_token);

    assert.ok(deletedTokens.includes(EXISTING_FCM),  "old FCM token on same platform must be deleted");
    assert.ok(!deletedTokens.includes(EXISTING_EXPO), "expo token on a different platform must NOT be deleted");
    assert.ok(!deletedTokens.includes(NEW_FCM),       "the newly registered FCM token must not be deleted");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. NotificationRouter — call.incoming push carries priority "high"
//
// Without priority:"high", Android/FCM delivers the message at normal priority
// and will not wake a backgrounded device.  APNs also uses priority 10
// (immediate) only when the push carries a sound + high priority; omitting it
// falls back to priority 5 (opportunistic).  This test proves the HTTP body
// that reaches the Expo Push API always includes priority:"high" for incoming
// calls so backgrounded devices actually ring.
// ─────────────────────────────────────────────────────────────────────────────
describe("NotificationRouter — call.incoming push priority", () => {
  it("outgoing Expo HTTP body carries priority:\"high\" for call.incoming", async () => {
    const capturedMessages: any[] = [];

    _setTestFetch(async (_url, init) => {
      const body = JSON.parse((init?.body as string) ?? "null") as any[];
      capturedMessages.push(...body);
      return new Response(
        JSON.stringify({ data: body.map(() => ({ status: "ok", id: "r" })) }),
        { status: 200 },
      );
    });

    const state: FakeState = {
      profiles: [{ id: USER_ID, role: "user", expo_push_token: null }],
      notificationDevices: [
        { id: "dev-call", user_id: USER_ID, push_token: "ExponentPushToken[callDevice]", platform: "expo" },
      ],
      notificationPreferences: basePrefs(),
      notificationCategoryPreferences: [],
      notificationDeliveryAttempts: [],
      locationPreferences: [],
      featureFlags: { notifications_enabled: true, push_notifications_enabled: true },
    };
    const client = makeFakeClient(state);

    const router = new NotificationRouter(client);
    await router.route(
      makeNotification({
        eventType: "call.incoming",
        category: "telegraph",
        priority: "important",
        title: "@bob is calling you",
        body: "Incoming call",
      }) as any,
    );

    assert.equal(capturedMessages.length, 1, "exactly one push message sent");
    assert.equal(
      capturedMessages[0].priority,
      "high",
      "call.incoming push must carry priority:\"high\" so FCM wakes a backgrounded device",
    );
    assert.equal(
      capturedMessages[0].channelId,
      "incoming_calls",
      "call.incoming push must carry channelId:\"incoming_calls\" so Android delivers it as a heads-up overlay",
    );
    assert.equal(capturedMessages[0].sound, "default", "sound must be set for audible ring");
    assert.equal(capturedMessages[0].to, "ExponentPushToken[callDevice]");
  });

  it("non-call pushes do NOT carry priority:\"high\" in the Expo HTTP body", async () => {
    const capturedMessages: any[] = [];

    _setTestFetch(async (_url, init) => {
      const body = JSON.parse((init?.body as string) ?? "null") as any[];
      capturedMessages.push(...body);
      return new Response(
        JSON.stringify({ data: body.map(() => ({ status: "ok", id: "r" })) }),
        { status: 200 },
      );
    });

    const state: FakeState = {
      profiles: [{ id: USER_ID, role: "user", expo_push_token: null }],
      notificationDevices: [
        { id: "dev-trip", user_id: USER_ID, push_token: "ExponentPushToken[tripDevice]", platform: "expo" },
      ],
      notificationPreferences: basePrefs(),
      notificationCategoryPreferences: [],
      notificationDeliveryAttempts: [],
      locationPreferences: [],
      featureFlags: { notifications_enabled: true, push_notifications_enabled: true },
    };
    const client = makeFakeClient(state);

    const router = new NotificationRouter(client);
    // trip.invite_accepted is "important" priority in the template but is NOT
    // an incoming call — it must NOT get priority:"high" in the push payload.
    await router.route(makeNotification() as any); // default: trip.invite_accepted

    assert.equal(capturedMessages.length, 1, "exactly one push message sent");
    assert.notEqual(
      capturedMessages[0].priority,
      "high",
      "non-call notifications must not consume FCM high-priority quota",
    );
  });
});
