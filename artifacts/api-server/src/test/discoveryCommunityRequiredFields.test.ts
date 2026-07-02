/**
 * Tests for POST /api/discovery/community — required field validation
 *
 * Uses _setTestClient to inject a fake Supabase service client, bypassing the
 * real DB entirely. No network calls are made.
 *
 * Tests cover:
 *  - missing city returns 400 invalid_payload
 *  - empty city string returns 400 invalid_payload
 *  - missing name returns 400 invalid_payload
 *  - empty name string returns 400 invalid_payload
 *  - missing place_type returns 400 invalid_payload
 *  - invalid place_type value returns 400 invalid_payload
 *  - valid body with both valid place_type values returns 201
 *
 * Run: node --import tsx/esm --test src/test/discoveryCommunityRequiredFields.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const FAKE_TOKEN = "community-required-fields-test-token";
const USER_ID    = "user-community-required-1";

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
    id:         "place-required-1",
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

describe("POST /api/discovery/community — required field validation", () => {
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

  // ── city ────────────────────────────────────────────────────────────────────

  it("returns 400 when city is missing", async () => {
    const { city: _omit, ...body } = VALID_BODY;
    const r = await post(url, "/api/discovery/community", body);
    assert.equal(r.status, 400, `expected 400 for missing city, got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("returns 400 when city is an empty string", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, city: "" });
    assert.equal(r.status, 400, `expected 400 for city="", got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("returns 400 when city is whitespace only", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, city: "   " });
    assert.equal(r.status, 400, `expected 400 for city="   ", got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  // ── name ────────────────────────────────────────────────────────────────────

  it("returns 400 when name is missing", async () => {
    const { name: _omit, ...body } = VALID_BODY;
    const r = await post(url, "/api/discovery/community", body);
    assert.equal(r.status, 400, `expected 400 for missing name, got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("returns 400 when name is an empty string", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, name: "" });
    assert.equal(r.status, 400, `expected 400 for name="", got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("returns 400 when name is whitespace only", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, name: "   " });
    assert.equal(r.status, 400, `expected 400 for name="   ", got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  // ── place_type ──────────────────────────────────────────────────────────────

  it("returns 400 when place_type is missing", async () => {
    const { place_type: _omit, ...body } = VALID_BODY;
    const r = await post(url, "/api/discovery/community", body);
    assert.equal(r.status, 400, `expected 400 for missing place_type, got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("returns 400 when place_type is an unrecognised value", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, place_type: "unknown_type" });
    assert.equal(r.status, 400, `expected 400 for place_type="unknown_type", got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("returns 400 when place_type is an empty string", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, place_type: "" });
    assert.equal(r.status, 400, `expected 400 for place_type="", got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  // ── happy paths (one per allowed place_type) ────────────────────────────────

  it("accepts place_type=hidden_gem and returns 201", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, place_type: "hidden_gem" });
    assert.equal(r.status, 201, `expected 201 for place_type="hidden_gem", got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, true);
  });

  it("accepts place_type=traveler_pick and returns 201", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, place_type: "traveler_pick" });
    assert.equal(r.status, 201, `expected 201 for place_type="traveler_pick", got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, true);
  });
});
