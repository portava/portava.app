/**
 * googlePhotoProxy.test.ts
 *
 * Integration tests for GET /api/places/photo — the server-side proxy that
 * performs Google Places (New) photo lookups and caches both positive and
 * negative results server-side (24 h TTL) so OSM places with no Google photo
 * never fire a second API call across client sessions.
 *
 * Scenarios covered:
 *  A. Key set + Google returns a photo    → { photoUrl: "https://..." }
 *  B. GOOGLE_MAPS_API_KEY absent          → { photoUrl: null, reason: "no_google_maps_key" }
 *  C. Google responds non-OK (SERVICE_DISABLED) → { photoUrl: null, reason: "google_places_api_new_service_disabled" }
 *  D. Google returns no places            → { photoUrl: null, reason: "no_photo_found" }
 *  E. Google returns a place with no photos → { photoUrl: null, reason: "no_photo_found" }
 *  F. Network / fetch throws              → { photoUrl: null, reason: "request_failed" }
 *  G. name missing or too long            → HTTP 400
 *  H. Second request for same place (no photo) does NOT call Google API
 *
 * Runtime: node:test + fetch, tsx/esm, no vitest.
 * Run:
 *   node --import tsx/esm --test src/test/googlePhotoProxy.test.ts
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { _setGooglePhotoCacheMaxForTest } from "../routes/places.js";

// ── Minimal fake Supabase client (route touches no DB tables) ─────────────────

function makeFakeClient() {
  return {
    from(_table: string) {
      const obj: any = {
        select()  { return obj; },
        eq()      { return obj; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        then(onF: any, onR: any) { return Promise.resolve({ data: [], error: null }).then(onF, onR); },
      };
      return obj;
    },
    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
    },
  };
}

// ── HTTP server helpers ───────────────────────────────────────────────────────

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

async function getPhoto(
  baseUrl: string,
  params: { name: string; lat?: number; lng?: number },
): Promise<{ status: number; body: any }> {
  const qs = new URLSearchParams({ name: params.name });
  if (params.lat != null) qs.set("lat", String(params.lat));
  if (params.lng != null) qs.set("lng", String(params.lng));
  const res = await fetch(`${baseUrl}/api/places/photo?${qs}`);
  return { status: res.status, body: await res.json() };
}

// ── Saved originals ───────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
const originalGoogleKey = process.env.GOOGLE_MAPS_API_KEY;

// ── A. Key set + Google returns a photo ───────────────────────────────────────

describe("GET /api/places/photo — happy path (photo returned)", () => {
  let server: Server;
  let url: string;

  before(async () => {
    ({ server, url } = await startServer());
    _setTestClient(makeFakeClient(), true);
  });

  after(async () => {
    _setTestClient(null, false);
    await closeServer(server);
  });

  beforeEach(() => {
    _setGooglePhotoCacheMaxForTest(Infinity); // clear cache before each test
    process.env.GOOGLE_MAPS_API_KEY = "test-google-key";
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const reqUrl = String(input);
      if (reqUrl.includes("places.googleapis.com")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            places: [
              { id: "ChIJN1t_tDeuEmsRUsoyG83frY4", photos: [{ name: "places/ChIJN1t_tDeuEmsRUsoyG83frY4/photos/AUGGfZk123" }] },
            ],
          }),
        } as Response;
      }
      return originalFetch(input, init);
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.GOOGLE_MAPS_API_KEY = originalGoogleKey;
    _setGooglePhotoCacheMaxForTest(Infinity);
  });

  it("returns HTTP 200", async () => {
    const { status } = await getPhoto(url, { name: "Eiffel Tower", lat: 48.858, lng: 2.294 });
    assert.equal(status, 200, `expected 200, got ${status}`);
  });

  it("returns a photoUrl string", async () => {
    const { body } = await getPhoto(url, { name: "Eiffel Tower", lat: 48.858, lng: 2.294 });
    assert.equal(typeof body.photoUrl, "string", `photoUrl must be a string, got ${JSON.stringify(body.photoUrl)}`);
    assert.ok(body.photoUrl.length > 0, "photoUrl must not be empty");
  });

  it("photoUrl is a Google Places media URL", async () => {
    const { body } = await getPhoto(url, { name: "Eiffel Tower", lat: 48.858, lng: 2.294 });
    assert.ok(
      (body.photoUrl as string).startsWith("https://places.googleapis.com/v1/places/"),
      `unexpected photoUrl: ${body.photoUrl as string}`,
    );
    assert.ok(
      (body.photoUrl as string).includes("/media?maxWidthPx=800"),
      `photoUrl must include media endpoint: ${body.photoUrl as string}`,
    );
  });

  it("does not include a 'reason' field on success", async () => {
    const { body } = await getPhoto(url, { name: "Eiffel Tower", lat: 48.858, lng: 2.294 });
    assert.equal(body.reason, undefined, `reason must be absent on success, got ${body.reason as string}`);
  });
});

// ── B. GOOGLE_MAPS_API_KEY absent ────────────────────────────────────────────

describe("GET /api/places/photo — no GOOGLE_MAPS_API_KEY", () => {
  let server: Server;
  let url: string;

  before(async () => {
    ({ server, url } = await startServer());
    _setTestClient(makeFakeClient(), true);
  });

  after(async () => {
    _setTestClient(null, false);
    await closeServer(server);
  });

  beforeEach(() => {
    _setGooglePhotoCacheMaxForTest(Infinity);
    delete process.env.GOOGLE_MAPS_API_KEY;
    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).includes("places.googleapis.com")) {
        throw new Error("fetch must not be called when GOOGLE_MAPS_API_KEY is absent");
      }
      return originalFetch(input, _init);
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.GOOGLE_MAPS_API_KEY = originalGoogleKey;
    _setGooglePhotoCacheMaxForTest(Infinity);
  });

  it("returns HTTP 200", async () => {
    const { status } = await getPhoto(url, { name: "Louvre" });
    assert.equal(status, 200, `expected 200, got ${status}`);
  });

  it("returns photoUrl: null", async () => {
    const { body } = await getPhoto(url, { name: "Louvre" });
    assert.equal(body.photoUrl, null, `expected null photoUrl, got ${JSON.stringify(body.photoUrl)}`);
  });

  it("returns reason: 'no_google_maps_key'", async () => {
    const { body } = await getPhoto(url, { name: "Louvre" });
    assert.equal(
      body.reason,
      "no_google_maps_key",
      `expected reason 'no_google_maps_key', got '${body.reason as string}'`,
    );
  });

  it("does not call Google when the key is absent", async () => {
    // The overridden fetch above throws if Google is hit — reaching here means it wasn't.
    const { body } = await getPhoto(url, { name: "Louvre" });
    assert.equal(body.reason, "no_google_maps_key");
  });
});

// ── C. Google responds non-OK (SERVICE_DISABLED) ──────────────────────────────

describe("GET /api/places/photo — Google Places API non-OK (SERVICE_DISABLED)", () => {
  let server: Server;
  let url: string;

  before(async () => {
    ({ server, url } = await startServer());
    _setTestClient(makeFakeClient(), true);
  });

  after(async () => {
    _setTestClient(null, false);
    await closeServer(server);
  });

  beforeEach(() => {
    _setGooglePhotoCacheMaxForTest(Infinity);
    process.env.GOOGLE_MAPS_API_KEY = "test-google-key";
    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).includes("places.googleapis.com")) {
        return {
          ok: false,
          status: 403,
          json: async () => ({
            error: {
              details: [
                {
                  reason: "SERVICE_DISABLED",
                  metadata: { activationUrl: "https://console.cloud.google.com/apis/enable" },
                },
              ],
            },
          }),
        } as Response;
      }
      return originalFetch(input, _init);
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.GOOGLE_MAPS_API_KEY = originalGoogleKey;
    _setGooglePhotoCacheMaxForTest(Infinity);
  });

  it("returns HTTP 200 (graceful degradation)", async () => {
    const { status } = await getPhoto(url, { name: "Big Ben" });
    assert.equal(status, 200, `expected 200 (graceful degradation), got ${status}`);
  });

  it("returns photoUrl: null on SERVICE_DISABLED", async () => {
    const { body } = await getPhoto(url, { name: "Big Ben" });
    assert.equal(body.photoUrl, null, `expected null photoUrl, got ${JSON.stringify(body.photoUrl)}`);
  });

  it("returns reason indicating google_places_api_new_service_disabled", async () => {
    const { body } = await getPhoto(url, { name: "Big Ben" });
    assert.equal(
      body.reason,
      "google_places_api_new_service_disabled",
      `expected 'google_places_api_new_service_disabled', got '${body.reason as string}'`,
    );
  });

  it("does NOT cache auth errors — second call still reaches Google", async () => {
    let googleCallCount = 0;
    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).includes("places.googleapis.com")) {
        googleCallCount++;
        return {
          ok: false,
          status: 403,
          json: async () => ({ error: { details: [{ reason: "SERVICE_DISABLED" }] } }),
        } as Response;
      }
      return originalFetch(input, _init);
    };

    await getPhoto(url, { name: "Parliament" });
    await getPhoto(url, { name: "Parliament" });

    assert.equal(googleCallCount, 2, `auth errors must not be cached; expected 2 Google calls, got ${googleCallCount}`);
  });
});

// ── D. Google returns no places ───────────────────────────────────────────────

describe("GET /api/places/photo — Google returns no places", () => {
  let server: Server;
  let url: string;

  before(async () => {
    ({ server, url } = await startServer());
    _setTestClient(makeFakeClient(), true);
  });

  after(async () => {
    _setTestClient(null, false);
    await closeServer(server);
  });

  beforeEach(() => {
    _setGooglePhotoCacheMaxForTest(Infinity);
    process.env.GOOGLE_MAPS_API_KEY = "test-google-key";
    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).includes("places.googleapis.com")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ places: [] }),
        } as Response;
      }
      return originalFetch(input, _init);
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.GOOGLE_MAPS_API_KEY = originalGoogleKey;
    _setGooglePhotoCacheMaxForTest(Infinity);
  });

  it("returns photoUrl: null when Google returns no places", async () => {
    const { body } = await getPhoto(url, { name: "Colosseum", lat: 41.89, lng: 12.492 });
    assert.equal(body.photoUrl, null, `expected null photoUrl, got ${JSON.stringify(body.photoUrl)}`);
  });

  it("returns reason: 'no_photo_found' when Google returns no places", async () => {
    const { body } = await getPhoto(url, { name: "Colosseum", lat: 41.89, lng: 12.492 });
    assert.equal(
      body.reason,
      "no_photo_found",
      `expected 'no_photo_found', got '${body.reason as string}'`,
    );
  });
});

// ── E. Google returns a place with no photos ──────────────────────────────────

describe("GET /api/places/photo — Google returns a place with no photos array", () => {
  let server: Server;
  let url: string;

  before(async () => {
    ({ server, url } = await startServer());
    _setTestClient(makeFakeClient(), true);
  });

  after(async () => {
    _setTestClient(null, false);
    await closeServer(server);
  });

  beforeEach(() => {
    _setGooglePhotoCacheMaxForTest(Infinity);
    process.env.GOOGLE_MAPS_API_KEY = "test-google-key";
    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).includes("places.googleapis.com")) {
        return {
          ok: true,
          status: 200,
          // Place found but no photos field
          json: async () => ({ places: [{ id: "ChIJxyz" }] }),
        } as Response;
      }
      return originalFetch(input, _init);
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.GOOGLE_MAPS_API_KEY = originalGoogleKey;
    _setGooglePhotoCacheMaxForTest(Infinity);
  });

  it("returns photoUrl: null when place has no photos", async () => {
    const { body } = await getPhoto(url, { name: "Alhambra", lat: 37.176, lng: -3.588 });
    assert.equal(body.photoUrl, null, `expected null photoUrl, got ${JSON.stringify(body.photoUrl)}`);
  });

  it("returns reason: 'no_photo_found' when place has no photos", async () => {
    const { body } = await getPhoto(url, { name: "Alhambra", lat: 37.176, lng: -3.588 });
    assert.equal(
      body.reason,
      "no_photo_found",
      `expected 'no_photo_found', got '${body.reason as string}'`,
    );
  });
});

// ── F. Network / fetch throws ─────────────────────────────────────────────────

describe("GET /api/places/photo — fetch throws (network error)", () => {
  let server: Server;
  let url: string;

  before(async () => {
    ({ server, url } = await startServer());
    _setTestClient(makeFakeClient(), true);
  });

  after(async () => {
    _setTestClient(null, false);
    await closeServer(server);
  });

  beforeEach(() => {
    _setGooglePhotoCacheMaxForTest(Infinity);
    process.env.GOOGLE_MAPS_API_KEY = "test-google-key";
    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).includes("places.googleapis.com")) {
        throw new TypeError("fetch failed");
      }
      return originalFetch(input, _init);
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.GOOGLE_MAPS_API_KEY = originalGoogleKey;
    _setGooglePhotoCacheMaxForTest(Infinity);
  });

  it("returns HTTP 200 (graceful degradation, never throws)", async () => {
    const { status } = await getPhoto(url, { name: "Acropolis" });
    assert.equal(status, 200, `expected 200, got ${status}`);
  });

  it("returns photoUrl: null on network error", async () => {
    const { body } = await getPhoto(url, { name: "Acropolis" });
    assert.equal(body.photoUrl, null, `expected null photoUrl on network error, got ${JSON.stringify(body.photoUrl)}`);
  });

  it("returns reason: 'request_failed' on network error", async () => {
    const { body } = await getPhoto(url, { name: "Acropolis" });
    assert.equal(
      body.reason,
      "request_failed",
      `expected 'request_failed', got '${body.reason as string}'`,
    );
  });
});

// ── G. name missing or too long ───────────────────────────────────────────────

describe("GET /api/places/photo — invalid 'name' param", () => {
  let server: Server;
  let url: string;

  before(async () => {
    ({ server, url } = await startServer());
    _setTestClient(makeFakeClient(), true);
    process.env.GOOGLE_MAPS_API_KEY = "test-google-key";
  });

  after(async () => {
    _setTestClient(null, false);
    delete process.env.GOOGLE_MAPS_API_KEY;
    process.env.GOOGLE_MAPS_API_KEY = originalGoogleKey;
    await closeServer(server);
  });

  it("returns HTTP 400 when name is missing", async () => {
    const res = await fetch(`${url}/api/places/photo`);
    assert.equal(res.status, 400, `expected 400 when name is absent, got ${res.status}`);
  });

  it("returns HTTP 400 when name is empty", async () => {
    const res = await fetch(`${url}/api/places/photo?name=`);
    assert.equal(res.status, 400, `expected 400 for empty name, got ${res.status}`);
  });

  it("returns HTTP 400 when name exceeds 200 characters", async () => {
    const longName = "a".repeat(201);
    const res = await fetch(`${url}/api/places/photo?name=${encodeURIComponent(longName)}`);
    assert.equal(res.status, 400, `expected 400 for oversized name, got ${res.status}`);
  });
});

// ── H. Second request does NOT call Google (negative result cached) ───────────
//
// This is the key regression test: an OSM place with no Google photo must NOT
// fire a second Google API call on the next client session. The server-side
// cache absorbs it.

describe("GET /api/places/photo — negative result is cached server-side", () => {
  let server: Server;
  let url: string;

  before(async () => {
    ({ server, url } = await startServer());
    _setTestClient(makeFakeClient(), true);
  });

  after(async () => {
    _setTestClient(null, false);
    await closeServer(server);
  });

  beforeEach(() => {
    _setGooglePhotoCacheMaxForTest(Infinity);
    process.env.GOOGLE_MAPS_API_KEY = "test-google-key";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.GOOGLE_MAPS_API_KEY = originalGoogleKey;
    _setGooglePhotoCacheMaxForTest(Infinity);
  });

  it("second request for same place does not call Google API", async () => {
    let googleCallCount = 0;
    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).includes("places.googleapis.com")) {
        googleCallCount++;
        return {
          ok: true,
          status: 200,
          json: async () => ({ places: [] }), // no photo found
        } as Response;
      }
      return originalFetch(input, _init);
    };

    const params = { name: "Unnamed OSM Viewpoint", lat: 35.012, lng: 135.768 };

    const first = await getPhoto(url, params);
    assert.equal(first.body.photoUrl, null, "first call should return null (no photo)");
    assert.equal(first.body.reason, "no_photo_found", "first call reason should be no_photo_found");
    assert.equal(googleCallCount, 1, `expected exactly 1 Google call on first request, got ${googleCallCount}`);

    const second = await getPhoto(url, params);
    assert.equal(second.body.photoUrl, null, "second call should also return null (from cache)");
    assert.equal(second.body.reason, "no_photo_found", "second call reason should be no_photo_found (from cache)");
    assert.equal(
      googleCallCount,
      1,
      `expected NO additional Google call on second request (served from cache), got ${googleCallCount}`,
    );
  });

  it("second request for same place with a photo also serves from cache", async () => {
    let googleCallCount = 0;
    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).includes("places.googleapis.com")) {
        googleCallCount++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            places: [{ id: "ChIJabc", photos: [{ name: "places/ChIJabc/photos/AUGGfZk999" }] }],
          }),
        } as Response;
      }
      return originalFetch(input, _init);
    };

    const params = { name: "Sagrada Familia", lat: 41.404, lng: 2.174 };

    const first = await getPhoto(url, params);
    assert.equal(typeof first.body.photoUrl, "string", "first call should return a photoUrl string");
    assert.equal(googleCallCount, 1, `expected 1 Google call, got ${googleCallCount}`);

    const second = await getPhoto(url, params);
    assert.equal(second.body.photoUrl, first.body.photoUrl, "second call should return the same URL (from cache)");
    assert.equal(googleCallCount, 1, `expected NO additional Google call on second request, got ${googleCallCount}`);
  });

  it("two concurrent requests for the same place trigger exactly one Google API call", async () => {
    let googleCallCount = 0;
    // Simulate a slow Google response so both in-flight requests are guaranteed
    // to be pending at the same time before either resolves.
    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).includes("places.googleapis.com")) {
        googleCallCount++;
        await new Promise((r) => setTimeout(r, 30));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            places: [{ id: "ChIJconc", photos: [{ name: "places/ChIJconc/photos/AUGGfZk_concurrent" }] }],
          }),
        } as Response;
      }
      return originalFetch(input, _init);
    };

    const params = { name: "Park Güell", lat: 41.414, lng: 2.152 };

    // Fire both requests at exactly the same time — the in-flight Map must
    // deduplicate them so only one reaches Google.
    const [first, second] = await Promise.all([
      getPhoto(url, params),
      getPhoto(url, params),
    ]);

    assert.equal(googleCallCount, 1, `in-flight dedup failed: expected 1 Google call, got ${googleCallCount}`);
    assert.equal(typeof first.body.photoUrl, "string", "first concurrent response should have a photoUrl");
    assert.equal(second.body.photoUrl, first.body.photoUrl, "both concurrent responses should return the same photoUrl");
  });
});
