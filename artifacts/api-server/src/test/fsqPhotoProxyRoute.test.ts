/**
 * GET /api/places/fsq-photo — route-level tests.
 *
 * WHY THIS EXISTS ALONGSIDE foursquarePhotoProxy.test.ts
 * =====================================================
 * That file tests `lookupFoursquarePhoto` directly and covers the Foursquare
 * contract exhaustively. It cannot tell you the route is REGISTERED, that it
 * survives the Express layer, or that it is the only handler on its path.
 *
 * Adapted from a parallel implementation of this same fix (Replit task
 * 747fc9e7), which reached the same route path and the same response shape
 * independently. Its end-to-end coverage was the part worth keeping; the
 * reasons are this tree's.
 *
 * THE DUPLICATE-ROUTE TEST IS THE POINT
 * =====================================
 * Two implementations of this proxy existed at once, both registering
 * `/places/fsq-photo`. Express does not warn about that: the first handler
 * wins and the second is silently dead. A shadowed route is a swallowed
 * failure with no error anywhere — a second, divergent implementation that
 * looks live in source and never executes. So the route table is asserted to
 * contain exactly one.
 *
 * Runtime: node:test + node:assert/strict.
 * Run: node --import tsx/esm --test src/test/fsqPhotoProxyRoute.test.ts
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import app from "../app.js";

const originalFetch = globalThis.fetch;
const originalKey = process.env.FOURSQUARE_API_KEY;

function startServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function getPhoto(base: string, q: Record<string, string | number>) {
  const params = new URLSearchParams(
    Object.entries(q).map(([k, v]) => [k, String(v)]),
  );
  const res = await originalFetch(`${base}/api/places/fsq-photo?${params}`);
  return { status: res.status, body: (await res.json()) as any };
}

/** Intercepts only Foursquare calls; everything else passes through. */
function stubFoursquare(status: number, body: unknown) {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    if (String(input).includes("foursquare.com")) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;
}

describe("GET /api/places/fsq-photo — route registration", () => {
  it("is registered exactly ONCE — a shadowed duplicate is a silent dead route", () => {
    // Express keeps the mounted stack on app._router (app.router on v5). A
    // second handler on the same method+path never runs and never warns, which
    // is exactly how two competing implementations of this proxy could both
    // appear correct in source.
    const router: any = (app as any)._router ?? (app as any).router;
    assert.ok(router?.stack, "could not reach the Express route stack");

    const matches: string[] = [];
    const walk = (stack: any[], prefix = "") => {
      for (const layer of stack) {
        if (layer.route?.path) {
          const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
          for (const p of paths) {
            if (String(p).includes("fsq-photo")) matches.push(prefix + p);
          }
        } else if (layer.handle?.stack) {
          walk(layer.handle.stack, prefix);
        }
      }
    };
    walk(router.stack);

    assert.equal(
      matches.length,
      1,
      `expected exactly one /fsq-photo route, found ${matches.length}: ${JSON.stringify(matches)}. ` +
        `A duplicate registration is silently dead code — the first handler wins.`,
    );
  });
});

describe("GET /api/places/fsq-photo — end to end", () => {
  let server: Server;
  let url: string;

  before(async () => { ({ server, url } = await startServer()); });
  after(async () => { await closeServer(server); });

  beforeEach(() => { process.env.FOURSQUARE_API_KEY = "test-fsq-key"; });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.FOURSQUARE_API_KEY;
    else process.env.FOURSQUARE_API_KEY = originalKey;
  });

  it("200 with a resolved photoUrl and NO reason on success", async () => {
    stubFoursquare(200, {
      results: [{ photos: [{ prefix: "https://fastly.4sqi.net/img/general/", suffix: "/photo.jpg" }] }],
    });

    const { status, body } = await getPhoto(url, { name: "Eiffel Tower", lat: 48.858, lng: 2.294 });
    assert.equal(status, 200);
    assert.equal(body.photoUrl, "https://fastly.4sqi.net/img/general/original/photo.jpg");
    assert.equal(body.reason, undefined, "success must not carry a reason");
  });

  it("200 with photoUrl null and a reason when Foursquare 401s — never a 5xx", async () => {
    // The whole contract: a place card must degrade to category artwork, not
    // receive an error. A 5xx here would turn a missing picture into a broken
    // card on the surface we are trying to make reachable.
    stubFoursquare(401, { message: "unauthorized" });

    const { status, body } = await getPhoto(url, { name: "Eiffel Tower" });
    assert.equal(status, 200);
    assert.equal(body.photoUrl, null);
    assert.equal(body.reason, "auth_failed");
  });

  it("200 with a PER-STATUS reason on a non-auth HTTP error", async () => {
    stubFoursquare(429, { message: "slow down" });

    const { status, body } = await getPhoto(url, { name: "Eiffel Tower" });
    assert.equal(status, 200);
    assert.equal(body.photoUrl, null);
    assert.equal(body.reason, "foursquare_http_429", "rate limiting must be distinguishable");
  });

  it("200 with reason no_foursquare_key when the server holds no credential", async () => {
    delete process.env.FOURSQUARE_API_KEY;
    let calledFsq = false;
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      if (String(input).includes("foursquare.com")) { calledFsq = true; }
      return originalFetch(input, init);
    }) as typeof globalThis.fetch;

    const { status, body } = await getPhoto(url, { name: "Eiffel Tower" });
    assert.equal(status, 200);
    assert.equal(body.photoUrl, null);
    assert.equal(body.reason, "no_foursquare_key");
    assert.equal(calledFsq, false, "must not call a paid API with no credential");
  });

  it("400 when name is missing — the one case that IS a client error", async () => {
    const res = await originalFetch(`${url}/api/places/fsq-photo`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as any;
    assert.equal(body.error, "invalid_payload");
  });

  it("400 when name exceeds the length cap", async () => {
    const { status } = await getPhoto(url, { name: "x".repeat(201) });
    assert.equal(status, 400);
  });

  it("requires NO authentication — place cards render signed-out", async () => {
    // Discovery serves anonymous traffic. Requiring a session here would blank
    // the cards this endpoint exists to fill.
    stubFoursquare(200, { results: [] });
    const { status } = await getPhoto(url, { name: "Somewhere" });
    assert.equal(status, 200, "an unauthenticated request must be served");
  });
});
