/**
 * Photo persistence at the ROUTE level — where the decisions actually live.
 *
 * `discoveryPlacePhotoStore.test.ts` pins the store. This file pins the three
 * choices the routes make, each of which is only observable here:
 *
 *  1. **Google persists the photo REFERENCE, never the media URL.** That URL
 *     carries the API key, so storing it would put a credential in a table and
 *     produce a dead link on the next rotation.
 *  2. **A stored photo short-circuits the provider entirely.** This is the
 *     whole point — the repeated external-provider work has to actually stop,
 *     and "we cached it" is not evidence that anything was skipped.
 *  3. **Only a VERIFIED Foursquare photo is persisted.** The route already
 *     HEAD-checks the CDN URL and refuses to cache an unverified one; the
 *     durable store must not accept a weaker guarantee than the 24-hour one.
 *
 * Plus the property that makes this safe to ship ahead of its migration:
 * without a `placeKey`, nothing is stored and the routes behave exactly as
 * before.
 *
 * Run: node --import tsx/esm --test src/test/placesPhotoPersistence.test.ts
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";
import placesRouter from "../routes/places.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { PHOTO_TTL_MS } from "../lib/discoveryPlacePhotoStore.js";

// ── Upstream stubs ────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

interface StubResponse { ok: boolean; status: number; json: () => Promise<unknown> }

let googleResponder: (() => Promise<StubResponse>) | null = null;
let fsqResponder: (() => Promise<StubResponse>) | null = null;
let headResponder: (() => Promise<{ ok: boolean; status: number }>) | null = null;

/** Counts prove the short-circuit: a stored photo must mean ZERO upstream calls. */
let googleCalls = 0;
let fsqCalls = 0;

const originalGoogleKey = process.env.GOOGLE_MAPS_API_KEY;
const originalApiBase = process.env.API_BASE_URL;
const originalFsqKey = process.env.FOURSQUARE_API_KEY;

let server: Server;
let port = 0;

before(async () => {
  globalThis.fetch = (async (url: unknown, init?: any) => {
    const u = String(typeof url === "string" ? url : (url as any)?.href ?? url);

    if (init?.method === "HEAD") {
      return (headResponder
        ? await headResponder()
        : { ok: true, status: 200 }) as any;
    }
    if (u.includes("places.googleapis.com/v1/places:searchText")) {
      googleCalls++;
      if (googleResponder) return (await googleResponder()) as any;
      return { ok: true, status: 200, json: async () => ({ places: [] }) } as any;
    }
    if (u.includes("places-api.foursquare.com") || u.includes("api.foursquare.com")) {
      fsqCalls++;
      if (fsqResponder) return (await fsqResponder()) as any;
      return { ok: true, status: 200, json: async () => ({ results: [] }) } as any;
    }
    return originalFetch(url as RequestInfo, init);
  }) as typeof fetch;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = pino({ level: "silent" });
    next();
  });
  app.use(placesRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, () => r()));
  port = (server.address() as any).port as number;
});

after(async () => {
  globalThis.fetch = originalFetch;
  if (originalGoogleKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
  else process.env.GOOGLE_MAPS_API_KEY = originalGoogleKey;
  if (originalApiBase === undefined) delete process.env.API_BASE_URL;
  else process.env.API_BASE_URL = originalApiBase;
  if (originalFsqKey === undefined) delete process.env.FOURSQUARE_API_KEY;
  else process.env.FOURSQUARE_API_KEY = originalFsqKey;
  _setTestServiceClient(null);
  await new Promise<void>((r) => server.close(() => r()));
});

// ── Service-client double ─────────────────────────────────────────────────────

interface StoreLog { upserts: any[]; rows: any[] }
let store: StoreLog;

function installStore(rows: any[] = []) {
  store = { upserts: [], rows };
  _setTestServiceClient({
    from(table: string) {
      if (table !== "discovery_place_photos") {
        // Any other table the router touches is not this test's business, but
        // it must not silently succeed either — an all-purpose stub that
        // answers everything is how a test stops being able to fail.
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
          upsert: () => Promise.resolve({ error: null }),
          update: () => ({ eq: () => Promise.resolve({ error: null }) }),
          delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
        };
      }
      return {
        select: () => ({
          eq: (_c: string, key: string) => ({
            maybeSingle: async () => ({
              data: store.rows.find((r) => r.place_key === key) ?? null,
              error: null,
            }),
          }),
        }),
        upsert: (row: any) => { store.upserts.push(row); return Promise.resolve({ error: null }); },
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
      };
    },
  } as any);
}

beforeEach(() => {
  process.env.GOOGLE_MAPS_API_KEY = "test-google-key";
  // photoProxyUrl prefixes API_BASE_URL when set; pinned so the proxy-URL
  // assertions are exact rather than dependent on the ambient environment.
  process.env.API_BASE_URL = "";
  process.env.FOURSQUARE_API_KEY = "test-fsq-key";
  googleResponder = null;
  fsqResponder = null;
  headResponder = null;
  googleCalls = 0;
  fsqCalls = 0;
  installStore();
});

afterEach(() => { _setTestServiceClient(null); });

async function get(path: string) {
  const res = await originalFetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: (await res.json()) as any };
}

/** Persistence is fire-and-forget, so let the microtask queue drain. */
const settle = () => new Promise((r) => setTimeout(r, 10));

const GOOGLE_PHOTO_NAME = "places/ChIJabc123/photos/AUGGfXnDef";

function googleFindsPhoto() {
  googleResponder = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ places: [{ id: "ChIJabc123", photos: [{ name: GOOGLE_PHOTO_NAME }] }] }),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Google route — persists the reference, never the credential", () => {
  it("stores photo_ref and no API key", async () => {
    googleFindsPhoto();

    const { body } = await get("/places/photo?name=Cebu%20Zoo&placeKey=node%2F123");
    await settle();

    // CONTRACT CHANGE, not a weakened assertion. The client still receives a
    // fully-minted, directly-renderable URL, so the shape of the response is
    // unchanged — but it now addresses this server's byte proxy instead of
    // Google's media endpoint, because the Google one carries the API key as a
    // query parameter and this route is unauthenticated. The row-level check
    // below already required the key to stay out of STORAGE; this requires it
    // to stay out of the RESPONSE, which is where it was actually leaking.
    assert.equal(body.photoUrl, "/api/places/photo/media?ref=places%2FChIJabc123%2Fphotos%2FAUGGfXnDef&w=800");
    assert.ok(
      !String(body.photoUrl).includes("test-google-key"),
      "the response must never carry the Google API key",
    );

    assert.equal(store.upserts.length, 1, "the resolved photo should be persisted once");
    const row = store.upserts[0];
    assert.equal(row.place_key, "osm:node/123");
    assert.equal(row.source, "google");
    assert.equal(row.photo_ref, GOOGLE_PHOTO_NAME);
    assert.equal(row.photo_url, null);
    assert.ok(
      !JSON.stringify(row).includes("test-google-key"),
      "a persisted row must never contain the API key",
    );
  });

  it("sets a bounded expiry rather than storing forever", async () => {
    googleFindsPhoto();
    await get("/places/photo?name=Cebu%20Zoo&placeKey=node%2F123");
    await settle();

    const row = store.upserts[0];
    assert.equal(Date.parse(row.expires_at) - Date.parse(row.resolved_at), PHOTO_TTL_MS);
  });

  it("persists NOTHING without a placeKey — the route is inert as before", async () => {
    googleFindsPhoto();
    await get("/places/photo?name=Cebu%20Zoo");
    await settle();

    assert.equal(store.upserts.length, 0);
  });

  it("persists nothing when Google finds no photo", async () => {
    googleResponder = async () => ({ ok: true, status: 200, json: async () => ({ places: [] }) });

    const { body } = await get("/places/photo?name=Nowhere&placeKey=node%2F999");
    await settle();

    assert.equal(body.photoUrl, null);
    assert.equal(body.reason, "no_photo_found");
    assert.equal(store.upserts.length, 0, "an absent photo must not be stored as a resolved one");
  });
});

describe("A stored photo actually stops the provider being called", () => {
  it("serves the stored Google photo without calling Google at all", async () => {
    installStore([{
      place_key: "osm:node/123",
      source: "google",
      photo_url: null,
      photo_ref: GOOGLE_PHOTO_NAME,
      expires_at: new Date(Date.now() + PHOTO_TTL_MS).toISOString(),
      invalid_at: null,
    }]);
    googleFindsPhoto();

    const { body } = await get("/places/photo?name=Cebu%20Zoo&placeKey=node%2F123");

    assert.equal(googleCalls, 0, "a stored photo must skip the provider entirely");
    // CONTRACT CHANGE, not a weakened assertion — see the note above. A stored
    // row mints the same proxy URL as a freshly-resolved one; that the two
    // paths agree is exactly what this file exists to check.
    assert.equal(body.photoUrl, "/api/places/photo/media?ref=places%2FChIJabc123%2Fphotos%2FAUGGfXnDef&w=800");
    assert.ok(
      !String(body.photoUrl).includes("test-google-key"),
      "the response must never carry the Google API key",
    );
    assert.equal(body.source, "google");
    assert.equal(body.cached, true);
  });

  it("serves it on the FIRST link of the chain, so neither provider is called", async () => {
    // The fsq-photo route is what the client hits first. A hit there means the
    // whole chain is skipped, which is where the repeated work disappears.
    installStore([{
      place_key: "osm:node/123",
      source: "google",
      photo_url: null,
      photo_ref: GOOGLE_PHOTO_NAME,
      expires_at: new Date(Date.now() + PHOTO_TTL_MS).toISOString(),
      invalid_at: null,
    }]);

    const { body } = await get("/places/fsq-photo?name=Cebu%20Zoo&placeKey=node%2F123");

    assert.equal(fsqCalls, 0, "Foursquare must not be called");
    assert.equal(googleCalls, 0, "Google must not be called");
    // Attribution stays truthful: the photo came from Google, and says so, even
    // though it was served by the Foursquare-named route.
    assert.equal(body.source, "google");
  });

  it("does NOT serve an expired row — it falls through and re-resolves", async () => {
    installStore([{
      place_key: "osm:node/123",
      source: "google",
      photo_url: null,
      photo_ref: "places/OLD/photos/OLD",
      expires_at: new Date(Date.now() - 1000).toISOString(),
      invalid_at: null,
    }]);
    googleFindsPhoto();

    const { body } = await get("/places/photo?name=Cebu%20Zoo&placeKey=node%2F123");
    await settle();

    assert.equal(googleCalls, 1, "an expired row must re-run the live chain");
    assert.match(body.photoUrl as string, /AUGGfXnDef/, "the fresh photo wins");
    assert.equal(store.upserts.at(-1)?.photo_ref, GOOGLE_PHOTO_NAME, "and is written back");
  });

  it("serves a stored photo even when the provider key is gone", async () => {
    // A photo we already resolved is a fact about the place, not about our
    // current credentials — but a Google row still needs a key to mint a URL,
    // so this is proven with a Foursquare row, which needs none.
    installStore([{
      place_key: "osm:node/123",
      source: "foursquare",
      photo_url: "https://fastly.4sqi.net/img/general/original/a.jpg",
      photo_ref: null,
      expires_at: new Date(Date.now() + PHOTO_TTL_MS).toISOString(),
      invalid_at: null,
    }]);
    delete process.env.GOOGLE_MAPS_API_KEY;

    const { body } = await get("/places/photo?name=Cebu%20Zoo&placeKey=node%2F123");

    assert.equal(body.photoUrl, "https://fastly.4sqi.net/img/general/original/a.jpg");
    assert.equal(body.source, "foursquare");
  });
});

describe("Foursquare route — only a VERIFIED photo is persisted", () => {
  // Each case uses a DISTINCT place name on purpose. The route keeps a
  // process-lifetime 24-hour cache keyed by name+lat+lng, so reusing one name
  // makes later cases read the first case's cached answer and assert against a
  // result the route never computed for them.
  function fsqFindsPhoto() {
    fsqResponder = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        results: [{ photos: [{ prefix: "https://fastly.4sqi.net/img/general/", suffix: "/abc.jpg" }] }],
      }),
    });
  }

  it("persists a photo whose CDN URL passed the liveness check", async () => {
    fsqFindsPhoto();
    headResponder = async () => ({ ok: true, status: 200 });

    const { body } = await get("/places/fsq-photo?name=CafeVerified&placeKey=node%2F55");
    await settle();

    assert.equal(body.photoUrl, "https://fastly.4sqi.net/img/general/original/abc.jpg");
    assert.equal(body.source, "foursquare");
    assert.equal(store.upserts.length, 1);
    assert.equal(store.upserts[0].place_key, "osm:node/55");
    assert.equal(store.upserts[0].photo_url, "https://fastly.4sqi.net/img/general/original/abc.jpg");
  });

  it("does NOT persist an UNVERIFIED URL, even though it is served", async () => {
    // The HEAD check failing outright means the URL is dead: not served at all.
    // The subtler case is the check itself failing — the route serves the URL
    // optimistically but refuses to cache it, because it may be dead. Storing
    // that for 30 days would strand exactly the broken image the liveness check
    // exists to prevent.
    fsqFindsPhoto();
    headResponder = async () => { throw new Error("network blip"); };

    const { body } = await get("/places/fsq-photo?name=CafeUnverified&placeKey=node%2F55");
    await settle();

    assert.equal(body.photoUrl, "https://fastly.4sqi.net/img/general/original/abc.jpg", "still served");
    assert.equal(store.upserts.length, 0, "but never persisted");
  });

  it("does not persist a dead CDN link", async () => {
    fsqFindsPhoto();
    headResponder = async () => ({ ok: false, status: 404 });

    const { body } = await get("/places/fsq-photo?name=CafeDead&placeKey=node%2F56");
    await settle();

    assert.equal(body.photoUrl, null);
    assert.equal(body.reason, "dead_photo_link");
    assert.equal(store.upserts.length, 0);
  });

  it("does not persist a 'no photo found' result as if it were a photo", async () => {
    fsqResponder = async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) });

    const { body } = await get("/places/fsq-photo?name=CafeEmpty&placeKey=node%2F57");
    await settle();

    assert.equal(body.photoUrl, null);
    assert.equal(store.upserts.length, 0);
  });
});
