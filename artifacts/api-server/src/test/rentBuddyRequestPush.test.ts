/**
 * Rent-a-Buddy request push notification tests
 *
 * Verifies that posting an open buddy request actually dispatches Expo push
 * notifications to eligible buddies, and that token capture/cleanup works:
 *
 *   1. notifyEligibleBuddies — pushes to tokens on rent_buddy_profiles
 *   2. notifyEligibleBuddies — falls back to legacy profiles.expo_push_token
 *   3. notifyEligibleBuddies — excludes the requesting traveler
 *   4. notifyEligibleBuddies — clears stale tokens on DeviceNotRegistered
 *   5. notifyEligibleBuddies — no push call when no tokens exist
 *   6. POST /api/me/devices — expo token backfilled onto rent_buddy_profiles
 *
 * Run: node --import tsx/esm --test src/test/rentBuddyRequestPush.test.ts
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestFetch } from "../lib/push.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { notifyEligibleBuddies } from "../routes/rentABuddyMarketplace.js";
import notificationsRouter from "../routes/notifications.js";

const FAKE_TOKEN  = "rbpush-user-token";
const TRAVELER_ID = "bb000000-0001-0001-0001-000000000001";
const BUDDY1_ID   = "bb000000-0002-0002-0002-000000000002";
const BUDDY2_ID   = "bb000000-0003-0003-0003-000000000003";
const TOKEN1 = "ExponentPushToken[buddy1token]";
const TOKEN2 = "ExponentPushToken[buddy2legacy]";

// ── Fake supabase client ───────────────────────────────────────────────────────

interface FakeState {
  rentBuddyProfiles?: Array<Record<string, any>>;
  profiles?: Array<Record<string, any>>;
  notificationDevices?: Array<Record<string, any>>;
  notificationPreferences?: Array<Record<string, any>>;
  notificationCategoryPreferences?: Array<Record<string, any>>;
  featureFlags?: Record<string, boolean>;
}

function makeFakeClient(state: FakeState = {}) {
  const updatePatches: Record<string, Array<{ patch: any; filters: any[] }>> = {};
  const inserted: Record<string, any[]> = {};
  const deletes: Record<string, Array<{ filters: any[] }>> = {};

  function getRows(table: string): any[] {
    if (table === "rent_buddy_profiles")   return state.rentBuddyProfiles ?? [];
    if (table === "profiles")              return state.profiles ?? [];
    if (table === "notification_devices")  return state.notificationDevices ?? [];
    if (table === "notification_preferences")          return state.notificationPreferences ?? [];
    if (table === "notification_category_preferences") return state.notificationCategoryPreferences ?? [];
    if (table === "feature_flags")
      // Default push_notifications_enabled=true so tests that don't set featureFlags
      // are not silently suppressed by the push kill-switch.
      return Object.entries({ push_notifications_enabled: true, ...(state.featureFlags ?? {}) })
        .map(([flag, enabled]) => ({ flag, enabled }));
    return [];
  }

  function builder(table: string) {
    const rows = getRows(table);
    let pendingInsert: any = null;
    let pendingUpdate: any = null;
    let pendingDelete = false;
    const filters: Array<(r: any) => boolean> = [];
    const filterLog: any[] = [];

    const b: any = {
      select() { return b; },
      insert(row: any) {
        pendingInsert = row;
        if (!inserted[table]) inserted[table] = [];
        inserted[table].push(row);
        return b;
      },
      update(patch: any) {
        pendingUpdate = patch;
        return b;
      },
      upsert(row: any) { pendingInsert = row; return b; },
      delete() { pendingDelete = true; return b; },
      eq(col: string, val: any)  { filters.push((r) => r[col] === val); filterLog.push(["eq", col, val]); return b; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); filterLog.push(["neq", col, val]); return b; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); filterLog.push(["in", col, vals]); return b; },
      contains(col: string, vals: any[]) {
        filters.push((r) => (vals as any[]).every((v) => ((r[col] ?? []) as any[]).includes(v)));
        return b;
      },
      is() { return b; }, gt() { return b; }, lt() { return b; }, or() { return b; },
      ilike() { return b; }, order() { return b; }, limit() { return b; }, range() { return b; },
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
        recordUpdate();
        const matched = getFiltered();
        return { data: matched[0] ? { ...matched[0], ...pendingUpdate } : null, error: null };
      }
      return { data: getFiltered()[0] ?? null, error: null };
    }

    function recordUpdate() {
      if (!updatePatches[table]) updatePatches[table] = [];
      updatePatches[table].push({ patch: pendingUpdate, filters: filterLog.slice() });
      // Apply the patch in-memory so later reads see it.
      for (const r of getFiltered()) Object.assign(r, pendingUpdate);
    }

    async function resolveList() {
      if (pendingInsert) {
        const row = Array.isArray(pendingInsert) ? pendingInsert[0] : pendingInsert;
        return { data: { id: `${table}-new`, ...row }, error: null };
      }
      if (pendingUpdate) {
        recordUpdate();
        return { data: getFiltered(), error: null };
      }
      if (pendingDelete) {
        if (!deletes[table]) deletes[table] = [];
        deletes[table].push({ filters: filterLog.slice() });
        return { data: [], error: null };
      }
      return { data: getFiltered(), error: null };
    }

    return b;
  }

  const client: any = {
    from: builder,
    auth: {
      getUser: async (token: string) => {
        if (token === FAKE_TOKEN) return { data: { user: { id: BUDDY1_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
    __updatePatches: updatePatches,
    __inserted: inserted,
    __deletes: deletes,
  };
  return client;
}

// ── Fake Expo fetch ────────────────────────────────────────────────────────────

let pushCalls: Array<{ url: string; messages: any[] }> = [];
let ticketFor: (to: string) => any = () => ({ status: "ok", id: "t" });

function fakeFetch(): typeof fetch {
  return (async (url: any, init: any) => {
    const messages = JSON.parse(init.body);
    pushCalls.push({ url: String(url), messages });
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: messages.map((m: any) => ticketFor(m.to)) }),
    } as any;
  }) as any;
}

before(() => { _setTestFetch(fakeFetch()); });
after(() => { _setTestFetch(null); _setTestClient(null, false); _setTestServiceClient(null); });
afterEach(() => { pushCalls = []; ticketFor = () => ({ status: "ok", id: "t" }); });

const REQUEST = {
  id: "req-1",
  traveler_id: TRAVELER_ID,
  city: "Lisbon",
  category: "nightlife",
};

function buddyRow(overrides: Record<string, any> = {}) {
  return {
    id: "bp-1",
    user_id: BUDDY1_ID,
    city: "Lisbon",
    status: "active",
    admin_status: "active",
    categories: ["nightlife"],
    expo_push_token: TOKEN1,
    ...overrides,
  };
}

// ── notifyEligibleBuddies ──────────────────────────────────────────────────────

describe("notifyEligibleBuddies", () => {
  it("sends a push to eligible buddies' tokens", async () => {
    const svc = makeFakeClient({ rentBuddyProfiles: [buddyRow()], profiles: [] });
    await notifyEligibleBuddies(svc, REQUEST);

    assert.equal(pushCalls.length, 1);
    const msgs = pushCalls[0].messages;
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].to, TOKEN1);
    assert.match(msgs[0].title, /Lisbon/);
    assert.equal(msgs[0].data.type, "rent_buddy_request");
    assert.equal(msgs[0].data.requestId, "req-1");

    // notified_buddy_ids recorded
    const reqPatches = svc.__updatePatches["rent_buddy_requests"] ?? [];
    assert.equal(reqPatches.length, 1);
    assert.deepEqual(reqPatches[0].patch.notified_buddy_ids, ["bp-1"]);
  });

  it("falls back to legacy profiles.expo_push_token when the buddy profile has none", async () => {
    const svc = makeFakeClient({
      rentBuddyProfiles: [buddyRow({ id: "bp-2", user_id: BUDDY2_ID, expo_push_token: null })],
      profiles: [{ id: BUDDY2_ID, expo_push_token: TOKEN2 }],
    });
    await notifyEligibleBuddies(svc, REQUEST);

    assert.equal(pushCalls.length, 1);
    assert.deepEqual(pushCalls[0].messages.map((m: any) => m.to), [TOKEN2]);
  });

  it("does not notify the requesting traveler even if they are a buddy", async () => {
    const svc = makeFakeClient({
      rentBuddyProfiles: [buddyRow({ id: "bp-self", user_id: TRAVELER_ID })],
      profiles: [],
    });
    await notifyEligibleBuddies(svc, REQUEST);
    assert.equal(pushCalls.length, 0);
  });

  it("clears stale tokens when Expo reports DeviceNotRegistered", async () => {
    ticketFor = (to) =>
      to === TOKEN1
        ? { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }
        : { status: "ok", id: "t" };

    const profiles = [{ id: BUDDY1_ID, expo_push_token: TOKEN1 }];
    const buddyProfiles = [buddyRow()];
    const notificationDevices = [{ id: "nd-1", user_id: BUDDY1_ID, push_token: TOKEN1 }];
    const svc = makeFakeClient({ rentBuddyProfiles: buddyProfiles, profiles, notificationDevices });
    await notifyEligibleBuddies(svc, REQUEST);

    // rent_buddy_profiles.expo_push_token nulled
    const rbPatches = svc.__updatePatches["rent_buddy_profiles"] ?? [];
    assert.ok(rbPatches.some((p: any) => p.patch.expo_push_token === null));
    // profiles.expo_push_token nulled
    const pPatches = svc.__updatePatches["profiles"] ?? [];
    assert.ok(pPatches.some((p: any) => p.patch.expo_push_token === null));
    assert.equal(buddyProfiles[0].expo_push_token, null);
    assert.equal(profiles[0].expo_push_token, null);
    // notification_devices rows for the dead token deleted
    const ndDeletes = svc.__deletes["notification_devices"] ?? [];
    assert.ok(
      ndDeletes.some((d: any) =>
        d.filters.some((f: any[]) => f[0] === "in" && f[1] === "push_token" && f[2].includes(TOKEN1)),
      ),
      "expected notification_devices delete filtered on the dead token",
    );
  });

  it("enqueues the push on the retry queue when Expo is temporarily down", async () => {
    // Expo returns a 5xx — sendPushNotification reports retryable: true.
    _setTestFetch((async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    })) as any);
    try {
      const svc = makeFakeClient({
        rentBuddyProfiles: [
          buddyRow(),
          buddyRow({ id: "bp-2", user_id: BUDDY2_ID, expo_push_token: null }),
        ],
        profiles: [{ id: BUDDY2_ID, expo_push_token: TOKEN2 }],
      });
      await notifyEligibleBuddies(svc, REQUEST);

      const rows = svc.__inserted["push_retry_queue"] ?? [];
      assert.equal(rows.length, 2, "one retry-queue row per buddy");

      const byUser = new Map(rows.map((r: any) => [r.user_id, r]));
      assert.deepEqual(byUser.get(BUDDY1_ID)?.tokens, [TOKEN1]);
      assert.deepEqual(byUser.get(BUDDY2_ID)?.tokens, [TOKEN2]);
      for (const row of rows) {
        assert.equal(row.status, "queued");
        assert.equal(row.payload.data.type, "rent_buddy_request");
        assert.equal(row.payload.data.requestId, "req-1");
      }
    } finally {
      _setTestFetch(fakeFetch());
    }
  });

  it("does not enqueue on the retry queue when the send succeeds", async () => {
    const svc = makeFakeClient({ rentBuddyProfiles: [buddyRow()], profiles: [] });
    await notifyEligibleBuddies(svc, REQUEST);
    assert.equal(pushCalls.length, 1);
    assert.equal((svc.__inserted["push_retry_queue"] ?? []).length, 0);
  });

  it("skips buddies who disabled the rent_buddy category push toggle", async () => {
    const svc = makeFakeClient({
      rentBuddyProfiles: [buddyRow()],
      profiles: [],
      notificationCategoryPreferences: [
        { user_id: BUDDY1_ID, category: "rent_buddy", in_app_enabled: true, push_enabled: false, email_enabled: false, digest_enabled: false },
      ],
    });
    await notifyEligibleBuddies(svc, REQUEST);
    assert.equal(pushCalls.length, 0);
    // No buddies recorded as notified either
    assert.equal((svc.__updatePatches["rent_buddy_requests"] ?? []).length, 0);
  });

  it("skips buddies who muted push globally", async () => {
    const svc = makeFakeClient({
      rentBuddyProfiles: [buddyRow()],
      profiles: [],
      notificationPreferences: [{ user_id: BUDDY1_ID, push_enabled: false }],
    });
    await notifyEligibleBuddies(svc, REQUEST);
    assert.equal(pushCalls.length, 0);
  });

  it("still notifies buddies who disabled a different category", async () => {
    const svc = makeFakeClient({
      rentBuddyProfiles: [buddyRow()],
      profiles: [],
      notificationCategoryPreferences: [
        { user_id: BUDDY1_ID, category: "pulse", in_app_enabled: true, push_enabled: false, email_enabled: false, digest_enabled: false },
      ],
    });
    await notifyEligibleBuddies(svc, REQUEST);
    assert.equal(pushCalls.length, 1);
  });

  it("only notifies opted-in buddies when preferences are mixed", async () => {
    const svc = makeFakeClient({
      rentBuddyProfiles: [
        buddyRow(),
        buddyRow({ id: "bp-2", user_id: BUDDY2_ID, expo_push_token: TOKEN2 }),
      ],
      profiles: [],
      notificationCategoryPreferences: [
        { user_id: BUDDY2_ID, category: "rent_buddy", in_app_enabled: true, push_enabled: false, email_enabled: false, digest_enabled: false },
      ],
    });
    await notifyEligibleBuddies(svc, REQUEST);
    assert.equal(pushCalls.length, 1);
    assert.deepEqual(pushCalls[0].messages.map((m: any) => m.to), [TOKEN1]);
    const reqPatches = svc.__updatePatches["rent_buddy_requests"] ?? [];
    assert.deepEqual(reqPatches[0].patch.notified_buddy_ids, ["bp-1"]);
  });

  it("skips buddies whose quiet hours cover the current time", async () => {
    // Build a window around "now" so the test is time-independent.
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const start = new Date(now.getTime() - 60 * 60 * 1000);
    const end = new Date(now.getTime() + 60 * 60 * 1000);
    const svc = makeFakeClient({
      rentBuddyProfiles: [buddyRow()],
      profiles: [],
      notificationPreferences: [{
        user_id: BUDDY1_ID,
        push_enabled: true,
        quiet_hours_enabled: true,
        quiet_start: `${pad(start.getHours())}:${pad(start.getMinutes())}`,
        quiet_end: `${pad(end.getHours())}:${pad(end.getMinutes())}`,
      }],
    });
    await notifyEligibleBuddies(svc, REQUEST);
    assert.equal(pushCalls.length, 0);
    assert.equal((svc.__updatePatches["rent_buddy_requests"] ?? []).length, 0);
  });

  it("still notifies buddies whose quiet hours do not cover the current time", async () => {
    // Window entirely outside "now": starts in 2 hours, ends in 3 hours.
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const start = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const end = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    const svc = makeFakeClient({
      rentBuddyProfiles: [buddyRow()],
      profiles: [],
      notificationPreferences: [{
        user_id: BUDDY1_ID,
        push_enabled: true,
        quiet_hours_enabled: true,
        quiet_start: `${pad(start.getHours())}:${pad(start.getMinutes())}`,
        quiet_end: `${pad(end.getHours())}:${pad(end.getMinutes())}`,
      }],
    });
    await notifyEligibleBuddies(svc, REQUEST);
    assert.equal(pushCalls.length, 1);
    assert.deepEqual(pushCalls[0].messages.map((m: any) => m.to), [TOKEN1]);
  });

  it("evaluates quiet hours in the buddy's own timezone, not server time", async () => {
    // Pick a timezone whose current wall clock differs from the server's by
    // several hours, then build a quiet window around the buddy's LOCAL now.
    // Under server-clock evaluation this window would NOT cover the moment.
    const now = new Date();
    const serverMins = now.getHours() * 60 + now.getMinutes();
    const candidates = ["Pacific/Kiritimati", "Pacific/Honolulu", "Asia/Tokyo", "Europe/Lisbon", "America/Anchorage"];
    let tz = "";
    let localMins = 0;
    for (const c of candidates) {
      const parts = new Intl.DateTimeFormat("en-GB", { timeZone: c, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
      const h = Number(parts.find((p) => p.type === "hour")!.value);
      const m = Number(parts.find((p) => p.type === "minute")!.value);
      const mins = h * 60 + m;
      const diff = Math.min(Math.abs(mins - serverMins), 1440 - Math.abs(mins - serverMins));
      if (diff >= 180) { tz = c; localMins = mins; break; }
    }
    assert.ok(tz, "expected a candidate timezone ≥3h from server time");

    const pad = (n: number) => String(n).padStart(2, "0");
    const fmt = (mins: number) => {
      const m = ((mins % 1440) + 1440) % 1440;
      return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
    };
    const quietStart = fmt(localMins - 60);
    const quietEnd = fmt(localMins + 60);

    // 1. Window covers the buddy's local now → suppressed (would NOT be
    //    suppressed under server-clock evaluation).
    const svc = makeFakeClient({
      rentBuddyProfiles: [buddyRow()],
      profiles: [],
      notificationPreferences: [{
        user_id: BUDDY1_ID,
        push_enabled: true,
        quiet_hours_enabled: true,
        quiet_start: quietStart,
        quiet_end: quietEnd,
        timezone: tz,
      }],
    });
    await notifyEligibleBuddies(svc, REQUEST);
    assert.equal(pushCalls.length, 0, `expected suppression in ${tz}`);

    // 2. Same window but no timezone stored → falls back to server time,
    //    where the window does not cover now → push goes out.
    const svc2 = makeFakeClient({
      rentBuddyProfiles: [buddyRow()],
      profiles: [],
      notificationPreferences: [{
        user_id: BUDDY1_ID,
        push_enabled: true,
        quiet_hours_enabled: true,
        quiet_start: quietStart,
        quiet_end: quietEnd,
        timezone: null,
      }],
    });
    await notifyEligibleBuddies(svc2, REQUEST);
    assert.equal(pushCalls.length, 1, "expected server-time fallback to deliver");
  });

  it("does not call Expo when no tokens exist anywhere", async () => {
    const svc = makeFakeClient({
      rentBuddyProfiles: [buddyRow({ expo_push_token: null })],
      profiles: [{ id: BUDDY1_ID, expo_push_token: null }],
    });
    await notifyEligibleBuddies(svc, REQUEST);
    assert.equal(pushCalls.length, 0);
  });
});

// ── POST /api/me/devices backfill ──────────────────────────────────────────────

describe("POST /api/me/devices — rent_buddy_profiles token backfill", () => {
  let server: http.Server;
  let base: string;
  let client: any;

  before(async () => {
    client = makeFakeClient({
      profiles: [{ id: BUDDY1_ID, expo_push_token: null }],
      rentBuddyProfiles: [buddyRow({ expo_push_token: null })],
      notificationDevices: [],
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const app = express();
    app.use(express.json());
    app.use("/api", notificationsRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    _setTestClient(null, false);
    _setTestServiceClient(null);
  });

  it("stores the expo token on the buddy profile", async () => {
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      const r = http.request(
        `${base}/api/me/devices`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${FAKE_TOKEN}`,
          },
        },
        (rsp) => {
          rsp.resume();
          rsp.on("end", () => resolve({ status: rsp.statusCode ?? 0 }));
        },
      );
      r.on("error", reject);
      r.write(JSON.stringify({ pushToken: TOKEN1, platform: "expo" }));
      r.end();
    });

    assert.equal(res.status, 201);
    const patches = client.__updatePatches["rent_buddy_profiles"] ?? [];
    assert.ok(
      patches.some(
        (p: any) =>
          p.patch.expo_push_token === TOKEN1 &&
          p.filters.some((f: any[]) => f[0] === "eq" && f[1] === "user_id" && f[2] === BUDDY1_ID),
      ),
      "expected rent_buddy_profiles.expo_push_token update for the user",
    );
  });
});
