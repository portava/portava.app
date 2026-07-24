/**
 * POST /api/discovery/community — photos field persistence tests
 *
 * Verifies that the community place creation route:
 *   - Accepts a `photos` array and passes it to the DB insert
 *   - Omits the photos field (null) when no photos are supplied (text-only path)
 *   - Limits photos to a maximum of 3 items even when more are sent
 *   - Strips non-string values from the photos array
 *
 * Uses _setTestClient to inject a fake Supabase service client.
 * No network calls are made.
 *
 * Run: node --import tsx/esm --test src/test/communityPlacePhotos.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const USER_ID    = "aaaaaaaa-aaaa-aaaa-aaaa-000000000001";
const PLACE_ID   = "bbbbbbbb-bbbb-bbbb-bbbb-000000000001";
const PHOTO_URL  = "https://cdn.example.com/uploads/place1.jpg";
const PHOTO_URL2 = "https://cdn.example.com/uploads/place2.jpg";
const PHOTO_URL3 = "https://cdn.example.com/uploads/place3.jpg";
const PHOTO_URL4 = "https://cdn.example.com/uploads/place4.jpg";

/** Capture the most-recent .insert() call payload. */
let lastInsertPayload: Record<string, unknown> | null = null;

function makeFakeClient(opts: { dupCheck?: boolean } = {}) {
  return {
    auth: {
      getUser: async () => ({
        data: { user: { id: USER_ID, email: "test@example.com" } },
        error: null,
      }),
    },
    from(table: string) {
      const obj: any = {
        select()                   { return obj; },
        insert(payload: unknown)   {
          if (table === "discovery_places") {
            lastInsertPayload = payload as Record<string, unknown>;
          }
          return obj;
        },
        eq()                       { return obj; },
        ilike()                    { return obj; },
        limit()                    { return obj; },
        maybeSingle: async () => ({
          data: opts.dupCheck ? null : null,
          error: null,
        }),
        single: async () => ({
          data: { id: PLACE_ID, name: "Test Place", city: "Paris", place_type: "hidden_gem", status: "active", created_at: "2026-07-24T00:00:00Z" },
          error: null,
        }),
      };
      return obj;
    },
  };
}

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

async function postCommunityPlace(
  url: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${url}/api/discovery/community`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer test-token`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/discovery/community — photos field", () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    lastInsertPayload = null;
    _setTestClient(makeFakeClient() as any, true);
    ({ server, url } = await startServer());
  });

  afterEach(async () => {
    _setTestClient(null as any);
    await closeServer(server);
  });

  it("text-only path: photos is null in the insert when no photos are provided", async () => {
    const { status } = await postCommunityPlace(url, {
      city: "Paris", name: "Rooftop Bar", place_type: "hidden_gem",
    });
    assert.equal(status, 201);
    assert.equal(lastInsertPayload?.photos, null);
  });

  it("photo path: photos array is included in the insert when photos are provided", async () => {
    const { status } = await postCommunityPlace(url, {
      city: "Paris", name: "Rooftop Bar", place_type: "hidden_gem",
      photos: [PHOTO_URL, PHOTO_URL2],
    });
    assert.equal(status, 201);
    assert.deepEqual(lastInsertPayload?.photos, [PHOTO_URL, PHOTO_URL2]);
  });

  it("caps photos at 3 even when more than 3 are sent", async () => {
    const { status } = await postCommunityPlace(url, {
      city: "Paris", name: "Rooftop Bar", place_type: "hidden_gem",
      photos: [PHOTO_URL, PHOTO_URL2, PHOTO_URL3, PHOTO_URL4],
    });
    assert.equal(status, 201);
    const saved = lastInsertPayload?.photos as string[];
    assert.equal(saved.length, 3);
    assert.deepEqual(saved, [PHOTO_URL, PHOTO_URL2, PHOTO_URL3]);
  });

  it("strips non-string entries from the photos array", async () => {
    const { status } = await postCommunityPlace(url, {
      city: "Paris", name: "Rooftop Bar", place_type: "hidden_gem",
      photos: [PHOTO_URL, 42, null, PHOTO_URL2],
    });
    assert.equal(status, 201);
    assert.deepEqual(lastInsertPayload?.photos, [PHOTO_URL, PHOTO_URL2]);
  });

  it("photos is null when an empty array is sent", async () => {
    const { status } = await postCommunityPlace(url, {
      city: "Paris", name: "Rooftop Bar", place_type: "hidden_gem",
      photos: [],
    });
    assert.equal(status, 201);
    assert.equal(lastInsertPayload?.photos, null);
  });
});
