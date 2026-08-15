/**
 * lookupFoursquarePhoto — the server side of the Foursquare photo proxy.
 *
 * WHAT THIS REPLACED, AND WHY THE TESTS LOOK LIKE THIS
 * ===================================================
 * The client used to call places-api.foursquare.com directly, from the browser,
 * with a key compiled into the bundle. It failed two ways at once: that host
 * serves no browser CORS headers, so on web the request could not succeed at
 * all; and EXPO_PUBLIC_* ships to every browser that loads the app, so the
 * credential was public.
 *
 * The proxy fixes both. What these tests defend is the property that makes it
 * safe to call from an unauthenticated place card: **it never throws, and a
 * missing photo is never an error.** A photo that cannot be found is normal —
 * callers fall back to category artwork — so an exception here would turn a
 * cosmetic absence into a broken card, on a surface we are separately trying to
 * make reachable.
 *
 * Every failure mode therefore resolves to `{ photoUrl: null, reason }`, and
 * the `reason` is asserted rather than ignored: "no key configured" and "venue
 * has no photo" produce the same null and are operationally opposite.
 *
 * Runtime: node:test + node:assert/strict.
 * Run: node --import tsx/esm --test src/test/foursquarePhotoProxy.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { lookupFoursquarePhoto } from "../lib/foursquarePlaces.js";

const originalFetch = globalThis.fetch;
const originalKey = process.env.FOURSQUARE_API_KEY;

/** Records every outbound request so the request shape can be asserted. */
function makeFetch(status: number, body: unknown) {
  const captured: { url: string; init?: RequestInit }[] = [];
  const fn = (async (url: any, init?: RequestInit) => {
    captured.push({ url: String(url), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { fn, captured };
}

beforeEach(() => {
  process.env.FOURSQUARE_API_KEY = "server-side-key";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.FOURSQUARE_API_KEY;
  else process.env.FOURSQUARE_API_KEY = originalKey;
});

describe("lookupFoursquarePhoto — request shape", () => {
  it("A. calls Foursquare with the server-held key in an Authorization header", async () => {
    const { fn, captured } = makeFetch(200, { results: [] });
    globalThis.fetch = fn;

    await lookupFoursquarePhoto("Test Venue", 48.85, 2.35);

    assert.equal(captured.length, 1);
    assert.match(captured[0].url, /^https:\/\/places-api\.foursquare\.com\/places\/search/);
    const headers = captured[0].init?.headers as Record<string, string>;
    assert.equal(headers["Authorization"], "Bearer server-side-key");
  });

  it("B. asks only for the photos field, one result", async () => {
    // The client's old call requested exactly this. Keeping it narrow matters:
    // it is a paid API and this runs once per place card.
    const { fn, captured } = makeFetch(200, { results: [] });
    globalThis.fetch = fn;

    await lookupFoursquarePhoto("Test Venue", null, null);

    const url = new URL(captured[0].url);
    assert.equal(url.searchParams.get("fields"), "photos");
    assert.equal(url.searchParams.get("limit"), "1");
    assert.equal(url.searchParams.get("query"), "Test Venue");
  });

  it("C. sends ll only when BOTH coordinates are present and finite", async () => {
    for (const [lat, lng, expected] of [
      [48.85, 2.35, "48.85,2.35"],
      [48.85, null, null],
      [null, 2.35, null],
      [NaN, 2.35, null],
    ] as [number | null, number | null, string | null][]) {
      const { fn, captured } = makeFetch(200, { results: [] });
      globalThis.fetch = fn;
      await lookupFoursquarePhoto("V", lat, lng);
      assert.equal(new URL(captured[0].url).searchParams.get("ll"), expected);
    }
  });
});

describe("lookupFoursquarePhoto — resolution", () => {
  it("D. assembles prefix + original + suffix", async () => {
    // This is the assembly the client test suite CLAIMED to cover and did not:
    // its "photo URL assembly" block contained five tests that all fetched a
    // 500 and asserted null. Asserted here, where the logic now lives.
    const { fn } = makeFetch(200, {
      results: [{ photos: [{ prefix: "https://fastly.4sqi.net/img/general/", suffix: "/venue.jpg" }] }],
    });
    globalThis.fetch = fn;

    const r = await lookupFoursquarePhoto("Test Venue", null, null);
    assert.equal(r.photoUrl, "https://fastly.4sqi.net/img/general/original/venue.jpg");
    assert.equal(r.reason, undefined);
  });

  it("E. takes the FIRST photo when several are returned", async () => {
    const { fn } = makeFetch(200, {
      results: [{ photos: [
        { prefix: "https://a/", suffix: "/1.jpg" },
        { prefix: "https://b/", suffix: "/2.jpg" },
      ] }],
    });
    globalThis.fetch = fn;
    assert.equal((await lookupFoursquarePhoto("V", null, null)).photoUrl, "https://a/original/1.jpg");
  });
});

describe("lookupFoursquarePhoto — every failure is a null with a REASON", () => {
  it("F. no key configured", async () => {
    delete process.env.FOURSQUARE_API_KEY;
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("{}"); }) as typeof globalThis.fetch;

    const r = await lookupFoursquarePhoto("V", 1, 2);
    assert.deepEqual(r, { photoUrl: null, reason: "no_foursquare_key" });
    assert.equal(called, false, "must not call a paid API with no credential");
  });

  it("G. blank name never reaches the network", async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("{}"); }) as typeof globalThis.fetch;

    const r = await lookupFoursquarePhoto("   ", 1, 2);
    assert.deepEqual(r, { photoUrl: null, reason: "no_match" });
    assert.equal(called, false);
  });

  it("H. no results", async () => {
    const { fn } = makeFetch(200, { results: [] });
    globalThis.fetch = fn;
    assert.deepEqual(await lookupFoursquarePhoto("V", null, null), { photoUrl: null, reason: "no_match" });
  });

  it("I. a result with no photos is 'no_photo', NOT 'no_match'", async () => {
    // Operationally different: the venue was found and has no picture, versus
    // the venue was not found at all. Collapsing them would hide a name-matching
    // problem behind an apparently normal outcome.
    const { fn } = makeFetch(200, { results: [{ photos: [] }] });
    globalThis.fetch = fn;
    assert.deepEqual(await lookupFoursquarePhoto("V", null, null), { photoUrl: null, reason: "no_photo" });
  });

  it("J. a photo entry missing prefix or suffix is 'no_photo', not a broken URL", async () => {
    for (const photo of [{ prefix: "https://a/" }, { suffix: "/x.jpg" }, {}]) {
      const { fn } = makeFetch(200, { results: [{ photos: [photo] }] });
      globalThis.fetch = fn;
      const r = await lookupFoursquarePhoto("V", null, null);
      assert.equal(r.photoUrl, null, `must not assemble a URL from ${JSON.stringify(photo)}`);
      assert.equal(r.reason, "no_photo");
    }
  });

  it("K. 401 and 403 report auth_failed", async () => {
    for (const status of [401, 403]) {
      const { fn } = makeFetch(status, { message: "nope" });
      globalThis.fetch = fn;
      assert.deepEqual(
        await lookupFoursquarePhoto("V", null, null),
        { photoUrl: null, reason: "auth_failed" },
      );
    }
  });

  it("L. a 500 is request_failed, and does not throw", async () => {
    const { fn } = makeFetch(500, { message: "boom" });
    globalThis.fetch = fn;
    assert.deepEqual(
      await lookupFoursquarePhoto("V", null, null),
      { photoUrl: null, reason: "request_failed" },
    );
  });

  it("M. a rejecting fetch is request_failed, and does not throw", async () => {
    globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof globalThis.fetch;
    assert.deepEqual(
      await lookupFoursquarePhoto("V", null, null),
      { photoUrl: null, reason: "request_failed" },
    );
  });

  it("N. malformed JSON is request_failed, and does not throw", async () => {
    globalThis.fetch = (async () => new Response("not json", { status: 200 })) as typeof globalThis.fetch;
    assert.deepEqual(
      await lookupFoursquarePhoto("V", null, null),
      { photoUrl: null, reason: "request_failed" },
    );
  });

  it("O. a non-array results field does not throw", async () => {
    const { fn } = makeFetch(200, { results: "unexpected" });
    globalThis.fetch = fn;
    assert.equal((await lookupFoursquarePhoto("V", null, null)).photoUrl, null);
  });
});
