/**
 * DiscoveryBlockedUsers.test.ts  (standalone)
 *
 * Verifies that the Compass traveler-matches service correctly handles API
 * responses where blocked users have been filtered by the backend
 * (CompassSafetyFilter), and that the client-side service layer correctly
 * passes through clean results without injecting blocked profiles.
 *
 * Tests the real fetchCompassTravelerMatches service with mocked fetch,
 * asserting URL contract and response-shape handling.
 *
 * Run: node --import tsx --test src/test/DiscoveryBlockedUsers.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  _setTestAuthToken,
  fetchCompassTravelerMatches,
  type CompassTravelerResult,
} from "../compass.ts";

const FAKE_TOKEN = "fake-test-token-blocked-users";
const API_BASE   = "http://localhost:9999";

let _savedFetch: typeof globalThis.fetch;
let capturedUrls: string[] = [];
let nextBody: unknown       = { recommendations: [] };
let nextStatus              = 200;

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
  nextBody     = { recommendations: [] };
  nextStatus   = 200;

  globalThis.fetch = async (url: RequestInfo | URL) => {
    capturedUrls.push(String(url));
    return {
      ok:     nextStatus >= 200 && nextStatus < 300,
      status: nextStatus,
      json:   async () => nextBody,
    } as unknown as Response;
  };
});

function makeTravelerResult(userId: string): CompassTravelerResult {
  return {
    id:       userId,
    type:     "traveler",
    category: "traveler",
    title:    `User ${userId}`,
    reason:   "Shares your travel interests",
    city:     "Cebu",
    data: {
      userId,
      username:        `user_${userId}`,
      displayName:     `User ${userId}`,
      avatarUrl:       null,
      homeCity:        "Cebu",
      isPrivate:       false,
      verified:        false,
      sharedInterests: ["beaches"],
      reasonCode:      "shared_interests",
      followStatus:    "not_following",
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("fetchCompassTravelerMatches — blocked user filtering (service layer)", () => {
  it("sends surface=traveler query param — correct endpoint for people recs", async () => {
    nextBody = { recommendations: [] };

    await fetchCompassTravelerMatches({ city: "Cebu", limit: 6 });

    assert.equal(capturedUrls.length, 1, "exactly one fetch call made");
    const url = new URL(capturedUrls[0]!);
    assert.equal(
      url.searchParams.get("surface"),
      "traveler",
      "surface=traveler must be present",
    );
    assert.ok(
      url.pathname.endsWith("/api/compass/recommendations"),
      `pathname must be /api/compass/recommendations; got: ${url.pathname}`,
    );
  });

  it("returns the full clean list when backend has already filtered blocked users", async () => {
    // The backend (CompassSafetyFilter) strips blocked users before responding.
    // The client should receive and return the filtered list as-is.
    const cleanList = [
      makeTravelerResult("user-aaa"),
      makeTravelerResult("user-ccc"),
    ];
    nextBody = { recommendations: cleanList };

    const res = await fetchCompassTravelerMatches({ city: "Cebu", limit: 6 });

    assert.equal(res.ok, true, "response ok");
    assert.equal(res.data?.length, 2, "two non-blocked travelers returned");
    assert.ok(
      res.data?.every((r) => r.data.userId !== "user-bbb"),
      "user-bbb (blocked, filtered server-side) is absent from results",
    );
    assert.ok(
      res.data?.some((r) => r.data.userId === "user-aaa"),
      "user-aaa is present",
    );
    assert.ok(
      res.data?.some((r) => r.data.userId === "user-ccc"),
      "user-ccc is present",
    );
  });

  it("returns ok=true with empty data when all travelers are filtered (all blocked)", async () => {
    nextBody = { recommendations: [] };

    const res = await fetchCompassTravelerMatches({ city: "Manila", limit: 6 });

    assert.equal(res.ok, true, "still ok=true when list is empty");
    assert.equal(res.data?.length, 0, "empty list when backend filters everyone");
    assert.equal(res.disabled, undefined, "not disabled — just empty");
  });

  it("returns ok=true, disabled=true when the feature flag is off", async () => {
    nextBody = { disabled: true, recommendations: [] };

    const res = await fetchCompassTravelerMatches({ city: "Cebu", limit: 6 });

    assert.equal(res.ok, true);
    assert.equal(res.disabled, true, "disabled flag surfaced to caller");
    assert.equal((res.data ?? []).length, 0, "empty data when disabled");
  });

  it("returns ok=false on HTTP error from backend", async () => {
    nextStatus = 500;
    nextBody   = { error: "server_error" };

    const res = await fetchCompassTravelerMatches({ city: "Cebu" });

    assert.equal(res.ok, false);
    assert.ok(res.error, "error field is set on failure");
  });

  it("returns ok=false on network failure", async () => {
    globalThis.fetch = async () => { throw new Error("Network failure"); };

    const res = await fetchCompassTravelerMatches({ city: "Cebu" });

    assert.equal(res.ok, false);
    assert.equal(res.error, "network_error");
  });

  it("data.followStatus on each result is preserved from API response", async () => {
    const result = makeTravelerResult("user-zzz");
    result.data.followStatus = "following";
    nextBody = { recommendations: [result] };

    const res = await fetchCompassTravelerMatches({});

    assert.equal(res.data?.[0]?.data.followStatus, "following");
  });
});
