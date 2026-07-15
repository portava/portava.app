/**
 * Tests for POST /api/discovery/community — rating range validation
 *
 * Uses _setTestClient to inject a fake Supabase service client, bypassing the
 * real DB entirely. No network calls are made.
 *
 * Tests cover:
 *  - rating above 5 returns 400 invalid_payload
 *  - rating below 0 returns 400 invalid_payload
 *  - NaN-ish rating string returns 400 invalid_payload
 *  - valid rating (e.g. 4.2) is accepted and returns 201
 *  - omitting rating entirely is accepted and returns 201
 *
 * Run: node --import tsx/esm --test src/test/discoveryCommunityRating.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const FAKE_TOKEN = "community-rating-test-token";
const USER_ID    = "user-community-rating-1";

const VALID_BODY = {
  city:       "Bangkok",
  name:       "Test Place",
  place_type: "hidden_gem",
  category:   "food",
  lat:        13.75,
  lng:        100.5,
};

// ── Fake client ────────────────────────────────────────────────────────────────

function makeFakeClient() {
  const insertedRow = {
    id:         "place-new-1",
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

describe("POST /api/discovery/community — rating range validation", () => {
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

  it("returns 400 when rating is above 5", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, rating: 999 });
    assert.equal(r.status, 400, `expected 400 for rating=999, got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("returns 400 when rating is exactly 5.1", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, rating: 5.1 });
    assert.equal(r.status, 400, `expected 400 for rating=5.1, got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("returns 400 when rating is below 0", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, rating: -1 });
    assert.equal(r.status, 400, `expected 400 for rating=-1, got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("returns 400 when rating is a non-numeric string", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, rating: "excellent" });
    assert.equal(r.status, 400, `expected 400 for rating="excellent", got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("accepts rating=4.2 and returns 201", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, rating: 4.2 });
    assert.equal(r.status, 201, `expected 201 for rating=4.2, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, true);
  });

  it("accepts rating=0 (boundary) and returns 201", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, rating: 0 });
    assert.equal(r.status, 201, `expected 201 for rating=0, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, true);
  });

  it("accepts rating=5 (boundary) and returns 201", async () => {
    const r = await post(url, "/api/discovery/community", { ...VALID_BODY, rating: 5 });
    assert.equal(r.status, 201, `expected 201 for rating=5, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, true);
  });

  it("accepts omitted rating and returns 201", async () => {
    const { rating: _omit, ...bodyWithoutRating } = { ...VALID_BODY, rating: undefined };
    const r = await post(url, "/api/discovery/community", bodyWithoutRating);
    assert.equal(r.status, 201, `expected 201 when rating is omitted, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, true);
  });
});
