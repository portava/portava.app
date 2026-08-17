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
import { _resetPlaceSearchCache } from "../routes/places.js";

import { namespaceGooglePlaceId, denamespaceGooglePlaceId } from "../lib/googlePlaceId.js";

// The place-search cache is module-level and keyed by query. Several cases in
// this file reuse the same `input`, so without this reset the second case
// asserts against the first case's cached answer instead of its own stub.
beforeEach(() => { _resetPlaceSearchCache(); });

process.env.GOOGLE_MAPS_API_KEY ??= "test-google-key";

const realFetch = globalThis.fetch;

/** One queued response per expected outbound call. */
let queue: Array<{ ok: boolean; status: number; body: unknown }> = [];
let calls: Array<{ url: string; init: any }> = [];

function installFetchStub(): void {
  globalThis.fetch = (async (url: any, init?: any) => {
    calls.push({ url: String(url), init });
    const next: any = queue.shift();
    if (!next) throw new Error(`unexpected fetch: ${String(url)}`);
    // A queued entry may be a fixed response, or a function of the request URL
    // so a stub can model an upstream that actually validates its input.
    const resolved = typeof next.onRequest === "function" ? next.onRequest(String(url)) : next;
    return {
      ok: resolved.ok,
      status: resolved.status,
      json: async () => resolved.body,
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

// ── THE ROUND TRIP ────────────────────────────────────────────────────────────
//
// This is the test whose absence let the two halves of one user flow disagree
// about the id format for three weeks, through a migration that touched BOTH
// routes in the same commit.
//
// autocomplete EMITTED `google-<id>`; details REQUIRED a bare `<id>`. Only a
// `.replace(/^google-/, '')` on the client bridged them, and nothing on the
// server knew that strip existed. Measured on production 2026-08-15:
//
//   place_id=google-ChIJ5TCOcRaYpBIRCmZHTz37sEQ
//     -> {"details":null,"reason":"google_places_new_invalid_argument"}
//   place_id=ChIJ5TCOcRaYpBIRCmZHTz37sEQ
//     -> {"details":{"lat":41.3874…,"lng":2.1686…}}
//
// Testing the two routes SEPARATELY could never have caught it: each was
// internally correct. Only feeding one's output into the other does.

describe("googlePlaceIdRoundTrip — autocomplete's id must work in details, verbatim", () => {
  it("id emitted by autocomplete, passed UNCHANGED to details, resolves", async () => {
    queue.push({
      ok: true,
      status: 200,
      body: {
        suggestions: [
          {
            placePrediction: {
              placeId: "ChIJ5TCOcRaYpBIRCmZHTz37sEQ",
              text: { text: "Barcelona, Spain" },
              types: ["locality"],
            },
          },
        ],
      },
    });
    const ac = await invoke("/places/google-autocomplete", { input: "Barcelona" });
    const emittedId = ac.body.places[0].id;
    assert.equal(emittedId, "google-ChIJ5TCOcRaYpBIRCmZHTz37sEQ");

    // The stub answers the way PRODUCTION GOOGLE ACTUALLY DID when handed a
    // namespaced id, measured 2026-08-15: INVALID_ARGUMENT. Without this the
    // round-trip test passes even with the defect present, because a stub that
    // returns success regardless of URL cannot detect a wrong URL — a test that
    // cannot fail is the thing this whole workstream exists to prevent.
    queue.push({
      onRequest: (url: string) =>
        url.includes("/places/google-")
          ? { ok: false, status: 400, body: { error: { status: "INVALID_ARGUMENT" } } }
          : {
              ok: true,
              status: 200,
              body: {
                location: { latitude: 41.3874374, longitude: 2.1686496 },
                formattedAddress: "Barcelona, Spain",
              },
            },
    } as any);
    // NO transformation. That is the entire point.
    const det = await invoke("/places/google-details", { place_id: emittedId });

    assert.deepEqual(det.body.details, {
      lat: 41.3874374,
      lng: 2.1686496,
      formattedAddress: "Barcelona, Spain",
    });
    assert.equal(det.body.reason, undefined);
  });

  it("the id reaching Google is the BARE one — the namespace never leaves us", async () => {
    queue.push({ ok: true, status: 200, body: { location: { latitude: 1, longitude: 2 } } });
    await invoke("/places/google-details", { place_id: "google-ChIJ_ABC" });
    assert.match(calls[0].url, /\/v1\/places\/ChIJ_ABC$/);
    assert.ok(!calls[0].url.includes("google-"), "the prefix is ours, not Google's");
  });

  it("the BARE form still works — the live client strips the prefix itself", async () => {
    // Non-negotiable: production works today because the client strips. A fix
    // that only accepted the namespaced form would break the working path.
    queue.push({ ok: true, status: 200, body: { location: { latitude: 1, longitude: 2 } } });
    const { body } = await invoke("/places/google-details", { place_id: "ChIJ_ABC" });
    assert.deepEqual(body.details, { lat: 1, lng: 2, formattedAddress: "" });
  });

  it("only ONE prefix is stripped — an opaque id starting with the literal text survives", async () => {
    queue.push({ ok: true, status: 200, body: { location: { latitude: 1, longitude: 2 } } });
    await invoke("/places/google-details", { place_id: "google-google-weird" });
    assert.match(calls[0].url, /\/v1\/places\/google-weird$/);
  });

  it("namespacing is idempotent — no google-google- can be produced", () => {
    assert.equal(namespaceGooglePlaceId("ChIJ_ABC"), "google-ChIJ_ABC");
    assert.equal(namespaceGooglePlaceId("google-ChIJ_ABC"), "google-ChIJ_ABC");
    assert.equal(denamespaceGooglePlaceId(namespaceGooglePlaceId("ChIJ_ABC")), "ChIJ_ABC");
  });

  it("BOTH SIDES USE THE SHARED DEFINITION — neither re-hardcodes the prefix", async () => {
    // The defect was two independent string literals. If someone reintroduces
    // one, the constant can be changed here and this test will catch the half
    // that did not follow.
    const { readFileSync } = await import("node:fs");
    const routes = readFileSync(
      new URL("../routes/places.ts", import.meta.url).pathname,
      "utf8",
    );
    // Comments are allowed to name the prefix — documenting the contract is the
    // point. Only CODE re-hardcoding it is the defect, so strip comment lines
    // before scanning rather than banning the string outright.
    const codeLines = routes
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    const hardcoded = codeLines.match(/["'`]google-/g) ?? [];
    assert.deepEqual(
      hardcoded,
      [],
      `routes/places.ts re-hardcodes the namespace in CODE: ${hardcoded.join(", ")} — use lib/googlePlaceId.ts`,
    );

    // Vacuity guard: if the scan removed everything, it proves nothing.
    assert.ok(codeLines.length > 5000, "comment-stripping removed too much — the scan is not examining the file");
  });
});
