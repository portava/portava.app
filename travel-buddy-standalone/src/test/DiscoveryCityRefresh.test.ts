/**
 * DiscoveryCityRefresh.test.ts  (standalone)
 *
 * Verifies that changing the city parameter passed to fetchCompassTravelerMatches
 * and fetchCompassBuddyMatches triggers a new fetch with the updated city value
 * encoded in the URL query params.
 *
 * Tests the real service functions with mocked fetch to assert that:
 *   - each unique city produces a distinct URL
 *   - city appears as a query param on the /api/compass/recommendations endpoint
 *   - null/undefined city omits the param entirely
 *
 * Run: node --import tsx --test src/test/DiscoveryCityRefresh.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  _setTestAuthToken,
  fetchCompassTravelerMatches,
  fetchCompassBuddyMatches,
} from "../services/compass.ts";

const FAKE_TOKEN = "fake-test-token-city-refresh";
const API_BASE   = "http://localhost:9998";

let _savedFetch: typeof globalThis.fetch;
let capturedUrls: string[] = [];

before(() => {
  _savedFetch = globalThis.fetch;
  _setTestAuthToken(FAKE_TOKEN);
  process.env["EXPO_PUBLIC_API_BASE_URL"] = API_BASE;
});

after(() => {
  globalThis.fetch = _savedFetch;
  _setTestAuthToken(null);
});

beforeEach(() => {
  capturedUrls = [];
  globalThis.fetch = async (url: RequestInfo | URL) => {
    capturedUrls.push(String(url));
    return {
      ok:     true,
      status: 200,
      json:   async () => ({ recommendations: [] }),
    } as unknown as Response;
  };
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("fetchCompassTravelerMatches — city param changes trigger fresh fetch", () => {
  it("includes city=Cebu in URL when city is Cebu", async () => {
    await fetchCompassTravelerMatches({ city: "Cebu", limit: 6 });

    assert.equal(capturedUrls.length, 1);
    const url = new URL(capturedUrls[0]!);
    assert.equal(url.searchParams.get("city"), "Cebu", "city param must be Cebu");
    assert.equal(url.searchParams.get("surface"), "traveler");
  });

  it("includes city=Manila in URL when city changes to Manila", async () => {
    await fetchCompassTravelerMatches({ city: "Manila", limit: 6 });

    assert.equal(capturedUrls.length, 1);
    const url = new URL(capturedUrls[0]!);
    assert.equal(url.searchParams.get("city"), "Manila", "city param must be Manila");
  });

  it("two sequential calls with different cities produce distinct URLs", async () => {
    await fetchCompassTravelerMatches({ city: "Cebu" });
    await fetchCompassTravelerMatches({ city: "Manila" });

    assert.equal(capturedUrls.length, 2, "two fetch calls — one per city");
    assert.notEqual(
      capturedUrls[0],
      capturedUrls[1],
      "each city change must produce a new distinct URL",
    );

    const cebuUrl   = new URL(capturedUrls[0]!);
    const manilaUrl = new URL(capturedUrls[1]!);
    assert.equal(cebuUrl.searchParams.get("city"),   "Cebu");
    assert.equal(manilaUrl.searchParams.get("city"), "Manila");
  });

  it("omits city param when city is null", async () => {
    await fetchCompassTravelerMatches({ city: null, limit: 6 });

    assert.equal(capturedUrls.length, 1);
    const url = new URL(capturedUrls[0]!);
    assert.equal(
      url.searchParams.get("city"),
      null,
      "no city param when city is null",
    );
  });

  it("omits city param when city is undefined (default)", async () => {
    await fetchCompassTravelerMatches({ limit: 4 });

    const url = new URL(capturedUrls[0]!);
    assert.equal(url.searchParams.get("city"), null, "no city param when city is undefined");
  });

  it("limit param is correctly forwarded alongside city", async () => {
    await fetchCompassTravelerMatches({ city: "Davao City", limit: 10 });

    const url = new URL(capturedUrls[0]!);
    assert.equal(url.searchParams.get("city"),  "Davao City", "city preserved");
    assert.equal(url.searchParams.get("limit"), "10",         "limit preserved");
  });
});

describe("fetchCompassBuddyMatches — city param changes trigger fresh fetch", () => {
  it("includes city=Cebu and surface=buddy in URL", async () => {
    await fetchCompassBuddyMatches({ city: "Cebu", limit: 4 });

    assert.equal(capturedUrls.length, 1);
    const url = new URL(capturedUrls[0]!);
    assert.equal(url.searchParams.get("city"),    "Cebu",  "city param correct");
    assert.equal(url.searchParams.get("surface"), "buddy", "surface=buddy for buddy matches");
  });

  it("city change produces a distinct URL", async () => {
    await fetchCompassBuddyMatches({ city: "Cebu" });
    await fetchCompassBuddyMatches({ city: "Iloilo" });

    assert.equal(capturedUrls.length, 2);
    assert.notEqual(capturedUrls[0], capturedUrls[1], "Iloilo URL differs from Cebu URL");

    const url2 = new URL(capturedUrls[1]!);
    assert.equal(url2.searchParams.get("city"), "Iloilo");
  });

  it("omits city param when city is null", async () => {
    await fetchCompassBuddyMatches({ city: null });

    const url = new URL(capturedUrls[0]!);
    assert.equal(url.searchParams.get("city"), null, "no city param when null");
  });
});

describe("City refresh — both surfaces use the same recommendations endpoint", () => {
  it("traveler and buddy surfaces call the same base path", async () => {
    await fetchCompassTravelerMatches({ city: "Cebu" });
    await fetchCompassBuddyMatches({ city: "Cebu" });

    assert.equal(capturedUrls.length, 2);
    const travelerUrl = new URL(capturedUrls[0]!);
    const buddyUrl    = new URL(capturedUrls[1]!);

    assert.ok(
      travelerUrl.pathname.endsWith("/api/compass/recommendations"),
      `traveler path: ${travelerUrl.pathname}`,
    );
    assert.ok(
      buddyUrl.pathname.endsWith("/api/compass/recommendations"),
      `buddy path: ${buddyUrl.pathname}`,
    );

    assert.equal(travelerUrl.searchParams.get("surface"), "traveler");
    assert.equal(buddyUrl.searchParams.get("surface"),    "buddy");
  });
});
