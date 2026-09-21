/**
 * notificationIssuance — does the notification pipeline actually SEND anything?
 *
 * ── WHY A REAL CLIENT AND NOT A FAKE ─────────────────────────────────────────
 * `PostgrestBuilder` is a THENABLE, not a promise: it builds headers and calls
 * `_fetch` inside `then()` (@supabase/postgrest-js@2.108.2). So
 *
 *     void sc.from("notification_delivery_attempts").insert({ … });
 *
 * constructs a request and throws it away — NO HTTP CALL IS MADE. A hand-rolled
 * fake client cannot tell that apart from a real send, because the fake's
 * `.insert()` captures the row EAGERLY, before any continuation runs. Twenty
 * such dead writes shipped in this tree (see unissuedWrites.test.ts).
 *
 * Every assertion below therefore counts REAL fetch invocations made by a REAL
 * `createClient`, exactly as unissuedWrites.test.ts does. The question answered
 * is narrow and factual: for each stage of the pipeline, was an HTTP request to
 * PostgREST issued, to which table, with which body.
 *
 * The last case is a VACUITY GUARD. A harness that silently stopped recording
 * would make every "expected N calls" assertion above it trivially satisfiable
 * with N=0 in a future edit; the guard asserts the recorder saw traffic at all,
 * and each case asserts a NON-ZERO count rather than merely "not more than".
 *
 * Run: node --import tsx/esm --test src/test/notificationIssuance.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

import { _setTestFetch } from "../lib/push.js";
import { NotificationService } from "../services/notifications/NotificationService.js";
import { NotificationRouter, _resetCleanupFailureCount } from "../services/notifications/NotificationRouter.js";
import { NotificationPreferenceService } from "../services/notifications/NotificationPreferenceService.js";
import { RealtimeActivityService } from "../services/notifications/RealtimeActivityService.js";
import type { NotificationRow } from "../services/notifications/NotificationService.js";

const SUPA_URL = "http://supabase.test";
const SUPA_KEY = "test-service-role-key";

const USER_ID  = "aa000000-0000-4000-8000-000000000001";
const NOTIF_ID = "aa000000-0000-4000-8000-000000000002";

interface Call { method: string; path: string; query: string; body: any }

let calls: Call[] = [];
/** Total requests recorded across every case in this file — the vacuity witness. */
let lifetimeCalls = 0;

type Responder = (c: Call) => unknown;

function makeRecordingFetch(respond: Responder): typeof fetch {
  return (async (input: any, init: any = {}) => {
    const raw = typeof input === "string" ? input : (input?.url ?? String(input));
    const u = new URL(raw);
    let body: any = null;
    if (init?.body) {
      try { body = JSON.parse(String(init.body)); } catch { body = String(init.body); }
    }
    const call: Call = {
      method: (init?.method ?? "GET").toUpperCase(),
      path: u.pathname,
      query: u.search,
      body,
    };
    calls.push(call);
    lifetimeCalls += 1;
    const payload = respond(call);
    if (payload instanceof Response) return payload;
    return new Response(JSON.stringify(payload ?? []), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function realClient(respond: Responder = () => []) {
  return createClient(SUPA_URL, SUPA_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: makeRecordingFetch(respond) },
  });
}

function callsTo(table: string, method: string): Call[] {
  return calls.filter((c) => c.path === `/rest/v1/${table}` && c.method === method);
}

/** The row PostgREST would hand back from `insert(...).select('*').single()`. */
const INSERTED_ROW = {
  id:            NOTIF_ID,
  user_id:       USER_ID,
  category:      "trips",
  event_type:    "trip.invite_received",
  priority:      "normal",
  title:         "Trip invitation",
  body:          "You were invited",
  action_url:    null,
  image_url:     null,
  source_type:   "trip",
  source_id:     "trip-1",
  actor_id:      null,
  metadata:      {},
  privacy_level: "standard",
  read_at:       null,
  dismissed_at:  null,
  expires_at:    null,
  created_at:    new Date().toISOString(),
};

/** Health-path answers for everything the create+route pipeline reads. */
function healthyResponder(c: Call): unknown {
  if (c.method === "POST" && c.path === "/rest/v1/notifications") return INSERTED_ROW;
  if (c.method === "POST" && c.path === "/rest/v1/notification_delivery_attempts") {
    return { id: "attempt-1" };
  }
  if (c.path === "/rest/v1/feature_flags") return [{ flag: "push_notifications_enabled", enabled: true }];
  return [];
}

const BASE_NOTIF: NotificationRow = {
  id:           NOTIF_ID,
  userId:       USER_ID,
  category:     "safety",           // maps to the Compass level that skips extra DB gates
  eventType:    "safe_return.missed",
  priority:     "urgent",
  title:        "Check in",
  body:         "You missed a check-in",
  actionUrl:    null,
  imageUrl:     null,
  sourceType:   null,
  sourceId:     null,
  actorId:      null,
  metadata:     {},
  privacyLevel: "standard",
  readAt:       null,
  dismissedAt:  null,
  expiresAt:    null,
  createdAt:    new Date().toISOString(),
};

beforeEach(() => {
  calls = [];
  _resetCleanupFailureCount();
  // Expo is a different host with a different fetch; keep it out of the count.
  _setTestFetch((async (_u: any, init: any) => {
    const messages: Array<{ to: string }> = JSON.parse((init as any).body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: messages.map(() => ({ status: "ok", id: "t1" })) }),
    } as any;
  }) as any);
});

afterEach(() => { _setTestFetch(null); });

describe("NotificationService.create — the notification row is actually POSTed", () => {
  it("issues exactly one POST to /rest/v1/notifications, carrying the row", async () => {
    const sc = realClient(healthyResponder);
    const row = await new NotificationService(sc as any).create({
      userId:     USER_ID,
      eventType:  "trip.invite_received",
      params:     { actor: "Mara", tripName: "Lisbon" },
      sourceType: "trip",
      sourceId:   "trip-1",
    });

    const inserts = callsTo("notifications", "POST");
    assert.equal(inserts.length, 1, `expected one notifications INSERT, got ${inserts.length}`);
    assert.equal(inserts[0]!.body.user_id, USER_ID);
    assert.equal(inserts[0]!.body.event_type, "trip.invite_received");
    assert.ok(inserts[0]!.body.title, "a title must be persisted");
    assert.ok(row, "create() must return the persisted row");
    assert.equal(row!.id, NOTIF_ID);

    // Non-zero traffic overall: the dedupe read happened too.
    assert.ok(calls.length >= 2, `expected the dedupe read AND the insert; saw ${calls.length}`);
  });

  it("performs the dedupe LOOKUP as a real request before inserting", async () => {
    const sc = realClient(healthyResponder);
    await new NotificationService(sc as any).create({
      userId:     USER_ID,
      eventType:  "trip.invite_received",
      params:     {},
      sourceType: "trip",
      sourceId:   "trip-1",
    });
    const reads = callsTo("notifications", "GET");
    assert.ok(reads.length >= 1, "the dedupe check must actually query the table");
    assert.ok(
      reads[0]!.query.includes("event_type=eq.trip.invite_received"),
      `dedupe must key on event_type; query was ${reads[0]!.query}`,
    );
    assert.ok(reads[0]!.query.includes("source_id=eq.trip-1"), "dedupe must key on source_id");
    // Ordering: the read precedes the write.
    const readIdx   = calls.findIndex((c) => c.path === "/rest/v1/notifications" && c.method === "GET");
    const insertIdx = calls.findIndex((c) => c.path === "/rest/v1/notifications" && c.method === "POST");
    assert.ok(readIdx >= 0 && insertIdx > readIdx, "dedupe must run before the insert");
  });
});

describe("NotificationRouter.route — every channel decision reaches the ledger", () => {
  it("POSTs a delivery attempt for in_app, push, email and sms", async () => {
    const sc = realClient(healthyResponder);
    await new NotificationRouter(sc as any).route(BASE_NOTIF);

    const attempts = callsTo("notification_delivery_attempts", "POST");
    assert.ok(attempts.length >= 4, `expected at least 4 delivery attempts, got ${attempts.length}`);

    const channels = new Set(attempts.map((a) => a.body.channel));
    for (const ch of ["in_app", "push", "email", "sms"]) {
      assert.ok(channels.has(ch), `no delivery attempt was written for channel '${ch}'`);
    }
    for (const a of attempts) {
      assert.equal(a.body.notification_id, NOTIF_ID);
      assert.equal(a.body.user_id, USER_ID);
    }
  });

  it("reads preferences and push tokens over the wire before deciding", async () => {
    const sc = realClient(healthyResponder);
    await new NotificationRouter(sc as any).route(BASE_NOTIF);

    assert.ok(callsTo("notification_preferences", "GET").length >= 1, "global preferences must be read");
    assert.ok(callsTo("notification_category_preferences", "GET").length >= 1, "category preferences must be read");
    assert.ok(callsTo("notification_devices", "GET").length >= 1, "push tokens must be read");
  });
});

describe("NotificationPreferenceService — preference writes are issued", () => {
  it("POSTs the category preference upsert", async () => {
    const sc = realClient((c) => {
      if (c.method === "POST") return [{ user_id: USER_ID, category: "trips" }];
      return [];
    });
    await new NotificationPreferenceService(sc as any)
      .upsertCategoryPreferences(USER_ID, "trips" as any, { pushEnabled: false });

    const writes = callsTo("notification_category_preferences", "POST");
    assert.equal(writes.length, 1, "the category preference upsert must issue exactly one request");
    assert.equal(writes[0]!.body.user_id, USER_ID);
    assert.equal(writes[0]!.body.push_enabled, false);
  });

  it("POSTs the global preference upsert and returns the stored row", async () => {
    const sc = realClient((c) => {
      if (c.method === "POST") return { user_id: USER_ID, push_enabled: false, timezone: "Europe/Lisbon" };
      return [];
    });
    const prefs = await new NotificationPreferenceService(sc as any)
      .upsertPreferences(USER_ID, { pushEnabled: false, timezone: "Europe/Lisbon" });

    assert.equal(callsTo("notification_preferences", "POST").length, 1);
    assert.equal(prefs.pushEnabled, false);
    assert.equal(prefs.timezone, "Europe/Lisbon");
  });
});

describe("RealtimeActivityService — the unread count is a real query", () => {
  it("issues a HEAD count request and emits the count it was given", async () => {
    const { activityBus } = await import("../services/notifications/RealtimeActivityService.js");
    const seen: any[] = [];
    const unsub = activityBus.subscribe((e) => { if (e.type === "unread_count.updated") seen.push(e); });
    try {
      const sc = realClient(() => new Response(null, {
        status: 200,
        headers: { "content-range": "*/7", "content-type": "application/json" },
      }));
      await new RealtimeActivityService(sc as any).emitUnreadUpdate(USER_ID);

      const counts = calls.filter((c) => c.path === "/rest/v1/notifications");
      assert.ok(counts.length >= 1, "the unread count must be queried over the wire");
      assert.equal(seen.length, 1, "exactly one unread_count.updated must be emitted");
      assert.equal(seen[0].payload.unreadCount, 7, "the emitted count must be the one PostgREST returned");
    } finally { unsub(); }
  });
});

describe("VACUITY GUARD", () => {
  it("the recorder observed real traffic — every count above is measured, not assumed", () => {
    assert.ok(
      lifetimeCalls > 10,
      `the fetch recorder saw ${lifetimeCalls} requests across this file; a near-zero ` +
      `number means the harness stopped observing and every assertion above is vacuous`,
    );
  });
});
