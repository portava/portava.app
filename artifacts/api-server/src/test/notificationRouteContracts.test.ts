/**
 * notificationRouteContracts — what the HTTP surface tells its caller when a
 * write or a read underneath it did not do what the response implies.
 *
 * Three contracts are pinned here, each of which used to be answered `ok: true`
 * (or a plain 200) for an operation that did not happen:
 *
 *   1. PUT /me/notification-preferences — a category mute whose upsert failed.
 *      `upsertCategoryPreferences` discarded its `{ error }` and returned void,
 *      so the handler answered `ok: true` and the user kept receiving the
 *      notifications they had just switched off.
 *   2. POST /internal/notifications/digest — an unreadable recipient list.
 *      `{ usersProcessed: 0 }` with HTTP 200 was returned both when no user had
 *      digests enabled AND when notification_preferences could not be read at
 *      all. A scheduler cannot retry a run it was told succeeded.
 *   3. POST /me/notifications/:id/dismiss — `notification.dismissed` was a
 *      declared realtime event type with NO producer anywhere in the tree, so
 *      other open sessions kept showing a card the user had dismissed.
 *
 * Note the `req.log` shim in the app below: without it these routes throw on
 * `req.log.error` and a 500-from-crash would masquerade as a working error
 * path. Case 1 asserts the ERROR CODE, not merely `status !== 200`.
 *
 * Run: node --import tsx/esm --test src/test/notificationRouteContracts.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeFailClosedClient, type FakeReadContext } from "./helpers/failClosedSupabase.js";
import notificationsRouter from "../routes/notifications.js";
import { activityBus } from "../services/notifications/RealtimeActivityService.js";

const USER_ID  = "ee000000-0000-4000-8000-000000000001";
const USER_TOK = "route-contract-user-token";
const SECRET   = "route-contract-internal-secret";
const NOTIF_ID = "ee000000-0000-4000-8000-000000000002";

const DB_DOWN = { message: "connection terminated unexpectedly", code: "57P01" };

let server: http.Server;
let base: string;

function installClient(opts: {
  failOn?: (ctx: FakeReadContext) => any;
  failWritesOn?: (table: string) => any;
  notifications?: any[];
} = {}) {
  const inserted: Record<string, any[]> = {};
  const updated: Record<string, any[]> = {};
  const client = makeFailClosedClient({
    rows: {
      profiles: [{ id: USER_ID, role: "user" }],
      notifications: opts.notifications ?? [],
      notification_preferences: [],
      notification_category_preferences: [],
      notification_devices: [],
      feature_flags: [{ flag: "push_notifications_enabled", enabled: false }],
    },
    inserted,
    updated,
    users: { [USER_TOK]: USER_ID },
    failOn: opts.failOn,
    failWritesOn: opts.failWritesOn,
  });
  _setTestClient(client, true);
  _setTestServiceClient(client);
  return { client, inserted, updated };
}

function request(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port),
        path: url.pathname + url.search, method,
        headers: { "content-type": "application/json", ...headers },
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

const AUTH = { authorization: `Bearer ${USER_TOK}` };

before(async () => {
  process.env.INTERNAL_API_SECRET = SECRET;
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", notificationsRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", () => resolve()); });
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => new Promise<void>((r) => { server.close(() => r()); }));

beforeEach(() => { installClient(); });

// ─────────────────────────────────────────────────────────────────────────────
// 1. A PREFERENCE WRITE THAT FAILED IS NOT `ok: true`
// ─────────────────────────────────────────────────────────────────────────────

describe("PUT /me/notification-preferences", () => {
  it("reports db_error when the category mute could not be stored", async () => {
    installClient({
      failWritesOn: (table) => (table === "notification_category_preferences" ? DB_DOWN : null),
    });
    const r = await request("PUT", "/api/me/notification-preferences", {
      categoryPreferences: [{ category: "trips", pushEnabled: false }],
    }, AUTH);

    assert.equal(r.status, 500, `expected 500, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "db_error", "the failure must be reported as a db_error, not as a crash or a success");
    assert.notEqual(r.body.ok, true);
  });

  it("answers ok:true when the same write SUCCEEDS", async () => {
    const { inserted } = installClient();
    const r = await request("PUT", "/api/me/notification-preferences", {
      categoryPreferences: [{ category: "trips", pushEnabled: false }],
    }, AUTH);

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(
      (inserted["notification_category_preferences"] ?? []).length, 1,
      "the mute must actually be written on the success path",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. A DIGEST RUN THAT COULD NOT READ ITS RECIPIENTS IS NOT A CLEAN RUN
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /internal/notifications/digest", () => {
  it("returns 503 when the recipient list is unreadable", async () => {
    installClient({
      failOn: (ctx) => (ctx.table === "notification_preferences" ? DB_DOWN : null),
    });
    const r = await request("POST", "/api/internal/notifications/digest", {}, { "x-internal-secret": SECRET });

    assert.equal(r.status, 503, `expected 503, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.notEqual(r.body.ok, true, "a failed run must not be reported as ok");
  });

  it("returns 200 with usersProcessed: 0 when nobody has digests enabled", async () => {
    installClient();
    const r = await request("POST", "/api/internal/notifications/digest", {}, { "x-internal-secret": SECRET });

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.usersProcessed, 0, "an empty recipient list is not an outage");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. REALTIME EVENTS THAT ROUTES ACTUALLY PRODUCE
// ─────────────────────────────────────────────────────────────────────────────

function captureBus(): { seen: any[]; stop: () => void } {
  const seen: any[] = [];
  const unsub = activityBus.subscribe((e) => seen.push(e));
  return { seen, stop: unsub };
}

describe("realtime activity events emitted by the routes", () => {
  it("POST /me/notifications/:id/dismiss emits notification.dismissed", async () => {
    installClient({
      notifications: [{ id: NOTIF_ID, user_id: USER_ID, read_at: null, dismissed_at: null }],
    });
    const cap = captureBus();
    try {
      const r = await request("POST", `/api/me/notifications/${NOTIF_ID}/dismiss`, undefined, AUTH);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const dismissed = cap.seen.filter((e) => e.type === "notification.dismissed");
      assert.equal(
        dismissed.length, 1,
        "`notification.dismissed` is a declared event type with no producer — other open " +
        "sessions keep showing a dismissed card until the next poll",
      );
      assert.equal(dismissed[0].userId, USER_ID);
      assert.equal(dismissed[0].payload.id, NOTIF_ID);
    } finally { cap.stop(); }
  });

  it("POST /me/notifications/:id/read emits notification.read", async () => {
    installClient({
      notifications: [{ id: NOTIF_ID, user_id: USER_ID, read_at: null, dismissed_at: null }],
    });
    const cap = captureBus();
    try {
      const r = await request("POST", `/api/me/notifications/${NOTIF_ID}/read`, undefined, AUTH);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const read = cap.seen.filter((e) => e.type === "notification.read");
      assert.equal(read.length, 1);
      assert.equal(read[0].payload.id, NOTIF_ID);
    } finally { cap.stop(); }
  });

  it("emits nothing when the dismiss target does not exist", async () => {
    installClient({ notifications: [] });
    const cap = captureBus();
    try {
      const r = await request("POST", `/api/me/notifications/${NOTIF_ID}/dismiss`, undefined, AUTH);
      assert.equal(r.status, 404, JSON.stringify(r.body));
      assert.equal(
        cap.seen.filter((e) => e.type === "notification.dismissed").length, 0,
        "a 404 must not broadcast a dismissal",
      );
    } finally { cap.stop(); }
  });
});
