/**
 * google-autocomplete / google-details on Places API (New).
 *
 * WHY THESE EXIST AT ALL
 * ======================
 * Before 2026-08-15 these two routes had **no tests whatsoever**. That is not
 * incidental to the defect they carried — it is part of it. A route that
 * returns an empty list on every failure path, with nothing asserting which
 * path was taken, cannot be caught by anything except someone noticing that
 * destination search feels wrong.
 *
 * So these tests pin the CONTRACT, not the implementation:
 *
 *   1. the response shapes the client already depends on
 *      (`body.places ?? []`, `body.details`, `id: "google-<placeId>"`);
 *   2. that failures are DISTINGUISHABLE from each other and from success;
 *   3. that an empty answer Google actually gave is NOT reported as a fault.
 *
 * Point 3 is the one most likely to be "simplified" away later by someone
 * tidying up what looks like a missing else-branch.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.GOOGLE_MAPS_API_KEY ??= "test-google-key";

const realFetch = globalThis.fetch;

/** One queued response per expected outbound call. */
let queue: Array<{ ok: boolean; status: number; body: unknown }> = [];
let calls: Array<{ url: string; init: any }> = [];

function installFetchStub(): void {
  globalThis.fetch = (async (url: any, init?: any) => {
    calls.push({ url: String(url), init });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch: ${String(url)}`);
    return {
      ok: next.ok,
      status: next.status,
      json: async () => next.body,
    } as any;
  }) as any;
}

before(installFetchStub);
after(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  queue = [];
  calls = [];
});

/** Invoke a router handler directly — no server, no port. */
async function invoke(
  path: string,
  query: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const mod = await import("../routes/places.js");
  const router: any = (mod as any).default;
  const layer = router.stack.find(
    (l: any) => l.route?.path === path && l.route?.methods?.get,
  );
  assert.ok(layer, `route not found: ${path}`);

  const req: any = { query, headers: {}, log: console };
  let statusCode = 200;
  let payload: any;
  const res: any = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    json(b: any) {
      payload = b;
      return res;
    },
  };
  await new Promise<void>((resolve, reject) => {
    layer.route.stack[0].handle(req, res, (e: any) => (e ? reject(e) : resolve()));
    setTimeout(resolve, 0);
  });
  // Handlers are async; give the microtask queue a chance to settle.
  for (let i = 0; i < 50 && payload === undefined; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return { status: statusCode, body: payload };
}

describe("google-autocomplete — talks to Places API (New), key in the HEADER", () => {
  it("POSTs to places:autocomplete with X-Goog-Api-Key and no key in the URL", async () => {
    queue.push({ ok: true, status: 200, body: { suggestions: [] } });
    await invoke("/places/google-autocomplete", { input: "Barcelona" });

    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /places\.googleapis\.com\/v1\/places:autocomplete/);
    assert.equal(calls[0].init.method, "POST");
    assert.ok(calls[0].init.headers["X-Goog-Api-Key"], "key must travel in the header");
    // The whole point of the header form: the secret is not in the URL.
    assert.ok(!calls[0].url.includes("key="), "key must NOT be in the query string");
  });

  it("never calls the legacy maps.googleapis.com surface", async () => {
    queue.push({ ok: true, status: 200, body: { suggestions: [] } });
    await invoke("/places/google-autocomplete", { input: "Barcelona" });
    assert.ok(!calls[0].url.includes("maps.googleapis.com"));
  });

  it("maps suggestions to the Place shape the client already consumes", async () => {
    queue.push({
      ok: true,
      status: 200,
      body: {
        suggestions: [
          {
            placePrediction: {
              placeId: "ChIJ_BARCELONA",
              text: { text: "Barcelona, Spain" },
              structuredFormat: { mainText: { text: "Barcelona" } },
              types: ["locality"],
            },
          },
        ],
      },
    });
    const { body } = await invoke("/places/google-autocomplete", { input: "Barcelona" });

    assert.equal(body.powered_by, "google");
    assert.equal(body.places.length, 1);
    // The client does `place.id.replace(/^google-/, '')` before calling details.
    assert.equal(body.places[0].id, "google-ChIJ_BARCELONA");
    assert.equal(body.places[0].name, "Barcelona");
    assert.equal(body.places[0].displayName, "Barcelona, Spain");
    assert.equal(body.places[0].type, "city");
    assert.equal(body.places[0].source, "google");
    assert.equal(body.places[0].lat, null, "autocomplete carries no coordinates");
    assert.equal(body.reason, undefined, "success carries no reason");
  });

  it("caps at 5 and drops malformed predictions rather than emitting 'google-undefined'", async () => {
    queue.push({
      ok: true,
      status: 200,
      body: {
        suggestions: [
          { placePrediction: { placeId: "a", text: { text: "A" }, types: [] } },
          { queryPrediction: { text: { text: "not a place" } } },
          { placePrediction: { text: { text: "no id" }, types: [] } },
          ...Array.from({ length: 6 }, (_, i) => ({
            placePrediction: { placeId: `x${i}`, text: { text: `X${i}` }, types: [] },
          })),
        ],
      },
    });
    const { body } = await invoke("/places/google-autocomplete", { input: "x" });
    assert.equal(body.places.length, 5);
    assert.ok(body.places.every((p: any) => !p.id.includes("undefined")));
  });

  it("EMPTY SUGGESTIONS IS NOT A FAULT — no reason, because Google answered", async () => {
    queue.push({ ok: true, status: 200, body: { suggestions: [] } });
    const { body } = await invoke("/places/google-autocomplete", { input: "zzzzzz" });
    assert.deepEqual(body.places, []);
    assert.equal(body.reason, undefined, "a real empty answer must not be reported as a failure");
  });

  it("translates the city filter and country filter to New API fields", async () => {
    queue.push({ ok: true, status: 200, body: { suggestions: [] } });
    await invoke("/places/google-autocomplete", {
      input: "Barc",
      type: "city",
      countryCode: "ES",
    });
    const sent = JSON.parse(calls[0].init.body);
    assert.deepEqual(sent.includedPrimaryTypes, ["(cities)"]);
    assert.deepEqual(sent.includedRegionCodes, ["es"], "CLDR region codes are lowercase");
  });
});

describe("google-autocomplete — failures are AUDIBLE and distinguishable", () => {
  it("SERVICE_DISABLED surfaces as a specific reason, not an empty list", async () => {
    queue.push({
      ok: false,
      status: 403,
      body: {
        error: {
          status: "PERMISSION_DENIED",
          message: "Places API (New) has not been used in project ...",
          details: [{ reason: "SERVICE_DISABLED", metadata: { activationUrl: "https://…" } }],
        },
      },
    });
    const { body } = await invoke("/places/google-autocomplete", { input: "Barcelona" });
    assert.deepEqual(body.places, []);
    assert.equal(body.reason, "google_places_new_service_disabled");
  });

  it("an HTTP failure with an unusable body still names the HTTP code", async () => {
    queue.push({ ok: false, status: 502, body: null });
    const { body } = await invoke("/places/google-autocomplete", { input: "Barcelona" });
    assert.equal(body.reason, "google_places_new_http_502");
  });

  it("THE ORIGINAL DEFECT: a refusal and a genuine no-match are NOT the same response", async () => {
    queue.push({ ok: true, status: 200, body: { suggestions: [] } });
    const noMatch = await invoke("/places/google-autocomplete", { input: "zzzzzz" });

    queue.push({
      ok: false,
      status: 403,
      body: { error: { details: [{ reason: "SERVICE_DISABLED" }] } },
    });
    const refused = await invoke("/places/google-autocomplete", { input: "Barcelona" });

    assert.deepEqual(noMatch.body.places, refused.body.places, "both are empty — that part is unchanged");
    assert.notDeepEqual(
      noMatch.body.reason,
      refused.body.reason,
      "but they MUST be distinguishable — this is the whole defect",
    );
  });

  it("rejects an over-long input before making any call", async () => {
    const { status, body } = await invoke("/places/google-autocomplete", { input: "x".repeat(201) });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
    assert.equal(calls.length, 0, "must not call Google with a payload it will reject");
  });
});

describe("google-details — Place Details by id, not a text search", () => {
  it("GETs the place resource with a mandatory field mask", async () => {
    queue.push({
      ok: true,
      status: 200,
      body: { location: { latitude: 41.38, longitude: 2.17 }, formattedAddress: "Barcelona, Spain" },
    });
    await invoke("/places/google-details", { place_id: "ChIJ_BARCELONA" });

    assert.match(calls[0].url, /places\.googleapis\.com\/v1\/places\/ChIJ_BARCELONA$/);
    assert.ok(calls[0].init.headers["X-Goog-FieldMask"], "field mask is mandatory on this endpoint");
    assert.ok(calls[0].init.headers["X-Goog-Api-Key"]);
    // searchText resolves free text and could return a DIFFERENT place. Using
    // it for an exact id would let a chosen destination silently become a
    // nearby one.
    assert.ok(!calls[0].url.includes("searchText"));
  });

  it("returns the {lat, lng, formattedAddress} shape the client destructures", async () => {
    queue.push({
      ok: true,
      status: 200,
      body: { location: { latitude: 41.38, longitude: 2.17 }, formattedAddress: "Barcelona, Spain" },
    });
    const { body } = await invoke("/places/google-details", { place_id: "ChIJ_BARCELONA" });
    assert.deepEqual(body.details, { lat: 41.38, lng: 2.17, formattedAddress: "Barcelona, Spain" });
  });

  it("percent-encodes the place id rather than interpolating it raw into a path", async () => {
    queue.push({ ok: true, status: 200, body: { location: { latitude: 1, longitude: 2 } } });
    await invoke("/places/google-details", { place_id: "a/b?c" });
    assert.ok(!calls[0].url.includes("a/b?c"));
    assert.match(calls[0].url, /a%2Fb%3Fc$/);
  });

  it("a place with no usable location is 'no_geometry', NOT a provider refusal", async () => {
    queue.push({ ok: true, status: 200, body: { formattedAddress: "somewhere" } });
    const { body } = await invoke("/places/google-details", { place_id: "x" });
    assert.equal(body.details, null);
    assert.equal(body.reason, "no_geometry");
  });

  it("a refusal names itself", async () => {
    queue.push({
      ok: false,
      status: 403,
      body: { error: { details: [{ reason: "SERVICE_DISABLED" }] } },
    });
    const { body } = await invoke("/places/google-details", { place_id: "x" });
    assert.equal(body.details, null);
    assert.equal(body.reason, "google_places_new_service_disabled");
  });

  it("no_geometry and a refusal are distinguishable", async () => {
    queue.push({ ok: true, status: 200, body: { formattedAddress: "somewhere" } });
    const a = await invoke("/places/google-details", { place_id: "x" });
    queue.push({ ok: false, status: 403, body: { error: { details: [{ reason: "SERVICE_DISABLED" }] } } });
    const b = await invoke("/places/google-details", { place_id: "y" });
    assert.equal(a.body.details, b.body.details, "both null");
    assert.notEqual(a.body.reason, b.body.reason, "for different reasons");
  });
});
