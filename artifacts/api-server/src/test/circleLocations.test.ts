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
import { coarsenPosition, effectiveDiscoveryVisibility } from "../lib/mapTravelers.js";

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

/**
 * A position young enough to pass the 60-minute freshness gate, computed
 * RELATIVE to now. An absolute literal is exactly how the sibling
 * mapProjectionLayers fixtures rotted: fresh on the day they were written,
 * silently expired the next, turning every "1 location" expectation into a
 * vacuous empty-case pass.
 *
 * `last_known_at` is the gated field, not `updated_at`. The writer stamps
 * `updated_at` on every upsert but `last_known_at` only when a coordinate is
 * present, so a member who last moved in June and picked a manual city this
 * morning has a one-minute-old `updated_at` over a three-month-old pin.
 */
const FRESH = new Date(Date.now() - 60_000).toISOString();

interface FakeState {
  circleMemberships: Array<{ user_id: string; other_id: string }>;
  locationPreferences: Array<{
    user_id: string;
    trusted_circle_share: boolean;
    location_mode?: string | null;
    sharing_paused?: boolean | null;
    discovery_visibility?: string | null;
  }>;
  locationState: Array<{
    user_id: string;
    lat: number | null;
    lng: number | null;
    city: string | null;
    country: string | null;
    updated_at: string | null;
    last_known_at?: string | null;
  }>;
  profiles: Array<{ id: string; name: string | null; avatar_url: string | null }>;
  blocks?: Array<{ blocker_id: string; blocked_id: string }>;
  userPrivacySettings?: Array<{ user_id: string; allow_location_sharing: boolean }>;
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
    // Parses "col.eq.val" terms separated by commas (OR). Enough for the
    // bidirectional block lookup fetchBlockedSet issues.
    or(expr: string) {
      const parts = expr.split(",").map((p) => {
        const m = p.trim().match(/^(\w+)\.(\w+)\.(.*)$/);
        return m ? { col: m[1], val: m[3] } : null;
      }).filter(Boolean) as { col: string; val: string }[];
      rows = rows.filter((r: any) => parts.some(({ col, val }) => String(r[col]) === val));
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
    blocks: state.blocks ?? [],
    user_privacy_settings: state.userPrivacySettings ?? [],
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

  it("EXCLUDES a circle member with no prefs row (absence is not consent)", async () => {
    // Circle location sharing is opt-IN: a member with no location_preferences
    // row has not affirmatively consented, and the settings UI shows them as NOT
    // sharing. Serving their location on "no row = consented" leaked the location
    // of members who believe they are private.
    const client = makeClient({
      circleMemberships: [{ user_id: USER_ID, other_id: MEMBER_A }],
      locationPreferences: [],
      locationState: [
        { user_id: MEMBER_A, lat: 48.8566, lng: 2.3522, city: "Paris", country: "FR", updated_at: FRESH, last_known_at: FRESH },
      ],
      profiles: [{ id: MEMBER_A, name: "Alice", avatar_url: null }],
    });
    _setTestClient(client as any, true);

    const r = await req("/me/circle-locations");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.locations, [], "a member with no explicit consent must not be shared");
  });

  it("returns location for a circle member with trusted_circle_share = true", async () => {
    const client = makeClient({
      circleMemberships: [{ user_id: USER_ID, other_id: MEMBER_B }],
      locationPreferences: [{ user_id: MEMBER_B, trusted_circle_share: true }],
      locationState: [
        { user_id: MEMBER_B, lat: 35.6762, lng: 139.6503, city: "Tokyo", country: "JP", updated_at: FRESH, last_known_at: FRESH },
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
      circleMemberships: [{ user_id: USER_ID, other_id: MEMBER_C }],
      locationPreferences: [{ user_id: MEMBER_C, trusted_circle_share: false }],
      locationState: [
        { user_id: MEMBER_C, lat: 51.5074, lng: -0.1278, city: "London", country: "GB", updated_at: FRESH, last_known_at: FRESH },
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
        { user_id: USER_ID, other_id: MEMBER_A },
        { user_id: USER_ID, other_id: MEMBER_B },
        { user_id: USER_ID, other_id: MEMBER_C },
      ],
      locationPreferences: [
        { user_id: MEMBER_A, trusted_circle_share: true },
        { user_id: MEMBER_B, trusted_circle_share: true },
        { user_id: MEMBER_C, trusted_circle_share: false },
      ],
      locationState: [
        { user_id: MEMBER_A, lat: 48.8566, lng: 2.3522, city: "Paris", country: "FR", updated_at: FRESH, last_known_at: FRESH },
        { user_id: MEMBER_B, lat: 35.6762, lng: 139.6503, city: "Tokyo", country: "JP", updated_at: FRESH, last_known_at: FRESH },
        { user_id: MEMBER_C, lat: 51.5074, lng: -0.1278, city: "London", country: "GB", updated_at: FRESH, last_known_at: FRESH },
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
        { user_id: USER_ID, other_id: MEMBER_A },
        { user_id: USER_ID, other_id: MEMBER_B },
      ],
      locationPreferences: [
        { user_id: MEMBER_A, trusted_circle_share: true },
        { user_id: MEMBER_B, trusted_circle_share: true },
      ],
      locationState: [
        { user_id: MEMBER_A, lat: 48.8566, lng: 2.3522, city: "Paris", country: "FR", updated_at: FRESH, last_known_at: FRESH },
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
        { user_id: USER_ID, other_id: MEMBER_A },
        { user_id: USER_ID, other_id: MEMBER_B },
      ],
      locationPreferences: [
        { user_id: MEMBER_A, trusted_circle_share: false },
        { user_id: MEMBER_B, trusted_circle_share: false },
      ],
      locationState: [
        { user_id: MEMBER_A, lat: 48.8566, lng: 2.3522, city: "Paris", country: "FR", updated_at: FRESH, last_known_at: FRESH },
        { user_id: MEMBER_B, lat: 35.6762, lng: 139.6503, city: "Tokyo", country: "JP", updated_at: FRESH, last_known_at: FRESH },
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

  it("coarsens member coordinates — raw lat/lng never appear in the response", async () => {
    const RAW_LAT = 35.6762;
    const RAW_LNG = 139.6503;
    const client = makeClient({
      circleMemberships: [{ user_id: USER_ID, other_id: MEMBER_B }],
      locationPreferences: [
        { user_id: MEMBER_B, trusted_circle_share: true, location_mode: "nearby", discovery_visibility: "neighborhood" },
      ],
      locationState: [
        { user_id: MEMBER_B, lat: RAW_LAT, lng: RAW_LNG, city: "Tokyo", country: "JP", updated_at: FRESH, last_known_at: FRESH },
      ],
      profiles: [{ id: MEMBER_B, name: "Bob", avatar_url: null }],
    });
    _setTestClient(client as any, true);

    const r = await req("/me/circle-locations");
    assert.equal(r.status, 200);
    assert.equal(r.body.locations.length, 1);
    const loc = r.body.locations[0];

    // Raw coords must not appear in the response
    assert.notEqual(loc.lat, RAW_LAT, "raw lat must not be returned for a non-self member");
    assert.notEqual(loc.lng, RAW_LNG, "raw lng must not be returned for a non-self member");

    // Returned coords must match the deterministic coarsenPosition output
    const prefs = { location_mode: "nearby", sharing_paused: undefined, discovery_visibility: "neighborhood" };
    const vis = effectiveDiscoveryVisibility(prefs) ?? "city_only";
    const expected = coarsenPosition(MEMBER_B, RAW_LAT, RAW_LNG, vis);
    assert.equal(loc.lat, expected.lat, "lat should equal the coarsened value");
    assert.equal(loc.lng, expected.lng, "lng should equal the coarsened value");
  });

  it("caller's own entry is also coarsened — raw coordinates never leave the server", async () => {
    const OWN_LAT = 40.7128;
    const OWN_LNG = -74.0060;
    // The caller (USER_ID) appears in their own circle_memberships as a member
    const client = makeClient({
      circleMemberships: [{ user_id: USER_ID, other_id: USER_ID }],
      locationPreferences: [],
      locationState: [
        { user_id: USER_ID, lat: OWN_LAT, lng: OWN_LNG, city: "New York", country: "US", updated_at: FRESH, last_known_at: FRESH },
      ],
      profiles: [{ id: USER_ID, name: "Owner", avatar_url: null }],
    });
    _setTestClient(client as any, true);

    const r = await req("/me/circle-locations");
    assert.equal(r.status, 200);
    assert.equal(r.body.locations.length, 1);
    const loc = r.body.locations[0];
    assert.equal(loc.userId, USER_ID);
    // Invariant: raw coordinates must never appear in any response row, even self.
    assert.notEqual(loc.lat, OWN_LAT, "caller's own raw lat must not be returned");
    assert.notEqual(loc.lng, OWN_LNG, "caller's own raw lng must not be returned");
    const expected = coarsenPosition(USER_ID, OWN_LAT, OWN_LNG, effectiveDiscoveryVisibility(null) ?? "city_only");
    assert.equal(loc.lat, expected.lat);
    assert.equal(loc.lng, expected.lng);
  });

  it("excludes a member who turned the master location switch OFF (allow_location_sharing = false)", async () => {
    // trusted_circle_share defaults to true (no opt-out here), but the master
    // switch user_privacy_settings.allow_location_sharing is false → the member
    // must disappear entirely, mirroring listMapTravelers' upsExcluded.
    const client = makeClient({
      circleMemberships: [
        { user_id: USER_ID, other_id: MEMBER_A },
        { user_id: USER_ID, other_id: MEMBER_B },
      ],
      locationPreferences: [
        { user_id: MEMBER_A, trusted_circle_share: true },
        { user_id: MEMBER_B, trusted_circle_share: true },
      ],
      locationState: [
        { user_id: MEMBER_A, lat: 48.8566, lng: 2.3522,   city: "Paris", country: "FR", updated_at: FRESH, last_known_at: FRESH },
        { user_id: MEMBER_B, lat: 35.6762, lng: 139.6503, city: "Tokyo", country: "JP", updated_at: FRESH, last_known_at: FRESH },
      ],
      profiles: [
        { id: MEMBER_A, name: "Alice", avatar_url: null },
        { id: MEMBER_B, name: "Bob",   avatar_url: null },
      ],
      userPrivacySettings: [{ user_id: MEMBER_B, allow_location_sharing: false }],
    });
    _setTestClient(client as any, true);

    const r = await req("/me/circle-locations");
    assert.equal(r.status, 200);
    const ids = r.body.locations.map((l: any) => l.userId);
    assert.ok(ids.includes(MEMBER_A),  "member A (sharing on) should appear");
    assert.ok(!ids.includes(MEMBER_B), "member B (allow_location_sharing=false) must not appear");
    // The excluded member must leak nothing — no city/country row at all.
    assert.ok(!r.body.locations.some((l: any) => l.city === "Tokyo"), "no field of the OFF member may leak");
  });

  it("excludes a member whose effective visibility is 'hide' — no city/country/updated_at leak", async () => {
    // effectiveDiscoveryVisibility() returns null for sharing_paused,
    // location_mode='off', and discovery_visibility='no_location'. In every
    // such case the member must be EXCLUDED, not coarsened to city_only (which
    // would still expose city/country/updated_at). trusted_circle_share is left
    // at its default (true) so only the visibility=null path is under test.
    const client = makeClient({
      circleMemberships: [
        { user_id: USER_ID, other_id: MEMBER_A }, // sharing_paused → null → exclude
        { user_id: USER_ID, other_id: MEMBER_B }, // location_mode 'off' → null → exclude
        { user_id: USER_ID, other_id: MEMBER_C }, // discovery_visibility 'no_location' → null → exclude
      ],
      locationPreferences: [
        { user_id: MEMBER_A, trusted_circle_share: true, sharing_paused: true },
        { user_id: MEMBER_B, trusted_circle_share: true, location_mode: "off" },
        { user_id: MEMBER_C, trusted_circle_share: true, discovery_visibility: "no_location" },
      ],
      locationState: [
        { user_id: MEMBER_A, lat: 48.8566, lng: 2.3522,   city: "Paris",  country: "FR", updated_at: FRESH, last_known_at: FRESH },
        { user_id: MEMBER_B, lat: 35.6762, lng: 139.6503, city: "Tokyo",  country: "JP", updated_at: FRESH, last_known_at: FRESH },
        { user_id: MEMBER_C, lat: 51.5074, lng: -0.1278,  city: "London", country: "GB", updated_at: FRESH, last_known_at: FRESH },
      ],
      profiles: [
        { id: MEMBER_A, name: "Alice", avatar_url: null },
        { id: MEMBER_B, name: "Bob",   avatar_url: null },
        { id: MEMBER_C, name: "Carol", avatar_url: null },
      ],
    });
    _setTestClient(client as any, true);

    const r = await req("/me/circle-locations");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.locations, [], "all sharing-OFF members must be excluded, leaking nothing");
  });

  it("excludes a circle member the caller has blocked", async () => {
    const client = makeClient({
      circleMemberships: [
        { user_id: USER_ID, other_id: MEMBER_A },
        { user_id: USER_ID, other_id: MEMBER_B },
      ],
      locationPreferences: [
        { user_id: MEMBER_A, trusted_circle_share: true },
        { user_id: MEMBER_B, trusted_circle_share: true },
      ],
      locationState: [
        { user_id: MEMBER_A, lat: 48.8566, lng: 2.3522,   city: "Paris", country: "FR", updated_at: FRESH, last_known_at: FRESH },
        { user_id: MEMBER_B, lat: 35.6762, lng: 139.6503, city: "Tokyo", country: "JP", updated_at: FRESH, last_known_at: FRESH },
      ],
      profiles: [
        { id: MEMBER_A, name: "Alice", avatar_url: null },
        { id: MEMBER_B, name: "Bob",   avatar_url: null },
      ],
      blocks: [{ blocker_id: USER_ID, blocked_id: MEMBER_B }], // caller blocked B
    });
    _setTestClient(client as any, true);

    const r = await req("/me/circle-locations");
    assert.equal(r.status, 200);
    const ids = r.body.locations.map((l: any) => l.userId);
    assert.ok(ids.includes(MEMBER_A),  "unblocked member A should appear");
    assert.ok(!ids.includes(MEMBER_B), "member B (blocked by caller) must not appear");
  });

  it("excludes a circle member who has blocked the caller (reverse direction)", async () => {
    const client = makeClient({
      circleMemberships: [
        { user_id: USER_ID, other_id: MEMBER_A },
        { user_id: USER_ID, other_id: MEMBER_C },
      ],
      locationPreferences: [
        { user_id: MEMBER_A, trusted_circle_share: true },
        { user_id: MEMBER_C, trusted_circle_share: true },
      ],
      locationState: [
        { user_id: MEMBER_A, lat: 48.8566, lng: 2.3522,  city: "Paris",  country: "FR", updated_at: FRESH, last_known_at: FRESH },
        { user_id: MEMBER_C, lat: 51.5074, lng: -0.1278, city: "London", country: "GB", updated_at: FRESH, last_known_at: FRESH },
      ],
      profiles: [
        { id: MEMBER_A, name: "Alice", avatar_url: null },
        { id: MEMBER_C, name: "Carol", avatar_url: null },
      ],
      blocks: [{ blocker_id: MEMBER_C, blocked_id: USER_ID }], // C blocked the caller
    });
    _setTestClient(client as any, true);

    const r = await req("/me/circle-locations");
    assert.equal(r.status, 200);
    const ids = r.body.locations.map((l: any) => l.userId);
    assert.ok(ids.includes(MEMBER_A),  "unblocked member A should appear");
    assert.ok(!ids.includes(MEMBER_C), "member C (who blocked caller) must not appear");
  });
});
