/**
 * Tests for POST /api/discovery/community — coordinate bounds validation
 *
 * Uses _setTestClient to inject a fake Supabase service client, bypassing the
 * real DB entirely. No network calls are made.
 *
 * Tests cover:
 *  - lat > 90 returns 400 invalid_payload
 *  - lat < -90 returns 400 invalid_payload
 *  - lng > 180 returns 400 invalid_payload
 *  - lng < -180 returns 400 invalid_payload
 *  - non-numeric lat string returns 400 invalid_payload
 *  - non-numeric lng string returns 400 invalid_payload
 *
 * Run: node --import tsx/esm --test src/test/discoveryCommunityCoordinateBounds.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const FAKE_TOKEN = "community-coord-bounds-test-token";
const USER_ID    = "user-community-coord-bounds-1";

const VALID_BODY = {
  city:       "Lisbon",
  name:       "Pastéis de Belém",
  place_type: "hidden_gem",
  category:   "food",
  lat:        38.6976,
  lng:        -9.2031,
};

// ── Fake client ────────────────────────────────────────────────────────────────

function makeFakeClient() {
  const insertedRow = {
    id:         "place-coord-bounds-1",
    name:       VALID_BODY.name,
    city:       VALID_BODY.city,
    place_type: VALID_BODY.place_type,
    status:     "active",
    created_at: "2025-07-01T00:00:00.000Z",
  };

  function chain() {
    let _singleMode = false;

    const obj: any = {
      select()          { return obj; },
      insert()          { return obj; },
      eq()              { return obj; },
      single()          { _singleMode = true; return obj; },
      then(onF: any, onR: any) { return resolve().then(onF, onR); },
    };

    async function resolve(): Promise<{ data: any; error: null }> {
      return { data: _singleMode ? insertedRow : [insertedRow], error: null };
    }

    return obj;
  }

  return {
    from(_table: string) { return chain(); },
    auth: {
      getUser: async (token: string) => {
        if (token === FAKE_TOKEN) {
          return { data: { user: { id: USER_ID } }, error: null };
        }
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
  };
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

describe("POST /api/discovery/community — coordinate bounds validation", () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    ({ server, url } = await startServer());
    _setTestClient(makeFakeClient(), true);
  });

  afterEach(async () => {
    _setTestClient(null, false);
    await closeServer(server);
  });

  // ── lat out of range ─────────────────────────────────────────────────────────

  it("returns 400 when lat is greater than 90", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, lat: 90.0001 });
    assert.equal(r.status, 400, `expected 400 for lat=90.0001, got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("returns 400 when lat is less than -90", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, lat: -90.0001 });
    assert.equal(r.status, 400, `expected 400 for lat=-90.0001, got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  // ── lng out of range ─────────────────────────────────────────────────────────

  it("returns 400 when lng is greater than 180", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, lng: 180.0001 });
    assert.equal(r.status, 400, `expected 400 for lng=180.0001, got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("returns 400 when lng is less than -180", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, lng: -180.0001 });
    assert.equal(r.status, 400, `expected 400 for lng=-180.0001, got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  // ── non-numeric values ───────────────────────────────────────────────────────

  it("returns 400 when lat is a non-numeric string", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, lat: "not-a-number" });
    assert.equal(r.status, 400, `expected 400 for lat="not-a-number", got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("returns 400 when lng is a non-numeric string", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, lng: "not-a-number" });
    assert.equal(r.status, 400, `expected 400 for lng="not-a-number", got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });
});
