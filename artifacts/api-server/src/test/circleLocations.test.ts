/**
 * Circle Locations — GET /api/me/circle-locations
 *
 * Verifies consent filtering, missing-prefs-row defaults, member exclusion,
 * and members with no location row being omitted from results.
 *
 * Uses the node:test + fake-client pattern.
 * Run: node --import tsx/esm --test src/test/circleLocations.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import locationRouter from "../routes/location.js";

// ── Test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

const VALID_TOKEN = "circle-test-token";
const USER_ID     = "owner-user-id";
const MEMBER_A    = "member-a-id";
const MEMBER_B    = "member-b-id";
const MEMBER_C    = "member-c-id";

function req(
  path: string,
  token: string = VALID_TOKEN,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method: "GET",
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
    r.end();
  });
}

// ── Fake client builder ───────────────────────────────────────────────────────

interface FakeState {
  circleMemberships: Array<{ owner_id: string; member_id: string }>;
  locationPreferences: Array<{ user_id: string; trusted_circle_share: boolean }>;
  locationState: Array<{
    user_id: string;
    lat: number | null;
    lng: number | null;
    city: string | null;
    country: string | null;
    updated_at: string | null;
  }>;
  profiles: Array<{ id: string; name: string | null; avatar_url: string | null }>;
}

function buildQuery(allRows: any[]) {
  let rows = [...allRows];
  const q: any = {
    select(_: string) { return q; },
    eq(col: string, val: any) {
      rows = rows.filter((r: any) => r[col] === val);
      return q;
    },
    in(col: string, vals: any[]) {
      rows = rows.filter((r: any) => vals.includes(r[col]));
      return q;
    },
    // requireUser's account-status check reads profiles via .maybeSingle().
    maybeSingle() {
      return Promise.resolve({ data: rows[0] ?? null, error: null });
    },
    then(resolve: (v: any) => void, reject?: (e: any) => void) {
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    },
  };
  return q;
}

function makeClient(state: FakeState, tokenToUser: Record<string, string> = { [VALID_TOKEN]: USER_ID }) {
  const tables: Record<string, any[]> = {
    circle_memberships: state.circleMemberships,
    location_preferences: state.locationPreferences,
    user_location_state: state.locationState,
    profiles: state.profiles,
  };

  return {
    auth: {
      getUser: async (token: string) => {
        const uid = tokenToUser[token];
        if (!uid) return { data: { user: null }, error: { message: "Unauthorized" } };
        return { data: { user: { id: uid } }, error: null };
      },
    },
    from: (table: string) => buildQuery(tables[table] ?? []),
  };
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(locationRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/me/circle-locations", () => {
  it("returns 401 when no auth token is provided", async () => {
    const client = makeClient({ circleMemberships: [], locationPreferences: [], locationState: [], profiles: [] });
    _setTestClient(client as any, true);

    const r = await req("/me/circle-locations", "");
    assert.equal(r.status, 401);
  });

  it("returns 200 with empty locations when caller has no circle members", async () => {
    const client = makeClient({
      circleMemberships: [],
      locationPreferences: [],
      locationState: [],
      profiles: [],
    });
    _setTestClient(client as any, true);

    const r = await req("/me/circle-locations");
    assert.equal(r.status, 200);
    assert.ok(r.body.ok);
    assert.deepEqual(r.body.locations, []);
  });

  it("returns location for a circle member with no prefs row (default = consented)", async () => {
    const client = makeClient({
      circleMemberships: [{ owner_id: USER_ID, member_id: MEMBER_A }],
      locationPreferences: [],
      locationState: [
        { user_id: MEMBER_A, lat: 48.8566, lng: 2.3522, city: "Paris", country: "FR", updated_at: "2026-07-01T10:00:00Z" },
      ],
      profiles: [{ id: MEMBER_A, name: "Alice", avatar_url: null }],
    });
    _setTestClient(client as any, true);

    const r = await req("/me/circle-locations");
    assert.equal(r.status, 200);
    assert.equal(r.body.locations.length, 1);
    const loc = r.body.locations[0];
    assert.equal(loc.userId, MEMBER_A);
    // Universal display-name rule: real name is redacted (null) unless the
    // member opted in via profile_privacy_settings.show_real_name.
    assert.equal(loc.name, null);
    assert.equal(loc.lat, 48.8566);
    assert.equal(loc.lng, 2.3522);
    assert.equal(loc.city, "Paris");
    assert.equal(loc.country, "FR");
  });

  it("returns location for a circle member with trusted_circle_share = true", async () => {
    const client = makeClient({
      circleMemberships: [{ owner_id: USER_ID, member_id: MEMBER_B }],
      locationPreferences: [{ user_id: MEMBER_B, trusted_circle_share: true }],
      locationState: [
        { user_id: MEMBER_B, lat: 35.6762, lng: 139.6503, city: "Tokyo", country: "JP", updated_at: "2026-07-01T08:00:00Z" },
      ],
      profiles: [{ id: MEMBER_B, name: "Bob", avatar_url: "https://example.com/bob.jpg" }],
    });
    _setTestClient(client as any, true);

    const r = await req("/me/circle-locations");
    assert.equal(r.status, 200);
    assert.equal(r.body.locations.length, 1);
    const loc = r.body.locations[0];
    assert.equal(loc.userId, MEMBER_B);
    assert.equal(loc.avatarUrl, "https://example.com/bob.jpg");
    assert.equal(loc.city, "Tokyo");
  });

  it("excludes a circle member who opted out (trusted_circle_share = false)", async () => {
    const client = makeClient({
      circleMemberships: [{ owner_id: USER_ID, member_id: MEMBER_C }],
      locationPreferences: [{ user_id: MEMBER_C, trusted_circle_share: false }],
      locationState: [
        { user_id: MEMBER_C, lat: 51.5074, lng: -0.1278, city: "London", country: "GB", updated_at: "2026-07-01T09:00:00Z" },
      ],
      profiles: [{ id: MEMBER_C, name: "Carol", avatar_url: null }],
    });
    _setTestClient(client as any, true);

    const r = await req("/me/circle-locations");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.locations, []);
  });

  it("returns only consenting members when circle has mixed consent", async () => {
    const client = makeClient({
      circleMemberships: [
        { owner_id: USER_ID, member_id: MEMBER_A },
        { owner_id: USER_ID, member_id: MEMBER_B },
        { owner_id: USER_ID, member_id: MEMBER_C },
      ],
      locationPreferences: [
        { user_id: MEMBER_B, trusted_circle_share: true },
        { user_id: MEMBER_C, trusted_circle_share: false },
      ],
      locationState: [
        { user_id: MEMBER_A, lat: 48.8566, lng: 2.3522, city: "Paris", country: "FR", updated_at: null },
        { user_id: MEMBER_B, lat: 35.6762, lng: 139.6503, city: "Tokyo", country: "JP", updated_at: null },
        { user_id: MEMBER_C, lat: 51.5074, lng: -0.1278, city: "London", country: "GB", updated_at: null },
      ],
      profiles: [
        { id: MEMBER_A, name: "Alice", avatar_url: null },
        { id: MEMBER_B, name: "Bob", avatar_url: null },
        { id: MEMBER_C, name: "Carol", avatar_url: null },
      ],
    });
    _setTestClient(client as any, true);

    const r = await req("/me/circle-locations");
    assert.equal(r.status, 200);
    const ids = r.body.locations.map((l: any) => l.userId).sort();
    assert.deepEqual(ids, [MEMBER_A, MEMBER_B].sort());
  });

  it("omits members who have no user_location_state row", async () => {
    const client = makeClient({
      circleMemberships: [
        { owner_id: USER_ID, member_id: MEMBER_A },
        { owner_id: USER_ID, member_id: MEMBER_B },
      ],
      locationPreferences: [],
      locationState: [
        { user_id: MEMBER_A, lat: 48.8566, lng: 2.3522, city: "Paris", country: "FR", updated_at: null },
      ],
      profiles: [
        { id: MEMBER_A, name: "Alice", avatar_url: null },
        { id: MEMBER_B, name: "Bob", avatar_url: null },
      ],
    });
    _setTestClient(client as any, true);

    const r = await req("/me/circle-locations");
    assert.equal(r.status, 200);
    assert.equal(r.body.locations.length, 1);
    assert.equal(r.body.locations[0].userId, MEMBER_A);
  });

  it("returns 200 with empty locations when all members opted out", async () => {
    const client = makeClient({
      circleMemberships: [
        { owner_id: USER_ID, member_id: MEMBER_A },
        { owner_id: USER_ID, member_id: MEMBER_B },
      ],
      locationPreferences: [
        { user_id: MEMBER_A, trusted_circle_share: false },
        { user_id: MEMBER_B, trusted_circle_share: false },
      ],
      locationState: [
        { user_id: MEMBER_A, lat: 48.8566, lng: 2.3522, city: "Paris", country: "FR", updated_at: null },
        { user_id: MEMBER_B, lat: 35.6762, lng: 139.6503, city: "Tokyo", country: "JP", updated_at: null },
      ],
      profiles: [
        { id: MEMBER_A, name: "Alice", avatar_url: null },
        { id: MEMBER_B, name: "Bob", avatar_url: null },
      ],
    });
    _setTestClient(client as any, true);

    const r = await req("/me/circle-locations");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.locations, []);
  });
});
