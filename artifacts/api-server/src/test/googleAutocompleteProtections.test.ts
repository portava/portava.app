/**
 * GET /places/google-autocomplete — cache, in-flight dedup, rate limit.
 *
 * These protections existed on /places/search (5-minute cache, inFlightSearches
 * dedup, a 1.1 s Nominatim spacing limiter) and NOT on the Google proxy. While
 * Google was a secondary source that was merely wasteful; making it the primary
 * source for city autocomplete would have turned every debounced keystroke into
 * a billable call. So they land BEFORE the source flip, not after.
 *
 * The client already debounces at 300 ms with a two-character floor
 * (useGooglePlacesAutocomplete DEBOUNCE_MS = 300, `query.trim().length < 2`),
 * and usePlaceSearch at 350 ms — verified, not assumed. Debounce limits one
 * user's typing; it does nothing about N users typing the same city, which is
 * what the cache is for.
 *
 * Run: node --import tsx/esm --test src/test/googleAutocompleteProtections.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkRateLimit, _resetRateLimit } from "../lib/rateLimit.js";

const ROUTE_SRC = readFileSync(
  resolve(import.meta.dirname, "../routes/places.ts"),
  "utf8",
);

/** The google-autocomplete handler body, isolated from its neighbours. */
function handlerBody(): string {
  const start = ROUTE_SRC.indexOf('router.get("/places/google-autocomplete"');
  assert.ok(start > 0, "handler must exist");
  const rest = ROUTE_SRC.slice(start);
  const end = rest.indexOf("\nrouter.");
  return end > 0 ? rest.slice(0, end) : rest;
}

describe("cache", () => {
  it("reuses the existing search cache rather than introducing a second one", () => {
    const body = handlerBody();
    assert.match(body, /getSearchCached\(cacheKey\)/, "must read the shared cache");
    assert.match(body, /setSearchCached\(cacheKey/, "must write the shared cache");
    // A second Map/TTL would drift from the first one's eviction behaviour.
    assert.doesNotMatch(body, /new Map<string, \{ places/, "no second cache");
  });

  it("namespaces the key so Google and Nominatim entries cannot collide", () => {
    assert.match(
      ROUTE_SRC,
      /function makeGoogleAutocompleteCacheKey[\s\S]{0,300}?`google:/,
      "the key must carry a source namespace",
    );
  });

  it("caches ONLY an answer Google actually gave", () => {
    const body = handlerBody();
    assert.match(
      body,
      /if \(!result\.reason\) setSearchCached\(/,
      "a `reason` means the answer did not come from Google — caching it would " +
        "hold an outage open for the whole TTL",
    );
  });

  it("a genuine empty result is still cacheable — it is an answer, not a fault", () => {
    // ZERO_RESULTS carries no reason (see googlePlacesReason.ts), so the guard
    // above admits it. Pinned so nobody "fixes" empties into a failure.
    assert.match(
      ROUTE_SRC,
      /An empty suggestion list is the New API's ZERO_RESULTS/,
      "the zero-results contract must remain documented",
    );
  });
});

describe("in-flight dedup", () => {
  it("registers the upstream call before awaiting it", () => {
    const body = handlerBody();
    const setIdx = body.indexOf("inFlightGoogleAutocomplete.set(cacheKey, work)");
    const awaitIdx = body.indexOf("await work");
    assert.ok(setIdx > 0 && awaitIdx > 0, "both must be present");
    assert.ok(
      setIdx < awaitIdx,
      "registering after awaiting would let a concurrent query start a second call",
    );
  });

  it("clears the entry when the call settles", () => {
    assert.match(
      handlerBody(),
      /\.finally\(\(\) => inFlightGoogleAutocomplete\.delete\(cacheKey\)\)/,
      "a never-cleared entry would pin a stale promise forever",
    );
  });

  it("a coalesced waiter inherits the reason, so it cannot cache a failure", () => {
    assert.match(
      handlerBody(),
      /shared\.reason \? \{ reason: shared\.reason \}/,
      "the waiter must learn the call failed",
    );
  });
});

describe("rate limit", () => {
  beforeEach(() => { _resetRateLimit("google_autocomplete"); });

  it("uses the shared limiter rather than a bespoke counter", () => {
    assert.match(handlerBody(), /checkRateLimit\(\s*"google_autocomplete"/);
  });

  it("is checked AFTER cache and dedup — the cheapest requests are never charged", () => {
    const body = handlerBody();
    const cacheIdx = body.indexOf("getSearchCached(cacheKey)");
    const dedupIdx = body.indexOf("inFlightGoogleAutocomplete.get(cacheKey)");
    const rateIdx = body.indexOf("checkRateLimit(");
    assert.ok(cacheIdx < rateIdx, "a cache hit costs nothing and must not be charged");
    assert.ok(dedupIdx < rateIdx, "joining a paid call costs nothing and must not be charged");
  });

  it("admits normal typing and stops a runaway loop", () => {
    const KEY = "1.2.3.4";
    let allowed = 0;
    for (let i = 0; i < 60; i++) {
      if (checkRateLimit("google_autocomplete", KEY, 60, 60_000).allowed) allowed++;
    }
    assert.equal(allowed, 60, "60 calls in a minute must all pass — that is a human typing");
    const over = checkRateLimit("google_autocomplete", KEY, 60, 60_000);
    assert.equal(over.allowed, false, "the 61st must be refused");
    assert.ok(over.retryAfterMs > 0, "and must say when to retry");
  });

  it("buckets per caller — one abuser cannot lock everyone out", () => {
    for (let i = 0; i < 60; i++) checkRateLimit("google_autocomplete", "abuser", 60, 60_000);
    assert.equal(checkRateLimit("google_autocomplete", "abuser", 60, 60_000).allowed, false);
    assert.equal(
      checkRateLimit("google_autocomplete", "someone-else", 60, 60_000).allowed,
      true,
      "a different caller must be unaffected",
    );
  });

  it("refuses in the route's own shape — 200 with a reason, not a bare error", () => {
    assert.match(
      handlerBody(),
      /reason: "rate_limited"/,
      "clients that read only `places` must be unaffected",
    );
  });
});
