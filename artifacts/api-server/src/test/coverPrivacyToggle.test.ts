/**
 * Cover-privacy and profile-photo toggle round-trip smoke tests
 *
 * Confirms that showHeaderPublicly (events & trips) and
 * show_profile_picture_publicly (profile) are accepted by the PATCH handlers
 * and written to the DB — not silently dropped.
 *
 * Covers:
 *   1. PATCH /api/events/:id with showHeaderPublicly=false → DB write captured
 *   2. PATCH /api/events/:id with showHeaderPublicly=true  → DB write captured
 *   3. PATCH /api/trips/:id  with showHeaderPublicly=false → DB write captured
 *   4. PATCH /api/trips/:id  with showHeaderPublicly=true  → DB write captured
 *   5. PATCH /api/me/privacy with show_profile_picture_publicly=false → profiles updated
 *   6. PATCH /api/me/privacy with show_profile_picture_publicly=true  → profiles updated
 *   7. PATCH /api/events/:id without showHeaderPublicly → field absent from patch (not overwritten)
 *
 * Run: node --import tsx/esm --test src/test/coverPrivacyToggle.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const HOST_ID  = "aaaaaaaa-0001-4000-a000-000000000001";
const EVENT_ID = "eeeeeeee-0001-4000-a000-000000000002";
const TRIP_ID  = "cccccccc-0003-4000-a000-000000000003";
const TOKEN    = "cover-privacy-test-token";

// ── HTTP helper ───────────────────────────────────────────────────────────────

function apiReq(
  method: string,
  path: string,
  body: unknown | null,
  server: Server,
): Promise<{ status: number; body: any }> {
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body != null ? JSON.stringify(body) : undefined;
    const r = httpRequest(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method,
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${TOKEN}`,
          ...(payload ? { "content-length": Buffer.byteLength(payload).toString() } : {}),
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

// ── Fake client builders ──────────────────────────────────────────────────────

/**
 * Builds a fake Supabase client for the events PATCH route.
 * Tracks every update() call on the "events" table.
 */
function buildEventsFakeClient() {
  const eventUpdates: any[] = [];

  function from(table: string) {
    let _filters: Array<(r: any) => boolean> = [];
    let _updatePatch: any = null;

    const b: any = {
      select() { return b; },
      update(patch: any) {
        _updatePatch = patch;
        if (table === "events") eventUpdates.push({ ...patch });
        return b;
      },
      delete() { return b; },
      upsert() { return b; },
      insert() { return b; },
      eq(col: string, val: any) { _filters.push((r: any) => r[col] === val); return b; },
      neq() { return b; },
      in() { return b; },
      is() { return b; },
      not() { return b; },
      or() { return b; },
      gte() { return b; },
      gt() { return b; },
      lt() { return b; },
      limit() { return b; },
      order() { return b; },
      range() { return b; },
      maybeSingle() {
        return Promise.resolve({ data: resolveOne(), error: null });
      },
      single() {
        if (table === "events" && _updatePatch) {
          return Promise.resolve({ data: { id: EVENT_ID, ..._updatePatch, show_header_publicly: _updatePatch.show_header_publicly ?? true, host_id: HOST_ID, title: "Test Event", state: "open", visibility: "public" }, error: null });
        }
        return Promise.resolve({ data: resolveOne(), error: null });
      },
      then(onF: any, onR: any) {
        return Promise.resolve({ data: [], error: null }).then(onF, onR);
      },
    };

    function resolveOne() {
      if (table === "events") {
        return { id: EVENT_ID, host_id: HOST_ID, title: "Test Event", state: "open", visibility: "public", show_header_publicly: true, chat_enabled: false, chat_thread_id: null };
      }
      if (table === "feature_flags") {
        // All feature flags disabled by default (events_enabled must be true)
        return { flag: "events_enabled", enabled: true };
      }
      if (table === "profiles") {
        return { id: HOST_ID, expo_push_token: null, name: null, avatar_url: null, handle: "testhost", show_profile_picture_publicly: true };
      }
      if (table === "trust_profiles") {
        return { user_id: HOST_ID, overall_score: 75 };
      }
      return null;
    }

    return b;
  }

  return {
    _eventUpdates: eventUpdates,
    auth: {
      getUser: async (token: string) => {
        if (token === TOKEN) return { data: { user: { id: HOST_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
    from,
  };
}

/**
 * Builds a fake Supabase client for the trips PATCH route.
 * Tracks every update() call on the "trips" table.
 */
function buildTripsFakeClient() {
  const tripUpdates: any[] = [];

  function from(table: string) {
    let _updatePatch: any = null;

    const b: any = {
      select() { return b; },
      update(patch: any) {
        _updatePatch = patch;
        if (table === "trips") tripUpdates.push({ ...patch });
        return b;
      },
      delete() { return b; },
      upsert() { return b; },
      insert() { return b; },
      eq() { return b; },
      neq() { return b; },
      in() { return b; },
      is() { return b; },
      not() { return b; },
      or() { return b; },
      gte() { return b; },
      gt() { return b; },
      lt() { return b; },
      limit() { return b; },
      order() { return b; },
      range() { return b; },
      maybeSingle() {
        if (table === "trips") {
          return Promise.resolve({ data: { id: TRIP_ID, owner_id: HOST_ID, title: "Test Trip", destination_city: "Paris", destination_country: "France", start_date: "2026-09-01", end_date: "2026-09-10", status: "upcoming", plan_edit_permission: "owner_only" }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      single() {
        if (table === "trips" && _updatePatch) {
          return Promise.resolve({
            data: {
              id: TRIP_ID, owner_id: HOST_ID, title: "Test Trip",
              destination_city: "Paris", destination_country: "France",
              start_date: "2026-09-01", end_date: "2026-09-10",
              status: "upcoming", visibility: "private",
              show_header_publicly: _updatePatch.show_header_publicly ?? true,
              ...(_updatePatch),
            },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then(onF: any, onR: any) {
        return Promise.resolve({ data: [], error: null }).then(onF, onR);
      },
    };
    return b;
  }

  return {
    _tripUpdates: tripUpdates,
    auth: {
      getUser: async (token: string) => {
        if (token === TOKEN) return { data: { user: { id: HOST_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
    from,
  };
}

/**
 * Builds a fake Supabase client for the PATCH /me/privacy route.
 * Tracks every update() call on the "profiles" table.
 */
function buildPrivacyFakeClient() {
  const profilesUpdated: any[] = [];
  const privacyUpserted: any[] = [];

  const existingPrivacyRow = {
    user_id: HOST_ID,
    profile_visibility: "public",
    show_real_name: false,
    show_current_city: true,
    show_home_country: true,
    show_visited_places: true,
    show_upcoming_trips: true,
    show_past_trips: true,
    show_posts: true,
    show_stamps: true,
    show_friends: true,
    show_followers: true,
    allow_messages_from: "everyone",
    allow_friend_requests: true,
    allow_follow: true,
    allow_tagging: true,
    allow_profile_discovery: true,
    delayed_posting_default: false,
    precise_location_visible: false,
    updated_at: "2026-01-01T00:00:00Z",
  };

  function from(table: string) {
    let _upsertRow: any = null;
    let _updatePatch: any = null;

    const b: any = {
      select() { return b; },
      update(patch: any) {
        _updatePatch = patch;
        if (table === "profiles") profilesUpdated.push({ ...patch });
        return b;
      },
      delete() { return b; },
      upsert(row: any) {
        _upsertRow = row;
        if (table === "profile_privacy_settings") privacyUpserted.push({ ...row });
        return b;
      },
      insert() { return b; },
      eq() { return b; },
      neq() { return b; },
      in() { return b; },
      is() { return b; },
      not() { return b; },
      or() { return b; },
      gte() { return b; },
      gt() { return b; },
      limit() { return b; },
      order() { return b; },
      maybeSingle() {
        if (table === "profile_privacy_settings") {
          return Promise.resolve({ data: { ...existingPrivacyRow }, error: null });
        }
        if (table === "profiles") {
          return Promise.resolve({ data: { id: HOST_ID, show_profile_picture_publicly: true }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      single() {
        if (table === "profile_privacy_settings" && _upsertRow) {
          return Promise.resolve({ data: { ...existingPrivacyRow, ..._upsertRow }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then(onF: any, onR: any) {
        return Promise.resolve({ data: [], error: null }).then(onF, onR);
      },
    };
    return b;
  }

  return {
    _profilesUpdated: profilesUpdated,
    _privacyUpserted: privacyUpserted,
    auth: {
      getUser: async (token: string) => {
        if (token === TOKEN) return { data: { user: { id: HOST_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
    from,
  };
}

// ── Test suites ───────────────────────────────────────────────────────────────

describe("Cover-privacy and profile-photo toggle round-trips", () => {
  let server: Server;

  before(async () => {
    server = createServer(app);
    server.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
  });

  after(() => {
    server.close();
    _setTestClient(null as any, false);
    _setTestServiceClient(null as any);
  });

  beforeEach(() => {
    _setTestClient(null as any, false);
    _setTestServiceClient(null as any);
  });

  // ── Events: showHeaderPublicly ─────────────────────────────────────────────

  describe("PATCH /api/events/:id — showHeaderPublicly", () => {
    it("writes show_header_publicly=false to the events table", async () => {
      const fc = buildEventsFakeClient();
      _setTestClient(fc as any, true);
      _setTestServiceClient(fc as any);

      const r = await apiReq("PATCH", `/api/events/${EVENT_ID}`, { showHeaderPublicly: false }, server);
      assert.equal(r.status, 200, `unexpected status: ${JSON.stringify(r.body)}`);
      assert.ok(
        fc._eventUpdates.some((p) => p.show_header_publicly === false),
        "events table must be updated with show_header_publicly=false",
      );
    });

    it("writes show_header_publicly=true to the events table", async () => {
      const fc = buildEventsFakeClient();
      _setTestClient(fc as any, true);
      _setTestServiceClient(fc as any);

      const r = await apiReq("PATCH", `/api/events/${EVENT_ID}`, { showHeaderPublicly: true }, server);
      assert.equal(r.status, 200, `unexpected status: ${JSON.stringify(r.body)}`);
      assert.ok(
        fc._eventUpdates.some((p) => p.show_header_publicly === true),
        "events table must be updated with show_header_publicly=true",
      );
    });

    it("does NOT include show_header_publicly in patch when field is absent from body", async () => {
      const fc = buildEventsFakeClient();
      _setTestClient(fc as any, true);
      _setTestServiceClient(fc as any);

      await apiReq("PATCH", `/api/events/${EVENT_ID}`, { title: "Updated Title" }, server);
      for (const p of fc._eventUpdates) {
        assert.ok(
          !("show_header_publicly" in p),
          "show_header_publicly must not appear in the events patch when not sent by client",
        );
      }
    });
  });

  // ── Trips: showHeaderPublicly ──────────────────────────────────────────────

  describe("PATCH /api/trips/:id — showHeaderPublicly", () => {
    it("writes show_header_publicly=false to the trips table", async () => {
      const fc = buildTripsFakeClient();
      _setTestClient(fc as any, true);
      _setTestServiceClient(fc as any);

      const r = await apiReq("PATCH", `/api/trips/${TRIP_ID}`, { showHeaderPublicly: false }, server);
      assert.equal(r.status, 200, `unexpected status: ${JSON.stringify(r.body)}`);
      assert.ok(
        fc._tripUpdates.some((p) => p.show_header_publicly === false),
        "trips table must be updated with show_header_publicly=false",
      );
    });

    it("writes show_header_publicly=true to the trips table", async () => {
      const fc = buildTripsFakeClient();
      _setTestClient(fc as any, true);
      _setTestServiceClient(fc as any);

      const r = await apiReq("PATCH", `/api/trips/${TRIP_ID}`, { showHeaderPublicly: true }, server);
      assert.equal(r.status, 200, `unexpected status: ${JSON.stringify(r.body)}`);
      assert.ok(
        fc._tripUpdates.some((p) => p.show_header_publicly === true),
        "trips table must be updated with show_header_publicly=true",
      );
    });
  });

  // ── Privacy: show_profile_picture_publicly ─────────────────────────────────

  describe("PATCH /api/me/privacy — show_profile_picture_publicly", () => {
    it("updates profiles.show_profile_picture_publicly=false when sent in body", async () => {
      const fc = buildPrivacyFakeClient();
      _setTestClient(fc as any, true);
      _setTestServiceClient(fc as any);

      const r = await apiReq("PATCH", "/api/me/privacy", { show_profile_picture_publicly: false }, server);
      assert.equal(r.status, 200, `unexpected status: ${JSON.stringify(r.body)}`);
      // Fire-and-forget: give async side-effect time to run
      await new Promise((res) => setTimeout(res, 60));
      assert.ok(
        fc._profilesUpdated.some((p) => p.show_profile_picture_publicly === false),
        "profiles.show_profile_picture_publicly must be set to false",
      );
    });

    it("updates profiles.show_profile_picture_publicly=true when sent in body", async () => {
      const fc = buildPrivacyFakeClient();
      _setTestClient(fc as any, true);
      _setTestServiceClient(fc as any);

      const r = await apiReq("PATCH", "/api/me/privacy", { show_profile_picture_publicly: true }, server);
      assert.equal(r.status, 200, `unexpected status: ${JSON.stringify(r.body)}`);
      await new Promise((res) => setTimeout(res, 60));
      assert.ok(
        fc._profilesUpdated.some((p) => p.show_profile_picture_publicly === true),
        "profiles.show_profile_picture_publicly must be set to true",
      );
    });

    it("returns show_profile_picture_publicly in response body", async () => {
      const fc = buildPrivacyFakeClient();
      _setTestClient(fc as any, true);
      _setTestServiceClient(fc as any);

      const r = await apiReq("PATCH", "/api/me/privacy", { show_profile_picture_publicly: false }, server);
      assert.equal(r.status, 200, `unexpected status: ${JSON.stringify(r.body)}`);
      assert.equal(
        r.body.show_profile_picture_publicly,
        false,
        "response must echo show_profile_picture_publicly=false so the client toggle reflects the saved value",
      );
    });

    it("does NOT update profiles when show_profile_picture_publicly is absent", async () => {
      const fc = buildPrivacyFakeClient();
      _setTestClient(fc as any, true);
      _setTestServiceClient(fc as any);

      const r = await apiReq("PATCH", "/api/me/privacy", { allow_profile_discovery: false }, server);
      assert.equal(r.status, 200, `unexpected status: ${JSON.stringify(r.body)}`);
      await new Promise((res) => setTimeout(res, 60));
      const showPicWrites = fc._profilesUpdated.filter(
        (p) => "show_profile_picture_publicly" in p,
      );
      assert.equal(
        showPicWrites.length,
        0,
        "profiles.show_profile_picture_publicly must not be touched when not sent in body",
      );
    });
  });
});
