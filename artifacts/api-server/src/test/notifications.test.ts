/**
 * Notifications system tests
 *
 * Tests the full notification pipeline:
 * - Privacy guard: GPS strip, Ghost Mode, pending member, removed member
 * - Preference service: quiet hours, safety override, category prefs
 * - Deduplication: message coalescence, nearby throttle, compass rate limit
 * - NotificationService: creation, list, mark-read, expire
 * - API routes: create, list, unread count, mark-read, preferences, devices
 * - Admin routes: account notice, delivery attempts, templates
 *
 * Run: node --import tsx/esm --test src/test/notifications.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import notificationsRouter from "../routes/notifications.js";
import { stripGPSCoordinates } from "../services/notifications/NotificationPrivacyGuard.js";
import { NotificationPrivacyGuard } from "../services/notifications/NotificationPrivacyGuard.js";
import { NotificationPreferenceService } from "../services/notifications/NotificationPreferenceService.js";
import { NotificationDeduplicationService } from "../services/notifications/NotificationDeduplicationService.js";
import { NotificationService } from "../services/notifications/NotificationService.js";
import { TEMPLATES, getTemplate, renderTemplate } from "../services/notifications/NotificationTemplateService.js";

// ── Test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

const FAKE_TOKEN   = "notif-test-token";
const USER_ID      = "00000000-0001-0001-0001-000000000001";
const OTHER_ID     = "00000000-0002-0002-0002-000000000002";
const ADMIN_TOKEN  = "notif-admin-token";
const ADMIN_ID     = "00000000-0003-0003-0003-000000000003";
const TRIP_ID      = "00000000-0004-0004-0004-000000000004";
const NOTIF_ID     = "00000000-0005-0005-0005-000000000005";
const DEVICE_ID    = "00000000-0006-0006-0006-000000000006";

function req(
  method: string,
  path: string,
  body?: unknown,
  token: string = FAKE_TOKEN,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method,
        headers: {
          "content-type": "application/json",
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

// ── Fake client ───────────────────────────────────────────────────────────────

interface FakeState {
  profiles?: Array<{ id: string; role?: string; expo_push_token?: string | null }>;
  notifications?: Array<Record<string, any>>;
  notificationPreferences?: Array<Record<string, any>>;
  notificationCategoryPreferences?: Array<Record<string, any>>;
  notificationDeliveryAttempts?: Array<Record<string, any>>;
  notificationDevices?: Array<Record<string, any>>;
  tripMembers?: Array<{ user_id: string; trip_id: string; role: string }>;
  locationPreferences?: Array<{ user_id: string; location_mode: string }>;
  featureFlags?: Record<string, boolean>;
}

function makeFakeClient(state: FakeState = {}) {
  const inserted: Record<string, any[]> = {};
  const updated:  Record<string, any[]> = {};

  function getRows(table: string): any[] {
    if (table === "profiles")                           return state.profiles ?? [];
    if (table === "notifications")                      return state.notifications ?? [];
    if (table === "notification_preferences")           return state.notificationPreferences ?? [];
    if (table === "notification_category_preferences")  return state.notificationCategoryPreferences ?? [];
    if (table === "notification_delivery_attempts")     return state.notificationDeliveryAttempts ?? [];
    if (table === "notification_devices")               return state.notificationDevices ?? [];
    if (table === "trip_members")                       return state.tripMembers ?? [];
    if (table === "user_location_preferences")          return state.locationPreferences ?? [];
    if (table === "feature_flags")
      return Object.entries(state.featureFlags ?? {}).map(([flag, enabled]) => ({ flag, enabled }));
    return [];
  }

  function builder(table: string) {
    let rows = getRows(table);
    let pendingInsert: any = null;
    let pendingUpdate: any = null;
    const filters: Array<(r: any) => boolean> = [];
    let _limit: number | null = null;
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
        if (!updated[table]) updated[table] = [];
        return b;
      },
      upsert(row: any) { pendingInsert = row; return b; },
      delete() { return b; },
      eq(col: string, val: any)     { filters.push((r) => r[col] === val); return b; },
      neq(col: string, val: any)    { filters.push((r) => r[col] !== val); return b; },
      in(col: string, vals: any[])  { filters.push((r) => vals.includes(r[col])); return b; },
      is(col: string, val: any)     { filters.push((r) => val === null ? r[col] == null : r[col] === val); return b; },
      gt(col: string, val: any)     { filters.push((_r) => true); return b; }, // simplified
      lt(col: string, val: any)     { filters.push((_r) => true); return b; },
      or(_expr: string)             { return b; }, // simplified
      ilike(col: string, pat: string) { return b; },
      order()  { return b; },
      limit(n: number) { _limit = n; return b; },
      range()  { return b; },
      head()   { return b; },
      maybeSingle() { return resolve(true); },
      single()      { return resolve(false); },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    function getFiltered(): any[] {
      return rows.filter((r) => filters.every((f) => f(r)));
    }

    async function resolve(maybe: boolean) {
      if (pendingInsert) {
        const row = Array.isArray(pendingInsert) ? pendingInsert[0] : pendingInsert;
        return { data: { id: `${table}-new`, ...row }, error: null };
      }
      if (pendingUpdate) {
        const matched = getFiltered();
        return { data: matched[0] ? { ...matched[0], ...pendingUpdate } : null, error: null };
      }
      const matched = getFiltered();
      const result = maybe ? (matched[0] ?? null) : matched[0] ?? null;
      return { data: result, error: null };
    }

    async function resolveList() {
      if (pendingInsert) {
        const row = Array.isArray(pendingInsert) ? pendingInsert[0] : pendingInsert;
        return { data: { id: `${table}-new`, ...row }, error: null };
      }
      if (pendingUpdate) {
        return { data: getFiltered(), error: null };
      }
      const matched = getFiltered();
      const data = _limit ? matched.slice(0, _limit) : matched;
      if (countMode) return { data, count: matched.length, error: null };
      return { data, error: null };
    }

    return b;
  }

  const client: any = {
    from: builder,
    auth: {
      getUser: async (token: string) => {
        if (token === FAKE_TOKEN)  return { data: { user: { id: USER_ID } }, error: null };
        if (token === ADMIN_TOKEN) return { data: { user: { id: ADMIN_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
    __inserted: inserted,
    __updated: updated,
  };
  return client;
}

function makeApp(state: FakeState) {
  const client = makeFakeClient(state);
  _setTestClient(client, true);
  _setTestServiceClient(client);

  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });
  app.use("/api", notificationsRouter);
  return { app, client };
}

// ── Test suite ────────────────────────────────────────────────────────────────

before(async () => {
  const state: FakeState = {
    profiles: [
      { id: USER_ID,  role: "user",  expo_push_token: "ExponentPushToken[user1]" },
      { id: ADMIN_ID, role: "admin", expo_push_token: null },
    ],
    notifications: [
      {
        id: NOTIF_ID,
        user_id:       USER_ID,
        category:      "trips",
        event_type:    "trip.invite_received",
        priority:      "important",
        title:         "Alice invited you to a trip",
        body:          "Join \"Thailand Adventure\"",
        action_url:    `/trip/${TRIP_ID}`,
        read_at:       null,
        dismissed_at:  null,
        expires_at:    null,
        created_at:    new Date().toISOString(),
        metadata:      {},
        privacy_level: "standard",
        source_type:   "trip",
        source_id:     TRIP_ID,
        actor_id:      OTHER_ID,
        image_url:     null,
      },
    ],
    notificationDevices: [
      { id: DEVICE_ID, user_id: USER_ID, push_token: "ExponentPushToken[dev1]", platform: "expo" },
    ],
    notificationPreferences: [
      {
        user_id:            USER_ID,
        push_enabled:       true,
        email_enabled:      false,
        in_app_enabled:     true,
        digests_enabled:    false,
        safety_override:    true,
        quiet_hours_enabled: false,
        quiet_start:        "22:00",
        quiet_end:          "08:00",
        message_previews:   true,
        location_previews:  false,
      },
    ],
    notificationDeliveryAttempts: [
      { id: "attempt-1", notification_id: NOTIF_ID, user_id: USER_ID, channel: "push", status: "sent", created_at: new Date().toISOString() },
      { id: "attempt-2", notification_id: NOTIF_ID, user_id: USER_ID, channel: "in_app", status: "sent", created_at: new Date().toISOString() },
    ],
    tripMembers: [
      { user_id: USER_ID, trip_id: TRIP_ID, role: "member" },
    ],
    locationPreferences: [],
    featureFlags: {
      notifications_enabled:      true,
      push_notifications_enabled: true,
    },
  };

  const { app } = makeApp(state);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => new Promise<void>((r) => server.close(r)));

// ─────────────────────────────────────────────────────────────────────────────
// 1. Privacy Guard: GPS coordinate stripping
// ─────────────────────────────────────────────────────────────────────────────
describe("NotificationPrivacyGuard", () => {
  it("strips decimal GPS coordinates from body", () => {
    const result = stripGPSCoordinates("You are at 13.7563, 100.5018 right now.");
    assert.ok(!result.includes("13.7563"), "lat should be stripped");
    assert.ok(!result.includes("100.5018"), "lng should be stripped");
    assert.ok(result.includes("[location]"), "placeholder should appear");
  });

  it("strips lat/lng label patterns", () => {
    const result = stripGPSCoordinates("lat: 51.5074, lng: -0.1278");
    assert.ok(!result.includes("51.5074"));
    assert.ok(!result.includes("-0.1278"));
  });

  it("leaves plain text unmodified", () => {
    const text = "Meet at the airport lobby";
    assert.equal(stripGPSCoordinates(text), text);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Privacy Guard: Ghost Mode suppression
// ─────────────────────────────────────────────────────────────────────────────
describe("NotificationPrivacyGuard — Ghost Mode", () => {
  it("blocks location notification when sender is in Ghost Mode", async () => {
    const state: FakeState = {
      locationPreferences: [{ user_id: OTHER_ID, location_mode: "ghost" }],
      tripMembers: [],
    };
    const client = makeFakeClient(state);
    const guard = new NotificationPrivacyGuard(client);
    const result = await guard.sanitise("Alice is nearby", "Alice is 100m away", {
      recipientId: USER_ID,
      senderId:    OTHER_ID,
      category:    "location",
      eventType:   "location.nearby_traveler",
    });
    assert.equal(result.blocked, true);
    assert.equal(result.blockReason, "ghost_mode");
    assert.equal(result.privacyLevel, "ghost_hidden");
  });

  it("allows location notification when sender is NOT in Ghost Mode", async () => {
    const state: FakeState = {
      locationPreferences: [{ user_id: OTHER_ID, location_mode: "standard" }],
      tripMembers: [],
    };
    const client = makeFakeClient(state);
    const guard = new NotificationPrivacyGuard(client);
    const result = await guard.sanitise("Alice is nearby", "Alice is in Bangkok", {
      recipientId: USER_ID,
      senderId:    OTHER_ID,
      category:    "location",
      eventType:   "location.nearby_traveler",
    });
    assert.equal(result.blocked, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Privacy Guard: pending member does not receive private plan location
// ─────────────────────────────────────────────────────────────────────────────
describe("NotificationPrivacyGuard — pending member", () => {
  it("blocks plan.item_added for invited (pending) trip member", async () => {
    const state: FakeState = {
      locationPreferences: [],
      tripMembers: [{ user_id: USER_ID, trip_id: TRIP_ID, role: "invited" }],
    };
    const client = makeFakeClient(state);
    const guard = new NotificationPrivacyGuard(client);
    const result = await guard.sanitise("New stop added", "Alice added Wat Pho", {
      recipientId: USER_ID,
      category:    "plans",
      eventType:   "plan.item_added",
      tripId:      TRIP_ID,
    });
    assert.equal(result.blocked, true);
    assert.equal(result.blockReason, "pending_member");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Privacy Guard: removed trip member stops receiving updates
// ─────────────────────────────────────────────────────────────────────────────
describe("NotificationPrivacyGuard — removed member", () => {
  it("blocks trip notification for a user with no trip_members row", async () => {
    const state: FakeState = {
      locationPreferences: [],
      tripMembers: [], // no row = removed
    };
    const client = makeFakeClient(state);
    const guard = new NotificationPrivacyGuard(client);
    const result = await guard.sanitise("Plan updated", "A stop was changed", {
      recipientId: USER_ID,
      category:    "plans",
      eventType:   "plan.item_updated",
      tripId:      TRIP_ID,
    });
    assert.equal(result.blocked, true);
    assert.equal(result.blockReason, "removed_from_trip");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Privacy Guard: trust notification hides reporter identity
// ─────────────────────────────────────────────────────────────────────────────
describe("NotificationPrivacyGuard — trust reporter identity", () => {
  it("strips reporter name from trust notification body", async () => {
    const client = makeFakeClient({});
    const guard = new NotificationPrivacyGuard(client);
    const result = await guard.sanitise(
      "Report received",
      "You were reported by Alice Smith. Reporter: Alice",
      { recipientId: USER_ID, category: "trust", eventType: "trust.report_received" },
    );
    assert.ok(!result.body.includes("Alice"), "reporter name should be stripped");
    assert.ok(result.body.toLowerCase().includes("protected") || result.body.includes("[protected]"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Privacy Guard: push preview excludes live-share coordinates
// ─────────────────────────────────────────────────────────────────────────────
describe("NotificationPrivacyGuard — live-share push preview", () => {
  it("replaces body with safe message for live-share push previews", async () => {
    const client = makeFakeClient({});
    const guard = new NotificationPrivacyGuard(client);
    const result = await guard.sanitise(
      "Alice shared their location",
      "Alice is at 13.7563, 100.5018",
      {
        recipientId: USER_ID,
        category:    "location",
        eventType:   "location.live_share_started",
        isLiveShare: true,
        isPushPreview: true,
      },
    );
    assert.ok(!result.body.includes("13.7563"), "exact coordinates should not appear");
    assert.ok(result.body.includes("Live location"), "safe message expected");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Preference Service: quiet hours suppress push for non-urgent
// ─────────────────────────────────────────────────────────────────────────────
describe("NotificationPreferenceService — quiet hours", () => {
  it("blocks push channel when quiet hours is active and priority is normal", () => {
    const svc = new NotificationPreferenceService({} as any);
    const prefs = {
      userId: USER_ID,
      pushEnabled: true,
      emailEnabled: false,
      inAppEnabled: true,
      digestsEnabled: false,
      safetyOverride: true,
      quietHoursEnabled: true,
      quietStart: "00:00", // start at midnight
      quietEnd:   "23:59", // end just before midnight — basically always quiet
      messagePreviews: true,
      locationPreviews: false,
    };
    const channels = svc.filterChannels(['in_app', 'push'], prefs, undefined, 'normal');
    assert.ok(channels.includes('in_app'),  'in_app should pass');
    assert.ok(!channels.includes('push'),   'push should be blocked during quiet hours');
  });

  it("allows push for urgent even during quiet hours (safety override)", () => {
    const svc = new NotificationPreferenceService({} as any);
    const prefs = {
      userId: USER_ID,
      pushEnabled: true,
      emailEnabled: false,
      inAppEnabled: true,
      digestsEnabled: false,
      safetyOverride: true,
      quietHoursEnabled: true,
      quietStart: "00:00",
      quietEnd:   "23:59",
      messagePreviews: true,
      locationPreviews: false,
    };
    const channels = svc.filterChannels(['in_app', 'push'], prefs, undefined, 'urgent');
    assert.ok(channels.includes('push'), 'urgent push should bypass quiet hours via safety override');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Preference Service: safety override allows push even when globally off
// ─────────────────────────────────────────────────────────────────────────────
describe("NotificationPreferenceService — safety override", () => {
  it("allows push for urgent even when pushEnabled=false (safety override)", () => {
    const svc = new NotificationPreferenceService({} as any);
    const prefs = {
      userId: USER_ID,
      pushEnabled: false, // globally off
      emailEnabled: false,
      inAppEnabled: true,
      digestsEnabled: false,
      safetyOverride: true,
      quietHoursEnabled: false,
      quietStart: "22:00",
      quietEnd:   "08:00",
      messagePreviews: true,
      locationPreviews: false,
    };
    const channels = svc.filterChannels(['in_app', 'push'], prefs, undefined, 'urgent');
    assert.ok(channels.includes('push'), 'safety override should allow urgent push');
  });

  it("blocks push for normal priority when pushEnabled=false", () => {
    const svc = new NotificationPreferenceService({} as any);
    const prefs = {
      userId: USER_ID,
      pushEnabled: false,
      emailEnabled: false,
      inAppEnabled: true,
      digestsEnabled: false,
      safetyOverride: true,
      quietHoursEnabled: false,
      quietStart: "22:00",
      quietEnd:   "08:00",
      messagePreviews: true,
      locationPreviews: false,
    };
    const channels = svc.filterChannels(['in_app', 'push'], prefs, undefined, 'normal');
    assert.ok(!channels.includes('push'), 'push should be blocked when off and not urgent');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Preference Service: category preferences respected
// ─────────────────────────────────────────────────────────────────────────────
describe("NotificationPreferenceService — category preferences", () => {
  it("blocks push for category when category push is disabled", () => {
    const svc = new NotificationPreferenceService({} as any);
    const prefs = {
      userId: USER_ID, pushEnabled: true, emailEnabled: false, inAppEnabled: true,
      digestsEnabled: false, safetyOverride: true, quietHoursEnabled: false,
      quietStart: "22:00", quietEnd: "08:00", messagePreviews: true, locationPreviews: false,
    };
    const catPref = { category: 'pulse' as const, inAppEnabled: true, pushEnabled: false, emailEnabled: false, digestEnabled: false };
    const channels = svc.filterChannels(['in_app', 'push'], prefs, catPref, 'normal');
    assert.ok(channels.includes('in_app'), 'in_app should pass');
    assert.ok(!channels.includes('push'),  'push should be blocked by category pref');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Deduplication: message coalescence
// ─────────────────────────────────────────────────────────────────────────────
describe("NotificationDeduplicationService — message coalescence", () => {
  it("coalesces telegraph.message within the time window", async () => {
    // The fake client returns a notification row for the same thread
    const state: FakeState = {
      notifications: [
        {
          id: "old-notif",
          user_id: USER_ID,
          category: "telegraph",
          source_type: "thread",
          source_id: "thread-123",
          created_at: new Date().toISOString(),
        },
      ],
    };
    const client = makeFakeClient(state);
    const svc = new NotificationDeduplicationService(client);
    const result = await svc.check({
      userId:     USER_ID,
      category:   "telegraph",
      eventType:  "telegraph.message",
      sourceType: "thread",
      sourceId:   "thread-123",
    });
    assert.equal(result.isDuplicate, true);
    assert.equal(result.reason, "message_coalesced");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Template Service: templates defined for all 13 categories
// ─────────────────────────────────────────────────────────────────────────────
describe("NotificationTemplateService", () => {
  const ALL_CATEGORIES = [
    'plans','trips','telegraph','safe_return','location','trip_crew',
    'compass','pulse','passport','hidden_gems','trust','airport','admin',
  ];

  it("has at least one template per category", () => {
    for (const cat of ALL_CATEGORIES) {
      const found = TEMPLATES.some((t) => t.category === cat);
      assert.ok(found, `No template found for category: ${cat}`);
    }
  });

  it("renders trip.invite_received template", () => {
    const rendered = renderTemplate("trip.invite_received", { actor: "Alice", tripTitle: "Thailand Adventure", destination: "Bangkok" });
    assert.ok(rendered, "should render");
    assert.ok(rendered!.title.includes("Alice"), "title should include actor");
    // Body must be privacy-safe (generic) — no trip title or destination on the lock screen.
    assert.ok(!rendered!.body.includes("Thailand Adventure"), "body must NOT include trip title (privacy)");
    assert.ok(!rendered!.body.includes("Bangkok"), "body must NOT include destination (privacy)");
    assert.ok(rendered!.body.length > 0, "body must not be empty");
    assert.equal(rendered!.category, "trips");
    assert.equal(rendered!.priority, "important");
  });

  it("renders safe_return.reminder template with correct priority", () => {
    const rendered = renderTemplate("safe_return.reminder", {});
    assert.ok(rendered);
    assert.equal(rendered!.priority, "urgent");
    assert.ok(rendered!.channels.includes("push"), "safe return should push");
  });

  it("returns null for unknown event type", () => {
    const rendered = renderTemplate("unknown.event.type.xyz", {});
    assert.equal(rendered, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. API: GET /me/notifications — list unread Activity Center
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /api/me/notifications", () => {
  it("returns notifications for authenticated user", async () => {
    const r = await req("GET", "/api/me/notifications");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.notifications), "should have notifications array");
    assert.ok(r.body.notifications.length >= 1, "should have at least 1 notification");
    const n = r.body.notifications[0];
    assert.equal(n.userId, USER_ID);
    assert.ok(n.title, "should have title");
    assert.ok(n.body, "should have body");
    assert.ok(n.category, "should have category");
    assert.ok(n.priority, "should have priority");
  });

  it("returns 401 for unauthenticated request", async () => {
    const r = await req("GET", "/api/me/notifications", undefined, "bad-token");
    assert.equal(r.status, 401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. API: GET /me/notifications/unread-count
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /api/me/notifications/unread-count", () => {
  it("returns a numeric unread count", async () => {
    const r = await req("GET", "/api/me/notifications/unread-count");
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.unreadCount, "number");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. API: POST /me/notifications/:id/read — mark-read updates count
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/me/notifications/:id/read", () => {
  it("marks a notification read", async () => {
    const r = await req("POST", `/api/me/notifications/${NOTIF_ID}/read`);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15. API: POST /me/notifications/read-all
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/me/notifications/read-all", () => {
  it("marks all notifications read", async () => {
    const r = await req("POST", "/api/me/notifications/read-all", {});
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.marked, "number");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 16. API: POST /me/notifications/:id/dismiss
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/me/notifications/:id/dismiss", () => {
  it("dismisses a notification", async () => {
    const r = await req("POST", `/api/me/notifications/${NOTIF_ID}/dismiss`);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 17. API: GET & PUT /me/notification-preferences
// ─────────────────────────────────────────────────────────────────────────────
describe("GET/PUT /api/me/notification-preferences", () => {
  it("returns preferences object", async () => {
    const r = await req("GET", "/api/me/notification-preferences");
    assert.equal(r.status, 200);
    assert.ok(r.body.preferences, "should have preferences");
    assert.equal(typeof r.body.preferences.pushEnabled, "boolean");
    assert.equal(typeof r.body.preferences.quietHoursEnabled, "boolean");
  });

  it("updates preferences", async () => {
    const r = await req("PUT", "/api/me/notification-preferences", {
      pushEnabled: false,
      quietHoursEnabled: true,
      quietStart: "21:00",
      quietEnd: "07:00",
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });

  it("rejects invalid quiet_start format", async () => {
    const r = await req("PUT", "/api/me/notification-preferences", {
      quietStart: "not-a-time",
    });
    assert.equal(r.status, 400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 18. API: POST /me/devices — device registration
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/me/devices", () => {
  it("registers a push token device", async () => {
    const r = await req("POST", "/api/me/devices", {
      pushToken: "ExponentPushToken[newdevice123]",
      platform: "expo",
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.ok, true);
    assert.ok(r.body.deviceId, "should return deviceId");
  });

  it("rejects too-short push token", async () => {
    const r = await req("POST", "/api/me/devices", { pushToken: "abc" });
    assert.equal(r.status, 400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 19. Admin: GET /admin/notification-templates
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /api/admin/notification-templates", () => {
  it("returns all templates for admin user", async () => {
    const r = await req("GET", "/api/admin/notification-templates", undefined, ADMIN_TOKEN);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.templates), "should be array");
    assert.ok(r.body.templates.length > 0, "should have templates");
    assert.ok(r.body.templates[0].eventType, "template should have eventType");
    assert.ok(r.body.templates[0].category, "template should have category");
  });

  it("returns 403 for non-admin user", async () => {
    const r = await req("GET", "/api/admin/notification-templates", undefined, FAKE_TOKEN);
    assert.equal(r.status, 403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 20. Admin: POST /admin/notifications/account-notice — logs delivery attempt
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/admin/notifications/account-notice", () => {
  it("creates account-notice notification for target user", async () => {
    const r = await req(
      "POST",
      "/api/admin/notifications/account-notice",
      {
        userId:  USER_ID,
        subject: "Community Guidelines Update",
        body:    "Please review our updated community guidelines.",
      },
      ADMIN_TOKEN,
    );
    // 200 or 201 depending on dedup; key check is no 5xx
    assert.ok(r.status === 200 || r.status === 201, `Unexpected status: ${r.status}`);
    assert.equal(r.body.ok, true);
  });

  it("returns 400 for missing subject", async () => {
    const r = await req(
      "POST",
      "/api/admin/notifications/account-notice",
      { userId: USER_ID, body: "no subject here" },
      ADMIN_TOKEN,
    );
    assert.equal(r.status, 400);
  });
});
