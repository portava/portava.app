/**
 * fsqPhotoProxy.test.ts
 *
 * Integration tests for GET /api/places/fsq-photo — the server-side proxy
 * that routes Foursquare photo lookups through the api-server so the browser
 * is never blocked by CORS (Foursquare does not emit Access-Control-Allow-Origin).
 *
 * Scenarios covered:
 *  A. Key set + Foursquare returns a photo  → { photoUrl: "https://..." }
 *  B. FOURSQUARE_API_KEY absent             → { photoUrl: null, reason: "no_foursquare_key" }
 *  C. Foursquare responds 401               → { photoUrl: null, reason: "foursquare_auth_error" }
 *  D. Foursquare responds 403               → { photoUrl: null, reason: "foursquare_auth_error" }
 *  E. Photo entry has prefix: null          → { photoUrl: null, reason: "no_photo_found" }
 *  F. Photo entry has suffix: null          → { photoUrl: null, reason: "no_photo_found" }
 *  G. Photo entry has both prefix+suffix absent → { photoUrl: null, reason: "no_photo_found" }
 *
 * Runtime: node:test + supertest-style fetch, tsx/esm, no vitest.
 * Run:
 *   node --import tsx/esm --test src/test/fsqPhotoProxy.test.ts
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { _setFsqPhotoCacheMaxForTest } from "../routes/places.js";

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
  const res = await fetch(`${baseUrl}/api/places/fsq-photo?${qs}`);
  return { status: res.status, body: await res.json() };
}

// ── Saved originals ───────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
const originalFsqKey = process.env.FOURSQUARE_API_KEY;

// ── A. Key set + Foursquare returns a photo ───────────────────────────────────

describe("GET /api/places/fsq-photo — happy path (photo returned)", () => {
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
    process.env.FOURSQUARE_API_KEY = "test-fsq-key";
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const reqUrl = String(input);
      // Intercept Foursquare Places API search call
      if (reqUrl.includes("foursquare.com")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              {
                photos: [
                  { prefix: "https://fastly.4sqi.net/img/general/", suffix: "/photo.jpg" },
                ],
              },
            ],
          }),
        } as Response;
      }
      // Intercept the HEAD liveness check to the Foursquare CDN
      if (reqUrl.includes("4sqi.net") && init?.method === "HEAD") {
        return { ok: true, status: 200 } as Response;
      }
      return originalFetch(input, init);
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.FOURSQUARE_API_KEY = originalFsqKey;
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

  it("photoUrl is assembled as prefix + 'original' + suffix", async () => {
    const { body } = await getPhoto(url, { name: "Eiffel Tower", lat: 48.858, lng: 2.294 });
    assert.equal(
      body.photoUrl,
      "https://fastly.4sqi.net/img/general/original/photo.jpg",
      `unexpected photoUrl: ${body.photoUrl as string}`,
    );
  });

  it("does not include a 'reason' field on success", async () => {
    const { body } = await getPhoto(url, { name: "Eiffel Tower", lat: 48.858, lng: 2.294 });
    assert.equal(body.reason, undefined, `reason must be absent on success, got ${body.reason as string}`);
  });
});

// ── B. FOURSQUARE_API_KEY absent ──────────────────────────────────────────────

describe("GET /api/places/fsq-photo — no FOURSQUARE_API_KEY", () => {
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
    delete process.env.FOURSQUARE_API_KEY;
    // fetch should NOT be called at all; override to detect any accidental call
    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const reqUrl = String(input);
      if (reqUrl.includes("foursquare.com")) {
        throw new Error("fetch must not be called when FOURSQUARE_API_KEY is absent");
      }
      return originalFetch(input, _init);
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.FOURSQUARE_API_KEY = originalFsqKey;
  });

  it("returns HTTP 200", async () => {
    const { status } = await getPhoto(url, { name: "Louvre" });
    assert.equal(status, 200, `expected 200, got ${status}`);
  });

  it("returns photoUrl: null", async () => {
    const { body } = await getPhoto(url, { name: "Louvre" });
    assert.equal(body.photoUrl, null, `expected null photoUrl, got ${JSON.stringify(body.photoUrl)}`);
  });

  it("returns reason: 'no_foursquare_key'", async () => {
    const { body } = await getPhoto(url, { name: "Louvre" });
    assert.equal(
      body.reason,
      "no_foursquare_key",
      `expected reason 'no_foursquare_key', got '${body.reason as string}'`,
    );
  });

  it("does not call Foursquare when the key is absent", async () => {
    // The overridden fetch above throws if Foursquare is hit — reaching here means it wasn't.
    const { body } = await getPhoto(url, { name: "Louvre" });
    assert.equal(body.reason, "no_foursquare_key");
  });
});

// ── C. Foursquare responds 401 ────────────────────────────────────────────────

describe("GET /api/places/fsq-photo — Foursquare 401 auth error", () => {
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
    process.env.FOURSQUARE_API_KEY = "invalid-key";
    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const reqUrl = String(input);
      if (reqUrl.includes("foursquare.com")) {
        return {
          ok: false,
          status: 401,
          json: async () => ({ message: "Unauthorized" }),
        } as Response;
      }
      return originalFetch(input, _init);
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.FOURSQUARE_API_KEY = originalFsqKey;
  });

  it("returns HTTP 200 (graceful degradation, never throws)", async () => {
    const { status } = await getPhoto(url, { name: "Big Ben" });
    assert.equal(status, 200, `expected 200 (graceful degradation), got ${status}`);
  });

  it("returns photoUrl: null on 401", async () => {
    const { body } = await getPhoto(url, { name: "Big Ben" });
    assert.equal(body.photoUrl, null, `expected null photoUrl on 401, got ${JSON.stringify(body.photoUrl)}`);
  });

  it("returns reason: 'foursquare_auth_error' on 401", async () => {
    const { body } = await getPhoto(url, { name: "Big Ben" });
    assert.equal(
      body.reason,
      "foursquare_auth_error",
      `expected reason 'foursquare_auth_error', got '${body.reason as string}'`,
    );
  });
});

// ── D. Foursquare responds 403 ────────────────────────────────────────────────

describe("GET /api/places/fsq-photo — Foursquare 403 auth error", () => {
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
    process.env.FOURSQUARE_API_KEY = "forbidden-key";
    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const reqUrl = String(input);
      if (reqUrl.includes("foursquare.com")) {
        return {
          ok: false,
          status: 403,
          json: async () => ({ message: "Forbidden" }),
        } as Response;
      }
      return originalFetch(input, _init);
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.FOURSQUARE_API_KEY = originalFsqKey;
  });

  it("returns HTTP 200 (graceful degradation, never throws)", async () => {
    const { status } = await getPhoto(url, { name: "Colosseum" });
    assert.equal(status, 200, `expected 200 (graceful degradation), got ${status}`);
  });

  it("returns photoUrl: null on 403", async () => {
    const { body } = await getPhoto(url, { name: "Colosseum" });
    assert.equal(body.photoUrl, null, `expected null photoUrl on 403, got ${JSON.stringify(body.photoUrl)}`);
  });

  it("returns reason: 'foursquare_auth_error' on 403", async () => {
    const { body } = await getPhoto(url, { name: "Colosseum" });
    assert.equal(
      body.reason,
      "foursquare_auth_error",
      `expected reason 'foursquare_auth_error' on 403, got '${body.reason as string}'`,
    );
  });
});

// ── E. Photo entry has prefix: null ──────────────────────────────────────────

describe("GET /api/places/fsq-photo — photo entry has prefix: null", () => {
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
    process.env.FOURSQUARE_API_KEY = "test-fsq-key";
    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const reqUrl = String(input);
      if (reqUrl.includes("foursquare.com")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              {
                photos: [
                  { prefix: null, suffix: "/photo.jpg" },
                ],
              },
            ],
          }),
        } as Response;
      }
      return originalFetch(input, _init);
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.FOURSQUARE_API_KEY = originalFsqKey;
  });

  it("returns photoUrl: null when prefix is null", async () => {
    const { body } = await getPhoto(url, { name: "Sagrada Familia", lat: 41.404, lng: 2.174 });
    assert.equal(body.photoUrl, null, `expected null photoUrl, got ${JSON.stringify(body.photoUrl)}`);
  });

  it("returns reason: 'no_photo_found' when prefix is null", async () => {
    const { body } = await getPhoto(url, { name: "Sagrada Familia", lat: 41.404, lng: 2.174 });
    assert.equal(
      body.reason,
      "no_photo_found",
      `expected reason 'no_photo_found', got '${body.reason as string}'`,
    );
  });
});

// ── F. Photo entry has suffix: null ──────────────────────────────────────────

describe("GET /api/places/fsq-photo — photo entry has suffix: null", () => {
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
    process.env.FOURSQUARE_API_KEY = "test-fsq-key";
    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const reqUrl = String(input);
      if (reqUrl.includes("foursquare.com")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              {
                photos: [
                  { prefix: "https://fastly.4sqi.net/img/general/", suffix: null },
                ],
              },
            ],
          }),
        } as Response;
      }
      return originalFetch(input, _init);
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.FOURSQUARE_API_KEY = originalFsqKey;
  });

  it("returns photoUrl: null when suffix is null", async () => {
    const { body } = await getPhoto(url, { name: "Alhambra", lat: 37.176, lng: -3.588 });
    assert.equal(body.photoUrl, null, `expected null photoUrl, got ${JSON.stringify(body.photoUrl)}`);
  });

  it("returns reason: 'no_photo_found' when suffix is null", async () => {
    const { body } = await getPhoto(url, { name: "Alhambra", lat: 37.176, lng: -3.588 });
    assert.equal(
      body.reason,
      "no_photo_found",
      `expected reason 'no_photo_found', got '${body.reason as string}'`,
    );
  });
});

// ── G. Photo entry has both prefix and suffix absent ─────────────────────────

describe("GET /api/places/fsq-photo — photo entry has both prefix and suffix absent", () => {
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
    process.env.FOURSQUARE_API_KEY = "test-fsq-key";
    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const reqUrl = String(input);
      if (reqUrl.includes("foursquare.com")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              {
                photos: [{}],
              },
            ],
          }),
        } as Response;
      }
      return originalFetch(input, _init);
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.FOURSQUARE_API_KEY = originalFsqKey;
  });

  it("returns photoUrl: null when both prefix and suffix are absent", async () => {
    const { body } = await getPhoto(url, { name: "Acropolis", lat: 37.971, lng: 23.726 });
    assert.equal(body.photoUrl, null, `expected null photoUrl, got ${JSON.stringify(body.photoUrl)}`);
  });

  it("returns reason: 'no_photo_found' when both prefix and suffix are absent", async () => {
    const { body } = await getPhoto(url, { name: "Acropolis", lat: 37.971, lng: 23.726 });
    assert.equal(
      body.reason,
      "no_photo_found",
      `expected reason 'no_photo_found', got '${body.reason as string}'`,
    );
  });
});

// ── H. HEAD check network failure — result not cached; next request retries FSQ ─
//
// When the CDN HEAD liveness check throws (timeout, network blip), the proxy
// must serve the URL for the current request but NOT cache it. A subsequent
// request for the same place must re-query FSQ rather than serving a cached
// unverified URL that may be dead.

describe("GET /api/places/fsq-photo — HEAD check throws; result must NOT be cached", () => {
  let server: Server;
  let url: string;
  let fsqCallCount = 0;

  before(async () => {
    ({ server, url } = await startServer());
    _setTestClient(makeFakeClient(), true);
  });

  after(async () => {
    _setTestClient(null, false);
    await closeServer(server);
    globalThis.fetch = originalFetch;
    process.env.FOURSQUARE_API_KEY = originalFsqKey;
  });

  before(() => {
    process.env.FOURSQUARE_API_KEY = "test-fsq-key-head-throw";
    // Unique name + coords to avoid collisions with other describe blocks.
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const reqUrl = String(input);
      if (reqUrl.includes("foursquare.com")) {
        fsqCallCount += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              { photos: [{ prefix: "https://fastly.4sqi.net/img/general/", suffix: "/cdnthrow.jpg" }] },
            ],
          }),
        } as Response;
      }
      // HEAD check to the CDN throws (network blip / timeout)
      if (reqUrl.includes("4sqi.net") && init?.method === "HEAD") {
        throw new Error("network blip — HEAD check unavailable");
      }
      return originalFetch(input, init);
    };
  });

  it("first request: returns the photoUrl despite the HEAD failure (best-effort serve)", async () => {
    const { body } = await getPhoto(url, { name: "Off-Grid Shack Head Throw", lat: 55.0, lng: -3.0 });
    // The URL is served optimistically even though the HEAD check threw.
    assert.equal(
      typeof body.photoUrl,
      "string",
      `first call: expected a string photoUrl, got ${JSON.stringify(body.photoUrl)}`,
    );
  });

  it("second request for same place: FSQ is called again (result was not cached)", async () => {
    await getPhoto(url, { name: "Off-Grid Shack Head Throw", lat: 55.0, lng: -3.0 });
    // If the first result had been cached, fsqCallCount would still be 1.
    assert.equal(
      fsqCallCount,
      2,
      `expected 2 FSQ calls after 2 requests when HEAD check throws (no caching), got ${fsqCallCount}`,
    );
  });
});

// ── I. Negative-result caching — FSQ not called on second request ─────────────
//
// When Foursquare returns no photo for a place, the server caches the negative
// result (24 h TTL). Subsequent requests for the same place must be served
// from cache — the Foursquare API must NOT be called again.
//
// This is the core correctness guarantee of the fix: OSM places with no FSQ
// record stop permanently hammering the proxy on every card impression.

describe("GET /api/places/fsq-photo — negative result is cached (no second FSQ call)", () => {
  let server: Server;
  let url: string;
  let fsqCallCount = 0;

  before(async () => {
    ({ server, url } = await startServer());
    _setTestClient(makeFakeClient(), true);
  });

  after(async () => {
    _setTestClient(null, false);
    await closeServer(server);
    globalThis.fetch = originalFetch;
    process.env.FOURSQUARE_API_KEY = originalFsqKey;
  });

  before(() => {
    process.env.FOURSQUARE_API_KEY = "test-fsq-key-cache";
    // Unique name + coords so this describe's entries don't collide with
    // any other describe block's cache entries.
    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const reqUrl = String(input);
      if (reqUrl.includes("foursquare.com")) {
        fsqCallCount += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ results: [] }), // no venues → no photo
        } as Response;
      }
      return originalFetch(input, _init);
    };
  });

  it("first request: returns photoUrl null and reason no_photo_found", async () => {
    const { body } = await getPhoto(url, { name: "Niche Local Market", lat: 10.001, lng: 20.001 });
    assert.equal(body.photoUrl, null, `first call: expected null photoUrl, got ${JSON.stringify(body.photoUrl)}`);
    assert.equal(
      body.reason,
      "no_photo_found",
      `first call: expected reason 'no_photo_found', got '${body.reason as string}'`,
    );
  });

  it("second request for same place: still returns photoUrl null", async () => {
    const { body } = await getPhoto(url, { name: "Niche Local Market", lat: 10.001, lng: 20.001 });
    assert.equal(body.photoUrl, null, `second call: expected null photoUrl, got ${JSON.stringify(body.photoUrl)}`);
    assert.equal(
      body.reason,
      "no_photo_found",
      `second call: expected reason 'no_photo_found', got '${body.reason as string}'`,
    );
  });

  it("Foursquare API was called exactly once for two requests (negative result cached)", async () => {
    // Both previous `it` blocks have already run. fsqCallCount == 1 if the
    // second request was served from the server-side negative cache.
    assert.equal(
      fsqCallCount,
      1,
      `expected exactly 1 FSQ API call for two requests to the same place, got ${fsqCallCount}`,
    );
  });
});

// ── J. Cache capacity eviction — oldest entry evicted when cap is reached ──────
//
// writeFsqPhotoCached evicts the oldest (Map insertion-order) entry whenever
// the cache would exceed FSQ_PHOTO_CACHE_MAX. This test sets the max to 1,
// caches one negative result, then makes a request for a different place —
// after which the first entry must have been evicted and a subsequent request
// for it must call FSQ again rather than being served from cache.

describe("GET /api/places/fsq-photo — capacity cap: oldest entry evicted at max size", () => {
  let server: Server;
  let url: string;
  // Track FSQ call counts per place name (keyed by the query param value).
  const fsqCalls: Record<string, number> = {};

  before(async () => {
    ({ server, url } = await startServer());
    _setTestClient(makeFakeClient(), true);
    // Cap at 1 entry so any second write evicts the first.
    _setFsqPhotoCacheMaxForTest(1);
  });

  after(async () => {
    _setFsqPhotoCacheMaxForTest(Infinity); // restore default (5 000)
    _setTestClient(null, false);
    await closeServer(server);
    globalThis.fetch = originalFetch;
    process.env.FOURSQUARE_API_KEY = originalFsqKey;
  });

  before(() => {
    process.env.FOURSQUARE_API_KEY = "test-fsq-key-cap";
    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const reqUrl = String(input);
      if (reqUrl.includes("foursquare.com")) {
        const qs = new URL(reqUrl).searchParams;
        const q = qs.get("query") ?? "unknown";
        fsqCalls[q] = (fsqCalls[q] ?? 0) + 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ results: [] }), // no photo → negative result
        } as Response;
      }
      return originalFetch(input, _init);
    };
  });

  it("first request: Alpha is cached (1 FSQ call)", async () => {
    await getPhoto(url, { name: "Cap Place Alpha", lat: 1.0, lng: 1.0 });
    assert.equal(fsqCalls["Cap Place Alpha"] ?? 0, 1, "expected 1 FSQ call for Alpha");
  });

  it("second request for Alpha: served from cache (no new FSQ call)", async () => {
    await getPhoto(url, { name: "Cap Place Alpha", lat: 1.0, lng: 1.0 });
    assert.equal(
      fsqCalls["Cap Place Alpha"],
      1,
      `expected Alpha still cached (1 FSQ call), got ${fsqCalls["Cap Place Alpha"]}`,
    );
  });

  it("inserting Beta evicts Alpha (cap = 1); Alpha re-request now fires FSQ again", async () => {
    // Cache Beta → Alpha evicted (cache at cap).
    await getPhoto(url, { name: "Cap Place Beta", lat: 2.0, lng: 2.0 });
    assert.equal(fsqCalls["Cap Place Beta"] ?? 0, 1, "expected 1 FSQ call for Beta");

    // Alpha must have been evicted — a fresh request goes to FSQ (count → 2).
    await getPhoto(url, { name: "Cap Place Alpha", lat: 1.0, lng: 1.0 });
    assert.equal(
      fsqCalls["Cap Place Alpha"],
      2,
      `expected 2 FSQ calls for Alpha after eviction (got ${fsqCalls["Cap Place Alpha"]})`,
    );
  });
});
