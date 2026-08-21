/**
 * Stamp-earned push notification tests
 *
 * Covers:
 *   1. Template unit tests — passport.stamp_earned actionUrl is the Expo Router
 *      deep-link path useNotificationHandler expects.
 *   2. Internal award route (POST /stamps/award via X-Internal-Secret) —
 *      a notification row is inserted when the award succeeds; nothing is
 *      inserted when the award is skipped (already_awarded).
 *   3. Admin award route (POST /admin/stamps/award) — same notification
 *      assertion.
 *
 * Runtime: node:test + fetch-style HTTP via node:http against a real Express
 * server.  Fake Supabase client injected via _setTestClient /
 * _setTestServiceClient — same pattern as the notifications.test.ts suite.
 *
 * Run: node --import tsx/esm --test src/test/stampEarnedNotification.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import stampsRouter from "../routes/stamps.js";
import adminStampsRouter from "../routes/adminStamps.js";
import { TEMPLATES, renderTemplate } from "../services/notifications/NotificationTemplateService.js";

// ── Fixed IDs ─────────────────────────────────────────────────────────────────

const USER_ID   = "00000000-0000-0000-0000-000000001133";
const ADMIN_ID  = "00000000-0000-0000-0000-000000001134";
const DEF_ID    = "00000000-0000-0000-0000-000000001135";
const STAMP_ID  = "00000000-0000-0000-0000-000000001136";

const USER_TOKEN  = "user-tok-1133";
const ADMIN_TOKEN = "admin-tok-1133";
const INT_SECRET  = "test-internal-secret-1133";

// ── HTTP helper ───────────────────────────────────────────────────────────────

function req(
  server: http.Server,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const addr = server.address() as { port: number };
  const base = `http://127.0.0.1:${addr.port}`;
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
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c: string) => (raw += c));
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

// ── Fake Supabase client ──────────────────────────────────────────────────────
//
// Handles the full notification pipeline:
//   awardStamp:       feature_flags, stamp_definitions, stamp_award_events,
//                     user_stamps
//   NotificationService.create:  notifications, notification_preferences,
//                     notification_category_preferences, user_location_preferences,
//                     trip_members
//   NotificationRouter.route:    notification_devices, profiles,
//                     notification_delivery_attempts
//   evaluateNotification (compass): compass-related tables — return empty so
//                     compass evaluation defaults to "sent"
//
// All tables not explicitly listed return empty arrays (fail-open).

interface FakeState {
  /** Whether to simulate a successful stamp insert (true = new award) */
  awardSucceeds: boolean;
  /** Whether the stamp_system_v2_enabled feature flag is enabled (default true) */
  featureEnabled?: boolean;
  /** Capture all inserts by table name */
  inserted: Record<string, any[]>;
}

const PROFILES: Record<string, { id: string; role: string; expo_push_token: string | null }> = {
  [USER_ID]:  { id: USER_ID,  role: "user",  expo_push_token: null },
  [ADMIN_ID]: { id: ADMIN_ID, role: "admin", expo_push_token: null },
};

function makeFakeClient(state: FakeState, tokenMap: Record<string, string>) {
  function from(table: string) {
    const eqFilters: Array<{ col: string; val: any }> = [];
    let _insert: any = null;

    const b: any = {
      select(_cols?: string, _opts?: any) { return b; },
      insert(row: any) {
        _insert = row;
        if (!state.inserted[table]) state.inserted[table] = [];
        const rows = Array.isArray(row) ? row : [row];
        state.inserted[table].push(...rows);
        return b;
      },
      update(_patch: any)          { return b; },
      upsert(row: any)             { _insert = row; return b; },
      delete()                     { return b; },
      eq(col: string, val: any)    { eqFilters.push({ col, val }); return b; },
      neq(_c: string, _v: any)     { return b; },
      in(_c: string, _v: any[])    { return b; },
      or(_e: string)               { return b; },
      is(_c: string, _v: any)      { return b; },
      gt(_c: string, _v: any)      { return b; },
      lt(_c: string, _v: any)      { return b; },
      not(_c: string, _op: string, _v: any) { return b; },
      ilike(_c: string, _p: string) { return b; },
      gte(_c: string, _v: any)     { return b; },
      lte(_c: string, _v: any)     { return b; },
      contains(_c: string, _v: any) { return b; },
      overlaps(_c: string, _v: any) { return b; },
      order()           { return b; },
      limit(_n: number) { return b; },
      range()           { return b; },
      head()            { return b; },
      maybeSingle() { return resolveOne(); },
      single()      { return resolveOne(); },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    function getEq(col: string): any {
      return eqFilters.find((f) => f.col === col)?.val;
    }

    async function resolveOne() {
      if (_insert) {
        const row = Array.isArray(_insert) ? _insert[0] : _insert;
        if (table === "stamp_award_events" && !state.awardSucceeds) {
          return { data: null, error: { code: "23505", message: "duplicate" } };
        }
        if (table === "user_stamps") {
          return { data: { id: STAMP_ID, ...row }, error: null };
        }
        return { data: { id: `${table}-row`, ...row }, error: null };
      }

      if (table === "stamp_definitions") {
        return {
          data: {
            id: DEF_ID, slug: "first-trip", name: "First Trip",
            is_active: true, is_repeatable: false,
            max_awards_per_user: null, visibility_default: "public",
            criteria_type: "trip",
          },
          error: null,
        };
      }

      if (table === "stamp_award_events") {
        return {
          data: state.awardSucceeds ? null : { id: "existing", status: "awarded" },
          error: null,
        };
      }

      if (table === "user_stamps")   {
        // When the award already exists (awardSucceeds:false), the idempotency
        // path re-reads user_stamps to confirm the passport row is present.
        // Return an existing stamp so the engine reports already_awarded rather
        // than trying to heal a "missing" row and re-awarding.
        return { data: state.awardSucceeds ? null : { id: STAMP_ID }, error: null };
      }
      if (table === "feature_flags") { return { data: { enabled: state.featureEnabled !== false }, error: null }; }

      if (table === "profiles") {
        const id = getEq("id");
        const profile = id ? PROFILES[id] ?? null : null;
        return { data: profile, error: null };
      }

      return { data: null, error: null };
    }

    async function resolveList() {
      if (_insert) {
        const row = Array.isArray(_insert) ? _insert[0] : _insert;
        return { data: { id: `${table}-row`, ...row }, error: null };
      }
      return { data: [], count: 0, error: null };
    }

    return b;
  }

  const client: any = {
    from,
    auth: {
      getUser: async (token: string) => {
        const id = tokenMap[token];
        if (!id) return { data: { user: null }, error: { message: "invalid token" } };
        return { data: { user: { id } }, error: null };
      },
    },
  };

  return client;
}

// ── Test server factory ───────────────────────────────────────────────────────

function makeServer(state: FakeState, routerType: "stamps" | "admin") {
  const client = makeFakeClient(state, {
    [USER_TOKEN]:  USER_ID,
    [ADMIN_TOKEN]: ADMIN_ID,
  });
  _setTestClient(client, true);
  _setTestServiceClient(client);

  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => {
    r.log = { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} };
    next();
  });

  if (routerType === "stamps") {
    app.use("/api", stampsRouter);
  } else {
    app.use("/api", adminStampsRouter);
  }

  const server = http.createServer(app);
  return new Promise<http.Server>((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function waitForNotification(state: FakeState, timeoutMs = 500): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if ((state.inserted["notifications"] ?? []).length > 0) return resolve();
      if (Date.now() > deadline) return reject(new Error("timed out waiting for notification insert"));
      setTimeout(check, 20);
    };
    check();
  });
}

// ── Suite 1: Template unit tests ──────────────────────────────────────────────

describe("passport.stamp_earned template", () => {
  it("is in the TEMPLATES list", () => {
    const t = TEMPLATES.find((t) => t.eventType === "passport.stamp_earned");
    assert.ok(t, "template not found");
  });

  it("has category 'passport'", () => {
    const t = TEMPLATES.find((t) => t.eventType === "passport.stamp_earned")!;
    assert.equal(t.category, "passport");
  });

  it("includes 'push' in defaultChannels", () => {
    const t = TEMPLATES.find((t) => t.eventType === "passport.stamp_earned")!;
    assert.ok(t.defaultChannels.includes("push"), "push channel missing");
  });

  it("actionUrl falls back to /(tabs)/passport?tab=stamps when no stampId", () => {
    const rendered = renderTemplate("passport.stamp_earned", { location: "Tokyo" });
    assert.ok(rendered, "renderTemplate returned null");
    assert.equal(rendered!.actionUrl, "/(tabs)/passport?tab=stamps");
  });

  it("actionUrl deep-links to /stamp/:stampId when stampId param is present", () => {
    const rendered = renderTemplate("passport.stamp_earned", { location: "Tokyo", stampId: STAMP_ID });
    assert.ok(rendered, "renderTemplate returned null");
    assert.equal(rendered!.actionUrl, `/stamp/${STAMP_ID}`);
  });

  it("title contains 'Passport Stamp Earned'", () => {
    const rendered = renderTemplate("passport.stamp_earned", { location: "Tokyo" });
    assert.ok(rendered!.title.includes("Passport Stamp Earned"), `unexpected title: ${rendered!.title}`);
  });

  it("body includes the location param", () => {
    const rendered = renderTemplate("passport.stamp_earned", { location: "Kyoto" });
    assert.ok(rendered!.body.includes("Kyoto"), `body missing location: ${rendered!.body}`);
  });

  it("body falls back gracefully when location is absent", () => {
    const rendered = renderTemplate("passport.stamp_earned", {});
    assert.ok(rendered!.body.length > 0, "body is empty");
  });
});

// ── Suite 2: Internal /stamps/award route fires notification ─────────────────

describe("POST /api/stamps/award (internal) — notification dispatch", () => {
  let server: http.Server;
  let state: FakeState;

  before(async () => {
    process.env.INTERNAL_API_SECRET = INT_SECRET;
    state = { awardSucceeds: true, inserted: {} };
    server = await makeServer(state, "stamps");
  });

  after(() => {
    server.close();
    delete process.env.INTERNAL_API_SECRET;
  });

  it("responds 201 when stamp is awarded", async () => {
    const res = await req(
      server,
      "POST",
      "/api/stamps/award",
      {
        userId:         USER_ID,
        definitionSlug: "first-trip",
        sourceType:     "system",
        city:           "Tokyo",
      },
      { "x-internal-secret": INT_SECRET },
    );
    assert.equal(res.status, 201);
    assert.equal(res.body.awarded, true);
  });

  it("inserts a notification row into the notifications table", async () => {
    await waitForNotification(state);
    const rows = state.inserted["notifications"] ?? [];
    assert.ok(rows.length > 0, "no notification row inserted");
  });

  it("notification has eventType 'passport.stamp_earned'", async () => {
    await waitForNotification(state);
    const row = (state.inserted["notifications"] ?? [])[0];
    assert.equal(row.event_type, "passport.stamp_earned");
  });

  it("notification has correct user_id", async () => {
    await waitForNotification(state);
    const row = (state.inserted["notifications"] ?? [])[0];
    assert.equal(row.user_id, USER_ID);
  });

  it("notification actionUrl deep-links to the specific stamp", async () => {
    await waitForNotification(state);
    const row = (state.inserted["notifications"] ?? [])[0];
    assert.equal(row.action_url, `/stamp/${STAMP_ID}`);
  });
});

// ── Suite 3: Internal route — already_awarded skips notification ──────────────

describe("POST /api/stamps/award — already awarded does NOT fire notification", () => {
  let server: http.Server;
  let state: FakeState;

  before(async () => {
    process.env.INTERNAL_API_SECRET = INT_SECRET;
    state = { awardSucceeds: false, inserted: {} };
    server = await makeServer(state, "stamps");
  });

  after(() => {
    server.close();
    delete process.env.INTERNAL_API_SECRET;
  });

  it("responds 200 when already awarded", async () => {
    const res = await req(
      server,
      "POST",
      "/api/stamps/award",
      {
        userId:         USER_ID,
        definitionSlug: "first-trip",
        sourceType:     "system",
      },
      { "x-internal-secret": INT_SECRET },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.awarded, false);
  });

  it("does NOT insert a notification row", async () => {
    await new Promise((r) => setTimeout(r, 200));
    const rows = state.inserted["notifications"] ?? [];
    assert.equal(rows.length, 0, `unexpected notification rows: ${rows.length}`);
  });
});

// ── Suite 4: Admin /admin/stamps/award route fires notification ───────────────

describe("POST /api/admin/stamps/award — notification dispatch", () => {
  let server: http.Server;
  let state: FakeState;

  before(async () => {
    state = { awardSucceeds: true, inserted: {} };
    server = await makeServer(state, "admin");
  });

  after(() => server.close());

  it("responds 201 for admin award", async () => {
    const res = await req(
      server,
      "POST",
      "/api/admin/stamps/award",
      {
        userId:         USER_ID,
        definitionSlug: "first-trip",
        reason:         "Manual award for testing",
        city:           "Paris",
      },
      { authorization: `Bearer ${ADMIN_TOKEN}` },
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.awarded, true);
  });

  it("inserts a notification row after admin award", async () => {
    await waitForNotification(state);
    const rows = state.inserted["notifications"] ?? [];
    assert.ok(rows.length > 0, "no notification row inserted");
  });

  it("admin award notification has eventType 'passport.stamp_earned'", async () => {
    await waitForNotification(state);
    const row = (state.inserted["notifications"] ?? [])[0];
    assert.equal(row.event_type, "passport.stamp_earned");
  });

  it("admin award notification has correct user_id (recipient, not admin)", async () => {
    await waitForNotification(state);
    const row = (state.inserted["notifications"] ?? [])[0];
    assert.equal(row.user_id, USER_ID);
  });

  it("admin award notification actionUrl deep-links to the specific stamp", async () => {
    await waitForNotification(state);
    const row = (state.inserted["notifications"] ?? [])[0];
    assert.equal(row.action_url, `/stamp/${STAMP_ID}`);
  });
});

// ── Suite 5: Admin award — already_awarded skips notification ─────────────────

describe("POST /api/admin/stamps/award — already awarded skips notification", () => {
  let server: http.Server;
  let state: FakeState;

  before(async () => {
    state = { awardSucceeds: false, inserted: {} };
    server = await makeServer(state, "admin");
  });

  after(() => server.close());

  it("responds 200 for already-awarded admin award", async () => {
    const res = await req(
      server,
      "POST",
      "/api/admin/stamps/award",
      {
        userId:         USER_ID,
        definitionSlug: "first-trip",
        reason:         "Already given",
      },
      { authorization: `Bearer ${ADMIN_TOKEN}` },
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.awarded, false);
  });

  it("does NOT insert a notification row for duplicate award", async () => {
    await new Promise((r) => setTimeout(r, 200));
    const rows = state.inserted["notifications"] ?? [];
    assert.equal(rows.length, 0, `unexpected notification rows: ${rows.length}`);
  });
});

// ── Suite 6: Feature flag disabled — award gated with 503, no notification ────

describe("POST /api/stamps/award — feature flag disabled fails closed", () => {
  let server: http.Server;
  let state: FakeState;

  before(async () => {
    process.env.INTERNAL_API_SECRET = INT_SECRET;
    state = { awardSucceeds: true, featureEnabled: false, inserted: {} };
    server = await makeServer(state, "stamps");
  });

  after(() => {
    server.close();
    delete process.env.INTERNAL_API_SECRET;
  });

  it("responds 503 feature_not_available when the flag is disabled", async () => {
    const res = await req(
      server,
      "POST",
      "/api/stamps/award",
      {
        userId:         USER_ID,
        definitionSlug: "first-trip",
        sourceType:     "system",
        city:           "Tokyo",
      },
      { "x-internal-secret": INT_SECRET },
    );
    assert.equal(res.status, 503, JSON.stringify(res.body));
    assert.equal(res.body.error, "feature_not_available");
  });

  it("does NOT insert a notification row when gated", async () => {
    await new Promise((r) => setTimeout(r, 200));
    const rows = state.inserted["notifications"] ?? [];
    assert.equal(rows.length, 0, `unexpected notification rows: ${rows.length}`);
  });
});
