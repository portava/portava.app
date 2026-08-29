/**
 * GET /api/places/photo — Google Places (New) photo fallback chain.
 *
 * Confirms:
 *  1. When Google Places (New) returns a place with a photo name, the endpoint
 *     constructs and returns the full media URL — this is what Discovery place
 *     cards receive after the API is enabled on the Google Cloud project.
 *  2. When the API is disabled (SERVICE_DISABLED), the endpoint returns
 *     { photoUrl: null, reason: "google_places_api_new_service_disabled" } so
 *     the client can fall through to category artwork without guessing why.
 *  3. When Google returns a place but no photos, the endpoint returns
 *     { photoUrl: null, reason: "no_photo_found" }.
 *  4. When Google returns zero places, the endpoint also returns
 *     { photoUrl: null, reason: "no_photo_found" }.
 *  5. When GOOGLE_MAPS_API_KEY is absent, { photoUrl: null, reason: "no_google_maps_key" }.
 *  6. A missing or empty `name` query param returns 400 invalid_payload.
 *
 * Run: node --import tsx/esm --test src/test/placesPhoto.test.ts
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";
import placesRouter from "../routes/places.js";

// ── fetch stub ────────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

type FetchResponder = () => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

let googleResponder: FetchResponder | null = null;

function stubGoogle(responder: FetchResponder) {
  googleResponder = responder;
}

const originalKey = process.env.GOOGLE_MAPS_API_KEY;
const originalApiBase = process.env.API_BASE_URL;

let server: Server;
let port = 0;

before(async () => {
  globalThis.fetch = (async (url: unknown, _init?: unknown) => {
    const u = String(typeof url === "string" ? url : (url as any)?.href ?? url);
    if (u.includes("places.googleapis.com/v1/places:searchText")) {
      if (googleResponder) return googleResponder();
      // Default: empty results list — no place found.
      return { ok: true, status: 200, json: async () => ({ places: [] }) } as any;
    }
    return originalFetch(url as RequestInfo, _init as RequestInit | undefined);
  }) as typeof fetch;

  const app = express();
  app.use(express.json());
  // NOTE: placesRouter calls req.log — shim it so the router doesn't crash
  // under node:test where pino-http middleware is absent.
  app.use((req, _res, next) => {
    (req as any).log = pino({ level: "silent" });
    next();
  });
  app.use(placesRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as any).port as number;
});

after(async () => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
  else process.env.GOOGLE_MAPS_API_KEY = originalKey;
  if (originalApiBase === undefined) delete process.env.API_BASE_URL;
  else process.env.API_BASE_URL = originalApiBase;
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  process.env.GOOGLE_MAPS_API_KEY = "test-google-key";
  // photoProxyUrl prefixes API_BASE_URL when set; pinned so the proxy-URL
  // assertions are exact rather than dependent on the ambient environment.
  process.env.API_BASE_URL = "";
  googleResponder = null;
});

afterEach(() => {
  googleResponder = null;
});

async function get(path: string) {
  const res = await originalFetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: (await res.json()) as any };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/places/photo", () => {
  it("returns a photoUrl when Google Places (New) finds a place with photos", async () => {
    const photoName = "places/ChIJabc123/photos/AUGGfXnDef";
    stubGoogle(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        places: [{ id: "ChIJabc123", photos: [{ name: photoName }] }],
      }),
    }));

    const { status, body } = await get("/places/photo?name=Cebu%20Zoo");

    assert.equal(status, 200);
    // CONTRACT CHANGE, not a weakened assertion. This previously required
    // photoUrl to be Google's own media URL with GOOGLE_MAPS_API_KEY embedded
    // in it. This route has no auth guard, so that response published the key
    // to anyone who asked — the leak 744a10d86 closed. The route now returns a
    // URL addressing this server's byte proxy, which holds the key server-side.
    // The added negative assertion is the property that actually matters and is
    // the one the old assertion required to be false.
    assert.equal(typeof body.photoUrl, "string", "photoUrl should be a string");
    assert.equal(
      body.photoUrl,
      "/api/places/photo/media?ref=places%2FChIJabc123%2Fphotos%2FAUGGfXnDef&w=800",
      "photoUrl should address the server-side byte proxy, keyed by photo reference",
    );
    assert.ok(
      !String(body.photoUrl).includes("test-google-key"),
      "an unauthenticated response must never carry the Google API key",
    );
    assert.equal(body.reason, undefined, "reason should be absent on success");
  });

  it("returns { photoUrl: null, reason: 'google_places_api_new_service_disabled' } when the API is disabled", async () => {
    stubGoogle(async () => ({
      ok: false,
      status: 403,
      json: async () => ({
        error: {
          code: 403,
          message: "Places API (New) is not enabled on this project.",
          details: [
            {
              reason: "SERVICE_DISABLED",
              metadata: {
                activationUrl:
                  "https://console.developers.google.com/apis/api/places.googleapis.com/overview?project=1019840900693",
              },
            },
          ],
        },
      }),
    }));

    const { status, body } = await get("/places/photo?name=Cebu%20Zoo");

    assert.equal(status, 200);
    assert.equal(body.photoUrl, null);
    assert.equal(
      body.reason,
      "google_places_api_new_service_disabled",
      "reason must identify the disabled API so the operator knows exactly which Cloud API to enable",
    );
  });

  it("returns { photoUrl: null, reason: 'no_photo_found' } when the place has no photos", async () => {
    stubGoogle(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        places: [{ id: "ChIJnophoto", photos: [] }],
      }),
    }));

    const { status, body } = await get("/places/photo?name=Obscure%20Venue");

    assert.equal(status, 200);
    assert.equal(body.photoUrl, null);
    assert.equal(body.reason, "no_photo_found");
  });

  it("returns { photoUrl: null, reason: 'no_photo_found' } when Google returns no places", async () => {
    // Default responder returns { places: [] }.
    const { status, body } = await get("/places/photo?name=Unknown%20Place");

    assert.equal(status, 200);
    assert.equal(body.photoUrl, null);
    assert.equal(body.reason, "no_photo_found");
  });

  it("returns { photoUrl: null, reason: 'no_google_maps_key' } when GOOGLE_MAPS_API_KEY is absent", async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;

    const { status, body } = await get("/places/photo?name=Cebu%20Zoo");

    assert.equal(status, 200);
    assert.equal(body.photoUrl, null);
    assert.equal(body.reason, "no_google_maps_key");
  });

  it("rejects a missing name with 400 invalid_payload", async () => {
    const { status, body } = await get("/places/photo?name=");

    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });

  it("includes lat/lng in the location bias when both are provided", async () => {
    let capturedBody: unknown = null;
    stubGoogle(async () => {
      // The real stub captures the request body — simulate a fetch that
      // reads from the call that was made.
      return {
        ok: true,
        status: 200,
        json: async () => ({ places: [] }),
      };
    });

    // Override fetch to capture the POST body sent to Google.
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      const u = String(typeof url === "string" ? url : (url as any)?.href ?? url);
      if (u.includes("places.googleapis.com/v1/places:searchText")) {
        capturedBody = JSON.parse((init as any)?.body ?? "{}");
        return { ok: true, status: 200, json: async () => ({ places: [] }) } as any;
      }
      return original(url as RequestInfo, init as RequestInit | undefined);
    }) as typeof fetch;

    try {
      await get("/places/photo?name=Cebu%20Zoo&lat=10.311&lng=123.891");
    } finally {
      globalThis.fetch = original;
    }

    assert.ok(capturedBody, "fetch should have been called");
    const b = capturedBody as any;
    assert.equal(b.textQuery, "Cebu Zoo");
    assert.ok(
      b.locationBias?.circle?.center?.latitude === 10.311 &&
        b.locationBias?.circle?.center?.longitude === 123.891,
      "locationBias should carry the lat/lng from the query string",
    );
  });
});
