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
    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const reqUrl = String(input);
      // Only intercept Foursquare calls; pass through others
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
      return originalFetch(input, _init);
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

// ── C2. Foursquare responds 429 — OUT OF CREDITS, not "busy" ─────────────────
//
// This is the state the live account was actually in on 2026-08-15, confirmed
// by direct call: HTTP 429 with body
// {"message":"Your account has no API credits remaining..."}.
//
// It matters that this does NOT collapse into the generic `foursquare_http_429`
// bucket. Ordinary 429 means "slow down, retry shortly"; this one means the
// account is out of credits and NO place will return a photo until someone
// tops it up. Reporting a persistent billing state as a transient rate limit
// invites a retry that can never succeed, and hides an outage behind a word
// that sounds temporary.
describe("GET /api/places/fsq-photo — Foursquare 429 out of credits", () => {
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
    process.env.FOURSQUARE_API_KEY = "valid-but-broke";
    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const reqUrl = String(input);
      if (reqUrl.includes("foursquare.com")) {
        return {
          ok: false,
          status: 429,
          json: async () => ({
            message:
              "Your account has no API credits remaining. Please visit your organization’s billing page",
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

  it("still degrades gracefully with HTTP 200 and a null photoUrl", async () => {
    const { status, body } = await getPhoto(url, { name: "Big Ben" });
    assert.equal(status, 200, `expected 200 (graceful degradation), got ${status}`);
    assert.equal(body.photoUrl, null, `expected null photoUrl on 429, got ${JSON.stringify(body.photoUrl)}`);
  });

  it("names the cause 'foursquare_quota_exhausted', NOT 'no_photo_found'", async () => {
    const { body } = await getPhoto(url, { name: "Big Ben" });
    assert.equal(
      body.reason,
      "foursquare_quota_exhausted",
      `expected 'foursquare_quota_exhausted', got '${body.reason as string}'`,
    );
    // The conflation this whole change exists to prevent: a dead provider must
    // never be reported as a fact about the place.
    assert.notEqual(
      body.reason,
      "no_photo_found",
      "an exhausted account is NOT evidence that this place has no photo",
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
