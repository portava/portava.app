/**
 * Tests for POST /api/discovery/community — lat/lng coordinate range validation
 *
 * Uses _setTestClient to inject a fake Supabase service client, bypassing the
 * real DB entirely. No network calls are made.
 *
 * Tests cover:
 *  - lat > 90 returns 400 invalid_payload
 *  - lat < -90 returns 400 invalid_payload
 *  - lng > 180 returns 400 invalid_payload
 *  - lng < -180 returns 400 invalid_payload
 *  - non-numeric strings (lat="north", lng="east") return 400 invalid_payload
 *  - valid coordinates (lat=13.75, lng=100.5) are accepted, return 201, and are
 *    forwarded to the DB insert unchanged
 *  - boundary values (lat=90, lat=-90, lng=180, lng=-180) are accepted and return 201
 *
 * Run: node --import tsx/esm --test src/test/discoveryCommunityCoords.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const FAKE_TOKEN = "community-coords-test-token";
const USER_ID    = "user-community-coords-1";

const VALID_BODY = {
  city:       "Bangkok",
  name:       "Test Place",
  place_type: "hidden_gem",
  category:   "food",
  lat:        13.75,
  lng:        100.5,
};

// ── Fake client ────────────────────────────────────────────────────────────────

/**
 * Creates a fake Supabase client that:
 * - authenticates FAKE_TOKEN as USER_ID
 * - captures the payload passed to .insert() for assertion
 * - always resolves inserts successfully
 */
function makeFakeClient() {
  let lastInsertPayload: Record<string, unknown> | null = null;

  const insertedRow = {
    id:         "place-new-coords-1",
    name:       VALID_BODY.name,
    city:       VALID_BODY.city,
    place_type: VALID_BODY.place_type,
    status:     "active",
    created_at: "2025-07-01T00:00:00.000Z",
  };

  function chain() {
    let _singleMode = false;

    const obj: any = {
      select()               { return obj; },
      insert(payload: any)   { lastInsertPayload = payload; return obj; },
      eq()                   { return obj; },
      single()               { _singleMode = true; return obj; },
      then(onF: any, onR: any) { return resolve().then(onF, onR); },
    };

    async function resolve(): Promise<{ data: any; error: null }> {
      return { data: _singleMode ? insertedRow : [insertedRow], error: null };
    }

    return obj;
  }

  const client = {
    from(_table: string) { return chain(); },
    auth: {
      getUser: async (token: string) => {
        if (token === FAKE_TOKEN) {
          return { data: { user: { id: USER_ID } }, error: null };
        }
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
    getLastInsertPayload() { return lastInsertPayload; },
  };

  return client;
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────

function startServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port as number;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function post(url: string, path: string, body: Record<string, unknown>) {
  const res = await fetch(`${url}${path}`, {
    method:  "POST",
    headers: {
      "content-type":  "application/json",
      "authorization": `Bearer ${FAKE_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("POST /api/discovery/community — lat/lng coordinate range validation", () => {
  let server: Server;
  let url: string;
  let fakeClient: ReturnType<typeof makeFakeClient>;

  beforeEach(async () => {
    fakeClient = makeFakeClient();
    ({ server, url } = await startServer());
    _setTestClient(fakeClient, true);
  });

  afterEach(async () => {
    _setTestClient(null, false);
    await closeServer(server);
  });

  // ── Invalid lat ─────────────────────────────────────────────────────────────

  it("returns 400 when lat is above 90", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, lat: 91 });
    assert.equal(r.status, 400, `expected 400 for lat=91, got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("returns 400 when lat is well above 90", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, lat: 999 });
    assert.equal(r.status, 400, `expected 400 for lat=999, got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("returns 400 when lat is below -90", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, lat: -91 });
    assert.equal(r.status, 400, `expected 400 for lat=-91, got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("returns 400 when lat is well below -90", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, lat: -999 });
    assert.equal(r.status, 400, `expected 400 for lat=-999, got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  // ── Invalid lng ─────────────────────────────────────────────────────────────

  it("returns 400 when lng is above 180", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, lng: 181 });
    assert.equal(r.status, 400, `expected 400 for lng=181, got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("returns 400 when lng is well above 180", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, lng: 360 });
    assert.equal(r.status, 400, `expected 400 for lng=360, got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("returns 400 when lng is below -180", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, lng: -181 });
    assert.equal(r.status, 400, `expected 400 for lng=-181, got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("returns 400 when lng is well below -180", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, lng: -360 });
    assert.equal(r.status, 400, `expected 400 for lng=-360, got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  // ── Non-numeric string coordinates ──────────────────────────────────────────

  it('returns 400 when lat is a non-numeric string ("north")', async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, lat: "north" });
    assert.equal(r.status, 400, `expected 400 for lat="north", got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  it('returns 400 when lng is a non-numeric string ("east")', async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, lng: "east" });
    assert.equal(r.status, 400, `expected 400 for lng="east", got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  // ── Valid coordinates — acceptance + storage ─────────────────────────────────

  it("accepts valid coordinates lat=13.75, lng=100.5, returns 201, and stores them", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, lat: 13.75, lng: 100.5 });
    assert.equal(r.status, 201, `expected 201 for lat=13.75 lng=100.5, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, true);

    const payload = fakeClient.getLastInsertPayload() as any;
    assert.ok(payload, "insert() was not called — coordinates were never forwarded to the DB");
    assert.equal(payload.lat, 13.75, `expected lat=13.75 in insert payload, got ${payload.lat}`);
    assert.equal(payload.lng, 100.5, `expected lng=100.5 in insert payload, got ${payload.lng}`);
  });

  it("accepts lat boundary 90 and returns 201", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, lat: 90 });
    assert.equal(r.status, 201, `expected 201 for lat=90, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, true);
    const payload = fakeClient.getLastInsertPayload() as any;
    assert.equal(payload?.lat, 90, `expected lat=90 in insert payload, got ${payload?.lat}`);
  });

  it("accepts lat boundary -90 and returns 201", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, lat: -90 });
    assert.equal(r.status, 201, `expected 201 for lat=-90, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, true);
    const payload = fakeClient.getLastInsertPayload() as any;
    assert.equal(payload?.lat, -90, `expected lat=-90 in insert payload, got ${payload?.lat}`);
  });

  it("accepts lng boundary 180 and returns 201", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, lng: 180 });
    assert.equal(r.status, 201, `expected 201 for lng=180, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, true);
    const payload = fakeClient.getLastInsertPayload() as any;
    assert.equal(payload?.lng, 180, `expected lng=180 in insert payload, got ${payload?.lng}`);
  });

  it("accepts lng boundary -180 and returns 201", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, lng: -180 });
    assert.equal(r.status, 201, `expected 201 for lng=-180, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, true);
    const payload = fakeClient.getLastInsertPayload() as any;
    assert.equal(payload?.lng, -180, `expected lng=-180 in insert payload, got ${payload?.lng}`);
  });

  it("accepts omitted lat/lng and returns 201 with null coords in insert payload", async () => {
    const { lat: _la, lng: _ln, ...bodyWithoutCoords } = VALID_BODY;
    const r = await post(url, "/api/discovery/community", bodyWithoutCoords);
    assert.equal(r.status, 201, `expected 201 when lat/lng omitted, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, true);
    // When no coords are supplied and geocoding yields nothing (fake client has no network),
    // the route inserts null for both lat and lng.
    const payload = fakeClient.getLastInsertPayload() as any;
    assert.ok(payload, "insert() was not called when lat/lng were omitted");
    assert.equal(payload.lat, null, `expected lat=null in insert payload, got ${payload.lat}`);
    assert.equal(payload.lng, null, `expected lng=null in insert payload, got ${payload.lng}`);
  });
});
